import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { DRILL_DIFFICULTIES, isDrillDifficulty } from '@/src/server/pilot/drills';
import {
  listDrillChangeProposals,
  proposeDrillChange,
  type DrillChangeProposalRow,
  type DrillChangeReviewState,
} from '@/src/server/pilot/drillVersioning';
import { isUuid, jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

/**
 * The bodies these handlers answer with.
 *
 * Declared as types the handlers are checked against, for the reason drills.ts
 * records at length about its own DrillLibraryResponse: that route sent `items`
 * while both of its clients read `drills`, so the drill library rendered empty
 * from the day it shipped, and route tests and component tests both passed
 * because each side was only ever tested against its own idea of the shape.
 * Nothing consumes these yet -- the coach-facing surface is another lane's --
 * so this pins the producing side now and gives that client something to import
 * rather than re-describe. `items` here matches ../route.ts deliberately.
 */
export interface DrillChangeProposalListResponse {
  ok: true;
  organization_id: string;
  items: DrillChangeProposalRow[];
}

export interface DrillChangeProposalCreatedResponse {
  ok: true;
  organization_id: string;
  proposal: DrillChangeProposalRow;
}

// A change proposal is a coach's argument about how a drill should be taught,
// and the review queue is internal coaching deliberation -- not athlete data,
// but not gym-wide reading either. So the roles that may write drills are the
// roles that may propose changes to them and see the queue, matching
// ../route.ts's DRILL_AUTHOR_ROLES rather than its wider reader set.
//
// proposeDrillChange carries no role gate of its own (see its comment: the
// intended workflow is that ANY coach's notes can refine a drill), and says
// so explicitly because the gate is meant to live here. This is that gate.
const DRILL_PROPOSER_ROLES = ['coach', 'organization_admin', 'admin'] as const;

// The vocabulary pilot.drill_change_proposals.review_state carries. Declared
// here rather than imported as a value because DrillChangeReviewState is a
// type-only export; a mismatch between the two is a typecheck failure, which
// is the check that catches it (jest does not typecheck -- see AGENT_KERNEL).
const REVIEW_STATES: readonly DrillChangeReviewState[] = [
  'proposed',
  'under_review',
  'adopted',
  'declined',
  'superseded',
];

// Only the fields adoptDrillChangeProposal will actually apply. The domain
// function ignores every other key by design, so a caller naming `active` or
// `version` is not an error -- but a caller naming `focuss` believes they
// proposed something and did not, so an unknown key is refused here rather
// than silently dropped.
const EDITABLE_FIELDS = ['name', 'category', 'focus', 'cues', 'difficulty'] as const;

const MAX_CUES = 12;

// Length caps. Not a style preference: an over-long `name` passes every check
// in this file and then fails the btree index behind
// pilot_drills_one_name_per_org at ADOPT time (SQLSTATE 54000) -- in front of
// the reviewer, for input the author typed. Same principle as the type
// validation below: keep the failure with its author.
const MAX_LENGTHS: Record<string, number> = {
  name: 200,
  category: 200,
  focus: 2000,
  cue: 200,
  rationale: 4000,
};

/**
 * `request.json()` RESOLVES for any valid JSON document, so a body of `null`,
 * `[]` or `"x"` never reaches the `.catch`. Reading a field off `null` then
 * throws a TypeError, which matches no jsonError prefix and is redacted to a
 * 500 -- an empty request reported as a server fault. Anything that is not a
 * plain object becomes an empty one, so the field checks below produce the
 * 400 they exist to produce.
 */
async function readJsonObject(request: NextRequest): Promise<Record<string, unknown>> {
  const parsed = await request.json().catch(() => null);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function requireText(raw: unknown, field: string, limitKey = field): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`Missing ${field}`);
  }
  // trim() does not strip U+0000. A NUL reaches Postgres as 22P05 inside a
  // jsonb value ("unsupported Unicode escape sequence") and as 22021 in a
  // text column -- both unhandled, both a 500.
  if (raw.includes('\u0000')) {
    throw new Error(`Unsupported ${field}: control characters are not allowed`);
  }
  const value = raw.trim();
  const max = MAX_LENGTHS[limitKey];
  if (max !== undefined && value.length > max) {
    throw new Error(`Unsupported ${field}: at most ${max} characters`);
  }
  return value;
}

/**
 * Validates the proposed change at the boundary, against the same rules
 * ../route.ts applies to a direct edit.
 *
 * This is load-bearing, not defensive decoration. applyProposedChange copies
 * whatever it is given onto the new version without checking types, so an
 * unvalidated `{ difficulty: 'banana' }` is accepted here, sits in the queue
 * looking reviewable, and then dies on pilot_drills_difficulty_check inside
 * adoptDrillChangeProposal's transaction -- a 23514 surfacing as a 500 at
 * ADOPT time, for a mistake made at PROPOSE time, in front of a different
 * person than the one who made it. Refusing it here keeps the failure with
 * its author.
 */
function parseProposedChange(raw: unknown): Record<string, unknown> {
  // Absent is refused exactly like `{}`. It used to return undefined, which
  // drillVersioning.ts stores as `proposedChange ?? {}` -- the same empty
  // object by a different spelling -- so omitting the key produced the
  // byte-identical version the empty-object branch below exists to refuse.
  // One invariant, both spellings.
  if (raw === undefined || raw === null) {
    throw new Error('Missing proposed_change: name, category, focus, cues or difficulty');
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Unsupported proposed_change');
  }

  const input = raw as Record<string, unknown>;
  const unknownKey = Object.keys(input).find(
    (key) => !EDITABLE_FIELDS.some((field) => field === key),
  );
  if (unknownKey) {
    throw new Error(
      `Unsupported proposed_change field "${unknownKey}": one of ${EDITABLE_FIELDS.join(', ')}`,
    );
  }

  const change: Record<string, unknown> = {};

  for (const field of ['name', 'category', 'focus'] as const) {
    if (input[field] !== undefined) {
      change[field] = requireText(input[field], `proposed_change.${field}`, field);
    }
  }

  if (input.cues !== undefined) {
    if (!Array.isArray(input.cues) || input.cues.some((cue) => typeof cue !== 'string')) {
      throw new Error('Unsupported proposed_change.cues');
    }
    const cues = (input.cues as string[])
      .filter((cue) => cue.trim().length > 0)
      .map((cue) => requireText(cue, 'proposed_change.cues', 'cue'));
    if (cues.length > MAX_CUES) {
      throw new Error(`Unsupported proposed_change.cues: at most ${MAX_CUES}`);
    }
    change.cues = cues;
  }

  if (input.difficulty !== undefined) {
    if (!isDrillDifficulty(input.difficulty)) {
      throw new Error(
        `Unsupported proposed_change.difficulty: one of ${DRILL_DIFFICULTIES.join(', ')}`,
      );
    }
    change.difficulty = input.difficulty;
  }

  // An empty object is not the same as no change: it would adopt a byte-identical
  // new version, which is a confusing thing to have in a lineage. A proposal with
  // no field changes is a discussion, and the rationale is where it belongs.
  if (Object.keys(change).length === 0) {
    throw new Error('Missing proposed_change: name, category, focus, cues or difficulty');
  }

  return change;
}

// observation_note_ids is a uuid[] column. An unvalidated non-UUID string
// reaches Postgres as invalid input syntax (22P02) and surfaces as a 500 --
// a caller's malformed id reported as a server fault.
function parseObservationNoteIds(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new Error('Unsupported observation_note_ids');
  }
  if (!raw.every((id) => isUuid(id))) {
    throw new Error('Unsupported observation_note_ids: each must be a UUID');
  }
  return raw as string[];
}

/**
 * The review queue, and the history of one drill's proposals.
 *
 * An unrecognized review_state is refused rather than passed through to an
 * `= $2` comparison that matches nothing: a typo returning "no proposals"
 * reads as an empty queue, which is the same failure mode this repository
 * has recorded elsewhere -- a load failure presented as an absence.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DRILL_PROPOSER_ROLES]);

    const rawState = request.nextUrl.searchParams.get('review_state');
    if (rawState !== null && !REVIEW_STATES.some((state) => state === rawState)) {
      throw new Error(`Unsupported review_state: one of ${REVIEW_STATES.join(', ')}`);
    }

    // Present-but-blank is refused rather than dropped. The mirror of the
    // review_state check above: a filter that silently does not apply returns
    // the whole queue while looking like a filtered view.
    const rawLineageId = request.nextUrl.searchParams.get('lineage_id');
    if (rawLineageId !== null && !rawLineageId.trim()) {
      throw new Error('Missing lineage_id');
    }

    const items = await listDrillChangeProposals(principal.organizationId, {
      reviewState: (rawState as DrillChangeReviewState | null) ?? undefined,
      lineageId: rawLineageId?.trim() || undefined,
    });

    const body: DrillChangeProposalListResponse = {
      ok: true,
      organization_id: principal.organizationId,
      items,
    };
    return NextResponse.json(body);
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...DRILL_PROPOSER_ROLES]);

    const body = await readJsonObject(request);

    const proposal = await proposeDrillChange({
      organizationId: principal.organizationId,
      basedOnDrillId: requireText(body.based_on_drill_id, 'based_on_drill_id'),
      proposedByAccountId: principal.accountId,
      proposedByRole: principal.role,
      // Validated here as well as in the domain function: the domain guard is
      // the one that cannot be bypassed, this one produces a 400 with the
      // field named instead of an unmatched message falling through to a 500.
      rationale: requireText(body.rationale, 'rationale'),
      proposedChange: parseProposedChange(body.proposed_change),
      observationNoteIds: parseObservationNoteIds(body.observation_note_ids),
    });

    // 'create' from the existing audit vocabulary, not a new drill_change_*
    // verb. AUDIT_EVENT_TYPES is closed and mirrored by a check constraint;
    // sending a value that is in neither is exactly the failure
    // pilot_slice_postgres_audit_event_vocabulary_migration.sql was written
    // to fix, where the work committed and the audit write then failed the
    // request. What kind of thing was created is carried in entity_type.
    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'drill_change_proposal',
      entity_id: proposal.proposal_id,
      details: {
        lineage_id: proposal.lineage_id,
        based_on_drill_id: proposal.based_on_drill_id,
        proposed_fields: Object.keys(proposal.proposed_change ?? {}),
      },
    });

    const created: DrillChangeProposalCreatedResponse = {
      ok: true,
      organization_id: principal.organizationId,
      proposal,
    };
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    // The drill named in based_on_drill_id is not in this organization.
    // DRILL_NOT_FOUND matches none of jsonError's message prefixes, so
    // without this it would be redacted to a 500 "Internal server error" --
    // a caller's bad id reported as a server fault.
    if (error instanceof Error && error.message === 'DRILL_NOT_FOUND') {
      return NextResponse.json({ error: 'DRILL_NOT_FOUND' }, { status: 404 });
    }
    return jsonError(error);
  }
}

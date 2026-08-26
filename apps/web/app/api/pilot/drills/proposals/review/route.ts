import { NextResponse, type NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  adoptDrillChangeProposal,
  declineDrillChangeProposal,
  type DrillChangeProposalRow,
  type PilotDrillVersionRow,
} from '@/src/server/pilot/drillVersioning';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// AUTHORIZATION IS DELIBERATELY NOT RESTATED HERE.
//
// Both domain functions call requireEvidenceReviewer(role) themselves, and
// shadowLibrary.ts exports that check precisely so there is "one source of
// truth for who may approve organization-wide content rather than a second
// copy that could drift from this one" -- its words. A requireRole([...])
// list in this file would be that second copy: harmless on the day it is
// written, and wrong the day the reviewer tier moves on one side only.
//
// So this route authenticates, and the domain function authorizes. A caller
// who is not a reviewer gets requireEvidenceReviewer's own
// 'Forbidden: ...' message, which jsonError maps to 403 before either
// function touches a row.

/**
 * Pinned for the reason ../route.ts records: a producing side typed against
 * its own response is a rename that fails to compile rather than a client
 * that renders nothing. `drill` is present only on an adoption -- declining
 * produces no new version, and saying so in the type stops a client reading
 * it unconditionally.
 */
export interface DrillChangeProposalReviewResponse {
  ok: true;
  organization_id: string;
  proposal: DrillChangeProposalRow;
  drill?: PilotDrillVersionRow;
}

const ACTIONS = ['adopt', 'decline'] as const;
type ReviewAction = (typeof ACTIONS)[number];

const MAX_REVIEW_NOTE = 4000;

/**
 * See ../route.ts: `request.json()` resolves for `null`, `[]` and `"x"`, so a
 * body that is valid JSON but not an object never reaches the `.catch` and
 * reading a field off it throws a TypeError -- redacted to a 500.
 */
async function readJsonObject(request: NextRequest): Promise<Record<string, unknown>> {
  const parsed = await request.json().catch(() => null);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function requireText(raw: unknown, field: string, max?: number): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`Missing ${field}`);
  }
  // trim() does not strip U+0000, and a NUL in a text column is SQLSTATE 22021.
  if (raw.includes('\u0000')) {
    throw new Error(`Unsupported ${field}: control characters are not allowed`);
  }
  const value = raw.trim();
  if (max !== undefined && value.length > max) {
    throw new Error(`Unsupported ${field}: at most ${max} characters`);
  }
  return value;
}

function parseAction(raw: unknown): ReviewAction {
  if (typeof raw !== 'string' || !ACTIONS.some((action) => action === raw)) {
    throw new Error(`Unsupported action: one of ${ACTIONS.join(', ')}`);
  }
  return raw as ReviewAction;
}

/**
 * Every domain code these two functions can throw, mapped to the status that
 * describes it.
 *
 * None of them reaches jsonError's prefix matcher: they are ALL_CAPS machine
 * codes, and that matcher keys off 'Missing' / 'Not found' / 'Forbidden'.
 * Unmapped, every one of them would be redacted to a 500 "Internal server
 * error" -- so a reviewer racing a colleague onto the same lineage would be
 * told the server had broken, rather than that the proposal they are looking
 * at was written against a version that has since been superseded.
 */
const CODE_STATUS = new Map<string, number>([
  ['DRILL_CHANGE_PROPOSAL_NOT_FOUND', 404],
  // The lineage the proposal names has no rows. Not the caller's doing, but
  // it is a fact about the addressed resource, not a server fault.
  ['DRILL_LINEAGE_NOT_FOUND', 404],
  // Someone already decided this proposal. 409, not 404: the proposal exists.
  ['DRILL_CHANGE_PROPOSAL_ALREADY_ADOPTED', 409],
  ['DRILL_CHANGE_PROPOSAL_ALREADY_DECLINED', 409],
  ['DRILL_CHANGE_PROPOSAL_ALREADY_SUPERSEDED', 409],
  // The proposal was written against a version that is no longer current --
  // adoptDrillChangeProposal refuses it rather than guessing how the two
  // changes combine. This is the expected outcome of two reviewers working
  // the same lineage, not an error in the ordinary sense.
  ['DRILL_CHANGE_PROPOSAL_STALE_BASE_VERSION', 409],
  // declineDrillChangeProposal's UPDATE ... returning matched no row, which
  // is either "no such proposal" or "already decided" and the statement
  // cannot tell the two apart. 409 rather than 404 because asserting the
  // proposal does not exist would be a claim wider than what was checked.
  ['DRILL_CHANGE_PROPOSAL_NOT_FOUND_OR_ALREADY_DECIDED', 409],
]);

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);

    const body = await readJsonObject(request);

    const proposalId = requireText(body.proposal_id, 'proposal_id');
    const action = parseAction(body.action);

    if (action === 'decline') {
      // Validated before the call so the 400 names the field. The domain
      // function guards this too, and its message ('Declining a drill change
      // proposal requires a review note.') matches no jsonError prefix, so
      // reaching it would produce a 500 for what is plainly a bad request.
      const reviewNote = requireText(body.review_note, 'review_note', MAX_REVIEW_NOTE);

      const proposal = await declineDrillChangeProposal({
        organizationId: principal.organizationId,
        proposalId,
        reviewedByAccountId: principal.accountId,
        reviewedByRole: principal.role,
        reviewNote,
      });

      // 'update' from the closed AUDIT_EVENT_TYPES vocabulary -- see the note
      // in ../route.ts on why this is not a new drill_change_declined verb.
      await writePilotAuditEvent({
        event_type: 'update',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'drill_change_proposal',
        entity_id: proposal.proposal_id,
        details: { review_state: proposal.review_state, lineage_id: proposal.lineage_id },
      });

      const declined: DrillChangeProposalReviewResponse = {
        ok: true,
        organization_id: principal.organizationId,
        proposal,
      };
      return NextResponse.json(declined);
    }

    const { proposal, newDrillVersion } = await adoptDrillChangeProposal({
      organizationId: principal.organizationId,
      proposalId,
      reviewedByAccountId: principal.accountId,
      reviewedByRole: principal.role,
      reviewNote: body.review_note === undefined || body.review_note === null
        ? null
        : requireText(body.review_note, 'review_note', MAX_REVIEW_NOTE),
    });

    // Written after the transaction commits, deliberately. An audit line for a
    // version that got rolled back would be a record of something that did not
    // happen; the reverse -- a committed version whose audit write fails -- is
    // the failure the vocabulary note in ../route.ts describes, and is why the
    // event_type here is one the constraint already admits.
    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'drill_change_proposal',
      entity_id: proposal.proposal_id,
      details: {
        review_state: proposal.review_state,
        lineage_id: proposal.lineage_id,
        resulting_drill_id: proposal.resulting_drill_id,
        new_version: newDrillVersion.version,
      },
    });

    const adopted: DrillChangeProposalReviewResponse = {
      ok: true,
      organization_id: principal.organizationId,
      proposal,
      drill: newDrillVersion,
    };
    return NextResponse.json(adopted);
  } catch (error) {
    if (error instanceof Error) {
      const status = CODE_STATUS.get(error.message);
      if (status !== undefined) {
        return NextResponse.json({ error: error.message }, { status });
      }
    }

    // The one constraint violation adoptDrillChangeProposal does NOT translate.
    //
    // It catches pilot_drills_lineage_version_uq and rethrows everything else
    // raw, so adopting a proposal that renames a drill onto a name another
    // ACTIVE drill already holds arrives here as a bare pg error and would be
    // redacted to a 500. The drill-versioning migration replaced the total
    // unique index with a PARTIAL one and deliberately KEPT THE NAME
    // pilot_drills_one_name_per_org so that drills.ts#isDrillNameCollision's
    // 409 "name taken" mapping would keep working -- this is that mapping, on
    // the path that reaches the index by a different route. The constraint is
    // matched by name, not the message, so a different unique violation stays
    // an opaque 500 rather than being mislabelled a name collision.
    if (isDrillNameCollision(error)) {
      return NextResponse.json({ error: 'DRILL_NAME_TAKEN' }, { status: 409 });
    }

    return jsonError(error);
  }
}

function isDrillNameCollision(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === '23505' && constraint === 'pilot_drills_one_name_per_org';
}

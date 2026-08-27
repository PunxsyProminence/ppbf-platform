import { randomUUID } from 'node:crypto';

import type { DrillDifficulty } from './drills';
import type { PilotRole } from './contracts';
import { query, queryOne, withTransaction } from './db';
import { requireEvidenceReviewer } from './shadowLibrary';

// pilot.drills, pilot.drill_change_proposals and pilot.drill_version_outcomes
// are owned by
// infra/azure/pilot_slice_postgres_drill_versioning_migration.sql, applied
// through the apply-migrations workflow like every other table. Nothing
// here issues DDL.
//
// THE MODEL: a drill's content is never edited in place once versioned. A
// refinement inserts a new pilot.drills row sharing lineage_id, with
// version = previous + 1 and supersedes_drill_id pointing at the row it
// replaces, and stamps the old row superseded. adoptDrillChangeProposal is
// the only function that does this, and it does it transactionally -- see
// its own comment for why the previous version is re-read and locked
// rather than trusted from the proposal.

export type DrillChangeReviewState = 'proposed' | 'under_review' | 'adopted' | 'declined' | 'superseded';

export interface DrillChangeProposalRow {
  proposal_id: string;
  organization_id: string;
  lineage_id: string;
  based_on_drill_id: string;
  proposed_by_account_id: string;
  proposed_by_role: string;
  rationale: string;
  proposed_change: Record<string, unknown>;
  observation_note_ids: string[];
  review_state: DrillChangeReviewState;
  reviewed_by_account_id: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  resulting_drill_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PilotDrillVersionRow {
  organization_id: string;
  drill_id: string;
  name: string;
  category: string;
  focus: string;
  cues: string[];
  difficulty: DrillDifficulty;
  active: boolean;
  version: number;
  lineage_id: string;
  supersedes_drill_id: string | null;
  superseded_at: string | null;
  superseded_by_drill_id: string | null;
  created_at: string;
  updated_at: string;
}

const DRILL_VERSION_FIELDS =
  'organization_id, drill_id, name, category, focus, cues, difficulty, active, '
  + 'version, lineage_id, supersedes_drill_id, superseded_at, superseded_by_drill_id, created_at, updated_at';

const PROPOSAL_FIELDS =
  'proposal_id, organization_id, lineage_id, based_on_drill_id, proposed_by_account_id, '
  + 'proposed_by_role, rationale, proposed_change, observation_note_ids, review_state, '
  + 'reviewed_by_account_id, reviewed_at, review_note, resulting_drill_id, created_at, updated_at';

// The content columns a proposed_change may adjust on adoption -- the same
// set drills.ts#updateDrill exposes for a coach's own direct edit. Any other
// key in proposed_change (a caller naming `active`, `version`, or anything
// else) is silently ignored rather than applied, so a change proposal can
// only ever produce a new version of the drill's CONTENT, never reach into
// the versioning machinery itself.
const EDITABLE_DRILL_FIELDS = ['name', 'category', 'focus', 'cues', 'difficulty'] as const;
type EditableDrillField = (typeof EDITABLE_DRILL_FIELDS)[number];
type EditableDrillFields = Pick<PilotDrillVersionRow, EditableDrillField>;

function applyProposedChange(base: PilotDrillVersionRow, proposedChange: Record<string, unknown>): EditableDrillFields {
  const merged: EditableDrillFields = {
    name: base.name,
    category: base.category,
    focus: base.focus,
    cues: base.cues,
    difficulty: base.difficulty,
  };
  for (const field of EDITABLE_DRILL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(proposedChange, field)) {
      (merged as Record<EditableDrillField, unknown>)[field] = proposedChange[field];
    }
  }
  return merged;
}

/**
 * A coach's proposed adjustment to a drill they were looking at. Deliberately
 * no role gate here beyond what the calling route enforces (the intended
 * workflow is that ANY coach's notes can refine a drill) -- see this
 * module's authorization note on adopt/decline below for the review-side
 * gate that DOES apply.
 */
export async function proposeDrillChange(input: {
  organizationId: string;
  basedOnDrillId: string;
  proposedByAccountId: string;
  proposedByRole: string;
  rationale: string;
  proposedChange?: Record<string, unknown>;
  observationNoteIds?: string[];
}): Promise<DrillChangeProposalRow> {
  const baseDrill = await queryOne<PilotDrillVersionRow>(
    `select ${DRILL_VERSION_FIELDS} from pilot.drills where organization_id = $1 and drill_id = $2`,
    [input.organizationId, input.basedOnDrillId],
  );
  if (!baseDrill) {
    throw new Error('DRILL_NOT_FOUND');
  }

  const rationale = input.rationale.trim();
  if (!rationale) {
    throw new Error('A drill change proposal requires a rationale.');
  }

  const proposalId = `propchg_${randomUUID()}`;
  const row = await queryOne<DrillChangeProposalRow>(
    `insert into pilot.drill_change_proposals
       (proposal_id, organization_id, lineage_id, based_on_drill_id, proposed_by_account_id,
        proposed_by_role, rationale, proposed_change, observation_note_ids)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::uuid[])
     returning ${PROPOSAL_FIELDS}`,
    [
      proposalId,
      input.organizationId,
      baseDrill.lineage_id,
      input.basedOnDrillId,
      input.proposedByAccountId,
      input.proposedByRole,
      rationale,
      JSON.stringify(input.proposedChange ?? {}),
      input.observationNoteIds ?? [],
    ],
  );

  if (!row) {
    throw new Error('Unable to create drill change proposal.');
  }
  return row;
}

/**
 * The review queue: filterable by review_state (the pending-review list) and
 * by lineage_id (every proposal ever made about one drill, regardless of
 * outcome).
 */
/**
 * A proposal, plus whether it can still be adopted.
 *
 * WHY THIS IS NOT JUST THE ROW. review_state alone cannot answer "may I act
 * on this", and a reviewer working a queue has no other signal. Adopting any
 * one proposal on a lineage advances that lineage, which leaves every SIBLING
 * proposal based on the version that just got superseded -- correctly
 * un-adoptable, because applying their field-level changes onto a version
 * they were not written against could silently discard whatever the adopted
 * change did.
 *
 * Before this, the only way to discover that was to attempt the adopt and
 * receive DRILL_CHANGE_PROPOSAL_STALE_BASE_VERSION. A queue of five proposals
 * on one drill therefore read as five actionable items, and a reviewer who
 * adopted the first met four identical errors with nothing explaining why,
 * what superseded them, or that declining was now the only move left.
 */
export interface DrillChangeProposalListing extends DrillChangeProposalRow {
  /** The lineage's current version, or null if the lineage has no rows at
   * all. This is the drill an adopt would apply the change ONTO. */
  current_drill_id: string | null;
  /** Whether based_on_drill_id still names that current version.
   *
   * False means an adopt would be refused. It does NOT mean the proposal is
   * worthless -- the coach's rationale and observation notes are still the
   * evidence they were, and the usual answer is to decline with a note asking
   * for a re-proposal against the new version. */
  base_is_current: boolean;
}

/**
 * The review queue, with staleness readable rather than discoverable by
 * failure.
 *
 * THE SUBQUERY MUST MATCH adoptDrillChangeProposal'S LOCK QUERY. Both take
 * the highest `version` in the lineage -- deliberately NOT `where active`.
 * The two definitions coincide today, but they are different questions, and a
 * read model that answered a different one from the writer would produce a
 * flag that lies in exactly the edge cases a reviewer would most rely on it.
 * drillVersioning.pg.test.ts asserts the flag PREDICTS the write: where it is
 * true an adopt succeeds, where it is false the adopt throws.
 */
export async function listDrillChangeProposals(
  organizationId: string,
  filter: { reviewState?: DrillChangeReviewState; lineageId?: string } = {},
): Promise<DrillChangeProposalListing[]> {
  return query<DrillChangeProposalListing>(
    `select ${PROPOSAL_FIELDS.split(', ').map((f) => `p.${f}`).join(', ')},
            cur.drill_id as current_drill_id,
            (cur.drill_id is not null and cur.drill_id = p.based_on_drill_id) as base_is_current
     from pilot.drill_change_proposals p
     left join lateral (
       select d.drill_id
       from pilot.drills d
       where d.organization_id = p.organization_id
         and d.lineage_id = p.lineage_id
       order by d.version desc
       limit 1
     ) cur on true
     where p.organization_id = $1
       and ($2::text is null or p.review_state = $2)
       and ($3::text is null or p.lineage_id = $3)
     order by p.created_at desc`,
    [organizationId, filter.reviewState ?? null, filter.lineageId ?? null],
  );
}

/** Every version of one drill lineage, oldest first. */
export async function getDrillLineage(organizationId: string, lineageId: string): Promise<PilotDrillVersionRow[]> {
  return query<PilotDrillVersionRow>(
    `select ${DRILL_VERSION_FIELDS}
     from pilot.drills
     where organization_id = $1 and lineage_id = $2
     order by version asc`,
    [organizationId, lineageId],
  );
}

/**
 * AUTHORIZATION: adopting or declining changes shared coaching content read
 * by every athlete in the org, so both are gated behind
 * requireEvidenceReviewer (shadowLibrary.ts) -- the same reviewer tier
 * SHADOW evidence review already uses for exactly this reason (org-wide
 * content, not one person's own record). No new role vocabulary is
 * introduced; this reuses the existing one.
 *
 * Transactional and all-or-nothing: inserting the new version, stamping the
 * old one, and marking the proposal adopted either all commit or none do.
 * withTransaction rolls back on any thrown error, so a failure after the
 * new-version INSERT (e.g. the UPDATE finding no matching row) leaves no
 * orphan version and the proposal still reads 'proposed'.
 */
export async function adoptDrillChangeProposal(input: {
  organizationId: string;
  proposalId: string;
  reviewedByAccountId: string;
  reviewedByRole: PilotRole;
  reviewNote?: string | null;
}): Promise<{ proposal: DrillChangeProposalRow; newDrillVersion: PilotDrillVersionRow }> {
  requireEvidenceReviewer(input.reviewedByRole);

  return withTransaction(async (client) => {
    const proposalResult = await client.query<DrillChangeProposalRow>(
      `select ${PROPOSAL_FIELDS}
       from pilot.drill_change_proposals
       where organization_id = $1 and proposal_id = $2
       for update`,
      [input.organizationId, input.proposalId],
    );
    const proposal = proposalResult.rows[0];
    if (!proposal) {
      throw new Error('DRILL_CHANGE_PROPOSAL_NOT_FOUND');
    }
    if (proposal.review_state !== 'proposed' && proposal.review_state !== 'under_review') {
      throw new Error(`DRILL_CHANGE_PROPOSAL_ALREADY_${proposal.review_state.toUpperCase()}`);
    }

    // The CURRENT latest version of this lineage, locked against a
    // concurrent adopt on the same lineage -- NOT the proposal's own
    // based_on_drill_id. based_on_drill_id is a historical fact about which
    // version the coach was actually looking at, and it can be stale by the
    // time a reviewer acts if a different proposal on the same lineage was
    // adopted first. Applying this proposal's field-level changes onto a
    // version other than the one they were written against could silently
    // discard whatever the intervening change did, so a stale proposal is
    // refused outright rather than guessed at.
    //
    // This `for update` lock does NOT by itself guarantee a clean refusal
    // under genuine concurrency: if two adopts on the same lineage are both
    // blocked on this row, Postgres re-checks the SAME physical row via
    // EvalPlanQual when the first commits, rather than re-running the
    // ORDER BY/LIMIT -- so the second transaction can still read back a
    // now-superseded row whose drill_id happens to still match
    // based_on_drill_id, and only discover the conflict when its own
    // INSERT collides with pilot_drills_lineage_version_uq below. Either
    // way only one adopt ever survives (data integrity holds), but the
    // catch below is what turns that into the same clean, catchable error
    // this staleness check exists to produce, instead of a raw constraint
    // violation reaching the caller.
    const currentResult = await client.query<PilotDrillVersionRow>(
      `select ${DRILL_VERSION_FIELDS}
       from pilot.drills
       where organization_id = $1 and lineage_id = $2
       order by version desc
       limit 1
       for update`,
      [input.organizationId, proposal.lineage_id],
    );
    const current = currentResult.rows[0];
    if (!current) {
      throw new Error('DRILL_LINEAGE_NOT_FOUND');
    }
    if (current.drill_id !== proposal.based_on_drill_id) {
      throw new Error('DRILL_CHANGE_PROPOSAL_STALE_BASE_VERSION');
    }

    const merged = applyProposedChange(current, proposal.proposed_change);
    // Generated here, client-side, rather than read back after the INSERT --
    // this lets the old row be deactivated FIRST and still name its successor.
    const newDrillId = randomUUID();

    // Deactivating v1 BEFORE inserting v2 matters, not just for readability:
    // pilot_drills_one_name_per_org is a partial unique index on
    // (organization_id, name) WHERE active. Most proposed changes do not
    // rename the drill, so v2 usually keeps v1's exact name. Inserting v2
    // while v1 is still active would collide with itself on that index --
    // the two rows would be genuinely indistinguishable to the constraint
    // for the instant both are active. Deactivating first means only one row
    // of that name is ever active at once, even mid-transaction.
    //
    // superseded_by_drill_id is NOT set in this first UPDATE: it is a
    // foreign key to pilot.drills(organization_id, drill_id), and v2 does
    // not exist yet -- setting it here would fail that FK the instant it ran.
    // It is stamped in a second, separate UPDATE below, after the INSERT.
    await client.query(
      `update pilot.drills
       set active = false,
           superseded_at = now(),
           updated_at = now()
       where organization_id = $1 and drill_id = $2`,
      [input.organizationId, current.drill_id],
    );

    let insertResult;
    try {
      insertResult = await client.query<PilotDrillVersionRow>(
        `insert into pilot.drills
           (organization_id, drill_id, name, category, focus, cues, difficulty, active,
            version, lineage_id, supersedes_drill_id)
         values ($1,$2,$3,$4,$5,$6::text[],$7,true,$8,$9,$10)
         returning ${DRILL_VERSION_FIELDS}`,
        [
          input.organizationId,
          newDrillId,
          merged.name,
          merged.category,
          merged.focus,
          merged.cues,
          merged.difficulty,
          current.version + 1,
          current.lineage_id,
          current.drill_id,
        ],
      );
    } catch (error) {
      // See the staleness comment above: under genuine concurrency this is
      // the SAME situation the based_on_drill_id check above exists to
      // catch, just discovered one statement later because the lock query
      // read back a row EvalPlanQual re-validated rather than re-selected.
      // Translated to the same error the caller already knows how to
      // handle, matching drills.ts's own isDrillNameCollision pattern for
      // turning a specific constraint violation into a domain error rather
      // than a raw Postgres one.
      const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
      if (code === '23505' && constraint === 'pilot_drills_lineage_version_uq') {
        throw new Error('DRILL_CHANGE_PROPOSAL_STALE_BASE_VERSION');
      }
      throw error;
    }
    const newDrillVersion = insertResult.rows[0];

    await client.query(
      `update pilot.drills
       set superseded_by_drill_id = $3
       where organization_id = $1 and drill_id = $2`,
      [input.organizationId, current.drill_id, newDrillId],
    );

    const updatedProposalResult = await client.query<DrillChangeProposalRow>(
      `update pilot.drill_change_proposals
       set review_state = 'adopted',
           reviewed_by_account_id = $3,
           reviewed_at = now(),
           review_note = $4,
           resulting_drill_id = $5,
           updated_at = now()
       where organization_id = $1 and proposal_id = $2
       returning ${PROPOSAL_FIELDS}`,
      [input.organizationId, input.proposalId, input.reviewedByAccountId, input.reviewNote ?? null, newDrillId],
    );

    return { proposal: updatedProposalResult.rows[0], newDrillVersion };
  });
}

/** See adoptDrillChangeProposal's authorization note -- the same gate applies here. */
export async function declineDrillChangeProposal(input: {
  organizationId: string;
  proposalId: string;
  reviewedByAccountId: string;
  reviewedByRole: PilotRole;
  reviewNote: string;
}): Promise<DrillChangeProposalRow> {
  requireEvidenceReviewer(input.reviewedByRole);

  const reviewNote = input.reviewNote.trim();
  if (!reviewNote) {
    throw new Error('Declining a drill change proposal requires a review note.');
  }

  const row = await queryOne<DrillChangeProposalRow>(
    `update pilot.drill_change_proposals
     set review_state = 'declined',
         reviewed_by_account_id = $3,
         reviewed_at = now(),
         review_note = $4,
         updated_at = now()
     where organization_id = $1
       and proposal_id = $2
       and review_state in ('proposed', 'under_review')
     returning ${PROPOSAL_FIELDS}`,
    [input.organizationId, input.proposalId, input.reviewedByAccountId, reviewNote],
  );

  if (!row) {
    throw new Error('DRILL_CHANGE_PROPOSAL_NOT_FOUND_OR_ALREADY_DECIDED');
  }
  return row;
}

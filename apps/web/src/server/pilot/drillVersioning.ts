import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { writePilotAuditEvent } from './audit';
import {
  DrillNameTakenError,
  ReferenceDrillAlreadyPromotedError,
  assertDrillMeetsCueRule,
  isDrillNameCollision,
  type DrillDifficulty,
} from './drills';
import type { PilotRole } from './contracts';
import { query, queryOne, withTransaction } from './db';
import { ConflictError } from './errors';
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
  /**
   * The reference drill this operational lineage was promoted from, or null for
   * a lineage the gym authored itself -- OD-2026-09-16-001.
   *
   * INHERITED BY A REFINEMENT, never re-derived. A refinement changes what the
   * gym's drill SAYS; it does not change which reference drill the lineage came
   * from, and it must not silently re-point at a newer reference version. That
   * is why adoption copies this value forward rather than looking it up again,
   * and why pilot_drills_one_reference_per_org is scoped to lineage ROOTS: the
   * successor legitimately carries the same value as the predecessor it
   * supersedes. The one deliberate move is updateDrillToReferenceVersion (D1):
   * its new version points at the newer reference, and older versions keep
   * pointing at the one they were built from.
   */
  reference_drill_id: string | null;
  created_at: string;
  updated_at: string;
}

const DRILL_VERSION_FIELDS =
  'organization_id, drill_id, name, category, focus, cues, difficulty, active, '
  + 'version, lineage_id, supersedes_drill_id, superseded_at, superseded_by_drill_id, '
  + 'reference_drill_id, created_at, updated_at';

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

// A RETIRED DRILL IS NOT CHANGED THROUGH A CHANGE PROPOSAL (OD-2026-10-08-008
// D3, "Refuse back-door; keep block (Recommended)").
//
// Adoption inserts the next version with active = true. On a drill the gym has
// retired that would bring it back into use by a side road, past everything
// Restore checks (drills.ts#updateDrill: the reference must still be active;
// the drills route applies the cue rule). So both ends refuse: a change cannot
// be proposed for a retired drill, and one proposed while the drill was in use
// cannot be adopted after it is retired. Restore stays the one way back, and
// each message names it.
//
// "Retired" is getOperationalDrillLifecycle's definition below: NO version of
// the lineage is active. An inactive earlier version of a drill the gym still
// runs is 'changed', not retired, and neither refusal applies to it.
const DRILL_RETIRED_CODE = 'DRILL_RETIRED';
const PROPOSE_ON_RETIRED_MESSAGE =
  'This drill is retired, so a change cannot be proposed for it. Restore the drill first.';
const ADOPT_ON_RETIRED_MESSAGE =
  'This drill is retired, so this change cannot be adopted. Restore the drill first, or decline the proposal.';

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
  // The base drill's lineage, and whether any version of it is in use, in one
  // statement. Not the last word on its own -- a drill can be retired between
  // this read and a reviewer's adopt -- which is why adoptDrillChangeProposal
  // asks again under its lock.
  const baseDrill = await queryOne<{ lineage_id: string; lineage_active: boolean }>(
    `select d.lineage_id,
            exists (
              select 1 from pilot.drills l
              where l.organization_id = d.organization_id
                and l.lineage_id = d.lineage_id
                and l.active
            ) as lineage_active
     from pilot.drills d
     where d.organization_id = $1 and d.drill_id = $2`,
    [input.organizationId, input.basedOnDrillId],
  );
  if (!baseDrill) {
    throw new Error('DRILL_NOT_FOUND');
  }
  if (!baseDrill.lineage_active) {
    throw new ConflictError(PROPOSE_ON_RETIRED_MESSAGE, DRILL_RETIRED_CODE);
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
  /** Whether the drill is retired: it has versions and none is in use.
   *
   * True means an adopt would be refused (DRILL_RETIRED) even where
   * base_is_current is true -- the proposal is written against the newest
   * version, and the newest version is not running. Restore the drill and the
   * proposal is an ordinary one again; otherwise decline it. */
  lineage_retired: boolean;
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
 *
 * lineage_retired is the second half of that prediction, and matches the
 * adopt's own in-use read the same way: base_is_current says the proposal is
 * written against the newest version, lineage_retired says nobody runs the
 * drill. An adopt is refused when either stands in its way.
 */
export async function listDrillChangeProposals(
  organizationId: string,
  filter: { reviewState?: DrillChangeReviewState; lineageId?: string } = {},
): Promise<DrillChangeProposalListing[]> {
  return query<DrillChangeProposalListing>(
    `select ${PROPOSAL_FIELDS.split(', ').map((f) => `p.${f}`).join(', ')},
            cur.drill_id as current_drill_id,
            (cur.drill_id is not null and cur.drill_id = p.based_on_drill_id) as base_is_current,
            (cur.drill_id is not null and not exists (
              select 1 from pilot.drills a
              where a.organization_id = p.organization_id
                and a.lineage_id = p.lineage_id
                and a.active
            )) as lineage_retired
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

/**
 * Where one operational drill version stands now, for a coach looking at work
 * that was issued against it (W-D4B).
 *
 *   current -- this version is active.
 *   changed -- this version is inactive, but another version of the same
 *              lineage is active: the gym refined the drill (or reinstated an
 *              earlier version) and still runs it.
 *   retired -- no version of the lineage is active: the gym no longer runs it.
 *
 * "Inactive" alone cannot tell those last two apart, because adopting a change
 * proposal deactivates the version it replaces. Telling a coach the drill was
 * retired when it was only refined is false lifecycle information.
 *
 * STATUS ONLY. This reads the lineage to describe it, never to pick content
 * from it: the instruction shown for the work stays the one pinned by the
 * version it was issued against. Null when the drill is not in this gym.
 */
export type OperationalDrillLifecycle = 'current' | 'changed' | 'retired';

export async function getOperationalDrillLifecycle(
  organizationId: string,
  drillId: string,
): Promise<OperationalDrillLifecycle | null> {
  const row = await queryOne<{ active: boolean; lineage_active: boolean }>(
    `select d.active,
            exists (
              select 1 from pilot.drills l
              where l.organization_id = d.organization_id
                and l.lineage_id = d.lineage_id
                and l.active
            ) as lineage_active
     from pilot.drills d
     where d.organization_id = $1 and d.drill_id = $2`,
    [organizationId, drillId],
  );
  if (!row) return null;
  if (row.active) return 'current';
  return row.lineage_active ? 'changed' : 'retired';
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
 * Every version of the lineage one drill belongs to, oldest first -- for a
 * screen that holds a drill id and not its lineage id. Both reads are scoped to
 * this gym, so a drill id from another gym, or no drill at all, reads as an
 * empty list, the same answer getDrillLineage gives an unknown lineage.
 */
export async function getDrillLineageForDrill(organizationId: string, drillId: string): Promise<PilotDrillVersionRow[]> {
  return query<PilotDrillVersionRow>(
    `select ${DRILL_VERSION_FIELDS}
     from pilot.drills
     where organization_id = $1
       and lineage_id = (
         select lineage_id from pilot.drills where organization_id = $1 and drill_id = $2
       )
     order by version asc`,
    [organizationId, drillId],
  );
}

// UPDATE IN PLACE TO A NEWER REFERENCE VERSION (OD-2026-10-08-008 D1, "B Update
// in place (Recommended)"). Same refusal and same meaning of "retired" as the
// change-proposal gate above (D3): no version of the lineage is active.
const UPDATE_ON_RETIRED_MESSAGE =
  'This drill is retired, so it cannot be updated to the newer version. Restore the drill first.';

/** What the gym's new version says: the promote route's mapping of the newer reference. */
export interface ReferenceVersionContent {
  name: string;
  category: string;
  focus: string;
  cues: string[];
  difficulty: DrillDifficulty;
}

/**
 * Moves a gym's drill (`drillId`: any of its versions) to a newer version of the
 * reference it was adopted from. Writes v(n+1) of the SAME lineage from
 * `content` (the promote mapping), pointing at the newer reference -- the one
 * place reference_drill_id moves -- and deactivates and supersedes the old
 * newest version. Every version stays, so issued work keeps the instruction it
 * pinned. The coach's edits on the old version stay there (Jason, question card
 * 2026-10-11: "A: Start clean (Recommended)"); open change proposals are left to
 * read stale, as after any adopt.
 *
 * The caller has judged the reference (active, ready, the lineage head) and the
 * role. Decided here, under the lineage lock: retired (DRILL_RETIRED), already on
 * that version, and a name clash -- each refused with nothing written -- and,
 * as an integrity check, that the target is a NEWER version of the reference
 * the gym pins (a stale request after another update must not move it back). One transaction, the
 * caller's when `client` is given, audit row included.
 */
export async function updateDrillToReferenceVersion(
  input: {
    organizationId: string;
    drillId: string;
    referenceDrillId: string;
    content: ReferenceVersionContent;
    actorAccountId: string;
    actorRole: PilotRole;
    auditDetails?: Record<string, unknown>;
  },
  client?: PoolClient,
): Promise<{ drill: PilotDrillVersionRow; previous: PilotDrillVersionRow }> {
  const run = async (tx: PoolClient) => {
    // Every row of the lineage, locked in a statement of its own as a restore
    // does (drills.ts#updateDrill), so the reads below see any Retire, Restore
    // or adopt that held these rows first.
    const locked = await tx.query(
      `select 1 from pilot.drills l
       where l.organization_id = $1
         and l.lineage_id = (
           select d.lineage_id from pilot.drills d
           where d.organization_id = $1 and d.drill_id = $2
         )
       for update`,
      [input.organizationId, input.drillId],
    );
    if (locked.rows.length === 0) {
      throw new Error('DRILL_NOT_FOUND');
    }

    // The newest version, whether any version is in use, and whether the target
    // is a newer version in the reference lineage the gym pins (an integrity
    // check on the caller; both callers pass one that is, barring a race).
    const headResult = await tx.query<PilotDrillVersionRow & { lineage_active: boolean; same_reference_lineage: boolean }>(
      `select ${DRILL_VERSION_FIELDS.split(', ').map((field) => `h.${field}`).join(', ')},
              exists (
                select 1 from pilot.drills a
                where a.organization_id = h.organization_id and a.lineage_id = h.lineage_id and a.active
              ) as lineage_active,
              exists (
                select 1 from pilot.drill_library pinned
                join pilot.drill_library target
                  on target.organization_id = pinned.organization_id
                 and target.lineage_id = pinned.lineage_id
                 and target.version > pinned.version
                where pinned.organization_id = h.organization_id
                  and pinned.drill_id = h.reference_drill_id
                  and target.drill_id = $3
              ) as same_reference_lineage
       from pilot.drills d
       join pilot.drills h
         on h.organization_id = d.organization_id and h.lineage_id = d.lineage_id
       where d.organization_id = $1 and d.drill_id = $2
       order by h.version desc
       limit 1`,
      [input.organizationId, input.drillId, input.referenceDrillId],
    );
    const { lineage_active: lineageActive, same_reference_lineage: sameReferenceLineage, ...previous } = headResult.rows[0];

    if (!lineageActive) {
      throw new ConflictError(UPDATE_ON_RETIRED_MESSAGE, DRILL_RETIRED_CODE);
    }
    if (previous.reference_drill_id === input.referenceDrillId) {
      throw new ReferenceDrillAlreadyPromotedError(input.referenceDrillId);
    }
    if (!sameReferenceLineage) {
      throw new Error('REFERENCE_VERSION_NOT_NEWER_IN_DRILL_LINEAGE');
    }

    // Deactivated before the insert, as in the adopt (one active row per name);
    // every active version, so exactly one runs afterwards.
    await tx.query(
      `update pilot.drills
       set active = false,
           superseded_at = case when drill_id = $3 then now() else superseded_at end,
           updated_at = now()
       where organization_id = $1 and lineage_id = $2 and (active or drill_id = $3)`,
      [input.organizationId, previous.lineage_id, previous.drill_id],
    );

    const newDrillId = randomUUID();
    let inserted;
    try {
      inserted = await tx.query<PilotDrillVersionRow>(
        `insert into pilot.drills
           (organization_id, drill_id, name, category, focus, cues, difficulty, active,
            version, lineage_id, supersedes_drill_id, reference_drill_id)
         values ($1,$2,$3,$4,$5,$6::text[],$7,true,$8,$9,$10,$11)
         returning ${DRILL_VERSION_FIELDS}`,
        [
          input.organizationId,
          newDrillId,
          input.content.name,
          input.content.category,
          input.content.focus,
          input.content.cues,
          input.content.difficulty,
          previous.version + 1,
          previous.lineage_id,
          previous.drill_id,
          input.referenceDrillId,
        ],
      );
    } catch (error) {
      if (isDrillNameCollision(error)) {
        throw new DrillNameTakenError(input.content.name);
      }
      throw error;
    }
    const drill = inserted.rows[0];

    await tx.query(
      `update pilot.drills set superseded_by_drill_id = $3
       where organization_id = $1 and drill_id = $2`,
      [input.organizationId, previous.drill_id, newDrillId],
    );

    await writePilotAuditEvent(
      {
        event_type: 'update',
        actor_account_id: input.actorAccountId,
        actor_role: input.actorRole,
        organization_id: input.organizationId,
        entity_type: 'drill',
        entity_id: drill.drill_id,
        details: {
          action: 'reference_version_update',
          lineage_id: drill.lineage_id,
          version: drill.version,
          from_drill_id: previous.drill_id,
          from_reference_drill_id: previous.reference_drill_id,
          reference_drill_id: drill.reference_drill_id,
          name: drill.name,
          category: drill.category,
          difficulty: drill.difficulty,
          ...input.auditDetails,
        },
      },
      tx,
    );

    return { drill, previous };
  };

  return client ? run(client) : withTransaction(run);
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

    // THE RETIRED GATE (see the note above proposeDrillChange). The INSERT
    // below always writes active = true, so this is the statement that would
    // re-open a retired drill, and the refusal that cannot be bypassed lives
    // here rather than only at propose time.
    //
    // An active newest version means the drill is in use and costs no query.
    // Otherwise the lineage is asked: only when NO version is active is the
    // drill retired. The newest version is locked above, and when it is the
    // version in use Retire is an UPDATE of that row, so a retirement that
    // committed first is seen here.
    //
    // BEFORE the staleness check on purpose. "Written against an earlier
    // version" invites a re-proposal against the newest one, and on a retired
    // drill that re-proposal is refused too. Retired is the true answer.
    if (!current.active) {
      const inUse = await client.query(
        `select 1 as in_use
         from pilot.drills
         where organization_id = $1 and lineage_id = $2 and active
         limit 1`,
        [input.organizationId, proposal.lineage_id],
      );
      if (inUse.rows.length === 0) {
        throw new ConflictError(ADOPT_ON_RETIRED_MESSAGE, DRILL_RETIRED_CODE);
      }
    }

    if (current.drill_id !== proposal.based_on_drill_id) {
      throw new Error('DRILL_CHANGE_PROPOSAL_STALE_BASE_VERSION');
    }

    const merged = applyProposedChange(current, proposal.proposed_change);

    // THE CUE RULE ON A NEW VERSION (OD-2026-10-06-026). A change that touches
    // the cues or the category must not leave a technique drill without a cue.
    // A change that touches neither keeps whatever the drill already had, so an
    // existing cue-less drill is not blocked from an unrelated revision.
    const changes = proposal.proposed_change as Record<string, unknown>;
    if (Object.hasOwn(changes, 'cues') || Object.hasOwn(changes, 'category')) {
      await assertDrillMeetsCueRule({
        organizationId: input.organizationId,
        name: merged.name,
        category: merged.category,
        cues: Array.isArray(merged.cues) ? merged.cues.filter((cue) => typeof cue === 'string') : [],
        referenceDrillId: current.reference_drill_id,
      });
    }
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
        // reference_drill_id is carried from `current` rather than taken from
        // the proposal: it is not a content field, and EDITABLE_DRILL_FIELDS
        // deliberately excludes it, so a proposed_change naming it is ignored
        // exactly like one naming `version`.
        `insert into pilot.drills
           (organization_id, drill_id, name, category, focus, cues, difficulty, active,
            version, lineage_id, supersedes_drill_id, reference_drill_id)
         values ($1,$2,$3,$4,$5,$6::text[],$7,true,$8,$9,$10,$11)
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
          current.reference_drill_id,
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

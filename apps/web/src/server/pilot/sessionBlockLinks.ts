import { query, queryOne } from './db';

// Which delivered session supported which athlete development block.
//
// THE LINK IS A COACH'S STATEMENT. Nothing in this module infers that a
// session served a block because their dates overlap, because the athlete was
// present, or because a drill name matched an emphasis string. A human says
// so and that saying is what is stored. An inferred link would be this
// platform asserting what a session was FOR -- which is coaching -- and every
// later read would inherit the guess.
//
// NOTHING IS COUNTED, SCORED OR DERIVED. No sessions-per-block total, no
// coverage or adherence percentage, no "on track" judgement. This is the
// module where that temptation actually arrives: once sessions are countable
// against a plan, "72% of planned sessions delivered" is one aggregate away,
// and it would be a compliance figure about a coach's work with a child
// assembled from links nobody validated. The reads below return rows; what
// they mean is the coach's to decide.
//
// AUTHORIZATION IS THE WHOLE PROBLEM HERE, and it runs the opposite way from
// the rest of this lane. A block is a record about ONE named minor. A
// delivered session is a gym-level record that names no athlete at all. So
// linking them creates a read -- "which blocks did this session support" --
// that turns a gym-level record into a list of children who have development
// plans. listBlocksForRun therefore takes the caller's permitted athlete ids
// as a REQUIRED argument and filters in SQL. It is not optional and there is
// no "null means unrestricted" mode: an organization admin's caller passes
// the organization's athlete ids explicitly, so the unrestricted case has to
// be constructed on purpose and cannot be reached by forgetting an argument.
// Whole-gym roster visibility is not athlete-record authorization, and this
// is exactly the surface where the two are easiest to confuse.

export interface SessionBlockLinkRow {
  organization_id: string;
  run_id: string;
  block_id: string;
  linked_by_account_id: string;
  created_at: string;
}

/**
 * A session that supported a block, with the run's OWN recorded facts.
 *
 * The run's account of itself -- what the coach wrote in deviation_note,
 * what_worked and what_did_not -- is carried through verbatim rather than
 * summarised. It is the answer to the build order's "which actual activities
 * occurred", and it already exists on pilot.session_script_runs; this read
 * joins it rather than storing a second copy.
 */
export interface LinkedSessionRow {
  run_id: string;
  script_id: string;
  script_name: string;
  delivered_on: string;
  delivered_by_account_id: string;
  run_state: string | null;
  athletes_present: number | null;
  blocks_completed: number | null;
  deviation_note: string;
  what_worked: string;
  what_did_not: string;
  linked_by_account_id: string;
  linked_at: string;
}

/** A block a session supported, as the run-side read returns it. */
export interface LinkedBlockRow {
  block_id: string;
  athlete_id: string;
  title: string;
  training_emphasis: string;
  starts_on: string;
  ends_on: string;
  status: string;
  linked_by_account_id: string;
  linked_at: string;
}

/** A settled run, for the picker that offers sessions to link. */
export interface SelectableRunRow {
  run_id: string;
  script_id: string;
  script_name: string;
  delivered_on: string;
  run_state: string | null;
}

/**
 * Records that a session supported a block.
 *
 * Returns null when either side is not in this organization -- a hidden
 * not-found, so neither a run id nor a block id can be probed for through
 * this path. The caller is responsible for the athlete-access check on the
 * block's athlete BEFORE calling; this module deliberately does not reach for
 * the session principal, because a data module that authorized itself would
 * be a second copy of the access contract.
 *
 * Linking twice is a NO-OP that returns the existing link rather than an
 * error. The primary key already refuses the duplicate row; turning that into
 * a 409 would make an ordinary double-click look like a failure, and the
 * second click asked for a state that is already true.
 */
export async function linkSessionToBlock(input: {
  organizationId: string;
  runId: string;
  blockId: string;
  linkedByAccountId: string;
}): Promise<{ link: SessionBlockLinkRow; created: boolean } | null> {
  const run = await queryOne<{ run_id: string }>(
    `select run_id from pilot.session_script_runs
     where organization_id = $1 and run_id = $2`,
    [input.organizationId, input.runId],
  );
  if (!run) return null;

  const block = await queryOne<{ block_id: string }>(
    `select block_id from pilot.athlete_development_blocks
     where organization_id = $1 and block_id = $2`,
    [input.organizationId, input.blockId],
  );
  if (!block) return null;

  const inserted = await queryOne<SessionBlockLinkRow>(
    `insert into pilot.session_run_development_block_links
       (organization_id, run_id, block_id, linked_by_account_id)
     values ($1, $2, $3, $4)
     on conflict do nothing
     returning organization_id, run_id, block_id, linked_by_account_id, created_at`,
    [input.organizationId, input.runId, input.blockId, input.linkedByAccountId],
  );

  if (inserted) return { link: inserted, created: true };

  // The conflict path: the link already existed. Read it back rather than
  // synthesising one, so `linked_by_account_id` names whoever ACTUALLY said
  // it first -- not whoever clicked most recently.
  const existing = await queryOne<SessionBlockLinkRow>(
    `select organization_id, run_id, block_id, linked_by_account_id, created_at
     from pilot.session_run_development_block_links
     where organization_id = $1 and run_id = $2 and block_id = $3`,
    [input.organizationId, input.runId, input.blockId],
  );
  return existing ? { link: existing, created: false } : null;
}

/**
 * Removes a link. True when a row was removed, false when there was nothing
 * to remove -- which is also what a link in another organization returns.
 *
 * Unlinking deletes the statement, not the session and not the block. Both
 * survive: a coach who linked the wrong session is correcting a claim about
 * what a session was for, and neither record of what happened changes.
 */
export async function unlinkSessionFromBlock(
  organizationId: string,
  runId: string,
  blockId: string,
): Promise<boolean> {
  const removed = await queryOne<{ run_id: string }>(
    `delete from pilot.session_run_development_block_links
     where organization_id = $1 and run_id = $2 and block_id = $3
     returning run_id`,
    [organizationId, runId, blockId],
  );
  return removed !== null;
}

/**
 * The sessions a coach says supported this block, most recently delivered
 * first.
 *
 * Organization-scoped, and the caller must already have cleared the block's
 * athlete through the access contract -- a block id is only obtainable from a
 * read that did.
 */
export async function listSessionsForBlock(
  organizationId: string,
  blockId: string,
): Promise<LinkedSessionRow[]> {
  return query<LinkedSessionRow>(
    `select r.run_id,
            r.script_id,
            s.name as script_name,
            r.delivered_on::text as delivered_on,
            r.delivered_by_account_id,
            r.run_state,
            r.athletes_present,
            r.blocks_completed,
            r.deviation_note,
            r.what_worked,
            r.what_did_not,
            l.linked_by_account_id,
            l.created_at as linked_at
     from pilot.session_run_development_block_links l
     join pilot.session_script_runs r
       on r.organization_id = l.organization_id and r.run_id = l.run_id
     join pilot.session_scripts s
       on s.organization_id = r.organization_id and s.script_id = r.script_id
     where l.organization_id = $1 and l.block_id = $2
     order by r.delivered_on desc, r.created_at desc, r.run_id`,
    [organizationId, blockId],
  );
}

/**
 * The blocks a session supported -- FILTERED to athletes this caller may
 * reach.
 *
 * `allowedAthleteIds` is required and is applied in the WHERE clause. There
 * is deliberately no unrestricted mode: a delivered session names no athlete,
 * so an unfiltered version of this read would turn a gym-level record into a
 * list of which children have development plans, for anyone who could name a
 * run id. An organization admin's caller passes the organization's athlete
 * ids explicitly, which is the same answer arrived at deliberately.
 *
 * An empty list short-circuits to no rows rather than to `= any('{}')`, which
 * is the same result but goes to the database to find it out.
 */
export async function listBlocksForRun(
  organizationId: string,
  runId: string,
  allowedAthleteIds: readonly string[],
): Promise<LinkedBlockRow[]> {
  if (allowedAthleteIds.length === 0) return [];

  return query<LinkedBlockRow>(
    `select b.block_id,
            b.athlete_id,
            b.title,
            b.training_emphasis,
            b.starts_on::text as starts_on,
            b.ends_on::text as ends_on,
            b.status,
            l.linked_by_account_id,
            l.created_at as linked_at
     from pilot.session_run_development_block_links l
     join pilot.athlete_development_blocks b
       on b.organization_id = l.organization_id and b.block_id = l.block_id
     where l.organization_id = $1
       and l.run_id = $2
       and b.athlete_id = any($3::text[])
     order by l.created_at desc, b.block_id`,
    [organizationId, runId, [...allowedAthleteIds]],
  );
}

/**
 * The athlete ids this run's links name, and NOTHING ELSE about them.
 *
 * The candidate list for the access filter, and it exists so the filter can
 * be applied by the central contract rather than reimplemented here: a caller
 * feeds this to accessibleAthleteIds and passes the permitted subset back to
 * listBlocksForRun. Ids only, deliberately -- no title, no emphasis, no
 * athlete name -- so the one read that is unavoidably unfiltered carries
 * nothing a caller could learn anything from beyond ids they must then earn.
 */
export async function athleteIdsLinkedToRun(
  organizationId: string,
  runId: string,
): Promise<string[]> {
  const rows = await query<{ athlete_id: string }>(
    `select distinct b.athlete_id
     from pilot.session_run_development_block_links l
     join pilot.athlete_development_blocks b
       on b.organization_id = l.organization_id and b.block_id = l.block_id
     where l.organization_id = $1 and l.run_id = $2`,
    [organizationId, runId],
  );
  return rows.map((row) => row.athlete_id);
}

/**
 * Settled sessions in this organization, most recently delivered first, for
 * the picker.
 *
 * NOT athlete-gated, and deliberately: a delivered session carries no athlete
 * id -- only a head count and who delivered it -- so it is an organization
 * fixture in the same sense a competition is. Gating it would require an
 * athlete id this read has no business asking for. WHICH BLOCK a session may
 * be attached to is the athlete question, and the write path answers it.
 *
 * In-progress runs are excluded: a session still being delivered has not
 * finished being what it was, and linking one would be a claim about work
 * that has not happened yet.
 */
export async function listSelectableRuns(
  organizationId: string,
  limit = 50,
): Promise<SelectableRunRow[]> {
  return query<SelectableRunRow>(
    `select r.run_id,
            r.script_id,
            s.name as script_name,
            r.delivered_on::text as delivered_on,
            r.run_state
     from pilot.session_script_runs r
     join pilot.session_scripts s
       on s.organization_id = r.organization_id and s.script_id = r.script_id
     where r.organization_id = $1
       and (r.run_state is null or r.run_state in ('completed', 'abandoned'))
     order by r.delivered_on desc, r.created_at desc, r.run_id
     limit $2`,
    [organizationId, limit],
  );
}

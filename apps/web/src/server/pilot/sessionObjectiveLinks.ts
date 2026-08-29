import { hasBlockWriteMembership } from './athleteDevelopmentBlocks';
import { query, queryOne } from './db';
import { ForbiddenError } from './errors';

// Which Full Spectrum objectives a coach says a delivered session addressed.
//
// THE LINK IS A COACH'S STATEMENT. Nothing here infers that a session
// addressed an objective because their dates overlap, because the drills the
// script ran sound like the objective's domain, or because the words match.
// A human says so and that saying is what is stored. An inferred link would
// be this platform deciding what a session was FOR, and a plan-versus-actual
// read built on it would compare a plan against its own guesses.
//
// NOTHING IS COUNTED, WEIGHTED OR DERIVED, and the pressure is higher here
// than anywhere else in this lane. Objectives carry a domain and a status,
// and sessions now attach to them -- one GROUP BY from "technical: 4
// sessions, nutrition: 0", a per-domain coverage chart about a child's
// training, and one step further from an objective completed because enough
// sessions pointed at it. The reads below return rows. What they mean is the
// coach's to decide.
//
// A ZERO HERE IS NOT A FINDING. An objective with no linked sessions means
// nobody recorded a link, which is the ordinary state of a record coaches
// fill in when they have a minute. It does not mean the domain was
// neglected, and no surface over this module may render it as though it did.
//
// AUTHORIZATION LIVES ON THE BLOCK, SO ASK THE BLOCK -- exactly as #762's own
// objectives module does. An objective is reachable when its parent block is
// reachable, and getDevelopmentBlock already answers that for the actor, with
// "no such block" and "not your athlete" deliberately indistinguishable. This
// module therefore takes ids that the CALLER has already cleared through that
// contract, and its own writes re-check the relationship in SQL rather than
// trusting the caller to have checked the right thing.
//
// THE WRITE FLOOR IS A SECOND, SEPARATE QUESTION, and it is enforced here.
// "May this actor reach this child" is the access contract's and stays with
// the caller. "Does this account hold a role in THIS gym that may write at
// all" is a floor, and the routes' requireRole did not answer it: requireRole
// compares principal.role, which resolvePrincipal reads from
// pilot.accounts.role -- the account's HOME role, not the role on the
// membership row for the organization the session is operating in. An account
// homed as 'coach' whose membership here was demoted passed it, and passed the
// athlete check too while it was still named as athletes.coach_id.
//
// hasBlockWriteMembership is called rather than copied: athleteDevelopmentBlocks.ts
// exports it "for the objectives module, so one decision is enforced in one
// place for both tables", and this is that module.

export interface SessionObjectiveLinkRow {
  organization_id: string;
  run_id: string;
  objective_id: string;
  block_id: string;
  linked_by_account_id: string;
  created_at: string;
}

/** An objective a session addressed, as the session-side read returns it. */
export interface LinkedObjectiveRow {
  objective_id: string;
  block_id: string;
  domain: string;
  objective: string;
  status: string;
  linked_by_account_id: string;
  linked_at: string;
}

/** A session that addressed an objective, with the run's own account of itself. */
export interface ObjectiveSessionRow {
  run_id: string;
  script_name: string;
  delivered_on: string;
  deviation_note: string;
  what_worked: string;
  what_did_not: string;
  linked_by_account_id: string;
  linked_at: string;
}

/**
 * Records that a session addressed an objective.
 *
 * Returns null when the objective is not in this organization, or is not in
 * the block the session is linked to, or the session was never linked to that
 * block at all. All three read the same way to a caller -- a hidden not-found
 * -- so none of them can be used to discover which of the three it was.
 *
 * THE BLOCK LINK IS THE PRECONDITION, and it is not merely checked here: the
 * insert names (run_id, block_id) into a composite FK against the block-link
 * table, so a row cannot exist without one. The SELECT below exists to turn
 * that into a null instead of a driver error, and to establish which block
 * the objective belongs to in the first place -- the caller never supplies
 * it, so it cannot be wrong about it.
 *
 * Linking twice is a NO-OP that returns the existing link. The primary key
 * refuses the duplicate row; turning that into an error would make an
 * ordinary double-click look like a failure when the second click asked for a
 * state that is already true.
 */
export async function linkSessionToObjective(input: {
  organizationId: string;
  runId: string;
  objectiveId: string;
  linkedByAccountId: string;
}): Promise<{ link: SessionObjectiveLinkRow; created: boolean } | null> {
  /* Checked FIRST, before any existence read, so a caller with no standing in
     this gym learns nothing about which run, block or objective ids are real. */
  if (!(await hasBlockWriteMembership(input.linkedByAccountId, input.organizationId))) {
    throw new ForbiddenError(
      'This account holds no active membership in this organization that may write here.',
      'SESSION_OBJECTIVE_LINK_NOT_A_WRITER',
    );
  }

  /* One statement for the whole precondition: the objective exists in this
     organization AND the session is already linked to that objective's block.
     Asking in one place means the block_id written below is the objective's
     own, never a value assembled from two reads that could disagree. */
  const eligible = await queryOne<{ block_id: string }>(
    `select o.block_id
     from pilot.athlete_development_block_objectives o
     join pilot.session_run_development_block_links l
       on l.organization_id = o.organization_id
      and l.block_id = o.block_id
      and l.run_id = $3
     where o.organization_id = $1 and o.objective_id = $2`,
    [input.organizationId, input.objectiveId, input.runId],
  );
  if (!eligible) return null;

  const inserted = await queryOne<SessionObjectiveLinkRow>(
    `insert into pilot.session_run_block_objective_links
       (organization_id, run_id, objective_id, block_id, linked_by_account_id)
     values ($1, $2, $3, $4, $5)
     on conflict do nothing
     returning organization_id, run_id, objective_id, block_id,
               linked_by_account_id, created_at`,
    [
      input.organizationId,
      input.runId,
      input.objectiveId,
      eligible.block_id,
      input.linkedByAccountId,
    ],
  );

  if (inserted) return { link: inserted, created: true };

  // The conflict path. Read it back rather than synthesising one, so
  // linked_by_account_id names whoever ACTUALLY said it first.
  const existing = await queryOne<SessionObjectiveLinkRow>(
    `select organization_id, run_id, objective_id, block_id,
            linked_by_account_id, created_at
     from pilot.session_run_block_objective_links
     where organization_id = $1 and run_id = $2 and objective_id = $3`,
    [input.organizationId, input.runId, input.objectiveId],
  );
  return existing ? { link: existing, created: false } : null;
}

/**
 * Removes a link. True when a row went, false when there was nothing to
 * remove -- which is also what a link in another organization, or a link
 * belonging to a different block, returns.
 *
 * Removing the statement leaves the session, the block link and the objective
 * exactly as they were. A coach who marked the wrong objective is correcting
 * a claim about what a class worked on, and none of the three records of what
 * happened changes.
 *
 * `blockId` IS REQUIRED, AND IT IS NOT REDUNDANT WITH THE PRIMARY KEY. It is
 * the block the CALLER cleared through getDevelopmentBlock, re-checked here
 * in SQL -- the discipline this module's header states and the one place that
 * did not keep it.
 *
 * Without it the delete was scoped to (organization_id, run_id, objective_id)
 * alone: authorization was proved about one block and then spent on whatever
 * block the objective actually belonged to. A coach cleared for their own
 * athlete's block could unlink an objective on a block for a child they
 * cannot reach -- run ids are obtainable from the deliberately un-gated
 * `?runs=options` picker, and the whole-gym roster is not athlete-record
 * authorization. It stayed inside one organization, and that is the only
 * thing that bounded it.
 *
 * The predicate cannot delete a row the old statement would not have: the
 * primary key is (organization_id, run_id, objective_id), so at most one row
 * matches either way. It can only REFUSE one -- which is the point.
 */
export async function unlinkSessionFromObjective(
  organizationId: string,
  runId: string,
  objectiveId: string,
  blockId: string,
  accountId: string,
): Promise<boolean> {
  // Same floor as linking. Removing a coach's statement about what a class
  // worked on is a write, and a demoted account may not make it either.
  if (!(await hasBlockWriteMembership(accountId, organizationId))) {
    throw new ForbiddenError(
      'This account holds no active membership in this organization that may write here.',
      'SESSION_OBJECTIVE_LINK_NOT_A_WRITER',
    );
  }

  const removed = await queryOne<{ run_id: string }>(
    `delete from pilot.session_run_block_objective_links
     where organization_id = $1 and run_id = $2 and objective_id = $3
       and block_id = $4
     returning run_id`,
    [organizationId, runId, objectiveId, blockId],
  );
  return removed !== null;
}

/**
 * The objectives a session addressed, within ONE block.
 *
 * Scoped to a block rather than to the whole run on purpose. A group session
 * may serve several athletes' blocks, and answering "every objective this
 * class addressed" would hand back objectives belonging to children the
 * caller has not been cleared for. The caller clears the block first --
 * getDevelopmentBlock decides that -- and asks per block.
 */
export async function listObjectivesForSessionBlock(
  organizationId: string,
  runId: string,
  blockId: string,
): Promise<LinkedObjectiveRow[]> {
  return query<LinkedObjectiveRow>(
    `select o.objective_id,
            o.block_id,
            o.domain,
            o.objective,
            o.status,
            l.linked_by_account_id,
            l.created_at as linked_at
     from pilot.session_run_block_objective_links l
     join pilot.athlete_development_block_objectives o
       on o.organization_id = l.organization_id
      and o.objective_id = l.objective_id
     where l.organization_id = $1 and l.run_id = $2 and l.block_id = $3
     order by o.created_at asc, o.objective_id`,
    [organizationId, runId, blockId],
  );
}

/**
 * Every objective link under one block, across all its sessions.
 *
 * The read a coach does when they open a block: for each objective, which
 * classes worked on it. Returned flat, keyed by objective, because grouping
 * is a rendering decision and a module that grouped would be choosing what
 * the shape of the answer means.
 */
export async function listObjectiveLinksForBlock(
  organizationId: string,
  blockId: string,
): Promise<(LinkedObjectiveRow & { run_id: string })[]> {
  return query<LinkedObjectiveRow & { run_id: string }>(
    `select l.run_id,
            o.objective_id,
            o.block_id,
            o.domain,
            o.objective,
            o.status,
            l.linked_by_account_id,
            l.created_at as linked_at
     from pilot.session_run_block_objective_links l
     join pilot.athlete_development_block_objectives o
       on o.organization_id = l.organization_id
      and o.objective_id = l.objective_id
     where l.organization_id = $1 and l.block_id = $2
     order by o.created_at asc, o.objective_id, l.created_at desc`,
    [organizationId, blockId],
  );
}

/**
 * The sessions that addressed one objective, most recently delivered first,
 * with what each run recorded about itself.
 *
 * The run's own words come through verbatim -- they are the build order's
 * "which actual activities occurred", already stored on the run, and this
 * joins them rather than keeping a second copy.
 */
export async function listSessionsForObjective(
  organizationId: string,
  objectiveId: string,
): Promise<ObjectiveSessionRow[]> {
  return query<ObjectiveSessionRow>(
    `select r.run_id,
            s.name as script_name,
            r.delivered_on::text as delivered_on,
            r.deviation_note,
            r.what_worked,
            r.what_did_not,
            l.linked_by_account_id,
            l.created_at as linked_at
     from pilot.session_run_block_objective_links l
     join pilot.session_script_runs r
       on r.organization_id = l.organization_id and r.run_id = l.run_id
     join pilot.session_scripts s
       on s.organization_id = r.organization_id and s.script_id = r.script_id
     where l.organization_id = $1 and l.objective_id = $2
     order by r.delivered_on desc, r.created_at desc, r.run_id`,
    [organizationId, objectiveId],
  );
}

/**
 * Auto-close: the app closes a training session nobody checked out of.
 *
 * Owner ruling OD-2026-10-06-024 Q4, in Jason's words: "1 bt check in give 20
 * min before auto close if nothing else is used in the ap for the athlet auto
 * close and keep record of the 20 min inactivity". OD-2026-10-08-007 settled
 * the two open halves: ACTIVITY (O6 = A1) is anything SAVED by or about the
 * athlete -- the eight signals below; LENGTH (O7 = B1) of an auto-closed
 * session runs check-in to last activity, with the close time and the window
 * still stored on the row.
 *
 * The storage half shipped in the session-close migration
 * (infra/azure/pilot_slice_postgres_session_close_migration.sql): this module
 * is the mechanism that fills it for 'auto_inactivity'.
 *
 * THE RULE, as one SQL statement per organization:
 *   for every OPEN session (completed_flag false) old enough to matter,
 *     last_activity_at = the newest of the eight signals for that athlete at or
 *                        after the check-in, never later than `now`;
 *     if now - last_activity_at >= the window, close it:
 *       completed_flag true, close_method 'auto_inactivity',
 *       last_activity_at as computed, inactivity_minutes = the window,
 *       checked_out_at = last_activity_at + the window,
 *     and write one audit row per closed session, in the same transaction.
 *
 * THE EIGHT SIGNALS (CHECKOUT-AUTOCLOSE-plan-2026-10-07 section 2, ruled A1).
 * Each is a write that already lands in Postgres with the athlete's id and a
 * timestamp. Where a table carries both the event's own stamp (what the
 * client said happened) and the save stamp, the newer of the two counts: the
 * ruling is about something being SAVED, and a back-dated entry saved just now
 * is still activity just now.
 *   1 own session note     pilot.sessions.updated_at of the open row itself
 *   2 wellness check-in    pilot.athlete_check_ins.created_at
 *   3 drill completion     pilot.assignment_completions completed_at / created_at
 *   4 training attempt     pilot.training_attempts attempted_at / created_at
 *   5 pain report          pilot.shadow_formula_observations observed_at / created_at
 *   6 class check-in       pilot.scheduler_attendance checked_in_at / updated_at
 *   7 coach note           pilot.coach_observations created_at / updated_at
 *   8 any audited write    pilot.audit_events.created_at where details->>'athlete_id'
 *                          names the athlete (session create/update, goals,
 *                          consent ... every mutation route writes one)
 * Nothing here can see a screen that is merely open: there is no per-request
 * "last seen" write (plan section 2, option A3, not ruled). A kid who reads
 * the floor for 25 minutes and saves nothing is closed.
 *
 * WHAT THIS NEVER DOES. It never touches duration_minutes (the athlete's own
 * typed minutes), rpe or notes. It never closes a session that is already
 * closed, so a manual check-out is never overwritten: the UPDATE's WHERE
 * carries completed_flag = false and re-reads it under the row lock, so two
 * concurrent sweeps close a row once and audit it once. It is scoped to one
 * organization per call, exactly like every other pilot read.
 *
 * TWO CALLERS. The sessions list read (app/api/pilot/sessions/list/route.ts)
 * sweeps the caller's organization before answering, so a stale session
 * closes the next time anyone looks; the nightly script
 * (scripts/pilot-close-inactive-sessions.mjs) sweeps every organization so a
 * session nobody looks at still closes. Both run this one statement.
 */

import type { PoolClient } from 'pg';

import { writePilotAuditEvent } from './audit';
import { query, withTransaction } from './db';

/** The window from the ruling: "give 20 min before auto close". */
export const SESSION_INACTIVITY_WINDOW_MINUTES = 20;

/** The upper bound the session-close migration's CHECK allows for inactivity_minutes. */
const MAX_WINDOW_MINUTES = 1440;

/** What ran the sweep; stored in the audit row so the record says which path closed the session. */
export type AutoCloseTrigger = 'sessions_list' | 'scheduled';

export interface AutoCloseOptions {
  /** Minutes without a saved signal before a session closes. Default 20 (OD-2026-10-06-024 Q4). */
  readonly windowMinutes?: number;
  /** "Now" for the comparison. Default: the JS clock. Tests pin it. */
  readonly now?: Date;
}

/** An open session the rule would close. created_at is the check-in. */
export interface InactiveSessionCandidate {
  readonly session_id: string;
  readonly athlete_id: string;
  readonly created_at: Date;
  readonly last_activity_at: Date;
}

/** A session the sweep closed. checked_out_at = last_activity_at + the window. */
export interface AutoClosedSession extends InactiveSessionCandidate {
  readonly checked_out_at: Date;
}

function resolveWindow(options: AutoCloseOptions): number {
  const minutes = options.windowMinutes ?? SESSION_INACTIVITY_WINDOW_MINUTES;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_WINDOW_MINUTES) {
    throw new Error(`INVALID_INACTIVITY_WINDOW: ${String(minutes)} (must be an integer 1..${MAX_WINDOW_MINUTES})`);
  }
  return minutes;
}

function resolveNow(options: AutoCloseOptions): Date {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error('INVALID_NOW');
  return now;
}

/**
 * The candidate query. Parameters: $1 organization_id, $2 now (timestamptz),
 * $3 window minutes (integer). Returns one row per open session whose newest
 * signal is at least the window ago.
 *
 * greatest() ignores NULLs, so a signal with no rows drops out and
 * created_at (the check-in) is the floor. least(now, ...) caps the result at
 * the sweep's own clock, so the row never records a last activity or a close
 * later than the sweep that wrote it; a future-dated save (a client clock
 * ahead of the server) therefore reads as "just now" on every sweep until its
 * stamp is past, and the session closes 20 minutes after the stamp. That is
 * the conservative direction: the app never closes a session something was
 * saved on "later" than now. The `>= s.created_at` filters are the
 * index-friendly form of "at or after the check-in"; greatest() with
 * created_at already makes an older signal irrelevant.
 *
 * The outer WHERE is the only place the rule's comparison lives: a session
 * created less than the window ago can never match it, so no separate age
 * filter is needed and the two cannot disagree.
 */
const INACTIVE_SESSIONS_SQL = `
  with open_session as (
    select
      s.organization_id,
      s.session_id,
      s.athlete_id,
      s.created_at,
      least(
        $2::timestamptz,
        greatest(
          s.created_at,
          -- 1 own session note (publication keeps completed_flag false and rewrites updated_at)
          s.updated_at,
          -- 2 wellness check-in
          (select max(c.created_at)
             from pilot.athlete_check_ins c
            where c.organization_id = s.organization_id and c.athlete_id = s.athlete_id
              and c.created_at >= s.created_at),
          -- 3 drill completion
          (select max(greatest(x.completed_at, x.created_at))
             from pilot.assignment_completions x
            where x.organization_id = s.organization_id and x.athlete_id = s.athlete_id
              and greatest(x.completed_at, x.created_at) >= s.created_at),
          -- 4 training attempt
          (select max(greatest(t.attempted_at, t.created_at))
             from pilot.training_attempts t
            where t.organization_id = s.organization_id and t.athlete_id = s.athlete_id
              and greatest(t.attempted_at, t.created_at) >= s.created_at),
          -- 5 pain report / observation
          (select max(greatest(o.observed_at, o.created_at))
             from pilot.shadow_formula_observations o
            where o.organization_id = s.organization_id and o.athlete_id = s.athlete_id
              and greatest(o.observed_at, o.created_at) >= s.created_at),
          -- 6 class check-in
          (select max(greatest(a.checked_in_at, a.updated_at))
             from pilot.scheduler_attendance a
            where a.organization_id = s.organization_id and a.athlete_id = s.athlete_id
              and greatest(a.checked_in_at, a.updated_at) >= s.created_at),
          -- 7 coach note on the athlete
          (select max(greatest(n.created_at, n.updated_at))
             from pilot.coach_observations n
            where n.organization_id = s.organization_id and n.athlete_id = s.athlete_id
              and greatest(n.created_at, n.updated_at) >= s.created_at),
          -- 8 any audited write naming the athlete
          (select max(e.created_at)
             from pilot.audit_events e
            where e.organization_id = s.organization_id
              and e.details->>'athlete_id' = s.athlete_id
              and e.created_at >= s.created_at)
        )
      ) as last_activity_at
    from pilot.sessions s
    where s.organization_id = $1
      and s.completed_flag = false
  )
  select organization_id, session_id, athlete_id, created_at, last_activity_at
    from open_session
   where last_activity_at <= $2::timestamptz - make_interval(mins => $3::integer)
`;

const CLOSE_INACTIVE_SESSIONS_SQL = `
  with candidate as (${INACTIVE_SESSIONS_SQL})
  update pilot.sessions t
     set completed_flag = true,
         close_method = 'auto_inactivity',
         last_activity_at = c.last_activity_at,
         inactivity_minutes = $3::integer,
         checked_out_at = c.last_activity_at + make_interval(mins => $3::integer),
         updated_at = $2::timestamptz
    from candidate c
   where t.organization_id = c.organization_id
     and t.session_id = c.session_id
     -- Re-checked under the row lock: a manual check-out (or another sweep)
     -- that committed between the CTE's read and this write wins, and this
     -- statement touches nothing.
     and t.completed_flag = false
  returning t.session_id, t.athlete_id, t.created_at, t.last_activity_at, t.checked_out_at
`;

/**
 * Read-only: the open sessions the rule WOULD close right now for this
 * organization. The nightly script's dry run; also what a test compares the
 * write against.
 */
export async function findInactiveSessions(
  organizationId: string,
  options: AutoCloseOptions = {},
): Promise<InactiveSessionCandidate[]> {
  const windowMinutes = resolveWindow(options);
  const now = resolveNow(options);
  return query<InactiveSessionCandidate>(INACTIVE_SESSIONS_SQL, [organizationId, now, windowMinutes]);
}

/**
 * Closes every inactive open session for this organization and audits each
 * close, in one transaction. Idempotent: a second call finds nothing. Returns
 * the sessions it closed (empty when there were none).
 */
export async function closeInactiveSessions(
  organizationId: string,
  options: AutoCloseOptions & { readonly trigger: AutoCloseTrigger },
): Promise<AutoClosedSession[]> {
  const windowMinutes = resolveWindow(options);
  const now = resolveNow(options);
  return withTransaction(async (client: PoolClient) => {
    const result = await client.query<AutoClosedSession>(CLOSE_INACTIVE_SESSIONS_SQL, [organizationId, now, windowMinutes]);
    for (const closed of result.rows) {
      // No actor: nobody pressed anything. The row is the app's own record of
      // having closed the session, and it names what it relied on.
      await writePilotAuditEvent(
        {
          event_type: 'update',
          actor_account_id: null,
          actor_role: null,
          organization_id: organizationId,
          entity_type: 'session',
          entity_id: closed.session_id,
          details: {
            athlete_id: closed.athlete_id,
            close_method: 'auto_inactivity',
            trigger: options.trigger,
            inactivity_minutes: windowMinutes,
            last_activity_at: closed.last_activity_at.toISOString(),
            checked_out_at: closed.checked_out_at.toISOString(),
          },
        },
        client,
      );
    }
    return result.rows;
  });
}

/**
 * The lazy trigger for a read path. Sweeps and swallows: a failed sweep is
 * logged as one structured line and the read it sits in front of still
 * answers, because a coach who cannot see the session list is a worse outcome
 * than a stale open row that the nightly run will close. Never throws.
 */
export async function sweepInactiveSessionsOnRead(organizationId: string): Promise<void> {
  try {
    await closeInactiveSessions(organizationId, { trigger: 'sessions_list' });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'session.autoclose.sweep_failed',
        trigger: 'sessions_list',
        message: error instanceof Error ? error.message : 'unknown',
      }),
    );
  }
}

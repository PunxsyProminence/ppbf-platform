import type { CoachRosterAthlete, PilotAthlete, PilotCoachReview, PilotGoal, PilotSession } from './contracts';
import { query, queryOne } from './db';
import { ConflictError } from './errors';

export async function getAthleteById(organizationId: string, athleteId: string): Promise<PilotAthlete | null> {
  return queryOne<PilotAthlete>('select * from pilot.athletes where organization_id = $1 and athlete_id = $2', [organizationId, athleteId]);
}

/**
 * CT-15: pilot.athletes.emergency_contact_note is the correctly-named twin of
 * emergency_contact, added by pilot_slice_postgres_emergency_contact_note_migration.sql.
 * There is exactly one free-text field on every athlete form for this, so
 * both columns are written the SAME value on every insert and update, right
 * here, at the one place either column is ever written from application
 * code. That is what "two sources of truth" stops meaning: neither column can
 * drift from the other, because nothing writes one without the other. The
 * old column is not read by anything new -- it stays only because a required,
 * `not null` column cannot be dropped out from under existing rows in an
 * additive migration.
 */
export async function upsertAthlete(organizationId: string, payload: PilotAthlete): Promise<void> {
  await query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, emergency_contact_note, active_flag, coach_id, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11)
     on conflict (organization_id, athlete_id) do update set
       full_name = excluded.full_name,
       dob = excluded.dob,
       weight_class = excluded.weight_class,
       gym_status = excluded.gym_status,
       emergency_contact = excluded.emergency_contact,
       emergency_contact_note = excluded.emergency_contact_note,
       active_flag = excluded.active_flag,
       coach_id = excluded.coach_id,
       updated_at = excluded.updated_at`,
    [
      organizationId,
      payload.athlete_id,
      payload.full_name,
      payload.dob,
      payload.weight_class,
      payload.gym_status,
      payload.emergency_contact,
      payload.active_flag,
      payload.coach_id,
      payload.created_at,
      payload.updated_at,
    ],
  );
}

/**
 * Create-only counterpart to upsertAthlete, for the roster-create path where
 * landing on an existing athlete_id must fail rather than overwrite it.
 *
 * The check and the write have to be the same statement: a `select` first
 * lets two concurrent creates for one athlete_id both find nothing and both
 * proceed, and the second one silently replaces the first athlete's name,
 * dob, weight class, gym status, emergency contact and coach assignment.
 * `do nothing` makes the primary key the arbiter instead. Returns false when
 * the row already existed, so the caller can report the conflict.
 */
export async function insertAthleteIfAbsent(organizationId: string, payload: PilotAthlete): Promise<boolean> {
  const inserted = await query<{ athlete_id: string }>(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, emergency_contact_note, active_flag, coach_id, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11)
     on conflict (organization_id, athlete_id) do nothing
     returning athlete_id`,
    [
      organizationId,
      payload.athlete_id,
      payload.full_name,
      payload.dob,
      payload.weight_class,
      payload.gym_status,
      payload.emergency_contact,
      payload.active_flag,
      payload.coach_id,
      payload.created_at,
      payload.updated_at,
    ],
  );

  return inserted.length > 0;
}

export async function getGoalById(organizationId: string, goalId: string): Promise<PilotGoal | null> {
  return queryOne<PilotGoal>('select * from pilot.goals where organization_id = $1 and goal_id = $2', [organizationId, goalId]);
}

// Whole-record semantics, the same as every other field here: what the payload
// says is what the row becomes. That matters more for category and
// progress_percent than for the rest, because both are nullable -- a caller
// that omits them is not leaving them alone, it is clearing them. A client
// updating one field sends the goal back entire.
/**
 * The write guard that closes the check-and-write race.
 *
 * A create route resolves the existing row, authorizes its owner (or, for a
 * new id, authorizes the caller's own athlete), and then writes -- but the
 * lookup and the write are separate statements, so between them another
 * request can insert the id or change the row's owner. The UPDATE-first upsert
 * would then rewrite the row that appeared after the authorization check
 * (the TOCTOU shape insertAthleteIfAbsent's header warns about: "the check
 * and the write have to be the same statement").
 *
 * `guard` makes the write compare against exactly what was authorized:
 *   - 'create': the caller saw no existing row. INSERT ... ON CONFLICT DO
 *     NOTHING -- if the id appeared concurrently, zero rows insert and this
 *     throws rather than falling through to an UPDATE that would overwrite it.
 *   - 'update': the caller authorized the row's current owner. The UPDATE
 *     carries that owner in its WHERE, so if ownership or existence changed
 *     concurrently, zero rows update and this throws. It never reassigns a row
 *     the caller did not authorize.
 * Either failure is a 409 the caller can retry after re-reading.
 */
export type WriteOwnerGuard =
  | { readonly mode: 'create' }
  | { readonly mode: 'update'; readonly expectedAthleteId: string };

export async function upsertGoal(
  organizationId: string,
  payload: PilotGoal,
  guard: WriteOwnerGuard,
): Promise<void> {
  if (guard.mode === 'update') {
    const updated = await query<{ goal_id: string }>(
      `update pilot.goals
       set athlete_id = $3,
           title = $4,
           target_date = $5,
           metric = $6,
           status = $7,
           category = $8,
           progress_percent = $9,
           updated_at = $10
       where organization_id = $1 and goal_id = $2 and athlete_id = $11
       returning goal_id`,
      [
        organizationId,
        payload.goal_id,
        payload.athlete_id,
        payload.title,
        payload.target_date,
        payload.metric,
        payload.status,
        payload.category,
        payload.progress_percent,
        payload.updated_at,
        guard.expectedAthleteId,
      ],
    );
    if (updated.length === 0) {
      throw new ConflictError('This goal changed before the update was applied. Reload it and try again.');
    }
    return;
  }

  const inserted = await query<{ goal_id: string }>(
    `insert into pilot.goals (organization_id, goal_id, athlete_id, title, target_date, metric, status, category, progress_percent, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (organization_id, goal_id) do nothing
     returning goal_id`,
    [
      organizationId,
      payload.goal_id,
      payload.athlete_id,
      payload.title,
      payload.target_date,
      payload.metric,
      payload.status,
      payload.category,
      payload.progress_percent,
      payload.created_at,
      payload.updated_at,
    ],
  );
  if (inserted.length === 0) {
    throw new ConflictError('A goal with that id already exists. Reload before creating it again.');
  }
}

export async function getSessionById(organizationId: string, sessionId: string): Promise<PilotSession | null> {
  return queryOne<PilotSession>('select * from pilot.sessions where organization_id = $1 and session_id = $2', [organizationId, sessionId]);
}

export async function upsertSession(
  organizationId: string,
  payload: PilotSession,
  guard: WriteOwnerGuard,
): Promise<void> {
  if (guard.mode === 'update') {
    const updated = await query<{ session_id: string }>(
      `update pilot.sessions
       set athlete_id = $3,
           date = $4,
           rpe = $5,
           rpe_method = $6,
           notes = $7,
           completed_flag = $8,
           updated_at = $9
       where organization_id = $1 and session_id = $2 and athlete_id = $10
       returning session_id`,
      [
        organizationId,
        payload.session_id,
        payload.athlete_id,
        payload.date,
        payload.rpe,
        payload.rpe_method,
        payload.notes,
        payload.completed_flag,
        payload.updated_at,
        guard.expectedAthleteId,
      ],
    );
    if (updated.length === 0) {
      throw new ConflictError('This session changed before the update was applied. Reload it and try again.');
    }
    return;
  }

  const inserted = await query<{ session_id: string }>(
    `insert into pilot.sessions (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes, completed_flag, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (organization_id, session_id) do nothing
     returning session_id`,
    [
      organizationId,
      payload.session_id,
      payload.athlete_id,
      payload.date,
      payload.rpe,
      payload.rpe_method,
      payload.notes,
      payload.completed_flag,
      payload.created_at,
      payload.updated_at,
    ],
  );
  if (inserted.length === 0) {
    throw new ConflictError('A session with that id already exists. Reload before creating it again.');
  }
}

export async function getCoachReviewById(organizationId: string, reviewId: string): Promise<PilotCoachReview | null> {
  return queryOne<PilotCoachReview>('select * from pilot.coach_reviews where organization_id = $1 and review_id = $2', [organizationId, reviewId]);
}

export async function getSessionAthleteId(organizationId: string, sessionId: string): Promise<string | null> {
  const row = await queryOne<{ athlete_id: string }>('select athlete_id from pilot.sessions where organization_id = $1 and session_id = $2', [organizationId, sessionId]);
  return row?.athlete_id ?? null;
}

export async function upsertCoachReview(organizationId: string, payload: PilotCoachReview): Promise<void> {
  const updated = await query<{ review_id: string }>(
    `update pilot.coach_reviews
     set session_id = $3,
         coach_id = $4,
         decision = $5,
         notes = $6,
         approved_flag = $7,
         updated_at = $8
     where organization_id = $1 and review_id = $2
     returning review_id`,
    [
      organizationId,
      payload.review_id,
      payload.session_id,
      payload.coach_id,
      payload.decision,
      payload.notes,
      payload.approved_flag,
      payload.updated_at,
    ],
  );

  if (updated.length > 0) {
    return;
  }

  await query(
    `insert into pilot.coach_reviews (organization_id, review_id, session_id, coach_id, decision, notes, approved_flag, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      organizationId,
      payload.review_id,
      payload.session_id,
      payload.coach_id,
      payload.decision,
      payload.notes,
      payload.approved_flag,
      payload.created_at,
      payload.updated_at,
    ],
  );
}

// List functions for frontend data fetching
//
// `page` is opt-in and defaults to undefined -- unbounded, exactly today's
// behavior -- because several callers (coach/intelligence, readiness-board,
// progression/suggestions, analytics/performance) compute across the WHOLE
// roster; a silent default cap there would not slow them down, it would
// make them wrong by quietly dropping athletes past the cut. Only the
// roster-browsing route (athletes/list's org-admin branch) passes one.
export async function getAthletesByOrganization(
  organizationId: string,
  page?: { limit: number; offset?: number },
): Promise<PilotAthlete[]> {
  if (!page) {
    return query<PilotAthlete>(
      'select * from pilot.athletes where organization_id = $1 order by created_at desc',
      [organizationId]
    );
  }
  return query<PilotAthlete>(
    'select * from pilot.athletes where organization_id = $1 order by created_at desc limit $2 offset $3',
    [organizationId, page.limit, page.offset ?? 0]
  );
}

/**
 * The relationship a coach has to one athlete, as a boolean expression over
 * `a` (an alias for pilot.athletes). The same two ways in that
 * access.ts#assertCoachAssignedToAthlete admits a coach, so the roster agrees
 * with the per-athlete gate instead of inventing a third rule: coach of
 * record, or an active coverage grant -- started, not yet expired, and in this
 * organization. A revoked grant has expires_at forced to now(), so it stops
 * revealing the fields the moment it is revoked, with no cleanup job.
 */
const COACH_RELATED_WITH_COVERAGE = `(
  a.coach_id = $2
  or exists (
    select 1
    from pilot.coach_coverage c
    where c.organization_id = a.organization_id
      and c.athlete_id = a.athlete_id
      and c.covering_coach_id = $2
      and c.starts_at <= now()
      and c.expires_at > now()
  )
)`;

/** The same question where pilot.coach_coverage does not exist yet. */
const COACH_RELATED_RECORD_ONLY = '(a.coach_id = $2)';

/**
 * Written once and interpolated, never copy-pasted per column: two hand-kept
 * copies of a redaction predicate drift, and the drift leaks exactly one
 * field. The alias is computed in an inner select because Postgres cannot
 * reference a select-list alias from a sibling item in the same list.
 *
 * CT-15: the `emergency_contact` this returns is the free-text NOTE, not the
 * authoritative record -- pilot.emergency_contacts (structured: name,
 * relationship, phone, email, is_primary), read separately through
 * /api/pilot/intake/domain-get, is. No page in apps/web/app/coach currently
 * renders this field, so nothing today shows a coach an unlabeled note as if
 * it were the verified contact -- but a future coach surface that does
 * `athlete.emergency_contact` and prints it as "the emergency contact" would
 * repeat the exact mistake CT-15 fixed on /admin/athletes and /admin/people.
 * Read this field's real shape, and reach for pilot.emergency_contacts, before
 * building one.
 */
function coachRosterQuery(relationship: string): string {
  return `select athlete_id,
                 full_name,
                 weight_class,
                 gym_status,
                 active_flag,
                 coach_id,
                 created_at,
                 updated_at,
                 case when coach_related then dob end as dob,
                 case when coach_related then emergency_contact end as emergency_contact
          from (
            select a.*, ${relationship} as coach_related
            from pilot.athletes a
            where a.organization_id = $1
          ) scoped
          order by created_at desc`;
}

/**
 * The roster a coach reads: every athlete in the organization, with dob and
 * emergency_contact present only for the ones this coach actually has a
 * relationship to. See CoachRosterAthlete for why the list stays whole and
 * the fields narrow instead.
 *
 * Redaction happens in SQL, so the two columns never leave the database for
 * an athlete this coach is unrelated to -- a filter applied in JavaScript
 * afterwards would still have loaded them into the response-building process,
 * and is one forgotten `map` away from being skipped.
 */
export async function getAthletesForCoach(organizationId: string, coachId: string): Promise<CoachRosterAthlete[]> {
  try {
    return await query<CoachRosterAthlete>(coachRosterQuery(COACH_RELATED_WITH_COVERAGE), [organizationId, coachId]);
  } catch (error) {
    // Migrations are operator-applied (guardrails section 7), so this runs
    // against databases the coach_coverage migration has not reached. A
    // missing relation (Postgres 42P01) must not 500 the whole roster --
    // access.ts makes the same allowance at the same table for the same
    // reason. Falling back to coach-of-record only fails SAFE: it redacts
    // more, never less. Any other database error still propagates.
    const code = (error as { code?: unknown }).code;
    if (code !== '42P01') {
      throw error;
    }

    return query<CoachRosterAthlete>(coachRosterQuery(COACH_RELATED_RECORD_ONLY), [organizationId, coachId]);
  }
}

// page is opt-in, same reasoning as getAthletesByOrganization above:
// undefined preserves today's unbounded behavior exactly.
export async function getGoalsByAthlete(
  organizationId: string,
  athleteId: string,
  page?: { limit: number; offset?: number },
): Promise<PilotGoal[]> {
  if (!page) {
    return query<PilotGoal>(
      'select * from pilot.goals where organization_id = $1 and athlete_id = $2 order by created_at desc',
      [organizationId, athleteId]
    );
  }
  return query<PilotGoal>(
    'select * from pilot.goals where organization_id = $1 and athlete_id = $2 order by created_at desc limit $3 offset $4',
    [organizationId, athleteId, page.limit, page.offset ?? 0]
  );
}

export async function getSessionsByAthlete(
  organizationId: string,
  athleteId: string,
  page?: { limit: number; offset?: number },
): Promise<PilotSession[]> {
  if (!page) {
    return query<PilotSession>(
      'select * from pilot.sessions where organization_id = $1 and athlete_id = $2 order by date desc',
      [organizationId, athleteId]
    );
  }
  return query<PilotSession>(
    'select * from pilot.sessions where organization_id = $1 and athlete_id = $2 order by date desc limit $3 offset $4',
    [organizationId, athleteId, page.limit, page.offset ?? 0]
  );
}

export async function getCoachReviewsBySession(
  organizationId: string,
  sessionId: string
): Promise<PilotCoachReview[]> {
  return query<PilotCoachReview>(
    'select * from pilot.coach_reviews where organization_id = $1 and session_id = $2 order by created_at desc',
    [organizationId, sessionId]
  );
}

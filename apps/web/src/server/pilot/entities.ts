import type { PilotAthlete, PilotCoachReview, PilotGoal, PilotSession } from './contracts';
import { query, queryOne } from './db';

export async function getAthleteById(organizationId: string, athleteId: string): Promise<PilotAthlete | null> {
  return queryOne<PilotAthlete>('select * from pilot.athletes where organization_id = $1 and athlete_id = $2', [organizationId, athleteId]);
}

export async function getCoachById(organizationId: string, accountId: string): Promise<boolean> {
  const coach = await queryOne<{ account_id: string }>(
    'select account_id from pilot.accounts where account_id = $1 and organization_id = $2 and role = $3 and active_flag = $4',
    [accountId, organizationId, 'coach', true],
  );
  return coach !== null;
}

export async function upsertAthlete(organizationId: string, payload: PilotAthlete): Promise<void> {
  await query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (organization_id, athlete_id) do update set
       full_name = excluded.full_name,
       dob = excluded.dob,
       weight_class = excluded.weight_class,
       gym_status = excluded.gym_status,
       emergency_contact = excluded.emergency_contact,
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
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
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

export async function upsertGoal(organizationId: string, payload: PilotGoal): Promise<void> {
  const updated = await query<{ goal_id: string }>(
    `update pilot.goals
     set athlete_id = $3,
         title = $4,
         target_date = $5,
         metric = $6,
         status = $7,
         updated_at = $8
     where organization_id = $1 and goal_id = $2
     returning goal_id`,
    [
      organizationId,
      payload.goal_id,
      payload.athlete_id,
      payload.title,
      payload.target_date,
      payload.metric,
      payload.status,
      payload.updated_at,
    ],
  );

  if (updated.length > 0) {
    return;
  }

  await query(
    `insert into pilot.goals (organization_id, goal_id, athlete_id, title, target_date, metric, status, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      organizationId,
      payload.goal_id,
      payload.athlete_id,
      payload.title,
      payload.target_date,
      payload.metric,
      payload.status,
      payload.created_at,
      payload.updated_at,
    ],
  );
}

export async function getSessionById(organizationId: string, sessionId: string): Promise<PilotSession | null> {
  return queryOne<PilotSession>('select * from pilot.sessions where organization_id = $1 and session_id = $2', [organizationId, sessionId]);
}

export async function upsertSession(organizationId: string, payload: PilotSession): Promise<void> {
  const updated = await query<{ session_id: string }>(
    `update pilot.sessions
     set athlete_id = $3,
         date = $4,
         rpe = $5,
         notes = $6,
         completed_flag = $7,
         updated_at = $8
     where organization_id = $1 and session_id = $2
     returning session_id`,
    [
      organizationId,
      payload.session_id,
      payload.athlete_id,
      payload.date,
      payload.rpe,
      payload.notes,
      payload.completed_flag,
      payload.updated_at,
    ],
  );

  if (updated.length > 0) {
    return;
  }

  await query(
    `insert into pilot.sessions (organization_id, session_id, athlete_id, date, rpe, notes, completed_flag, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      organizationId,
      payload.session_id,
      payload.athlete_id,
      payload.date,
      payload.rpe,
      payload.notes,
      payload.completed_flag,
      payload.created_at,
      payload.updated_at,
    ],
  );
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
export async function getAthletesByOrganization(organizationId: string): Promise<PilotAthlete[]> {
  return query<PilotAthlete>(
    'select * from pilot.athletes where organization_id = $1 order by created_at desc',
    [organizationId]
  );
}

export async function getGoalsByAthlete(
  organizationId: string,
  athleteId: string
): Promise<PilotGoal[]> {
  return query<PilotGoal>(
    'select * from pilot.goals where organization_id = $1 and athlete_id = $2 order by created_at desc',
    [organizationId, athleteId]
  );
}

export async function getSessionsByAthlete(
  organizationId: string,
  athleteId: string
): Promise<PilotSession[]> {
  return query<PilotSession>(
    'select * from pilot.sessions where organization_id = $1 and athlete_id = $2 order by date desc',
    [organizationId, athleteId]
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

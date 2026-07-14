import type { PilotAthlete, PilotCoachReview, PilotGoal, PilotSession } from './contracts';
import { query, queryOne } from './db';

export async function getAthleteById(athleteId: string): Promise<PilotAthlete | null> {
  return queryOne<PilotAthlete>('select * from pilot.athletes where athlete_id = $1', [athleteId]);
}

export async function upsertAthlete(payload: PilotAthlete): Promise<void> {
  await query(
    `insert into pilot.athletes (athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (athlete_id) do update set
       full_name = excluded.full_name,
       dob = excluded.dob,
       weight_class = excluded.weight_class,
       gym_status = excluded.gym_status,
       emergency_contact = excluded.emergency_contact,
       active_flag = excluded.active_flag,
       coach_id = excluded.coach_id,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    [
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

export async function getGoalById(goalId: string): Promise<PilotGoal | null> {
  return queryOne<PilotGoal>('select * from pilot.goals where goal_id = $1', [goalId]);
}

export async function upsertGoal(payload: PilotGoal): Promise<void> {
  await query(
    `insert into pilot.goals (goal_id, athlete_id, title, target_date, metric, status, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (goal_id) do update set
       athlete_id = excluded.athlete_id,
       title = excluded.title,
       target_date = excluded.target_date,
       metric = excluded.metric,
       status = excluded.status,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    [payload.goal_id, payload.athlete_id, payload.title, payload.target_date, payload.metric, payload.status, payload.created_at, payload.updated_at],
  );
}

export async function getSessionById(sessionId: string): Promise<PilotSession | null> {
  return queryOne<PilotSession>('select * from pilot.sessions where session_id = $1', [sessionId]);
}

export async function upsertSession(payload: PilotSession): Promise<void> {
  await query(
    `insert into pilot.sessions (session_id, athlete_id, date, rpe, notes, completed_flag, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (session_id) do update set
       athlete_id = excluded.athlete_id,
       date = excluded.date,
       rpe = excluded.rpe,
       notes = excluded.notes,
       completed_flag = excluded.completed_flag,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    [
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

export async function getCoachReviewById(reviewId: string): Promise<PilotCoachReview | null> {
  return queryOne<PilotCoachReview>('select * from pilot.coach_reviews where review_id = $1', [reviewId]);
}

export async function getSessionAthleteId(sessionId: string): Promise<string | null> {
  const row = await queryOne<{ athlete_id: string }>('select athlete_id from pilot.sessions where session_id = $1', [sessionId]);
  return row?.athlete_id ?? null;
}

export async function upsertCoachReview(payload: PilotCoachReview): Promise<void> {
  await query(
    `insert into pilot.coach_reviews (review_id, session_id, coach_id, decision, notes, approved_flag, created_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (review_id) do update set
       session_id = excluded.session_id,
       coach_id = excluded.coach_id,
       decision = excluded.decision,
       notes = excluded.notes,
       approved_flag = excluded.approved_flag,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    [
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

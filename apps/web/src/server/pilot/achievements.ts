import { randomUUID } from 'node:crypto';

import {
  DEFAULT_PROGRAM,
  RECOGNITION_NOTE_MAX,
  isMilestoneKey,
  isProgram,
  isRecognitionKind,
  type Program,
  type RecognitionKind,
} from '@/src/shared/achievementPaths';
import { query, queryOne } from './db';

/**
 * ACHIEVEMENT PERSISTENCE — goals somebody set for themselves, a coach catching
 * somebody being good, non-fight milestones, and who mentors whom.
 *
 * The tables are owned by
 * infra/azure/pilot_slice_postgres_achievements_migration.sql and applied
 * through the apply-migrations workflow. Nothing here issues DDL: a missing
 * table means the migration has not run, and the query should say so loudly
 * rather than create schema from inside a request.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DELIBERATELY CANNOT DO
 * ---------------------------------------------------------------------------
 *
 * IT CANNOT RANK ATHLETES. Every read below takes exactly one athlete_id and
 * returns that athlete's own rows. There is no function here that groups by
 * athlete, counts per athlete, orders athletes, or returns more than one
 * athlete's achievements in a single call — not because a caller is trusted not
 * to ask, but because there is nothing to call. A leaderboard between kids
 * needs a comparable number per athlete and this module refuses to compute one.
 * recognitionNoRanking.test.ts reads this file and fails on the SQL shapes that
 * would produce one.
 *
 * IT CANNOT RECORD A NEGATIVE. Recognition takes a `kind` from a closed
 * positive vocabulary, checked here and checked again by the database. There is
 * no severity, no rating, no numeric column, no "concern" value, and no
 * coach-private visibility flag — the athlete sees every row written about
 * them, which is what stops a record of good things becoming a file kept on
 * somebody.
 *
 * IT CANNOT PUNISH AN ABSENCE. Nothing here reads a last-seen date, computes a
 * gap, expires an award, or writes a decay. Every write is append-only and
 * every award, once written, stays written. See TrainingCard.tsx lines 19-24
 * for why that is load-bearing rather than merely kind.
 *
 * IT CANNOT UN-SAY SOMETHING. There is no update and no delete for a
 * recognition or a milestone award. A rescindable compliment is a lever, and
 * the platform should not hand anybody one.
 */

/* ------------------------------------------------------------------------- */
/* A. PERSONAL GOALS — the athlete's own words                                */
/* ------------------------------------------------------------------------- */

export interface PersonalGoal {
  goal_id: string;
  athlete_id: string;
  /** What they wrote. The goal, in their words, unedited. */
  title: string;
  /** Why it matters to them. Optional — a goal does not owe anyone a reason. */
  why_it_matters: string;
  /**
   * Optional. "Show up on the days I don't want to" has no date, and requiring
   * one would turn a goal into something that can be failed on a calendar.
   */
  target_date: string | null;
  set_by_role: string;
  /** null means still working. There is no failed state and no column for one. */
  reached_at: string | null;
  created_at: string;
  updated_at: string;
}

const PERSONAL_GOAL_FIELDS = `goal_id, athlete_id, title, why_it_matters, target_date,
  set_by_role, reached_at, created_at, updated_at`;

/** Long enough for a real sentence, short enough that it stays a goal and not an essay. */
export const GOAL_TITLE_MAX = 160;
export const GOAL_WHY_MAX = 240;

export class InvalidAchievementInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAchievementInput';
  }
}

function requireOwnWords(raw: string, max: number, field: string): string {
  const value = raw.trim();
  if (!value) {
    throw new InvalidAchievementInput(`Missing ${field}`);
  }
  if (value.length > max) {
    throw new InvalidAchievementInput(`Unsupported ${field}: at most ${max} characters`);
  }
  return value;
}

/**
 * A goal the athlete wrote themselves.
 *
 * Written into pilot.goals rather than a second table: one athlete's goals
 * belong in one place, and the SMART-goal path already there keeps working
 * untouched. `goal_kind = 'own_words'` is what tells the two apart on the way
 * back out.
 *
 * `metric` is written as the empty string on purpose. The existing column is
 * NOT NULL and the whole point of this path is that nobody has to invent a
 * measurable proxy for "be a better training partner" before they are allowed
 * to want it.
 */
export async function createPersonalGoal(params: {
  organizationId: string;
  athleteId: string;
  ownWords: string;
  whyItMatters?: string;
  targetDate?: string | null;
  setByRole: string;
}): Promise<PersonalGoal> {
  const title = requireOwnWords(params.ownWords, GOAL_TITLE_MAX, 'goal');
  const why = (params.whyItMatters ?? '').trim().slice(0, GOAL_WHY_MAX);
  const goalId = `goal_${Date.now()}_${randomUUID().substring(0, 8)}`;
  const now = new Date().toISOString();

  const rows = await query<PersonalGoal>(
    `insert into pilot.goals (
       organization_id, goal_id, athlete_id, title, target_date, metric, status,
       goal_kind, own_words, why_it_matters, set_by_role, created_at, updated_at
     ) values ($1,$2,$3,$4,$5,'','active','own_words',$4,$6,$7,$8,$8)
     returning ${PERSONAL_GOAL_FIELDS}`,
    [
      params.organizationId,
      goalId,
      params.athleteId,
      title,
      params.targetDate || null,
      why,
      params.setByRole,
      now,
    ],
  );

  return rows[0];
}

/** One athlete's own-words goals, newest first. Athlete-scoped, like everything here. */
export async function listPersonalGoals(
  organizationId: string,
  athleteId: string,
): Promise<PersonalGoal[]> {
  return query<PersonalGoal>(
    `select ${PERSONAL_GOAL_FIELDS}
     from pilot.goals
     where organization_id = $1 and athlete_id = $2 and goal_kind = 'own_words'
     order by reached_at is null desc, created_at desc`,
    [organizationId, athleteId],
  );
}

/**
 * Reached. Idempotent: `reached_at is null` in the predicate means a second
 * call returns the row unchanged rather than moving the date, so a double-tap
 * on a gym tablet cannot rewrite the day somebody got there.
 *
 * There is no un-reach. A goal somebody set for themselves and got to is not
 * something the platform takes back.
 *
 * `athleteId` IS THE AUTHORIZATION, NOT A FILTER. The caller has already
 * decided this athlete is one the actor may act for; naming it in the WHERE
 * clause is what makes the check and the write a single statement. Keyed on
 * goal_id alone -- as this was -- the row was mutated first and its owner
 * compared afterwards, which can only ever report a write that has already
 * committed: an actor authorized for their own athlete could name any other
 * athlete's goal_id and permanently stamp that child's goal reached. Because
 * there is no un-reach and no route that writes reached_at back to null, the
 * falsified record is not recoverable through the API, and the guardian-facing
 * read shows a linked guardian their child reaching something they did not.
 *
 * The read-back carries the same predicate for the same reason -- it returns
 * own_words and why_it_matters, a child's goal in their own language, and an
 * unscoped read hands it to whoever guessed the id.
 *
 * Same shape the SMART-goal create path on this table already uses (see
 * app/api/pilot/goals/route.ts, which resolves and authorizes the STORED
 * owner before its upsert): authorize the row you are about to write, not the
 * one the payload names.
 */
export async function markPersonalGoalReached(
  organizationId: string,
  goalId: string,
  athleteId: string,
): Promise<PersonalGoal | null> {
  const now = new Date().toISOString();
  const updated = await query<PersonalGoal>(
    `update pilot.goals
     set reached_at = $3, status = 'completed', updated_at = $3
     where organization_id = $1 and goal_id = $2 and athlete_id = $4
       and goal_kind = 'own_words' and reached_at is null
     returning ${PERSONAL_GOAL_FIELDS}`,
    [organizationId, goalId, now, athleteId],
  );

  if (updated.length > 0) {
    return updated[0];
  }

  return queryOne<PersonalGoal>(
    `select ${PERSONAL_GOAL_FIELDS}
     from pilot.goals
     where organization_id = $1 and goal_id = $2 and athlete_id = $3
       and goal_kind = 'own_words'`,
    [organizationId, goalId, athleteId],
  );
}

/* ------------------------------------------------------------------------- */
/* B. RECOGNITION — a coach catching somebody being good                      */
/* ------------------------------------------------------------------------- */

export interface Recognition {
  recognition_id: string;
  athlete_id: string;
  coach_display_name: string;
  kind: RecognitionKind;
  note: string;
  created_at: string;
}

/**
 * coach_account_id is written but NOT returned.
 *
 * The athlete is told who said it, by name, because an unsigned compliment is
 * a system notification and this is supposed to be a person. The account
 * identifier behind that name is an internal fact with no reason to reach a
 * client, and it is the one field that would make a recognition feed joinable
 * against anything else.
 */
const RECOGNITION_FIELDS = 'recognition_id, athlete_id, coach_display_name, kind, note, created_at';

/** Nothing calls for more than this at once; the cap keeps one athlete's wall bounded. */
export const RECOGNITION_PAGE_MAX = 100;

/**
 * The name a recognition is signed with.
 *
 * Derived server-side from the coach's own login, never taken from the request
 * body: a signature the sender supplies is a signature anybody in the coach
 * role can forge, and the whole value of this feature is that an athlete can
 * believe a named person said it.
 *
 * pilot.accounts has no display-name column today (logged as a gap — identity
 * work is in flight elsewhere), so the local part of the login address is the
 * best true thing available. When accounts grow a real name, this is the one
 * function to change.
 */
export function deriveCoachDisplayName(loginEmail: string | null | undefined): string {
  const local = (loginEmail ?? '').split('@')[0]?.trim() ?? '';
  if (!local) {
    return 'Your coach';
  }

  const spoken = local
    .replace(/[._-]+/g, ' ')
    .replace(/\d+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

  return spoken ? `Coach ${spoken}` : 'Your coach';
}

export async function getCoachDisplayName(
  organizationId: string,
  accountId: string,
): Promise<string> {
  const row = await queryOne<{ login_email: string | null }>(
    `select login_email from pilot.accounts
     where organization_id = $1 and account_id = $2`,
    [organizationId, accountId],
  );

  return deriveCoachDisplayName(row?.login_email);
}

export async function createRecognition(params: {
  organizationId: string;
  athleteId: string;
  coachAccountId: string;
  coachDisplayName: string;
  kind: string;
  note?: string;
}): Promise<Recognition> {
  // Checked here and by pilot_recognitions_kind_check. Both, deliberately: the
  // constraint is the thing that cannot be bypassed, and this is the thing that
  // gives the coach a sentence instead of SQLSTATE 23514.
  if (!isRecognitionKind(params.kind)) {
    throw new InvalidAchievementInput('Unsupported recognition');
  }

  // Truncated rather than rejected. A coach with taped hands who runs long
  // should not lose what they typed to a validation error — and the cap is what
  // keeps this a sentence rather than a report.
  const note = (params.note ?? '').trim().slice(0, RECOGNITION_NOTE_MAX);
  const recognitionId = `recog_${Date.now()}_${randomUUID().substring(0, 8)}`;

  const rows = await query<Recognition>(
    `insert into pilot.recognitions (
       organization_id, recognition_id, athlete_id, coach_account_id,
       coach_display_name, kind, note
     ) values ($1,$2,$3,$4,$5,$6,$7)
     returning ${RECOGNITION_FIELDS}`,
    [
      params.organizationId,
      recognitionId,
      params.athleteId,
      params.coachAccountId,
      params.coachDisplayName.trim() || 'Your coach',
      params.kind,
      note,
    ],
  );

  return rows[0];
}

/**
 * One athlete's recognitions, newest first.
 *
 * Takes exactly one athlete_id and has no variant that takes a list. That is
 * the point: this is the only read of pilot.recognitions in the codebase, so
 * there is no query anywhere that can put two athletes' recognitions side by
 * side, and therefore none that can order them.
 */
export async function listRecognitionsForAthlete(
  organizationId: string,
  athleteId: string,
  limit = 50,
): Promise<Recognition[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit) || 0, 1), RECOGNITION_PAGE_MAX);
  return query<Recognition>(
    `select ${RECOGNITION_FIELDS}
     from pilot.recognitions
     where organization_id = $1 and athlete_id = $2
     order by created_at desc
     limit $3`,
    [organizationId, athleteId, bounded],
  );
}

/* ------------------------------------------------------------------------- */
/* C. NON-FIGHT MILESTONES                                                    */
/* ------------------------------------------------------------------------- */

export interface MilestoneAward {
  athlete_id: string;
  milestone_key: string;
  awarded_by_role: string;
  note: string;
  awarded_at: string;
}

const MILESTONE_FIELDS = 'athlete_id, milestone_key, awarded_by_role, note, awarded_at';

const AWARDER_ROLES = ['coach', 'self', 'parent'] as const;
type AwarderRole = (typeof AWARDER_ROLES)[number];

function isAwarderRole(value: unknown): value is AwarderRole {
  return AWARDER_ROLES.includes(value as AwarderRole);
}

/**
 * Marks a milestone. Idempotent by the primary key: awarding the same milestone
 * twice keeps the FIRST date, because the day it happened is the fact and a
 * second tap is not a second achievement.
 *
 * That idempotence is also what keeps the table from ever holding a per-athlete
 * count worth ranking — one row per milestone per athlete, maximum.
 */
export async function awardMilestone(params: {
  organizationId: string;
  athleteId: string;
  milestoneKey: string;
  awardedByRole: string;
  awardedByAccountId?: string | null;
  note?: string;
}): Promise<MilestoneAward | null> {
  if (!isMilestoneKey(params.milestoneKey)) {
    throw new InvalidAchievementInput('Unsupported milestone');
  }
  if (!isAwarderRole(params.awardedByRole)) {
    throw new InvalidAchievementInput('Unsupported awarded_by_role');
  }

  await query(
    `insert into pilot.athlete_milestones (
       organization_id, athlete_id, milestone_key, awarded_by_role,
       awarded_by_account_id, note
     ) values ($1,$2,$3,$4,$5,$6)
     on conflict (organization_id, athlete_id, milestone_key) do nothing`,
    [
      params.organizationId,
      params.athleteId,
      params.milestoneKey,
      params.awardedByRole,
      params.awardedByAccountId ?? null,
      (params.note ?? '').trim().slice(0, RECOGNITION_NOTE_MAX),
    ],
  );

  // Read back rather than returning the insert: on a conflict the insert
  // returns nothing, and the caller still needs the award that already exists.
  return queryOne<MilestoneAward>(
    `select ${MILESTONE_FIELDS}
     from pilot.athlete_milestones
     where organization_id = $1 and athlete_id = $2 and milestone_key = $3`,
    [params.organizationId, params.athleteId, params.milestoneKey],
  );
}

/**
 * The cumulative number of completed sessions, which is what the consistency
 * track is computed from.
 *
 * A COUNT, and only a count. It cannot see a date, a gap, or an ordering, so
 * nothing derived from it can punish an absence — the same property the
 * training card's own count has, and the reason both are safe.
 *
 * It lives here rather than being read from the sessions list because the
 * family-facing surface needs it and a parent is not admitted to
 * /api/pilot/sessions/list, which returns every session's date, RPE and notes.
 * A number is the whole of what a progression needs; the session log is not.
 */
export async function countCompletedSessions(
  organizationId: string,
  athleteId: string,
): Promise<number> {
  const row = await queryOne<{ completed: string }>(
    `select count(*)::text as completed
     from pilot.sessions
     where organization_id = $1 and athlete_id = $2 and completed_flag = true`,
    [organizationId, athleteId],
  );

  const parsed = Number(row?.completed ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function listMilestoneAwards(
  organizationId: string,
  athleteId: string,
): Promise<MilestoneAward[]> {
  return query<MilestoneAward>(
    `select ${MILESTONE_FIELDS}
     from pilot.athlete_milestones
     where organization_id = $1 and athlete_id = $2
     order by awarded_at desc`,
    [organizationId, athleteId],
  );
}

/* ------------------------------------------------------------------------- */
/* D. MENTORSHIP                                                              */
/* ------------------------------------------------------------------------- */

export interface Mentorship {
  mentorship_id: string;
  mentor_athlete_id: string;
  mentor_name: string;
  mentee_athlete_id: string;
  mentee_name: string;
  started_on: string;
  ended_on: string | null;
  note: string;
}

// Names are joined in because a mentorship is only useful as two people, and a
// client that had to resolve two athlete_ids to names would need a roster read
// it is not entitled to.
const MENTORSHIP_SELECT = `select m.mentorship_id, m.mentor_athlete_id,
    coalesce(mentor.full_name, '') as mentor_name,
    m.mentee_athlete_id, coalesce(mentee.full_name, '') as mentee_name,
    m.started_on, m.ended_on, m.note
  from pilot.mentorships m
  left join pilot.athletes mentor
    on mentor.organization_id = m.organization_id and mentor.athlete_id = m.mentor_athlete_id
  left join pilot.athletes mentee
    on mentee.organization_id = m.organization_id and mentee.athlete_id = m.mentee_athlete_id`;

/**
 * Both directions for one athlete: who they mentor, and who mentors them.
 *
 * One call rather than two, because the point of the feature is that the
 * relationship is visible on BOTH sides — a mentee who could only see up, or a
 * mentor who could only see down, would be half a community structure.
 *
 * Open pairings first; a closed one is history, never a failure.
 */
export async function listMentorshipsForAthlete(
  organizationId: string,
  athleteId: string,
): Promise<Mentorship[]> {
  return query<Mentorship>(
    `${MENTORSHIP_SELECT}
     where m.organization_id = $1
       and (m.mentor_athlete_id = $2 or m.mentee_athlete_id = $2)
     order by m.ended_on is null desc, m.started_on desc`,
    [organizationId, athleteId],
  );
}

const UNIQUE_VIOLATION = '23505';

export class MentorshipAlreadyOpenError extends Error {
  constructor() {
    super('These two are already paired up.');
    this.name = 'MentorshipAlreadyOpenError';
  }
}

export async function createMentorship(params: {
  organizationId: string;
  mentorAthleteId: string;
  menteeAthleteId: string;
  createdByAccountId: string;
  note?: string;
}): Promise<Mentorship> {
  if (params.mentorAthleteId === params.menteeAthleteId) {
    throw new InvalidAchievementInput('An athlete cannot mentor themselves');
  }

  const mentorshipId = `mentor_${Date.now()}_${randomUUID().substring(0, 8)}`;

  try {
    await query(
      `insert into pilot.mentorships (
         organization_id, mentorship_id, mentor_athlete_id, mentee_athlete_id,
         created_by_account_id, note
       ) values ($1,$2,$3,$4,$5,$6)`,
      [
        params.organizationId,
        mentorshipId,
        params.mentorAthleteId,
        params.menteeAthleteId,
        params.createdByAccountId,
        (params.note ?? '').trim().slice(0, RECOGNITION_NOTE_MAX),
      ],
    );
  } catch (error) {
    // Only the partial unique index can hold "one open pairing per couple" --
    // two concurrent creates each read no existing row and both write.
    const { code } = (error ?? {}) as { code?: unknown };
    if (code === UNIQUE_VIOLATION) {
      throw new MentorshipAlreadyOpenError();
    }
    throw error;
  }

  const created = await queryOne<Mentorship>(
    `${MENTORSHIP_SELECT} where m.organization_id = $1 and m.mentorship_id = $2`,
    [params.organizationId, mentorshipId],
  );

  if (!created) {
    throw new Error('Mentorship was not written');
  }

  return created;
}

/**
 * The mentor athlete a mentorship is bound to, for authorizing an action on it
 * BEFORE mutating the row. Deliberately minimal: it reads only the id the
 * access check needs, straight from pilot.mentorships with no join, so no
 * mentor/mentee name or other PII is loaded before the caller is authorized.
 * mentor_athlete_id is set at creation and never reassigned.
 */
export async function getMentorshipMentorAthleteId(
  organizationId: string,
  mentorshipId: string,
): Promise<string | null> {
  const row = await queryOne<{ mentor_athlete_id: string }>(
    'select mentor_athlete_id from pilot.mentorships where organization_id = $1 and mentorship_id = $2',
    [organizationId, mentorshipId],
  );
  return row?.mentor_athlete_id ?? null;
}

/**
 * Closes a pairing. There is no outcome and no reason: people move on, and the
 * schema has nowhere to record that a mentorship "did not work out".
 */
export async function endMentorship(
  organizationId: string,
  mentorshipId: string,
): Promise<Mentorship | null> {
  await query(
    `update pilot.mentorships
     set ended_on = current_date
     where organization_id = $1 and mentorship_id = $2 and ended_on is null`,
    [organizationId, mentorshipId],
  );

  return queryOne<Mentorship>(
    `${MENTORSHIP_SELECT} where m.organization_id = $1 and m.mentorship_id = $2`,
    [organizationId, mentorshipId],
  );
}

/* ------------------------------------------------------------------------- */
/* E. THE PROGRAM SOMEBODY CAME FOR                                           */
/* ------------------------------------------------------------------------- */

/**
 * Which progression this athlete sees. A missing row is not an error and not a
 * gap in the data — it is somebody who has not been asked yet, and they get the
 * general path, which is complete on its own.
 */
export async function getAthleteProgram(
  organizationId: string,
  athleteId: string,
): Promise<Program> {
  const row = await queryOne<{ program: string }>(
    `select program from pilot.athlete_programs
     where organization_id = $1 and athlete_id = $2`,
    [organizationId, athleteId],
  );

  return isProgram(row?.program) ? row.program : DEFAULT_PROGRAM;
}

export async function setAthleteProgram(params: {
  organizationId: string;
  athleteId: string;
  program: string;
}): Promise<Program> {
  if (!isProgram(params.program)) {
    throw new InvalidAchievementInput('Unsupported program');
  }

  await query(
    `insert into pilot.athlete_programs (organization_id, athlete_id, program, updated_at)
     values ($1,$2,$3, now())
     on conflict (organization_id, athlete_id) do update set
       program = excluded.program,
       updated_at = excluded.updated_at`,
    [params.organizationId, params.athleteId, params.program],
  );

  return params.program;
}

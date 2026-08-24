export type PilotRole =
  | 'platform_owner'
  | 'organization_admin'
  | 'admin'
  | 'coach'
  | 'athlete'
  | 'parent'
  | 'board'
  | 'volunteer'
  | 'staff';

export interface PilotAthlete {
  athlete_id: string;
  full_name: string;
  dob: string;
  weight_class: string;
  gym_status: string;
  emergency_contact: string;
  active_flag: boolean;
  coach_id: string;
  created_at: string;
  updated_at: string;
}

/**
 * One athlete as a COACH reads them off the roster list, which is not the same
 * row an organization admin reads.
 *
 * A coach needs every athlete's name and gym status to plan a floor and to
 * pick up cover, so the roster stays org-wide. A coach does not need the date
 * of birth and the emergency contact of a child they have no relationship to
 * -- that pair is a minor's identity and a phone number belonging to an adult
 * who never agreed to appear on a staff screen. So the LIST stays whole and
 * the FIELDS narrow: both are null unless the reader is the coach of record or
 * holds an active pilot.coach_coverage grant.
 *
 * `null` rather than an absent key, deliberately. The key stays present so a
 * client cannot tell "redacted" apart from "this build predates the field" by
 * shape, and null is already the value this codebase treats as fail-safe --
 * wallDisplay.ts#isMinor reads a null dob as a minor, never as an adult.
 */
export type CoachRosterAthlete = Omit<PilotAthlete, 'dob' | 'emergency_contact'> & {
  dob: string | null;
  emergency_contact: string | null;
};

export interface PilotGoal {
  goal_id: string;
  athlete_id: string;
  title: string;
  target_date: string;
  metric: string;
  status: string;
  // Both nullable, and both mean "nobody has said" rather than a value.
  // pilot.goals admits NULL for each because every goal written before
  // pilot_slice_postgres_goal_category_progress_migration.sql carries neither,
  // and defaulting them would attribute a category the athlete never chose and
  // a progress reading nobody reported. The read path must render null as
  // untracked, never as 'Boxing' and never as a 0% bar -- that substitution in
  // the athlete workspace is the defect this pair of columns exists to end.
  category: string | null;
  progress_percent: number | null;
  created_at: string;
  updated_at: string;
}

export interface PilotSession {
  session_id: string;
  athlete_id: string;
  date: string;
  // Session RPE: perceived exertion across the COMPLETED session, collected
  // after it ends. NULL between check-in and check-out, which is the honest
  // state -- the session has not happened yet, so there is nothing to rate.
  //
  // This was `number` and NOT NULL, and that is precisely what produced the
  // defect it now records: check-in had to supply some number, so it supplied
  // the pre-session "Readiness to Train" slider, and a readiness self-report
  // has been stored as session RPE for every row the application has written.
  // Read this field only alongside rpe_method.
  rpe: number | null;
  rpe_method: SessionRpeMethod;
  notes: string;
  completed_flag: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * What produced a session's rpe reading.
 *
 * Deliberately narrow, and matched to the CHECK constraint in
 * pilot_slice_postgres_session_rpe_semantics_migration.sql. 'UNKNOWN' is the
 * true answer for every row written before that migration -- those hold a
 * pre-session readiness value -- and for anything the CSV seeder writes.
 * 'athlete_post_session_self_report' is the only honest method the application
 * has: the athlete rating the session they just finished, at check-out.
 *
 * A coach-entered RPE has no value here because no such write path exists;
 * CoachWorkspace only reads the column. Adding one is a migration, which is
 * the point -- it forces the decision to be recorded rather than absorbed.
 */
export type SessionRpeMethod = 'UNKNOWN' | 'athlete_post_session_self_report';

export const SESSION_RPE_METHODS = ['UNKNOWN', 'athlete_post_session_self_report'] as const;

export interface PilotCoachReview {
  review_id: string;
  session_id: string;
  coach_id: string;
  decision: string;
  notes: string;
  approved_flag: boolean;
  created_at: string;
  updated_at: string;
}

export const ATHLETE_FIELDS = [
  'athlete_id',
  'full_name',
  'dob',
  'weight_class',
  'gym_status',
  'emergency_contact',
  'active_flag',
  'coach_id',
  'created_at',
  'updated_at',
] as const;

export const GOAL_FIELDS = [
  'goal_id',
  'athlete_id',
  'title',
  'target_date',
  'metric',
  'status',
  'created_at',
  'updated_at',
] as const;

// Permitted on a goal payload but not demanded of it. assertOnlyAllowedKeys
// requires every field it is given, so putting these in GOAL_FIELDS would break
// every existing caller the moment the columns landed -- and would force a
// client that does not track progress to state a number for it anyway. Absent
// means null, which is the honest reading.
export const GOAL_OPTIONAL_FIELDS = [
  'category',
  'progress_percent',
] as const;

// The categories a goal may be filed under, and the mirror of the CHECK in
// pilot_slice_postgres_goal_category_progress_migration.sql -- keep the two in
// step or the API will accept a value the database then refuses.
//
// 'Weight Loss' and 'Weight Gain' are deliberately NOT here. The athlete-facing
// dropdown offered them and the value was discarded, so nothing has ever been
// stored under either. Admitting them now would file a minor's weight intent as
// a queryable row ahead of the Privacy-Tier System (capability 200) that is
// supposed to govern exactly that data, and ahead of Group J, which the
// capability plan places in Phase 7 behind those tiers. The SQL header carries
// the full argument; this is an owner decision to revisit once the tiers exist,
// and reversing it is one line here, one in the migration, and one in
// SMART_GOAL_CATEGORIES.
export const GOAL_CATEGORIES = [
  'Boxing',
  'Fitness',
  'Academics',
  'Attendance',
  'Recovery',
  'Lifestyle',
  'Leadership',
] as const;

export const SESSION_FIELDS = [
  'session_id',
  'athlete_id',
  'date',
  'rpe',
  'rpe_method',
  'notes',
  'completed_flag',
  'created_at',
  'updated_at',
] as const;

export const COACH_REVIEW_FIELDS = [
  'review_id',
  'session_id',
  'coach_id',
  'decision',
  'notes',
  'approved_flag',
  'created_at',
  'updated_at',
] as const;

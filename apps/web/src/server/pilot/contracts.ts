import { type GymStatus } from '@/src/shared/athleteConstants';

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
  gym_status: GymStatus;
  emergency_contact: string;
  active_flag: boolean;
  coach_id: string;
  created_at: string;
  updated_at: string;
}

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
  rpe: number;
  notes: string;
  completed_flag: boolean;
  created_at: string;
  updated_at: string;
}

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

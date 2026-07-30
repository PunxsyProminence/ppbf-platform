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

export interface PilotGoal {
  goal_id: string;
  athlete_id: string;
  title: string;
  target_date: string;
  metric: string;
  status: string;
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

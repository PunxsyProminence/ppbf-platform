import {
  ATHLETE_FIELDS,
  COACH_REVIEW_FIELDS,
  GOAL_FIELDS,
  SESSION_FIELDS,
  type PilotAthlete,
  type PilotCoachReview,
  type PilotGoal,
  type PilotSession,
} from './contracts';
import { GYM_STATUS_OPTIONS, type GymStatus } from '@/src/shared/athleteConstants';

function asRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Request body must be a JSON object');
  }
  return payload as Record<string, unknown>;
}

function assertOnlyAllowedKeys(record: Record<string, unknown>, allowedKeys: readonly string[]): void {
  const incoming = Object.keys(record);
  const extras = incoming.filter((key) => !allowedKeys.includes(key));
  if (extras.length > 0) {
    throw new Error(`Unsupported fields: ${extras.join(', ')}`);
  }

  const missing = allowedKeys.filter((key) => !(key in record));
  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }
}

// Every message below has to begin with a prefix jsonError maps to 400
// ("Request body", "Missing", "Unsupported"). Anything else is an unrecognized
// message, which jsonError replaces with a 500 "Internal server error" -- so a
// caller who sent one bad field would be told the server was broken and never
// learn which field to fix.
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Request body field ${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`Request body field ${field} must be a boolean`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError(`Request body field ${field} must be a valid number`);
  }
  return value;
}

function requireGymStatus(value: unknown, field: string): GymStatus {
  const str = requireString(value, field);
  if (!GYM_STATUS_OPTIONS.includes(str as GymStatus)) {
    throw new Error(`Request body field ${field} must be one of: ${GYM_STATUS_OPTIONS.join(', ')}`);
  }
  return str as GymStatus;
}

export function validateAthletePayload(payload: unknown): PilotAthlete {
  const record = asRecord(payload);
  assertOnlyAllowedKeys(record, ATHLETE_FIELDS);

  return {
    athlete_id: requireString(record.athlete_id, 'athlete_id'),
    full_name: requireString(record.full_name, 'full_name'),
    dob: requireString(record.dob, 'dob'),
    weight_class: requireString(record.weight_class, 'weight_class'),
    gym_status: requireGymStatus(record.gym_status, 'gym_status'),
    emergency_contact: requireString(record.emergency_contact, 'emergency_contact'),
    active_flag: requireBoolean(record.active_flag, 'active_flag'),
    coach_id: requireString(record.coach_id, 'coach_id'),
    created_at: requireString(record.created_at, 'created_at'),
    updated_at: requireString(record.updated_at, 'updated_at'),
  };
}

export function validateGoalPayload(payload: unknown): PilotGoal {
  const record = asRecord(payload);
  assertOnlyAllowedKeys(record, GOAL_FIELDS);

  return {
    goal_id: requireString(record.goal_id, 'goal_id'),
    athlete_id: requireString(record.athlete_id, 'athlete_id'),
    title: requireString(record.title, 'title'),
    target_date: requireString(record.target_date, 'target_date'),
    metric: requireString(record.metric, 'metric'),
    status: requireString(record.status, 'status'),
    created_at: requireString(record.created_at, 'created_at'),
    updated_at: requireString(record.updated_at, 'updated_at'),
  };
}

export function validateSessionPayload(payload: unknown): PilotSession {
  const record = asRecord(payload);
  assertOnlyAllowedKeys(record, SESSION_FIELDS);

  return {
    session_id: requireString(record.session_id, 'session_id'),
    athlete_id: requireString(record.athlete_id, 'athlete_id'),
    date: requireString(record.date, 'date'),
    rpe: requireNumber(record.rpe, 'rpe'),
    notes: requireString(record.notes, 'notes'),
    completed_flag: requireBoolean(record.completed_flag, 'completed_flag'),
    created_at: requireString(record.created_at, 'created_at'),
    updated_at: requireString(record.updated_at, 'updated_at'),
  };
}

export function validateCoachReviewPayload(payload: unknown): PilotCoachReview {
  const record = asRecord(payload);
  assertOnlyAllowedKeys(record, COACH_REVIEW_FIELDS);

  return {
    review_id: requireString(record.review_id, 'review_id'),
    session_id: requireString(record.session_id, 'session_id'),
    coach_id: requireString(record.coach_id, 'coach_id'),
    decision: requireString(record.decision, 'decision'),
    notes: requireString(record.notes, 'notes'),
    approved_flag: requireBoolean(record.approved_flag, 'approved_flag'),
    created_at: requireString(record.created_at, 'created_at'),
    updated_at: requireString(record.updated_at, 'updated_at'),
  };
}

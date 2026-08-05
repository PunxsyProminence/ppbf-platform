import {
  ATHLETE_FIELDS,
  COACH_REVIEW_FIELDS,
  GOAL_CATEGORIES,
  GOAL_FIELDS,
  GOAL_OPTIONAL_FIELDS,
  SESSION_FIELDS,
  type PilotAthlete,
  type PilotCoachReview,
  type PilotGoal,
  type PilotSession,
} from './contracts';

function asRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Request body must be a JSON object');
  }
  return payload as Record<string, unknown>;
}

// `optionalKeys` are accepted but not demanded. Everything in `allowedKeys`
// stays required, so the existing payloads are unchanged: the parameter exists
// so a field can be added to a contract without breaking every caller that
// predates it, which is the situation the goal columns arrived in.
function assertOnlyAllowedKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): void {
  const incoming = Object.keys(record);
  const extras = incoming.filter((key) => !allowedKeys.includes(key) && !optionalKeys.includes(key));
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

// Absent and explicitly null both mean "not recorded" and both store as NULL.
// The distinction the column exists to keep is between null and 0: null is
// nobody has reported progress, 0 is an athlete reporting they have not started.
function optionalProgressPercent(value: unknown, field: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(`Request body field ${field} must be a whole number from 0 to 100`);
  }
  return value;
}

// Checked against the vocabulary here rather than left to the database, so a
// bad value is a 400 naming the field instead of a constraint violation
// surfacing as a 500. GOAL_CATEGORIES and the SQL CHECK are the same list.
function optionalCategory(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || !(GOAL_CATEGORIES as readonly string[]).includes(value)) {
    throw new Error(
      `Request body field ${field} must be one of: ${GOAL_CATEGORIES.join(', ')}`,
    );
  }
  return value;
}

export function validateAthletePayload(payload: unknown): PilotAthlete {
  const record = asRecord(payload);
  assertOnlyAllowedKeys(record, ATHLETE_FIELDS);

  return {
    athlete_id: requireString(record.athlete_id, 'athlete_id'),
    full_name: requireString(record.full_name, 'full_name'),
    dob: requireString(record.dob, 'dob'),
    weight_class: requireString(record.weight_class, 'weight_class'),
    gym_status: requireString(record.gym_status, 'gym_status'),
    emergency_contact: requireString(record.emergency_contact, 'emergency_contact'),
    active_flag: requireBoolean(record.active_flag, 'active_flag'),
    coach_id: requireString(record.coach_id, 'coach_id'),
    created_at: requireString(record.created_at, 'created_at'),
    updated_at: requireString(record.updated_at, 'updated_at'),
  };
}

export function validateGoalPayload(payload: unknown): PilotGoal {
  const record = asRecord(payload);
  assertOnlyAllowedKeys(record, GOAL_FIELDS, GOAL_OPTIONAL_FIELDS);

  return {
    goal_id: requireString(record.goal_id, 'goal_id'),
    athlete_id: requireString(record.athlete_id, 'athlete_id'),
    title: requireString(record.title, 'title'),
    target_date: requireString(record.target_date, 'target_date'),
    metric: requireString(record.metric, 'metric'),
    status: requireString(record.status, 'status'),
    category: optionalCategory(record.category, 'category'),
    progress_percent: optionalProgressPercent(record.progress_percent, 'progress_percent'),
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

// An issued workout template as a SCREEN receives it, and the order a screen
// draws it in (lane P7c, OD-2026-10-10-004 ruling 5).
//
// Pure and client-safe: no server imports. One copy for every screen that
// lists assigned work -- the athlete's assignments page, the athlete's Floor
// and the coach's card list -- so they cannot come to disagree about what a
// readable answer is or about the order a workout is drawn in.
//
// The server sends the assignments as it always has and, beside them, the
// workouts: which assignments are steps of one, in the coach's order, and what
// the template says beside each step. The drill, reps, minutes and status of a
// step stay on the assignment the step points at.

/** One step of an issued workout: where the assignment sits and what the template says beside it. */
export interface IssuedWorkoutStepView {
  /** The coach's own number for the step. It can have gaps. */
  ordinal: number;
  block: string;
  /** Null when the coach left the level to be picked on the day. Never filled in. */
  scale_level: string | null;
  /** The coach's entry. Shown as written. */
  contact_level: string;
  coach_note: string | null;
  assignment_id: string;
}

/** An issued workout. The optional fields are sent to some readers and not others. */
export interface IssuedWorkoutView {
  issue_id: string;
  template_name: string;
  issued_at?: string;
  issued_by_name?: string;
  steps: IssuedWorkoutStepView[];
}

const isText = (value: unknown): value is string => typeof value === 'string';
const isTextOrNull = (value: unknown): value is string | null => value === null || isText(value);
const isTextIfSent = (value: unknown): boolean => value === undefined || isText(value);

/** Thrown by readIssuedWorkouts. Its message is for a log, never for a screen. */
export class IssuedWorkoutsUnreadableError extends Error {
  constructor() {
    super('The workouts beside the assignments could not be read.');
    this.name = 'IssuedWorkoutsUnreadableError';
  }
}

/**
 * The `workouts` of an answer. Absent (a server that predates the field) is no
 * workouts. Present but not the shape a screen reads is NOT read as "no
 * workouts": the steps would be drawn as loose drills, out of their order, and
 * called the whole list. So it throws, and the caller says the list could not
 * be read, in its own words.
 *
 * Only what every screen draws is required. `issued_at` and `issued_by_name`
 * must be text when they are sent; a screen that draws the date checks that it
 * is one.
 */
export function readIssuedWorkouts(raw: unknown): IssuedWorkoutView[] {
  if (raw === undefined) return [];
  const wellFormed = Array.isArray(raw) && raw.every((workout: unknown) => {
    const w = workout as Partial<IssuedWorkoutView> | null;
    return w !== null && typeof w === 'object' && isText(w.issue_id) && isText(w.template_name)
      && isTextIfSent(w.issued_at) && isTextIfSent(w.issued_by_name)
      && Array.isArray(w.steps) && w.steps.every((step: unknown) => {
        const s = step as Partial<IssuedWorkoutStepView> | null;
        return s !== null && typeof s === 'object' && Number.isInteger(s.ordinal) && isText(s.block)
          && isTextOrNull(s.scale_level) && isText(s.contact_level) && isTextOrNull(s.coach_note) && isText(s.assignment_id);
      });
  });
  if (!wellFormed) throw new IssuedWorkoutsUnreadableError();
  return raw as IssuedWorkoutView[];
}

/** One line of an assigned-work list, in the order it is drawn. */
export type AssignedWorkRow<T> =
  | { kind: 'workout'; key: string; workout: IssuedWorkoutView; stepCount: number }
  | { kind: 'block'; key: string; block: string }
  | { kind: 'assignment'; key: string; assignment: T; step: IssuedWorkoutStepView | null };

/**
 * The assigned work in the order it is drawn. The order the assignments came
 * in is kept (dated work first, as the server sorts it): an assignment that is
 * not a step of a workout is drawn where it stands, and an issued workout is
 * drawn WHOLE at the place of the first of its drills -- a heading, then its
 * steps in the coach's order, with a block heading every time the block
 * changes (so a block the coach returns to is shown again, where the coach put
 * it). A step whose assignment is not in the list is left out; a workout with
 * no step left is not drawn; an assignment two workouts both name is a step of
 * the first only, and an issue id the answer repeats is one workout, so
 * nothing is drawn twice.
 *
 * `stepCount` on the workout row is the number of its steps that ARE in the
 * list, which is fewer than `workout.steps.length` when the caller passed only
 * some of the assignments (the Floor passes the open ones).
 */
export function orderAssignedWork<T extends { assignment_id: string }>(
  assignments: T[],
  workouts: IssuedWorkoutView[],
): AssignedWorkRow<T>[] {
  const sent = new Set(assignments.map((assignment) => assignment.assignment_id));
  const workoutOf = new Map<string, IssuedWorkoutView>();
  const stepsOf = new Map<IssuedWorkoutView, IssuedWorkoutStepView[]>();
  const issueIds = new Set<string>();
  for (const workout of workouts) {
    // An issue id the answer repeats is one workout: the first entry is it.
    if (issueIds.has(workout.issue_id)) continue;
    issueIds.add(workout.issue_id);
    const steps: IssuedWorkoutStepView[] = [];
    for (const step of [...workout.steps].sort((a, b) => a.ordinal - b.ordinal)) {
      if (!sent.has(step.assignment_id) || workoutOf.has(step.assignment_id)) continue;
      workoutOf.set(step.assignment_id, workout);
      steps.push(step);
    }
    stepsOf.set(workout, steps);
  }

  const byId = new Map(assignments.map((assignment) => [assignment.assignment_id, assignment]));
  const drawn = new Set<IssuedWorkoutView>();
  const rows: AssignedWorkRow<T>[] = [];
  for (const assignment of assignments) {
    const workout = workoutOf.get(assignment.assignment_id);
    if (!workout) {
      rows.push({ kind: 'assignment', key: assignment.assignment_id, assignment, step: null });
      continue;
    }
    if (drawn.has(workout)) continue;
    drawn.add(workout);
    const steps = stepsOf.get(workout) ?? [];
    rows.push({ kind: 'workout', key: `workout-${workout.issue_id}`, workout, stepCount: steps.length });
    let block: string | null = null;
    for (const [index, step] of steps.entries()) {
      if (step.block !== block) {
        block = step.block;
        rows.push({ kind: 'block', key: `block-${workout.issue_id}-${index}`, block });
      }
      rows.push({ kind: 'assignment', key: step.assignment_id, assignment: byId.get(step.assignment_id) as T, step });
    }
  }
  return rows;
}

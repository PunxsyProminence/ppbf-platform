// An issued workout template as a SCREEN receives it, and the order a screen
// draws it in (lane P7c, OD-2026-10-10-004 ruling 5).
//
// Pure and client-safe: no server imports. The READER is the one copy for the
// four screens that list assigned work -- the athlete's assignments page, the
// athlete's Floor, the guardian's page and the coach's card list -- so they
// cannot come to disagree about what a readable answer is. The ORDERING is shared by the two athlete
// screens and the guardian's; the card list arranges cards inside its own
// issuance groups (app/coach/cards/page.tsx) and uses only the reader.
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

/**
 * An issued workout, as far as readIssuedWorkouts has checked it. The date and
 * the coach's name are typed `unknown` because the reader does not look at
 * them: a screen that draws one checks it itself and narrows the type.
 */
export interface IssuedWorkoutView {
  issue_id: string;
  template_name: string;
  issued_at?: unknown;
  issued_by_name?: unknown;
  steps: IssuedWorkoutStepView[];
}

const isText = (value: unknown): value is string => typeof value === 'string';
const isTextOrNull = (value: unknown): value is string | null => value === null || isText(value);

/** Thrown by readIssuedWorkouts and readDatedIssuedWorkouts. Its message is for a log, never for a screen. */
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
 * Only what every screen draws is required, so a field one screen does not
 * draw cannot make that screen's list unreadable. `issued_at` and
 * `issued_by_name` are not looked at here: a screen that draws them reads
 * with readDatedIssuedWorkouts.
 */
export function readIssuedWorkouts(raw: unknown): IssuedWorkoutView[] {
  if (raw === undefined) return [];
  const wellFormed = Array.isArray(raw) && raw.every((workout: unknown) => {
    const w = workout as Partial<IssuedWorkoutView> | null;
    return w !== null && typeof w === 'object' && isText(w.issue_id) && isText(w.template_name)
      && Array.isArray(w.steps) && w.steps.every((step: unknown) => {
        const s = step as Partial<IssuedWorkoutStepView> | null;
        return s !== null && typeof s === 'object' && Number.isInteger(s.ordinal) && isText(s.block)
          && isTextOrNull(s.scale_level) && isText(s.contact_level) && isTextOrNull(s.coach_note) && isText(s.assignment_id);
      });
  });
  if (!wellFormed) throw new IssuedWorkoutsUnreadableError();
  return raw as IssuedWorkoutView[];
}

/** An issued workout whose date and coach's name have been checked too. */
export interface DatedIssuedWorkout extends IssuedWorkoutView {
  issued_at: string;
  /** Absent when the server sent no name. Never an account id: a family reader is sent a name. */
  issued_by_name?: string;
}

/**
 * readIssuedWorkouts for a screen that also draws the date each workout was
 * issued and who issued it: the athlete's assignments page and the guardian's.
 * A workout with no readable date, or a name that is not text, is refused
 * here the same way -- thrown, never read as "no workouts".
 */
export function readDatedIssuedWorkouts(raw: unknown): DatedIssuedWorkout[] {
  return readIssuedWorkouts(raw).map((workout) => {
    const { issued_at, issued_by_name } = workout;
    if (typeof issued_at !== 'string' || Number.isNaN(Date.parse(issued_at))) throw new IssuedWorkoutsUnreadableError();
    if (issued_by_name !== undefined && typeof issued_by_name !== 'string') throw new IssuedWorkoutsUnreadableError();
    return { ...workout, issued_at, issued_by_name };
  });
}

/** One line of an assigned-work list, in the order it is drawn. */
export type AssignedWorkRow<T, W extends IssuedWorkoutView = IssuedWorkoutView> =
  | { kind: 'workout'; key: string; workout: W; stepCount: number }
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
export function orderAssignedWork<T extends { assignment_id: string }, W extends IssuedWorkoutView>(
  assignments: T[],
  workouts: W[],
): AssignedWorkRow<T, W>[] {
  const sent = new Set(assignments.map((assignment) => assignment.assignment_id));
  const workoutOf = new Map<string, W>();
  const stepsOf = new Map<W, IssuedWorkoutStepView[]>();
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
  const drawn = new Set<W>();
  const rows: AssignedWorkRow<T, W>[] = [];
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

/** What is drawn under a workout's heading: a block name, or one of its steps. */
export type IssuedWorkoutPart<T> =
  | { kind: 'block'; key: string; block: string }
  | { kind: 'step'; key: string; assignment: T; step: IssuedWorkoutStepView };

/** One unit of an assigned-work list: a whole workout, or one assignment that is a step of none. */
export type AssignedWorkSection<T, W extends IssuedWorkoutView = IssuedWorkoutView> =
  | { kind: 'workout'; key: string; workout: W; stepCount: number; parts: IssuedWorkoutPart<T>[] }
  | { kind: 'assignment'; key: string; assignment: T };

/**
 * The same order as orderAssignedWork, with each workout's block names and
 * steps gathered under it -- for a screen that draws a workout as ONE panel,
 * so the panel's edge says where the workout starts and where it ends.
 */
export function sectionAssignedWork<T extends { assignment_id: string }, W extends IssuedWorkoutView>(
  assignments: T[],
  workouts: W[],
): AssignedWorkSection<T, W>[] {
  const sections: AssignedWorkSection<T, W>[] = [];
  let parts: IssuedWorkoutPart<T>[] = [];
  for (const row of orderAssignedWork(assignments, workouts)) {
    if (row.kind === 'workout') {
      parts = [];
      sections.push({ kind: 'workout', key: row.key, workout: row.workout, stepCount: row.stepCount, parts });
    } else if (row.kind === 'block') {
      parts.push(row);
    } else if (row.step) {
      parts.push({ kind: 'step', key: row.key, assignment: row.assignment, step: row.step });
    } else {
      sections.push({ kind: 'assignment', key: row.key, assignment: row.assignment });
    }
  }
  return sections;
}

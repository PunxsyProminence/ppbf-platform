/* WHAT A FAMILY IS SENT ABOUT AN ATHLETE'S GOALS (lane N8-05, F-047).
 *
 * Owner ruling 2026-10-12: goals, reported progress and "I did it" show
 * read-only to the athlete's coach and to their guardian. The athlete's "why
 * it matters" line shows to the coach only, never to the parent.
 *
 * So a guardian's answer is built here from a NAMED list of fields, never by
 * deleting fields from a row. A column added to pilot.goals later is then
 * absent from a family's answer until somebody decides it belongs there,
 * rather than present until somebody remembers to strip it. The projection is
 * done on the server: a field the browser was sent is a field the family has,
 * whatever the screen chooses to draw. */

import type { PilotGoal } from './contracts';
import type { PersonalGoal } from './achievements';

/** An own-words goal as a guardian receives it: no reason line, no author role. */
export interface FamilyPersonalGoal {
  goal_id: string;
  title: string;
  target_date: string | null;
  reached_at: string | null;
  created_at: string;
}

/** A SMART goal as a guardian receives it, with the athlete's reported progress. */
export interface FamilySmartGoal {
  goal_id: string;
  title: string;
  category: string | null;
  target_date: string;
  metric: string;
  progress_percent: number | null;
  status: string;
  created_at: string;
}

export function toFamilyPersonalGoal(goal: PersonalGoal): FamilyPersonalGoal {
  return {
    goal_id: goal.goal_id,
    title: goal.title,
    target_date: goal.target_date,
    reached_at: goal.reached_at,
    created_at: goal.created_at,
  };
}

/** pilot.goals holds both kinds. A row written by the own-words path is read
 *  through /goals/personal, so it is not repeated in a family's SMART list --
 *  and its own_words and why_it_matters columns never ride along with it. */
export function isOwnWordsRow(goal: PilotGoal): boolean {
  return goal.goal_kind === 'own_words';
}

/* WHO IS SENT THE WHOLE ROW. Named, so a role added to a route's gate later
   gets the family projection until somebody decides otherwise -- the reason
   line does not go to a role by default. The athlete wrote it; staff (coach,
   organization admin) read it under the owner ruling. */
const FULL_GOAL_READERS = new Set(['athlete', 'coach', 'organization_admin', 'admin']);

export function readsFullGoals(role: string): boolean {
  return FULL_GOAL_READERS.has(role);
}

export function toFamilySmartGoals(goals: PilotGoal[]): FamilySmartGoal[] {
  return goals
    .filter((goal) => !isOwnWordsRow(goal))
    .map((goal) => ({
      goal_id: goal.goal_id,
      title: goal.title,
      category: goal.category ?? null,
      target_date: goal.target_date,
      metric: goal.metric,
      progress_percent: goal.progress_percent ?? null,
      status: goal.status,
      created_at: goal.created_at,
    }));
}

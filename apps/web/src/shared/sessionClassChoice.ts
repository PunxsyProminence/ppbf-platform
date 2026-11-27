// Which scheduled class a new session is for, before the coach chooses (D4, OD-2026-10-21-002:
// a live session tied to its class, so attendance is entered once).
//
// The classes are today's that the coach may tie (GET /api/pilot/session-scripts/runs?classes=today,
// already filtered to the gym's day, not cancelled, the coach's own). A class "under way" runs from
// 30 minutes before its start until its end. The default is never a guess between classes and
// never the oldest one (the wrong-class failure, B2):
//   exactly one free class under way  -> that class
//   no free class today               -> no class (open gym)
//   anything else                     -> undecided: the screen asks
// A class another live session already holds cannot be chosen (one live session per class).

/** A class's plan: the newest version of the plan it was scheduled with (sessionRunClass.ts listTieableClasses). */
export interface ClassPlanView {
  script_id: string;
  name: string;
  retired: boolean;
  has_blocks: boolean;
}

export interface TieableClassView {
  class_id: string;
  title: string;
  start_at: string;
  end_at: string;
  held_by_other_session: boolean;
  /** null: a class with no plan. Optional so a list without it reads as no plan. */
  plan?: ClassPlanView | null;
}

/**
 * What a class's plan starts as, and the one line the class screen shows for it (OW27-29 A, "Class
 * keeps the plan; Start runs it"; App Overwatch 7215533652 on #2189). A retired plan (Q2) or one
 * with no blocks (Q3) starts a session tied to the class without it; retired is checked first. No
 * class, or a class with no plan: nothing starts with it and nothing is shown. The class screen's
 * Start does not send this scriptId: the server resolves the class's plan when Start is committed
 * (sessionScriptRuns.ts startClassPlanRun; Codex P1 on #2241), and the screen words its answer here.
 */
export function classPlanStart(item: Pick<TieableClassView, 'plan'> | undefined): { scriptId: string | null; line: string | null } {
  const plan = item?.plan;
  if (!plan) return { scriptId: null, line: null };
  if (plan.retired) return { scriptId: null, line: `This class's plan, ${plan.name}, is retired, so this session starts without it.` };
  if (!plan.has_blocks) return { scriptId: null, line: `This class's plan, ${plan.name}, has no blocks yet, so this session starts without it.` };
  return { scriptId: plan.script_id, line: `This class runs the plan: ${plan.name}.` };
}

export const UNDER_WAY_LEAD_MS = 30 * 60 * 1000;

/** The class id, null for no class (open gym), or undefined when the coach must choose. */
export type ClassChoice = string | null | undefined;

/**
 * Milliseconds for a time the server sends as Postgres text ("2026-10-21 22:00:00+00"), which not
 * every browser's Date.parse reads (Safari wants "T" and "+00:00"); ISO strings pass unchanged.
 */
export function toIsoInstant(value: string): string {
  return value.trim().replace(' ', 'T').replace(/(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?[+-]\d{2})$/, '$1:00');
}

export function instantMs(value: string): number {
  return Date.parse(toIsoInstant(value));
}

export function classesUnderWay(classes: readonly TieableClassView[], nowMs: number): TieableClassView[] {
  return classes.filter((item) => {
    const start = instantMs(item.start_at);
    const end = instantMs(item.end_at);
    return !item.held_by_other_session && Number.isFinite(start) && Number.isFinite(end)
      && start - UNDER_WAY_LEAD_MS <= nowMs && nowMs < end;
  });
}

export function defaultClassChoice(classes: readonly TieableClassView[], nowMs: number): ClassChoice {
  const free = classes.filter((item) => !item.held_by_other_session);
  if (free.length === 0) return null;
  const underWay = classesUnderWay(free, nowMs);
  return underWay.length === 1 ? underWay[0].class_id : undefined;
}

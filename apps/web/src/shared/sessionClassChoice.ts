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

export interface TieableClassView {
  class_id: string;
  title: string;
  start_at: string;
  end_at: string;
  held_by_other_session: boolean;
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

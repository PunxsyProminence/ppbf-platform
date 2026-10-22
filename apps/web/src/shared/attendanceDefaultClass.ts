import { gymDayIso } from '@/src/lib/gymTime';

// Which class the /schedule "Attendance Check-In" picker opens on for STAFF (coach, organization
// admin, admin). A family's default is the page's own rule (today's class, their own first).
//
// The picker used to open on the first class the scheduler returned, and the scheduler lists
// classes oldest first (schedulerDb.ts, `order by start_at asc`). Live walkthrough 2026-10-19:
// it opened on a test class from two weeks earlier, so one tap marked the wrong class. The
// readiness check of 2026-10-20 lists it as pilot blocker B2.
//
// The order, never a cancelled class (the register refuses one):
//   1. today's class (the gym's day): the one running now, else the one nearest now, by its start
//      or its end, so 10 minutes before a 6 PM class opens on that class and 8 PM after a 6-7 PM
//      class opens on it unless another starts sooner;
//   2. with no class today, the latest class that has already begun (a register taken late);
//   3. with every class still ahead, the next one.
// Null only when there is no class that is not cancelled.

export interface PickableClass {
  class_id: string;
  start_at: string;
  end_at: string;
  status: string;
}

function instant(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function distanceFromNow(item: PickableClass, nowMs: number): number {
  const start = instant(item.start_at);
  const endParsed = instant(item.end_at);
  const end = Number.isFinite(endParsed) && endParsed > start ? endParsed : start;
  if (start <= nowMs && nowMs < end) return 0;
  return Math.min(Math.abs(nowMs - start), Math.abs(nowMs - end));
}

export function defaultStaffAttendanceClassId(classes: readonly PickableClass[], nowMs: number): string | null {
  const open = classes.filter((item) => item.status !== 'cancelled' && Number.isFinite(instant(item.start_at)));
  if (open.length === 0) return null;

  const today = gymDayIso(nowMs);
  const todays = open.filter((item) => today !== null && gymDayIso(item.start_at) === today);
  if (todays.length > 0) {
    return todays.reduce((best, item) => (distanceFromNow(item, nowMs) < distanceFromNow(best, nowMs) ? item : best))
      .class_id;
  }

  const begun = open.filter((item) => instant(item.start_at) <= nowMs);
  if (begun.length > 0) {
    return begun.reduce((latest, item) => (instant(item.start_at) > instant(latest.start_at) ? item : latest)).class_id;
  }

  return open.reduce((next, item) => (instant(item.start_at) < instant(next.start_at) ? item : next)).class_id;
}

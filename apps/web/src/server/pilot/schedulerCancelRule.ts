import { parseInstantAsGymTime } from '@/src/lib/gymTime';

import type { SchedulerClass } from './schedulerDb';

/**
 * Who may cancel a class, and until when (#1595, Jason's rulings on #1550's
 * two questions, 2026-10-14):
 *
 * 1. "A: Its coaches + office (Recommended)". The class's own coach (the
 *    coach it is scheduled for, or the coach who scheduled it), its cover
 *    coach, and the organization admin (and admin). Covering stays open to
 *    any coach of the gym, but a cover added within the last hour before the
 *    cancel cannot cancel, so "make myself cover, then cancel" no longer works.
 * 2. After the start: the office only. Jason, 2026-10-22: "then classes need
 *    to be able to be canceled", which replaces his 2026-10-14 "A: No, not
 *    after start (Recommended)" (OD-2026-10-14-001's "After start" half; the
 *    "Who cancels" half above stands). A coach, cover or not, still cannot
 *    cancel once the start time has passed; the organization admin can, at any
 *    time. A cancelled class's marks stop counting in the class-mark readers
 *    (lane LC; the per-day attendance view is not yet one of them).
 *
 * Pure: the route reads the class and when its cover was taken, and this
 * decides. GET's can_cancel and the cancel_class POST both call it, so the
 * screen offers the button exactly where the server would accept it.
 */

export const COVER_SETTLE_MS = 60 * 60 * 1000;

export type CancelRefusal = 'cancelled' | 'started' | 'not_class_coach' | 'cover_too_recent';

export interface CancelActor {
  accountId: string;
  /** organization_admin or admin: the office. */
  isOffice: boolean;
  isCoach: boolean;
}

// PROPOSED copy for the owner.
export const CANCEL_REFUSAL_MESSAGES: Record<CancelRefusal, string> = {
  cancelled: 'This class is already cancelled.',
  started: 'This class has already started, so only the office can cancel it now.',
  not_class_coach: "Only this class's coach, its cover coach or the office can cancel it.",
  cover_too_recent: 'A cover taken in the last hour cannot cancel this class. Its coach or the office can.',
};

/**
 * When the current cover was taken, as late as the evidence allows (so the
 * hour is never cut short). The cover_class audit row names the moment; it is
 * trusted only when the newest such row names the coach who covers now.
 * setSchedulerClassCover writes that row in the cover's own transaction, so
 * every cover since #1595 has one. A cover from before then, when the row was
 * best-effort, may not: the class's updated_at stands in. Covering sets it,
 * and nothing moves it backwards, so it is never earlier than the cover.
 */
export function coverTakenAtMs(
  classItem: Pick<SchedulerClass, 'covering_coach_account_id' | 'updated_at'>,
  latestCoverAudit: { covering_coach_account_id: string | null; created_at: string } | null,
): number {
  const updatedMs = Date.parse(classItem.updated_at);
  if (latestCoverAudit && latestCoverAudit.covering_coach_account_id === classItem.covering_coach_account_id) {
    const auditMs = Date.parse(latestCoverAudit.created_at);
    if (Number.isFinite(auditMs)) return auditMs;
  }
  // An unreadable timestamp reads as "just now": refused, never waved through.
  return Number.isFinite(updatedMs) ? updatedMs : Number.POSITIVE_INFINITY;
}

export function classCancelRefusal(
  actor: CancelActor,
  classItem: Pick<
    SchedulerClass,
    'status' | 'start_at' | 'updated_at' | 'coach_account_id' | 'scheduled_by_account_id' | 'covering_coach_account_id'
  >,
  coverTakenMs: number,
  nowMs: number,
): CancelRefusal | null {
  if (classItem.status === 'cancelled') return 'cancelled';
  // The office cancels before or after the start (Jason, 2026-10-22).
  if (actor.isOffice) return null;

  // Gym time: a stored start with no zone is the gym's clock, not the server's.
  const start = parseInstantAsGymTime(classItem.start_at);
  if (!start || start.getTime() <= nowMs) return 'started';

  if (!actor.isCoach) return 'not_class_coach';
  if (classItem.coach_account_id === actor.accountId || classItem.scheduled_by_account_id === actor.accountId) {
    return null;
  }
  if (classItem.covering_coach_account_id === actor.accountId) {
    return nowMs - coverTakenMs >= COVER_SETTLE_MS ? null : 'cover_too_recent';
  }
  return 'not_class_coach';
}

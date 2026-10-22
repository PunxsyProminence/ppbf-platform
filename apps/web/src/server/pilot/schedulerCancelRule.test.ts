import { COVER_SETTLE_MS, classCancelRefusal, coverTakenAtMs } from './schedulerCancelRule';

// The edges of #1595's two rulings. The route suite drives the same rule
// through cancel_class and GET's can_cancel.

const NOW = Date.parse('2026-10-14T20:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

const classItem = (fields: Record<string, unknown> = {}) => ({
  status: 'open' as const,
  start_at: iso(NOW + 30 * 60_000),
  updated_at: iso(NOW - 24 * 3_600_000),
  coach_account_id: 'acct-coach',
  scheduled_by_account_id: 'acct-scheduler',
  covering_coach_account_id: 'acct-cover' as string | undefined,
  ...fields,
});
const coach = (accountId: string) => ({ accountId, isOffice: false, isCoach: true });
const office = { accountId: 'acct-office', isOffice: true, isCoach: false };

describe('classCancelRefusal', () => {
  test('a cover held exactly an hour may cancel; a minute less may not', () => {
    expect(classCancelRefusal(coach('acct-cover'), classItem(), NOW - COVER_SETTLE_MS, NOW)).toBeNull();
    expect(classCancelRefusal(coach('acct-cover'), classItem(), NOW - COVER_SETTLE_MS + 60_000, NOW)).toBe('cover_too_recent');
  });

  test('the class coach and the coach who scheduled it are not held to the cover hour', () => {
    expect(classCancelRefusal(coach('acct-coach'), classItem(), NOW, NOW)).toBeNull();
    expect(classCancelRefusal(coach('acct-scheduler'), classItem(), NOW, NOW)).toBeNull();
  });

  test('a class starting now has started: its coach and its cover may no longer cancel it', () => {
    expect(classCancelRefusal(coach('acct-coach'), classItem({ start_at: iso(NOW) }), 0, NOW)).toBe('started');
    expect(classCancelRefusal(coach('acct-coach'), classItem({ start_at: iso(NOW + 1) }), 0, NOW)).toBeNull();
    expect(classCancelRefusal(coach('acct-cover'), classItem({ start_at: iso(NOW) }), NOW - 2 * COVER_SETTLE_MS, NOW)).toBe('started');
  });

  // Jason, 2026-10-22: "then classes need to be able to be canceled" (lane LC).
  test('the office may cancel before the start, at it, and after the class has ended', () => {
    expect(classCancelRefusal(office, classItem({ start_at: iso(NOW + 1) }), 0, NOW)).toBeNull();
    expect(classCancelRefusal(office, classItem({ start_at: iso(NOW) }), 0, NOW)).toBeNull();
    expect(classCancelRefusal(office, classItem({ start_at: iso(NOW - 8 * 24 * 3_600_000) }), 0, NOW)).toBeNull();
  });

  test('an unreadable start is treated as started for a coach, not waved through', () => {
    expect(classCancelRefusal(coach('acct-coach'), classItem({ start_at: 'not a date' }), 0, NOW)).toBe('started');
  });

  test('anyone who is neither office nor a coach of the class is refused', () => {
    expect(classCancelRefusal(coach('acct-other'), classItem(), 0, NOW)).toBe('not_class_coach');
    expect(classCancelRefusal({ accountId: 'acct-coach', isOffice: false, isCoach: false }, classItem(), 0, NOW)).toBe('not_class_coach');
  });

  test('a cancelled class says so before anything else', () => {
    expect(classCancelRefusal(coach('acct-other'), classItem({ status: 'cancelled' }), 0, NOW)).toBe('cancelled');
    expect(classCancelRefusal(office, classItem({ status: 'cancelled', start_at: iso(NOW - 3_600_000) }), 0, NOW)).toBe('cancelled');
  });
});

describe('coverTakenAtMs', () => {
  test('the audit row, when the newest one names the coach who covers now', () => {
    const at = NOW - 2 * 3_600_000;
    expect(coverTakenAtMs(classItem(), { covering_coach_account_id: 'acct-cover', created_at: iso(at) })).toBe(at);
  });

  test("otherwise the class's updated_at, which is never earlier than the cover", () => {
    const item = classItem({ updated_at: iso(NOW - 5 * 60_000) });
    expect(coverTakenAtMs(item, { covering_coach_account_id: 'acct-other', created_at: iso(NOW - 3 * 3_600_000) })).toBe(NOW - 5 * 60_000);
    expect(coverTakenAtMs(item, null)).toBe(NOW - 5 * 60_000);
  });

  test('an unreadable updated_at reads as just now', () => {
    expect(coverTakenAtMs(classItem({ updated_at: 'now' }), null)).toBe(Number.POSITIVE_INFINITY);
  });
});

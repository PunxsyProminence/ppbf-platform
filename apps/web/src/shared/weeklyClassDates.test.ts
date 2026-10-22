import { addGymDays, formatGymTimeOfDay, gymDayIso, parseInstantAsGymTime } from '@/src/lib/gymTime';

import { REPEAT_WEEKS_MAX, weeklyClassDates } from './weeklyClassDates';

/* Repeat weekly on Schedule Class (lane LW). The gym is America/New_York; in
   2026 the clocks go back on Sunday 1 November, and in 2027 forward on Sunday
   14 March. A class at 6:00 pm must stay at 6:00 pm on the gym clock on both
   sides, which moves it an hour in UTC. */

function gym(text: string): Date {
  const parsed = parseInstantAsGymTime(text);
  if (!parsed) throw new Error(`test bug: ${text}`);
  return parsed;
}

const TUESDAY_6PM = { start: gym('2026-10-27T18:00'), end: gym('2026-10-27T19:30') };

function iso(classes: Array<{ start: Date; end: Date }>) {
  return classes.map((item) => [item.start.toISOString(), item.end.toISOString()]);
}

describe('addGymDays', () => {
  test('keeps the gym clock across the November change: 6:00 pm EDT to 6:00 pm EST', () => {
    const next = addGymDays(gym('2026-10-27T18:00'), 7);
    expect(next.toISOString()).toBe('2026-11-03T23:00:00.000Z');
    expect(formatGymTimeOfDay(next)).toBe('6:00 PM');
  });

  test('keeps the gym clock across the March change: 6:00 pm EST to 6:00 pm EDT', () => {
    const next = addGymDays(gym('2027-03-09T18:00'), 7);
    expect(next.toISOString()).toBe('2027-03-16T22:00:00.000Z');
    expect(formatGymTimeOfDay(next)).toBe('6:00 PM');
  });

  test('days * 24 hours would have been an hour out (the bug this avoids)', () => {
    const start = gym('2026-10-27T18:00');
    expect(formatGymTimeOfDay(new Date(start.getTime() + 7 * 86_400_000))).toBe('5:00 PM');
  });
});

describe('weeklyClassDates', () => {
  test('for 4 weeks: four classes on the same weekday at the same gym time, across the clock change', () => {
    const plan = weeklyClassDates(TUESDAY_6PM, { weeks: 4 });
    if (!plan.ok) throw new Error(plan.error);
    expect(iso(plan.classes)).toEqual([
      ['2026-10-27T22:00:00.000Z', '2026-10-27T23:30:00.000Z'],
      ['2026-11-03T23:00:00.000Z', '2026-11-04T00:30:00.000Z'],
      ['2026-11-10T23:00:00.000Z', '2026-11-11T00:30:00.000Z'],
      ['2026-11-17T23:00:00.000Z', '2026-11-18T00:30:00.000Z'],
    ]);
    expect(plan.classes.map((item) => formatGymTimeOfDay(item.start))).toEqual(['6:00 PM', '6:00 PM', '6:00 PM', '6:00 PM']);
    expect(plan.classes.map((item) => gymDayIso(item.start))).toEqual(['2026-10-27', '2026-11-03', '2026-11-10', '2026-11-17']);
  });

  test('the first class is the instant given, untouched', () => {
    const plan = weeklyClassDates(TUESDAY_6PM, { weeks: 1 });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.classes).toEqual([TUESDAY_6PM]);
  });

  test('until a date: every week up to and including that gym date', () => {
    const plan = weeklyClassDates(TUESDAY_6PM, { until: '2026-11-10' });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.classes.map((item) => gymDayIso(item.start))).toEqual(['2026-10-27', '2026-11-03', '2026-11-10']);
  });

  test('until a date that is not a class day stops at the week before it', () => {
    const plan = weeklyClassDates(TUESDAY_6PM, { until: '2026-11-09' });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.classes).toHaveLength(2);
  });

  test('until reads the GYM date: a 9:00 pm class is still on its own day after midnight UTC', () => {
    const late = { start: gym('2026-10-27T21:00'), end: gym('2026-10-27T22:00') };
    const plan = weeklyClassDates(late, { until: '2026-11-03' });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.classes).toHaveLength(2);
  });

  test(`at most ${REPEAT_WEEKS_MAX} weeks, both ways of asking`, () => {
    expect(weeklyClassDates(TUESDAY_6PM, { weeks: REPEAT_WEEKS_MAX }).ok).toBe(true);
    const lastAllowed = gymDayIso(addGymDays(TUESDAY_6PM.start, 7 * (REPEAT_WEEKS_MAX - 1)));
    const twelve = weeklyClassDates(TUESDAY_6PM, { until: lastAllowed ?? '' });
    expect(twelve.ok && twelve.classes.length).toBe(REPEAT_WEEKS_MAX);

    expect(weeklyClassDates(TUESDAY_6PM, { weeks: REPEAT_WEEKS_MAX + 1 })).toEqual({ ok: false, error: 'Repeat weekly runs for 1 to 12 weeks.' });
    const oneMore = gymDayIso(addGymDays(TUESDAY_6PM.start, 7 * REPEAT_WEEKS_MAX));
    expect(weeklyClassDates(TUESDAY_6PM, { until: oneMore ?? '' })).toEqual({
      ok: false,
      error: 'Repeat weekly runs for at most 12 weeks. Pick an earlier end date.',
    });
  });

  test.each([0, -1, 2.5, Number.NaN])('%p weeks is refused', (weeks) => {
    expect(weeklyClassDates(TUESDAY_6PM, { weeks })).toEqual({ ok: false, error: 'Repeat weekly runs for 1 to 12 weeks.' });
  });

  test('an end date before the first class is refused', () => {
    expect(weeklyClassDates(TUESDAY_6PM, { until: '2026-10-26' })).toEqual({ ok: false, error: 'The repeat end date is before the first class.' });
  });

  test.each(['2026-02-30', 'next friday', '11/10/2026', ''])('%p is not a date', (until) => {
    expect(weeklyClassDates(TUESDAY_6PM, { until })).toEqual({ ok: false, error: 'The repeat end date must be a date.' });
  });
});

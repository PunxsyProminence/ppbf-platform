import {
  loadWeekWindows,
  REST_MARK_CLEAR_FIELDS,
  REST_MARK_CREATE_FIELDS,
  REST_MARK_KINDS,
  REST_MARK_MAX_DAYS,
  REST_MARK_ROLES,
  restMarkReadWindow,
  restMarkShapeError,
  restMarkUnknownFieldsError,
} from './restMarks';

// Pure rules of the rest/away mark (lane R6-b1, OD-2026-11-17-004). The
// database half is restMarks.pg.test.ts.

const TODAY = '2026-11-19';

describe('who may mark, and what a mark is', () => {
  test('coach and organization admin only (Jason 2026-11-19, "A: Coach + office")', () => {
    expect([...REST_MARK_ROLES]).toEqual(['coach', 'organization_admin', 'admin']);
    for (const role of ['athlete', 'parent', 'board', 'volunteer', 'platform_owner']) {
      expect(REST_MARK_ROLES as readonly string[]).not.toContain(role);
    }
  });

  test('two fixed kinds and two dates; nothing that could hold a reason', () => {
    expect([...REST_MARK_KINDS]).toEqual(['rest', 'away']);
    expect([...REST_MARK_CREATE_FIELDS]).toEqual(['athlete_id', 'kind', 'first_day', 'last_day']);
    expect([...REST_MARK_CLEAR_FIELDS]).toEqual(['athlete_id', 'mark_id']);
  });
});

describe('restMarkUnknownFieldsError: a reason is refused, never dropped', () => {
  test.each([
    ['reason'],
    ['note'],
    ['notes'],
    ['health_reason'],
    ['comment'],
    ['injury'],
  ])('a body carrying %s is refused, naming it', (field) => {
    const body = { athlete_id: 'a', kind: 'rest', first_day: TODAY, last_day: TODAY, [field]: 'sick' };
    const error = restMarkUnknownFieldsError(body, REST_MARK_CREATE_FIELDS);
    expect(error).toMatch(/records no reason/);
    expect(error).toContain(field);
  });

  test('an empty reason is refused too: the field itself is the refusal, not its content', () => {
    const body = { athlete_id: 'a', kind: 'rest', first_day: TODAY, last_day: TODAY, reason: '' };
    expect(restMarkUnknownFieldsError(body, REST_MARK_CREATE_FIELDS)).not.toBeNull();
  });

  test('exactly the allowed fields pass, for marking and for clearing', () => {
    expect(restMarkUnknownFieldsError({ athlete_id: 'a', kind: 'away', first_day: TODAY, last_day: TODAY }, REST_MARK_CREATE_FIELDS)).toBeNull();
    expect(restMarkUnknownFieldsError({ athlete_id: 'a', mark_id: 'm' }, REST_MARK_CLEAR_FIELDS)).toBeNull();
    expect(restMarkUnknownFieldsError({ athlete_id: 'a', mark_id: 'm', reason: 'x' }, REST_MARK_CLEAR_FIELDS)).not.toBeNull();
  });
});

describe('restMarkShapeError', () => {
  const ok = { kind: 'rest', firstDay: '2026-11-13', lastDay: TODAY };

  test('a week ending today is a valid mark, rest or away', () => {
    expect(restMarkShapeError(ok, TODAY)).toBeNull();
    expect(restMarkShapeError({ ...ok, kind: 'away' }, TODAY)).toBeNull();
    expect(restMarkShapeError({ ...ok, firstDay: TODAY }, TODAY)).toBeNull();
  });

  test.each([
    ['an unknown kind', { kind: 'sick' }, /kind must be one of: rest, away/],
    ['a missing kind', { kind: undefined }, /kind must be one of/],
    ['a non-date', { firstDay: 'next week' }, /must be dates/],
    ['an impossible date', { firstDay: '2026-02-30' }, /must be dates/],
    ['a timestamp, not a day', { lastDay: '2026-11-19T00:00:00Z' }, /must be dates/],
    ['a backwards range', { firstDay: TODAY, lastDay: '2026-11-18' }, /on or after first_day/],
  ])('refuses %s', (_label, change, message) => {
    expect(restMarkShapeError({ ...ok, ...change }, TODAY)).toMatch(message);
  });

  test(`a range covers at most ${REST_MARK_MAX_DAYS} days`, () => {
    expect(REST_MARK_MAX_DAYS).toBe(35);
    expect(restMarkShapeError({ kind: 'rest', firstDay: '2026-10-16', lastDay: TODAY }, TODAY)).toBeNull();
    expect(restMarkShapeError({ kind: 'rest', firstDay: '2026-10-15', lastDay: TODAY }, TODAY)).toMatch(/at most 35 days/);
  });

  test('a mark may start no earlier than the oldest day the load rule reads, and end at most 34 days ahead', () => {
    expect(restMarkShapeError({ kind: 'away', firstDay: '2026-10-16', lastDay: '2026-10-16' }, TODAY)).toBeNull();
    expect(restMarkShapeError({ kind: 'away', firstDay: '2026-10-15', lastDay: '2026-10-15' }, TODAY)).toMatch(/start at most 34 days ago/);
    expect(restMarkShapeError({ kind: 'away', firstDay: '2026-12-23', lastDay: '2026-12-23' }, TODAY)).toBeNull();
    expect(restMarkShapeError({ kind: 'away', firstDay: '2026-12-24', lastDay: '2026-12-24' }, TODAY)).toMatch(/end at most 34 days ahead/);
  });
});

describe('loadWeekWindows: the same 7-day buckets Rule 6 reads', () => {
  test('5 windows, newest first, week 0 ending today', () => {
    expect(loadWeekWindows(TODAY)).toEqual([
      { week_index: 0, first_day: '2026-11-13', last_day: '2026-11-19' },
      { week_index: 1, first_day: '2026-11-06', last_day: '2026-11-12' },
      { week_index: 2, first_day: '2026-10-30', last_day: '2026-11-05' },
      { week_index: 3, first_day: '2026-10-23', last_day: '2026-10-29' },
      { week_index: 4, first_day: '2026-10-16', last_day: '2026-10-22' },
    ]);
  });

  test("matches weeklySessionLoad.ts's SQL bucket ((today - date) / 7) for every day of the window", () => {
    const todayMs = Date.parse(`${TODAY}T00:00:00Z`);
    for (const window of loadWeekWindows(TODAY)) {
      for (let ms = Date.parse(`${window.first_day}T00:00:00Z`); ms <= Date.parse(`${window.last_day}T00:00:00Z`); ms += 86_400_000) {
        expect(Math.floor((todayMs - ms) / 86_400_000 / 7)).toBe(window.week_index);
      }
    }
  });

  test('crosses a month and a year boundary by calendar days, and refuses a non-day', () => {
    expect(loadWeekWindows('2027-01-02')[0]).toEqual({ week_index: 0, first_day: '2026-12-27', last_day: '2027-01-02' });
    expect(() => loadWeekWindows('2026-13-01')).toThrow(/Not a gym day/);
  });
});

describe("restMarkReadWindow: the strip reads from Rule 6's oldest day to the last day a mark may end", () => {
  test('34 days back and 34 days ahead, matching the shape limits', () => {
    expect(restMarkReadWindow(TODAY)).toEqual({ from_day: '2026-10-16', to_day: '2026-12-23' });
    expect(restMarkShapeError({ kind: 'away', firstDay: '2026-12-23', lastDay: '2026-12-23' }, TODAY)).toBeNull();
    expect(loadWeekWindows(TODAY)[4].first_day).toBe(restMarkReadWindow(TODAY).from_day);
  });
});

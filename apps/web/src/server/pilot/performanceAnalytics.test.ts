import {
  clampWindowDays,
  getPerformanceRollup,
  PERFORMANCE_WINDOW_DAYS_DEFAULT,
  PERFORMANCE_WINDOW_DAYS_MAX,
} from './performanceAnalytics';
import { query } from './db';

/**
 * THIS MODULE HAD NO TEST OF ITS OWN.
 *
 * Three files referenced it and none of them executed it: the route test
 * (`app/api/pilot/analytics/performance/route.test.ts`) mocks
 * `getPerformanceRollup` out, `coachIntelligence.test.ts` mocks the whole
 * module, and `progressionSuggestions.test.ts` imports only the row TYPE.
 * `gap-justification/route.test.ts` comes closest -- it lets the real module
 * run and feeds the db mock positionally -- but it inspects only
 * `mock.calls[0]`, which is progression's own query, and never looks at the
 * five this module issues.
 *
 * WHAT THAT LEFT UNGUARDED. `getPerformanceRollup` takes a caller-supplied
 * `athleteIds` array and trusts it; the ONLY tenancy boundary in the module is
 * `organization_id = $1`, repeated once in each of the five queries. Every
 * existing test would have stayed green with any one of those five predicates
 * deleted. Two of the five (`progression_gaps`, `drill_assignments`) carry no
 * date window either, so a scoping regression there would expose whole
 * history rather than a 28-day slice.
 *
 * So the org predicate is pinned per query, by SQL text and by bind
 * parameter, in the style `attendanceReporting.test.ts` established. Pinning
 * the parameter alone would not catch a predicate moved off the query it
 * belongs to; pinning the text alone would not catch the wrong value bound.
 *
 * Mocked-pool limits, stated rather than implied: this proves the SQL this
 * module SENDS. It does not prove what Postgres does with it. Real row-level
 * behaviour for the queries' date arithmetic is not covered here and is not
 * claimed.
 */
jest.mock('./db', () => ({ query: jest.fn() }));

const mockQuery = query as jest.Mock;

/** The five reads, in the order `Promise.all` issues them. */
const QUERIES = [
  { index: 0, name: 'sessions', table: 'pilot.sessions' },
  { index: 1, name: 'readiness', table: 'pilot.readiness' },
  { index: 2, name: 'training days', table: 'pilot.activity_log' },
  { index: 3, name: 'progression gaps', table: 'pilot.progression_gaps' },
  { index: 4, name: 'drill assignments', table: 'pilot.drill_assignments' },
] as const;

function resolveAllFiveEmpty() {
  mockQuery.mockResolvedValue([]);
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('the organization boundary, per query', () => {
  test.each(QUERIES)(
    'the $name read is scoped by organization_id and by athlete id',
    async ({ index, table }) => {
      resolveAllFiveEmpty();

      await getPerformanceRollup('org-1', ['ath-1'], 28);

      const [sql, params] = mockQuery.mock.calls[index];
      expect(sql).toContain(table);
      // Both halves of the boundary, in the query that carries them.
      expect(sql).toContain('organization_id = $1');
      expect(sql).toContain('athlete_id = any($2::text[])');
      // And bound to the caller's organization, not to anything else.
      expect(params[0]).toBe('org-1');
      expect(params[1]).toEqual(['ath-1']);
    },
  );

  test('every one of the five reads is issued, so none can be dropped silently', async () => {
    resolveAllFiveEmpty();

    await getPerformanceRollup('org-1', ['ath-1'], 28);

    expect(mockQuery).toHaveBeenCalledTimes(5);
  });

  test('the athlete id list is passed through exactly, not widened', async () => {
    resolveAllFiveEmpty();

    await getPerformanceRollup('org-1', ['ath-1', 'ath-2'], 28);

    for (const { index } of QUERIES) {
      expect(mockQuery.mock.calls[index][1][1]).toEqual(['ath-1', 'ath-2']);
    }
  });
});

describe('an empty roster', () => {
  /**
   * `athlete_id = any('{}')` matches nothing, so the five queries would be
   * five round trips to learn that. The module short-circuits instead, and
   * that is worth pinning: a regression here is silent extra load on every
   * coach with no athletes yet.
   */
  test('asks the database nothing at all', async () => {
    const rows = await getPerformanceRollup('org-1', [], 28);

    expect(rows).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('clampWindowDays', () => {
  /**
   * The route test exercises three of these branches incidentally, because
   * its http mock spreads `requireActual`. That coverage is real but it lives
   * in another file and would vanish the moment the route stopped calling
   * this function. The floor clamp and the empty-string branch were covered
   * nowhere.
   */
  test('an absent value is the default, not the floor', () => {
    expect(clampWindowDays(undefined)).toBe(PERFORMANCE_WINDOW_DAYS_DEFAULT);
    expect(clampWindowDays(null)).toBe(PERFORMANCE_WINDOW_DAYS_DEFAULT);
    // Number('') is 0, which would clamp to 1 rather than fall back.
    expect(clampWindowDays('')).toBe(PERFORMANCE_WINDOW_DAYS_DEFAULT);
  });

  test('a non-numeric value is the default', () => {
    expect(clampWindowDays('soon')).toBe(PERFORMANCE_WINDOW_DAYS_DEFAULT);
    expect(clampWindowDays(Number.NaN)).toBe(PERFORMANCE_WINDOW_DAYS_DEFAULT);
    expect(clampWindowDays(Number.POSITIVE_INFINITY)).toBe(PERFORMANCE_WINDOW_DAYS_DEFAULT);
  });

  test('the window is clamped at both ends', () => {
    expect(clampWindowDays(0)).toBe(1);
    expect(clampWindowDays(-30)).toBe(1);
    expect(clampWindowDays(99999)).toBe(PERFORMANCE_WINDOW_DAYS_MAX);
    expect(clampWindowDays(PERFORMANCE_WINDOW_DAYS_MAX)).toBe(PERFORMANCE_WINDOW_DAYS_MAX);
  });

  test('a fractional window is truncated to whole days', () => {
    expect(clampWindowDays(7.9)).toBe(7);
    expect(clampWindowDays('14.5')).toBe(14);
  });

  test('a numeric string is accepted, since it arrives from a query string', () => {
    expect(clampWindowDays('56')).toBe(56);
  });
});

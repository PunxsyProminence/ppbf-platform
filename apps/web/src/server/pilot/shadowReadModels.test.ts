import { query } from './db';
import { listShadowEvents, listShadowTelemetry, getShadowReviewProjection } from './shadowReadModels';
import type { ShadowReadContext } from './shadowReadModels';

jest.mock('./db', () => ({
  query: jest.fn(),
}));

const mockQuery = query as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function context(overrides: Partial<ShadowReadContext>): ShadowReadContext {
  return {
    organizationId: 'org-1',
    actorAccountId: 'acct-1',
    actorRole: 'coach',
    athleteId: null,
    ...overrides,
  };
}

describe('listShadowEvents athlete scoping', () => {
  test('athlete role restricts the query to their own athleteId only', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listShadowEvents(context({ actorRole: 'athlete', athleteId: 'ath-1' }));

    const params = mockQuery.mock.calls[0][1];
    const restrictToAthleteIds = params[8];
    const excludeAthleteScoped = params[9];
    expect(restrictToAthleteIds).toEqual(['ath-1']);
    expect(excludeAthleteScoped).toBe(false);
  });

  test('parent role restricts the query to their linked athletes, not the whole org', async () => {
    // First call: guardian_links lookup inside resolveAthleteScope.
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-linked-1' }, { athlete_id: 'ath-linked-2' }]);
    // Second call: the actual shadow_events query.
    mockQuery.mockResolvedValueOnce([]);

    await listShadowEvents(context({ actorRole: 'parent', actorAccountId: 'parent-acct-1' }));

    const guardianLinksCallParams = mockQuery.mock.calls[0][1];
    expect(guardianLinksCallParams).toEqual(['org-1', 'parent-acct-1']);

    const eventsCallParams = mockQuery.mock.calls[1][1];
    const restrictToAthleteIds = eventsCallParams[8];
    expect(restrictToAthleteIds).toEqual(['ath-linked-1', 'ath-linked-2']);
  });

  test('parent with no linked athletes gets a scope that matches nothing, not the whole org', async () => {
    mockQuery.mockResolvedValueOnce([]); // no guardian links found
    mockQuery.mockResolvedValueOnce([]);

    await listShadowEvents(context({ actorRole: 'parent' }));

    const eventsCallParams = mockQuery.mock.calls[1][1];
    expect(eventsCallParams[8]).toEqual(['__unbound_athlete__']);
  });

  test('volunteer role excludes all athlete-scoped rows instead of seeing every athlete in the org', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listShadowEvents(context({ actorRole: 'volunteer' }));

    const params = mockQuery.mock.calls[0][1];
    expect(params[8]).toBeNull(); // no explicit id list
    expect(params[9]).toBe(true); // but exclusion mode is on
  });

  test('coach/admin roles remain unrestricted (no regression from the fix)', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listShadowEvents(context({ actorRole: 'coach' }));

    const params = mockQuery.mock.calls[0][1];
    expect(params[8]).toBeNull();
    expect(params[9]).toBe(false);
  });
});

describe('listShadowTelemetry athlete scoping', () => {
  test('volunteer role excludes athlete-tied telemetry', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await listShadowTelemetry(context({ actorRole: 'volunteer' }));

    const params = mockQuery.mock.calls[0][1];
    expect(params[6]).toBeNull();
    expect(params[7]).toBe(true);
  });
});

describe('getShadowReviewProjection athlete scoping', () => {
  test('parent only sees review items for their linked athletes', async () => {
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-linked-1' }]); // guardian links
    mockQuery.mockResolvedValueOnce([]); // items query
    mockQuery.mockResolvedValueOnce([{ count: '0' }]); // total query

    await getShadowReviewProjection(context({ actorRole: 'parent', actorAccountId: 'parent-1' }));

    const itemsParams = mockQuery.mock.calls[1][1];
    const totalParams = mockQuery.mock.calls[2][1];
    expect(itemsParams[itemsParams.length - 1]).toEqual(['ath-linked-1']);
    expect(totalParams[totalParams.length - 1]).toEqual(['ath-linked-1']);
  });

  test('coach/admin remain unrestricted across the whole organization', async () => {
    mockQuery.mockResolvedValueOnce([]); // items query
    mockQuery.mockResolvedValueOnce([{ count: '0' }]); // total query

    await getShadowReviewProjection(context({ actorRole: 'coach' }));

    const itemsParams = mockQuery.mock.calls[0][1];
    expect(itemsParams[itemsParams.length - 1]).toBeNull();
  });
});

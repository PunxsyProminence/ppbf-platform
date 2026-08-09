import { query } from './db';
import { listShadowEvents, listShadowTelemetry, getShadowReviewProjection, getShadowObservationProjection } from './shadowReadModels';
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

describe('getShadowObservationProjection pain-report labels', () => {
  test('decodes a pain report event into a sentence instead of the raw constant', async () => {
    mockQuery.mockResolvedValueOnce([
      {
        shadow_event_id: 1,
        organization_id: 'org-1',
        event_name: 'SHADOW_ATHLETE_PAIN_REPORT_PENDING_REVIEW',
        entity_type: 'athlete',
        entity_id: 'ath-1',
        actor_account_id: 'ath-1',
        actor_role: 'athlete',
        payload: { athlete_id: 'ath-1', severity_1_10: 7, location: 'Hips', pain_type: 'Sharp' },
        created_at: '2026-08-01T00:00:00.000Z',
      },
    ]); // events query
    mockQuery.mockResolvedValueOnce([]); // telemetry query

    const items = await getShadowObservationProjection(context({ actorRole: 'coach' }));

    expect(items[0].label).toBe('Pain reported: Hips (Sharp), severity 7/10');
    expect(items[0].label).not.toBe('SHADOW_ATHLETE_PAIN_REPORT_PENDING_REVIEW');
  });

  test('missing location and pain type read as not stated, never invented', async () => {
    mockQuery.mockResolvedValueOnce([
      {
        shadow_event_id: 2,
        organization_id: 'org-1',
        event_name: 'SHADOW_ATHLETE_PAIN_REPORT_PENDING_REVIEW',
        entity_type: 'athlete',
        entity_id: 'ath-1',
        actor_account_id: 'ath-1',
        actor_role: 'athlete',
        payload: { athlete_id: 'ath-1', severity_1_10: 4, location: null, pain_type: null },
        created_at: '2026-08-01T00:00:00.000Z',
      },
    ]);
    mockQuery.mockResolvedValueOnce([]);

    const items = await getShadowObservationProjection(context({ actorRole: 'coach' }));

    expect(items[0].label).toBe('Pain reported: an unspecified location, severity 4/10');
  });

  test('a pain-report event with no severity in the payload falls back to the raw event name rather than guessing', async () => {
    mockQuery.mockResolvedValueOnce([
      {
        shadow_event_id: 3,
        organization_id: 'org-1',
        event_name: 'SHADOW_ATHLETE_PAIN_REPORT_PENDING_REVIEW',
        entity_type: 'athlete',
        entity_id: 'ath-1',
        actor_account_id: 'ath-1',
        actor_role: 'athlete',
        payload: {},
        created_at: '2026-08-01T00:00:00.000Z',
      },
    ]);
    mockQuery.mockResolvedValueOnce([]);

    const items = await getShadowObservationProjection(context({ actorRole: 'coach' }));

    expect(items[0].label).toBe('SHADOW_ATHLETE_PAIN_REPORT_PENDING_REVIEW');
  });

  test('an unrelated event still passes through as its raw name, unaffected by the new decoder', async () => {
    mockQuery.mockResolvedValueOnce([
      {
        shadow_event_id: 4,
        organization_id: 'org-1',
        event_name: 'SHADOW_INTAKE_DOCUMENT_UPLOADED',
        entity_type: 'intake_case',
        entity_id: 'case-1',
        actor_account_id: 'coach-1',
        actor_role: 'coach',
        payload: {},
        created_at: '2026-08-01T00:00:00.000Z',
      },
    ]);
    mockQuery.mockResolvedValueOnce([]);

    const items = await getShadowObservationProjection(context({ actorRole: 'coach' }));

    expect(items[0].label).toBe('SHADOW_INTAKE_DOCUMENT_UPLOADED');
  });
});


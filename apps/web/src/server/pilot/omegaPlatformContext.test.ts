jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('./boardSummary', () => ({ getBoardSummary: jest.fn() }));
jest.mock('./shadowMetrics', () => ({ getGrowthMetrics: jest.fn() }));

import {
  PLATFORM_ROLLUP_MAX_RENDERED_GYMS,
  clearPlatformRollupCache,
  formatPlatformRollup,
  getPlatformRollup,
  mentionsCrossOrganizationScope,
  type PlatformRollup,
} from './omegaPlatformContext';
import { getShadowChatCapabilities } from './shadowChatCapabilities';
import { getBoardSummary } from './boardSummary';
import { query } from './db';
import { getGrowthMetrics } from './shadowMetrics';
import type { PilotRole } from './contracts';

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockBoardSummary = getBoardSummary as jest.MockedFunction<typeof getBoardSummary>;
const mockGrowthMetrics = getGrowthMetrics as jest.MockedFunction<typeof getGrowthMetrics>;

function availableMetric(count: number) {
  return { status: 'available' as const, count };
}

function board(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'organization_aggregate' as const,
    minimumCohortSize: 5,
    generatedAt: '2026-07-28T00:00:00.000Z',
    activeAthletes: availableMetric(12),
    trainingSessions30Days: { ...availableMetric(40), completedCount: 30, completionRate: 0.75 },
    goalStatusBuckets: {
      active: availableMetric(6),
      completed: availableMetric(2),
      other: availableMetric(1),
    },
    coachReviews30Days: { ...availableMetric(9), approvedCount: 8, approvalRate: 0.888 },
    ...overrides,
  } as PlatformRollup['gyms'][number]['board'];
}

function growth(totalInteractions: number) {
  return {
    period: '30d',
    totalInteractions,
    avgSatisfaction: null,
    avgEffectiveness: null,
    recommendationsMade: 0,
    researchRequirementsCreated: 0,
    researchRequirementsClosed: 0,
    newLibraryPatterns: 0,
    filterRate: null,
    positiveOutcomeRate: null,
    unavailableReasons: {},
  } as PlatformRollup['gyms'][number]['growth'];
}

function rollup(gyms: PlatformRollup['gyms']): PlatformRollup {
  return { generatedAt: '2026-07-28T00:00:00.000Z', gymCount: gyms.length, gyms };
}

describe('cross-organization trigger', () => {
  test.each([
    'How are all the gyms doing this month?',
    'Compare the gyms on attendance',
    'Give me a platform-wide summary',
    'Which gym has the most active athletes?',
    'Show me every organization',
    'break it down gym-by-gym',
    'how do the other gyms compare',
    'across the platform, how is retention',
  ])('triggers on a genuinely cross-gym question: %s', (message) => {
    expect(mentionsCrossOrganizationScope(message)).toBe(true);
  });

  // The trigger must fail CLOSED: anything it does not recognize keeps the
  // single-organization behavior that shipped before this module existed.
  test.each([
    'How is my gym doing?',
    'What should I work on with this athlete?',
    'Summarize last week for me',
    'Is the gym growing?',
    '',
    '   ',
  ])('does not trigger on a single-gym or empty question: %p', (message) => {
    expect(mentionsCrossOrganizationScope(message)).toBe(false);
  });

  test('never triggers on a non-string message', () => {
    expect(mentionsCrossOrganizationScope(undefined)).toBe(false);
    expect(mentionsCrossOrganizationScope(null)).toBe(false);
    expect(mentionsCrossOrganizationScope(42)).toBe(false);
    expect(mentionsCrossOrganizationScope({ message: 'all the gyms' })).toBe(false);
  });
});

describe('only the Omega tier can reach cross-organization breadth', () => {
  test('platform_owner is the only role with crossOrganizationRead', () => {
    expect(getShadowChatCapabilities('platform_owner').crossOrganizationRead).toBe(true);

    const otherRoles: PilotRole[] = [
      'organization_admin', 'admin', 'coach', 'athlete', 'parent', 'board', 'volunteer', 'staff',
    ];
    for (const role of otherRoles) {
      expect(getShadowChatCapabilities(role).crossOrganizationRead).toBe(false);
    }
  });

  test('Omega is still denied protected health information', () => {
    expect(getShadowChatCapabilities('platform_owner').canAccessProtectedHealthInformation).toBe(false);
  });
});

describe('rendered platform context', () => {
  const sample = rollup([
    { organizationId: 'gym-a', organizationName: 'Alpha Boxing', status: 'active', board: board(), growth: growth(17) },
    {
      organizationId: 'gym-b',
      organizationName: 'Beta Club',
      status: 'active',
      board: board({ activeAthletes: { status: 'insufficient_data', count: null } }),
      growth: growth(3),
    },
    {
      organizationId: 'gym-c',
      organizationName: 'Gamma Gym',
      status: 'pending',
      board: board({ activeAthletes: { status: 'unavailable', count: null } }),
      growth: growth(0),
    },
  ]);

  test('names each gym and attributes its own figures', () => {
    const text = formatPlatformRollup(sample);
    expect(text).toContain('Alpha Boxing');
    expect(text).toContain('active athletes: 12');
    expect(text).toContain('SHADOW interactions (30d): 17');
    expect(text).toContain('across 3 gym(s)');
  });

  test('withheld metrics are never rendered as a number', () => {
    const text = formatPlatformRollup(sample);
    expect(text).toMatch(/Beta Club[^\n]*active athletes: withheld \(fewer than 5 athletes\)/);
    expect(text).toMatch(/Gamma Gym[^\n]*active athletes: none recorded/);
    expect(text).not.toContain('active athletes: null');
    expect(text).not.toContain('undefined');
  });

  test('instructs the model not to merge gyms or estimate withheld values', () => {
    const text = formatPlatformRollup(sample);
    expect(text).toContain('never merge them into a single gym');
    expect(text).toContain('must never be estimated');
  });

  // The payload is built only from aggregate counters. If a future change
  // introduced an identifier or free-text field into either source summary, this
  // is the test that should fail.
  test('carries no per-athlete, per-account, or free-text field', () => {
    // Asserted against the DATA rows only. The header deliberately names
    // medical/clearance/notes in order to instruct the model that they are out
    // of scope, so matching the whole block would fail on its own safety text.
    const dataRows = formatPlatformRollup(sample)
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .join('\n');

    expect(dataRows).not.toHaveLength(0);
    expect(dataRows).not.toMatch(/athlete_id|athleteId|account_id|accountId|full_name|\bnotes\b|clearance|medical/i);
  });

  test('an unavailable gym degrades to a named gap rather than breaking the rollup', () => {
    const text = formatPlatformRollup(rollup([
      { organizationId: 'gym-a', organizationName: 'Alpha Boxing', status: 'active', board: board(), growth: growth(5) },
      {
        organizationId: 'gym-x',
        organizationName: 'Broken Gym',
        status: 'active',
        board: null,
        growth: null,
        unavailableReason: 'BOARD_SUMMARY_UNAVAILABLE',
      },
    ]));
    expect(text).toContain('Alpha Boxing');
    expect(text).toContain('Broken Gym (active): summary unavailable for this gym');
  });

  test('renders nothing when the platform has no gyms', () => {
    expect(formatPlatformRollup(rollup([]))).toBe('');
  });

  test('reports the omitted count instead of silently truncating', () => {
    const many = Array.from({ length: PLATFORM_ROLLUP_MAX_RENDERED_GYMS + 3 }, (_, index) => ({
      organizationId: `gym-${index}`,
      organizationName: `Gym ${index}`,
      status: 'active',
      board: board(),
      growth: growth(1),
    }));
    const text = formatPlatformRollup(rollup(many));
    expect(text).toContain('3 further gym(s) not listed here');
    expect(text).not.toContain(`Gym ${PLATFORM_ROLLUP_MAX_RENDERED_GYMS + 2}:`);
  });
});

// The shared pg pool is max: 10 (getPool in db.ts) and every organization in
// the rollup costs two connections. An unbounded fan-out would hold 2N, so a
// handful of gyms would consume the whole pool and stall unrelated requests
// behind one Omega turn. These assert the ceiling rather than trusting it by
// inspection, because the failure mode is latency and would not show up as a
// test failure anywhere else.
describe('per-gym fan-out stays inside the connection pool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPlatformRollupCache();
  });

  function organizations(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      organization_id: `org-${index}`,
      organization_name: `Gym ${index}`,
      status: 'active',
    }));
  }

  /** Resolves after other already-queued microtasks, without real timers. */
  function tick(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  it('never exceeds six concurrent summary queries regardless of gym count', async () => {
    mockQuery.mockResolvedValue(organizations(25) as never);

    let inFlight = 0;
    let peakInFlight = 0;
    const track = async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await tick();
      inFlight -= 1;
      return null as never;
    };

    mockBoardSummary.mockImplementation(track);
    mockGrowthMetrics.mockImplementation(track);

    await getPlatformRollup(1000);

    // 3 organizations in flight, 2 queries each.
    expect(peakInFlight).toBeLessThanOrEqual(6);
    expect(mockBoardSummary).toHaveBeenCalledTimes(25);
    expect(mockGrowthMetrics).toHaveBeenCalledTimes(25);
  });

  it('returns every gym, in input order, despite the bound', async () => {
    mockQuery.mockResolvedValue(organizations(7) as never);
    mockBoardSummary.mockResolvedValue(null as never);
    mockGrowthMetrics.mockResolvedValue(null as never);

    const result = await getPlatformRollup(2000);

    expect(result.gymCount).toBe(7);
    expect(result.gyms.map((gym) => gym.organizationId)).toEqual([
      'org-0', 'org-1', 'org-2', 'org-3', 'org-4', 'org-5', 'org-6',
    ]);
  });

  it('isolates a failing gym instead of losing the whole rollup', async () => {
    mockQuery.mockResolvedValue(organizations(3) as never);
    mockBoardSummary.mockImplementation(async (organizationId: string) => {
      if (organizationId === 'org-1') throw new Error('boom');
      return null as never;
    });
    mockGrowthMetrics.mockResolvedValue(null as never);

    const result = await getPlatformRollup(3000);

    expect(result.gyms).toHaveLength(3);
    expect(result.gyms[1].unavailableReason).toBe('boom');
    expect(result.gyms[0].unavailableReason).toBeUndefined();
    expect(result.gyms[2].unavailableReason).toBeUndefined();
  });
});

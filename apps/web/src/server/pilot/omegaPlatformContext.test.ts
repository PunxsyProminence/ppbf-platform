jest.mock('./db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('./boardSummary', () => ({ getBoardSummary: jest.fn() }));
jest.mock('./shadowMetrics', () => ({ getGrowthMetrics: jest.fn() }));

import {
  PLATFORM_ROLLUP_MAX_GYMS,
  clearPlatformRollupCache,
  formatPlatformRollup,
  getPlatformRollup,
  mentionsCrossOrganizationScope,
  platformGymEvidenceId,
  platformRollupEvidenceIds,
  type PlatformRollup,
} from './omegaPlatformContext';
import { validateShadowResponse } from './shadowChat';
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
    reviewedOutcomes: 0,
    researchRequirementsCreated: 0,
    researchRequirementsClosed: 0,
    newLibraryPatterns: 0,
    filterRate: null,
    positiveOutcomeRate: null,
    unavailableReasons: {},
  } as PlatformRollup['gyms'][number]['growth'];
}

function rollup(gyms: PlatformRollup['gyms'], totalGymCount = gyms.length): PlatformRollup {
  return {
    generatedAt: '2026-07-28T00:00:00.000Z',
    gymCount: gyms.length,
    totalGymCount,
    gyms,
  };
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

// The bug these cover: validateShadowResponse discards any response stating a
// quantity ("12 athletes") unless it carries an authorized [E:<id>] citation.
// A cross-gym answer is nothing but quantities, so without citable ids the whole
// feature returned the safety placeholder. Module-level tests alone missed this;
// it only appears when the renderer and the validator are exercised together.
describe('rollup figures survive response validation', () => {
  const gymEvidenceId = platformGymEvidenceId('gym-a');

  test('derives a UUID the validator will accept', () => {
    expect(gymEvidenceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  test('is stable for the same organization and distinct across organizations', () => {
    expect(platformGymEvidenceId('gym-a')).toBe(gymEvidenceId);
    expect(platformGymEvidenceId('gym-b')).not.toBe(gymEvidenceId);
  });

  test('an uncited figure is still discarded -- the rule is intact', () => {
    const result = validateShadowResponse('Alpha Boxing has 12 athletes.', {
      allowedEvidenceIds: [gymEvidenceId],
    });
    expect(result.filtered).toBe(true);
    expect(result.reasons.join(' ')).toMatch(/quantitative claim/i);
  });

  test('the same figure passes once it cites the gym token', () => {
    const result = validateShadowResponse(
      `Alpha Boxing has 12 athletes [E:${gymEvidenceId}].`,
      { allowedEvidenceIds: [gymEvidenceId] },
    );
    expect(result.filtered).toBe(false);
    expect(result.citationIds).toContain(gymEvidenceId);
  });

  test('a token that was never authorized is rejected', () => {
    const result = validateShadowResponse(
      `Alpha Boxing has 12 athletes [E:${platformGymEvidenceId('gym-not-rendered')}].`,
      { allowedEvidenceIds: [gymEvidenceId] },
    );
    expect(result.filtered).toBe(true);
  });

  test('authorizes exactly the gyms the block renders, and no unrendered gym', () => {
    const many = Array.from({ length: PLATFORM_ROLLUP_MAX_GYMS + 2 }, (_, index) => ({
      organizationId: `gym-${index}`,
      organizationName: `Gym ${index}`,
      status: 'active',
      board: board(),
      growth: growth(1),
    }));
    const ids = platformRollupEvidenceIds(rollup(many));

    expect(ids).toHaveLength(PLATFORM_ROLLUP_MAX_GYMS);
    expect(ids).not.toContain(platformGymEvidenceId(`gym-${PLATFORM_ROLLUP_MAX_GYMS + 1}`));
  });

  test('a gym with no summary carries no token, so none is authorized', () => {
    const ids = platformRollupEvidenceIds(rollup([
      { organizationId: 'gym-a', organizationName: 'Alpha Boxing', status: 'active', board: board(), growth: growth(2) },
      { organizationId: 'gym-x', organizationName: 'Broken Gym', status: 'active', board: null, growth: null },
    ]));
    expect(ids).toEqual([gymEvidenceId]);
  });

  test('every rendered gym line carries its own token', () => {
    const text = formatPlatformRollup(rollup([
      { organizationId: 'gym-a', organizationName: 'Alpha Boxing', status: 'active', board: board(), growth: growth(4) },
    ]));
    expect(text).toContain(`[E:${gymEvidenceId}]`);
    expect(text).toContain('copy its token character for character');
  });
});

describe('fan-out cost control', () => {
  beforeEach(() => {
    clearPlatformRollupCache();
    mockQuery.mockReset();
    mockBoardSummary.mockReset();
    mockGrowthMetrics.mockReset();
  });

  function orgRows(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      organization_id: `gym-${index}`,
      organization_name: `Gym ${index}`,
      status: 'active',
      total_count: String(count),
    }));
  }

  test('concurrent misses share a single fan-out instead of each running their own', async () => {
    mockQuery.mockResolvedValue(orgRows(3) as never);
    mockBoardSummary.mockResolvedValue(board() as never);
    mockGrowthMetrics.mockResolvedValue(growth(1) as never);

    const [a, b, c] = await Promise.all([
      getPlatformRollup(1_000),
      getPlatformRollup(1_000),
      getPlatformRollup(1_000),
    ]);

    // One organization listing, and one board/growth pair per gym -- not three
    // times over, which is what an unshared fan-out would have cost.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockBoardSummary).toHaveBeenCalledTimes(3);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test('a resolved rollup is served from cache within the TTL', async () => {
    mockQuery.mockResolvedValue(orgRows(2) as never);
    mockBoardSummary.mockResolvedValue(board() as never);
    mockGrowthMetrics.mockResolvedValue(growth(1) as never);

    await getPlatformRollup(1_000);
    await getPlatformRollup(30_000);

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  // A rollup where nothing resolved describes a fault, not the platform.
  test('an all-degraded rollup is not cached, so the next turn retries', async () => {
    mockQuery.mockResolvedValue(orgRows(2) as never);
    mockBoardSummary.mockRejectedValue(new Error('BOARD_SUMMARY_UNAVAILABLE'));
    mockGrowthMetrics.mockRejectedValue(new Error('metrics down'));

    const first = await getPlatformRollup(1_000);
    expect(first.gyms.every((gym) => gym.board === null)).toBe(true);

    mockBoardSummary.mockResolvedValue(board() as never);
    mockGrowthMetrics.mockResolvedValue(growth(4) as never);

    const second = await getPlatformRollup(5_000);
    expect(second.gyms.every((gym) => gym.board !== null)).toBe(true);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  test('a partially degraded rollup still caches', async () => {
    mockQuery.mockResolvedValue(orgRows(2) as never);
    mockBoardSummary
      .mockResolvedValueOnce(board() as never)
      .mockRejectedValueOnce(new Error('one gym down'));
    mockGrowthMetrics.mockResolvedValue(growth(2) as never);

    await getPlatformRollup(1_000);
    await getPlatformRollup(20_000);

    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('a failed organization listing is not cached and does not wedge later turns', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db unreachable'));
    await expect(getPlatformRollup(1_000)).rejects.toThrow('db unreachable');

    mockQuery.mockResolvedValue(orgRows(1) as never);
    mockBoardSummary.mockResolvedValue(board() as never);
    mockGrowthMetrics.mockResolvedValue(growth(1) as never);

    const recovered = await getPlatformRollup(2_000);
    expect(recovered.gymCount).toBe(1);
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
    expect(text).toContain('Listing 3 of 3 organization(s) on record');
  });

  test('withheld metrics are never rendered as a number', () => {
    const text = formatPlatformRollup(sample);
    expect(text).toMatch(/Beta Club[^\n]*active athletes: withheld \(fewer than 5 active athletes\)/);
    expect(text).toMatch(/Gamma Gym[^\n]*active athletes: none recorded/);
    expect(text).not.toContain('active athletes: null');
    expect(text).not.toContain('undefined');
  });

  test('instructs the model not to merge gyms or estimate withheld values', () => {
    const text = formatPlatformRollup(sample);
    expect(text).toContain('never merge them into a single gym');
    expect(text).toContain('must never be estimated');
  });

  // The rows are pilot.organizations unfiltered, so the line count is not an
  // active-gym count. Claiming otherwise hands the platform owner an
  // authoritative wrong number about their own platform.
  // A live model copied the specimen UUID this block used to carry as an
  // illustration, citing it for gyms it wanted to attribute. It is structurally
  // valid but authorized for nothing, so validateShadowResponse discarded the
  // entire answer. Every UUID in the block must be a real, authorized token.
  test('carries no citable token beyond the authorized gym tokens', () => {
    const text = formatPlatformRollup(sample);
    const authorized = new Set(platformRollupEvidenceIds(sample));
    const emitted = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi) ?? [];

    expect(emitted.length).toBe(authorized.size);
    for (const token of emitted) {
      expect(authorized.has(token)).toBe(true);
    }
    expect(text).not.toContain('00000000-0000-5000-8000-000000000000');
  });

  // boardSummary suppresses each metric on the distinct athletes appearing in
  // THAT metric, not on the gym's headcount. Labelling all three "fewer than 5
  // athletes" told the platform owner a busy gym had almost no athletes whenever
  // a slow month put its session cohort under the floor.
  test('names the cohort each withheld metric actually gates on', () => {
    const quietMonth = rollup([{
      organizationId: 'gym-q',
      organizationName: 'Quiet Month Gym',
      status: 'active',
      board: board({
        activeAthletes: availableMetric(30),
        trainingSessions30Days: { status: 'insufficient_data', count: null, completedCount: null, completionRate: null },
        coachReviews30Days: { status: 'insufficient_data', count: null, approvedCount: null, approvalRate: null },
      }),
      growth: growth(11),
    }]);

    const text = formatPlatformRollup(quietMonth);
    expect(text).toContain('active athletes: 30');
    expect(text).toContain('training sessions (30d): withheld (fewer than 5 athletes trained in the period)');
    expect(text).toContain('coach reviews (30d): withheld (fewer than 5 athletes reviewed in the period)');
    // The old wording would have contradicted the headcount on the same line.
    expect(text).not.toContain('withheld (fewer than 5 athletes)');
  });

  test('does not present the listing as a roster of active member gyms', () => {
    const text = formatPlatformRollup(sample);
    expect(text).not.toContain('EVERY member gym');
    expect(text).toContain('not a roster of active member gyms');
    expect(text).toContain('Do not report the number of lines as the number of gyms');
    // Status is on the line itself, so a pending gym is never read as active.
    expect(text).toMatch(/- Gamma Gym \(pending\)/);
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
    const many = Array.from({ length: PLATFORM_ROLLUP_MAX_GYMS + 3 }, (_, index) => ({
      organizationId: `gym-${index}`,
      organizationName: `Gym ${index}`,
      status: 'active',
      board: board(),
      growth: growth(1),
    }));
    const text = formatPlatformRollup(rollup(many));
    expect(text).toContain('3 further organization(s) not listed here');
    expect(text).not.toContain(`Gym ${PLATFORM_ROLLUP_MAX_GYMS + 2}:`);
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

  function organizations(count: number, totalCount = count) {
    return Array.from({ length: count }, (_, index) => ({
      organization_id: `org-${index}`,
      organization_name: `Gym ${index}`,
      status: 'active',
      total_count: String(totalCount),
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

  // The cap has to bind in SQL, not only at render time. Slicing afterwards
  // still runs two queries per organization past the cap and discards both.
  it('bounds the organization listing itself rather than only the rendering', async () => {
    mockQuery.mockResolvedValue(organizations(2) as never);
    mockBoardSummary.mockResolvedValue(null as never);
    mockGrowthMetrics.mockResolvedValue(null as never);

    await getPlatformRollup(1000);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/limit \$1/i);
    expect(params).toEqual([PLATFORM_ROLLUP_MAX_GYMS]);
  });

  it('reports the platform total even though it only summarizes up to the cap', async () => {
    const beyondCap = PLATFORM_ROLLUP_MAX_GYMS + 12;
    // What the database returns under the LIMIT, with the window count of all.
    mockQuery.mockResolvedValue(organizations(PLATFORM_ROLLUP_MAX_GYMS, beyondCap) as never);
    mockBoardSummary.mockResolvedValue(null as never);
    mockGrowthMetrics.mockResolvedValue(null as never);

    const result = await getPlatformRollup(1000);

    expect(result.gymCount).toBe(PLATFORM_ROLLUP_MAX_GYMS);
    expect(result.totalGymCount).toBe(beyondCap);
    // Two per organization summarized -- not two per organization on record.
    expect(mockBoardSummary).toHaveBeenCalledTimes(PLATFORM_ROLLUP_MAX_GYMS);
    expect(formatPlatformRollup(result)).toContain('12 further organization(s) not listed here');
  });

  // A missing or nonsensical window count must not invent gyms that were never
  // listed, which would render a "further organizations" note for nothing.
  it('falls back to the rows in hand when the total is absent or too small', async () => {
    mockQuery.mockResolvedValue([
      { organization_id: 'org-0', organization_name: 'Gym 0', status: 'active', total_count: null },
      { organization_id: 'org-1', organization_name: 'Gym 1', status: 'active', total_count: null },
    ] as never);
    mockBoardSummary.mockResolvedValue(null as never);
    mockGrowthMetrics.mockResolvedValue(null as never);

    const result = await getPlatformRollup(1000);

    expect(result.totalGymCount).toBe(2);
    expect(formatPlatformRollup(result)).not.toContain('further organization(s)');
  });
});

// getGrowthMetrics applies no minimum-cohort suppression of its own, so the
// rollup must hold its figures to the same floor boardSummary enforces.
// Otherwise a withheld board metric and a published interaction count sit on
// the same line, describing the exact cohort the withholding just protected.
describe('small-gym suppression covers growth figures, not just board figures', () => {
  const smallGym = rollup([{
    organizationId: 'gym-tiny',
    organizationName: 'Tiny Gym',
    status: 'active',
    board: board({ activeAthletes: { status: 'insufficient_data', count: null } }),
    growth: growth(7),
  }]);

  test('withholds interaction volume when the gym is below the cohort floor', () => {
    const text = formatPlatformRollup(smallGym);
    expect(text).toContain('SHADOW interactions (30d): withheld (fewer than 5 active athletes)');
    expect(text).not.toContain('SHADOW interactions (30d): 7');
  });

  test('does not leak the count anywhere else in the rendered block', () => {
    expect(formatPlatformRollup(smallGym)).not.toMatch(/\b7\b/);
  });

  test('still reports interaction volume for a gym at or above the floor', () => {
    const text = formatPlatformRollup(rollup([{
      organizationId: 'gym-ok',
      organizationName: 'Normal Gym',
      status: 'active',
      board: board(),
      growth: growth(41),
    }]));
    expect(text).toContain('SHADOW interactions (30d): 41');
  });

  test('a gym with no records at all still reports rather than withholding', () => {
    const text = formatPlatformRollup(rollup([{
      organizationId: 'gym-empty',
      organizationName: 'Empty Gym',
      status: 'active',
      board: board({ activeAthletes: { status: 'unavailable', count: null } }),
      growth: growth(0),
    }]));
    expect(text).toContain('SHADOW interactions (30d): 0');
    expect(text).toContain('active athletes: none recorded');
  });
});

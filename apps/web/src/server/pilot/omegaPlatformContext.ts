// Cross-organization platform context for the Omega (platform_owner) chat tier.
//
// shadowRoleSets.ts states the doctrine: Omega is BROADER IN BREADTH but
// STRICTLY NARROWER IN DEPTH than an organization admin -- it reads operational
// and aggregate signal across organizations and must never reach protected
// health information, SafeSport content, or organization-private athlete
// records. This module is the breadth half, and nothing more.
//
// Two deliberate properties keep it inside the doctrine:
//
//   1. It composes ONLY getBoardSummary and getGrowthMetrics, both of which are
//      already used by the board and platform overview surfaces. Neither returns
//      an account id, athlete id, name, note, or any free text -- boardSummary's
//      own test asserts the serialized output matches no
//      /accountId|athleteId|full_name|notes|message|content/ and that its SQL
//      never selects those columns. No new SQL is introduced here.
//   2. It never takes an athlete id or account id as input, so there is no
//      parameter through which a per-athlete question could be smuggled in.
//
// It is NOT a general cross-organization read. It cannot reach another gym's
// SHADOW library, coach notes, medical/clearance state, conversations, or
// rosters -- only the aggregate counters below.

import { getBoardSummary, type BoardSummary } from './boardSummary';
import { query } from './db';
import { getGrowthMetrics, type GrowthMetrics } from './shadowMetrics';

// A platform owner asking "how is the platform doing" is answered from this
// rollup; anything narrower stays on the single-organization path. The trigger
// is deliberately a fixed pattern list rather than a model-inferred intent:
// it is auditable, costs nothing, and fails CLOSED -- an unmatched message
// produces exactly the behavior that shipped before this module existed.
const CROSS_ORGANIZATION_PATTERNS: readonly RegExp[] = [
  /\ball\s+(?:the\s+)?(?:gyms|orgs|organizations|clubs)\b/i,
  /\b(?:every|each)\s+(?:gym|org|organization|club)\b/i,
  /\bacross\s+(?:the\s+)?(?:gyms|orgs|organizations|clubs|platform|network)\b/i,
  /\b(?:platform|network)[-\s]?wide\b/i,
  /\bwhole\s+platform\b/i,
  /\bentire\s+(?:platform|network)\b/i,
  /\bcompare\s+(?:the\s+)?(?:gyms|orgs|organizations|clubs)\b/i,
  /\bwhich\s+(?:gym|org|organization|club)\b/i,
  /\bother\s+(?:gyms|orgs|organizations|clubs)\b/i,
  /\bgym[-\s]?by[-\s]?gym\b/i,
  /\bper[-\s]?gym\b/i,
];

export function mentionsCrossOrganizationScope(message: unknown): boolean {
  if (typeof message !== 'string' || !message.trim()) {
    return false;
  }
  return CROSS_ORGANIZATION_PATTERNS.some((pattern) => pattern.test(message));
}

export interface PlatformGymRollup {
  organizationId: string;
  organizationName: string;
  status: string;
  board: BoardSummary | null;
  growth: GrowthMetrics | null;
  unavailableReason?: string;
}

export interface PlatformRollup {
  generatedAt: string;
  gymCount: number;
  gyms: PlatformGymRollup[];
}

// Rendering more gyms than this would start crowding the model's context window
// on every triggered turn. The cap is reported in the rendered block rather than
// silently truncating, so a platform owner is never shown a partial rollup that
// reads as complete.
export const PLATFORM_ROLLUP_MAX_RENDERED_GYMS = 40;

interface OrganizationRow {
  organization_id: string;
  organization_name: string;
  status: string;
}

// The rollup is identical for every caller -- it is whole-platform aggregate
// data with nothing account-scoped or organization-scoped in it -- so a single
// process-local memo is safe and cannot leak one caller's context to another.
// Only a platform_owner can ever trigger a read (see the crossOrganizationRead
// check at the call site), and the TTL is short so figures stay current within
// a conversation. Mirrors the existing 5-minute memo in shadowChat.ts.
const ROLLUP_TTL_MS = 60_000;
let memo: { at: number; value: PlatformRollup } | null = null;

/**
 * Ceiling on how many organizations are summarized at once.
 *
 * Each organization costs two concurrent connections (board + growth), and the
 * shared pool is max: 10 (see getPool in db.ts). An unbounded fan-out over N
 * organizations therefore holds 2N connections, so five gyms alone consumes the
 * entire pool and every other in-flight request -- athlete check-ins, coach
 * reviews, session lookups -- queues behind a single Omega turn. pg queues
 * rather than rejecting and the pool sets no connectionTimeoutMillis, so this
 * degrades as unexplained latency instead of a visible error.
 *
 * Three gyms in flight is six connections, leaving headroom for the rest of the
 * application while still overlapping most of the wait.
 */
const GYM_ROLLUP_CONCURRENCY = 3;

/**
 * Bounded-concurrency map that preserves input order.
 *
 * Deliberately not Promise.all with a chunked loop: chunking stalls on the
 * slowest member of each batch, whereas a shared cursor starts the next
 * organization the moment any worker frees a connection.
 */
async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  limit: number,
  mapper: (item: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<TOutput>(items.length);
  let cursor = 0;

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await mapper(items[index]);
      }
    }),
  );

  return results;
}

export function clearPlatformRollupCache(): void {
  memo = null;
}

export async function getPlatformRollup(nowMs: number = Date.now()): Promise<PlatformRollup> {
  if (memo && nowMs - memo.at < ROLLUP_TTL_MS) {
    return memo.value;
  }

  const organizations = await query<OrganizationRow>(
    `select organization_id, organization_name, status
     from pilot.organizations
     order by organization_name asc`,
  );

  // Per-organization isolation, same as platform/overview: one gym whose
  // aggregate query fails degrades to a named gap in the rollup rather than
  // failing the whole SHADOW turn.
  const gyms = await mapWithConcurrency(
    organizations,
    GYM_ROLLUP_CONCURRENCY,
    async (org): Promise<PlatformGymRollup> => {
      try {
        const [board, growth] = await Promise.all([
          getBoardSummary(org.organization_id),
          getGrowthMetrics(org.organization_id),
        ]);
        return {
          organizationId: org.organization_id,
          organizationName: org.organization_name,
          status: org.status,
          board,
          growth,
        };
      } catch (error) {
        return {
          organizationId: org.organization_id,
          organizationName: org.organization_name,
          status: org.status,
          board: null,
          growth: null,
          unavailableReason: error instanceof Error ? error.message : 'summary unavailable',
        };
      }
    },
  );

  const value: PlatformRollup = {
    generatedAt: new Date(nowMs).toISOString(),
    gymCount: gyms.length,
    gyms,
  };
  memo = { at: nowMs, value };
  return value;
}

// boardSummary nulls every numeric field when a metric is not reportable, and
// distinguishes 'insufficient_data' (fewer than the minimum cohort) from
// 'unavailable' (no records at all). That distinction is preserved here at the
// platform owner's explicit request: it separates a brand-new empty gym from a
// small active one, which is operationally meaningful to them. It does mean a
// gym below the cohort floor is identifiable AS below the floor, without ever
// exposing the underlying count.
function renderMetric(
  label: string,
  metric: { status: string; count: number | null } | undefined,
  minimumCohortSize: number,
): string {
  if (!metric) {
    return `${label}: not reported`;
  }
  if (metric.status === 'available') {
    return `${label}: ${metric.count}`;
  }
  if (metric.status === 'insufficient_data') {
    return `${label}: withheld (fewer than ${minimumCohortSize} athletes)`;
  }
  return `${label}: none recorded`;
}

export function formatPlatformRollup(rollup: PlatformRollup): string {
  if (rollup.gymCount === 0) {
    return '';
  }

  const rendered = rollup.gyms.slice(0, PLATFORM_ROLLUP_MAX_RENDERED_GYMS);
  const omitted = rollup.gymCount - rendered.length;

  const lines = rendered.map((gym) => {
    if (!gym.board) {
      return `- ${gym.organizationName} (${gym.status}): summary unavailable for this gym`;
    }
    const cohort = gym.board.minimumCohortSize;
    const parts = [
      renderMetric('active athletes', gym.board.activeAthletes, cohort),
      renderMetric('training sessions (30d)', gym.board.trainingSessions30Days, cohort),
      renderMetric('coach reviews (30d)', gym.board.coachReviews30Days, cohort),
      `SHADOW interactions (30d): ${gym.growth ? gym.growth.totalInteractions : 'not reported'}`,
    ];
    return `- ${gym.organizationName} (${gym.status}): ${parts.join('; ')}`;
  });

  return [
    '## PLATFORM-WIDE CONTEXT (OMEGA SCOPE)',
    // The base system prompt frames SHADOW as one specific gym's intelligence
    // system. These figures span every member gym, so the framing is corrected
    // here rather than in the shared prompt, which would alter every other
    // role's turn.
    'These figures cover EVERY member gym on the platform, not only the gym named in the persona above. Attribute each number to the gym it is listed under and never merge them into a single gym.',
    'Aggregate operational counters only. Per-athlete records, medical or clearance status, coach notes, and any other organization-private content are NOT included and are not available at this scope. A withheld metric must never be estimated or filled in.',
    `Generated ${rollup.generatedAt} across ${rollup.gymCount} gym(s).`,
    '',
    ...lines,
    ...(omitted > 0
      ? ['', `(${omitted} further gym(s) not listed here; ask about a specific gym for its detail.)`]
      : []),
  ].join('\n');
}

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

import crypto from 'node:crypto';

import { getBoardSummary, type BoardSummary } from './boardSummary';
import { query } from './db';
import { getGrowthMetrics, type GrowthMetrics } from './shadowMetrics';

/**
 * Namespace for deriving a gym's platform-evidence id.
 *
 * validateShadowResponse discards any response that states a quantity without
 * an authorized [E:<id>] citation, and it accepts only v1-5 UUIDs carrying the
 * RFC 4122 variant. Rollup figures are real server-owned data, so rather than
 * exempting them from that rule -- which would weaken the same check that stops
 * an uncited clinical claim -- each gym gets a citable id and the model is told
 * to cite it. The figures become auditable instead of merely permitted.
 *
 * Derivation is deterministic from organization_id so a gym's id is stable
 * across turns, processes, and replicas.
 */
const PLATFORM_EVIDENCE_NAMESPACE = '6f3d1c92-8a41-4b7e-9c05-2d8f1e4a7b63';

export function platformGymEvidenceId(organizationId: string): string {
  const namespaceBytes = Buffer.from(PLATFORM_EVIDENCE_NAMESPACE.replaceAll('-', ''), 'hex');
  const digest = crypto
    .createHash('sha1')
    .update(namespaceBytes)
    .update(Buffer.from(organizationId, 'utf8'))
    .digest();

  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

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
  /** Organizations actually summarized -- at most PLATFORM_ROLLUP_MAX_GYMS. */
  gymCount: number;
  /** Organizations on the platform, including any beyond the cap. */
  totalGymCount: number;
  gyms: PlatformGymRollup[];
}

// Summarizing more organizations than this would both crowd the model's context
// window on every triggered turn and pay for per-gym queries whose output is
// discarded. The cap bounds the fan-out and the rendering together, and the
// remainder is reported in the block rather than silently truncated, so a
// platform owner is never shown a partial rollup that reads as complete.
export const PLATFORM_ROLLUP_MAX_GYMS = 40;

interface OrganizationRow {
  organization_id: string;
  organization_name: string;
  status: string;
  // count(*) over () is evaluated before LIMIT, so this carries the full
  // platform total on every returned row. pg returns bigint as a string.
  total_count: string | number | null;
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
 * Shared in-flight rollup, so concurrent misses cost one fan-out rather than N.
 *
 * The memo is only written once a fan-out resolves, so without this every
 * request arriving during the first one starts its own. The chat rate limit
 * allows 20 requests per minute per account, and a slow turn invites exactly the
 * retries and duplicate tabs that would stack those fan-outs onto the same
 * 10-connection pool.
 */
let inFlight: Promise<PlatformRollup> | null = null;

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
  inFlight = null;
}

export async function getPlatformRollup(nowMs: number = Date.now()): Promise<PlatformRollup> {
  if (memo && nowMs - memo.at < ROLLUP_TTL_MS) {
    return memo.value;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = buildPlatformRollup(nowMs).finally(() => {
    inFlight = null;
  });

  return inFlight;
}

async function buildPlatformRollup(nowMs: number): Promise<PlatformRollup> {
  // LIMIT here, not only at render time: without it the fan-out below runs two
  // queries for every organization on the platform and then throws away the
  // ones past the cap. The window count keeps the "further organizations not
  // listed" note honest now that the rows themselves are truncated.
  const organizations = await query<OrganizationRow>(
    `select organization_id, organization_name, status,
            count(*) over () as total_count
     from pilot.organizations
     order by organization_name asc
     limit $1`,
    [PLATFORM_ROLLUP_MAX_GYMS],
  );

  const reportedTotal = Number(organizations[0]?.total_count);
  const totalGymCount = Number.isFinite(reportedTotal) && reportedTotal >= organizations.length
    ? reportedTotal
    : organizations.length;

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
    totalGymCount,
    gyms,
  };

  // A rollup in which nothing resolved is a symptom of a transient fault -- the
  // database briefly unreachable, a missing table -- not a description of the
  // platform. Caching it would hold that fault in place for the full TTL and
  // answer a minute of questions with an all-degraded picture. Successes and
  // partial successes cache normally.
  const anyGymResolved = gyms.some((gym) => gym.board !== null);
  if (gyms.length === 0 || anyGymResolved) {
    memo = { at: nowMs, value };
  }

  return value;
}

// boardSummary nulls every numeric field when a metric is not reportable, and
// distinguishes 'insufficient_data' (fewer than the minimum cohort) from
// 'unavailable' (no records at all). That distinction is preserved here at the
// platform owner's explicit request: it separates a brand-new empty gym from a
// small active one, which is operationally meaningful to them. It does mean a
// gym below the cohort floor is identifiable AS below the floor, without ever
// exposing the underlying count.
//
// cohortDescription must name the cohort THIS metric gates on. boardSummary
// suppresses each metric on the distinct athletes appearing in that metric
// (session_athlete_count, review_athlete_count -- see its aggregateStatus
// callers), not on the gym's athlete headcount. A single "fewer than 5 athletes"
// label therefore told the model a 30-gym club with four athletes training that
// month had fewer than five athletes, and the model has no way to know better.
function renderMetric(
  label: string,
  metric: { status: string; count: number | null } | undefined,
  minimumCohortSize: number,
  cohortDescription: string,
): string {
  if (!metric) {
    return `${label}: not reported`;
  }
  if (metric.status === 'available') {
    return `${label}: ${metric.count}`;
  }
  if (metric.status === 'insufficient_data') {
    return `${label}: withheld (fewer than ${minimumCohortSize} ${cohortDescription})`;
  }
  return `${label}: none recorded`;
}

/**
 * SHADOW interaction volume, held to the same cohort floor as the board metrics.
 *
 * getGrowthMetrics applies no minimum-cohort suppression of its own -- that
 * suppression lives entirely in boardSummary (BOARD_MINIMUM_COHORT_SIZE).
 * Rendering its raw count next to a withheld board metric published exactly the
 * cohort the line above it had just refused to describe: a two-athlete gym read
 * as "active athletes: withheld (fewer than 5 athletes); SHADOW interactions
 * (30d): 7". Omega is the tier where that matters most, because it sets small
 * gyms side by side for comparison.
 *
 * activeAthletes is the right gate: it is the participant count the board
 * summary itself suppresses on, so the two stay consistent by construction
 * rather than by a second threshold that could drift.
 */
function renderInteractions(
  gym: PlatformGymRollup,
  minimumCohortSize: number,
): string {
  const label = 'SHADOW interactions (30d)';
  if (!gym.growth) {
    return `${label}: not reported`;
  }
  if (gym.board?.activeAthletes?.status === 'insufficient_data') {
    return `${label}: withheld (fewer than ${minimumCohortSize} active athletes)`;
  }
  return `${label}: ${gym.growth.totalInteractions}`;
}

/**
 * The evidence ids the rendered block actually carries, for the caller to add to
 * validateShadowResponse's allowed set.
 *
 * Sliced identically to formatPlatformRollup: a gym that is not rendered has no
 * token in the prompt, so authorizing its id would let the model cite a figure
 * it was never shown.
 */
export function platformRollupEvidenceIds(rollup: PlatformRollup): string[] {
  return rollup.gyms
    .slice(0, PLATFORM_ROLLUP_MAX_GYMS)
    .filter((gym) => gym.board)
    .map((gym) => platformGymEvidenceId(gym.organizationId));
}

/**
 * Stands in for the rollup when a cross-organization question was asked and the
 * rollup could not be produced.
 *
 * Omitting the block instead leaves the model answering a cross-gym question
 * from the single-gym persona in the base prompt, with nothing marking the
 * absence -- and the platform owner reads that as a real platform answer. A
 * named gap can be retried; a confident wrong answer gets acted on. Carries no
 * figures of its own, so it cannot trip response validation.
 */
export const PLATFORM_SCOPE_UNAVAILABLE_CONTEXT = [
  '## PLATFORM-WIDE CONTEXT (OMEGA SCOPE): UNAVAILABLE',
  'This question spans more than one organization, but the platform-wide figures could not be read for this turn.',
  'State plainly that the cross-organization data is unavailable right now and that this question cannot be answered from it. Do NOT substitute this gym\'s own figures for platform figures, do not estimate, and do not describe any other organization. Offer to retry, or to answer about one named gym instead.',
].join('\n');

export function formatPlatformRollup(rollup: PlatformRollup): string {
  if (rollup.gyms.length === 0) {
    return '';
  }

  // buildPlatformRollup already limits the fan-out to the cap, so this slice is
  // a floor under a hand-built or future caller's rollup, not the primary bound.
  const rendered = rollup.gyms.slice(0, PLATFORM_ROLLUP_MAX_GYMS);
  const omitted = Math.max(0, rollup.totalGymCount - rendered.length);

  const lines = rendered.map((gym) => {
    if (!gym.board) {
      return `- ${gym.organizationName} (${gym.status}): summary unavailable for this gym`;
    }
    const cohort = gym.board.minimumCohortSize;
    const parts = [
      renderMetric('active athletes', gym.board.activeAthletes, cohort, 'active athletes'),
      renderMetric('training sessions (30d)', gym.board.trainingSessions30Days, cohort, 'athletes trained in the period'),
      renderMetric('coach reviews (30d)', gym.board.coachReviews30Days, cohort, 'athletes reviewed in the period'),
      renderInteractions(gym, cohort),
    ];
    return `- ${gym.organizationName} (${gym.status}): ${parts.join('; ')} [E:${platformGymEvidenceId(gym.organizationId)}]`;
  });

  return [
    '## PLATFORM-WIDE CONTEXT (OMEGA SCOPE)',
    // The base system prompt frames SHADOW as one specific gym's intelligence
    // system. These figures span many organizations, so the framing is
    // corrected here rather than in the shared prompt, which would alter every
    // other role's turn.
    'These figures cover multiple organizations on the platform, not only the gym named in the persona above. Attribute each number to the organization it is listed under and never merge them into a single gym.',
    // The rows are pilot.organizations, unfiltered: the platform's own root
    // organization is in there, as is anything pending, inactive, or suspended.
    // Left unsaid, the model reads the line count as an authoritative active-gym
    // count and reports it that way to the one person who would act on it.
    'Each line ends its name with that organization\'s status in parentheses. The list is every organization on record -- including the platform\'s own root organization and any that is pending, inactive, or suspended -- so it is not a roster of active member gyms. Do not report the number of lines as the number of gyms.',
    'Aggregate operational counters only. Per-athlete records, medical or clearance status, coach notes, and any other organization-private content are NOT included and are not available at this scope. A withheld metric must never be estimated or filled in.',
    // Response validation discards any stated quantity that is not backed by an
    // authorized citation. These figures are server-owned and citable, so the
    // model is told how to cite them rather than the rule being relaxed.
    'Each gym line below ends with that gym\'s evidence token. Whenever you state one of its figures, cite that gym\'s token verbatim, for example [E:00000000-0000-5000-8000-000000000000]. A figure stated without its token is discarded before it reaches the reader.',
    `Generated ${rollup.generatedAt}. Listing ${rendered.length} of ${rollup.totalGymCount} organization(s) on record.`,
    '',
    ...lines,
    ...(omitted > 0
      ? ['', `(${omitted} further organization(s) not listed here; ask about a specific gym for its detail.)`]
      : []),
  ].join('\n');
}

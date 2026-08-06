import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { BOARD_MINIMUM_COHORT_SIZE, boardCountMetric, type BoardCountMetric } from './boardSummary';
import { query, queryOne, withTransaction } from './db';

/**
 * Red Flag Escalation ladder (capability #194) -- the pull-based surface
 * that puts a near miss, pain report, or safety-gate flag in front of a
 * human without them needing to already know where to look. There is no
 * notification channel in this platform (no email, ever), so this table and
 * the /admin/escalations page that reads it ARE the escalation mechanism.
 *
 * Deliberately NOT unified with pilot.compliance_violations /
 * violation_escalations -- that system already works and has its own UI.
 * This module owns near-miss-shaped signal only (near_miss, pain_report,
 * safety_gate_evaluation, repeated_pattern); whether to eventually merge
 * the two is a real product question left open.
 */

export type SafetyEscalationSeverity = 'low' | 'moderate' | 'high' | 'critical';
export type SafetyEscalationSourceType = 'near_miss' | 'pain_report' | 'safety_gate_evaluation' | 'repeated_pattern';
export type SafetyEscalationStatus = 'open' | 'acknowledged' | 'resolved';
/** Who an escalation is filed against. Deliberately excludes 'board' -- see the migration header for why. */
export type SafetyEscalationTargetRole = 'coach' | 'organization_admin' | 'admin';

export interface SafetyEscalationRow {
  escalation_id: string;
  source_type: SafetyEscalationSourceType;
  source_id: string | null;
  athlete_id: string;
  severity: SafetyEscalationSeverity;
  reason: string;
  escalated_to_role: SafetyEscalationTargetRole;
  triggered_by: 'system' | 'human';
  triggered_by_account_id: string | null;
  triggered_by_role: string | null;
  status: SafetyEscalationStatus;
  acknowledged_by_account_id: string | null;
  acknowledged_at: string | null;
  resolved_by_account_id: string | null;
  resolved_at: string | null;
  resolution_note: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface FileEscalationInput {
  organizationId: string;
  sourceType: SafetyEscalationSourceType;
  sourceId?: string | null;
  athleteId: string;
  severity: SafetyEscalationSeverity;
  reason: string;
  /** Defaults to 'organization_admin' -- the safety-critical default, so an
   * org admin always sees a system-filed escalation even if the athlete's
   * coach has not acted on it yet. */
  escalatedToRole?: SafetyEscalationTargetRole;
  triggeredBy: 'system' | 'human';
  triggeredByAccountId?: string | null;
  triggeredByRole?: string | null;
  metadata?: Record<string, unknown>;
}

async function insertEscalation(
  execute: (text: string, values: unknown[]) => Promise<unknown>,
  input: FileEscalationInput,
): Promise<SafetyEscalationRow> {
  const escalationId = randomUUID();
  const escalatedToRole = input.escalatedToRole ?? 'organization_admin';

  await execute(
    `insert into pilot.safety_escalations (
       organization_id, escalation_id, source_type, source_id, athlete_id,
       severity, reason, escalated_to_role,
       triggered_by, triggered_by_account_id, triggered_by_role,
       metadata
     ) values (
       $1,$2,$3,$4,$5,
       $6,$7,$8,
       $9,$10,$11,
       $12::jsonb
     )`,
    [
      input.organizationId,
      escalationId,
      input.sourceType,
      input.sourceId ?? null,
      input.athleteId,
      input.severity,
      input.reason,
      escalatedToRole,
      input.triggeredBy,
      input.triggeredByAccountId ?? null,
      input.triggeredByRole ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  const now = new Date().toISOString();
  return {
    escalation_id: escalationId,
    source_type: input.sourceType,
    source_id: input.sourceId ?? null,
    athlete_id: input.athleteId,
    severity: input.severity,
    reason: input.reason,
    escalated_to_role: escalatedToRole,
    triggered_by: input.triggeredBy,
    triggered_by_account_id: input.triggeredByAccountId ?? null,
    triggered_by_role: input.triggeredByRole ?? null,
    status: 'open',
    acknowledged_by_account_id: null,
    acknowledged_at: null,
    resolved_by_account_id: null,
    resolved_at: null,
    resolution_note: '',
    metadata: input.metadata ?? {},
    created_at: now,
    updated_at: now,
  };
}

/**
 * Files one escalation. Accepts an optional client so a caller (e.g.
 * shadowNearMisses.ts's flagNearMiss) can make filing part of the same
 * transaction that wrote the near miss it is escalating -- a near miss
 * severe enough to escalate should never commit without its escalation, or
 * vice versa.
 */
export async function fileEscalation(input: FileEscalationInput, client?: PoolClient): Promise<SafetyEscalationRow> {
  if (client) {
    return insertEscalation((text, values) => client.query(text, values), input);
  }
  return withTransaction(async (transactionClient) => insertEscalation(
    (text, values) => transactionClient.query(text, values),
    input,
  ));
}

/**
 * Near-miss severities that automatically escalate. 'low' and 'moderate'
 * near misses stay pull-only on their existing surfaces (the decision-loop
 * page, the pain-reports route) -- escalating every near miss would bury
 * the ladder in noise and defeat the point of having one.
 */
export function shouldAutoEscalateNearMiss(severity: SafetyEscalationSeverity): boolean {
  return severity === 'high' || severity === 'critical';
}

export interface EscalationListFilters {
  status?: SafetyEscalationStatus;
  athleteIds?: string[];
}

/** Org-wide list, newest first. Callers scope by athleteIds for a coach; omit it for org_admin/admin. */
export async function listEscalations(
  organizationId: string,
  filters: EscalationListFilters = {},
): Promise<SafetyEscalationRow[]> {
  return query<SafetyEscalationRow>(
    `select escalation_id, source_type, source_id, athlete_id, severity, reason,
            escalated_to_role, triggered_by, triggered_by_account_id, triggered_by_role,
            status, acknowledged_by_account_id, acknowledged_at::text,
            resolved_by_account_id, resolved_at::text, resolution_note, metadata,
            created_at::text, updated_at::text
     from pilot.safety_escalations
     where organization_id = $1
       and ($2::text is null or status = $2)
       and ($3::text[] is null or athlete_id = any($3))
     order by
       case severity when 'critical' then 0 when 'high' then 1 when 'moderate' then 2 else 3 end asc,
       created_at desc`,
    [organizationId, filters.status ?? null, filters.athleteIds ?? null],
  );
}

async function transitionEscalation(
  organizationId: string,
  escalationId: string,
  input: {
    status: 'acknowledged' | 'resolved';
    accountId: string;
    resolutionNote?: string;
  },
): Promise<SafetyEscalationRow | null> {
  const columns = input.status === 'acknowledged'
    ? `status = 'acknowledged', acknowledged_by_account_id = $3, acknowledged_at = now(), updated_at = now()`
    : `status = 'resolved', resolved_by_account_id = $3, resolved_at = now(), resolution_note = coalesce($4, resolution_note), updated_at = now()`;

  return queryOne<SafetyEscalationRow>(
    `update pilot.safety_escalations
     set ${columns}
     where organization_id = $1 and escalation_id = $2
     returning escalation_id, source_type, source_id, athlete_id, severity, reason,
               escalated_to_role, triggered_by, triggered_by_account_id, triggered_by_role,
               status, acknowledged_by_account_id, acknowledged_at::text,
               resolved_by_account_id, resolved_at::text, resolution_note, metadata,
               created_at::text, updated_at::text`,
    input.status === 'acknowledged'
      ? [organizationId, escalationId, input.accountId]
      : [organizationId, escalationId, input.accountId, input.resolutionNote ?? null],
  );
}

export async function acknowledgeEscalation(
  organizationId: string,
  escalationId: string,
  accountId: string,
): Promise<SafetyEscalationRow | null> {
  return transitionEscalation(organizationId, escalationId, { status: 'acknowledged', accountId });
}

export async function resolveEscalation(
  organizationId: string,
  escalationId: string,
  accountId: string,
  resolutionNote: string,
): Promise<SafetyEscalationRow | null> {
  return transitionEscalation(organizationId, escalationId, { status: 'resolved', accountId, resolutionNote });
}

const DEFAULT_PATTERN_WINDOW_DAYS = 30;
const DEFAULT_PATTERN_THRESHOLD = 3;

interface PatternCandidateRow {
  athlete_id: string;
  trigger_key: string;
  occurrence_count: string | number;
  max_severity: SafetyEscalationSeverity;
}

/**
 * The doctrine's own example: "this athlete keeps asking about weight
 * cutting" is a pattern across several individually-unremarkable near
 * misses, not one event severe enough to escalate on its own. Groups
 * pilot.shadow_near_misses by athlete + metadata->>'trigger' (the marker
 * both contactClearanceGate.ts and painReportAlert.ts already write) within
 * a lookback window, and files a 'repeated_pattern' escalation for any
 * athlete/trigger pair that crosses the threshold and does not already have
 * an open one.
 *
 * Idempotency is a query-then-insert check, not a database constraint --
 * this runs on-demand (an admin action), not on a hot write path, so the
 * small race window between the check and the insert is an accepted
 * tradeoff rather than one worth a partial unique index for.
 */
export async function detectRepeatedPatternEscalations(
  organizationId: string,
  options: { windowDays?: number; threshold?: number } = {},
): Promise<SafetyEscalationRow[]> {
  const windowDays = Math.min(365, Math.max(1, Math.trunc(options.windowDays ?? DEFAULT_PATTERN_WINDOW_DAYS)));
  const threshold = Math.max(2, Math.trunc(options.threshold ?? DEFAULT_PATTERN_THRESHOLD));

  const candidates = await query<PatternCandidateRow>(
    `select
       athlete_id,
       coalesce(metadata->>'trigger', 'unspecified') as trigger_key,
       count(*) as occurrence_count,
       (array_agg(severity order by
         case severity when 'critical' then 0 when 'high' then 1 when 'moderate' then 2 else 3 end
       ))[1] as max_severity
     from pilot.shadow_near_misses
     where organization_id = $1
       and created_at > now() - ($2 * interval '1 day')
     group by athlete_id, coalesce(metadata->>'trigger', 'unspecified')
     having count(*) >= $3`,
    [organizationId, windowDays, threshold],
  );

  const filed: SafetyEscalationRow[] = [];
  for (const candidate of candidates) {
    const existingOpen = await queryOne<{ escalation_id: string }>(
      `select escalation_id from pilot.safety_escalations
       where organization_id = $1
         and athlete_id = $2
         and source_type = 'repeated_pattern'
         and status = 'open'
         and metadata->>'trigger_key' = $3
       limit 1`,
      [organizationId, candidate.athlete_id, candidate.trigger_key],
    );
    if (existingOpen) continue;

    const occurrenceCount = Number(candidate.occurrence_count);
    const escalation = await fileEscalation({
      organizationId,
      sourceType: 'repeated_pattern',
      sourceId: null,
      athleteId: candidate.athlete_id,
      severity: candidate.max_severity,
      reason: `Triggered '${candidate.trigger_key}' ${occurrenceCount} times in the last ${windowDays} days -- `
        + 'a pattern, not a single event, and worth a human look even though no one occurrence crossed the line alone.',
      triggeredBy: 'system',
      metadata: { trigger_key: candidate.trigger_key, occurrence_count: occurrenceCount, window_days: windowDays },
    });
    filed.push(escalation);
  }

  return filed;
}

export interface BoardEscalationSummary {
  scope: 'organization_aggregate';
  minimumCohortSize: number;
  generatedAt: string;
  openBySeverity: {
    critical: BoardCountMetric;
    high: BoardCountMetric;
    moderate: BoardCountMetric;
    low: BoardCountMetric;
  };
}

interface BoardEscalationSummaryRow {
  open_critical: number;
  open_critical_athletes: number;
  open_high: number;
  open_high_athletes: number;
  open_moderate: number;
  open_moderate_athletes: number;
  open_low: number;
  open_low_athletes: number;
}

/**
 * Board never reads pilot.safety_escalations rows directly -- only this
 * count-only, k-anonymity-gated summary, matching
 * compliance.ts:getOrganizationViolationSummary's audience:'board' path
 * exactly. A count below BOARD_MINIMUM_COHORT_SIZE distinct athletes comes
 * back 'insufficient_data', never a small real number.
 */
export async function getBoardEscalationSummary(organizationId: string): Promise<BoardEscalationSummary> {
  const row = await queryOne<BoardEscalationSummaryRow>(
    `select
       count(*) filter (where severity = 'critical' and status = 'open') as open_critical,
       count(distinct athlete_id) filter (where severity = 'critical' and status = 'open') as open_critical_athletes,
       count(*) filter (where severity = 'high' and status = 'open') as open_high,
       count(distinct athlete_id) filter (where severity = 'high' and status = 'open') as open_high_athletes,
       count(*) filter (where severity = 'moderate' and status = 'open') as open_moderate,
       count(distinct athlete_id) filter (where severity = 'moderate' and status = 'open') as open_moderate_athletes,
       count(*) filter (where severity = 'low' and status = 'open') as open_low,
       count(distinct athlete_id) filter (where severity = 'low' and status = 'open') as open_low_athletes
     from pilot.safety_escalations
     where organization_id = $1`,
    [organizationId],
  );

  const safe = row ?? {
    open_critical: 0, open_critical_athletes: 0,
    open_high: 0, open_high_athletes: 0,
    open_moderate: 0, open_moderate_athletes: 0,
    open_low: 0, open_low_athletes: 0,
  };

  return {
    scope: 'organization_aggregate',
    minimumCohortSize: BOARD_MINIMUM_COHORT_SIZE,
    generatedAt: new Date().toISOString(),
    openBySeverity: {
      critical: boardCountMetric(safe.open_critical, safe.open_critical_athletes),
      high: boardCountMetric(safe.open_high, safe.open_high_athletes),
      moderate: boardCountMetric(safe.open_moderate, safe.open_moderate_athletes),
      low: boardCountMetric(safe.open_low, safe.open_low_athletes),
    },
  };
}

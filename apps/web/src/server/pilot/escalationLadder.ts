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
export type SafetyEscalationSourceType = 'near_miss' | 'pain_report' | 'safety_gate_evaluation' | 'repeated_pattern' | 'athlete_voice' | 'training_hold' | 'incident';
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

export interface FileIncidentReportInput {
  organizationId: string;
  athleteId: string;
  /**
   * An incident is, by definition, something that actually happened -- not
   * a close call -- so 'low'/'moderate' are deliberately not accepted here.
   * A near miss belongs on shadow_near_misses, not this path.
   */
  severity: 'high' | 'critical';
  reason: string;
  reportedByAccountId: string;
  reportedByRole: string;
  /**
   * When the incident happened, if different from when it was filed (a
   * coach reporting Monday's incident on Tuesday). No dedicated column
   * exists for this -- created_at is always the filing time -- so it rides
   * in metadata alongside every other source_type's contextual detail.
   */
  occurredAt?: string | null;
}

// POST /api/pilot/incidents accepts no client-supplied idempotency key, and
// a double-submit or a client retry after a dropped response is a real
// pattern for an admin-facing form with no optimistic UI -- each retried
// request otherwise files a second, fully duplicate 'incident' escalation
// for the same real-world event, doubling the manual safety-review queue
// for something that only happened once. A window this short cannot
// mistake two genuinely separate incidents (even identically worded ones,
// reported minutes apart) for the same submission; it exists to absorb a
// retried REQUEST, not to deduplicate the athlete's history.
const INCIDENT_DEDUP_WINDOW_SECONDS = 30;

/**
 * Capability #152: a post-hoc report that harm or a rule violation actually
 * occurred, distinct from pilot.shadow_near_misses ("this almost happened")
 * and from every other source_type here, which are all system-detected or
 * derived from an existing record. An incident always has a human reporter
 * and severity is never allowed to read as anything less than 'high' --
 * this is the one source_type where the filer is asserting something
 * genuinely happened, not flagging a possibility.
 *
 * Idempotent within INCIDENT_DEDUP_WINDOW_SECONDS: the same org/athlete/
 * reporter/reason combination filed twice in quick succession returns the
 * FIRST report both times rather than inserting a duplicate. The check and
 * the insert are one atomic statement (INSERT ... SELECT ... WHERE NOT
 * EXISTS), matching detectRepeatedPatternEscalations's own accepted
 * tradeoff elsewhere in this file: this is not a partial-unique-index-level
 * guarantee against two requests landing at the database in the same
 * instant (that would need a migration and a client-supplied key neither of
 * which exist here), but it closes the documented failure mode -- a
 * sequential retry, which by definition cannot reach Postgres before the
 * first attempt has already committed.
 */
export async function fileIncidentReport(input: FileIncidentReportInput): Promise<SafetyEscalationRow> {
  // The 'high'/'critical' floor above is a TypeScript-only guarantee -- it
  // does not survive past this module's own boundary. Round 9 review: the
  // only actual enforcement was api/pilot/incidents/route.ts's own
  // allow-list check, so any other caller (a script, a future route) could
  // file a sub-floor severity with nothing in this function or the database
  // (severity is app-enforced for source_type='incident', not a DB CHECK
  // scoped to it) to stop it. Checked here too, so the floor holds even for
  // a caller that bypasses TypeScript (JS, a malformed request already cast
  // past the route's own check, or a future caller that never re-validates).
  if (input.severity !== 'high' && input.severity !== 'critical') {
    throw new Error(`fileIncidentReport: severity must be 'high' or 'critical', got '${String(input.severity)}'`);
  }

  const escalationId = randomUUID();
  const escalatedToRole: SafetyEscalationTargetRole = 'organization_admin';
  const metadata = input.occurredAt ? { occurred_at: input.occurredAt } : {};

  const inserted = await queryOne<{ escalation_id: string }>(
    `insert into pilot.safety_escalations (
       organization_id, escalation_id, source_type, source_id, athlete_id,
       severity, reason, escalated_to_role,
       triggered_by, triggered_by_account_id, triggered_by_role,
       metadata
     )
     select $1, $2, 'incident', null, $3, $4, $5, $6, 'human', $7, $8, $9::jsonb
     where not exists (
       select 1 from pilot.safety_escalations
       where organization_id = $1
         and source_type = 'incident'
         and athlete_id = $3
         and triggered_by_account_id = $7
         and reason = $5
         and created_at > now() - ($10 * interval '1 second')
     )
     returning escalation_id`,
    [
      input.organizationId,
      escalationId,
      input.athleteId,
      input.severity,
      input.reason,
      escalatedToRole,
      input.reportedByAccountId,
      input.reportedByRole,
      JSON.stringify(metadata),
      INCIDENT_DEDUP_WINDOW_SECONDS,
    ],
  );

  if (inserted) {
    const now = new Date().toISOString();
    return {
      escalation_id: escalationId,
      source_type: 'incident',
      source_id: null,
      athlete_id: input.athleteId,
      severity: input.severity,
      reason: input.reason,
      escalated_to_role: escalatedToRole,
      triggered_by: 'human',
      triggered_by_account_id: input.reportedByAccountId,
      triggered_by_role: input.reportedByRole,
      status: 'open',
      acknowledged_by_account_id: null,
      acknowledged_at: null,
      resolved_by_account_id: null,
      resolved_at: null,
      resolution_note: '',
      metadata,
      created_at: now,
      updated_at: now,
    };
  }

  // A duplicate landed inside the window: the caller's request still
  // resolves to a real record -- the report that already exists -- rather
  // than silently doing nothing or throwing on what looks, from the
  // reporter's side, like an ordinary submission.
  const existing = await queryOne<SafetyEscalationRow>(
    `select escalation_id, source_type, source_id, athlete_id, severity, reason,
            escalated_to_role, triggered_by, triggered_by_account_id, triggered_by_role,
            status, acknowledged_by_account_id, acknowledged_at::text,
            resolved_by_account_id, resolved_at::text, resolution_note, metadata,
            created_at::text, updated_at::text
     from pilot.safety_escalations
     where organization_id = $1 and source_type = 'incident' and athlete_id = $2
       and triggered_by_account_id = $3 and reason = $4
       and created_at > now() - ($5 * interval '1 second')
     order by created_at desc
     limit 1`,
    [input.organizationId, input.athleteId, input.reportedByAccountId, input.reason, INCIDENT_DEDUP_WINDOW_SECONDS],
  );
  if (existing) return existing;

  // Vanishingly unlikely -- the row that blocked the insert would have to
  // be deleted between the two queries -- but never fabricate a report that
  // does not exist; a real error here is honest, a synthesized one is not.
  throw new Error('fileIncidentReport: a duplicate was detected but the existing report could not be re-read');
}

export interface EscalationListFilters {
  status?: SafetyEscalationStatus;
  athleteIds?: string[];
  /**
   * Coach-scoped reads set this: an 'athlete_voice' escalation exists
   * because a child typed something into the feedback box, and its mere
   * presence on a coach's list -- however non-disclosing its reason --
   * tells the athlete's coach that the athlete said something. The coach
   * may be exactly who the child is disclosing about, so athlete_voice
   * rows are admin-surface only.
   */
  excludeAthleteVoice?: boolean;
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
       and ($4::boolean is not true or source_type <> 'athlete_voice')
     order by
       case severity when 'critical' then 0 when 'high' then 1 when 'moderate' then 2 else 3 end asc,
       created_at desc`,
    [organizationId, filters.status ?? null, filters.athleteIds ?? null, filters.excludeAthleteVoice ?? null],
  );
}

/**
 * The one legal ordering: open -> acknowledged -> resolved (resolve may also
 * skip acknowledged). Enforced by a status predicate on the UPDATE itself, so
 * a stale page or a raced request cannot regress a record: without the guard,
 * acknowledging a RESOLVED escalation flipped it back to 'acknowledged' with
 * its resolved_* columns still populated -- a closed safety record about a
 * minor silently reopened, its resolution invisible on every status filter --
 * and re-acknowledging overwrote who first saw the red flag.
 *
 * When the guarded UPDATE matches nothing, the row is re-read to distinguish
 * the two different facts a caller must not conflate: no such row (returns
 * null; routes surface their 'Missing escalation record') versus a row in a
 * state the transition is not legal from (throws 'Unsupported transition:',
 * which jsonError maps to 400 -- a caller mistake, not a server fault).
 */
const LEGAL_PRIOR_STATES: Record<'acknowledged' | 'resolved', SafetyEscalationStatus[]> = {
  acknowledged: ['open'],
  resolved: ['open', 'acknowledged'],
};

async function transitionEscalation(
  organizationId: string,
  escalationId: string,
  input: {
    status: 'acknowledged' | 'resolved';
    accountId: string;
    resolutionNote?: string;
  },
): Promise<SafetyEscalationRow | null> {
  // nullif($4, '') keeps an empty-string note from wiping a stored one: the
  // route layer can only ever produce strings, and coalesce alone treats ''
  // as a real value that wins over the existing note.
  const columns = input.status === 'acknowledged'
    ? `status = 'acknowledged', acknowledged_by_account_id = $3, acknowledged_at = now(), updated_at = now()`
    : `status = 'resolved', resolved_by_account_id = $3, resolved_at = now(), resolution_note = coalesce(nullif($4, ''), resolution_note), updated_at = now()`;

  const legalPriorStates = LEGAL_PRIOR_STATES[input.status];
  const statesParam = input.status === 'acknowledged' ? '$4' : '$5';

  const updated = await queryOne<SafetyEscalationRow>(
    `update pilot.safety_escalations
     set ${columns}
     where organization_id = $1 and escalation_id = $2
       and status = any(${statesParam}::text[])
     returning escalation_id, source_type, source_id, athlete_id, severity, reason,
               escalated_to_role, triggered_by, triggered_by_account_id, triggered_by_role,
               status, acknowledged_by_account_id, acknowledged_at::text,
               resolved_by_account_id, resolved_at::text, resolution_note, metadata,
               created_at::text, updated_at::text`,
    input.status === 'acknowledged'
      ? [organizationId, escalationId, input.accountId, legalPriorStates]
      : [organizationId, escalationId, input.accountId, input.resolutionNote ?? null, legalPriorStates],
  );
  if (updated) return updated;

  const existing = await queryOne<{ status: SafetyEscalationStatus }>(
    `select status from pilot.safety_escalations
     where organization_id = $1 and escalation_id = $2`,
    [organizationId, escalationId],
  );
  if (!existing) return null;
  throw new Error(
    `Unsupported transition: escalation is '${existing.status}' and cannot move to '${input.status}'`,
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

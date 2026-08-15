import { randomUUID } from 'node:crypto';
import {
  BOARD_MINIMUM_COHORT_SIZE,
  boardCountMetric,
  type BoardCountMetric,
} from './boardSummary';
import { query, queryOne, withTransaction } from './db';

const COMPLIANCE_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

// severity is a text column, so `order by severity desc` sorts alphabetically
// and puts 'medium' above 'critical'. Rank the vocabulary explicitly instead.
// Anything outside it sorts last rather than silently displacing a real
// severity.
const SEVERITY_RANK_SQL = `case severity
      when 'critical' then 1
      when 'high' then 2
      when 'medium' then 3
      when 'low' then 4
      else 5
    end`;

export interface ComplianceRule {
  rule_id: string;
  rule_name: string;
  rule_category: 'safety' | 'technique' | 'protocol' | 'medical' | 'behavioral';
  severity: 'critical' | 'high' | 'medium' | 'low';
  escalation_level: 'coach' | 'admin' | 'board' | 'parent';
  active_flag: boolean;
}

export interface ComplianceViolation {
  violation_id: string;
  rule_id: string;
  video_session_id: string | null;
  athlete_id: string;
  severity: string;
  status: 'new' | 'acknowledged' | 'escalated' | 'resolved' | 'dismissed';
  escalation_status: 'pending' | 'in_progress' | 'resolved' | 'escalated_to_board';
  created_at: string;
}

// An organization admin runs the gym and legitimately reads exact violation
// counts. The board reads organization aggregates only, so its figures are
// held to the same k-anonymity floor as every other board aggregate.
export type ComplianceSummaryAudience = 'organization_admin' | 'board';

export interface ComplianceViolationSummary {
  audience: ComplianceSummaryAudience;
  minimumCohortSize: number;
  generatedAt: string;
  total: BoardCountMetric;
  severity: {
    critical: BoardCountMetric;
    high: BoardCountMetric;
    medium: BoardCountMetric;
    low: BoardCountMetric;
  };
  status: {
    new: BoardCountMetric;
    acknowledged: BoardCountMetric;
    escalated: BoardCountMetric;
    resolved: BoardCountMetric;
    dismissed: BoardCountMetric;
  };
}

interface ComplianceViolationSummaryRow {
  total: number;
  total_athletes: number;
  critical: number;
  critical_athletes: number;
  high: number;
  high_athletes: number;
  medium: number;
  medium_athletes: number;
  low: number;
  low_athletes: number;
  status_new: number;
  status_new_athletes: number;
  status_acknowledged: number;
  status_acknowledged_athletes: number;
  status_escalated: number;
  status_escalated_athletes: number;
  status_resolved: number;
  status_resolved_athletes: number;
  status_dismissed: number;
  status_dismissed_athletes: number;
}

// Each bucket is gated on the athletes who appear in THAT bucket, not on the
// organization total: a single critical violation is an identification even
// when the ledger as a whole is large, because the severity and the date
// narrow it to one athlete. The board therefore gets a withheld bucket rather
// than a small number, and an empty ledger stays distinguishable from a
// suppressed one so neither can be read as a measured zero.
function violationMetric(
  audience: ComplianceSummaryAudience,
  recordCountInput: unknown,
  participantCountInput: unknown,
): BoardCountMetric {
  const gated = boardCountMetric(recordCountInput, participantCountInput);
  if (audience === 'board') {
    return gated;
  }
  return { status: gated.status, count: Number(recordCountInput) };
}

export async function createComplianceViolation(params: {
  organizationId: string;
  ruleId: string;
  videoSessionId: string | null;
  athleteId: string;
  detectedByAccountId: string;
  severity: string;
  details: Record<string, unknown>;
  evidencePath?: string;
}): Promise<ComplianceViolation> {
  // pilot.compliance_violations.severity carries no check constraint, unlike
  // the rules table it is filed against. Free text written here is invisible to
  // getOrganizationViolationSummary, which counts only these four buckets, and
  // sorts last everywhere severity is ranked.
  if (!(COMPLIANCE_SEVERITIES as readonly string[]).includes(params.severity)) {
    throw new Error(`Unsupported severity: must be one of ${COMPLIANCE_SEVERITIES.join(', ')}`);
  }

  const violationId = `violation_${Date.now()}_${randomUUID().split('-')[0]}`;
  const now = new Date().toISOString();

  const result = await query<ComplianceViolation>(
    `insert into pilot.compliance_violations (
      violation_id, organization_id, rule_id, video_session_id, athlete_id,
      detected_by_account_id, violation_timestamp, severity, details, evidence_path, status, escalation_status
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'new', 'pending')
    returning *`,
    [
      violationId,
      params.organizationId,
      params.ruleId,
      params.videoSessionId,
      params.athleteId,
      params.detectedByAccountId,
      now,
      params.severity,
      JSON.stringify(params.details),
      params.evidencePath || null,
    ],
  );

  return result[0];
}

export async function escalateViolation(params: {
  organizationId: string;
  violationId: string;
  escalatedByAccountId: string;
  escalatedToRole: string;
  escalationReason: string;
  actionRequired?: string;
}): Promise<void> {
  const escalationId = `escalation_${Date.now()}_${randomUUID().split('-')[0]}`;

  // One transaction: an escalation row whose violation is still sitting at
  // status 'new' reads as an unescalated violation everywhere the compliance
  // centre looks, so the pair must commit together or not at all.
  //
  // The guarded UPDATE runs FIRST and is a compare-and-set out of the two
  // escalatable states. This used to update by id alone with no row-count
  // check, which had two failure shapes: an escalation row could be filed
  // against a violation the org-scoped update never matched (foreign or
  // missing id), and a violation already resolved or dismissed could be
  // silently yanked back to 'escalated' by a stale click. Zero matched rows
  // now throws, which rolls the whole transaction back before the
  // escalation row exists.
  await withTransaction(async (client) => {
    const updated = await client.query<{ violation_id: string }>(
      `update pilot.compliance_violations
       set status = 'escalated', escalation_status = 'in_progress', updated_at = now()
       where violation_id = $1 and organization_id = $2
         and status in ('new', 'acknowledged')
       returning violation_id`,
      [params.violationId, params.organizationId],
    );

    if (updated.rows.length === 0) {
      throw new Error('Unsupported: violation is not in an escalatable state');
    }

    await client.query(
      `insert into pilot.violation_escalations (
        escalation_id, organization_id, violation_id, escalated_by_account_id,
        escalated_to_role, escalation_reason, action_required
      ) values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        escalationId,
        params.organizationId,
        params.violationId,
        params.escalatedByAccountId,
        params.escalatedToRole,
        params.escalationReason,
        params.actionRequired || null,
      ],
    );
  });
}

export type ComplianceViolationTransition = 'acknowledge' | 'resolve' | 'dismiss';

// The lifecycle the status vocabulary already declares, made reachable. Each
// transition names its allowed source states explicitly; everything else is a
// refusal, so 'resolved' and 'dismissed' are terminal and a stale click can
// never re-open or overwrite a decided violation.
//
//   acknowledge: new -> acknowledged            (an admin has seen it)
//   escalate:    new|acknowledged -> escalated  (escalateViolation above)
//   resolve:     acknowledged|escalated -> resolved
//   dismiss:     new|acknowledged -> dismissed  (an escalated violation went
//                up the ladder; it comes back down by being resolved, never
//                by being dismissed)
//
// Resolution and dismissal close the WORKFLOW only. They do not clear an
// athlete medically, disprove a safeguarding concern, lift any restriction
// or hold, or erase the violation, its rule, its evidence, or its history.
const TRANSITION_CONTRACT: Record<ComplianceViolationTransition, {
  target: ComplianceViolation['status'];
  allowedSources: ReadonlyArray<ComplianceViolation['status']>;
}> = {
  acknowledge: { target: 'acknowledged', allowedSources: ['new'] },
  resolve: { target: 'resolved', allowedSources: ['acknowledged', 'escalated'] },
  dismiss: { target: 'dismissed', allowedSources: ['new', 'acknowledged'] },
};

/**
 * Move a violation through its existing lifecycle. Compare-and-set on the
 * allowed source states, organization-scoped in the predicate, one
 * transaction. Returns false (and writes nothing) when no row matched --
 * a foreign or missing violation_id and a stale state arrive identically,
 * so two operators cannot silently overwrite one another.
 *
 * Resolving an escalated violation also closes its escalation track in the
 * same transaction: escalation_status moves to 'resolved' (whatever leg it
 * was on -- in_progress or escalated_to_board), and the escalation records'
 * open resolved_at stamps are filled. status = 'resolved' with an
 * escalation still reading in_progress is exactly the contradictory state
 * the transaction exists to make unrepresentable. The escalation rows
 * themselves are history and are never deleted.
 */
export async function transitionComplianceViolation(params: {
  organizationId: string;
  violationId: string;
  transition: ComplianceViolationTransition;
}): Promise<boolean> {
  const contract = TRANSITION_CONTRACT[params.transition];

  return withTransaction(async (client) => {
    const updated = await client.query<{ violation_id: string; status: string }>(
      `update pilot.compliance_violations
       set status = $3,
           escalation_status = case
             when $3 = 'resolved' and status = 'escalated' then 'resolved'
             else escalation_status
           end,
           updated_at = now()
       where organization_id = $1 and violation_id = $2
         and status = any($4::text[])
       returning violation_id, status`,
      [params.organizationId, params.violationId, contract.target, [...contract.allowedSources]],
    );

    if (updated.rows.length === 0) {
      return false;
    }

    if (params.transition === 'resolve') {
      await client.query(
        `update pilot.violation_escalations
         set resolved_at = now(), updated_at = now()
         where organization_id = $1 and violation_id = $2 and resolved_at is null`,
        [params.organizationId, params.violationId],
      );
    }

    return true;
  });
}

export async function getComplianceViolationById(
  organizationId: string,
  violationId: string,
): Promise<ComplianceViolation | null> {
  return queryOne<ComplianceViolation>(
    `select violation_id, rule_id, video_session_id, athlete_id, severity, status, escalation_status, created_at
     from pilot.compliance_violations
     where organization_id = $1 and violation_id = $2`,
    [organizationId, violationId],
  );
}

export async function getOrganizationViolations(
  organizationId: string,
  filters?: {
    athleteId?: string;
    status?: string;
    severity?: string;
    limit?: number;
    coachAccountId?: string;
  },
): Promise<ComplianceViolation[]> {
  let sql = `
    select violation_id, rule_id, video_session_id, athlete_id, severity, status, escalation_status, created_at
    from pilot.compliance_violations
    where organization_id = $1
  `;
  const params: unknown[] = [organizationId];

  if (filters?.athleteId) {
    sql += ` and athlete_id = $${params.length + 1}`;
    params.push(filters.athleteId);
  }

  if (filters?.coachAccountId) {
    sql += ` and athlete_id in (select athlete_id from pilot.athletes where coach_id = $${params.length + 1} and organization_id = $1)`;
    params.push(filters.coachAccountId);
  }

  if (filters?.status) {
    sql += ` and status = $${params.length + 1}`;
    params.push(filters.status);
  }

  if (filters?.severity) {
    sql += ` and severity = $${params.length + 1}`;
    params.push(filters.severity);
  }

  sql += ` order by created_at desc limit $${params.length + 1}`;
  params.push(filters?.limit || 50);

  return query<ComplianceViolation>(sql, params);
}

export async function getComplianceRuleById(
  organizationId: string,
  ruleId: string,
): Promise<ComplianceRule | null> {
  return queryOne<ComplianceRule>(
    `select rule_id, rule_name, rule_category, severity, escalation_level, active_flag
     from pilot.compliance_rules
     where organization_id = $1 and rule_id = $2`,
    [organizationId, ruleId],
  );
}

export async function getComplianceRulesByCategory(
  organizationId: string,
  category?: string,
): Promise<ComplianceRule[]> {
  let sql = `
    select rule_id, rule_name, rule_category, severity, escalation_level, active_flag
    from pilot.compliance_rules
    where organization_id = $1 and active_flag = true
  `;
  const params: unknown[] = [organizationId];

  if (category) {
    sql += ` and rule_category = $${params.length + 1}`;
    params.push(category);
  }

  sql += ` order by ${SEVERITY_RANK_SQL}, rule_name asc`;

  return query<ComplianceRule>(sql, params);
}

export async function getOrganizationViolationSummary(
  organizationId: string,
  options: {
    audience: ComplianceSummaryAudience;
    status?: string;
  },
): Promise<ComplianceViolationSummary> {
  // Only aggregates leave this query. count(distinct athlete_id) sizes each
  // cohort for the floor above; the athlete_id itself is never selected.
  let sql = `
    select
      count(*)::int as total,
      count(distinct athlete_id)::int as total_athletes,
      count(*) filter (where severity = 'critical')::int as critical,
      count(distinct athlete_id) filter (where severity = 'critical')::int as critical_athletes,
      count(*) filter (where severity = 'high')::int as high,
      count(distinct athlete_id) filter (where severity = 'high')::int as high_athletes,
      count(*) filter (where severity = 'medium')::int as medium,
      count(distinct athlete_id) filter (where severity = 'medium')::int as medium_athletes,
      count(*) filter (where severity = 'low')::int as low,
      count(distinct athlete_id) filter (where severity = 'low')::int as low_athletes,
      count(*) filter (where status = 'new')::int as status_new,
      count(distinct athlete_id) filter (where status = 'new')::int as status_new_athletes,
      count(*) filter (where status = 'acknowledged')::int as status_acknowledged,
      count(distinct athlete_id) filter (where status = 'acknowledged')::int as status_acknowledged_athletes,
      count(*) filter (where status = 'escalated')::int as status_escalated,
      count(distinct athlete_id) filter (where status = 'escalated')::int as status_escalated_athletes,
      count(*) filter (where status = 'resolved')::int as status_resolved,
      count(distinct athlete_id) filter (where status = 'resolved')::int as status_resolved_athletes,
      count(*) filter (where status = 'dismissed')::int as status_dismissed,
      count(distinct athlete_id) filter (where status = 'dismissed')::int as status_dismissed_athletes
    from pilot.compliance_violations
    where organization_id = $1
  `;
  const params: unknown[] = [organizationId];

  if (options.status) {
    sql += ` and status = $2`;
    params.push(options.status);
  }

  const row = await queryOne<ComplianceViolationSummaryRow>(sql, params);

  if (!row) {
    throw new Error('COMPLIANCE_SUMMARY_UNAVAILABLE');
  }

  const metric = (recordCount: unknown, participantCount: unknown) =>
    violationMetric(options.audience, recordCount, participantCount);

  return {
    audience: options.audience,
    minimumCohortSize: BOARD_MINIMUM_COHORT_SIZE,
    generatedAt: new Date().toISOString(),
    total: metric(row.total, row.total_athletes),
    severity: {
      critical: metric(row.critical, row.critical_athletes),
      high: metric(row.high, row.high_athletes),
      medium: metric(row.medium, row.medium_athletes),
      low: metric(row.low, row.low_athletes),
    },
    status: {
      new: metric(row.status_new, row.status_new_athletes),
      acknowledged: metric(row.status_acknowledged, row.status_acknowledged_athletes),
      escalated: metric(row.status_escalated, row.status_escalated_athletes),
      resolved: metric(row.status_resolved, row.status_resolved_athletes),
      dismissed: metric(row.status_dismissed, row.status_dismissed_athletes),
    },
  };
}

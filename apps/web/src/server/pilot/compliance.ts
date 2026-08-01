import { randomUUID } from 'node:crypto';
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

export interface ComplianceViolationSummary {
  total: number;
  severity: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  status: {
    new: number;
    acknowledged: number;
    escalated: number;
    resolved: number;
    dismissed: number;
  };
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
  await withTransaction(async (client) => {
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

    // Update violation status. Scoped by organization_id so a violation_id
    // from another organization can never be mutated by this call.
    await client.query(
      `update pilot.compliance_violations
       set status = 'escalated', escalation_status = 'in_progress'
       where violation_id = $1 and organization_id = $2`,
      [params.violationId, params.organizationId],
    );
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
  status?: string,
): Promise<ComplianceViolationSummary> {
  let sql = `
    select
      count(*)::int as total,
      count(*) filter (where severity = 'critical')::int as critical,
      count(*) filter (where severity = 'high')::int as high,
      count(*) filter (where severity = 'medium')::int as medium,
      count(*) filter (where severity = 'low')::int as low,
      count(*) filter (where status = 'new')::int as status_new,
      count(*) filter (where status = 'acknowledged')::int as status_acknowledged,
      count(*) filter (where status = 'escalated')::int as status_escalated,
      count(*) filter (where status = 'resolved')::int as status_resolved,
      count(*) filter (where status = 'dismissed')::int as status_dismissed
    from pilot.compliance_violations
    where organization_id = $1
  `;
  const params: unknown[] = [organizationId];

  if (status) {
    sql += ` and status = $2`;
    params.push(status);
  }

  const row = await queryOne<{
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    status_new: number;
    status_acknowledged: number;
    status_escalated: number;
    status_resolved: number;
    status_dismissed: number;
  }>(sql, params);

  return {
    total: row?.total ?? 0,
    severity: {
      critical: row?.critical ?? 0,
      high: row?.high ?? 0,
      medium: row?.medium ?? 0,
      low: row?.low ?? 0,
    },
    status: {
      new: row?.status_new ?? 0,
      acknowledged: row?.status_acknowledged ?? 0,
      escalated: row?.status_escalated ?? 0,
      resolved: row?.status_resolved ?? 0,
      dismissed: row?.status_dismissed ?? 0,
    },
  };
}

import { randomUUID } from 'node:crypto';
import { query } from './db';

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

  await query(
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

  // Update violation status
  await query(
    `update pilot.compliance_violations set status = 'escalated', escalation_status = 'in_progress' where violation_id = $1`,
    [params.violationId],
  );
}

export async function getOrganizationViolations(
  organizationId: string,
  filters?: {
    athleteId?: string;
    status?: string;
    severity?: string;
    limit?: number;
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

  sql += ` order by severity desc`;

  return query<ComplianceRule>(sql, params);
}

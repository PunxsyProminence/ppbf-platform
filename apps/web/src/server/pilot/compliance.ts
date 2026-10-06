import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import {
  BOARD_MINIMUM_COHORT_SIZE,
  boardCountMetric,
  type BoardCountMetric,
} from './boardSummary';
import { type PilotAuditEvent, writePilotAuditEvent } from './audit';
import { query, queryOne, withTransaction } from './db';
import { athleteNotDeletedSql } from './deletedAthletes';
import { ConflictError } from './errors';
import {
  fileEscalation,
  type SafetyEscalationSeverity,
  type SafetyEscalationTargetRole,
} from './escalationLadder';

const COMPLIANCE_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

/**
 * details.source on a violation escalated from the Film Study review queue
 * (app/coach/video-analysis). It is the only provenance value a violation can
 * carry: POST /api/pilot/compliance/violations refuses any other source, and
 * the details of a Film Study filing are written here, never taken from the
 * request, so the stored citation is exactly the pair the route verified.
 */
export const FILM_STUDY_PROPOSAL_SOURCE = 'film_study_proposal';

/**
 * The same Film Study proposal is already filed under the same rule in this
 * organization. Each filing also files its rule's escalation, so a second one
 * would put a duplicate on the escalation ladder as well as the register.
 * Filing the proposal under a different rule is still allowed.
 */
export class ComplianceViolationAlreadyFiledError extends ConflictError {
  constructor(readonly violationId: string) {
    super('This observation is already filed under this rule.', 'COMPLIANCE_VIOLATION_ALREADY_FILED');
  }
}

// Maps pilot.compliance_rules.escalation_level to escalationLadder.ts's
// SafetyEscalationTargetRole. 'coach' and 'admin' map onto rungs that
// already exist on the ladder ('admin' maps to 'organization_admin', the
// canonical modern name -- ORGANIZATION_ROLE_MODEL.md notes 'admin' is only
// legacy-compatible with it, and it is also fileEscalation's own documented
// safety-critical default). 'board' and 'parent' are deliberately absent:
// see SafetyEscalationTargetRole's own doc comment in escalationLadder.ts
// for the full reasoning (k-anonymity for board, non-disclosure to
// guardians for parent) -- a rule seeded/authored with either level does
// not auto-escalate here, which is a reported gap, not silently widened.
const RULE_ESCALATION_LEVEL_TO_TARGET_ROLE: Partial<Record<ComplianceRule['escalation_level'], SafetyEscalationTargetRole>> = {
  coach: 'coach',
  admin: 'organization_admin',
};

// pilot.compliance_rules/compliance_violations use ('critical','high','medium','low');
// escalationLadder.ts inherits pilot.shadow_near_misses's ('low','moderate','high','critical')
// -- the migration's own doc calls these out as different, unreconciled
// vocabularies. 'medium' is the one value without a same-named counterpart.
const COMPLIANCE_SEVERITY_TO_ESCALATION_SEVERITY: Record<typeof COMPLIANCE_SEVERITIES[number], SafetyEscalationSeverity> = {
  critical: 'critical',
  high: 'high',
  medium: 'moderate',
  low: 'low',
};

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

/**
 * Files the pull-surface notification escalationLadder.ts exists for,
 * alongside a just-created violation, when the violated rule's
 * escalation_level maps to a supported SafetyEscalationTargetRole. A rule
 * whose escalation_level is 'board' or 'parent' -- or whose rule_id does
 * not resolve inside this organization -- is a deliberate no-op here; see
 * RULE_ESCALATION_LEVEL_TO_TARGET_ROLE's doc comment.
 *
 * Runs on the same transaction client as the violation insert (fileEscalation
 * accepts one for exactly this reason): a violation severe enough for its
 * rule to demand escalation must never commit without that escalation, or
 * vice versa, matching trainingHolds.ts:placeTrainingHold's own pairing of
 * its state-owning insert with a ladder notification.
 */
async function fileComplianceEscalationIfConfigured(
  client: PoolClient,
  params: {
    organizationId: string;
    ruleId: string;
    athleteId: string;
    severity: typeof COMPLIANCE_SEVERITIES[number];
    detectedByAccountId: string;
    violationId: string;
  },
): Promise<void> {
  const ruleResult = await client.query<{ rule_name: string; escalation_level: ComplianceRule['escalation_level'] }>(
    `select rule_name, escalation_level from pilot.compliance_rules
     where organization_id = $1 and rule_id = $2`,
    [params.organizationId, params.ruleId],
  );
  const rule = ruleResult.rows[0];
  if (!rule) {
    return;
  }

  const escalatedToRole = RULE_ESCALATION_LEVEL_TO_TARGET_ROLE[rule.escalation_level];
  if (!escalatedToRole) {
    return;
  }

  await fileEscalation(
    {
      organizationId: params.organizationId,
      sourceType: 'compliance_violation',
      sourceId: params.violationId,
      athleteId: params.athleteId,
      severity: COMPLIANCE_SEVERITY_TO_ESCALATION_SEVERITY[params.severity],
      reason:
        `Compliance rule "${rule.rule_name}" was violated (severity: ${params.severity}). `
        + 'The violation record carries the evidence and details; resolving this escalation does not resolve the violation.',
      escalatedToRole,
      triggeredBy: 'system',
      metadata: {
        violation_id: params.violationId,
        rule_id: params.ruleId,
        escalation_level: rule.escalation_level,
        detected_by_account_id: params.detectedByAccountId,
      },
    },
    client,
  );
}

/**
 * The violation already filed in this organization from this Film Study
 * proposal under this rule, if any (the oldest, should duplicates predate this
 * check). Organization-scoped in the predicate, so another gym's filings never
 * answer. Pass the transaction client to read inside the create transaction.
 */
export async function findFilmStudyProposalViolation(
  organizationId: string,
  ruleId: string,
  proposalId: string,
  client?: PoolClient,
): Promise<{ violation_id: string } | null> {
  const sql = `select violation_id from pilot.compliance_violations
     where organization_id = $1 and rule_id = $2
       and details->>'source' = $3 and details->>'proposal_id' = $4
     order by created_at asc, violation_id asc
     limit 1`;
  const params = [organizationId, ruleId, FILM_STUDY_PROPOSAL_SOURCE, proposalId];
  if (client) {
    const result = await client.query<{ violation_id: string }>(sql, params);
    return result.rows[0] ?? null;
  }
  return queryOne<{ violation_id: string }>(sql, params);
}

export async function createComplianceViolation(params: {
  organizationId: string;
  ruleId: string;
  videoSessionId: string | null;
  athleteId: string;
  detectedByAccountId: string;
  severity: string;
  /** The filer's own details, for a violation not escalated from Film Study. */
  details?: Record<string, unknown>;
  /**
   * The Film Study proposal this violation is escalated from, already checked
   * by the caller to be in this organization and about this athlete and
   * video. When set, the stored details are exactly
   * { source: FILM_STUDY_PROPOSAL_SOURCE, proposal_id } and `details` is not
   * used, and a second filing of the same proposal under the same rule throws
   * ComplianceViolationAlreadyFiledError.
   */
  filmStudyProposalId?: string;
  evidencePath?: string;
}): Promise<ComplianceViolation> {
  // pilot.compliance_violations.severity carries no check constraint, unlike
  // the rules table it is filed against. Free text written here is invisible to
  // getOrganizationViolationSummary, which counts only these four buckets, and
  // sorts last everywhere severity is ranked.
  if (!(COMPLIANCE_SEVERITIES as readonly string[]).includes(params.severity)) {
    throw new Error(`Unsupported severity: must be one of ${COMPLIANCE_SEVERITIES.join(', ')}`);
  }
  const severity = params.severity as typeof COMPLIANCE_SEVERITIES[number];

  const violationId = `violation_${Date.now()}_${randomUUID().split('-')[0]}`;
  const now = new Date().toISOString();
  const filmStudyProposalId = params.filmStudyProposalId;
  const details: Record<string, unknown> = filmStudyProposalId
    ? { source: FILM_STUDY_PROPOSAL_SOURCE, proposal_id: filmStudyProposalId }
    : params.details ?? {};

  return withTransaction(async (client) => {
    if (filmStudyProposalId) {
      // Locking the proposal row makes two filings of the same proposal wait
      // for each other, so the second one's duplicate check below sees the
      // first one's committed violation instead of racing past it. A proposal
      // gone since the caller's check is refused the way a missing one is.
      const locked = await client.query<{ proposal_id: string }>(
        `select proposal_id from pilot.shadow_film_study_proposals
         where organization_id = $1 and proposal_id = $2
         for update`,
        [params.organizationId, filmStudyProposalId],
      );
      if (locked.rows.length === 0) {
        throw new Error('Not found');
      }

      const existing = await findFilmStudyProposalViolation(
        params.organizationId,
        params.ruleId,
        filmStudyProposalId,
        client,
      );
      if (existing) {
        throw new ComplianceViolationAlreadyFiledError(existing.violation_id);
      }
    }

    const result = await client.query<ComplianceViolation>(
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
        JSON.stringify(details),
        params.evidencePath || null,
      ],
    );

    const violation = result.rows[0];

    await fileComplianceEscalationIfConfigured(client, {
      organizationId: params.organizationId,
      ruleId: params.ruleId,
      athleteId: params.athleteId,
      severity,
      detectedByAccountId: params.detectedByAccountId,
      violationId: violation.violation_id,
    });

    return violation;
  });
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
 * The statuses that mean a violation is still live -- somebody's open problem
 * rather than a closed record. 'resolved' and 'dismissed' are the two terminal
 * targets in TRANSITION_CONTRACT above and no transition leads back out of
 * either, so every other status the column's check constraint allows is open.
 *
 * Exported because a second consumer needs exactly this definition and must
 * not invent its own: Coach Intelligence's Morning Read (coachIntelligence.ts,
 * register module 111) lists still-open violations on a coach's own roster. A
 * digest that decided for itself what "open" means would drift from this
 * module the first time the lifecycle grew a status -- and it would drift
 * silently, on the surface a coach reads instead of the ledger, either by
 * counting a dismissed violation as live or, far worse, by dropping an
 * escalated one out of a safety list.
 */
export const COMPLIANCE_VIOLATION_OPEN_STATUSES: ReadonlyArray<ComplianceViolation['status']> = [
  'new',
  'acknowledged',
  'escalated',
];

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
 *
 * `audit`, when given, is written on the same transaction after the CAS
 * hits. A resolution or dismissal's stated reason lives only in that audit
 * row, so the route passes it here for those two: if the reason cannot be
 * recorded the closure rolls back with it, rather than committing a closed
 * violation whose reason exists nowhere (CX-3).
 */
export async function transitionComplianceViolation(params: {
  organizationId: string;
  violationId: string;
  transition: ComplianceViolationTransition;
  audit?: PilotAuditEvent;
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

    if (params.audit) {
      await writePilotAuditEvent(params.audit, client);
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
  // A deleted athlete's violation leaves once it is closed -- resolved or
  // dismissed -- and an open one stays until somebody closes it (Jason,
  // 2026-09-30, OD-2026-09-30-004 "B"). "Open" is this module's one definition
  // of it, inlined: the values are this file's own constants, never input.
  let sql = `
    select violation_id, rule_id, video_session_id, athlete_id, severity, status, escalation_status, created_at
    from pilot.compliance_violations
    where organization_id = $1
      and (status in (${COMPLIANCE_VIOLATION_OPEN_STATUSES.map((status) => `'${status}'`).join(', ')})
           or ${athleteNotDeletedSql('pilot.compliance_violations')})
  `;
  const params: unknown[] = [organizationId];

  if (filters?.athleteId) {
    sql += ` and athlete_id = $${params.length + 1}`;
    params.push(filters.athleteId);
  }

  if (filters?.coachAccountId) {
    // deleted_at is null: the coach's own view, which elsewhere has always
    // left a deleted athlete out (athleteIdsForCoach), and a deleted
    // athlete's rows are marked deleted with them (scope B). The org-admin
    // view keeps a deleted athlete's OPEN violations (the filter above).
    sql += ` and athlete_id in (select athlete_id from pilot.athletes where coach_id = $${params.length + 1} and organization_id = $1 and deleted_at is null)`;
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

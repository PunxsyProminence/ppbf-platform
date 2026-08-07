import { getOrganizationViolations, type ComplianceViolation } from './compliance';
import { query } from './db';
import { listEscalations, type SafetyEscalationRow } from './escalationLadder';
import type { SafetyGateOutcome } from './safetyGateMatrix';
import type { SafetyGateCategory } from './safetyGateSeeds';
import { listTrainingHolds, type TrainingHoldRow } from './trainingHolds';

/**
 * Capability #75: THE ROLLED-UP SAFETY REVIEW.
 *
 * Four real safety subsystems already exist -- training holds (#82), safety
 * gates (#3/#43), the escalation ladder (#194), and compliance violations
 * (pre-existing) -- but each lives on its own admin page with no combined
 * view. escalationLadder.ts's own header names this split as a deliberate,
 * still-open product question ("whether to eventually merge the two is a
 * real product question left open"); this module does not merge the
 * underlying tables (a bigger, riskier change this ticket does not attempt)
 * -- it is a pure read-side rollup, one Promise.all over the four systems'
 * own existing list functions, so an admin sees "everything open, right
 * now, for this org" without clicking between four pages.
 *
 * Each item is enriched with athlete_name (none of the four source tables
 * carry it) via one extra roster read, not by widening any of the four
 * underlying functions' own return shapes.
 */

export interface SafetyReviewHoldItem extends TrainingHoldRow {
  athlete_name: string | null;
}

export interface SafetyReviewGateFailureItem {
  athlete_id: string;
  athlete_name: string | null;
  gate_key: string;
  gate_name: string;
  category: SafetyGateCategory;
  outcome: Exclude<SafetyGateOutcome, 'passed'>;
  evaluated_at: string;
}

export interface SafetyReviewEscalationItem extends SafetyEscalationRow {
  athlete_name: string | null;
}

export interface SafetyReviewViolationItem extends ComplianceViolation {
  athlete_name: string | null;
}

export interface OrganizationSafetyReview {
  openHolds: SafetyReviewHoldItem[];
  failingGates: SafetyReviewGateFailureItem[];
  openEscalations: SafetyReviewEscalationItem[];
  openViolations: SafetyReviewViolationItem[];
}

interface GateFailureRow {
  athlete_id: string;
  gate_key: string;
  gate_name: string;
  category: SafetyGateCategory;
  outcome: SafetyGateOutcome;
  evaluated_at: string;
}

/**
 * Org-wide, unlike getGuardianGateSummary (#84, one athlete). Only the most
 * recent evaluation per (athlete, gate), and only where that outcome is
 * NOT 'passed' -- an inner join (not left), so an athlete/gate pair with no
 * evaluation at all is correctly absent rather than surfaced as a failure.
 */
async function getOrganizationFailingGateEvaluations(organizationId: string): Promise<GateFailureRow[]> {
  return query<GateFailureRow>(
    `select
       ath.athlete_id,
       g.gate_key,
       g.name as gate_name,
       g.category,
       latest.outcome,
       latest.evaluated_at::text
     from pilot.athletes ath
     join pilot.safety_gates g
       on g.organization_id = ath.organization_id and g.active_flag = true
     join lateral (
       select outcome, evaluated_at
       from pilot.safety_gate_evaluations e
       where e.organization_id = ath.organization_id
         and e.gate_key = g.gate_key
         and e.athlete_id = ath.athlete_id
       order by e.evaluated_at desc
       limit 1
     ) latest on true
     where ath.organization_id = $1
       and ath.active_flag = true
       and latest.outcome <> 'passed'
     order by ath.full_name, g.name`,
    [organizationId],
  );
}

const OPEN_VIOLATION_STATUSES = new Set<ComplianceViolation['status']>(['new', 'acknowledged', 'escalated']);

export async function getOrganizationSafetyReview(organizationId: string): Promise<OrganizationSafetyReview> {
  const [holds, gateFailures, escalations, violations, athleteNames] = await Promise.all([
    listTrainingHolds(organizationId, { status: 'active' }),
    getOrganizationFailingGateEvaluations(organizationId),
    listEscalations(organizationId, {}),
    getOrganizationViolations(organizationId, { limit: 200 }),
    query<{ athlete_id: string; full_name: string }>(
      `select athlete_id, full_name from pilot.athletes where organization_id = $1`,
      [organizationId],
    ),
  ]);

  const nameByAthlete = new Map(athleteNames.map((row) => [row.athlete_id, row.full_name]));
  const nameFor = (athleteId: string): string | null => nameByAthlete.get(athleteId) ?? null;

  return {
    openHolds: holds.map((hold) => ({ ...hold, athlete_name: nameFor(hold.athlete_id) })),
    failingGates: gateFailures.map((row) => ({
      athlete_id: row.athlete_id,
      athlete_name: nameFor(row.athlete_id),
      gate_key: row.gate_key,
      gate_name: row.gate_name,
      category: row.category,
      outcome: row.outcome as Exclude<SafetyGateOutcome, 'passed'>,
      evaluated_at: row.evaluated_at,
    })),
    openEscalations: escalations
      .filter((escalation) => escalation.status !== 'resolved')
      .map((escalation) => ({ ...escalation, athlete_name: nameFor(escalation.athlete_id) })),
    openViolations: violations
      .filter((violation) => OPEN_VIOLATION_STATUSES.has(violation.status))
      .map((violation) => ({ ...violation, athlete_name: nameFor(violation.athlete_id) })),
  };
}

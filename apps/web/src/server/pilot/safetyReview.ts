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
 * own existing list functions, so an admin sees what is open across all four
 * without clicking between four pages.
 *
 * It is NOT "everything open", and the phrase is avoided deliberately: the
 * compliance-violations feed is capped (VIOLATION_ROLLUP_READ_LIMIT) and
 * filtered to open statuses after that cap. `violationsTruncated` carries
 * that fact to the caller so the screen states its window instead of
 * implying it has none.
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

/**
 * How many compliance violations the rollup reads before filtering to the
 * open ones.
 *
 * This is the one capped feed of the four. Holds, escalations and the
 * gate-failure query all read the organization entire; getOrganizationViolations
 * is `order by created_at desc limit N`, and the filter to open statuses
 * happens HERE, after the cap. Cap first, filter second: an open violation
 * older than the newest N never reaches the status filter at all.
 *
 * Widening the read is a separate product decision (it needs a pager or a
 * status-filtered query, neither of which belongs in a rollup). What this
 * module owes its callers meanwhile is the truth that the feed was cut --
 * hence the +1 probe below and `violationsTruncated`, so no screen can call
 * this list "everything open".
 */
export const VIOLATION_ROLLUP_READ_LIMIT = 200;

export interface OrganizationSafetyReview {
  openHolds: SafetyReviewHoldItem[];
  failingGates: SafetyReviewGateFailureItem[];
  openEscalations: SafetyReviewEscalationItem[];
  openViolations: SafetyReviewViolationItem[];
  /** The cap applied to the compliance-violations feed before status filtering. */
  violationsReadLimit: number;
  /** True when the gym holds more violations than the rollup read. */
  violationsTruncated: boolean;
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
    // One row past the cap, so the count itself tells us whether the gym holds
    // more than this rollup read. Same probe intake.ts and painReportAlert.ts
    // already use for their own capped reads.
    getOrganizationViolations(organizationId, { limit: VIOLATION_ROLLUP_READ_LIMIT + 1 }),
    query<{ athlete_id: string; full_name: string }>(
      `select athlete_id, full_name from pilot.athletes where organization_id = $1`,
      [organizationId],
    ),
  ]);

  const nameByAthlete = new Map(athleteNames.map((row) => [row.athlete_id, row.full_name]));
  const nameFor = (athleteId: string): string | null => nameByAthlete.get(athleteId) ?? null;

  // Drop the probe row before anything renders it, but keep what it told us.
  const violationsTruncated = violations.length > VIOLATION_ROLLUP_READ_LIMIT;
  const violationsInWindow = violations.slice(0, VIOLATION_ROLLUP_READ_LIMIT);

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
    openViolations: violationsInWindow
      .filter((violation) => OPEN_VIOLATION_STATUSES.has(violation.status))
      .map((violation) => ({ ...violation, athlete_name: nameFor(violation.athlete_id) })),
    violationsReadLimit: VIOLATION_ROLLUP_READ_LIMIT,
    violationsTruncated,
  };
}

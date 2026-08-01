import { emitShadowEvent } from '../shadowEvents';
import { flagNearMiss } from '../shadowNearMisses';
import type { ShadowNearMissSeverity } from '../shadowNearMisses';

/**
 * The observation kind an athlete's pain report arrives as.
 *
 * A severity of zero is not a pain report -- it is the absence of pain -- and a
 * null value is "no reading", so neither raises anything.
 */
export const PAIN_REPORT_KIND = 'pain_report';

export function isPainReport(kind: string, value: number | null): boolean {
  return kind === PAIN_REPORT_KIND && value !== null && value > 0;
}

/**
 * Severity band for a 1-10 self-reported pain score.
 *
 * Never 'low': a minor taking the trouble to report pain is always worth a
 * human look, and the band only decides the order a coach sees it in
 * (listRecentNearMisses sorts severity-first).
 */
function severityForPain(value: number): ShadowNearMissSeverity {
  if (value >= 7) return 'critical';
  if (value >= 4) return 'high';
  return 'moderate';
}

function dimensionText(
  dimensions: Readonly<Record<string, string | number | boolean | null>>,
  key: string,
): string | null {
  const value = dimensions[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function describe(
  athleteId: string,
  value: number,
  dimensions: Readonly<Record<string, string | number | boolean | null>>,
): string {
  const location = dimensionText(dimensions, 'location') ?? 'an unspecified location';
  const painType = dimensionText(dimensions, 'painType');

  return `Athlete ${athleteId} reported pain at ${location}`
    + `${painType ? ` (${painType})` : ''} at severity ${value}/10. `
    + 'Self-reported by the athlete, not assessed by a coach or a medical provider.';
}

export interface PainReportAlertOutcome {
  /** True when a coach-visible record was raised for this pain report. */
  readonly raised: boolean;
  readonly severity?: ShadowNearMissSeverity;
}

/**
 * Puts an athlete's pain report in front of a coach.
 *
 * Two writes, because the two coach surfaces read different stores and neither
 * alone is enough: the near miss is the reviewable safety record on the
 * decision-loop surface and in SHADOW's athlete context, and the shadow event
 * is what puts the report in the observation feed the coach workspace loads on
 * its own, so nobody has to know to go looking for it.
 *
 * Fails toward alerting, matching contactClearanceGate.ts: callers run this
 * BEFORE persisting the observation, so a database problem here aborts the
 * whole request instead of storing pain nobody was told about. The observation
 * write is idempotency-keyed, so the athlete's retry is safe.
 */
export async function alertCoachToPainReport(input: {
  organizationId: string;
  athleteId: string;
  kind: string;
  value: number | null;
  dimensions: Readonly<Record<string, string | number | boolean | null>>;
  actorAccountId: string;
  actorRole: string;
  contextId: string;
  observedAt: string;
}): Promise<PainReportAlertOutcome> {
  if (!isPainReport(input.kind, input.value)) {
    return { raised: false };
  }

  const value = input.value as number;
  const severity = severityForPain(value);

  await flagNearMiss({
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    description: describe(input.athleteId, value, input.dimensions),
    severity,
    detectedBy: 'system',
    detectedByAccountId: input.actorAccountId,
    detectedByRole: input.actorRole,
    metadata: {
      trigger: 'athlete_pain_report',
      severity_1_10: value,
      location: input.dimensions.location ?? null,
      pain_type: input.dimensions.painType ?? null,
      context_id: input.contextId,
      observed_at: input.observedAt,
    },
  });

  // 'PENDING' is load-bearing: shadowReadModels.toReviewState reads it out of
  // the event name to show the coach that this item is still unreviewed.
  await emitShadowEvent({
    organizationId: input.organizationId,
    eventName: 'SHADOW_ATHLETE_PAIN_REPORT_PENDING_REVIEW',
    entityType: 'athlete',
    entityId: input.athleteId,
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    payload: {
      athlete_id: input.athleteId,
      severity_1_10: value,
      near_miss_severity: severity,
      location: input.dimensions.location ?? null,
      pain_type: input.dimensions.painType ?? null,
      context_id: input.contextId,
      observed_at: input.observedAt,
    },
  });

  return { raised: true, severity };
}

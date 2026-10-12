/**
 * How a pain report reads on a screen: the number only (owner ruling
 * 2026-10-12 on #1528, "A: Show the number only").
 *
 * A self-reported 2 out of 10 reads "2/10", with no severity word next to it.
 * The stored severity (severityForPain in formulas/painReportAlert.ts) is
 * unchanged and still decides the badge tone, the order and whether an
 * escalation is filed. Only the text a person reads changes.
 *
 * Client-safe: no server imports.
 */

/**
 * The trigger painReportAlert.ts writes on every pain near miss
 * (metadata.trigger). A repeated-pattern escalation carries it as
 * metadata.trigger_key.
 */
export const PAIN_REPORT_TRIGGER = 'athlete_pain_report';

/** "N/10", or a plain statement that no score was recorded. */
export function painScoreLabel(score: number | null | undefined): string {
  return typeof score === 'number' && Number.isFinite(score) ? `${score}/10` : 'Score not recorded';
}

/** The score a pain near miss carries in metadata.severity_1_10, if any. */
export function painScoreFromMetadata(metadata: unknown): number | null {
  const score = (metadata as { severity_1_10?: unknown } | null | undefined)?.severity_1_10;
  return typeof score === 'number' && Number.isFinite(score) ? score : null;
}

/** True for a near miss filed from a pain report. */
export function isPainReportNearMiss(metadata: unknown): boolean {
  return (metadata as { trigger?: unknown } | null | undefined)?.trigger === PAIN_REPORT_TRIGGER;
}

/**
 * True for an escalation filed from a pain report: one filed from a pain near
 * miss (metadata.trigger) or a repeated-pattern escalation over pain reports
 * (metadata.trigger_key). Such an escalation stores no score, so its badge
 * reads PAIN_ESCALATION_LABEL; the score is in its reason text.
 */
export function isPainReportEscalation(metadata: unknown): boolean {
  const m = metadata as { trigger?: unknown; trigger_key?: unknown } | null | undefined;
  return m?.trigger === PAIN_REPORT_TRIGGER || m?.trigger_key === PAIN_REPORT_TRIGGER;
}

export const PAIN_ESCALATION_LABEL = 'Pain report';

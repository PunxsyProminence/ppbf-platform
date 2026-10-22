// How much an athlete enjoyed the session, tapped at check-out beside the
// effort answer (OD-2026-10-17-026 (a), Jason: "A: All three (Rec.)" -- "a 1-5
// enjoyment tap beside the end-of-session effort rating"). Enjoyment after
// training is a different signal from motivation before it (research draft
// MORE-ATHLETE-METRICS-2026-10-18, section 3.7).
//
// SHARED so the server validates against the same scale the athlete taps, and
// matched to pilot_sessions_enjoyment_range in
// pilot_slice_postgres_athlete_metrics_migration.sql. Optional: null is "not
// answered", and nothing fills it in. The answer is the athlete's own, read by
// staff; it is withheld from athlete and family session reads
// (familyRecordView.ts SESSION_WITHHELD_FROM_FAMILY_FIELDS) until a ruling
// says who reads it back. Labels are PROPOSED copy.

export const ENJOYMENT_QUESTION = 'How much did you enjoy it?';

export const ENJOYMENT_LEVELS = [
  { value: 1, label: 'Not at all' },
  { value: 2, label: 'A little' },
  { value: 3, label: 'Some' },
  { value: 4, label: 'A lot' },
  { value: 5, label: 'Loved it' },
] as const;

export type EnjoymentLevel = (typeof ENJOYMENT_LEVELS)[number]['value'];

export function isEnjoymentLevel(value: unknown): value is EnjoymentLevel {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
}

export function enjoymentLabel(value: EnjoymentLevel): string {
  return ENJOYMENT_LEVELS.find((level) => level.value === value)?.label ?? String(value);
}

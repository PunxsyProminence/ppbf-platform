import { query } from '../db';
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

/**
 * The shadow event name a pain report is written under.
 *
 * Exported rather than repeated as a literal: shadowReadModels.toReviewState
 * already depends on the substring 'PENDING' inside this name, and
 * getShadowObservationProjection depends on the exact string to recognize a
 * pain-report event and build a human label from its payload. A drifted copy
 * in either place silently breaks one of those without the other noticing.
 */
export const PAIN_REPORT_PENDING_REVIEW_EVENT_NAME = 'SHADOW_ATHLETE_PAIN_REPORT_PENDING_REVIEW';

/**
 * The metadata marker every pain-report near miss is written with, and the only
 * thing that distinguishes one from a hand-flagged near miss on read.
 *
 * It is a stored value, not a label: changing it orphans every report already
 * in the database from the coach's alert, so the read path below and the write
 * path further down share this constant rather than repeating the string.
 */
const PAIN_REPORT_TRIGGER = 'athlete_pain_report';

/**
 * How far back the coach's pain-report alert looks.
 *
 * A pain report is not dismissible -- ageing out of this window is the only
 * thing that removes it from the coach's screen -- so the window is the whole
 * retention decision, and callers surface it to the coach rather than writing
 * the number into copy that can drift away from it.
 */
export const PAIN_REPORT_ALERT_WINDOW_DAYS = 7;

export function isPainReport(kind: string, value: number | null): boolean {
  return kind === PAIN_REPORT_KIND && value !== null && value > 0;
}

function assertValidPainReportSeverity(kind: string, value: number | null): void {
  if (kind !== PAIN_REPORT_KIND || value === null || value <= 0) return;
  if (!Number.isFinite(value) || value > 10) {
    throw new RangeError('Pain report severity must be a finite value from 1 through 10.');
  }
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

export type PainReporter = 'athlete' | 'coach' | 'staff_admin' | 'unknown';

export function classifyPainReporter(actorRole: string | null | undefined): PainReporter {
  if (actorRole === 'athlete') return 'athlete';
  if (actorRole === 'coach') return 'coach';
  if (actorRole === 'organization_admin' || actorRole === 'admin') return 'staff_admin';
  return 'unknown';
}

export function readPainReporter(stored: string | null | undefined): PainReporter {
  return stored === 'athlete' || stored === 'coach' || stored === 'staff_admin'
    ? stored
    : 'unknown';
}

function describe(
  athleteId: string,
  value: number,
  dimensions: Readonly<Record<string, string | number | boolean | null>>,
  reporter: PainReporter,
): string {
  const location = dimensionText(dimensions, 'location') ?? 'an unspecified location';
  const painType = dimensionText(dimensions, 'painType');
  const head = `Athlete ${athleteId} reported pain at ${location}`
    + `${painType ? ` (${painType})` : ''} at severity ${value}/10. `;
  const provenance: Record<PainReporter, string> = {
    athlete: 'Self-reported by the athlete, not assessed by a coach or a medical provider.',
    coach: 'Entered by a coach, not self-reported by the athlete. This is an observation, not a medical assessment.',
    staff_admin: 'Entered by staff, not self-reported by the athlete. This is an observation, not a medical assessment.',
    unknown: 'The reporter of this observation is not recorded. Do not read it as self-reported by the athlete. This is an observation, not a medical assessment.',
  };
  return head + provenance[reporter];
}

export interface PainReportAlertOutcome {
  readonly raised: boolean;
  readonly severity?: ShadowNearMissSeverity;
}

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
  const reporter = classifyPainReporter(input.actorRole);

  await flagNearMiss({
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    description: describe(input.athleteId, value, input.dimensions, reporter),
    severity,
    detectedBy: 'system',
    detectedByAccountId: input.actorAccountId,
    detectedByRole: input.actorRole,
    metadata: {
      trigger: PAIN_REPORT_TRIGGER,
      severity_1_10: value,
      location: input.dimensions.location ?? null,
      pain_type: input.dimensions.painType ?? null,
      context_id: input.contextId,
      observed_at: input.observedAt,
      reporter_role: reporter,
    },
  });

  await emitShadowEvent({
    organizationId: input.organizationId,
    eventName: PAIN_REPORT_PENDING_REVIEW_EVENT_NAME,
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
      reporter_role: reporter,
    },
  });

  return { raised: true, severity };
}

export interface CoachPainReport {
  readonly nearMissId: string;
  readonly athleteId: string;
  readonly athleteName: string | null;
  readonly severity: ShadowNearMissSeverity;
  readonly painScore: number | null;
  readonly location: string | null;
  readonly painType: string | null;
  readonly observedAt: string | null;
  readonly recordedAt: string | null;
  readonly reporter: PainReporter;
}

export interface CoachPainReportPage {
  readonly reports: readonly CoachPainReport[];
  readonly truncated: boolean;
}

interface CoachPainReportRow {
  near_miss_id: string;
  athlete_id: string;
  athlete_name: string | null;
  severity: ShadowNearMissSeverity;
  metadata: Record<string, unknown> | null;
  created_at: Date | string | null;
}

function metadataText(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isoText(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function toCoachPainReport(row: CoachPainReportRow): CoachPainReport {
  const metadata = row.metadata ?? {};
  const score = metadata.severity_1_10;
  return {
    nearMissId: row.near_miss_id,
    athleteId: row.athlete_id,
    athleteName: typeof row.athlete_name === 'string' && row.athlete_name.trim().length > 0
      ? row.athlete_name.trim()
      : null,
    severity: row.severity,
    painScore: typeof score === 'number' && Number.isFinite(score) ? score : null,
    location: metadataText(metadata, 'location'),
    painType: metadataText(metadata, 'pain_type'),
    observedAt: isoText(metadata.observed_at),
    recordedAt: isoText(row.created_at),
    reporter: readPainReporter(metadataText(metadata, 'reporter_role')),
  };
}

export async function listAthletesWithRecentPainReports(
  organizationId: string,
  windowDays: number = PAIN_REPORT_ALERT_WINDOW_DAYS,
): Promise<string[]> {
  const rows = await query<{ athlete_id: string }>(
    `select distinct athlete_id
     from pilot.shadow_near_misses
     where organization_id = $1
       and metadata->>'trigger' = $2
       and created_at > now() - ($3 * interval '1 day')`,
    [organizationId, PAIN_REPORT_TRIGGER, windowDays],
  );
  return rows.map((row) => row.athlete_id);
}

export async function listPainReportsForAthletes(
  organizationId: string,
  athleteIds: readonly string[],
  options: { windowDays?: number; limit: number },
): Promise<CoachPainReportPage> {
  if (athleteIds.length === 0) {
    return { reports: [], truncated: false };
  }
  const windowDays = options.windowDays ?? PAIN_REPORT_ALERT_WINDOW_DAYS;
  const rows = await query<CoachPainReportRow>(
    `select n.near_miss_id,
            n.athlete_id,
            a.full_name as athlete_name,
            n.severity,
            n.metadata,
            n.created_at
     from pilot.shadow_near_misses n
     left join pilot.athletes a
       on a.organization_id = n.organization_id and a.athlete_id = n.athlete_id
     where n.organization_id = $1
       and n.athlete_id = any($2::text[])
       and n.metadata->>'trigger' = $3
       and n.created_at > now() - ($4 * interval '1 day')
     order by
       case n.severity
         when 'critical' then 0
         when 'high' then 1
         when 'moderate' then 2
         else 3
       end asc,
       n.created_at desc
     limit $5`,
    [organizationId, [...athleteIds], PAIN_REPORT_TRIGGER, windowDays, options.limit + 1],
  );
  return {
    reports: rows.slice(0, options.limit).map(toCoachPainReport),
    truncated: rows.length > options.limit,
  };
}

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

/**
 * Who reported the pain, as a bounded classification.
 *
 * The observations route admits four roles -- athlete, coach,
 * organization_admin and admin -- and until 2026-08-24 every downstream
 * sentence said the athlete had self-reported. A coach typing what they saw
 * was rendered to the next coach as the child's own words.
 *
 * organization_admin and admin collapse into one value on purpose. The
 * distinction between them is an administrative one that changes nothing about
 * how a coach should read the report, and this classification travels to a
 * screen showing a minor's health information -- so it carries what changes the
 * reading and stops there. No account id is exposed, ever.
 */
export type PainReporter = 'athlete' | 'coach' | 'staff_admin' | 'unknown';

/**
 * Maps an actor role onto the bounded classification.
 *
 * Anything unrecognised is 'unknown', not 'athlete'. That direction matters: an
 * unknown reporter described as the athlete is a fabricated attribution on a
 * medical-adjacent record, while an athlete report described as unknown is
 * merely less specific than it could be.
 */
export function classifyPainReporter(actorRole: string | null | undefined): PainReporter {
  if (actorRole === 'athlete') return 'athlete';
  if (actorRole === 'coach') return 'coach';
  if (actorRole === 'organization_admin' || actorRole === 'admin') return 'staff_admin';
  return 'unknown';
}

/**
 * Validates an ALREADY-CLASSIFIED value read back off a stored row.
 *
 * Distinct from `classifyPainReporter`, which maps an actor ROLE. Feeding a
 * stored classification through the role classifier looks equivalent and is
 * not: 'athlete' and 'coach' happen to be valid in both vocabularies, but
 * 'staff_admin' is a classification that is not a role, so it resolved to
 * 'unknown' and every organization_admin/admin report silently lost its
 * provenance on the way to the coach's screen. A regression test caught that.
 *
 * Unrecognised input is 'unknown', in the same direction as everything else
 * here: never invent an attribution.
 */
export function readPainReporter(stored: string | null | undefined): PainReporter {
  return stored === 'athlete' || stored === 'coach' || stored === 'staff_admin'
    ? stored
    : 'unknown';
}

/**
 * The description a coach reads, which must not claim a self-report that did
 * not happen.
 *
 * Only the athlete's own report is described as self-reported. A staff-entered
 * observation says who entered it and says plainly that it is not a medical
 * assessment -- because a coach reading "athlete reported pain 8/10" acts
 * differently from one reading "a colleague wrote down that this athlete seemed
 * to be in pain", and the platform was showing the first sentence for both.
 *
 * An unestablished reporter says so rather than guessing.
 */
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
    athlete:
      'Self-reported by the athlete, not assessed by a coach or a medical provider.',
    coach:
      'Entered by a coach, not self-reported by the athlete. This is an '
      + 'observation, not a medical assessment.',
    staff_admin:
      'Entered by staff, not self-reported by the athlete. This is an '
      + 'observation, not a medical assessment.',
    unknown:
      'The reporter of this observation is not recorded. Do not read it as '
      + 'self-reported by the athlete. This is an observation, not a medical '
      + 'assessment.',
  };

  return head + provenance[reporter];
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
      // PROVENANCE, PERSISTED ON THE ROW.
      //
      // `detectedByRole` above does NOT land here: pilot.shadow_near_misses has
      // detected_by_account_id but no detected_by_role column, so that argument
      // reaches only the audit event and the escalation. Every pain report
      // written before 2026-08-24 therefore has no reporter role anywhere on
      // its row, which is why the read path resolves those to 'unknown' rather
      // than assuming.
      //
      // It goes in metadata rather than in a new column because metadata is
      // already how this record carries its own shape (`trigger` is the only
      // thing distinguishing a pain report from a hand-flagged near miss), and
      // a migration is not needed to stop writing a false sentence.
      reporter_role: reporter,
    },
  });

  // 'PENDING' is load-bearing: shadowReadModels.toReviewState reads it out of
  // the event name to show the coach that this item is still unreviewed.
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
      // Carried on the payload as well as in actor_role, so a projection can
      // label the event without joining, and so the classification the coach
      // sees is the one that was computed at write time.
      reporter_role: reporter,
    },
  });

  return { raised: true, severity };
}

/**
 * One athlete's pain report, shaped for the coach who is allowed to see it.
 *
 * Every optional field is optional because the athlete may not have supplied
 * it, never because it was lost on the way here. A null is rendered as "not
 * stated", never as a stand-in value: a body location the coach invents is
 * worse than one they know they have to ask for.
 *
 * Carries exactly the fields the coach's screen shows and nothing more. This
 * is a minor's health information leaving the server, so an unused field is
 * not free.
 */
export interface CoachPainReport {
  readonly nearMissId: string;
  readonly athleteId: string;
  /** Null only when the athlete row is gone; the caller names the id instead. */
  readonly athleteName: string | null;
  readonly severity: ShadowNearMissSeverity;
  readonly painScore: number | null;
  readonly location: string | null;
  readonly painType: string | null;
  /** When the reporter says it happened -- not necessarily the athlete. */
  readonly observedAt: string | null;
  /** When the platform recorded it. */
  readonly recordedAt: string | null;
  /**
   * Who reported it, bounded to what changes how a coach should read it.
   *
   * 'unknown' on every report written before provenance was persisted, and on
   * any row whose stored value is not one this platform recognises. It is a
   * real answer, not a gap to paper over: the alternative is telling a coach a
   * child said something when nobody knows who said it.
   *
   * No account id accompanies this. The classification is the whole point --
   * the coach needs to know whether the athlete spoke, not who the individual
   * was.
   */
  readonly reporter: PainReporter;
}

export interface CoachPainReportPage {
  readonly reports: readonly CoachPainReport[];
  /** True when more reports matched than were returned, so the list is partial. */
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
    // Read back through the same classifier that wrote it, so a stored value
    // this build does not recognise resolves to 'unknown' rather than leaking
    // a raw role string onto a coach's screen.
    reporter: readPainReporter(metadataText(metadata, 'reporter_role')),
  };
}

/**
 * The athletes with a pain report inside the alert window, before any
 * authorization is applied.
 *
 * Deliberately returns identifiers only and nothing about the reports: the
 * caller runs each id past access.ts and drops the ones it refuses, so an
 * unauthorized coach never receives a field that would tell them a report
 * exists. Bounded by the roster rather than by the report count.
 */
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

/**
 * The pain reports for an already-authorized set of athletes.
 *
 * Severity-first, matching listRecentNearMisses, so a critical report is never
 * pushed off the end of the list by newer moderate ones. One extra row is read
 * beyond the limit purely to answer whether the list is complete -- a coach
 * reading a capped list as the whole set is the same false-reassurance failure
 * as an empty list after a failed read.
 */
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

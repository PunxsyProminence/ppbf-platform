import { NextResponse, type NextRequest } from 'next/server';

import {
  type ActorIdentity,
  assertActorCanAccessAthlete,
  assertAthleteBelongsToOrganization,
  isOrganizationAdminRole,
  requireRole,
} from '@/src/server/pilot/access';
import {
  CONTACT_STAGES,
  type CapReading,
  type CapWarning,
  type ContactStage,
  entryCapWarnings,
  readCapForEntry,
} from '@/src/server/pilot/athleteContactCaps';
import { gymToday } from '@/src/server/pilot/competenceCohorts';
import { ConflictError, ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { type LinkedClip, listLinkedClipsForExposures } from '@/src/server/pilot/videoClipTags';
import {
  type AthletePresentation,
  type CoachObservedHeadContact,
  type CoachObservedIntensity,
  countHardOrOpenSparringDays,
  getSparringExposureCounts,
  listActiveUniversalStopRules,
  listSparringExposure,
  type RecordSparringExposureInput,
  recordSparringExposure,
  type SparringType,
} from '@/src/server/pilot/sparringExposure';

export const runtime = 'nodejs';

// Coach floor entry for sparring exposure: one record per sparring segment
// for one athlete, and a read of that athlete's recent records.
//
// WHO. Coaches and organization admins (organization_admin, admin), and for
// each request only for an athlete assertActorCanAccessAthlete admits: a coach
// of record or a coach holding a live coverage grant; an org admin for any
// live athlete in their own gym. That gate refuses deleted athletes, other
// gyms' athletes, platform_owner and board. Athletes and parents stop at the
// role gate. The organization is always the principal's own; there is no
// organization_id parameter.
//
// WHAT IS RECORDED, AND BY WHOM. The supervising account is the principal --
// never a body field -- so a record always names who actually entered it. The
// row is UNLINKED (no activity_log row) and carries the gym day, per
// pilot_slice_postgres_sparring_exposure_session_date_migration.sql; this
// route therefore writes no attendance, tenure or hours. Device fields are
// reserved for a validated sensor and are not accepted here.
//
// WHAT IS REFUSED, matching the sparring migration's own header and Jason's
// standing refusal: no damage score, no cumulative risk index, no recommended
// limit, no clearance. GET returns the stored rows and raw counts (segments by
// type, a raw sum of seconds) and nothing derived. A coach reads them and
// decides.
//
// STRICT BODY. Every key must be one this route knows; anything else is
// refused rather than silently dropped, so a client cannot believe it stored a
// field it did not. To add a field (e.g. a ladder stage), add it to
// ENTRY_FIELDS and parseEntry together.
//
// THE CAP CHECK (map item 15). An entry may carry its contact-ladder stage
// (optional; omitted = not recorded). Both GET and POST return `cap_check`:
// the coach-set cap for this athlete ('set' / 'none' = no cap set / 'unknown'
// = could not be read -- never shown as no cap) and the raw count of gym days
// with hard or open sparring in the 7 gym days ending today (GET) or on the
// entry's day (POST, entry included). POST adds `warnings` when the saved
// entry is above the cap. WARN ONLY (Jason, 2026-10-04): the entry has
// already saved when the check runs, and nothing here refuses it. Sessions =
// gym days.

const SPARRING_ROLES = ['coach', 'organization_admin', 'admin'] as const;

const SPARRING_TYPES: readonly SparringType[] = ['hard', 'play', 'technical', 'game', 'conditioned'];
const INTENSITIES: readonly CoachObservedIntensity[] = ['light', 'moderate', 'firm', 'unclear'];
const HEAD_CONTACT: readonly CoachObservedHeadContact[] = ['none', 'incidental', 'regular', 'frequent', 'unclear'];
const PRESENTATIONS: readonly AthletePresentation[] = ['normal', 'slowed', 'unsteady', 'withdrawn', 'other_concern'];

const ENTRY_FIELDS: ReadonlySet<string> = new Set([
  'athlete_id',
  'session_date',
  'sparring_type',
  'contact_stage',
  'time_under_impact_sec',
  'round_equivalent',
  'partner_athlete_id',
  'headgear_worn',
  'glove_oz',
  'coach_observed_intensity',
  'coach_observed_head_contact',
  'athlete_presentation',
  'coach_note',
  'stopped_early',
  'stop_rule_id',
  'stop_reason',
]);

const NOTE_MAX = 2000;
const STOP_REASON_MAX = 500;
const DEFAULT_WINDOW_DAYS = 28;
const MAX_WINDOW_DAYS = 365;
const ENTRY_LIMIT = 100;

function requiredEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`Unsupported ${field}: must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function optionalStage(value: unknown): ContactStage | null {
  if (value === undefined || value === null) return null;
  return requiredEnum(value, 'contact_stage', CONTACT_STAGES);
}

function actorOf(principal: { accountId: string; role: ActorIdentity['role']; organizationId: string; athleteId: string | null }): ActorIdentity {
  return {
    accountId: principal.accountId,
    role: principal.role,
    organizationId: principal.organizationId,
    athleteId: principal.athleteId,
  };
}

interface CapCheck {
  cap_state: CapReading['state'];
  cap: CapReading['cap'];
  /** Raw count; sessions = gym days. Null = could not be counted (never shown as 0). */
  hard_open_days_in_7: number | null;
  /** The last of those 7 gym days. */
  through_day: string;
  warnings?: CapWarning[];
}

/**
 * Never throws: on POST the entry has already saved, and on GET the entries
 * are what the coach came for. A cap that cannot be read is 'unknown'; a count
 * that cannot be taken is null; neither is shown as "no cap" or "0".
 */
async function capCheck(
  actor: ActorIdentity,
  athleteId: string,
  throughDay: string,
  entry?: { contactStage: ContactStage | null; sparringType: string },
): Promise<CapCheck> {
  const [reading, days] = await Promise.all([
    // readCapForEntry already never throws; this keeps that true here even if
    // it changes, because a throw now would report a SAVED entry as failed.
    Promise.resolve().then(() => readCapForEntry(actor, athleteId)).catch((error: unknown): CapReading => {
      console.error({ event: 'sparring-cap-read-failed', name: error instanceof Error ? error.name : 'unknown' });
      return { state: 'unknown', cap: null };
    }),
    Promise.resolve().then(() => countHardOrOpenSparringDays(actor.organizationId, athleteId, throughDay)).catch((error: unknown) => {
      console.error({ event: 'sparring-hard-open-count-failed', name: error instanceof Error ? error.name : 'unknown' });
      return null;
    }),
  ]);
  const check: CapCheck = {
    cap_state: reading.state,
    cap: reading.cap,
    hard_open_days_in_7: days,
    through_day: throughDay,
  };
  if (entry) {
    check.warnings = entryCapWarnings(reading, { ...entry, sparringDay: throughDay }, days);
  }
  return check;
}

function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw new ValidationError(`Unsupported ${field}: must be true or false`);
  return value;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError(`Unsupported ${field}: must be text`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new ValidationError(`Unsupported ${field}: at most ${max} characters`);
  return trimmed === '' ? null : trimmed;
}

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** A gym day N days before another, both YYYY-MM-DD (calendar arithmetic, no time zone). */
function daysBefore(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - days);
  return at.toISOString().slice(0, 10);
}

function parseSessionDate(value: unknown): string {
  const today = gymToday();
  if (value === undefined || value === null) return today;
  if (typeof value !== 'string' || !isRealDate(value)) {
    throw new ValidationError('Unsupported session_date: must be a date (YYYY-MM-DD)');
  }
  // YYYY-MM-DD compares correctly as text.
  if (value > today) throw new ValidationError('Unsupported session_date: cannot be after today');
  // Catching up a paper sheet is fine; a year-old date is a typo. The bound
  // is the GET window's own (MAX_WINDOW_DAYS gym days, today inclusive), so
  // anything accepted here can still be read back.
  if (value < daysBefore(today, MAX_WINDOW_DAYS - 1)) {
    throw new ValidationError(`Unsupported session_date: at most ${MAX_WINDOW_DAYS} days ago`);
  }
  return value;
}

type ParsedEntry = Omit<RecordSparringExposureInput, 'organizationId' | 'supervisingCoachAccountId'>;

function parseEntry(body: Record<string, unknown>): ParsedEntry {
  for (const key of Object.keys(body)) {
    if (!ENTRY_FIELDS.has(key)) throw new ValidationError(`Unsupported field: ${key}`);
  }

  const athleteId = typeof body.athlete_id === 'string' ? body.athlete_id.trim() : '';
  if (!athleteId) throw new ValidationError('Missing athlete_id.');

  const time = body.time_under_impact_sec;
  if (typeof time !== 'number' || !Number.isInteger(time) || time < 1 || time > 1800) {
    throw new ValidationError('Unsupported time_under_impact_sec: whole seconds from 1 to 1800');
  }

  let roundEquivalent: number | null = null;
  if (body.round_equivalent !== undefined && body.round_equivalent !== null) {
    const rounds = body.round_equivalent;
    // The column is numeric(4,2): anything finer than hundredths would be
    // silently rounded, and 0.004 would be stored as the 0 this refuses.
    const hundredths = typeof rounds === 'number' ? Math.round(rounds * 100) : NaN;
    if (
      typeof rounds !== 'number' || !Number.isFinite(rounds)
      || Math.abs(rounds * 100 - hundredths) > 1e-9 || hundredths < 1 || hundredths > 9999
    ) {
      throw new ValidationError('Unsupported round_equivalent: 0.01 to 99.99, in hundredths at most');
    }
    roundEquivalent = rounds;
  }

  let gloveOz: number | null = null;
  if (body.glove_oz !== undefined && body.glove_oz !== null) {
    const oz = body.glove_oz;
    if (typeof oz !== 'number' || !Number.isInteger(oz) || oz < 8 || oz > 20) {
      throw new ValidationError('Unsupported glove_oz: whole ounces from 8 to 20');
    }
    gloveOz = oz;
  }

  const partnerAthleteId = optionalText(body.partner_athlete_id, 'partner_athlete_id', 200);
  if (partnerAthleteId === athleteId) {
    throw new ValidationError('Unsupported partner_athlete_id: cannot be the athlete being recorded');
  }

  const stoppedEarly = optionalBoolean(body.stopped_early, 'stopped_early') ?? false;
  const stopRuleId = optionalText(body.stop_rule_id, 'stop_rule_id', 200);
  const stopReason = optionalText(body.stop_reason, 'stop_reason', STOP_REASON_MAX);
  if (stoppedEarly && !stopReason) {
    throw new ValidationError('Missing stop_reason: an early stop records what ended it.');
  }
  if (!stoppedEarly && (stopRuleId || stopReason)) {
    throw new ValidationError('Unsupported stop_rule_id/stop_reason: only recorded when stopped_early is true');
  }

  return {
    athleteId,
    sessionDate: parseSessionDate(body.session_date),
    sparringType: requiredEnum(body.sparring_type, 'sparring_type', SPARRING_TYPES),
    contactStage: optionalStage(body.contact_stage),
    timeUnderImpactSec: time,
    roundEquivalent,
    partnerAthleteId,
    headgearWorn: optionalBoolean(body.headgear_worn, 'headgear_worn'),
    gloveOz,
    coachObservedIntensity: requiredEnum(body.coach_observed_intensity, 'coach_observed_intensity', INTENSITIES),
    coachObservedHeadContact: requiredEnum(body.coach_observed_head_contact, 'coach_observed_head_contact', HEAD_CONTACT),
    // The post-sparring check is the reason this screen exists, so it is
    // required here even though the column is nullable.
    athletePresentation: requiredEnum(body.athlete_presentation, 'athlete_presentation', PRESENTATIONS),
    coachNote: optionalText(body.coach_note, 'coach_note', NOTE_MAX) ?? '',
    stoppedEarly,
    stopRuleId,
    stopReason,
  };
}

/*
 * Tagged clips linked to each entry (owner, Jason 2026-10-05, overwatch-
 * relayed: "behind the scenes now"). Tagged clips are for coaches and the
 * organization admin only (OD-2026-10-04-003), so any other role gets no
 * linked_clips at all (undefined). A failed read is null -- "could not
 * check" -- never [] ("no clips"), and it does not fail the sparring record.
 */
async function linkedClips(
  principal: { role: ActorIdentity['role']; organizationId: string },
  athleteId: string,
  exposureIds: string[],
): Promise<Map<string, LinkedClip[]> | null | undefined> {
  if (principal.role !== 'coach' && !isOrganizationAdminRole(principal.role)) return undefined;
  try {
    return await listLinkedClipsForExposures(principal.organizationId, athleteId, exposureIds);
  } catch (error) {
    console.error({
      event: 'sparring-linked-clips-read-failed',
      name: error instanceof Error ? error.name : 'unknown',
      code: (error as { code?: unknown })?.code ?? null,
    });
    return null;
  }
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SPARRING_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim();
    if (!athleteId) throw new ValidationError('Missing athlete_id.');
    await assertActorCanAccessAthlete(principal, athleteId);

    const daysParam = request.nextUrl.searchParams.get('days');
    let windowDays = DEFAULT_WINDOW_DAYS;
    if (daysParam !== null) {
      const days = Number(daysParam);
      if (!Number.isInteger(days) || days < 1 || days > MAX_WINDOW_DAYS) {
        throw new ValidationError(`Unsupported days: whole days from 1 to ${MAX_WINDOW_DAYS}`);
      }
      windowDays = days;
    }
    // Gym days, inclusive: days=1 is today, days=28 is today and the 27 before.
    // Compared against the day sparred, not when the entry was typed.
    const sinceDay = daysBefore(gymToday(), windowDays - 1);

    const [rows, counts, stopRules, check] = await Promise.all([
      listSparringExposure(principal.organizationId, { athleteId, sinceDay, limit: ENTRY_LIMIT + 1 }),
      getSparringExposureCounts(principal.organizationId, athleteId, sinceDay),
      listActiveUniversalStopRules(principal.organizationId),
      capCheck(actorOf(principal), athleteId, gymToday()),
    ]);

    const entries = rows.slice(0, ENTRY_LIMIT);
    const clips = await linkedClips(principal, athleteId, entries.map((entry) => entry.exposure_id));

    // counts covers the whole window; entries stops at ENTRY_LIMIT and says so.
    return NextResponse.json({
      window_days: windowDays,
      since_day: sinceDay,
      entries: entries.map((entry) => ({
        ...entry,
        ...(clips === undefined ? {} : { linked_clips: clips === null ? null : clips.get(entry.exposure_id) ?? [] }),
      })),
      entries_truncated: rows.length > ENTRY_LIMIT,
      counts,
      stop_rules: stopRules,
      cap_check: check,
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SPARRING_ROLES]);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ValidationError('Request body must be JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a JSON object.');
    }

    const entry = parseEntry(body as Record<string, unknown>);
    await assertActorCanAccessAthlete(principal, entry.athleteId);

    if (entry.partnerAthleteId) {
      try {
        await assertAthleteBelongsToOrganization(principal.organizationId, entry.partnerAthleteId);
      } catch (error) {
        // Only the helper's own refusal means "not a partner here"; a database
        // failure stays a 500 through jsonError.
        if (error instanceof Error && error.message.startsWith('Forbidden')) {
          throw new ValidationError('Unsupported partner_athlete_id: not an athlete in this organization');
        }
        throw error;
      }
    }

    if (entry.stopRuleId) {
      const rules = await listActiveUniversalStopRules(principal.organizationId);
      if (!rules.some((rule) => rule.universal_rule_id === entry.stopRuleId)) {
        throw new ValidationError('Unsupported stop_rule_id: not a current stop rule for this organization');
      }
    }

    try {
      const saved = await recordSparringExposure({
        ...entry,
        organizationId: principal.organizationId,
        supervisingCoachAccountId: principal.accountId,
      });
      // After the save, never before: a cap can only warn.
      const check = await capCheck(actorOf(principal), entry.athleteId, saved.session_date ?? gymToday(), {
        contactStage: saved.contact_stage,
        sparringType: saved.sparring_type,
      });
      return NextResponse.json({ entry: saved, cap_check: check }, { status: 201 });
    } catch (error) {
      if (error instanceof Error && error.message === 'SPARRING_EXPOSURE_SEGMENT_DUPLICATE') {
        throw new ConflictError('Another entry for this athlete was saved at the same moment. Try again.');
      }
      throw error;
    }
  } catch (error) {
    return jsonError(error);
  }
}

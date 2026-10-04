import { NextResponse, type NextRequest } from 'next/server';

import {
  assertActorCanAccessAthlete,
  assertAthleteBelongsToOrganization,
  requireRole,
} from '@/src/server/pilot/access';
import { gymToday } from '@/src/server/pilot/competenceCohorts';
import { ConflictError, ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  type AthletePresentation,
  type CoachObservedHeadContact,
  type CoachObservedIntensity,
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

const SPARRING_ROLES = ['coach', 'organization_admin', 'admin'] as const;

const SPARRING_TYPES: readonly SparringType[] = ['hard', 'play', 'technical', 'game', 'conditioned'];
const INTENSITIES: readonly CoachObservedIntensity[] = ['light', 'moderate', 'firm', 'unclear'];
const HEAD_CONTACT: readonly CoachObservedHeadContact[] = ['none', 'incidental', 'regular', 'frequent', 'unclear'];
const PRESENTATIONS: readonly AthletePresentation[] = ['normal', 'slowed', 'unsteady', 'withdrawn', 'other_concern'];

const ENTRY_FIELDS: ReadonlySet<string> = new Set([
  'athlete_id',
  'session_date',
  'sparring_type',
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

function parseSessionDate(value: unknown): string {
  const today = gymToday();
  if (value === undefined || value === null) return today;
  if (typeof value !== 'string' || !isRealDate(value)) {
    throw new ValidationError('Unsupported session_date: must be a date (YYYY-MM-DD)');
  }
  // YYYY-MM-DD compares correctly as text.
  if (value > today) throw new ValidationError('Unsupported session_date: cannot be after today');
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
    if (typeof rounds !== 'number' || !Number.isFinite(rounds) || rounds <= 0 || rounds > 99.99) {
      throw new ValidationError('Unsupported round_equivalent: a number above 0 and at most 99.99');
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
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    const [entries, counts, stopRules] = await Promise.all([
      listSparringExposure(principal.organizationId, { athleteId, since, limit: ENTRY_LIMIT }),
      getSparringExposureCounts(principal.organizationId, athleteId, since),
      listActiveUniversalStopRules(principal.organizationId),
    ]);

    return NextResponse.json({ window_days: windowDays, entries, counts, stop_rules: stopRules });
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
      } catch {
        throw new ValidationError('Unsupported partner_athlete_id: not an athlete in this organization');
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
      return NextResponse.json({ entry: saved }, { status: 201 });
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

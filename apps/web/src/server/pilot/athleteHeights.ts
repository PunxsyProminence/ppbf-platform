import { randomUUID } from 'node:crypto';

import { type ActorIdentity, accessibleAthleteIds, assertActorCanAccessAthlete } from './access';
import { writePilotAuditEvent } from './audit';
import { query, queryOne, withTransaction } from './db';
import { ConflictError, ForbiddenError, ValidationError } from './errors';

/**
 * Standing height a COACH records for one athlete, and the growth rate read
 * from it (OD-2026-10-17-026 (b), Jason: "A: All three (Rec.)" -- coach-entered
 * standing height about every 3 months, growth rate only, no maturity labels).
 *
 * WHAT IT IS FOR. Growth rate, in cm per year, between two readings at least
 * GROWTH_MIN_DAYS apart (Overwatch's GO to L60, 2026-10-17: "growth as cm/year
 * between readings 60 or more days apart"). Nothing here predicts adult
 * height, estimates maturity, stages puberty, or labels an athlete early or
 * late; no cut-off marks a reading as anything. The "baseline may be
 * drifting" mark in the ruling waits for a researched cut-off (Overwatch Q1:
 * "Ship the cm/year rate with no "drift" mark ... inventing one would show
 * something false").
 *
 * WHO. Staff only, both ways: coach, organization_admin, admin, with an
 * ACTIVE membership in this organization in one of those roles, and only for
 * an athlete assertActorCanAccessAthlete lets them reach. Athletes, guardians,
 * board, volunteers and platform_owner get nothing from this module (Overwatch:
 * "coaches only = coach + organization_admin + admin"). The database guard on
 * pilot.athlete_heights enforces the same seat rule for the recorder.
 *
 * APPEND-ONLY. A reading is never changed; a mistyped one is replaced by a new
 * row naming it (supersedes_height_id), and the original stays on record, as
 * OD-2026-10-04-029 keeps a corrected weight. The reading in force is the one
 * nothing supersedes. There is no UPDATE and no DELETE here.
 *
 * ONE SAVE, ONE ROW, ONE AUDIT ROW. Every write carries a request key; a retry
 * with the same key returns the row the first attempt wrote instead of adding
 * a reading. The audit row is written in the reading's own transaction.
 */

export const HEIGHT_ROLES = ['coach', 'organization_admin', 'admin'] as const;
export type HeightRole = (typeof HEIGHT_ROLES)[number];

/** Typing-slip bounds, the same as pilot_athlete_heights_cm_range. Not a norm. */
export const HEIGHT_CM_MIN = 50;
export const HEIGHT_CM_MAX = 250;
/** Two readings closer than this are not turned into a yearly rate. */
export const GROWTH_MIN_DAYS = 60;
/** The readings returned with the panel, newest first. */
export const HEIGHT_HISTORY_LIMIT = 24;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_PER_YEAR = 365.25;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REQUEST_KEY_MAX = 200;

export interface HeightReading {
  height_id: string;
  measured_on: string;
  height_cm: number;
  recorded_by_role: HeightRole;
  recorded_at: string;
  /** The reading this one replaced, when it is a correction. */
  supersedes_height_id: string | null;
  /** True when a later correction replaced this reading. */
  superseded: boolean;
}

export interface GrowthRate {
  from_measured_on: string;
  from_cm: number;
  to_measured_on: string;
  to_cm: number;
  days: number;
  change_cm: number;
  cm_per_year: number;
}

export interface HeightSummary {
  readings: HeightReading[];
  latest: HeightReading | null;
  growth: GrowthRate | null;
}

interface HeightRow {
  height_id: string;
  athlete_id: string;
  measured_on: string;
  height_cm: string;
  recorded_by_role: HeightRole;
  recorded_at: Date | string;
  supersedes_height_id: string | null;
  request_key: string;
  superseded: boolean;
}

const BASE_FIELDS = `h.height_id::text as height_id, h.athlete_id, h.measured_on::text as measured_on,
  h.height_cm::text as height_cm, h.recorded_by_role, h.recorded_at,
  h.supersedes_height_id::text as supersedes_height_id, h.request_key`;
const FIELDS = `${BASE_FIELDS},
  exists (select 1 from pilot.athlete_heights s
           where s.organization_id = h.organization_id and s.supersedes_height_id = h.height_id) as superseded`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toReading(row: HeightRow): HeightReading {
  return {
    height_id: row.height_id,
    measured_on: row.measured_on,
    height_cm: Number(row.height_cm),
    recorded_by_role: row.recorded_by_role,
    recorded_at: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : String(row.recorded_at),
    supersedes_height_id: row.supersedes_height_id,
    superseded: row.superseded === true,
  };
}

/**
 * The actor's role HERE, from its active membership in this organization (not
 * pilot.accounts.role, the HOME role). Null when the account may not touch
 * heights in this organization.
 */
export async function heightRoleInOrganization(actor: ActorIdentity): Promise<HeightRole | null> {
  if (!(HEIGHT_ROLES as readonly string[]).includes(actor.role)) return null;
  const membership = await queryOne<{ role: HeightRole }>(
    `select om.role
       from pilot.organization_memberships om
      where om.account_id = $1 and om.organization_id = $2 and om.active_flag = true
        and om.role = any($3::text[])`,
    [actor.accountId, actor.organizationId, [...HEIGHT_ROLES]],
  );
  return membership?.role ?? null;
}

/**
 * Throws ForbiddenError unless this actor is staff here AND reaches this
 * athlete. One message for every refusal, so the response cannot be used to
 * learn whether an athlete id exists. Only access.ts's own refusals become
 * this refusal; an outage is rethrown, never reported as "not permitted".
 */
async function assertHeightAccess(actor: ActorIdentity, athleteId: string): Promise<HeightRole> {
  const role = await heightRoleInOrganization(actor);
  if (role) {
    try {
      await assertActorCanAccessAthlete({ ...actor, role }, athleteId);
      return role;
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith('Forbidden'))) throw error;
    }
  }
  throw new ForbiddenError('This account may not read or record heights for this athlete.', 'HEIGHT_NOT_PERMITTED');
}

/** Of these athletes, the ones this actor may read and record heights for (same rule, batched). */
export async function heightAccessibleAthleteIds(
  actor: ActorIdentity,
  athleteIds: readonly string[],
): Promise<Set<string>> {
  const role = await heightRoleInOrganization(actor);
  if (!role) return new Set();
  return accessibleAthleteIds({ ...actor, role }, athleteIds);
}

/** The typed centimetres, rounded to one decimal, or a refusal naming the bounds. */
export function parseHeightCm(value: unknown): number {
  const cm = typeof value === 'number' ? Math.round(value * 10) / 10 : Number.NaN;
  if (!Number.isFinite(cm) || cm < HEIGHT_CM_MIN || cm > HEIGHT_CM_MAX) {
    throw new ValidationError(
      `Enter the height in centimetres, from ${HEIGHT_CM_MIN} to ${HEIGHT_CM_MAX}.`,
      'HEIGHT_CM_INVALID',
    );
  }
  return cm;
}

/** A real calendar day, not in the future at the gym, not before 2000. Absent = today. */
export function parseMeasuredOn(value: unknown, today: string): string {
  if (value === undefined || value === null || value === '') return today;
  const parsed = typeof value === 'string' && ISO_DATE.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value < '2000-01-01') {
    throw new ValidationError('measured_on must be a date (YYYY-MM-DD).', 'HEIGHT_DATE_INVALID');
  }
  if (value > today) {
    throw new ValidationError('A height cannot be measured on a day that has not happened yet.', 'HEIGHT_DATE_FUTURE');
  }
  return value;
}

export function parseRequestKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key || key.length > REQUEST_KEY_MAX) {
    throw new ValidationError('request_key is required (1-200 characters).', 'HEIGHT_REQUEST_KEY_INVALID');
  }
  return key;
}

/** The reading a correction replaces: absent/null for a first reading, else a reading id. */
export function parseSupersedesHeightId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new ValidationError('supersedes_height_id must be a reading id, or omitted.', 'HEIGHT_CORRECTION_TARGET_INVALID');
  }
  return value.toLowerCase();
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);
}

/**
 * Growth rate between the latest reading in force and the newest one at least
 * GROWTH_MIN_DAYS before it, annualised. Null when there is no such pair.
 * Superseded readings are never used. A negative change is reported as it
 * is: two readings say what they say.
 */
export function growthRate(readings: readonly HeightReading[]): GrowthRate | null {
  const current = readings
    .filter((reading) => !reading.superseded)
    .sort((a, b) => (a.measured_on === b.measured_on
      ? b.recorded_at.localeCompare(a.recorded_at)
      : b.measured_on.localeCompare(a.measured_on)));
  const latest = current[0];
  if (!latest) return null;
  const earlier = current.find((reading) => daysBetween(reading.measured_on, latest.measured_on) >= GROWTH_MIN_DAYS);
  if (!earlier) return null;
  const days = daysBetween(earlier.measured_on, latest.measured_on);
  const change = Math.round((latest.height_cm - earlier.height_cm) * 10) / 10;
  return {
    from_measured_on: earlier.measured_on,
    from_cm: earlier.height_cm,
    to_measured_on: latest.measured_on,
    to_cm: latest.height_cm,
    days,
    change_cm: change,
    cm_per_year: Math.round(((latest.height_cm - earlier.height_cm) / days) * DAYS_PER_YEAR * 10) / 10,
  };
}

function summarize(readings: HeightReading[]): HeightSummary {
  const latest = readings.find((reading) => !reading.superseded) ?? null;
  // The rate is read from EVERY reading in force; only the list is cut to the
  // newest HEIGHT_HISTORY_LIMIT, so a long history never hides a pair.
  return { readings: readings.slice(0, HEIGHT_HISTORY_LIMIT), latest, growth: growthRate(readings) };
}

async function listRows(organizationId: string, athleteId: string): Promise<HeightReading[]> {
  const rows = await query<HeightRow>(
    `select ${FIELDS}
       from pilot.athlete_heights h
      where h.organization_id = $1 and h.athlete_id = $2
      order by h.measured_on desc, h.recorded_at desc`,
    [organizationId, athleteId],
  );
  return rows.map(toReading);
}

/** One athlete's readings, newest first (corrected ones marked), with the growth rate. */
export async function readAthleteHeights(actor: ActorIdentity, athleteId: string): Promise<HeightSummary> {
  await assertHeightAccess(actor, athleteId);
  return summarize(await listRows(actor.organizationId, athleteId));
}

export interface RecordHeightInput {
  athleteId: string;
  heightCm: number;
  measuredOn: string;
  requestKey: string;
  supersedesHeightId: string | null;
}

function pgCode(error: unknown): { code?: string; constraint?: string } {
  return (error && typeof error === 'object' ? error : {}) as { code?: string; constraint?: string };
}

function sameSave(row: HeightRow, input: RecordHeightInput): boolean {
  return row.athlete_id === input.athleteId
    && row.measured_on === input.measuredOn
    && Number(row.height_cm) === input.heightCm
    && (row.supersedes_height_id ?? null) === input.supersedesHeightId;
}

const KEY_FIELDS_SQL = `select ${FIELDS} from pilot.athlete_heights h where h.organization_id = $1 and h.request_key = $2`;

function keyReused(): ConflictError {
  return new ConflictError(
    'This save was already used for a different reading. Reload and try again.',
    'HEIGHT_REQUEST_KEY_REUSED',
  );
}

/**
 * Records one reading (or a correction of one), and its audit row in the SAME
 * transaction, so a saved reading always says who wrote it. Returns the row
 * for this save and whether this call wrote it: the new row, or, for a retry
 * of the same request key, the row the first attempt wrote (created: false,
 * no second audit row). A request key already used for a DIFFERENT reading is
 * a conflict, never silently treated as the same save.
 */
export async function recordAthleteHeight(
  actor: ActorIdentity,
  input: RecordHeightInput,
): Promise<{ reading: HeightReading; created: boolean }> {
  const role = await assertHeightAccess(actor, input.athleteId);
  try {
    return await withTransaction(async (client) => {
      const inserted = await client.query<HeightRow>(
        `with inserted as (
           insert into pilot.athlete_heights as h
             (organization_id, height_id, athlete_id, measured_on, height_cm,
              recorded_by_account_id, recorded_by_role, request_key, supersedes_height_id)
           values ($1, $2::uuid, $3, $4::date, $5, $6, $7, $8, $9::uuid)
           on conflict (organization_id, request_key) do nothing
           returning h.*
         )
         select ${BASE_FIELDS}, false as superseded from inserted h`,
        [
          actor.organizationId,
          randomUUID(),
          input.athleteId,
          input.measuredOn,
          input.heightCm,
          actor.accountId,
          role,
          input.requestKey,
          input.supersedesHeightId,
        ],
      );
      const row = inserted.rows[0];
      if (!row) {
        // The key was used before: the same save retried, or a different one.
        const existing = (await client.query<HeightRow>(KEY_FIELDS_SQL, [actor.organizationId, input.requestKey])).rows[0];
        if (existing && sameSave(existing, input)) return { reading: toReading(existing), created: false };
        throw keyReused();
      }
      // shadow_mirror false, as for a child's coach-set limits: nothing about a
      // child's height feeds SHADOW or a family-readable feed.
      await writePilotAuditEvent({
        event_type: input.supersedesHeightId ? 'update' : 'create',
        actor_account_id: actor.accountId,
        actor_role: role,
        organization_id: actor.organizationId,
        entity_type: 'athlete_height',
        entity_id: row.height_id,
        details: { athlete_id: input.athleteId, supersedes_height_id: input.supersedesHeightId },
        shadow_mirror: false,
      }, client);
      return { reading: toReading(row), created: true };
    });
  } catch (error) {
    const { code, constraint } = pgCode(error);
    if (code === '23503' && constraint === 'pilot_athlete_heights_supersedes_fk') {
      throw new ValidationError('The reading to correct was not found for this athlete.', 'HEIGHT_CORRECTION_TARGET_INVALID');
    }
    if (code === '23505' && constraint === 'pilot_athlete_heights_one_correction') {
      // Two presses of the same correction at once: the second meets the first
      // on the one-correction rule, not the save key. Same save -> the replay.
      const existing = await queryOne<HeightRow>(KEY_FIELDS_SQL, [actor.organizationId, input.requestKey]);
      if (existing && sameSave(existing, input)) return { reading: toReading(existing), created: false };
      throw new ConflictError('That reading was already corrected. Reload and correct the newer one.', 'HEIGHT_ALREADY_CORRECTED');
    }
    if (code === '23514' && constraint === 'pilot_athlete_heights_recorder_of_this_gym') {
      // The seat ended between the access check and the insert.
      throw new ForbiddenError('This account may not read or record heights for this athlete.', 'HEIGHT_NOT_PERMITTED');
    }
    throw error;
  }
}

export async function recordAndSummarize(actor: ActorIdentity, input: RecordHeightInput): Promise<{
  reading: HeightReading;
  created: boolean;
  summary: HeightSummary;
}> {
  const { reading, created } = await recordAthleteHeight(actor, input);
  return { reading, created, summary: summarize(await listRows(actor.organizationId, input.athleteId)) };
}

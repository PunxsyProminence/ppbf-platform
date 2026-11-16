import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { gymDayIso } from '@/src/lib/gymTime';

import { type ContactStage, isHardOrOpen } from './athleteContactCaps';
import { writePilotAuditEvent } from './audit';
import { queryOne, query, withTransaction } from './db';
import { ConflictError, ForbiddenError, ValidationError } from './errors';

/**
 * USA Boxing medical restrictions (Backbone schema proposal P22;
 * pilot_slice_postgres_medical_restrictions_migration.sql says what a row is).
 *
 * THE RULE (OD-2026-11-10-002, narrowed by Jason's cards OW25-04 B and
 * OW25-11 B). During a restriction, or after it with no release on file, the
 * app refuses entries at contact level 'controlled_sparring' or
 * 'open_sparring' for that member and names the restriction as the reason.
 * 'none', 'light_technical' and 'conditioned' still save, with the note. The
 * gate lifts when the release date is on file and the minimum end date has
 * passed (OW25-05 A).
 *
 * On an entry's gym day d, a restriction BLOCKS when
 *     start_date <= d
 *     AND NOT (release_signed_on <= d AND d > minimum_end_date)
 * and it is not voided. Any one blocking restriction blocks. The release must
 * be dated on or before the day it is relied on: a release signed later does
 * not reach back to a sparring day before it.
 *
 * NO OVERRIDE. The coach may stop, reduce or defer (AGENT_KERNEL.md authority
 * doctrine); nothing here lets anyone lift the gate except by recording the
 * release date, which is the lift condition itself. Voiding (gym admin only,
 * with a reason) corrects a record entered in error; it is not an override
 * (Overwatch, lane P22 step 1, Q7).
 *
 * WHO. Route-layer checks decide standing (assertActorCanAccessAthlete; coach
 * of this gym, organization_admin, admin). This module records who acted and
 * writes the audit row in the same transaction as the change, with FIELD NAMES
 * ONLY in its details -- never a medical value -- and shadow_mirror off, so no
 * copy reaches the SHADOW event feed.
 */

export const MEDICAL_RESTRICTION_SOURCES = [
  'ringside_affidavit',
  'training_knockout_or_concussion',
  'other',
] as const;
export type MedicalRestrictionSource = (typeof MEDICAL_RESTRICTION_SOURCES)[number];

export const LOSS_OF_CONSCIOUSNESS_VALUES = ['none', 'under_1_min', 'over_1_min', 'unknown'] as const;
export type LossOfConsciousness = (typeof LOSS_OF_CONSCIOUSNESS_VALUES)[number];

/** Who may record a restriction, its release date and its LBC date (OW25-05 A). */
export const MEDICAL_RESTRICTION_WRITER_ROLES = ['coach', 'organization_admin', 'admin'] as const;
export type MedicalRestrictionWriterRole = (typeof MEDICAL_RESTRICTION_WRITER_ROLES)[number];

/** Who may mark a record entered in error (Q7). Never a coach. */
export const MEDICAL_RESTRICTION_VOID_ROLES = ['organization_admin', 'admin'] as const;
export type MedicalRestrictionVoidRole = (typeof MEDICAL_RESTRICTION_VOID_ROLES)[number];

export const NOTE_MAX = 2000;
export const VOID_REASON_MAX = 500;
export const INCIDENT_ID_MAX = 200;

/** The full staff row. Never sent to a member or parent (OW25-06 A). */
export interface MedicalRestrictionRow {
  restriction_id: string;
  athlete_id: string;
  source: MedicalRestrictionSource;
  loss_of_consciousness: LossOfConsciousness;
  start_date: string;
  minimum_end_date: string;
  release_signed_on: string | null;
  release_recorded_by_account_id: string | null;
  release_recorded_by_role: string | null;
  release_recorded_at: string | null;
  lbc_informed_on: string | null;
  lbc_recorded_by_account_id: string | null;
  lbc_recorded_at: string | null;
  linked_incident_id: string | null;
  note: string;
  recorded_by_account_id: string;
  recorded_by_role: string;
  recorded_at: string;
  voided_at: string | null;
  voided_by_account_id: string | null;
  voided_by_role: string | null;
  void_reason: string | null;
  updated_at: string;
}

const COLUMNS = `restriction_id::text, athlete_id, source, loss_of_consciousness,
       start_date::text, minimum_end_date::text,
       release_signed_on::text, release_recorded_by_account_id, release_recorded_by_role, release_recorded_at::text,
       lbc_informed_on::text, lbc_recorded_by_account_id, lbc_recorded_at::text,
       linked_incident_id, note, recorded_by_account_id, recorded_by_role, recorded_at::text,
       voided_at::text, voided_by_account_id, voided_by_role, void_reason, updated_at::text`;

/** The fields the gate reads. */
export type GateFields = Pick<
  MedicalRestrictionRow,
  'start_date' | 'minimum_end_date' | 'release_signed_on' | 'voided_at'
>;

/**
 * Does this restriction block a sparring-level entry on gym day `day`
 * (YYYY-MM-DD)? ISO dates compare correctly as strings.
 */
export function restrictionBlocksOn(row: GateFields, day: string): boolean {
  if (row.voided_at) return false;
  if (day < row.start_date) return false;
  const released = row.release_signed_on !== null
    && row.release_signed_on <= day
    && day > row.minimum_end_date;
  return !released;
}

/**
 * The state a staff screen shows for a restriction on `today`.
 *   voided          -- marked entered in error; never blocks.
 *   not_started     -- start date still ahead.
 *   in_force        -- on or before the minimum end date.
 *   release_needed  -- the minimum end date has passed; no release dated by today.
 *   lifted          -- the minimum end date has passed and a release is on file.
 */
export type RestrictionState = 'voided' | 'not_started' | 'in_force' | 'release_needed' | 'lifted';

export function restrictionState(row: GateFields, today: string): RestrictionState {
  if (row.voided_at) return 'voided';
  if (today < row.start_date) return 'not_started';
  if (today <= row.minimum_end_date) return 'in_force';
  return restrictionBlocksOn(row, today) ? 'release_needed' : 'lifted';
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day written YYYY-MM-DD, or a ValidationError naming the field. */
export function parseDay(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ISO_DAY.test(value.trim())) {
    throw new ValidationError(`Unsupported ${field}: must be a date written YYYY-MM-DD`);
  }
  const day = value.trim();
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new ValidationError(`Unsupported ${field}: not a real date`);
  }
  return day;
}

function isMissingTableError(error: unknown): boolean {
  return (error as { code?: unknown }).code === '42P01';
}

function isCheckViolation(error: unknown): boolean {
  return (error as { code?: unknown }).code === '23514';
}

async function audit(
  client: PoolClient,
  input: {
    organizationId: string;
    actorAccountId: string;
    actorRole: MedicalRestrictionWriterRole;
    restrictionId: string;
    athleteId: string;
    eventType: 'create' | 'update';
    action: 'record' | 'release' | 'lbc_informed' | 'void';
    fields: readonly string[];
  },
): Promise<void> {
  // Field names only. The values -- source, loss of consciousness, dates,
  // note, void reason -- stay in the row, which only staff read.
  await writePilotAuditEvent(
    {
      event_type: input.eventType,
      actor_account_id: input.actorAccountId,
      actor_role: input.actorRole,
      organization_id: input.organizationId,
      entity_type: 'medical_restriction',
      entity_id: input.restrictionId,
      details: { athlete_id: input.athleteId, action: input.action, fields: [...input.fields] },
      shadow_mirror: false,
    },
    client,
  );
}

export interface RecordMedicalRestrictionInput {
  organizationId: string;
  athleteId: string;
  source: MedicalRestrictionSource;
  lossOfConsciousness: LossOfConsciousness;
  startDate: string;
  minimumEndDate: string;
  linkedIncidentId: string | null;
  note: string;
  actorAccountId: string;
  actorRole: MedicalRestrictionWriterRole;
}

/** Records a restriction and its audit row in one transaction. */
export async function recordMedicalRestriction(input: RecordMedicalRestrictionInput): Promise<MedicalRestrictionRow> {
  if (input.minimumEndDate < input.startDate) {
    throw new ValidationError('Unsupported minimum_end_date: must be on or after start_date');
  }
  return withTransaction(async (client) => {
    const restrictionId = randomUUID();
    const fields = ['source', 'loss_of_consciousness', 'start_date', 'minimum_end_date'];
    if (input.linkedIncidentId) fields.push('linked_incident_id');
    if (input.note) fields.push('note');
    const inserted = await client.query<MedicalRestrictionRow>(
      `insert into pilot.medical_restrictions (
         organization_id, restriction_id, athlete_id, source, loss_of_consciousness,
         start_date, minimum_end_date, linked_incident_id, note,
         recorded_by_account_id, recorded_by_role
       ) values ($1, $2::uuid, $3, $4, $5, $6::date, $7::date, $8, $9, $10, $11)
       returning ${COLUMNS}`,
      [
        input.organizationId,
        restrictionId,
        input.athleteId,
        input.source,
        input.lossOfConsciousness,
        input.startDate,
        input.minimumEndDate,
        input.linkedIncidentId,
        input.note,
        input.actorAccountId,
        input.actorRole,
      ],
    );
    await audit(client, {
      organizationId: input.organizationId,
      actorAccountId: input.actorAccountId,
      actorRole: input.actorRole,
      restrictionId,
      athleteId: input.athleteId,
      eventType: 'create',
      action: 'record',
      fields,
    });
    return inserted.rows[0];
  });
}

/**
 * The guarded, set-once UPDATE shared by the release, LBC and void writes.
 * The predicate is ON the UPDATE, so a stale page or a raced request cannot
 * overwrite a date already on file or re-void a voided row. When nothing
 * matches, the caller learns why (a ConflictError naming the state).
 */
async function guardedUpdate(input: {
  organizationId: string;
  restrictionId: string;
  setSql: string;
  guardSql: string;
  params: unknown[];
  audit: Omit<Parameters<typeof audit>[1], 'organizationId' | 'restrictionId' | 'athleteId' | 'eventType'>;
  conflictMessage: (current: MedicalRestrictionRow) => string;
  /** What a CHECK violation means for this write; absent, it propagates as a 500. */
  checkViolationMessage?: string;
}): Promise<MedicalRestrictionRow | null> {
  return withTransaction(async (client) => {
    let updated;
    try {
      updated = await client.query<MedicalRestrictionRow>(
        `update pilot.medical_restrictions
            set ${input.setSql}, updated_at = clock_timestamp()
          where organization_id = $1 and restriction_id = $2::uuid and ${input.guardSql}
          returning ${COLUMNS}`,
        [input.organizationId, input.restrictionId, ...input.params],
      );
    } catch (error) {
      if (input.checkViolationMessage && isCheckViolation(error)) {
        throw new ValidationError(input.checkViolationMessage);
      }
      throw error;
    }
    const row = updated.rows[0];
    if (row) {
      await audit(client, {
        ...input.audit,
        organizationId: input.organizationId,
        restrictionId: input.restrictionId,
        athleteId: row.athlete_id,
        eventType: 'update',
      });
      return row;
    }
    const current = await client.query<MedicalRestrictionRow>(
      `select ${COLUMNS} from pilot.medical_restrictions where organization_id = $1 and restriction_id = $2::uuid`,
      [input.organizationId, input.restrictionId],
    );
    if (!current.rows[0]) return null;
    throw new ConflictError(input.conflictMessage(current.rows[0]));
  });
}

function stateConflict(row: MedicalRestrictionRow, what: string): string {
  if (row.voided_at) return `This restriction was marked entered in error; ${what} cannot be recorded on it.`;
  return `A ${what} is already on file for this restriction.`;
}

/** Records the date the physician's clearance or medical release was signed. Set once. */
export async function recordRelease(input: {
  organizationId: string;
  restrictionId: string;
  releaseSignedOn: string;
  actorAccountId: string;
  actorRole: MedicalRestrictionWriterRole;
}): Promise<MedicalRestrictionRow | null> {
  return guardedUpdate({
    organizationId: input.organizationId,
    restrictionId: input.restrictionId,
    setSql: `release_signed_on = $3::date, release_recorded_by_account_id = $4,
             release_recorded_by_role = $5, release_recorded_at = clock_timestamp()`,
    guardSql: 'release_signed_on is null and voided_at is null',
    params: [input.releaseSignedOn, input.actorAccountId, input.actorRole],
    audit: { actorAccountId: input.actorAccountId, actorRole: input.actorRole, action: 'release', fields: ['release_signed_on'] },
    conflictMessage: (row) => stateConflict(row, 'release date'),
    checkViolationMessage: 'Unsupported release_signed_on: a release cannot be signed before the restriction started',
  });
}

/** Records the date the LBC (or its registration chair) was informed. Set once. */
export async function recordLbcInformed(input: {
  organizationId: string;
  restrictionId: string;
  lbcInformedOn: string;
  actorAccountId: string;
  actorRole: MedicalRestrictionWriterRole;
}): Promise<MedicalRestrictionRow | null> {
  return guardedUpdate({
    organizationId: input.organizationId,
    restrictionId: input.restrictionId,
    setSql: 'lbc_informed_on = $3::date, lbc_recorded_by_account_id = $4, lbc_recorded_at = clock_timestamp()',
    guardSql: 'lbc_informed_on is null and voided_at is null',
    params: [input.lbcInformedOn, input.actorAccountId],
    audit: { actorAccountId: input.actorAccountId, actorRole: input.actorRole, action: 'lbc_informed', fields: ['lbc_informed_on'] },
    conflictMessage: (row) => stateConflict(row, 'LBC date'),
  });
}

/** Marks a record entered in error (gym admin only; the route checks the role). */
export async function voidMedicalRestriction(input: {
  organizationId: string;
  restrictionId: string;
  reason: string;
  actorAccountId: string;
  actorRole: MedicalRestrictionVoidRole;
}): Promise<MedicalRestrictionRow | null> {
  return guardedUpdate({
    organizationId: input.organizationId,
    restrictionId: input.restrictionId,
    setSql: 'voided_at = clock_timestamp(), voided_by_account_id = $3, voided_by_role = $4, void_reason = $5',
    guardSql: 'voided_at is null',
    params: [input.actorAccountId, input.actorRole, input.reason],
    audit: { actorAccountId: input.actorAccountId, actorRole: input.actorRole, action: 'void', fields: ['voided_at', 'void_reason'] },
    conflictMessage: () => 'This restriction is already marked entered in error.',
  });
}

/** One member's restrictions, newest first, voided ones included (staff history). */
export async function listMedicalRestrictions(organizationId: string, athleteId: string): Promise<MedicalRestrictionRow[]> {
  return query<MedicalRestrictionRow>(
    `select ${COLUMNS} from pilot.medical_restrictions
      where organization_id = $1 and athlete_id = $2
      order by start_date desc, recorded_at desc`,
    [organizationId, athleteId],
  );
}

export async function getMedicalRestrictionById(
  organizationId: string,
  restrictionId: string,
): Promise<MedicalRestrictionRow | null> {
  return queryOne<MedicalRestrictionRow>(
    `select ${COLUMNS} from pilot.medical_restrictions where organization_id = $1 and restriction_id = $2::uuid`,
    [organizationId, restrictionId],
  );
}

/** What a refusal or a note needs to say. Never the source or loss of consciousness. */
export type BlockingRestriction = Pick<MedicalRestrictionRow, 'restriction_id' | 'minimum_end_date' | 'release_signed_on'>;

/**
 * THE GATE'S PROBE: the restriction that blocks a sparring-level entry for this
 * member on gym day `day`, or null. The SQL is restrictionBlocksOn, written
 * for the database; medicalRestrictions.pg.test.ts holds the two to the same
 * cases.
 *
 * Missing table (42P01, the pre-migration window) reads as "no restriction":
 * nothing can have been recorded into a table that does not exist. Every
 * other error propagates, so the save fails closed. On a caller's transaction
 * the probe runs under a SAVEPOINT, so a 42P01 does not abort that
 * transaction (trainingHolds.ts findRegistrationBlockingHold, same reason).
 */
export async function findBlockingMedicalRestriction(
  organizationId: string,
  athleteId: string,
  day: string,
  client?: PoolClient,
): Promise<BlockingRestriction | null> {
  // Refuse to answer a malformed question. A null or undefined day would reach
  // Postgres as NULL, every comparison would be NULL, no row would match, and
  // the probe would say "no restriction" -- a fail-open. A caller with no
  // entry day must pass gymToday(), never nothing.
  if (typeof organizationId !== 'string' || !organizationId.trim()
    || typeof athleteId !== 'string' || !athleteId.trim()) {
    throw new Error('MEDICAL_RESTRICTION_PROBE_BAD_INPUT: organization and athlete are required');
  }
  if (typeof day !== 'string' || !ISO_DAY.test(day)) {
    throw new Error('MEDICAL_RESTRICTION_PROBE_BAD_INPUT: day must be YYYY-MM-DD');
  }
  const sql = `select restriction_id::text, minimum_end_date::text, release_signed_on::text
       from pilot.medical_restrictions
      where organization_id = $1 and athlete_id = $2
        and voided_at is null
        and start_date <= $3::date
        and not (release_signed_on is not null and release_signed_on <= $3::date and $3::date > minimum_end_date)
      order by minimum_end_date desc, restriction_id
      limit 1`;
  const params = [organizationId, athleteId, day];

  if (client) {
    await client.query('SAVEPOINT medical_restriction_probe');
    try {
      const result = await client.query<BlockingRestriction>(sql, params);
      await client.query('RELEASE SAVEPOINT medical_restriction_probe');
      return result.rows[0] ?? null;
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
      await client.query('ROLLBACK TO SAVEPOINT medical_restriction_probe');
      return null;
    }
  }

  try {
    return await queryOne<BlockingRestriction>(sql, params);
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    return null;
  }
}

// ---------------------------------------------------------------------------
// THE GATE ON SAVE PATHS (lane P22b). Every sparring save path calls
// assertNoMedicalRestriction before it writes a sparring-level entry, and
// medicalRestrictionNote when it writes anything else for that member, so
// the reason is named both ways (OD-2026-11-10-002; Overwatch rulings Q1-Q8).
// Callers run these only AFTER their role and athlete-access checks, so a
// refusal never tells someone without standing that a restriction exists.
// ---------------------------------------------------------------------------

/** The two contact levels the gate refuses (OW25-04 B). Everything below them saves, with the note. */
export const GATED_CONTACT_LEVELS = ['controlled_sparring', 'open_sparring'] as const;

export function isGatedContactLevel(level: unknown): boolean {
  return typeof level === 'string' && (GATED_CONTACT_LEVELS as readonly string[]).includes(level);
}

/** The ForbiddenError code on every refusal, so a screen can tell this refusal from any other. */
export const MEDICAL_RESTRICTION_REFUSAL_CODE = 'MEDICAL_RESTRICTION';

/**
 * The gym days a save is checked on (Overwatch, P22b step 1). An entry with
 * no day of its own is checked on today. A dated entry is checked on its own
 * day; when that day is after today it is ALSO checked on today, so a release
 * on file with the minimum end date still ahead cannot let a future-dated
 * sparring entry save now. A day before today is checked on that day only:
 * an entry dated before a restriction started is a record of sparring before
 * the injury or bout, and saves.
 */
export function medicalRestrictionGateDays(entryDay: string | null | undefined, today: string): string[] {
  if (!ISO_DAY.test(today)) throw new Error('MEDICAL_RESTRICTION_PROBE_BAD_INPUT: today must be YYYY-MM-DD');
  if (entryDay === null || entryDay === undefined) return [today];
  if (typeof entryDay !== 'string' || !ISO_DAY.test(entryDay)) {
    throw new Error('MEDICAL_RESTRICTION_PROBE_BAD_INPUT: day must be YYYY-MM-DD');
  }
  return entryDay > today ? [entryDay, today] : [entryDay];
}

/** The gym day (America/New_York) of a timestamp, for entries stamped with a time rather than a day. */
export function gymDayOf(value: string | Date): string {
  const day = gymDayIso(value);
  if (!day) throw new Error('MEDICAL_RESTRICTION_PROBE_BAD_INPUT: not a valid time');
  return day;
}

/** The blocking restriction on any of the days, preferring the latest minimum end date. */
async function findBlockingOnDays(
  organizationId: string,
  athleteId: string,
  days: readonly string[],
  client?: PoolClient,
): Promise<{ row: BlockingRestriction; day: string } | null> {
  let found: { row: BlockingRestriction; day: string } | null = null;
  for (const day of days) {
    const row = await findBlockingMedicalRestriction(organizationId, athleteId, day, client);
    if (row && (!found || row.minimum_end_date > found.row.minimum_end_date)) found = { row, day };
  }
  return found;
}

/**
 * What a member, parent or coach is told: that a restriction is on file, its
 * minimum end date, and whether a release is still needed (OW25-06 A). Never
 * the source, the loss-of-consciousness answer, the note or the incident.
 */
export interface MedicalRestrictionNote {
  on_file: true;
  minimum_end_date: string;
  release_needed: boolean;
  message: string;
}

function noteFor(row: BlockingRestriction, day: string): MedicalRestrictionNote {
  const releaseNeeded = row.release_signed_on === null || row.release_signed_on > day;
  const conditions = releaseNeeded
    ? `the minimum end date (${row.minimum_end_date}) has passed and a physician's release is on file`
    : `the minimum end date (${row.minimum_end_date}) has passed`;
  return {
    on_file: true,
    minimum_end_date: row.minimum_end_date,
    release_needed: releaseNeeded,
    message: `A USA Boxing medical restriction is on file for this member. No sparring until ${conditions}. Training below sparring still saves.`,
  };
}

export interface MedicalRestrictionGateInput {
  organizationId: string;
  athleteId: string;
  /** The entry's own gym day, if it has one; omitted = today. */
  entryDay?: string | null;
  /** Injected for tests; defaults to the gym's today. */
  today?: string;
  /** The caller's transaction, when the save runs in one. */
  client?: PoolClient;
}

function gateDaysFor(input: MedicalRestrictionGateInput): string[] {
  const today = input.today ?? gymDayOf(new Date());
  return medicalRestrictionGateDays(input.entryDay, today);
}

/** The refusal for one restriction, worded for the person saving. */
export function medicalRestrictionRefusal(note: MedicalRestrictionNote): ForbiddenError {
  return new ForbiddenError(`Not saved: ${note.message}`, MEDICAL_RESTRICTION_REFUSAL_CODE);
}

/**
 * The note for this member on the save's day(s), or null. A save below sparring
 * returns it so the person saving sees the reason the member is held back.
 */
export async function medicalRestrictionNote(input: MedicalRestrictionGateInput): Promise<MedicalRestrictionNote | null> {
  const found = await findBlockingOnDays(input.organizationId, input.athleteId, gateDaysFor(input), input.client);
  return found ? noteFor(found.row, found.day) : null;
}

/**
 * Throws the 403 refusal when a restriction blocks this member on the save's
 * day(s). Call it only for a sparring-level entry, after role and access
 * checks. There is no override parameter, by design.
 */
export async function assertNoMedicalRestriction(input: MedicalRestrictionGateInput): Promise<void> {
  const note = await medicalRestrictionNote(input);
  if (note) throw medicalRestrictionRefusal(note);
}

// ---------------------------------------------------------------------------
// PER-PATH CHECKS. Each save path's own facts (its day, its contact level)
// are read here, so every P22 database read lives in this one module.
// ---------------------------------------------------------------------------

async function readOne<T extends object>(sql: string, params: unknown[], client?: PoolClient): Promise<T | null> {
  if (client) return (await client.query<T>(sql, params)).rows[0] ?? null;
  return queryOne<T>(sql, params);
}

/** A read that may meet a pre-migration schema (42P01 table, 42703 column) reads as "nothing"; under a SAVEPOINT on a client. */
async function readTolerant<T extends object>(
  sql: string,
  params: unknown[],
  savepoint: string,
  client?: PoolClient,
): Promise<T | null> {
  const missing = (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    return code === '42P01' || code === '42703';
  };
  if (client) {
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await client.query<T>(sql, params);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result.rows[0] ?? null;
    } catch (error) {
      if (!missing(error)) throw error;
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      return null;
    }
  }
  try {
    return await queryOne<T>(sql, params);
  } catch (error) {
    if (!missing(error)) throw error;
    return null;
  }
}

/**
 * A date string exactly as a Postgres `date` column will store it (sessions
 * accept any castable text). A value stored as something other than a
 * calendar day ('infinity', a BC date) reads as null: the gate then checks
 * today, rather than failing a save that used to succeed.
 */
async function storedDay(value: string): Promise<string | null> {
  const row = await queryOne<{ day: string | null }>('select $1::date::text as day', [value]);
  return row?.day && ISO_DAY.test(row.day) ? row.day : null;
}

// --- A. Sparring exposure (coach floor entry) ------------------------------

export interface SparringExposureGateInput {
  organizationId: string;
  athleteId: string;
  /**
   * The gym day the entry is for: session_date, else the linked activity's
   * occurred_on (sparringExposure.ts sparringExposureDay, the one file that
   * reads the activity log for it). null = not known yet: today is checked.
   */
  entryDay: string | null;
  contactStage?: string | null;
  sparringType?: string | null;
  /** The other boxer in the segment, if named. Same gym (the route checks). */
  partnerAthleteId?: string | null;
}

/** Does this exposure entry need the gate at all? Blank stage, a sparring stage, or 'hard'. */
export function sparringExposureIsGated(input: Pick<SparringExposureGateInput, 'contactStage' | 'sparringType'>): boolean {
  const stage = input.contactStage ?? null;
  return stage === null
    || isGatedContactLevel(stage)
    || isHardOrOpen({ contactStage: stage as ContactStage, sparringType: input.sparringType ?? '' });
}

/**
 * For a restricted member on the entry's day, refused:
 *   - contact_stage 'controlled_sparring' / 'open_sparring';
 *   - NO stage at all, with "say the contact stage" (Overwatch Q1 A: the stage
 *     is optional, and leaving it blank must not be the way past the gate);
 *   - sparring_type 'hard', whatever the stage (Overwatch Q9 A): the app
 *     already counts 'hard' as open sparring (athleteContactCaps.ts
 *     isHardOrOpen, reused here, not redefined).
 * 'none', 'light_technical' and 'conditioned' save (unless 'hard'); the route
 * returns the note. The PARTNER named on the entry is held to the same rule
 * (Overwatch Q10 A): a restricted member cannot be the other boxer either.
 * Callers have checked role and standing; the route checks the partner is in
 * this gym, where a coach or admin reaches every member.
 */
export async function assertSparringExposureClearOfMedicalRestriction(input: SparringExposureGateInput): Promise<void> {
  if (!sparringExposureIsGated(input)) return;
  const stage = input.contactStage ?? null;
  const hard = input.sparringType === 'hard';
  const boxers: Array<{ athleteId: string; who: 'member' | 'partner' }> = [{ athleteId: input.athleteId, who: 'member' }];
  if (input.partnerAthleteId && input.partnerAthleteId !== input.athleteId) {
    boxers.push({ athleteId: input.partnerAthleteId, who: 'partner' });
  }
  for (const boxer of boxers) {
    const note = await medicalRestrictionNote({
      organizationId: input.organizationId,
      athleteId: boxer.athleteId,
      entryDay: input.entryDay,
    });
    if (!note) continue;
    const message = boxer.who === 'partner'
      ? note.message.replace('on file for this member', 'on file for the sparring partner named on this entry')
      : note.message;
    const lead = stage === null
      ? 'say the contact stage. '
      : hard && !isGatedContactLevel(stage)
        ? 'hard sparring counts as open sparring. '
        : '';
    throw new ForbiddenError(`Not saved: ${lead}${message}`, MEDICAL_RESTRICTION_REFUSAL_CODE);
  }
}

// --- C, D. Drill work (assignments, Coach Cards, completions) --------------

/**
 * Is this gym drill at a sparring contact level? A pilot.drills row carries no
 * contact level of its own; it has one through the reference-library drill it
 * was adopted from (pilot.drill_library.contact_level, drill_library_v3). A
 * drill with no reference has none, and is not sparring. Before
 * drill_library_v3 the table or the reference_drill_id column is missing; then
 * no drill can carry a sparring level, so the answer is "no". Every other
 * error propagates, so the save fails closed.
 */
export async function drillIsAtSparringLevel(
  organizationId: string,
  drillId: string,
  client?: PoolClient,
): Promise<boolean> {
  const row = await readTolerant<{ gated: boolean }>(
    `select exists (
       select 1 from pilot.drills d
         join pilot.drill_library r
           on r.organization_id = d.organization_id and r.drill_id = d.reference_drill_id
        where d.organization_id = $1 and d.drill_id = $2
          and r.contact_level = any($3::text[])
     ) as gated`,
    [organizationId, drillId, [...GATED_CONTACT_LEVELS]],
    'drill_contact_level_probe',
    client,
  );
  return row?.gated === true;
}

/** A sparring-level drill is refused for a restricted member on today's gym day; work below it saves. */
export async function assertDrillClearOfMedicalRestriction(input: {
  organizationId: string;
  athleteId: string;
  drillId: string;
  client?: PoolClient;
}): Promise<void> {
  if (!(await drillIsAtSparringLevel(input.organizationId, input.drillId, input.client))) return;
  await assertNoMedicalRestriction({ organizationId: input.organizationId, athleteId: input.athleteId, client: input.client });
}

/** Which of these members a restriction blocks today. For the group Coach Card's skipped list (Q3). */
export async function membersBlockedToday(organizationId: string, athleteIds: readonly string[]): Promise<Set<string>> {
  const today = gymDayOf(new Date());
  const blocked = new Set<string>();
  for (const athleteId of athleteIds) {
    if (await findBlockingMedicalRestriction(organizationId, athleteId, today)) blocked.add(athleteId);
  }
  return blocked;
}

// --- G. Sessions tagged 'sparring' ------------------------------------------

/**
 * Overwatch Q5: the 'sparring' tag is refused for a restricted member; the
 * rest of the check-in or check-out can be sent again with another tag.
 * Checked on the session's own date.
 *
 * An UPDATE is gated only when it RAISES (Overwatch, P22b step 1 (2)): the
 * row will be 'sparring' AND either it was not, or the athlete or the date
 * changes. Editing RPE, minutes or notes on a sparring row that stays as it
 * was is not a new sparring entry and saves.
 */
export async function assertSessionClearOfMedicalRestriction(input: {
  organizationId: string;
  sessionId: string;
  athleteId: string;
  date: string;
  /** undefined = the write leaves the stored type alone. */
  sessionType: string | null | undefined;
  update: boolean;
}): Promise<void> {
  let resultingType: string | null = input.sessionType ?? null;
  if (input.update) {
    const stored = await queryOne<{ athlete_id: string; day: string; session_type: string | null }>(
      `select athlete_id, date::text as day, session_type from pilot.sessions
        where organization_id = $1 and session_id = $2`,
      [input.organizationId, input.sessionId],
    );
    if (stored) {
      if (input.sessionType === undefined) resultingType = stored.session_type;
      if (resultingType !== 'sparring') return;
      const raises = stored.session_type !== 'sparring'
        || stored.athlete_id !== input.athleteId
        || (await storedDay(input.date)) !== stored.day;
      if (!raises) return;
    }
  }
  if (resultingType !== 'sparring') return;
  await assertNoMedicalRestriction({
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    entryDay: await storedDay(input.date),
  });
}

export async function sessionMedicalRestrictionNote(input: {
  organizationId: string;
  athleteId: string;
  date: string;
}): Promise<MedicalRestrictionNote | null> {
  return medicalRestrictionNote({
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    entryDay: await storedDay(input.date),
  });
}

// --- H. External competition entry ------------------------------------------

/**
 * Overwatch Q6: a bout is contact above open sparring, so a restricted member
 * is not entered. Checked on the competition's own date, and on today as well
 * when that date is ahead (Overwatch, P22b step 1 (1)); a restriction that
 * blocks either blocks the entry. A competition with no row here (the entry
 * write then answers not-found) is checked on today. Runs on the entry's
 * transaction when given one.
 */
export async function assertCompetitionClearOfMedicalRestriction(input: {
  organizationId: string;
  athleteId: string;
  competitionId: string;
  client?: PoolClient;
}): Promise<void> {
  const competition = await readOne<{ day: string | null }>(
    `select competition_date::text as day from pilot.external_competitions
      where organization_id = $1 and competition_id = $2`,
    [input.organizationId, input.competitionId],
    input.client,
  );
  await assertNoMedicalRestriction({
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    entryDay: competition?.day && ISO_DAY.test(competition.day) ? competition.day : null,
    client: input.client,
  });
}

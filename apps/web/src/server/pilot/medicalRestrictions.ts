import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { writePilotAuditEvent } from './audit';
import { queryOne, query, withTransaction } from './db';
import { ConflictError, ValidationError } from './errors';

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

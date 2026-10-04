import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { query, withTransaction } from './db';
import { athleteNotDeletedSql } from './deletedAthletes';
import { NotFoundError, ValidationError } from './errors';

// The athlete injury record (map item 11): date, body area, type, training or
// competition, time lost. The table is owned by
// infra/azure/pilot_slice_postgres_athlete_injuries_migration.sql; nothing here
// issues DDL.
//
// NOT DIAGNOSTIC. A row records what a person reported or a clinician stated,
// and reported_by says which. No function here infers, computes or clears
// anything, and nothing here stops training -- a training hold does that, and
// an injury only LINKS to one.
//
// LINKS, NOT COPIES. A concussion's rest period and earliest return date live
// on its return-to-training plan; a pause lives on its training hold; a
// clearance on the medical status record; the athlete's own words on their
// pain report. This module links to those rows and checks, in the writing
// transaction, that each one names the same athlete in the same organization.
// When a plan is linked, its earliest_return_date is the expected return and
// this row stores none (the migration's one-return-source check backs that).
//
// PER-ATHLETE AUTHORITY IS ENFORCED BY THE CALLER, as in safetyFlags.ts and
// trainingHolds.ts: every function is organization-scoped data access only.
// The route decides whether this coach has standing with this athlete;
// getInjuryById exists so it can name the injury's athlete before acting.
//
// DELETED ATHLETES. Every read filters through athleteNotDeletedSql, and every
// write refuses an athlete marked deleted. The purge removes the rows with the
// athlete through the foreign key's cascade.

export const INJURY_BODY_AREAS = [
  'head', 'face', 'neck', 'shoulder', 'upper_arm', 'elbow', 'forearm', 'wrist', 'hand',
  'chest', 'ribs', 'abdomen', 'back', 'hip', 'groin', 'thigh', 'knee', 'lower_leg',
  'ankle', 'foot', 'other',
] as const;
export type InjuryBodyArea = (typeof INJURY_BODY_AREAS)[number];

export const INJURY_TYPES = ['sprain_strain', 'cut', 'fracture', 'head_injury', 'other'] as const;
export type InjuryType = (typeof INJURY_TYPES)[number];

export const INJURY_CONTEXTS = ['training', 'competition'] as const;
export type InjuryContext = (typeof INJURY_CONTEXTS)[number];

/** Who the account of the injury came from. 'clinician' = what a clinician stated. */
export const INJURY_REPORTED_BY = ['athlete', 'parent_guardian', 'coach_observed', 'clinician'] as const;
export type InjuryReportedBy = (typeof INJURY_REPORTED_BY)[number];

export const INJURY_STAFF_NOTE_MAX = 2000;

export interface InjuryLinks {
  linkedRttPlanId?: string | null;
  linkedHoldId?: string | null;
  linkedClearanceStatusId?: string | null;
  linkedPainReportId?: string | null;
}

export interface AthleteInjuryRow {
  organization_id: string;
  injury_id: string;
  athlete_id: string;
  injury_date: string;
  body_area: InjuryBodyArea;
  injury_type: InjuryType;
  context: InjuryContext;
  reported_by: InjuryReportedBy;
  staff_note: string;
  /** This row's own expected return; always null when a plan is linked. */
  expected_return_date: string | null;
  returned_on: string | null;
  linked_rtt_plan_id: string | null;
  linked_hold_id: string | null;
  linked_clearance_status_id: string | null;
  linked_pain_report_id: string | null;
  entered_in_error: boolean;
  recorded_by_account_id: string;
  recorded_by_role: string;
  updated_by_account_id: string;
  created_at: string;
  updated_at: string;
  /** The linked plan's human-entered earliest return date, read from the plan. */
  plan_earliest_return_date: string | null;
}

const COLUMNS = `i.organization_id, i.injury_id, i.athlete_id, i.injury_date::text, i.body_area,
       i.injury_type, i.context, i.reported_by, i.staff_note, i.expected_return_date::text,
       i.returned_on::text, i.linked_rtt_plan_id, i.linked_hold_id,
       i.linked_clearance_status_id::text, i.linked_pain_report_id::text, i.entered_in_error,
       i.recorded_by_account_id, i.recorded_by_role, i.updated_by_account_id,
       i.created_at::text, i.updated_at::text,
       p.earliest_return_date::text as plan_earliest_return_date`;

const FROM = `pilot.athlete_injuries i
     left join pilot.return_to_training_plans p
       on p.organization_id = i.organization_id and p.plan_id = i.linked_rtt_plan_id`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oneOf<T extends string>(values: readonly T[], value: unknown, field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new ValidationError(`${field} must be one of: ${values.join(', ')}.`);
  }
  return value as T;
}

function dateOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ValidationError(`${field} must be a date (YYYY-MM-DD).`);
  }
  return value;
}

function idOrNull(value: unknown, field: string, uuid: boolean): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 200 || (uuid && !UUID.test(value))) {
    throw new ValidationError(`${field} is not a valid record id.`);
  }
  return value;
}

interface InjuryFields {
  injuryDate: string;
  bodyArea: InjuryBodyArea;
  injuryType: InjuryType;
  context: InjuryContext;
  reportedBy: InjuryReportedBy;
  staffNote: string;
  expectedReturnDate: string | null;
  returnedOn: string | null;
  linkedRttPlanId: string | null;
  linkedHoldId: string | null;
  linkedClearanceStatusId: string | null;
  linkedPainReportId: string | null;
}

function validateFields(input: Record<string, unknown>): InjuryFields {
  const injuryDate = dateOrNull(input.injuryDate, 'injuryDate');
  if (!injuryDate) throw new ValidationError('injuryDate is required.');
  const staffNote = input.staffNote ?? '';
  if (typeof staffNote !== 'string' || staffNote.length > INJURY_STAFF_NOTE_MAX) {
    throw new ValidationError(`staffNote must be text of at most ${INJURY_STAFF_NOTE_MAX} characters.`);
  }
  const fields: InjuryFields = {
    injuryDate,
    bodyArea: oneOf(INJURY_BODY_AREAS, input.bodyArea, 'bodyArea'),
    injuryType: oneOf(INJURY_TYPES, input.injuryType, 'injuryType'),
    context: oneOf(INJURY_CONTEXTS, input.context, 'context'),
    reportedBy: oneOf(INJURY_REPORTED_BY, input.reportedBy, 'reportedBy'),
    staffNote,
    expectedReturnDate: dateOrNull(input.expectedReturnDate, 'expectedReturnDate'),
    returnedOn: dateOrNull(input.returnedOn, 'returnedOn'),
    linkedRttPlanId: idOrNull(input.linkedRttPlanId, 'linkedRttPlanId', false),
    linkedHoldId: idOrNull(input.linkedHoldId, 'linkedHoldId', false),
    linkedClearanceStatusId: idOrNull(input.linkedClearanceStatusId, 'linkedClearanceStatusId', true),
    linkedPainReportId: idOrNull(input.linkedPainReportId, 'linkedPainReportId', true),
  };
  // ISO dates compare correctly as strings.
  if (fields.expectedReturnDate && fields.expectedReturnDate < fields.injuryDate) {
    throw new ValidationError('expectedReturnDate cannot be before injuryDate.');
  }
  if (fields.returnedOn && fields.returnedOn < fields.injuryDate) {
    throw new ValidationError('returnedOn cannot be before injuryDate.');
  }
  if (fields.linkedRttPlanId && fields.expectedReturnDate) {
    throw new ValidationError(
      'A linked return-to-training plan already holds the expected return date; leave expectedReturnDate empty.',
    );
  }
  return fields;
}

async function assertLiveAthlete(client: PoolClient, organizationId: string, athleteId: string): Promise<void> {
  const found = await client.query(
    `select 1 from pilot.athletes
      where organization_id = $1 and athlete_id = $2 and deleted_at is null
      for share`,
    [organizationId, athleteId],
  );
  if (found.rows.length === 0) {
    throw new NotFoundError('Athlete not found.');
  }
}

// Each linked record must name THIS athlete in THIS organization. The foreign
// keys prove a record exists; only this proves it is the right child's.
const LINK_CHECKS: ReadonlyArray<{ field: keyof InjuryLinks; label: string; sql: string }> = [
  {
    field: 'linkedRttPlanId',
    label: 'return-to-training plan',
    sql: `select 1 from pilot.return_to_training_plans
           where organization_id = $1 and athlete_id = $2 and plan_id = $3`,
  },
  {
    field: 'linkedHoldId',
    label: 'training hold',
    sql: `select 1 from pilot.training_holds
           where organization_id = $1 and athlete_id = $2 and hold_id = $3`,
  },
  {
    field: 'linkedClearanceStatusId',
    label: 'clearance record',
    sql: `select 1 from pilot.shadow_medical_administrative_status
           where organization_id = $1 and athlete_id = $2 and status_id = $3::uuid`,
  },
  {
    field: 'linkedPainReportId',
    label: 'pain report',
    sql: `select 1 from pilot.shadow_near_misses
           where organization_id = $1 and athlete_id = $2 and near_miss_id = $3::uuid
             and metadata->>'trigger' = 'athlete_pain_report'`,
  },
];

async function assertLinksBelongToAthlete(
  client: PoolClient,
  organizationId: string,
  athleteId: string,
  links: InjuryLinks,
): Promise<void> {
  for (const check of LINK_CHECKS) {
    const id = links[check.field];
    if (!id) continue;
    const found = await client.query(check.sql, [organizationId, athleteId, id]);
    if (found.rows.length === 0) {
      throw new ValidationError(`The linked ${check.label} is not one of this athlete's records.`);
    }
  }
}

async function selectInjury(
  client: PoolClient,
  organizationId: string,
  injuryId: string,
): Promise<AthleteInjuryRow | null> {
  const result = await client.query<AthleteInjuryRow>(
    `select ${COLUMNS} from ${FROM}
      where i.organization_id = $1 and i.injury_id = $2::uuid and ${athleteNotDeletedSql('i')}`,
    [organizationId, injuryId],
  );
  return result.rows[0] ?? null;
}

export interface RecordInjuryInput extends Record<string, unknown> {
  organizationId: string;
  athleteId: string;
  recordedByAccountId: string;
  recordedByRole: string;
}

export async function recordInjury(input: RecordInjuryInput): Promise<AthleteInjuryRow> {
  const fields = validateFields(input);
  return withTransaction(async (client) => {
    await assertLiveAthlete(client, input.organizationId, input.athleteId);
    await assertLinksBelongToAthlete(client, input.organizationId, input.athleteId, fields);
    const injuryId = randomUUID();
    await client.query(
      `insert into pilot.athlete_injuries (
         organization_id, injury_id, athlete_id, injury_date, body_area, injury_type, context,
         reported_by, staff_note, expected_return_date, returned_on, linked_rtt_plan_id,
         linked_hold_id, linked_clearance_status_id, linked_pain_report_id,
         recorded_by_account_id, recorded_by_role, updated_by_account_id
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $16)`,
      [
        input.organizationId, injuryId, input.athleteId, fields.injuryDate, fields.bodyArea,
        fields.injuryType, fields.context, fields.reportedBy, fields.staffNote,
        fields.expectedReturnDate, fields.returnedOn, fields.linkedRttPlanId, fields.linkedHoldId,
        fields.linkedClearanceStatusId, fields.linkedPainReportId,
        input.recordedByAccountId, input.recordedByRole,
      ],
    );
    const row = await selectInjury(client, input.organizationId, injuryId);
    if (!row) throw new Error('Recorded injury could not be read back.');
    return row;
  });
}

/**
 * Replaces an injury's recorded fields (the full set, as the form sends them).
 * Refuses a row marked entered_in_error and a row whose athlete is deleted.
 */
export async function updateInjury(input: {
  organizationId: string;
  injuryId: string;
  fields: Record<string, unknown>;
  updatedByAccountId: string;
}): Promise<AthleteInjuryRow> {
  const fields = validateFields(input.fields);
  return withTransaction(async (client) => {
    const existing = await selectInjury(client, input.organizationId, input.injuryId);
    if (!existing || existing.entered_in_error) {
      throw new NotFoundError('Injury record not found.');
    }
    await assertLiveAthlete(client, input.organizationId, existing.athlete_id);
    await assertLinksBelongToAthlete(client, input.organizationId, existing.athlete_id, fields);
    await client.query(
      `update pilot.athlete_injuries
          set injury_date = $3, body_area = $4, injury_type = $5, context = $6, reported_by = $7,
              staff_note = $8, expected_return_date = $9, returned_on = $10,
              linked_rtt_plan_id = $11, linked_hold_id = $12, linked_clearance_status_id = $13,
              linked_pain_report_id = $14, updated_by_account_id = $15, updated_at = now()
        where organization_id = $1 and injury_id = $2::uuid and entered_in_error = false`,
      [
        input.organizationId, input.injuryId, fields.injuryDate, fields.bodyArea, fields.injuryType,
        fields.context, fields.reportedBy, fields.staffNote, fields.expectedReturnDate,
        fields.returnedOn, fields.linkedRttPlanId, fields.linkedHoldId,
        fields.linkedClearanceStatusId, fields.linkedPainReportId, input.updatedByAccountId,
      ],
    );
    const row = await selectInjury(client, input.organizationId, input.injuryId);
    if (!row) throw new Error('Updated injury could not be read back.');
    return row;
  });
}

/**
 * Takes a mistaken row off every list. Not a delete: the row and who marked it
 * stay. The guarded predicate means a second call changes nothing and says so.
 */
export async function markInjuryEnteredInError(input: {
  organizationId: string;
  injuryId: string;
  updatedByAccountId: string;
}): Promise<void> {
  const result = await query<{ injury_id: string }>(
    `update pilot.athlete_injuries i
        set entered_in_error = true, updated_by_account_id = $3, updated_at = now()
      where i.organization_id = $1 and i.injury_id = $2::uuid and i.entered_in_error = false
        and ${athleteNotDeletedSql('i')}
      returning i.injury_id`,
    [input.organizationId, input.injuryId, input.updatedByAccountId],
  );
  if (result.length === 0) {
    throw new NotFoundError('Injury record not found.');
  }
}

/** One injury, for a caller that must name its athlete before acting. Null when absent or deleted. */
export async function getInjuryById(organizationId: string, injuryId: string): Promise<AthleteInjuryRow | null> {
  if (!UUID.test(injuryId)) return null;
  const rows = await query<AthleteInjuryRow>(
    `select ${COLUMNS} from ${FROM}
      where i.organization_id = $1 and i.injury_id = $2::uuid and ${athleteNotDeletedSql('i')}`,
    [organizationId, injuryId],
  );
  return rows[0] ?? null;
}

/** An athlete's injuries, newest first; rows entered in error are left out. Staff projection. */
export async function listInjuriesForAthlete(
  organizationId: string,
  athleteId: string,
): Promise<AthleteInjuryRow[]> {
  return query<AthleteInjuryRow>(
    `select ${COLUMNS} from ${FROM}
      where i.organization_id = $1 and i.athlete_id = $2 and i.entered_in_error = false
        and ${athleteNotDeletedSql('i')}
      order by i.injury_date desc, i.created_at desc`,
    [organizationId, athleteId],
  );
}

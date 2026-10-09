import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { query, withTransaction } from './db';
import { athleteNotDeletedSql } from './deletedAthletes';
import { ConflictError, NotFoundError, ValidationError } from './errors';

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
  // Round-trip, not Date.parse alone: Date.parse rolls 2026-02-31 forward to
  // March 3 instead of refusing it, and Postgres would then refuse it as a 500.
  const parsed = typeof value === 'string' && ISO_DATE.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value < '0001-01-01') {
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
// keys prove a record exists; only this proves it is the right child's -- and
// for the clearance and pain-report links, whose keys are a bare uuid, only
// this keeps the link inside the organization. `for share` holds each linked
// row until commit, so it cannot vanish between this check and the write.
const LINK_CHECKS: ReadonlyArray<{ field: keyof InjuryLinks; label: string; sql: string }> = [
  {
    field: 'linkedRttPlanId',
    label: 'return-to-training plan',
    sql: `select 1 from pilot.return_to_training_plans
           where organization_id = $1 and athlete_id = $2 and plan_id = $3
           for share`,
  },
  {
    field: 'linkedHoldId',
    label: 'training hold',
    sql: `select 1 from pilot.training_holds
           where organization_id = $1 and athlete_id = $2 and hold_id = $3
           for share`,
  },
  {
    field: 'linkedClearanceStatusId',
    label: 'clearance record',
    sql: `select 1 from pilot.shadow_medical_administrative_status
           where organization_id = $1 and athlete_id = $2 and status_id = $3::uuid
           for share`,
  },
  {
    field: 'linkedPainReportId',
    label: 'pain report',
    sql: `select 1 from pilot.shadow_near_misses
           where organization_id = $1 and athlete_id = $2 and near_miss_id = $3::uuid
             and metadata->>'trigger' = 'athlete_pain_report'
           for share`,
  },
];

async function assertLinksBelongToAthlete(
  client: PoolClient,
  organizationId: string,
  athleteId: string,
  fields: InjuryFields,
): Promise<void> {
  for (const check of LINK_CHECKS) {
    const id = fields[check.field];
    if (!id) continue;
    const found = await client.query(check.sql, [organizationId, athleteId, id]);
    if (found.rows.length === 0) {
      throw new ValidationError(`The linked ${check.label} is not one of this athlete's records.`);
    }
  }
  // A linked plan's earliest return date stands in for this injury's expected
  // return, so it is held to the same rule this row's own date is
  // (pilot_athlete_injuries_return_after_injury): an older plan that ended
  // before this injury happened is not this injury's plan.
  if (fields.linkedRttPlanId) {
    const early = await client.query(
      `select 1 from pilot.return_to_training_plans
        where organization_id = $1 and plan_id = $2 and earliest_return_date < $3::date`,
      [organizationId, fields.linkedRttPlanId, fields.injuryDate],
    );
    if (early.rows.length > 0) {
      throw new ValidationError(
        "The linked return-to-training plan's earliest return date is before this injury's date.",
      );
    }
  }
}

async function selectInjury(
  client: PoolClient,
  organizationId: string,
  injuryId: string,
  lock = false,
): Promise<AthleteInjuryRow | null> {
  // `for update of i` on the edit path: a concurrent edit or error mark waits
  // for this transaction instead of being silently overwritten or reported as
  // saved when nothing was.
  const result = await client.query<AthleteInjuryRow>(
    `select ${COLUMNS} from ${FROM}
      where i.organization_id = $1 and i.injury_id = $2::uuid and ${athleteNotDeletedSql('i')}${lock ? ' for update of i' : ''}`,
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
    // Parent before child, the order the purge's cascade takes them in: lock
    // the athlete (for share), then the injury row (for update). The reverse
    // order deadlocks against `delete from pilot.athletes`, which holds the
    // athlete and then waits on this row. athlete_id never changes on a row,
    // so reading it unlocked first is safe.
    const owner = await client.query<{ athlete_id: string }>(
      `select athlete_id from pilot.athlete_injuries where organization_id = $1 and injury_id = $2::uuid`,
      [input.organizationId, input.injuryId],
    );
    if (owner.rows.length === 0) {
      throw new NotFoundError('Injury record not found.');
    }
    try {
      await assertLiveAthlete(client, input.organizationId, owner.rows[0].athlete_id);
    } catch (error) {
      if (error instanceof NotFoundError) throw new NotFoundError('Injury record not found.');
      throw error;
    }
    const existing = await selectInjury(client, input.organizationId, input.injuryId, true);
    if (!existing || existing.entered_in_error) {
      throw new NotFoundError('Injury record not found.');
    }
    await assertLinksBelongToAthlete(client, input.organizationId, existing.athlete_id, fields);
    const updated = await client.query(
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
    if (updated.rowCount !== 1) {
      throw new NotFoundError('Injury record not found.');
    }
    const row = await selectInjury(client, input.organizationId, input.injuryId);
    if (!row) throw new Error('Updated injury could not be read back.');
    return row;
  });
}

/**
 * Links an injury to a return-to-training plan and nothing else: no field
 * replay, so an edit made since the caller read the row is kept, and the row
 * lock plus the `linked_rtt_plan_id is null` guard mean two coaches creating
 * a plan on the same injury at once cannot both link -- the second gets the
 * ConflictError and its plan stays unlinked. The plan takes over the expected
 * return, so the row's own is cleared (the one-return-source constraint). The
 * plan must be this athlete's and must not end before the injury, the same
 * checks every other link path makes.
 */
export async function linkInjuryToPlan(input: {
  organizationId: string;
  injuryId: string;
  planId: string;
  updatedByAccountId: string;
}): Promise<AthleteInjuryRow> {
  if (!UUID.test(input.injuryId)) throw new NotFoundError('Injury record not found.');
  const planId = idOrNull(input.planId, 'planId', false);
  if (!planId) throw new ValidationError('planId is required.');
  return withTransaction(async (client) => {
    const existing = await selectInjury(client, input.organizationId, input.injuryId, true);
    if (!existing || existing.entered_in_error) {
      throw new NotFoundError('Injury record not found.');
    }
    if (existing.linked_rtt_plan_id) {
      throw new ConflictError('This injury already has a return-to-training plan.', 'RTT_PLAN_ALREADY_LINKED');
    }
    await assertLinksBelongToAthlete(client, input.organizationId, existing.athlete_id, {
      injuryDate: existing.injury_date,
      linkedRttPlanId: planId,
    } as InjuryFields);
    const updated = await client.query(
      `update pilot.athlete_injuries
          set linked_rtt_plan_id = $3, expected_return_date = null, updated_by_account_id = $4, updated_at = now()
        where organization_id = $1 and injury_id = $2::uuid and entered_in_error = false
          and linked_rtt_plan_id is null`,
      [input.organizationId, input.injuryId, planId, input.updatedByAccountId],
    );
    if (updated.rowCount !== 1) {
      throw new ConflictError('This injury already has a return-to-training plan.', 'RTT_PLAN_ALREADY_LINKED');
    }
    const row = await selectInjury(client, input.organizationId, input.injuryId);
    if (!row) throw new Error('Linked injury could not be read back.');
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

export interface InjuryLinkCandidates {
  holds: Array<{ hold_id: string; scope: string; status: string; placed_at: string }>;
  plans: Array<{
    plan_id: string;
    triggering_event: string;
    event_date: string;
    earliest_return_date: string | null;
    status: string;
  }>;
  clearances: Array<{ status_id: string; status: string; effective_at: string }>;
  painReports: Array<{ near_miss_id: string; severity: string; created_at: string }>;
}

const CANDIDATE_LIMIT = 20;

/**
 * The athlete's existing records an injury may link to, newest first, so the
 * coach picks a real one instead of typing an id. Ids, kinds and dates only --
 * no reason text, notes or restriction detail. Empty for a deleted athlete.
 * Per-athlete authority is the caller's, as everywhere in this module.
 */
export async function listLinkCandidates(organizationId: string, athleteId: string): Promise<InjuryLinkCandidates> {
  const params = [organizationId, athleteId, CANDIDATE_LIMIT];
  const [holds, plans, clearances, painReports] = await Promise.all([
    query<InjuryLinkCandidates['holds'][number]>(
      `select h.hold_id, h.scope, h.status, h.placed_at::text
         from pilot.training_holds h
        where h.organization_id = $1 and h.athlete_id = $2 and ${athleteNotDeletedSql('h')}
        order by h.placed_at desc limit $3`,
      params,
    ),
    query<InjuryLinkCandidates['plans'][number]>(
      `select p.plan_id, p.triggering_event, p.event_date::text, p.earliest_return_date::text, p.status
         from pilot.return_to_training_plans p
        where p.organization_id = $1 and p.athlete_id = $2 and ${athleteNotDeletedSql('p')}
        order by p.event_date desc, p.entered_at desc limit $3`,
      params,
    ),
    query<InjuryLinkCandidates['clearances'][number]>(
      `select m.status_id::text, m.status, m.effective_at::text
         from pilot.shadow_medical_administrative_status m
        where m.organization_id = $1 and m.athlete_id = $2 and ${athleteNotDeletedSql('m')}
        order by m.effective_at desc limit $3`,
      params,
    ),
    query<InjuryLinkCandidates['painReports'][number]>(
      `select n.near_miss_id::text, n.severity, n.created_at::text
         from pilot.shadow_near_misses n
        where n.organization_id = $1 and n.athlete_id = $2 and n.metadata->>'trigger' = 'athlete_pain_report'
          and ${athleteNotDeletedSql('n')}
        order by n.created_at desc limit $3`,
      params,
    ),
  ]);
  return { holds, plans, clearances, painReports };
}

/**
 * What the athlete and their linked guardians read (owner decision
 * 2026-10-04: a read-only view of their own records). ENUMERATED, and selected
 * column by column: the staff note, who recorded or edited it, and the ids of
 * linked staff records are never read out of the database for this audience,
 * so no later change to a route can forward them by accident. The expected
 * return is the linked plan's date when there is one, as staff see it.
 */
export interface FamilyInjury {
  injury_id: string;
  injury_date: string;
  body_area: InjuryBodyArea;
  injury_type: InjuryType;
  context: InjuryContext;
  reported_by: InjuryReportedBy;
  expected_return_date: string | null;
  returned_on: string | null;
}

/** The family projection, newest first; entered-in-error rows and deleted athletes left out. Caller authorizes. */
export async function listFamilyInjuries(organizationId: string, athleteId: string): Promise<FamilyInjury[]> {
  return query<FamilyInjury>(
    `select i.injury_id::text, i.injury_date::text, i.body_area, i.injury_type, i.context, i.reported_by,
            (case when i.linked_rtt_plan_id is not null then p.earliest_return_date
                  else i.expected_return_date end)::text as expected_return_date,
            i.returned_on::text
       from ${FROM}
      where i.organization_id = $1 and i.athlete_id = $2 and i.entered_in_error = false
        and ${athleteNotDeletedSql('i')}
      order by i.injury_date desc, i.created_at desc`,
    [organizationId, athleteId],
  );
}

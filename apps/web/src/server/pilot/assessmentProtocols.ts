import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';

// pilot.assessment_protocols and pilot.data_collection_requests, plus the
// additive columns on pilot.assessments, are owned by
// infra/azure/pilot_slice_postgres_assessment_protocols_migration.sql,
// applied through the apply-migrations workflow like every other table.
// Nothing here issues DDL.
//
// TWO RETEST TRIGGERS, DELIBERATELY SEPARATE. retest_interval_days and
// retest_after_training_hours can disagree -- see the migration's own
// comment. Neither function here collapses them into one "next due" value;
// callers that need both read both.

export type AssessmentMeasureKind = 'physical_test' | 'skill_rubric' | 'wellness' | 'questionnaire' | 'other';

export interface AssessmentProtocolRow {
  organization_id: string;
  protocol_id: string;
  protocol_version: number;
  name: string;
  measure_kind: AssessmentMeasureKind;
  source_ref: string | null;
  quality_measured: string;
  protocol_summary: string;
  equipment_needed: string;
  time_to_administer_min: number | null;
  retest_interval_days: number | null;
  retest_after_training_hours: number | null;
  retest_interval_basis: string;
  reliability_status: string;
  validity_status: string;
  evidence_class: string;
  boxing_specific: string;
  minimal_detectable_change: number | null;
  human_authority_required: boolean;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export type DataCollectionRequestKind =
  | 'observation'
  | 'video'
  | 'photo'
  | 'physical_test'
  | 'skill_rubric'
  | 'wellness_check'
  | 'document';

export type DataCollectionRequestStatus = 'open' | 'captured' | 'declined' | 'expired';

export interface DataCollectionRequestRow {
  organization_id: string;
  request_id: string;
  athlete_id: string | null;
  person_account_id: string | null;
  request_kind: DataCollectionRequestKind;
  protocol_id: string | null;
  protocol_version: number | null;
  prompt_text: string;
  reason_code: string;
  capture_hint: string;
  due_on: string | null;
  priority: 'low' | 'normal' | 'high';
  status: DataCollectionRequestStatus;
  captured_at: string | null;
  captured_by_account_id: string | null;
  media_ref: string | null;
  resulting_assessment_id: string | null;
  declined_reason: string | null;
  created_at: string;
  updated_at: string;
}

const PROTOCOL_FIELDS =
  'organization_id, protocol_id, protocol_version, name, measure_kind, source_ref, quality_measured, '
  + 'protocol_summary, equipment_needed, time_to_administer_min, retest_interval_days, '
  + 'retest_after_training_hours, retest_interval_basis, reliability_status, validity_status, '
  + 'evidence_class, boxing_specific, minimal_detectable_change, human_authority_required, active, '
  + 'created_at, updated_at';

const DCR_FIELDS =
  'organization_id, request_id, athlete_id, person_account_id, request_kind, protocol_id, protocol_version, '
  + 'prompt_text, reason_code, capture_hint, due_on, priority, status, captured_at, captured_by_account_id, '
  + 'media_ref, resulting_assessment_id, declined_reason, created_at, updated_at';

export async function listAssessmentProtocols(
  organizationId: string,
  filter: { measureKind?: AssessmentMeasureKind; active?: boolean } = {},
): Promise<AssessmentProtocolRow[]> {
  return query<AssessmentProtocolRow>(
    `select ${PROTOCOL_FIELDS}
     from pilot.assessment_protocols
     where organization_id = $1
       and ($2::text is null or measure_kind = $2)
       and ($3::boolean is null or active = $3)
     order by name, protocol_version desc`,
    [organizationId, filter.measureKind ?? null, filter.active ?? null],
  );
}

/** Highest version, active by default, unless a specific version is named. */
export async function getAssessmentProtocol(
  organizationId: string,
  protocolId: string,
  protocolVersion?: number,
): Promise<AssessmentProtocolRow | null> {
  return queryOne<AssessmentProtocolRow>(
    `select ${PROTOCOL_FIELDS}
     from pilot.assessment_protocols
     where organization_id = $1
       and protocol_id = $2
       and ($3::integer is null or protocol_version = $3)
     order by protocol_version desc
     limit 1`,
    [organizationId, protocolId, protocolVersion ?? null],
  );
}

/**
 * Un-administered assessments past due, using pilot_assessments_due, the
 * partial index on due_on where administered_on is null. Row shape kept
 * loose (Record) rather than a new interface: this reads pilot.assessments,
 * whose base shape belongs to a different module (assessments.ts, if one
 * exists) -- this function only adds the due-date filter this migration
 * introduced.
 */
export async function listDueAssessments(
  organizationId: string,
  filter: { athleteId?: string; asOf?: string } = {},
): Promise<Array<Record<string, unknown>>> {
  return query(
    `select *
     from pilot.assessments
     where organization_id = $1
       and administered_on is null
       and due_on is not null
       and due_on <= coalesce($3::date, current_date)
       and ($2::text is null or athlete_id = $2)
     order by due_on asc`,
    [organizationId, filter.athleteId ?? null, filter.asOf ?? null],
  );
}

export interface CreateDataCollectionRequestInput {
  organizationId: string;
  athleteId?: string | null;
  personAccountId?: string | null;
  requestKind: DataCollectionRequestKind;
  protocolId?: string | null;
  protocolVersion?: number | null;
  promptText: string;
  reasonCode: string;
  captureHint?: string;
  dueOn?: string | null;
  priority?: 'low' | 'normal' | 'high';
}

export async function createDataCollectionRequest(
  input: CreateDataCollectionRequestInput,
): Promise<DataCollectionRequestRow> {
  if (!input.athleteId && !input.personAccountId) {
    throw new Error('A data collection request requires an athlete_id or a person_account_id.');
  }

  const requestId = randomUUID();
  const row = await queryOne<DataCollectionRequestRow>(
    `insert into pilot.data_collection_requests
       (organization_id, request_id, athlete_id, person_account_id, request_kind, protocol_id,
        protocol_version, prompt_text, reason_code, capture_hint, due_on, priority)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     returning ${DCR_FIELDS}`,
    [
      input.organizationId,
      requestId,
      input.athleteId ?? null,
      input.personAccountId ?? null,
      input.requestKind,
      input.protocolId ?? null,
      input.protocolVersion ?? null,
      input.promptText,
      input.reasonCode,
      input.captureHint ?? '',
      input.dueOn ?? null,
      input.priority ?? 'normal',
    ],
  );
  if (!row) {
    throw new Error('Unable to create data collection request.');
  }
  return row;
}

/** The open queue a coach works from: highest priority and soonest-due first. */
export async function listOpenDataCollectionRequests(
  organizationId: string,
  filter: { athleteId?: string; personAccountId?: string } = {},
): Promise<DataCollectionRequestRow[]> {
  return query<DataCollectionRequestRow>(
    `select ${DCR_FIELDS}
     from pilot.data_collection_requests
     where organization_id = $1
       and status = 'open'
       and ($2::text is null or athlete_id = $2)
       and ($3::text is null or person_account_id = $3)
     order by case priority when 'high' then 0 when 'normal' then 1 else 2 end,
              due_on asc nulls last,
              created_at asc`,
    [organizationId, filter.athleteId ?? null, filter.personAccountId ?? null],
  );
}

export interface CaptureDataCollectionRequestInput {
  organizationId: string;
  requestId: string;
  capturedByAccountId: string;
  mediaRef?: string | null;
  resultingAssessmentId?: string | null;
}

/**
 * status='captured' requires captured_at AND captured_by_account_id
 * (pilot_dcr_captured) -- both are stamped together here, in the same
 * statement that sets status, so the two can never be set independently.
 */
export async function captureDataCollectionRequest(
  input: CaptureDataCollectionRequestInput,
): Promise<DataCollectionRequestRow> {
  const row = await queryOne<DataCollectionRequestRow>(
    `update pilot.data_collection_requests
     set status = 'captured',
         captured_at = now(),
         captured_by_account_id = $3,
         media_ref = coalesce($4, media_ref),
         resulting_assessment_id = coalesce($5, resulting_assessment_id),
         updated_at = now()
     where organization_id = $1 and request_id = $2 and status = 'open'
     returning ${DCR_FIELDS}`,
    [input.organizationId, input.requestId, input.capturedByAccountId, input.mediaRef ?? null, input.resultingAssessmentId ?? null],
  );
  if (!row) {
    throw new Error('DATA_COLLECTION_REQUEST_NOT_FOUND_OR_NOT_OPEN');
  }
  return row;
}

export async function declineDataCollectionRequest(input: {
  organizationId: string;
  requestId: string;
  declinedReason: string;
}): Promise<DataCollectionRequestRow> {
  const declinedReason = input.declinedReason.trim();
  if (!declinedReason) {
    throw new Error('Declining a data collection request requires a reason.');
  }

  const row = await queryOne<DataCollectionRequestRow>(
    `update pilot.data_collection_requests
     set status = 'declined',
         declined_reason = $3,
         updated_at = now()
     where organization_id = $1 and request_id = $2 and status = 'open'
     returning ${DCR_FIELDS}`,
    [input.organizationId, input.requestId, declinedReason],
  );
  if (!row) {
    throw new Error('DATA_COLLECTION_REQUEST_NOT_FOUND_OR_NOT_OPEN');
  }
  return row;
}

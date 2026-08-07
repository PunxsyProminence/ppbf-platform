import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';

// pilot.safety_flags, pilot.v_flag_calibration, pilot.return_to_training_plans
// and pilot.return_to_training_steps are owned by
// infra/azure/pilot_slice_postgres_safety_flags_migration.sql, applied
// through the apply-migrations workflow like every other table. Nothing here
// issues DDL.
//
// THE DESIGN PREMISE THIS MODULE EXISTS TO SERVE: a flag system tuned to
// never be wrong is tuned to never fire. resolveSafetyFlag requires a note
// on every resolution -- not friction, the training signal -- because it is
// the only mechanism by which a false positive is ever identified as one.
//
// MEDICAL DETERMINATIONS ARE NEVER COMPUTED HERE. No function in this
// module infers, shortens, or clears a rest period. A confirmed concussion,
// its rest period, and the earliest return date are all human-entered on
// pilot.return_to_training_plans; advancing a
// pilot.return_to_training_steps row is always a named human decision with
// a reason, never an automated clearance.

export type SafetyFlagClass = 'system_guidance' | 'external_rule';
export type SafetyFlagSeverity = 'advisory' | 'attention' | 'blocking_display';
export type SafetyFlagTriggeredBy = 'shadow_inference' | 'rule_evaluation' | 'human_entry';
export type SafetyFlagStatus = 'open' | 'acknowledged' | 'bypassed' | 'upheld' | 'expired' | 'withdrawn';
export type SafetyFlagResolution =
  | 'false_positive'
  | 'true_but_not_actionable'
  | 'acted_on'
  | 'acknowledged_external_constraint'
  | 'deferred';

// Flag codes pilot_safety_flags_medical_human_only requires
// triggered_by='human_entry' on. Kept as one exported set so the pre-insert
// check here and the constraint it mirrors can never silently drift apart.
export const MEDICAL_HUMAN_ONLY_FLAG_CODES: ReadonlySet<string> = new Set([
  'medical_clearance_missing',
  'concussion_rest_period',
  'rtp_not_cleared',
]);

const MIN_NOTE_LENGTH = 10;

export interface SafetyFlagRow {
  organization_id: string;
  flag_id: string;
  athlete_id: string | null;
  person_account_id: string | null;
  flag_class: SafetyFlagClass;
  flag_code: string;
  severity: SafetyFlagSeverity;
  triggered_by: SafetyFlagTriggeredBy;
  trigger_detail: string;
  evidence_basis: string;
  confidence_note: string;
  source_activity_id: string | null;
  source_reference: string | null;
  status: SafetyFlagStatus;
  resolution: SafetyFlagResolution | null;
  resolved_by_account_id: string | null;
  resolved_by_role: string | null;
  resolved_at: string | null;
  coach_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlagCalibrationRow {
  organization_id: string;
  flag_code: string;
  flag_class: SafetyFlagClass;
  total_raised: number;
  called_false_positive: number;
  acted_on: number;
  true_not_actionable: number;
  still_open: number;
  false_positive_pct: string | null;
  first_raised: string;
  last_raised: string;
}

const FLAG_FIELDS =
  'organization_id, flag_id, athlete_id, person_account_id, flag_class, flag_code, severity, '
  + 'triggered_by, trigger_detail, evidence_basis, confidence_note, source_activity_id, source_reference, '
  + 'status, resolution, resolved_by_account_id, resolved_by_role, resolved_at, coach_note, '
  + 'created_at, updated_at';

export interface RaiseSafetyFlagInput {
  organizationId: string;
  athleteId?: string | null;
  personAccountId?: string | null;
  flagClass: SafetyFlagClass;
  flagCode: string;
  severity?: SafetyFlagSeverity;
  triggeredBy: SafetyFlagTriggeredBy;
  triggerDetail?: string;
  evidenceBasis?: string;
  confidenceNote?: string;
  sourceActivityId?: string | null;
  sourceReference?: string | null;
}

/**
 * Raises a flag. A medical-vocabulary flag_code (see
 * MEDICAL_HUMAN_ONLY_FLAG_CODES) is refused up front for anything but
 * triggered_by='human_entry' -- pilot_safety_flags_medical_human_only is
 * the real enforcement, this is just a clean error ahead of the raw
 * constraint violation.
 */
export async function raiseSafetyFlag(input: RaiseSafetyFlagInput): Promise<SafetyFlagRow> {
  if (!input.athleteId && !input.personAccountId) {
    throw new Error('SAFETY_FLAG_SUBJECT_REQUIRED: a flag needs an athlete_id or a person_account_id');
  }
  if (MEDICAL_HUMAN_ONLY_FLAG_CODES.has(input.flagCode) && input.triggeredBy !== 'human_entry') {
    throw new Error(
      `SAFETY_FLAG_MEDICAL_CODE_REQUIRES_HUMAN_ENTRY: ${input.flagCode} may not be raised by SHADOW`,
    );
  }

  const flagId = randomUUID();
  const row = await queryOne<SafetyFlagRow>(
    `insert into pilot.safety_flags
       (organization_id, flag_id, athlete_id, person_account_id, flag_class, flag_code, severity,
        triggered_by, trigger_detail, evidence_basis, confidence_note, source_activity_id, source_reference)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     returning ${FLAG_FIELDS}`,
    [
      input.organizationId,
      flagId,
      input.athleteId ?? null,
      input.personAccountId ?? null,
      input.flagClass,
      input.flagCode,
      input.severity ?? 'advisory',
      input.triggeredBy,
      input.triggerDetail ?? '',
      input.evidenceBasis ?? '',
      input.confidenceNote ?? '',
      input.sourceActivityId ?? null,
      input.sourceReference ?? null,
    ],
  );
  if (!row) {
    throw new Error('Unable to raise safety flag.');
  }
  return row;
}

export async function listOpenSafetyFlags(
  organizationId: string,
  filter: { flagClass?: SafetyFlagClass; severity?: SafetyFlagSeverity; athleteId?: string } = {},
): Promise<SafetyFlagRow[]> {
  return query<SafetyFlagRow>(
    `select ${FLAG_FIELDS}
     from pilot.safety_flags
     where organization_id = $1
       and status = 'open'
       and ($2::text is null or flag_class = $2)
       and ($3::text is null or severity = $3)
       and ($4::text is null or athlete_id = $4)
     order by
       case severity when 'blocking_display' then 0 when 'attention' then 1 else 2 end,
       created_at desc`,
    [organizationId, filter.flagClass ?? null, filter.severity ?? null, filter.athleteId ?? null],
  );
}

export interface ResolveSafetyFlagInput {
  organizationId: string;
  flagId: string;
  status: 'acknowledged' | 'bypassed' | 'upheld' | 'withdrawn';
  resolution: SafetyFlagResolution;
  coachNote: string;
  resolvedByAccountId: string;
  resolvedByRole: string;
}

/**
 * Resolves an open flag. Refuses up front, ahead of the raw constraint
 * violations, for the same two reasons the migration enforces:
 * - a note under 10 characters (pilot_safety_flags_note_required)
 * - status='bypassed' on an external_rule flag (pilot_safety_flags_external_not_bypassed)
 */
export async function resolveSafetyFlag(input: ResolveSafetyFlagInput): Promise<SafetyFlagRow> {
  if (input.coachNote.trim().length < MIN_NOTE_LENGTH) {
    throw new Error(`SAFETY_FLAG_NOTE_TOO_SHORT: resolution note must be at least ${MIN_NOTE_LENGTH} characters`);
  }

  const existing = await queryOne<Pick<SafetyFlagRow, 'flag_class'>>(
    `select flag_class from pilot.safety_flags where organization_id = $1 and flag_id = $2`,
    [input.organizationId, input.flagId],
  );
  if (!existing) {
    throw new Error('SAFETY_FLAG_NOT_FOUND');
  }
  if (existing.flag_class === 'external_rule' && input.status === 'bypassed') {
    throw new Error('SAFETY_FLAG_EXTERNAL_RULE_CANNOT_BYPASS: use status=acknowledged instead');
  }

  const row = await queryOne<SafetyFlagRow>(
    `update pilot.safety_flags
       set status = $3, resolution = $4, coach_note = $5,
           resolved_by_account_id = $6, resolved_by_role = $7, resolved_at = now(), updated_at = now()
     where organization_id = $1 and flag_id = $2 and status = 'open'
     returning ${FLAG_FIELDS}`,
    [
      input.organizationId,
      input.flagId,
      input.status,
      input.resolution,
      input.coachNote.trim(),
      input.resolvedByAccountId,
      input.resolvedByRole,
    ],
  );
  if (!row) {
    throw new Error('SAFETY_FLAG_NOT_FOUND_OR_NOT_OPEN');
  }
  return row;
}

export async function getFlagCalibration(organizationId: string): Promise<FlagCalibrationRow[]> {
  return query<FlagCalibrationRow>(
    `select organization_id, flag_code, flag_class, total_raised, called_false_positive, acted_on,
            true_not_actionable, still_open, false_positive_pct, first_raised, last_raised
     from pilot.v_flag_calibration
     where organization_id = $1
     order by total_raised desc`,
    [organizationId],
  );
}

// ---------------------------------------------------------------------------
// Return-to-training intensity progression.

export type RttTriggeringEvent =
  | 'confirmed_concussion'
  | 'knockout'
  | 'technical_knockout'
  | 'injury'
  | 'illness'
  | 'other';
export type RttPlanStatus = 'active' | 'completed' | 'cancelled';
export type RttPermittedContact = 'none' | 'light_technical' | 'conditioned' | 'controlled_sparring' | 'open_sparring';
export type RttScaleLevel = 'A' | 'B' | 'C';

export interface ReturnToTrainingPlanRow {
  organization_id: string;
  plan_id: string;
  athlete_id: string;
  triggering_event: RttTriggeringEvent;
  event_date: string;
  authority_source: string;
  rest_period_days: number | null;
  earliest_return_date: string | null;
  medical_clearance_on_file: boolean;
  entered_by_account_id: string;
  entered_by_role: string;
  entered_at: string;
  status: RttPlanStatus;
  note: string;
}

export interface ReturnToTrainingStepRow {
  organization_id: string;
  step_id: string;
  plan_id: string;
  week_number: number;
  intensity_label: string;
  permitted_contact: RttPermittedContact;
  permitted_scale_level: RttScaleLevel | null;
  planned_note: string;
  advanced_by_account_id: string | null;
  advanced_at: string | null;
  advancement_note: string | null;
}

const PLAN_FIELDS =
  'organization_id, plan_id, athlete_id, triggering_event, event_date, authority_source, rest_period_days, '
  + 'earliest_return_date, medical_clearance_on_file, entered_by_account_id, entered_by_role, entered_at, '
  + 'status, note';

const STEP_FIELDS =
  'organization_id, step_id, plan_id, week_number, intensity_label, permitted_contact, permitted_scale_level, '
  + 'planned_note, advanced_by_account_id, advanced_at, advancement_note';

export interface CreateReturnToTrainingPlanInput {
  organizationId: string;
  athleteId: string;
  triggeringEvent: RttTriggeringEvent;
  eventDate: string;
  authoritySource: string;
  restPeriodDays?: number | null;
  earliestReturnDate?: string | null;
  medicalClearanceOnFile?: boolean;
  enteredByAccountId: string;
  enteredByRole: string;
  note?: string;
}

/**
 * The rest period and earliest return date are HUMAN-ENTERED from the
 * governing rule (USA Boxing rulebook, a physician) -- this function never
 * computes either.
 */
export async function createReturnToTrainingPlan(
  input: CreateReturnToTrainingPlanInput,
): Promise<ReturnToTrainingPlanRow> {
  const planId = randomUUID();
  const row = await queryOne<ReturnToTrainingPlanRow>(
    `insert into pilot.return_to_training_plans
       (organization_id, plan_id, athlete_id, triggering_event, event_date, authority_source,
        rest_period_days, earliest_return_date, medical_clearance_on_file, entered_by_account_id,
        entered_by_role, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     returning ${PLAN_FIELDS}`,
    [
      input.organizationId,
      planId,
      input.athleteId,
      input.triggeringEvent,
      input.eventDate,
      input.authoritySource,
      input.restPeriodDays ?? null,
      input.earliestReturnDate ?? null,
      input.medicalClearanceOnFile ?? false,
      input.enteredByAccountId,
      input.enteredByRole,
      input.note ?? '',
    ],
  );
  if (!row) {
    throw new Error('Unable to create return-to-training plan.');
  }
  return row;
}

export async function listReturnToTrainingPlans(
  organizationId: string,
  filter: { athleteId?: string; status?: RttPlanStatus } = {},
): Promise<ReturnToTrainingPlanRow[]> {
  return query<ReturnToTrainingPlanRow>(
    `select ${PLAN_FIELDS}
     from pilot.return_to_training_plans
     where organization_id = $1
       and ($2::text is null or athlete_id = $2)
       and ($3::text is null or status = $3)
     order by entered_at desc`,
    [organizationId, filter.athleteId ?? null, filter.status ?? null],
  );
}

export interface AddReturnToTrainingStepInput {
  organizationId: string;
  planId: string;
  weekNumber: number;
  intensityLabel: string;
  permittedContact?: RttPermittedContact;
  permittedScaleLevel?: RttScaleLevel | null;
  plannedNote?: string;
}

export async function addReturnToTrainingStep(
  input: AddReturnToTrainingStepInput,
): Promise<ReturnToTrainingStepRow> {
  const stepId = randomUUID();
  try {
    const row = await queryOne<ReturnToTrainingStepRow>(
      `insert into pilot.return_to_training_steps
         (organization_id, step_id, plan_id, week_number, intensity_label, permitted_contact,
          permitted_scale_level, planned_note)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning ${STEP_FIELDS}`,
      [
        input.organizationId,
        stepId,
        input.planId,
        input.weekNumber,
        input.intensityLabel,
        input.permittedContact ?? 'none',
        input.permittedScaleLevel ?? null,
        input.plannedNote ?? '',
      ],
    );
    if (!row) {
      throw new Error('Unable to add return-to-training step.');
    }
    return row;
  } catch (error) {
    const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
    if (code === '23505' && constraint === 'pilot_rtt_steps_week_uq') {
      throw new Error('RTT_STEP_WEEK_DUPLICATE');
    }
    throw error;
  }
}

export async function listReturnToTrainingSteps(
  organizationId: string,
  planId: string,
): Promise<ReturnToTrainingStepRow[]> {
  return query<ReturnToTrainingStepRow>(
    `select ${STEP_FIELDS}
     from pilot.return_to_training_steps
     where organization_id = $1 and plan_id = $2
     order by week_number asc`,
    [organizationId, planId],
  );
}

export interface AdvanceReturnToTrainingStepInput {
  organizationId: string;
  stepId: string;
  advancedByAccountId: string;
  advancementNote: string;
}

/**
 * Advancing a step is a decision, never an automated clearance. Refuses a
 * note under 10 characters up front, matching pilot_rtt_steps_advance.
 */
export async function advanceReturnToTrainingStep(
  input: AdvanceReturnToTrainingStepInput,
): Promise<ReturnToTrainingStepRow> {
  if (input.advancementNote.trim().length < MIN_NOTE_LENGTH) {
    throw new Error(`RTT_STEP_ADVANCEMENT_NOTE_REQUIRED: note must be at least ${MIN_NOTE_LENGTH} characters`);
  }

  const row = await queryOne<ReturnToTrainingStepRow>(
    `update pilot.return_to_training_steps
       set advanced_by_account_id = $3, advanced_at = now(), advancement_note = $4
     where organization_id = $1 and step_id = $2 and advanced_at is null
     returning ${STEP_FIELDS}`,
    [input.organizationId, input.stepId, input.advancedByAccountId, input.advancementNote.trim()],
  );
  if (!row) {
    throw new Error('RTT_STEP_NOT_FOUND_OR_ALREADY_ADVANCED');
  }
  return row;
}

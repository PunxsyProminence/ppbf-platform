import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';

// pilot.clearance_types, pilot.person_clearances,
// pilot.activity_clearance_requirements and the view pilot.v_clearance_status
// are owned by
// infra/azure/pilot_slice_postgres_clearance_register_migration.sql, applied
// through the apply-migrations workflow like every other table. Nothing here
// issues DDL.
//
// THIS MODULE DOES NOT AUTHORIZE ANYTHING. getClearanceStatus reads a
// read-only view that DISPLAYS a factual comparison between recorded
// clearances and human-authored requirements. No function here blocks an
// assignment, infers a requirement, or extends an expiry -- see the
// migration's own header for why that boundary is deliberate. Whether a
// given clearance satisfies PA Act 153/Act 15 for a given role is a legal
// determination made by qualified humans; recordPersonClearance below only
// records what a human already decided.

export type ClearanceAuthorityKind = 'state_statutory' | 'federal' | 'governing_body' | 'internal_approval';
export type ClearanceStatus = 'not_started' | 'submitted' | 'current' | 'expired' | 'revoked' | 'not_required';
export type ActivityScope =
  | 'supervise_sparring'
  | 'corner_competition'
  | 'coach_youth_session'
  | 'unsupervised_youth_contact'
  | 'supervised_gym_service'
  | 'transport_athletes'
  | 'board_or_admin'
  | 'observer_only';
export type ClearanceRequirementKind = 'required' | 'required_or_supervised' | 'recommended';

export interface ClearanceTypeRow {
  organization_id: string;
  clearance_type_id: string;
  name: string;
  issuing_authority: string;
  authority_kind: ClearanceAuthorityKind;
  level_label: string | null;
  validity_months: number | null;
  renewal_grace_days: number;
  external_reference: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PersonClearanceRow {
  organization_id: string;
  clearance_id: string;
  person_account_id: string;
  clearance_type_id: string;
  status: ClearanceStatus;
  issued_on: string | null;
  expires_on: string | null;
  document_ref: string | null;
  verified_by_account_id: string | null;
  verified_at: string | null;
  verification_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActivityClearanceRequirementRow {
  organization_id: string;
  requirement_id: string;
  activity_scope: ActivityScope;
  clearance_type_id: string;
  requirement_kind: ClearanceRequirementKind;
  approved_by_account_id: string;
  approved_at: string;
  policy_note: string;
  created_at: string;
}

export type ClearanceDisplayState = 'on_file' | 'expired' | 'revoked' | 'missing';

export interface ClearanceStatusRow {
  organization_id: string;
  activity_scope: ActivityScope;
  person_account_id: string;
  clearance_name: string;
  issuing_authority: string;
  requirement_kind: ClearanceRequirementKind;
  clearance_status: ClearanceStatus;
  expires_on: string | null;
  display_state: ClearanceDisplayState;
}

const CLEARANCE_TYPE_FIELDS =
  'organization_id, clearance_type_id, name, issuing_authority, authority_kind, level_label, '
  + 'validity_months, renewal_grace_days, external_reference, active, created_at, updated_at';

const PERSON_CLEARANCE_FIELDS =
  'organization_id, clearance_id, person_account_id, clearance_type_id, status, issued_on, expires_on, '
  + 'document_ref, verified_by_account_id, verified_at, verification_note, created_at, updated_at';

const REQUIREMENT_FIELDS =
  'organization_id, requirement_id, activity_scope, clearance_type_id, requirement_kind, '
  + 'approved_by_account_id, approved_at, policy_note, created_at';

export async function listClearanceTypes(
  organizationId: string,
  filter: { active?: boolean } = {},
): Promise<ClearanceTypeRow[]> {
  return query<ClearanceTypeRow>(
    `select ${CLEARANCE_TYPE_FIELDS}
     from pilot.clearance_types
     where organization_id = $1
       and ($2::boolean is null or active = $2)
     order by name`,
    [organizationId, filter.active ?? null],
  );
}

export async function listPersonClearances(
  organizationId: string,
  filter: { personAccountId?: string } = {},
): Promise<PersonClearanceRow[]> {
  return query<PersonClearanceRow>(
    `select ${PERSON_CLEARANCE_FIELDS}
     from pilot.person_clearances
     where organization_id = $1
       and ($2::text is null or person_account_id = $2)
     order by person_account_id, clearance_type_id`,
    [organizationId, filter.personAccountId ?? null],
  );
}

/**
 * Records what a human already decided about one person's clearance -- it
 * does not decide anything itself. status='current' requires
 * verified_by_account_id, verified_at, and issued_on
 * (pilot_person_clearances_current); callers passing status='current'
 * without a verifier hit that constraint, same as any other write path.
 * Upserts on (organization_id, person_account_id, clearance_type_id): a
 * clearance's history of statuses is not tracked row-by-row here, only its
 * current state, matching the register's own scope (surface today's
 * standing, not an audit trail -- that lives in pilot.audit_events via the
 * calling route).
 */
export async function recordPersonClearance(input: {
  organizationId: string;
  personAccountId: string;
  clearanceTypeId: string;
  status: ClearanceStatus;
  issuedOn?: string | null;
  expiresOn?: string | null;
  documentRef?: string | null;
  verifiedByAccountId?: string | null;
  verificationNote?: string | null;
}): Promise<PersonClearanceRow> {
  const clearanceId = randomUUID();
  const row = await queryOne<PersonClearanceRow>(
    `insert into pilot.person_clearances
       (organization_id, clearance_id, person_account_id, clearance_type_id, status, issued_on, expires_on,
        document_ref, verified_by_account_id, verified_at, verification_note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,case when $9::text is null then null else now() end,$10)
     on conflict (organization_id, person_account_id, clearance_type_id) do update
       set status = excluded.status,
           issued_on = excluded.issued_on,
           expires_on = excluded.expires_on,
           document_ref = excluded.document_ref,
           verified_by_account_id = excluded.verified_by_account_id,
           verified_at = excluded.verified_at,
           verification_note = excluded.verification_note,
           updated_at = now()
     returning ${PERSON_CLEARANCE_FIELDS}`,
    [
      input.organizationId,
      clearanceId,
      input.personAccountId,
      input.clearanceTypeId,
      input.status,
      input.issuedOn ?? null,
      input.expiresOn ?? null,
      input.documentRef ?? null,
      input.verifiedByAccountId ?? null,
      input.verificationNote ?? null,
    ],
  );
  if (!row) {
    throw new Error('Unable to record person clearance.');
  }
  return row;
}

export async function listActivityClearanceRequirements(
  organizationId: string,
  filter: { activityScope?: ActivityScope } = {},
): Promise<ActivityClearanceRequirementRow[]> {
  return query<ActivityClearanceRequirementRow>(
    `select ${REQUIREMENT_FIELDS}
     from pilot.activity_clearance_requirements
     where organization_id = $1
       and ($2::text is null or activity_scope = $2)
     order by activity_scope`,
    [organizationId, filter.activityScope ?? null],
  );
}

/**
 * Reads pilot.v_clearance_status -- advisory display only. See this
 * module's header: no function here (this one included) may be used to
 * gate an assignment. It answers "what does the record show", not "is this
 * person allowed".
 */
export async function getClearanceStatus(
  organizationId: string,
  filter: { activityScope?: ActivityScope; personAccountId?: string } = {},
): Promise<ClearanceStatusRow[]> {
  return query<ClearanceStatusRow>(
    `select organization_id, activity_scope, person_account_id, clearance_name, issuing_authority,
            requirement_kind, clearance_status, expires_on, display_state
     from pilot.v_clearance_status
     where organization_id = $1
       and ($2::text is null or activity_scope = $2)
       and ($3::text is null or person_account_id = $3)
     order by activity_scope, person_account_id`,
    [organizationId, filter.activityScope ?? null, filter.personAccountId ?? null],
  );
}

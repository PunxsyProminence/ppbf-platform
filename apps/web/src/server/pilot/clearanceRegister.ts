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

/**
 * Every role that can plausibly hold a staff credential -- the set that may
 * self-upload a document (app/coach/credentials) and the set the broad
 * status page (app/staff-credentials) lists. Kept as one list so the two
 * surfaces cannot silently drift: a role that can upload a credential should
 * appear on the status page showing it, and a role listed on the status page
 * should be one that can actually clear the "missing" state by uploading.
 *
 * 'athlete', 'parent', 'board' and 'platform_owner' are deliberately absent.
 * Athletes and parents are not staff and do not hold SafeSport/coach/CPR
 * credentials in this domain; board is an organization-level oversight role,
 * not a floor role; platform_owner operates across organizations and holds
 * no single gym's credentials. This is a product judgment call, not a
 * constraint the schema enforces -- see the ticket note this module's
 * caller was built against.
 */
export const STAFF_CREDENTIAL_ROLES = ['coach', 'admin', 'organization_admin', 'staff', 'volunteer'] as const;

/**
 * Where a credential display state lands, computed at READ time from the
 * status a human recorded and today's date -- never written back. This is
 * the same "no cron, read-time sweep" house style trainingHolds.ts documents
 * for its own expiry: a clearance whose expires_on has quietly passed shows
 * as expired the next time anyone reads it, without any job walking the
 * table to flip a flag.
 *
 * 'expiring_soon' is a DISPLAY judgment only (the ticket's 30-day alert
 * window) and is not one of pilot.person_clearances.status's five stored
 * values -- it exists only so a coach or admin sees an expiry coming before
 * it lapses; nothing about the underlying stored status changes.
 */
export type CredentialBand =
  | 'current'
  | 'expiring_soon'
  | 'expired'
  | 'submitted'
  | 'revoked'
  | 'not_required'
  | 'missing';

const EXPIRING_SOON_WINDOW_DAYS = 30;

export function deriveCredentialBand(
  status: ClearanceStatus,
  expiresOn: string | null,
  today: Date = new Date(),
): CredentialBand {
  if (status === 'revoked') return 'revoked';
  if (status === 'not_required') return 'not_required';
  if (status === 'submitted') return 'submitted';
  if (status === 'not_started') return 'missing';

  // status is 'current' or 'expired' from here. Either can have quietly
  // aged past its own expires_on since it was last written, which is exactly
  // what this function exists to catch without a cron job.
  if (expiresOn) {
    const expiryDate = new Date(`${expiresOn}T00:00:00Z`);
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    if (expiryDate.getTime() < todayUtc.getTime()) return 'expired';
    const warnAt = new Date(todayUtc.getTime() + EXPIRING_SOON_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    if (expiryDate.getTime() <= warnAt.getTime()) return 'expiring_soon';
  }

  return status === 'expired' ? 'expired' : 'current';
}

/**
 * A SUGGESTED expiry, from an issue date and the clearance type's own
 * validity_months -- not an automatic one. The admin route below only uses
 * this to fill in expires_on when the admin submitted issued_on but left
 * expires_on blank; the admin's own explicit value, when given, always
 * wins over this. Returns null when there is nothing to compute from (no
 * validity_months on the type, meaning the type does not expire), which the
 * caller must then treat as "no expiry", not as a failure.
 *
 * Calendar-month arithmetic (not a fixed day count), so a 12-month
 * SafeSport cert issued on the 31st lands on the nearest valid date the
 * following year rather than drifting by a few days the way `+365 days`
 * would.
 */
export function computeClearanceExpiry(issuedOn: string, validityMonths: number | null): string | null {
  if (!validityMonths) return null;
  const issued = new Date(`${issuedOn}T00:00:00Z`);
  if (Number.isNaN(issued.getTime())) return null;
  const expiry = new Date(Date.UTC(issued.getUTCFullYear(), issued.getUTCMonth() + validityMonths, issued.getUTCDate()));
  return expiry.toISOString().slice(0, 10);
}

export interface CredentialQueueRow {
  organization_id: string;
  clearance_id: string;
  person_account_id: string;
  person_login_email: string | null;
  person_role: PilotRoleLike;
  clearance_type_id: string;
  clearance_name: string;
  issuing_authority: string;
  validity_months: number | null;
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

// Kept local rather than imported from ./contracts: this module only needs
// "a role string", and importing the full PilotRole union here would make a
// display-only read function a coupling point for the role vocabulary.
type PilotRoleLike = string;

/**
 * Every person_clearances row in the organization, joined to the clearance
 * type's own name/authority/validity and the holder's login email -- the
 * single read the admin verification queue (app/admin/credentials) needs.
 * Includes document_ref: unlike listStaffCredentialStatus below, this feeds
 * an ADMIN-ONLY page whose whole purpose is reviewing submitted documents,
 * not the broadly-visible status page.
 */
export async function listPersonClearancesForVerification(organizationId: string): Promise<CredentialQueueRow[]> {
  return query<CredentialQueueRow>(
    `select
       pc.organization_id, pc.clearance_id, pc.person_account_id,
       a.login_email as person_login_email, a.role as person_role,
       pc.clearance_type_id, ct.name as clearance_name, ct.issuing_authority, ct.validity_months,
       pc.status, pc.issued_on, pc.expires_on, pc.document_ref,
       pc.verified_by_account_id, pc.verified_at, pc.verification_note,
       pc.created_at, pc.updated_at
     from pilot.person_clearances pc
     join pilot.clearance_types ct
       on ct.organization_id = pc.organization_id and ct.clearance_type_id = pc.clearance_type_id
     join pilot.accounts a
       on a.organization_id = pc.organization_id and a.account_id = pc.person_account_id
     where pc.organization_id = $1
     order by pc.status = 'submitted' desc, pc.expires_on nulls last, a.login_email`,
    [organizationId],
  );
}

/**
 * One person_clearances row scoped to a single (person, clearance type)
 * pair -- what a verify/reject action needs to confirm a submission exists
 * in THIS organization before acting on it, and to read the existing
 * document_ref forward so an admin decision never has to re-supply it.
 *
 * Deliberately org-scoped in the WHERE clause rather than trusting the
 * caller: a row simply does not exist under this function's result for an
 * account that belongs to a different organization, which is what keeps an
 * admin's verify/reject action from ever being able to act on another gym's
 * credential by guessing an account id.
 */
export async function getPersonClearanceForOrganization(
  organizationId: string,
  personAccountId: string,
  clearanceTypeId: string,
): Promise<PersonClearanceRow | null> {
  return queryOne<PersonClearanceRow>(
    `select ${PERSON_CLEARANCE_FIELDS}
     from pilot.person_clearances
     where organization_id = $1 and person_account_id = $2 and clearance_type_id = $3`,
    [organizationId, personAccountId, clearanceTypeId],
  );
}

export interface StaffCredentialStatusRow {
  account_id: string;
  role: PilotRoleLike;
  login_email: string | null;
  clearance_type_id: string;
  clearance_name: string;
  issuing_authority: string;
  status: ClearanceStatus;
  expires_on: string | null;
}

/**
 * Every (staff member) x (active clearance type) pair in the organization,
 * for the BROADLY VISIBLE status page -- any signed-in user, any role. This
 * is the read the product owner asked for by name: "parents/athletes should
 * be able to see the staff are well-trained and certified."
 *
 * Deliberately does NOT select document_ref, verified_by_account_id or
 * verification_note. Those are for the admin queue
 * (listPersonClearancesForVerification) and the self-upload page only; this
 * query cannot leak them because it never reads them, which is a stronger
 * guarantee than trusting every caller to drop the field before responding.
 *
 * Unlike pilot.v_clearance_status (getClearanceStatus above), this does NOT
 * depend on pilot.activity_clearance_requirements existing -- that table is
 * human-authored only and may be empty for a gym that has not yet mapped
 * activities to requirements, which would leave the view showing nothing.
 * This instead cross-joins every staff-ish role directly, the same shape
 * the view itself uses for its own cross join, just against roles instead
 * of activity requirements.
 */
export async function listStaffCredentialStatus(
  organizationId: string,
  roles: readonly string[] = STAFF_CREDENTIAL_ROLES,
): Promise<StaffCredentialStatusRow[]> {
  return query<StaffCredentialStatusRow>(
    `select
       a.account_id, a.role, a.login_email,
       ct.clearance_type_id, ct.name as clearance_name, ct.issuing_authority,
       coalesce(pc.status, 'not_started') as status, pc.expires_on
     from pilot.accounts a
     cross join pilot.clearance_types ct
     left join pilot.person_clearances pc
       on pc.organization_id = a.organization_id
      and pc.person_account_id = a.account_id
      and pc.clearance_type_id = ct.clearance_type_id
     where a.organization_id = $1
       and a.active_flag = true
       and ct.organization_id = $1
       and ct.active = true
       and a.role = any($2::text[])
     order by a.login_email, a.account_id, ct.name`,
    [organizationId, [...roles]],
  );
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

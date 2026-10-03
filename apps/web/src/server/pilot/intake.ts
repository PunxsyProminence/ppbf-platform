import { randomUUID } from 'node:crypto';

import type { PoolClient, QueryResultRow } from 'pg';

import {
  assertActorCanAccessAthlete,
  isOrganizationAdminRole,
  type ActorIdentity,
} from './access';
import type { PilotAthlete, PilotRole } from './contracts';
import { query, queryOne, withTransaction } from './db';
import { accountDeletedSql, isDeletedAccount } from './deletedAccountSignIn';
import { upsertAthlete } from './entities';
import { ConflictError } from './errors';
import type { ReadinessMethod } from './readinessProvenance';
import { getShadowEventTimeline, getShadowReviewProjection } from './shadowReadModels';

export type IntakeDocumentType =
  | 'athlete_registration'
  | 'emergency_contact'
  | 'medical_form'
  | 'waiver_consent'
  | 'assessment_document'
  | 'general_intake';

export type IntakeCaseStatus = 'pending_review' | 'approved' | 'rejected' | 'promoted';

export interface IntakeCaseRecord {
  organization_id: string;
  intake_case_id: string;
  status: IntakeCaseStatus;
  primary_athlete_id: string | null;
  source_shadow_intake_id: string | null;
  summary: string;
  submitted_by_account_id: string;
  reviewed_by_account_id: string | null;
  review_notes: string | null;
  promoted_at: string | null;
  rejected_at: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface IntakeDocumentRecord {
  organization_id: string;
  intake_document_id: string;
  intake_case_id: string;
  shadow_intake_id: string | null;
  document_type: IntakeDocumentType;
  file_name: string;
  blob_path: string;
  classification: string;
  review_status: IntakeCaseStatus;
  owner_entity_type: string | null;
  owner_entity_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export function isIntakeDocumentReadyForReview(
  document: Pick<IntakeDocumentRecord, 'metadata'>,
): boolean {
  const metadata = document.metadata;
  return (
    (metadata.security_state === 'clean' || metadata.quarantine_status === 'clean')
    && metadata.extraction_state === 'ready_for_review'
  );
}

export interface IntakePromotionPayload {
  athlete: {
    athlete_id: string;
    account_id?: string;
    pin?: string;
    full_name: string;
    dob: string;
    weight_class: string;
    gym_status: string;
    emergency_contact: string;
    coach_id: string;
  };
  guardian?: {
    parent_id: string;
    account_id?: string;
    /**
     * @deprecated Rejected at the boundary rather than ignored.
     *
     * A guardian account provisioned with a PIN cannot be used: PIN sign-in is
     * athlete-only, and resolvePrincipal revokes any live session belonging to
     * a local non-athlete account on sight. Supplying this used to produce an
     * account nobody could log into, so a caller still sending it is asking for
     * something that cannot work and is told so.
     *
     * Guardians authenticate with Microsoft; supply `email` instead.
     */
    pin?: string;
    full_name: string;
    phone?: string;
    /** Required when `account_id` is set -- it is the guardian's login identity. */
    email?: string;
    relationship_to_athlete?: string;
  };
  emergency_contact?: {
    contact_id?: string;
    full_name: string;
    relationship_to_athlete: string;
    phone: string;
    email?: string;
    is_primary?: boolean;
    notes?: string;
  };
  medical?: {
    medical_id?: string;
    conditions?: string;
    medications?: string;
    allergies?: string;
    physician_name?: string;
    physician_phone?: string;
    clearance_status?: string;
    notes?: string;
  };
  waiver?: {
    waiver_id?: string;
    waiver_type: string;
    signed_by_name: string;
    signed_by_role: string;
    signed_at: string;
    consent_version: string;
    status: string;
    notes?: string;
  };
  assessment?: {
    assessment_id?: string;
    assessment_type: string;
    result: Record<string, unknown>;
  };
  attendance?: {
    attendance_id?: string;
    attendance_date: string;
    status: string;
    notes?: string;
  };
  readiness?: {
    readiness_id?: string;
    score: number;
    category: string;
    measured_at: string;
    recovery_notes?: string;
  };
  coach_note?: {
    note_id?: string;
    note_type?: string;
    note_text: string;
  };
}

export async function createIntakeCase(params: {
  organizationId: string;
  submittedByAccountId: string;
  summary: string;
  sourceShadowIntakeId?: string;
  primaryAthleteId?: string;
  payload?: Record<string, unknown>;
}): Promise<string> {
  const intakeCaseId = randomUUID();

  await query(
    `insert into pilot.intake_cases
     (organization_id, intake_case_id, status, primary_athlete_id, source_shadow_intake_id, summary, submitted_by_account_id, payload)
     values ($1,$2,'pending_review',$3,$4,$5,$6,$7::jsonb)`,
    [
      params.organizationId,
      intakeCaseId,
      params.primaryAthleteId ?? null,
      params.sourceShadowIntakeId ?? null,
      params.summary,
      params.submittedByAccountId,
      JSON.stringify(params.payload ?? {}),
    ],
  );

  return intakeCaseId;
}

export async function createIntakeDocument(params: {
  organizationId: string;
  intakeCaseId: string;
  shadowIntakeId?: string;
  documentType: IntakeDocumentType;
  fileName: string;
  blobPath: string;
  classification: string;
  reviewStatus?: IntakeCaseStatus;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const intakeDocumentId = randomUUID();

  await query(
    `insert into pilot.intake_documents
     (organization_id, intake_document_id, intake_case_id, shadow_intake_id, document_type, file_name, blob_path, classification, review_status, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [
      params.organizationId,
      intakeDocumentId,
      params.intakeCaseId,
      params.shadowIntakeId ?? null,
      params.documentType,
      params.fileName,
      params.blobPath,
      params.classification,
      params.reviewStatus ?? 'pending_review',
      JSON.stringify(params.metadata ?? {}),
    ],
  );

  return intakeDocumentId;
}

export async function listReviewQueue(
  organizationId: string,
  context?: { actorAccountId: string; actorRole: PilotRole },
): Promise<Array<{
  intake_case_id: string;
  status: IntakeCaseStatus;
  summary: string;
  primary_athlete_id: string | null;
  created_at: string;
  updated_at: string;
  document_count: number;
}>> {
  if (context) {
    const projection = await getShadowReviewProjection(
      {
        organizationId,
        actorAccountId: context.actorAccountId,
        actorRole: context.actorRole,
      },
      { limit: 200 },
    );

    return projection.items;
  }

  return query(
    `select
       c.intake_case_id,
       c.status,
       c.summary,
       c.primary_athlete_id,
       c.created_at,
       c.updated_at,
       coalesce(count(d.intake_document_id), 0)::int as document_count
     from pilot.intake_cases c
     left join pilot.intake_documents d
       on d.organization_id = c.organization_id
      and d.intake_case_id = c.intake_case_id
     where c.organization_id = $1
     group by c.organization_id, c.intake_case_id
     order by c.updated_at desc`,
    [organizationId],
  );
}

export async function getIntakeCaseById(organizationId: string, intakeCaseId: string): Promise<IntakeCaseRecord | null> {
  return queryOne<IntakeCaseRecord>(
    'select * from pilot.intake_cases where organization_id = $1 and intake_case_id = $2',
    [organizationId, intakeCaseId],
  );
}

export async function listIntakeDocumentsByCase(organizationId: string, intakeCaseId: string): Promise<IntakeDocumentRecord[]> {
  return query<IntakeDocumentRecord>(
    'select * from pilot.intake_documents where organization_id = $1 and intake_case_id = $2 order by created_at asc',
    [organizationId, intakeCaseId],
  );
}

export async function getIntakeDocumentById(
  organizationId: string,
  intakeDocumentId: string,
): Promise<IntakeDocumentRecord | null> {
  return queryOne<IntakeDocumentRecord>(
    'select * from pilot.intake_documents where organization_id = $1 and intake_document_id = $2',
    [organizationId, intakeDocumentId],
  );
}

/**
 * Who an intake case is ABOUT -- resolved from the only two places this
 * codebase has ever recorded it, and honest about the fact that for most of a
 * case's life the answer is "nobody yet".
 *
 * `pilot.intake_cases.primary_athlete_id` is the column the schema intends
 * for this, and no code path writes it. `createIntakeCase` is reachable from
 * exactly one caller (app/api/pilot/shadow/upload/route.ts), which never
 * passes `primaryAthleteId`; `updateIntakeCaseStatus` does not touch the
 * column; and no other statement in the repository updates it. Every row
 * carries NULL. That is why a gate spelled `if (primary_athlete_id) await
 * assertActorCanAccessAthlete(...)` was dead on every row it ever guarded.
 *
 * `pilot.intake_documents.owner_entity_type/owner_entity_id` are written --
 * `bindIntakeDocumentsToOwner` stamps ('athlete', <athlete_id>) across the
 * whole case at promotion -- so they are the real subject linkage. But they
 * only exist from promotion onward, and the review queue exposes a case for
 * the whole pending window BEFORE that. A gate keyed on the owner columns
 * alone would therefore be dead in exactly the window that matters, which is
 * the same mistake in a different column.
 *
 * So this returns what is knowable and refuses to guess. An empty
 * `subjectAthleteIds` means "not attributable to an athlete yet" -- never
 * "open to anyone" -- and `assertActorCanAccessIntakeCase` is what turns that
 * into a decision.
 */
export interface IntakeCaseAuthority {
  /** False when no such case exists in this organization. */
  found: boolean;
  /** The account that filed the case. NOT NULL in schema; null only when !found. */
  submittedByAccountId: string | null;
  /** Every athlete this case is about, from both sources, de-duplicated. */
  subjectAthleteIds: string[];
}

export async function resolveIntakeCaseAuthority(
  organizationId: string,
  intakeCaseId: string,
): Promise<IntakeCaseAuthority> {
  const intakeCase = await queryOne<{ primary_athlete_id: string | null; submitted_by_account_id: string }>(
    `select primary_athlete_id, submitted_by_account_id
     from pilot.intake_cases
     where organization_id = $1 and intake_case_id = $2`,
    [organizationId, intakeCaseId],
  );

  if (!intakeCase) {
    return { found: false, submittedByAccountId: null, subjectAthleteIds: [] };
  }

  // `owner_entity_type = 'athlete'` is not decoration. The column is free
  // text; the single writer sets 'athlete', and an owner this code cannot map
  // to an athlete must NOT silently widen the gate -- it drops the case back
  // to unattributed, which is the closed side.
  const owners = await query<{ owner_entity_id: string }>(
    `select distinct owner_entity_id
     from pilot.intake_documents
     where organization_id = $1
       and intake_case_id = $2
       and owner_entity_type = 'athlete'
       and owner_entity_id is not null`,
    [organizationId, intakeCaseId],
  );

  const subjectAthleteIds = Array.from(new Set([
    ...(intakeCase.primary_athlete_id ? [intakeCase.primary_athlete_id] : []),
    ...owners.map((row) => row.owner_entity_id),
  ]));

  return {
    found: true,
    submittedByAccountId: intakeCase.submitted_by_account_id,
    subjectAthleteIds,
  };
}

/**
 * The gate every intake-case read must pass BEFORE it reads anything, and the
 * one all three case-scoped routes share so they cannot drift apart.
 *
 * Two branches, because the data has two states and only one of them names a
 * person:
 *
 *  1. The case resolves to one or more athletes -- gate on every one of them
 *     through `assertActorCanAccessAthlete`. All must pass: a case whose
 *     documents span two athletes discloses both, so reaching one of them is
 *     not authority over the case.
 *  2. The case resolves to nobody (today: every pending case). There is no
 *     athlete to check, so the authority falls back to the case's own
 *     relationships: the organization admin, whose review authority is
 *     organization-wide by definition, and the account that filed the case,
 *     who supplied the documents in the first place. Everyone else is refused.
 *
 * Branch 2 is deliberately narrower than the role gate above it. A pending
 * case's summary, payload and document rows carry intake file names, and an
 * intake file name routinely carries a child's name -- so "any coach in the
 * organization" is not a defensible audience for a case that coach has no
 * relationship to. The only surface that calls these routes is /admin/shadow
 * (allowedRoles admin, platform_owner), so no existing coach workflow depends
 * on the wider set.
 *
 * Returns the authority so a caller can distinguish "no such case" from
 * "refused" without a second round trip. `found: false` is NOT permission:
 * every caller must decide what a missing case means for its own response.
 */
export async function assertActorCanAccessIntakeCase(
  actor: ActorIdentity,
  organizationId: string,
  intakeCaseId: string,
): Promise<IntakeCaseAuthority> {
  const authority = await resolveIntakeCaseAuthority(organizationId, intakeCaseId);

  if (!authority.found) {
    return authority;
  }

  if (authority.subjectAthleteIds.length > 0) {
    for (const athleteId of authority.subjectAthleteIds) {
      await assertActorCanAccessAthlete(actor, athleteId);
    }
    return authority;
  }

  if (isOrganizationAdminRole(actor.role)) {
    return authority;
  }

  if (authority.submittedByAccountId !== null && authority.submittedByAccountId === actor.accountId) {
    return authority;
  }

  throw new Error('Forbidden: actor has no relationship to this intake case');
}

export type IntakeDocumentSecurityDecision = 'clean' | 'quarantined';

/**
 * The human closure of the security-scan requirement. Uploads are born
 * pending_security_review, and no automated scanner exists (the requirement
 * dates to #17) -- so the state approval demands is produced the way this
 * platform produces every other trust transition: a named human looks at the
 * document and attests. 'clean' writes exactly the states
 * isIntakeDocumentReadyForReview requires; 'quarantined' writes states that
 * can never satisfy it, so one quarantined document keeps the whole case
 * unapprovable. The attestation itself (who, when, which decision, notes) is
 * merged into metadata so re-reviews overwrite the verdict but the row always
 * carries the latest reviewer on record.
 */
export async function reviewIntakeDocumentSecurity(params: {
  organizationId: string;
  intakeDocumentId: string;
  decision: IntakeDocumentSecurityDecision;
  reviewedByAccountId: string;
  reviewedByRole: PilotRole;
  notes?: string;
}): Promise<IntakeDocumentRecord | null> {
  const patch = params.decision === 'clean'
    ? {
        security_state: 'clean',
        quarantine_status: 'clean',
        extraction_state: 'ready_for_review',
      }
    : {
        security_state: 'quarantined',
        quarantine_status: 'quarantined',
        extraction_state: 'blocked',
      };

  return queryOne<IntakeDocumentRecord>(
    `update pilot.intake_documents
     set metadata = metadata || $3::jsonb,
         updated_at = now()
     where organization_id = $1 and intake_document_id = $2
     returning *`,
    [
      params.organizationId,
      params.intakeDocumentId,
      JSON.stringify({
        ...patch,
        security_review: {
          decision: params.decision,
          reviewed_by_account_id: params.reviewedByAccountId,
          reviewed_by_role: params.reviewedByRole,
          reviewed_at: new Date().toISOString(),
          notes: params.notes ?? null,
        },
      }),
    ],
  );
}

export async function updateIntakeCaseStatus(params: {
  organizationId: string;
  intakeCaseId: string;
  status: IntakeCaseStatus;
  reviewedByAccountId: string;
  reviewNotes?: string;
}, client?: PoolClient): Promise<void> {
  await writeRows(
    client,
    `update pilot.intake_cases
     set status = $3,
         reviewed_by_account_id = $4,
         review_notes = $5,
         promoted_at = case when $3 = 'promoted' then now() else promoted_at end,
         rejected_at = case when $3 = 'rejected' then now() else rejected_at end,
         updated_at = now()
     where organization_id = $1 and intake_case_id = $2`,
    [params.organizationId, params.intakeCaseId, params.status, params.reviewedByAccountId, params.reviewNotes ?? null],
  );

  await writeRows(
    client,
    `update pilot.intake_documents
     set review_status = $3,
         updated_at = now()
     where organization_id = $1 and intake_case_id = $2`,
    [params.organizationId, params.intakeCaseId, params.status],
  );
}

export async function bindIntakeDocumentsToOwner(params: {
  organizationId: string;
  intakeCaseId: string;
  ownerEntityType: string;
  ownerEntityId: string;
}, client?: PoolClient): Promise<void> {
  await writeRows(
    client,
    `update pilot.intake_documents
     set owner_entity_type = $3,
         owner_entity_id = $4,
         updated_at = now()
     where organization_id = $1 and intake_case_id = $2`,
    [params.organizationId, params.intakeCaseId, params.ownerEntityType, params.ownerEntityId],
  );

  const docs = await writeRows<{
    blob_path: string;
    classification: string;
    created_by_account_id: string;
  }>(
    client,
    `select
       d.blob_path,
       d.classification,
       coalesce(c.reviewed_by_account_id, c.submitted_by_account_id) as created_by_account_id
     from pilot.intake_documents d
     join pilot.intake_cases c
       on c.organization_id = d.organization_id
      and c.intake_case_id = d.intake_case_id
     where d.organization_id = $1 and d.intake_case_id = $2`,
    [params.organizationId, params.intakeCaseId],
  );

  for (const doc of docs) {
    await writeRows(
      client,
      `insert into pilot.documents
       (organization_id, document_id, owner_entity_type, owner_entity_id, storage_path, classification, created_by_account_id)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        params.organizationId,
        randomUUID(),
        params.ownerEntityType,
        params.ownerEntityId,
        doc.blob_path,
        doc.classification,
        doc.created_by_account_id,
      ],
    );
  }
}

/**
 * Runs one write on the caller's transaction when a client is passed, and
 * through the pooled query() when it is not.
 *
 * The pooled query() checks out a connection, runs one statement and commits
 * it on its own (db.ts). A writer that only ever used it could not take part
 * in a transaction at all, which is how intake/domain-upsert came to save a
 * coach's note, fail on the audit row after it, and answer 500 for a write
 * that had already happened. The client is optional and last so every caller
 * that passes none runs the same statement through the same query() as before.
 */
async function writeRows<T extends QueryResultRow>(
  client: PoolClient | undefined,
  text: string,
  values: unknown[],
): Promise<T[]> {
  if (!client) {
    return query<T>(text, values);
  }
  return (await client.query<T>(text, values)).rows;
}

/** writeRows's read twin: the first row, on the caller's transaction if given. */
async function readOne<T extends QueryResultRow>(
  client: PoolClient | undefined,
  text: string,
  values: unknown[],
): Promise<T | null> {
  return (await writeRows<T>(client, text, values))[0] ?? null;
}

export async function upsertEmergencyContact(params: {
  organizationId: string;
  athleteId: string;
  fullName: string;
  relationshipToAthlete: string;
  phone: string;
  email?: string;
  isPrimary?: boolean;
  notes?: string;
}, client?: PoolClient): Promise<string> {
  const contactId = randomUUID();

  await writeRows(
    client,
    `insert into pilot.emergency_contacts
     (organization_id, contact_id, athlete_id, full_name, relationship_to_athlete, phone, email, is_primary, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      params.organizationId,
      contactId,
      params.athleteId,
      params.fullName,
      params.relationshipToAthlete,
      params.phone,
      params.email ?? null,
      params.isPrimary ?? true,
      params.notes ?? '',
    ],
  );

  return contactId;
}

export async function upsertMedicalIntake(params: {
  organizationId: string;
  athleteId: string;
  conditions?: string;
  medications?: string;
  allergies?: string;
  physicianName?: string;
  physicianPhone?: string;
  clearanceStatus?: string;
  notes?: string;
}, client?: PoolClient): Promise<string> {
  const medicalId = randomUUID();

  await writeRows(
    client,
    `insert into pilot.medical_intake
     (organization_id, medical_id, athlete_id, conditions, medications, allergies, physician_name, physician_phone, clearance_status, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      params.organizationId,
      medicalId,
      params.athleteId,
      params.conditions ?? '',
      params.medications ?? '',
      params.allergies ?? '',
      params.physicianName ?? '',
      params.physicianPhone ?? '',
      params.clearanceStatus ?? 'pending',
      params.notes ?? '',
    ],
  );

  return medicalId;
}

/**
 * The columns and values every waiver insert uses, shared so the pooled and
 * the transactional writer cannot drift into inserting different shapes.
 */
const WAIVER_INSERT_SQL = `insert into pilot.waivers
     (organization_id, waiver_id, athlete_id, waiver_type, signed_by_name, signed_by_role, signed_at, consent_version, status, notes, parent_id, covers_video, public_use_allowed, recorded_by_account_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`;

function waiverInsertValues(waiverId: string, params: UpsertWaiverParams): unknown[] {
  return [
    params.organizationId,
    waiverId,
    params.athleteId,
    params.waiverType,
    params.signedByName,
    params.signedByRole,
    params.signedAt,
    params.consentVersion,
    params.status,
    params.notes ?? '',
    params.parentId ?? null,
    params.coversVideo ?? true,
    params.publicUseAllowed ?? false,
    params.recordedByAccountId,
  ];
}

export interface UpsertWaiverParams {
  organizationId: string;
  athleteId: string;
  waiverType: string;
  signedByName: string;
  signedByRole: string;
  signedAt: string;
  consentVersion: string;
  status: string;
  notes?: string;
  // T-008: only meaningfully set for waiverType='photo_media'. One write
  // path for every waiver_type -- see the guardian-media-consent migration's
  // header for why this extends pilot.waivers instead of a second table.
  parentId?: string | null;
  coversVideo?: boolean;
  publicUseAllowed?: boolean;
  /**
   * The signed-in account PUTTING THIS ROW ON FILE -- not the signer.
   *
   * REQUIRED, not optional, and that is the whole point. Optional would let a
   * caller keep writing waivers with no provenance, which is the state this
   * ends; every existing call site has a principal in scope, so there is
   * nothing to accommodate. The same argument
   * pilot_slice_postgres_observation_author_role_migration.sql makes for
   * author_role.
   *
   * Who SIGNED stays in signedByName. For intake-entered waivers the signer is
   * often a guardian with no account here at all -- data entry from paper --
   * so a column claiming to identify them would either block honest intake or
   * invite staff to attach the nearest account to somebody else's signature.
   * This says who is answerable for the record, which is knowable.
   */
  recordedByAccountId: string;
}

export async function upsertWaiver(params: UpsertWaiverParams, client?: PoolClient): Promise<string> {
  const waiverId = randomUUID();
  await writeRows(client, WAIVER_INSERT_SQL, waiverInsertValues(waiverId, params));
  return waiverId;
}

/**
 * The same insert, on a caller's transaction.
 *
 * Exists so the media-consent writers can take a lock and record the waiver
 * as ONE unit (guardianConsent.ts, owner decision D-2). Without it those
 * writers had no way to be inside a transaction at all: upsertWaiver goes
 * through the module-level pooled query, which commits on its own the moment
 * it returns, so a lock taken around it would have been released before the
 * row existed.
 *
 * Structurally typed rather than importing PoolClient, matching the
 * QueryExecutor shape guardianConsent.ts and publication.ts already use for
 * the same reason.
 */
export async function upsertWaiverWithClient(
  client: { query(text: string, values?: unknown[]): Promise<unknown> },
  params: UpsertWaiverParams,
): Promise<string> {
  const waiverId = randomUUID();
  await client.query(WAIVER_INSERT_SQL, waiverInsertValues(waiverId, params));
  return waiverId;
}

export async function createAssessment(params: {
  organizationId: string;
  athleteId: string;
  assessorAccountId: string;
  assessmentType: string;
  result: Record<string, unknown>;
}, client?: PoolClient): Promise<string> {
  const assessmentId = randomUUID();

  await writeRows(
    client,
    `insert into pilot.assessments
     (organization_id, assessment_id, athlete_id, assessor_account_id, assessment_type, result)
     values ($1,$2,$3,$4,$5,$6::jsonb)`,
    [params.organizationId, assessmentId, params.athleteId, params.assessorAccountId, params.assessmentType, JSON.stringify(params.result)],
  );

  return assessmentId;
}

export async function createAttendance(params: {
  organizationId: string;
  athleteId: string;
  attendanceDate: string;
  status: string;
  notes?: string;
}, client?: PoolClient): Promise<string> {
  const attendanceId = randomUUID();

  await writeRows(
    client,
    `insert into pilot.attendance
     (organization_id, attendance_id, athlete_id, attendance_date, status, notes)
     values ($1,$2,$3,$4,$5,$6)`,
    [params.organizationId, attendanceId, params.athleteId, params.attendanceDate, params.status, params.notes ?? ''],
  );

  return attendanceId;
}

// ReadinessMethod is defined ONCE, in readinessProvenance.ts, and re-exported
// here for callers already importing from this module. It was briefly declared
// in both files, which is the drift hazard this whole change exists to remove:
// two hand-kept copies of the method vocabulary would eventually disagree with
// each other and with the database CHECK constraint, and the copy that drifted
// would be the one describing a score nobody could audit.
//
// Imported as well as re-exported because `export type { X } from` publishes
// the name without binding it locally, and createReadiness below uses it.
export type { ReadinessMethod };

/**
 * Writes one readiness reading, and REQUIRES the caller to say what produced
 * it.
 *
 * `method` is not optional and has no default, here or in the column. Three
 * engine proposals (modules 021, 029, 033) independently refused to consume
 * this table because a score arrived with no way to audit where it came from;
 * a defaulted parameter here would reintroduce exactly that, one layer up from
 * the database. See docs/capabilities/READINESS_PROVENANCE_FACTS.md.
 *
 * The measurement-property arguments default toward "not established", the
 * same direction pilot.assessment_protocols defaults them. Nothing that writes
 * here today has a validated method, so nothing today passes them -- they are
 * parameters rather than constants only so that a future validated method can
 * state its own status without this function needing to know about it.
 */
export async function createReadiness(params: {
  organizationId: string;
  athleteId: string;
  score: number;
  category: string;
  measuredAt: string;
  method: ReadinessMethod;
  recordedByAccountId?: string | null;
  reliabilityStatus?: string;
  validityStatus?: string;
  evidenceClass?: string;
}, client?: PoolClient): Promise<string> {
  const readinessId = randomUUID();

  await writeRows(
    client,
    `insert into pilot.readiness
     (organization_id, readiness_id, athlete_id, score, category, measured_at,
      method, recorded_by_account_id, reliability_status, validity_status, evidence_class)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      params.organizationId,
      readinessId,
      params.athleteId,
      params.score,
      params.category,
      params.measuredAt,
      params.method,
      params.recordedByAccountId ?? null,
      params.reliabilityStatus ?? 'UNVALIDATED - PPBF MUST ESTABLISH',
      params.validityStatus ?? 'UNKNOWN',
      params.evidenceClass ?? 'INSUFFICIENT EVIDENCE',
    ],
  );

  return readinessId;
}

/**
 * authorRole records what the writer WAS at the moment of writing, and it is
 * required rather than optional.
 *
 * This table records who wrote a note (coach_account_id) and what kind it is
 * (note_type), and until this column existed it recorded nothing about the
 * author's role. The two readers that report one -- listParentMessages'
 * sender_role and listBarrierReports' reporter_role -- recover it by joining
 * pilot.accounts.role at READ time, and that column is mutable:
 * upsertOrganizationMembership runs `set role = $3` whenever an organization
 * admin changes a membership, and several activation paths set it to
 * 'athlete'. Authorship was therefore recomputed on every read from a value
 * that can change afterwards.
 *
 * Measured against real PostgreSQL before this column existed: a coach writes
 * a parent_message; listParentMessages reports sender_role 'coach'; the
 * account's role is changed to 'staff'; the same query, on the same untouched
 * row, reports 'staff'. Nothing rewrote the note. The claim about who wrote
 * it changed underneath it.
 *
 * It matters most in the direction this platform cares about. A guardian's
 * barrier report is a parent's account of their own household; if that
 * guardian is later given a coach role, the same row starts reading as a
 * coach's professional observation of a family, which is a different kind of
 * statement carrying different weight.
 *
 * REQUIRED, not optional: an optional parameter lets a caller omit it and go
 * on writing rows with no provenance, which is the state this ends. Every
 * call site has a principal in scope, so no caller legitimately cannot
 * answer.
 *
 * Readers still report the joined account role for now. Switching them to
 * prefer this column is deliberately a separate change -- with no rows yet
 * carrying a recorded role, flipping the readers today would turn every
 * existing message and barrier report into "unknown" at once.
 */
export async function createCoachObservation(params: {
  organizationId: string;
  athleteId: string;
  coachAccountId: string;
  authorRole: PilotRole;
  noteType: string;
  noteText: string;
}, client?: PoolClient): Promise<string> {
  const noteId = randomUUID();

  await writeRows(
    client,
    `insert into pilot.coach_observations
     (organization_id, note_id, athlete_id, coach_account_id, author_role, note_type, note_text)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      params.organizationId,
      noteId,
      params.athleteId,
      params.coachAccountId,
      params.authorRole,
      params.noteType,
      params.noteText,
    ],
  );

  return noteId;
}

export interface ParentMessageRow {
  note_id: string;
  athlete_id: string;
  sender_role: string;
  note_text: string;
  created_at: string;
}

/**
 * Capability #90: one-directional coach/admin -> parent messaging, scoped
 * down from the full two-way channel deliberately -- reply, moderation, and
 * a "message any coach" surface are real product decisions the owner should
 * make, not guessed at. `pilot.coach_observations.note_type` is already
 * unconstrained text and already reused this way (#125, #95/#96); a coach
 * or admin sends via the existing `POST /api/pilot/intake/domain-upsert`
 * (`entity_type: 'coach_note'`, `note_type: 'parent_message'`) -- no new
 * write route. This is the read side, filtered to ONLY that one note_type
 * so a guardian's message feed can never surface a behavior note or a
 * barrier report filed under the same table.
 *
 * `sender_role` (via a join to pilot.accounts, never a resolved display
 * name -- accounts has no name column for staff) matches ParentHub's own
 * prior placeholder copy, "From Coach" -- a family reads who sent it by
 * role, the same way the mock data this replaces always displayed it.
 */
export async function listParentMessages(organizationId: string, athleteIds: string[]): Promise<ParentMessageRow[]> {
  if (athleteIds.length === 0) return [];

  const rows = await query<ParentMessageRow>(
    `select co.note_id, co.athlete_id, a.role as sender_role, co.note_text, co.created_at::text
     from pilot.coach_observations co
     join pilot.accounts a on a.account_id = co.coach_account_id
     where co.organization_id = $1
       and co.athlete_id = any($2::text[])
       and co.note_type = 'parent_message'
     order by co.created_at desc`,
    [organizationId, athleteIds],
  );

  return rows;
}

// The two note_types the parent barrier-report route writes. A closed set,
// for the same reason listParentMessages filters to exactly one: a coach's
// barrier inbox must never surface a behavior note or a parent message
// filed under the same table.
export const BARRIER_NOTE_TYPES = ['home_barrier', 'transportation_barrier'] as const;

export interface BarrierReportRow {
  note_id: string;
  athlete_id: string;
  athlete_name: string;
  // The author's role from pilot.accounts, never assumed: the write path
  // stores the REPORTING GUARDIAN's account id in coach_account_id (the
  // column predates guardian-authored rows), so labeling by the stored
  // role is what keeps a guardian's report from reading as a coach's note.
  reporter_role: string;
  note_type: string;
  note_text: string;
  created_at: string;
}

// Which athletes have a barrier report on file at all -- the candidate list
// the coach route filters through assertActorCanAccessAthlete before any
// report content is read.
export async function listAthletesWithBarrierReports(organizationId: string): Promise<string[]> {
  const rows = await query<{ athlete_id: string }>(
    `select distinct athlete_id
     from pilot.coach_observations
     where organization_id = $1
       and note_type = any($2::text[])`,
    [organizationId, [...BARRIER_NOTE_TYPES]],
  );
  return rows.map((row) => row.athlete_id);
}

/**
 * The read side of the parent barrier report -- the surface that makes
 * ParentHub's "Sent to your child's coach" true. Guardians file these
 * through POST /api/pilot/parent/barrier-report; until this reader existed
 * the rows were write-only. Newest first, capped by the caller; one row
 * more than `limit` is fetched so the caller can say "more exist" instead
 * of silently truncating.
 */
export async function listBarrierReports(
  organizationId: string,
  athleteIds: string[],
  limit: number,
): Promise<{ reports: BarrierReportRow[]; truncated: boolean }> {
  if (athleteIds.length === 0) return { reports: [], truncated: false };

  const rows = await query<BarrierReportRow>(
    `select co.note_id, co.athlete_id, ath.full_name as athlete_name,
            acc.role as reporter_role, co.note_type, co.note_text, co.created_at::text
     from pilot.coach_observations co
     join pilot.accounts acc on acc.account_id = co.coach_account_id
     join pilot.athletes ath
       on ath.organization_id = co.organization_id and ath.athlete_id = co.athlete_id
     where co.organization_id = $1
       and co.athlete_id = any($2::text[])
       and co.note_type = any($3::text[])
     order by co.created_at desc
     limit $4`,
    [organizationId, athleteIds, [...BARRIER_NOTE_TYPES], limit + 1],
  );

  return {
    reports: rows.slice(0, limit),
    truncated: rows.length > limit,
  };
}

/**
 * Which `pilot.coach_observations.note_type` values a given READER may
 * receive. `null` means unrestricted.
 *
 * That table is a shared bus, not a coach's notebook. Five distinct writers
 * put rows on it under `note_type`, an unconstrained text column:
 *
 *   'intake_observation'  intake/review-action promotion default (staff)
 *   'coach_observation'   intake/domain-upsert default            (staff)
 *   'behavior_standard'   coach/decision-loop                     (staff)
 *   'parent_message'      coach/admin -> guardian                 (staff)
 *   'home_barrier' /      parent/barrier-report -- authored by a GUARDIAN,
 *   'transportation_barrier'   addressed to the coach
 *
 * The repository already answered this question once, for exactly one
 * reader: `listParentMessages` filters to `note_type = 'parent_message'`
 * "so a guardian's message feed can never surface a behavior note or a
 * barrier report filed under the same table". The rule generalizes -- a
 * reader must not receive note types that were never meant for them -- and
 * the readers that had no such filter were reading the whole bus.
 *
 * Per role, and why:
 *
 * - organization_admin / admin / coach: unrestricted. Every note type above
 *   is either staff-authored or explicitly addressed to staff (the barrier
 *   report exists to reach the coach -- `listBarrierReports` IS that inbox),
 *   so there is nothing on this bus written for someone else. No change.
 * - athlete: `coach_observation` ONLY -- the one type whose author, subject
 *   and intended reader all sit inside the coaching relationship.
 *   `parent_message` is addressed to the guardian, not the child, and a
 *   barrier report is a guardian describing home circumstances -- no
 *   transport, an unsafe walk, a barrier at home -- to a coach in
 *   confidence. Handing that to the child it is about is a safeguarding
 *   harm, not a privacy nicety.
 *
 *   `behavior_standard` and `intake_observation` are excluded, and an
 *   earlier draft of this list included both. `behavior_standard` is a
 *   SINGLE GENERIC LABEL by deliberate design -- coach/decision-loop's own
 *   comment says picking category names "is a coaching-philosophy decision
 *   for the gym's own staff, not something to invent here" -- so every
 *   conduct note a coach types shares one value and there is no way to show
 *   a child the encouraging ones without the disciplinary ones, unmediated.
 *   `intake_observation` is free text promoted out of a packet that also
 *   carries medical, waiver and emergency-contact blocks; nothing
 *   constrains it to training content.
 *
 *   This matches passbook.ts's PASSBOOK_ATHLETE_NOTE_TYPES exactly. The two
 *   readers were built in parallel and disagreed on these two values; the
 *   narrower list wins, because a shared bus with two different answers to
 *   "what may this child read about themselves" is the drift this whole
 *   comment exists to prevent.
 * - parent: `parent_message` only, byte-for-byte the set `listParentMessages`
 *   already decided for the guardian-facing read. It also closes a case that
 *   set never had to consider: two guardians linked to one athlete, where an
 *   unfiltered read hands one household the other household's report.
 *
 * The lists are closed, so a note_type nobody has enumerated here reaches
 * staff and nobody else. That is deliberate: a new writer choosing a new
 * value must decide who it is for, rather than inheriting an audience by
 * default. Any other role falls through to the empty set for the same reason.
 */
export const ATHLETE_READABLE_NOTE_TYPES = ['coach_observation'] as const;

export const PARENT_READABLE_NOTE_TYPES = ['parent_message'] as const;

export function coachObservationNoteTypesForReader(role: PilotRole): string[] | null {
  if (isOrganizationAdminRole(role) || role === 'coach') {
    return null;
  }

  if (role === 'athlete') {
    return [...ATHLETE_READABLE_NOTE_TYPES];
  }

  if (role === 'parent') {
    return [...PARENT_READABLE_NOTE_TYPES];
  }

  return [];
}

/**
 * WHICH COLUMNS OF A GUARDIAN'S RECORD A READER MAY SEE.
 *
 * The reader-scoped sibling of coachObservationNoteTypesForReader above, and
 * it exists for the same reason: both intake reads that join pilot.parents
 * (getIntakeCaseAggregate, and the domain-get route) selected `p.*`, and both
 * are reachable by 'athlete' and 'parent' -- assertActorCanAccessAthlete
 * admits the athlete themself and every linked guardian, and
 * assertActorCanAccessIntakeCase gates on that same function.
 *
 * pilot.parents carries phone, email and account_id. An athlete with two
 * guardians therefore read both guardians' contact details, and each guardian
 * read the other's -- which in a split household, or one with a protective
 * order, is precisely the disclosure the platform must not make. The note_type
 * filter above already stopped one household reading the other's barrier
 * report; this stops the same crossing through the column list rather than
 * through the row filter.
 *
 * The identity set is byte-for-byte the one passbook.ts already hands these
 * two readers, so the two guardian-facing reads cannot give different answers
 * to "what may this child see about their parents". Contact details stay with
 * the coach of record and the organization admins, who need them to make the
 * emergency call -- that is the whole reason the columns exist. (The literal
 * 'staff' role is NOT one of them: it cannot reach either call site, because
 * both routes admit organization_admin, coach, athlete and parent only. It
 * falls through to identity for the same reason every unenumerated role
 * does.) The platform is stricter still one step further out:
 * duplicateGuardians.ts masks a guardian email even for an organization admin.
 *
 * Column lists, not `*`: a table that grows a column must not widen a response
 * by default. Any role outside the four falls through to identity only, the
 * closed side, for the same reason the note-type sets do.
 */
export const GUARDIAN_IDENTITY_COLUMNS = ['p.parent_id', 'p.full_name'] as const;

export const GUARDIAN_CONTACT_COLUMNS = ['p.account_id', 'p.phone', 'p.email'] as const;

export function guardianColumnsForReader(role: PilotRole): string[] {
  if (isOrganizationAdminRole(role) || role === 'coach') {
    return [...GUARDIAN_IDENTITY_COLUMNS, ...GUARDIAN_CONTACT_COLUMNS];
  }

  return [...GUARDIAN_IDENTITY_COLUMNS];
}

/**
 * WHICH COLUMNS OF AN EMERGENCY CONTACT A READER MAY SEE.
 *
 * NARROWING THE GUARDIAN LIST ALONE DID NOT CLOSE THE DISCLOSURE. It moved it
 * one table sideways, and arguably sharpened it.
 *
 * Both reads that were fixed above return `pilot.emergency_contacts` in the
 * SAME response body, and both read it with `select *`. That table carries
 * `full_name`, `relationship_to_athlete`, a NOT NULL `phone`, an `email` and
 * free-text `notes`, under the same gate -- so an athlete and every linked
 * guardian received all of it, unscoped.
 *
 * The other parent IS the ordinary emergency contact: one intake promotion
 * request carries a `guardian` block and an `emergency_contact` block side by
 * side (IntakePromotionPayload), and review-action writes both from it. So
 * Guardian A read Guardian B's name out of the narrowed `guardians` list and
 * Guardian B's phone and email out of `emergency_contacts` in the same
 * payload, joined on the name -- the disclosure the guardian narrowing exists
 * to prevent, reassembled from two fields of one response. The child read it
 * too.
 *
 * `notes` is staff-only for a reason worth stating plainly: it is where "do
 * not call the father" is written. Handing that to the household it names is
 * worse than handing over a phone number.
 *
 * A guardian who needs to correct their own emergency contact does it the way
 * they correct their own guardian record -- through staff, on a write path --
 * rather than by this read handing every household the whole table. No
 * first-party surface reads these columns as a guardian or an athlete: the two
 * consumers of these responses (app/admin/athletes and app/admin/consent) are
 * organization-admin pages, and both keep every field they render.
 */
export const EMERGENCY_CONTACT_IDENTITY_COLUMNS = [
  'contact_id',
  'athlete_id',
  'full_name',
  'relationship_to_athlete',
  'is_primary',
] as const;

export const EMERGENCY_CONTACT_CONTACT_COLUMNS = ['phone', 'email', 'notes'] as const;

export function emergencyContactColumnsForReader(role: PilotRole): string[] {
  if (isOrganizationAdminRole(role) || role === 'coach') {
    return [...EMERGENCY_CONTACT_IDENTITY_COLUMNS, ...EMERGENCY_CONTACT_CONTACT_COLUMNS];
  }

  return [...EMERGENCY_CONTACT_IDENTITY_COLUMNS];
}

/**
 * WHICH COLUMNS OF A WAIVER A READER MAY SEE.
 *
 * THE NARROWING ABOVE STOPPED AT TWO TABLES OF A BODY THAT RETURNS SEVEN.
 *
 * `pilot.waivers` has the same shape as the emergency-contact case and was
 * left with `select *`. It carries `signed_by_name` -- byte-identical to the
 * pilot.parents row -- and, since the guardian-media-consent migration, a
 * `parent_id` that names the guardian outright. Beside them sits a free-text
 * `notes`.
 *
 * So a note written on the other parent's waiver reached this household
 * already keyed to the guardian it concerns, with no join required. The
 * reasoning recorded for the emergency-contact note applies word for word:
 * it is where "do not call the father" is written, and handing that to the
 * household it names is worse than handing over a phone number. A waiver is
 * if anything the likelier place for it, because a waiver is where a custody
 * or safeguarding qualification on who may consent gets recorded.
 *
 * What the guardian and the athlete keep is everything a waiver IS: its type,
 * status, version, when it was signed and by whom, and the media-consent flags
 * a parent checks their child's permissions against. Only the staff note goes.
 *
 * AN ALLOWLIST, NOT A DENYLIST, and deliberately so. A column added to
 * pilot.waivers by a later migration does not reach a guardian until somebody
 * adds it here. That fails closed: the cost is a missing field somebody
 * notices, rather than a disclosure nobody does. waiverColumnsForReader is
 * pinned against the live table by guardianContactProjection.pg.test.ts, so a
 * new column fails that test rather than vanishing quietly.
 */
export const WAIVER_IDENTITY_COLUMNS = [
  'organization_id',
  'waiver_id',
  'athlete_id',
  'waiver_type',
  'signed_by_name',
  'signed_by_role',
  'signed_at',
  'consent_version',
  'status',
  'parent_id',
  'covers_video',
  'public_use_allowed',
  'created_at',
  'updated_at',
] as const;

/* `recorded_by_account_id` sits here, with the staff note, and not in the
   identity list. It is a STAFF ACCOUNT IDENTIFIER -- on this platform an
   account_id resolves to a login email -- so handing it to a guardian would
   disclose which staff member typed their paperwork, and their address with
   it. The guardian already gets everything the waiver IS, signed_by_name
   included; who keyed it in is the gym's record, not theirs.

   The same call, for the identically-named column, is already made a few
   hundred lines down: READINESS_STAFF_COLUMNS is exactly
   ['recorded_by_account_id'], for exactly this reason. */
export const WAIVER_STAFF_COLUMNS = ['notes', 'recorded_by_account_id'] as const;

export function waiverColumnsForReader(role: PilotRole): string[] {
  if (isOrganizationAdminRole(role) || role === 'coach') {
    return [...WAIVER_IDENTITY_COLUMNS, ...WAIVER_STAFF_COLUMNS];
  }

  return [...WAIVER_IDENTITY_COLUMNS];
}

/**
 * WHICH COLUMNS OF A MEDICAL INTAKE A READER MAY SEE.
 *
 * THE NARROWING HAD REACHED THREE TABLES OF A BODY THAT RETURNS SEVEN.
 *
 * The argument is already written twice in this file. For the emergency
 * contact: "`notes` is staff-only for a reason worth stating plainly: it is
 * where 'do not call the father' is written. Handing that to the household it
 * names is worse than handing over a phone number." For the waiver, that same
 * reasoning was extended "word for word".
 *
 * pilot.medical_intake carries an identically-shaped free-text `notes`, in the
 * same response body, under the same gate -- and it did not get it. A staff
 * note qualifying a child's medical situation is the same kind of writing as a
 * staff note qualifying who may collect them.
 *
 * AND THE READER HERE MAY BE THE CHILD. This route and getIntakeCaseAggregate
 * both admit role 'athlete', and access.ts resolves that to a strict self-read
 * -- so the minor the note is about is one of the people it reached. That is a
 * different disclosure from a guardian reading it, and nothing in the previous
 * query distinguished them.
 *
 * WHAT IS DELIBERATELY NOT NARROWED, so the absence is a decision and not an
 * oversight: conditions, medications, allergies, physician_name and
 * physician_phone stay. Those are the child's own medical facts and their
 * clinician's contact -- what a guardian needs in order to act, and what a
 * minor already knows about themselves. Withholding them would be a medical
 * and product judgement this change has no basis to make. Only the staff
 * narrative moves.
 */
export const MEDICAL_INTAKE_IDENTITY_COLUMNS = [
  'organization_id',
  'medical_id',
  'athlete_id',
  'conditions',
  'medications',
  'allergies',
  'physician_name',
  'physician_phone',
  'clearance_status',
  'created_at',
  'updated_at',
] as const;

export const MEDICAL_INTAKE_STAFF_COLUMNS = ['notes'] as const;

export function medicalIntakeColumnsForReader(role: PilotRole): string[] {
  if (isOrganizationAdminRole(role) || role === 'coach') {
    return [...MEDICAL_INTAKE_IDENTITY_COLUMNS, ...MEDICAL_INTAKE_STAFF_COLUMNS];
  }

  return [...MEDICAL_INTAKE_IDENTITY_COLUMNS];
}

/**
 * WHICH COLUMNS OF AN ATTENDANCE ROW A READER MAY SEE.
 *
 * The fourth table in the same body with a staff free-text `notes`, and the
 * last one still on `select *`. privacyTiers.ts already places the equivalent
 * column on the OTHER attendance table at tier `organization`, with the note
 * "Free text a coach typed about a child" -- pilot.scheduler_attendance.note.
 * pilot.attendance.notes is the same writing on a different table and carried
 * no entry at all.
 *
 * Everything a guardian or an athlete needs from an attendance row -- the
 * date, and whether they were there -- is in the identity set.
 */
export const ATTENDANCE_IDENTITY_COLUMNS = [
  'organization_id',
  'attendance_id',
  'athlete_id',
  'attendance_date',
  'status',
  'created_at',
  'updated_at',
] as const;

export const ATTENDANCE_STAFF_COLUMNS = ['notes'] as const;

export function attendanceColumnsForReader(role: PilotRole): string[] {
  if (isOrganizationAdminRole(role) || role === 'coach') {
    return [...ATTENDANCE_IDENTITY_COLUMNS, ...ATTENDANCE_STAFF_COLUMNS];
  }

  return [...ATTENDANCE_IDENTITY_COLUMNS];
}

/**
 * WHICH COLUMNS OF AN ASSESSMENT ROW A READER MAY SEE.
 *
 * The fifth table in this body to be narrowed, and the one where the widening
 * happened AFTER the reads were written. pilot.assessments shipped with seven
 * columns; the assessment-protocols migration added eleven more, including a
 * free-text staff note and a second rater's independent score. Both reads of
 * this table were `select *`, so those eleven reached a guardian and the
 * athlete themself on the day the migration applied, with nothing in either
 * read changed or reviewed. That is the failure mode the waiver projection's
 * header names in as many words: AN ALLOWLIST, NOT A DENYLIST, so a later
 * migration's column does not reach a family by default. This is that
 * allowlist arriving one migration late.
 *
 * WHAT MOVES TO STAFF, and the stated harm for each -- nothing is moved for
 * being merely untidy:
 *
 *   conditions_note      Free text a staff member typed about the conditions
 *                        an assessment ran under. Identical in kind to
 *                        pilot.waivers.notes, pilot.medical_intake.notes and
 *                        pilot.attendance.notes, all three already staff-only
 *                        for exactly this reason.
 *   assessor_account_id  A staff account identifier. The guardian projection
 *                        above drops pilot.parents.account_id from the family
 *                        set on the same ground: an account id is a handle on
 *                        a person, not a fact about the child.
 *   second_rater_account_id
 *                        The same, for the second rater.
 *   second_rater_result  The second rater's independent score. Its migration
 *                        header states why the column exists: so "the
 *                        reliability study collects itself from live use" --
 *                        raw material for weighted kappa and ICC. It is
 *                        unreconciled internal review state, and paired with
 *                        the id above it is a record of which staff member
 *                        disagreed with which about a child. It was never a
 *                        result issued to anyone.
 *
 * WHAT DELIBERATELY STAYS, so the absence is a decision and not an oversight:
 * result, assessment_type, and the whole protocol block -- protocol_id,
 * protocol_version, administration_kind, due_on, administered_on,
 * retest_of_assessment_id, training_hours_at_administration -- plus
 * assessor_role. Those are the child's own assessment and the bookkeeping
 * around it. assessor_role says a coach assessed them, which names no person.
 * Withholding any of it would be a product judgement this change has no basis
 * to make.
 */
export const ASSESSMENT_IDENTITY_COLUMNS = [
  'organization_id',
  'assessment_id',
  'athlete_id',
  'assessment_type',
  'result',
  'created_at',
  'updated_at',
  'protocol_id',
  'protocol_version',
  'administration_kind',
  'due_on',
  'administered_on',
  'retest_of_assessment_id',
  'training_hours_at_administration',
  'assessor_role',
] as const;

export const ASSESSMENT_STAFF_COLUMNS = [
  'assessor_account_id',
  'second_rater_account_id',
  'second_rater_result',
  'conditions_note',
] as const;

export function assessmentColumnsForReader(role: PilotRole): string[] {
  if (isOrganizationAdminRole(role) || role === 'coach') {
    return [...ASSESSMENT_IDENTITY_COLUMNS, ...ASSESSMENT_STAFF_COLUMNS];
  }

  return [...ASSESSMENT_IDENTITY_COLUMNS];
}

/**
 * WHICH COLUMNS OF A READINESS ROW A READER MAY SEE.
 *
 * The same shape as the assessments case above: five columns to begin with,
 * five more added by the readiness-provenance migration, and both reads still
 * `select *`.
 *
 * ONLY ONE COLUMN MOVES, and it is the one with a stated harm:
 * recorded_by_account_id, a staff account identifier, on the same ground as
 * assessor_account_id and pilot.parents.account_id.
 *
 * THE OTHER FOUR STAY, AND THAT IS AN OPEN QUESTION RATHER THAN A SETTLED
 * ONE. method, reliability_status, validity_status and evidence_class are
 * PPBF's own honest labels about its instrument -- the stored values are
 * literally 'UNVALIDATED - PPBF MUST ESTABLISH' and 'INSUFFICIENT EVIDENCE'.
 * Whether a family should read those raw, uninterpreted, is a product and
 * communications judgement, and there is no privacy argument for hiding them:
 * they describe the measurement, not a person. So they are left where they
 * are and the question is recorded rather than answered here. OWNER DECISION
 * REQUIRED to move them.
 *
 * Note that a narrower family-facing readiness projection already exists on a
 * different surface: passbook.ts returns readiness_id, score, category and
 * measured_at and nothing else. That is a summary screen's own shape, not a
 * ruling about this allowlist, and it is not treated as one.
 */
export const READINESS_IDENTITY_COLUMNS = [
  'organization_id',
  'readiness_id',
  'athlete_id',
  'score',
  'category',
  'measured_at',
  'created_at',
  'method',
  'reliability_status',
  'validity_status',
  'evidence_class',
] as const;

export const READINESS_STAFF_COLUMNS = ['recorded_by_account_id'] as const;

export function readinessColumnsForReader(role: PilotRole): string[] {
  if (isOrganizationAdminRole(role) || role === 'coach') {
    return [...READINESS_IDENTITY_COLUMNS, ...READINESS_STAFF_COLUMNS];
  }

  return [...READINESS_IDENTITY_COLUMNS];
}

/**
 * Refuses, before anything is written, an athlete account_id that intake
 * promotion's call to createOrUpdateAthleteAccount must not touch.
 *
 * Promotion writes the athlete record first and has no transaction around its
 * writes. createOrUpdateAthleteAccount's own cross-organization refusal was
 * therefore a 409 ("Account already exists in another organization") that
 * landed only after upsertAthlete had written the athlete record. Here it is
 * refused first, as a 403, with the message provisioning uses elsewhere.
 *
 * createOrUpdateAthleteAccount's update branch sets role athlete, sets
 * athlete_id to the promoted athlete, clears the PIN, deactivates the login
 * and revokes every session, on whatever same-organization account it is
 * pointed at. So:
 *  - an account_id that named a coach's, a parent's or an admin's login turned
 *    it into a locked athlete login. Intake does not change an existing
 *    account's role, the same rule as the guardian login (R5, Jason
 *    2026-09-29);
 *  - an account_id that named ANOTHER child's athlete login re-bound it to the
 *    promoted child's record: the first child was locked out, and the next
 *    activation code issued for that login showed the promoted child's records
 *    to whoever redeemed it -- the first child's family. Refused too.
 * Re-promoting the same athlete, or naming an athlete login bound to no
 * athlete record, stays allowed: re-provisioning is what re-running promotion
 * is for. createOrUpdateAthleteAccount holds the same two rules in its own
 * write, so this check only moves the refusal ahead of the first write.
 *
 * Also refused, each held in that write too:
 *  - a login marked deleted. The update left deleted_at set, so the athlete
 *    redeemed an activation code and still could not sign in. A re-enrolled
 *    athlete gets a new login and the deleted one stays deleted (Jason
 *    2026-09-30, OD-2026-09-30-004 e1, A);
 *  - a login other than the one this athlete record already has. unique
 *    (organization_id, athlete_id) on pilot.accounts refused it inside the
 *    write, after upsertAthlete had written the athlete record, and the admin
 *    saw "Internal server error" (OD-2026-09-29-002 item 4);
 *  - any login at all for an athlete record a deleted login still holds. The
 *    deleted login keeps its athlete_id, so the same constraint refuses every
 *    new one, and intake does not restore the deleted one. The message says
 *    so rather than sending the admin from "use a new account_id" into this.
 *
 * Lives here, not in auth.ts: it is an intake provisioning check, and auth.ts
 * is the sign-in surface credentialPolicyDrift.test.ts guards.
 */
/**
 * Refuses, before any write, an athlete record that a DELETED login still
 * holds -- whether or not the promotion names an account_id.
 *
 * This used to live only inside assertAthleteAccountIdProvisionable, which
 * review-action ran only when promotion.athlete.account_id was present. A
 * promotion that named no login therefore skipped it, and upsertAthlete wrote
 * a live athlete record whose only login was deleted: the record shown as
 * active, the athlete unable to sign in, and nothing saying why (the Build
 * List row "Intake can leave a live athlete whose login is marked deleted",
 * OD-2026-09-29-002 item 4). review-action now runs this check on every
 * promotion, and the account_id check above still runs it as its own first
 * step on the record.
 *
 * Returns the live login the record holds, or null, so the account_id check
 * can tell a second login from the same one without a second read.
 *
 * The deleted login's id is not named -- it may belong to a record purged
 * long ago, which no screen shows any more.
 */
export async function assertAthleteRecordNotHeldByDeletedLogin(params: {
  athleteId: string;
  organizationId: string;
}, client?: PoolClient): Promise<{ account_id: string } | null> {
  // The login this athlete record holds, if any: at most one, by the
  // constraint.
  const heldBy = await readOne<{ account_id: string; account_deleted: boolean }>(
    client,
    `select account_id, ${accountDeletedSql('a')} as account_deleted
     from pilot.accounts a
     where organization_id = $1 and athlete_id = $2
     limit 1`,
    [params.organizationId, params.athleteId],
  );

  if (heldBy && isDeletedAccount(heldBy)) {
    throw new ConflictError(
      `Conflict: athlete record "${params.athleteId}" is still held by a login that was deleted. Intake does not `
      + 'restore a deleted login, and an athlete record takes one login, so intake cannot give this record a new '
      + 'one. If this is a returning athlete whose old record was removed, promote under a new athlete_id with a '
      + "new account_id; otherwise the old login's hold on this record needs a database fix.",
      'ATHLETE_RECORD_HELD_BY_DELETED_LOGIN',
    );
  }

  return heldBy ? { account_id: heldBy.account_id } : null;
}

export async function assertAthleteAccountIdProvisionable(params: {
  accountId: string;
  athleteId: string;
  organizationId: string;
}, client?: PoolClient): Promise<void> {
  const existing = await readOne<{
    organization_id: string;
    role: PilotRole;
    athlete_id: string | null;
    account_deleted: boolean;
  }>(
    client,
    `select organization_id, role, athlete_id, ${accountDeletedSql('a')} as account_deleted
     from pilot.accounts a where account_id = $1`,
    [params.accountId],
  );

  if (existing) {
    if (existing.organization_id !== params.organizationId) {
      throw new Error('Forbidden: account already exists in another organization');
    }

    if (existing.role !== 'athlete') {
      throw new ConflictError(
        `Conflict: account_id "${params.accountId}" already belongs to an existing ${existing.role} account `
        + "in this organization. Intake does not change an existing account's role, so it cannot make that "
        + 'account an athlete login. Use a different account_id.',
        'EXISTING_ACCOUNT_ROLE_CONFLICT',
      );
    }

    // A deleted login this athlete record holds is refused below, with the
    // record: a new account_id would be refused too.
    if (isDeletedAccount(existing) && existing.athlete_id !== params.athleteId) {
      throw new ConflictError(
        `Conflict: account_id "${params.accountId}" belongs to a login that was deleted. Intake does not restore `
        + 'a deleted login; a re-enrolled athlete gets a new one. Use a new account_id.',
        'DELETED_ATHLETE_LOGIN',
      );
    }

    if (existing.athlete_id && existing.athlete_id !== params.athleteId) {
      throw new ConflictError(
        `Conflict: account_id "${params.accountId}" is already the login of a different athlete record in this `
        + "organization. Intake does not move an athlete's login to another athlete record. Use a different account_id.",
        'EXISTING_ATHLETE_ACCOUNT_CONFLICT',
      );
    }
  }

  const heldBy = await assertAthleteRecordNotHeldByDeletedLogin({
    athleteId: params.athleteId,
    organizationId: params.organizationId,
  }, client);

  if (heldBy && heldBy.account_id !== params.accountId) {
    throw new ConflictError(
      `Conflict: athlete record "${params.athleteId}" already has a login, account_id "${heldBy.account_id}". `
      + 'An athlete record has one login. Leave account_id out to keep that login as it is.',
      'ATHLETE_ALREADY_HAS_LOGIN',
    );
  }
}

/**
 * Takes the athlete-login lock for (organizationId, athleteId) on the
 * caller's transaction, held until it commits or rolls back.
 *
 * The account cleanup (scripts/pilot-cleanup-accounts.mjs) takes the same key,
 * ATHLETE_LOGIN_LOCK_SQL in scripts/lib/account-cleanup-plan.mjs, for every
 * login it is about to retire. Intake's checks and its athlete write run
 * under it, so the two cannot interleave: if the cleanup goes first, intake's
 * checks run after its commit and see the deleted login; if intake goes
 * first, the cleanup's retire runs after intake's commit and its `not exists`
 * guard sees the live athlete record. Plain reads could not do this -- each
 * side could check before the other wrote (OD-2026-09-29-002 item 4, path
 * ii). intakeDeletedLoginRace.pg.test.ts proves both orders, and fails if
 * either key text changes alone.
 */
export async function lockAthleteLoginForIntake(
  client: PoolClient,
  organizationId: string,
  athleteId: string,
): Promise<void> {
  await client.query(
    `select pg_advisory_xact_lock(hashtext('ppbf.athlete-login:' || $1::text || ':' || $2::text))`,
    [organizationId, athleteId],
  );
}

/**
 * Locks the intake case row on the caller's transaction (`for update`, held
 * until it ends) and refuses (409) unless the case is still approved. The
 * route reads the status before its transaction opens; this is the same rule
 * held under the lock, so a second promotion of the same case that started
 * before the first committed is refused instead of writing a second athlete.
 */
export async function assertIntakeCaseStillApproved(
  client: PoolClient,
  organizationId: string,
  intakeCaseId: string,
): Promise<void> {
  const row = await client.query<{ status: string }>(
    `select status from pilot.intake_cases
      where organization_id = $1 and intake_case_id = $2
      for update`,
    [organizationId, intakeCaseId],
  );
  const status = row.rows[0]?.status;
  if (status !== 'approved') {
    throw new ConflictError(
      `Conflict: intake case "${intakeCaseId}" is no longer approved (now ${status ?? 'missing'}). `
      + 'It was promoted, or changed, while this promotion was waiting. Reload the case before acting on it.',
      'INTAKE_CASE_NOT_APPROVED',
    );
  }
}

/**
 * Promotion's athlete record: the checks that refuse it, and the write, in one
 * transaction under the athlete-login lock.
 *
 * Refused: a withdrawn record, a record a deleted login holds (with or without
 * an account_id), and, when account_id is given, every refusal of
 * assertAthleteAccountIdProvisionable. The lock is what keeps the account
 * cleanup from retiring this athlete's login between those checks and the
 * write (lockAthleteLoginForIntake). One pooled connection carries all of it.
 *
 * Given `callerClient`, all of it runs on the caller's transaction, and the lock is
 * held until that transaction ends. review-action passes one: the athlete's
 * login, the guardian's login and record, and the rest of the promotion are
 * written on the same transaction, so they commit or roll back with the
 * record, and the cleanup cannot retire the named login between the record
 * and the link (OD-2026-10-03-002 section 5). This must be the first thing
 * the caller's transaction does, so the lock comes before any row lock.
 * Without it, it is a transaction of its own, as before.
 *
 * Given `intakeCaseId`, the case row is locked right after the athlete-login
 * lock and the promotion is refused unless the case is still approved. Two
 * promotions of one case each passed the route's earlier status read, and
 * with different athlete_ids they take different athlete-login locks, so both
 * used to write. The row lock makes the second wait for the first to commit;
 * it then sees the case promoted and is refused (assertIntakeCaseStillApproved).
 */
export async function writePromotedAthleteRecord(params: {
  organizationId: string;
  athlete: PilotAthlete;
  accountId?: string;
  intakeCaseId?: string;
}, callerClient?: PoolClient): Promise<void> {
  const { organizationId, athlete } = params;
  const athleteId = athlete.athlete_id;
  const write = async (client: PoolClient): Promise<void> => {
    await lockAthleteLoginForIntake(client, organizationId, athleteId);

    if (params.intakeCaseId) {
      await assertIntakeCaseStillApproved(client, organizationId, params.intakeCaseId);
    }

    // A withdrawn athlete record: upsertAthlete would rewrite it while it
    // stayed withdrawn. A returning athlete is re-enrolled under a new
    // athlete_id and a new login (OD-2026-09-30-004 e1).
    await assertAthleteRecordNotWithdrawn({ organizationId, athleteId }, client);

    // The athlete's account: createOrUpdateAthleteAccount refuses one in
    // another organization, would re-role a same-organization account of any
    // other role into a locked athlete account, would re-bind another child's
    // athlete login to this child's record, would re-provision a deleted login
    // that still could not sign in, and meets the one-login-per-athlete
    // constraint only after the athlete record is written. All refused here,
    // the deleted-login hold on the record first. With no account_id, the
    // deleted-login hold is still refused, on every promotion.
    if (params.accountId) {
      await assertAthleteAccountIdProvisionable(
        { accountId: params.accountId, athleteId, organizationId },
        client,
      );
    } else {
      await assertAthleteRecordNotHeldByDeletedLogin({ organizationId, athleteId }, client);
    }

    await upsertAthlete(organizationId, athlete, client);
  };
  await (callerClient ? write(callerClient) : withTransaction(write));
}

/**
 * Refuses, before anything is written, promoting onto an athlete record that
 * was withdrawn (pilot.athletes.deleted_at set).
 *
 * upsertAthlete does not read or clear deleted_at, so re-promoting a withdrawn
 * athlete_id rewrote a record that stayed withdrawn, still on its retention
 * clock, and its deleted login still held the record, so no new login could be
 * made for it. Restoring a withdrawn athlete is not an intake action (Jason
 * 2026-09-30, OD-2026-09-30-004 e3, B). A returning athlete is re-enrolled as a
 * new athlete record with a new login (e1, A; Jason 2026-09-30, "go with A").
 */
export async function assertAthleteRecordNotWithdrawn(params: {
  organizationId: string;
  athleteId: string;
}, client?: PoolClient): Promise<void> {
  const row = await readOne<{ withdrawn: boolean }>(
    client,
    `select deleted_at is not null as withdrawn
     from pilot.athletes where organization_id = $1 and athlete_id = $2`,
    [params.organizationId, params.athleteId],
  );

  if (row?.withdrawn) {
    throw new ConflictError(
      `Conflict: athlete record "${params.athleteId}" was withdrawn. Intake does not restore a withdrawn athlete. `
      + 'To re-enroll them, promote under a new athlete_id, and a new account_id if they need a login.',
      'WITHDRAWN_ATHLETE_RECORD',
    );
  }
}

/**
 * The refusal for naming an existing guardian record with a different login
 * account. A guardian record's account is the login that sees every child
 * linked to that record, so re-pointing it silently would cut the real parent
 * off from all their children and hand them to whoever holds the new login.
 * Intake refuses instead. Moving a guardian to another login on purpose is not
 * an intake action and nothing here provides one.
 */
function guardianAccountConflict(parentId: string, accountId: string): ConflictError {
  return new ConflictError(
    `Conflict: guardian record "${parentId}" is already linked to another login account, not "${accountId}". `
    + 'Intake does not move a guardian to another login. Leave account_id out to keep the current link, '
    + 'or use a new parent_id if this is a different guardian.',
    'GUARDIAN_ACCOUNT_CONFLICT',
  );
}

/**
 * Refuses, before any write, a request that would re-point an existing
 * guardian record to a different login account.
 *
 * upsertGuardian enforces the same rule itself, atomically, and that is the
 * guarantee. This read exists for review-action's promotion, which had no
 * transaction around its writes when it was added: without it the athlete
 * record, and any athlete or guardian account the payload names, were already
 * written when upsertGuardian refused. The promotion's writes are one
 * transaction now (OD-2026-10-03-002 section 5), so that refusal rolls them
 * back; this read still refuses before the transaction opens.
 */
export async function assertGuardianAccountUnchanged(params: {
  organizationId: string;
  parentId: string;
  accountId?: string;
}): Promise<void> {
  if (!params.accountId) {
    return;
  }

  const existing = await queryOne<{ account_id: string | null }>(
    'select account_id from pilot.parents where organization_id = $1 and parent_id = $2',
    [params.organizationId, params.parentId],
  );

  if (existing?.account_id && existing.account_id !== params.accountId) {
    throw guardianAccountConflict(params.parentId, params.accountId);
  }
}

export async function upsertGuardian(params: {
  organizationId: string;
  parentId: string;
  accountId?: string;
  fullName: string;
  phone?: string;
  email?: string;
}, client?: PoolClient): Promise<void> {
  // account_id, phone and email are optional in this signature -- both
  // callers omit them when the caller-supplied payload simply did not carry
  // one, not to mean "clear it". Overwriting unconditionally, as this used to
  // do, meant naming an EXISTING parent_id with a shorter payload silently
  // nulled a real guardian's account link and contact details rather than
  // leaving them alone. coalesce against the current row so an omitted field
  // preserves what is already on file; full_name has no optional caller path
  // (both call sites always supply one) and keeps overwriting as before.
  //
  // account_id may FILL an empty link or restate the same one, never replace
  // a different one. coalesce alone let a supplied account_id overwrite the
  // guardian's existing login, silently moving every child linked to this
  // record to the new login. The where clause makes that case update nothing,
  // so no row comes back and the write is refused below. It is in the same
  // statement as the write, so a concurrent change cannot slip between a
  // check and the update.
  const written = await writeRows<{ parent_id: string }>(
    client,
    `insert into pilot.parents
     (organization_id, parent_id, account_id, full_name, phone, email)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (organization_id, parent_id) do update set
       account_id = coalesce(excluded.account_id, pilot.parents.account_id),
       full_name = excluded.full_name,
       phone = coalesce(excluded.phone, pilot.parents.phone),
       email = coalesce(excluded.email, pilot.parents.email),
       updated_at = now()
     where pilot.parents.account_id is null
        or excluded.account_id is null
        or pilot.parents.account_id = excluded.account_id
     returning parent_id`,
    [params.organizationId, params.parentId, params.accountId ?? null, params.fullName, params.phone ?? null, params.email ?? null],
  );

  if (written.length === 0) {
    // Only the where clause can leave nothing written, and it only fails
    // when both sides carry an account_id and they differ.
    throw guardianAccountConflict(params.parentId, params.accountId ?? '');
  }
}

export async function linkGuardianAthlete(params: {
  organizationId: string;
  parentId: string;
  athleteId: string;
  relationshipToAthlete: string;
}, client?: PoolClient): Promise<void> {
  await writeRows(
    client,
    `insert into pilot.guardian_links
     (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1,$2,$3,$4)
     on conflict (organization_id, parent_id, athlete_id) do update set
       relationship_to_athlete = excluded.relationship_to_athlete,
       updated_at = now()`,
    [params.organizationId, params.parentId, params.athleteId, params.relationshipToAthlete],
  );
}

export async function getIntakeCaseAggregate(
  organizationId: string,
  intakeCaseId: string,
  context?: { actorAccountId: string; actorRole: PilotRole },
): Promise<Record<string, unknown> | null> {
  const intakeCase = await getIntakeCaseById(organizationId, intakeCaseId);
  if (!intakeCase) {
    return null;
  }

  // Same reader scoping the domain-get route applies, because this aggregate
  // is reachable by the same roles: /api/pilot/intake/cases/get admits
  // 'athlete' and 'parent', and assertActorCanAccessIntakeCase gates on
  // assertActorCanAccessAthlete for every subject the case names. Without a
  // context there is no reader to scope to, so this falls to identity only --
  // the closed side.
  //
  // All THREE of the route's reader scopings, not one of them. The note-type
  // filter was the first one written, and this aggregate never received it:
  // the sibling route has filtered pilot.coach_observations by reader since
  // that fix landed, while this function -- reachable by the same athlete and
  // the same two guardians -- went on returning the whole shared bus,
  // including the 'home_barrier' and 'transportation_barrier' rows a guardian
  // wrote to a coach in confidence and the 'parent_message' rows addressed to
  // the other household. Two reads of one table cannot give two answers to
  // "what may this reader see".
  const readerRole = context?.actorRole ?? 'athlete';
  const guardianColumns = guardianColumnsForReader(readerRole);
  const emergencyContactColumns = emergencyContactColumnsForReader(readerRole);
  const waiverColumns = waiverColumnsForReader(readerRole);
  const medicalIntakeColumns = medicalIntakeColumnsForReader(readerRole);
  const attendanceColumns = attendanceColumnsForReader(readerRole);
  const assessmentColumns = assessmentColumnsForReader(readerRole);
  const readinessColumns = readinessColumnsForReader(readerRole);
  const readableNoteTypes = coachObservationNoteTypesForReader(readerRole);

  const [documents, emergencyContacts, medical, waivers, assessments, attendance, readiness, notes, guardians, shadowTimeline] = await Promise.all([
    query('select * from pilot.intake_documents where organization_id = $1 and intake_case_id = $2 order by created_at asc', [organizationId, intakeCaseId]),
    query(
      `select ${emergencyContactColumns.join(', ')} from pilot.emergency_contacts
       where organization_id = $1 and athlete_id = $2 order by created_at desc`,
      [organizationId, intakeCase.primary_athlete_id],
    ),
    query(
      `select ${medicalIntakeColumns.join(', ')} from pilot.medical_intake
       where organization_id = $1 and athlete_id = $2 order by created_at desc`,
      [organizationId, intakeCase.primary_athlete_id],
    ),
    query(
      `select ${waiverColumns.join(', ')} from pilot.waivers
       where organization_id = $1 and athlete_id = $2 order by created_at desc`,
      [organizationId, intakeCase.primary_athlete_id],
    ),
    query(
      `select ${assessmentColumns.join(', ')} from pilot.assessments
       where organization_id = $1 and athlete_id = $2 order by created_at desc`,
      [organizationId, intakeCase.primary_athlete_id],
    ),
    query(
      `select ${attendanceColumns.join(', ')} from pilot.attendance
       where organization_id = $1 and athlete_id = $2 order by attendance_date desc`,
      [organizationId, intakeCase.primary_athlete_id],
    ),
    query(
      `select ${readinessColumns.join(', ')} from pilot.readiness
       where organization_id = $1 and athlete_id = $2 order by measured_at desc`,
      [organizationId, intakeCase.primary_athlete_id],
    ),
    query(
      `select * from pilot.coach_observations
       where organization_id = $1
         and athlete_id = $2
         and ($3::text[] is null or note_type = any($3::text[]))
       order by created_at desc`,
      [organizationId, intakeCase.primary_athlete_id, readableNoteTypes],
    ),
    query(
      `select ${guardianColumns.join(', ')}, g.relationship_to_athlete, g.athlete_id
       from pilot.guardian_links g
       join pilot.parents p
         on p.organization_id = g.organization_id
        and p.parent_id = g.parent_id
      where g.organization_id = $1 and g.athlete_id = $2`,
      [organizationId, intakeCase.primary_athlete_id],
    ),
    context
      ? getShadowEventTimeline(
          {
            organizationId,
            actorAccountId: context.actorAccountId,
            actorRole: context.actorRole,
          },
          { correlationId: intakeCaseId, limit: 100 },
        )
      : Promise.resolve([]),
  ]);

  return {
    intake_case: intakeCase,
    shadow_timeline: shadowTimeline,
    documents,
    emergency_contacts: emergencyContacts,
    medical_intake: medical,
    waivers,
    assessments,
    attendance,
    readiness,
    coach_observations: notes,
    guardians,
  };
}

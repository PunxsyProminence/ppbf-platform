import { randomUUID } from 'node:crypto';

import {
  assertActorCanAccessAthlete,
  isOrganizationAdminRole,
  type ActorIdentity,
} from './access';
import type { PilotRole } from './contracts';
import { query, queryOne } from './db';
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
}): Promise<void> {
  await query(
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

  await query(
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
}): Promise<void> {
  await query(
    `update pilot.intake_documents
     set owner_entity_type = $3,
         owner_entity_id = $4,
         updated_at = now()
     where organization_id = $1 and intake_case_id = $2`,
    [params.organizationId, params.intakeCaseId, params.ownerEntityType, params.ownerEntityId],
  );

  const docs = await query<{
    blob_path: string;
    classification: string;
    created_by_account_id: string;
  }>(
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
    await query(
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

export async function upsertEmergencyContact(params: {
  organizationId: string;
  athleteId: string;
  fullName: string;
  relationshipToAthlete: string;
  phone: string;
  email?: string;
  isPrimary?: boolean;
  notes?: string;
}): Promise<string> {
  const contactId = randomUUID();

  await query(
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
}): Promise<string> {
  const medicalId = randomUUID();

  await query(
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

export async function upsertWaiver(params: {
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
}): Promise<string> {
  const waiverId = randomUUID();

  await query(
    `insert into pilot.waivers
     (organization_id, waiver_id, athlete_id, waiver_type, signed_by_name, signed_by_role, signed_at, consent_version, status, notes, parent_id, covers_video, public_use_allowed)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
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
    ],
  );

  return waiverId;
}

export async function createAssessment(params: {
  organizationId: string;
  athleteId: string;
  assessorAccountId: string;
  assessmentType: string;
  result: Record<string, unknown>;
}): Promise<string> {
  const assessmentId = randomUUID();

  await query(
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
}): Promise<string> {
  const attendanceId = randomUUID();

  await query(
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
}): Promise<string> {
  const readinessId = randomUUID();

  await query(
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

export async function createCoachObservation(params: {
  organizationId: string;
  athleteId: string;
  coachAccountId: string;
  noteType: string;
  noteText: string;
}): Promise<string> {
  const noteId = randomUUID();

  await query(
    `insert into pilot.coach_observations
     (organization_id, note_id, athlete_id, coach_account_id, note_type, note_text)
     values ($1,$2,$3,$4,$5,$6)`,
    [params.organizationId, noteId, params.athleteId, params.coachAccountId, params.noteType, params.noteText],
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
 * staff, who need them to make the emergency call -- that is the whole reason
 * the columns exist. The platform is stricter still one step further out:
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

export async function upsertGuardian(params: {
  organizationId: string;
  parentId: string;
  accountId?: string;
  fullName: string;
  phone?: string;
  email?: string;
}): Promise<void> {
  // account_id, phone and email are optional in this signature -- both
  // callers omit them when the caller-supplied payload simply did not carry
  // one, not to mean "clear it". Overwriting unconditionally, as this used to
  // do, meant naming an EXISTING parent_id with a shorter payload silently
  // nulled a real guardian's account link and contact details rather than
  // leaving them alone. coalesce against the current row so an omitted field
  // preserves what is already on file; full_name has no optional caller path
  // (both call sites always supply one) and keeps overwriting as before.
  await query(
    `insert into pilot.parents
     (organization_id, parent_id, account_id, full_name, phone, email)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (organization_id, parent_id) do update set
       account_id = coalesce(excluded.account_id, pilot.parents.account_id),
       full_name = excluded.full_name,
       phone = coalesce(excluded.phone, pilot.parents.phone),
       email = coalesce(excluded.email, pilot.parents.email),
       updated_at = now()`,
    [params.organizationId, params.parentId, params.accountId ?? null, params.fullName, params.phone ?? null, params.email ?? null],
  );
}

export async function linkGuardianAthlete(params: {
  organizationId: string;
  parentId: string;
  athleteId: string;
  relationshipToAthlete: string;
}): Promise<void> {
  await query(
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
  const guardianColumns = guardianColumnsForReader(context?.actorRole ?? 'athlete');

  const [documents, emergencyContacts, medical, waivers, assessments, attendance, readiness, notes, guardians, shadowTimeline] = await Promise.all([
    query('select * from pilot.intake_documents where organization_id = $1 and intake_case_id = $2 order by created_at asc', [organizationId, intakeCaseId]),
    query(
      'select * from pilot.emergency_contacts where organization_id = $1 and athlete_id = $2 order by created_at desc',
      [organizationId, intakeCase.primary_athlete_id],
    ),
    query(
      'select * from pilot.medical_intake where organization_id = $1 and athlete_id = $2 order by created_at desc',
      [organizationId, intakeCase.primary_athlete_id],
    ),
    query('select * from pilot.waivers where organization_id = $1 and athlete_id = $2 order by created_at desc', [organizationId, intakeCase.primary_athlete_id]),
    query('select * from pilot.assessments where organization_id = $1 and athlete_id = $2 order by created_at desc', [organizationId, intakeCase.primary_athlete_id]),
    query('select * from pilot.attendance where organization_id = $1 and athlete_id = $2 order by attendance_date desc', [organizationId, intakeCase.primary_athlete_id]),
    query('select * from pilot.readiness where organization_id = $1 and athlete_id = $2 order by measured_at desc', [organizationId, intakeCase.primary_athlete_id]),
    query('select * from pilot.coach_observations where organization_id = $1 and athlete_id = $2 order by created_at desc', [organizationId, intakeCase.primary_athlete_id]),
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

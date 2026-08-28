import { query, queryOne } from './db';
import type { ShadowConfidenceTier } from './shadowAuthority';
import type { ShadowSourceVerificationState } from './shadow';

export interface ShadowResearchRequirementInput {
  organizationId: string;
  sourceEventName: string;
  sourceEntityType: string;
  sourceEntityId: string;
  researchRequirement: string;
  knowledgeGap: string;
  evidenceLabel: string | null;
  sourceStatus: string;
  sourceConfidenceTier: ShadowConfidenceTier;
  sourceVerificationState: ShadowSourceVerificationState;
  createdByAccountId: string;
  createdByRole: string;
  metadata?: Record<string, unknown>;
  // Mirrors pilot.shadow_library_documents.subject_id exactly: text,
  // nullable, no foreign key -- a research requirement may outlive the
  // athlete it was about. Absent/null means the row is not about one athlete
  // (e.g. an org-wide capability-coverage gap).
  subjectId?: string | null;
}

export interface ShadowResearchRequirementRow {
  research_requirement_id: number;
  organization_id: string;
  source_event_name: string;
  source_entity_type: string;
  source_entity_id: string;
  research_requirement: string;
  knowledge_gap: string;
  evidence_label: string | null;
  source_status: string;
  source_confidence_tier: string;
  source_verification_state: string;
  status: 'open' | 'resolved';
  created_by_account_id: string;
  created_by_role: string;
  metadata: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
  subject_id: string | null;
}

export interface ShadowResearchRequirementFilter {
  status?: 'open' | 'resolved';
  // When provided, only return rows tied to one of these athlete IDs.
  athleteIds?: string[];
}

export async function createShadowResearchRequirement(input: ShadowResearchRequirementInput): Promise<number> {
  const row = await queryOne<{ research_requirement_id: number }>(
    `insert into pilot.shadow_research_requirements
     (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement, knowledge_gap, evidence_label, source_status, source_confidence_tier, source_verification_state, created_by_account_id, created_by_role, metadata, subject_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
     on conflict (organization_id, source_event_name, source_entity_type, source_entity_id)
     do update set
       source_entity_id = pilot.shadow_research_requirements.source_entity_id
     returning research_requirement_id`,
    [
      input.organizationId,
      input.sourceEventName,
      input.sourceEntityType,
      input.sourceEntityId,
      input.researchRequirement,
      input.knowledgeGap,
      input.evidenceLabel,
      input.sourceStatus,
      input.sourceConfidenceTier,
      input.sourceVerificationState,
      input.createdByAccountId,
      input.createdByRole,
      JSON.stringify(input.metadata ?? {}),
      input.subjectId ?? null,
    ],
  );

  if (!row) {
    throw new Error('Unable to create SHADOW research requirement.');
  }

  return row.research_requirement_id;
}

// Every column of a requirement row, in the order ShadowResearchRequirementRow
// declares them. Shared by the list read and the single-row read below so the
// two cannot drift into returning different shapes of the same record.
const REQUIREMENT_COLUMNS = `research_requirement_id,
       organization_id,
       source_event_name,
       source_entity_type,
       source_entity_id,
       research_requirement,
       knowledge_gap,
       evidence_label,
       source_status,
       source_confidence_tier,
       source_verification_state,
       status,
       created_by_account_id,
       created_by_role,
       metadata,
       created_at,
       resolved_at,
       subject_id`;

/**
 * One stored requirement, by id, within one organization.
 *
 * This exists so an authorization decision about a requirement is made against
 * the row that is actually STORED rather than against whatever the caller
 * asserted in the request body. research_requirement_id is a bigserial: it is
 * guessed by counting, not leaked, so "the caller named an id" carries no
 * evidence at all about whether they may touch what the id points at.
 *
 * Organization-scoped like every other read here, so a cross-organization id
 * reads as absent rather than as a row.
 */
/**
 * WHICH ATHLETE A REQUIREMENT ROW NAMES.
 *
 * Lifted out of app/api/pilot/shadow/research-requirements/route.ts, where it
 * lived as route-local helpers, because a second route needed the same answer
 * and could not reach it. That is not a tidiness point: the research-SUBMISSIONS
 * route read submissions attached to these rows and scoped them on
 * organization_id alone, so a guardian could name any research_requirement_id
 * and read the staff notes on a requirement about somebody else's child. The
 * scoping existed; it was in a file the other route could not import from.
 *
 * `subject_id` is the authority -- the dedicated column added by
 * pilot_slice_postgres_research_requirement_subject_migration.sql precisely so
 * "which child is this row about" stops being guessed. The two metadata
 * fallbacks are the same ones the requirements route already trusted, in the
 * same priority order, so moving this changes no answer.
 */
export type SubjectBearingRow = Pick<ShadowResearchRequirementRow, 'subject_id' | 'metadata'>;

/** The metadata keys that name an athlete, in the priority order the subject
 *  resolution uses. Named once so the read scope, the create gate and the
 *  resolve gate cannot end up disagreeing about which keys count. */
export const SUBJECT_NAMING_METADATA_KEYS = ['subject_id', 'athlete_id'] as const;

export function namedAthleteId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Every athlete id a row NAMES, in priority order, deduplicated.
 *
 * subjectAthleteIdOf answers "who is this row about" and takes the first of
 * these. This answers the different question the WRITE paths need: "which
 * athletes does this row touch at all". They differ when the fields disagree
 * -- subject_id says one child and metadata.athlete_id another -- and on a
 * write every one of them has to be authorized, because whichever the reader
 * later believes, the row will have been filed against a child.
 */
export function namedAthleteIdsOf(row: SubjectBearingRow): string[] {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const candidates = [
    namedAthleteId(row.subject_id),
    ...SUBJECT_NAMING_METADATA_KEYS.map((key) => namedAthleteId(metadata[key])),
  ].filter((athleteId): athleteId is string => athleteId !== null);
  return Array.from(new Set(candidates));
}

/** The athlete a requirement row is ABOUT, or null when it is about no one. */
export function subjectAthleteIdOf(row: SubjectBearingRow): string | null {
  return namedAthleteIdsOf(row)[0] ?? null;
}

export async function getShadowResearchRequirementById(
  organizationId: string,
  researchRequirementId: number,
): Promise<ShadowResearchRequirementRow | null> {
  return queryOne<ShadowResearchRequirementRow>(
    `select
       ${REQUIREMENT_COLUMNS}
     from pilot.shadow_research_requirements
     where organization_id = $1
       and research_requirement_id = $2`,
    [organizationId, researchRequirementId],
  );
}

export async function listShadowResearchRequirements(
  organizationId: string,
  filter: ShadowResearchRequirementFilter = {},
): Promise<ShadowResearchRequirementRow[]> {
  const athleteIds = filter.athleteIds ?? [];
  const hasAthleteScope = athleteIds.length > 0;
  return query<ShadowResearchRequirementRow>(
    `select
       ${REQUIREMENT_COLUMNS}
     from pilot.shadow_research_requirements
     where organization_id = $1
       and ($2::text is null or status = $2)
       and (
         $3::boolean = false
         or subject_id = any($4::text[])
       )
     order by created_at desc`,
    [organizationId, filter.status ?? null, hasAthleteScope, athleteIds],
  );
}

export async function resolveShadowResearchRequirement(input: {
  organizationId: string;
  researchRequirementId: number;
  resolvedByAccountId: string;
  resolvedByRole: string;
  metadata?: Record<string, unknown>;
  // When provided (a parent caller), the row must match one of these athlete
  // IDs via the subject_id column -- otherwise a parent could resolve any
  // other family's requirement in the org by guessing/enumerating an id, even
  // though the list view is already correctly scoped.
  athleteIds?: string[];
  /**
   * The athlete the caller ALREADY AUTHORIZED for this exact row, or null when
   * the row they authorized names no athlete at all.
   *
   * REQUIRED, not optional, and that is the point. The caller resolves the
   * stored row's subject, runs it through assertActorCanAccessAthlete, and
   * then hands that same value here so the authorization and the write are ONE
   * statement: if the row's subject is not still exactly what was authorized
   * when the UPDATE runs, zero rows match and nothing is written. A caller
   * that could omit this would be back to a check-then-write with a gap
   * between them -- the TOCTOU shape #624/#630/#648 fixed elsewhere -- so the
   * type system refuses to let a new call site forget it.
   *
   * The predicate resolves the subject in SQL exactly as the route resolves it
   * in TypeScript: the subject_id column first, then metadata.subject_id, then
   * metadata.athlete_id. The metadata arms are load-bearing, not belt-and-
   * braces: the subject_id migration's backfill never reads metadata.athlete_id,
   * so every intake-review row written before its application companion names
   * its child ONLY there, with the column NULL. `is not distinct from` rather
   * than `=` so that "this row names nobody" is itself a value that must match,
   * instead of a NULL that silently drops the predicate.
   *
   * Where the two resolutions could disagree they disagree CLOSED: SQL's
   * `->>` renders a non-string metadata value as text where the TypeScript
   * helper reads it as "names no athlete", and btrim strips ASCII spaces where
   * String.trim strips all whitespace. Either way the comparison fails and the
   * write is refused; neither direction admits a write the caller did not
   * authorize.
   */
  expectedSubjectAthleteId: string | null;
}): Promise<boolean> {
  const hasAthleteScope = (input.athleteIds?.length ?? 0) > 0;
  const rows = await query<{
    research_requirement_id: number;
  }>(
    `update pilot.shadow_research_requirements
     set status = 'resolved',
         resolved_at = now(),
         metadata = metadata || $3::jsonb
     where organization_id = $1
       and research_requirement_id = $2
       and status = 'open'
       and (
         $4::boolean = false
         or subject_id = any($5::text[])
       )
       and coalesce(
             nullif(btrim(subject_id), ''),
             nullif(btrim(metadata->>'subject_id'), ''),
             nullif(btrim(metadata->>'athlete_id'), '')
           ) is not distinct from $6::text
     returning research_requirement_id`,
    [
      input.organizationId,
      input.researchRequirementId,
      // The actor fields go LAST so they win the spread. They used to go
      // first, which let a caller's own `metadata` overwrite them: any
      // admitted role could resolve a requirement while passing
      // {resolved_by_account_id, resolved_by_role} of their choosing, and the
      // stored row would then name somebody else as having handled a
      // safeguarding-adjacent follow-up. Attribution on this row is the
      // server's to state, not the caller's.
      JSON.stringify({
        ...(input.metadata ?? {}),
        resolved_by_account_id: input.resolvedByAccountId,
        resolved_by_role: input.resolvedByRole,
      }),
      hasAthleteScope,
      input.athleteIds ?? [],
      input.expectedSubjectAthleteId,
    ],
  );

  return rows.length > 0;
}

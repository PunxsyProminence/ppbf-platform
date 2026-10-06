import { isOrganizationAdminRole } from './access';
import type { PilotRole } from './contracts';
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

/**
 * Who sees and closes the gym's research questions and needs: the rows that
 * name no athlete.
 *
 * Those rows carry the asker's own words -- a Library question goes in as
 * metadata.question and knowledge_gap, a negative feedback note from the
 * learning loop as knowledge_gap and metadata.note. They were readable, and
 * their submissions and review notes too, by every role the research routes
 * admit, so one family's question was readable by every other family (CL-A3).
 *
 * RULING (Jason 2026-10-06, CL-A3): "Staff only" -- coaches and organization
 * admins see the gym's research questions and needs; everyone else sees only
 * their own. One copy for both routes (research-requirements and
 * research-submissions), so they cannot drift apart.
 */
export function isResearchStaff(role: PilotRole): boolean {
  return role === 'coach' || isOrganizationAdminRole(role);
}

export function mayReadSubjectlessResearchRow(
  actor: { accountId: string; role: PilotRole },
  row: Pick<ShadowResearchRequirementRow, 'created_by_account_id'>,
): boolean {
  return isResearchStaff(actor.role) || row.created_by_account_id === actor.accountId;
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

/**
 * THE CAPABILITY-COVERAGE GAP TICKET.
 *
 * recomputeShadowCapabilityCoverage opens one of these for a rule that grades
 * uncovered or partial, and -- Jason 2026-09-29, R2: "the coverage check
 * closes its own gap tickets once a topic becomes covered" -- closes it again
 * once the rule grades covered. The unique index on (organization_id,
 * source_event_name, source_entity_type, source_entity_id) makes this at most
 * ONE row per capability per organization, ever; source_entity_id is the
 * capability_key.
 */
export const CAPABILITY_GAP_SOURCE_EVENT_NAME = 'SHADOW_LIBRARY_CAPABILITY_GAP_DETECTED';
export const CAPABILITY_GAP_SOURCE_ENTITY_TYPE = 'shadow_library_capability_map';

export interface CapabilityGapFields {
  capabilityKey: string;
  coverageState: 'uncovered' | 'partial';
  requiredSourceTypes: string[];
  minimumAuthorityTier: number;
  minimumSourceCount: number;
  matchedSources: number;
}

/**
 * The gap ticket's text, composed only from the capability rule's own fields.
 * The coverage check writes it, and the research-bridge export rebuilds it from
 * the row's metadata rather than shipping the stored prose -- so a row a
 * member forged carries none of its own words out.
 */
export function buildCapabilityGapResearchFields(fields: CapabilityGapFields) {
  const requiredTypes = fields.requiredSourceTypes.length > 0 ? fields.requiredSourceTypes.join(', ') : 'any verified source type';
  const requirement = `Close SHADOW Library coverage gap for capability ${fields.capabilityKey}`;
  const knowledgeGap =
    fields.coverageState === 'uncovered'
      ? `No qualifying SHADOW Library sources currently support capability ${fields.capabilityKey}. Required source types: ${requiredTypes}. Minimum authority tier: ${fields.minimumAuthorityTier}. Minimum source count: ${fields.minimumSourceCount}.`
      : `Capability ${fields.capabilityKey} has only ${fields.matchedSources} qualifying sources and requires ${fields.minimumSourceCount}. Required source types: ${requiredTypes}. Minimum authority tier: ${fields.minimumAuthorityTier}.`;

  return {
    requirement,
    knowledgeGap,
    sourceStatus: fields.coverageState === 'uncovered' ? 'missing' : 'weak',
  } as const;
}

/**
 * The metadata.resolution a coverage closure writes. It marks the closure as
 * the coverage check's own, so the same check may reopen that row as soon as
 * the gap comes back.
 */
export const CAPABILITY_COVERED_RESOLUTION = 'capability_covered';

/**
 * The metadata key the coverage check stamps on a ticket a PERSON resolved,
 * when that capability grades covered while the ticket is resolved.
 *
 * A hand resolve is respected while the gap it was about is still the same
 * gap: a person who closes a still-uncovered capability ("not pursuing this")
 * is not overruled on the next recompute. But once the capability has been
 * covered since, a later uncovered or partial grade is a NEW gap, and it must
 * not go ticketless (OD-2026-09-29-002 item 4; overwatch 2026-10-03, D1 = A).
 * This stamp is the record that coverage happened in between; the person's
 * own resolution keys are left as they wrote them.
 */
export const COVERED_AFTER_RESOLUTION_KEY = 'covered_after_resolution_at';

/**
 * "This row names no athlete", in SQL, resolved exactly as
 * resolveShadowResearchRequirement resolves a row's subject: the subject_id
 * column, then metadata.subject_id, then metadata.athlete_id. A coverage gap is
 * org-wide by construction; the automatic open, close and reopen touch nothing
 * else, whatever the other columns say. `row` qualifies the columns, which an
 * ON CONFLICT clause needs to tell the stored row from `excluded`.
 */
function namesNoAthleteSql(row = ''): string {
  const prefix = row ? `${row}.` : '';
  return `coalesce(
             nullif(btrim(${prefix}subject_id), ''),
             nullif(btrim(${prefix}metadata->>'subject_id'), ''),
             nullif(btrim(${prefix}metadata->>'athlete_id'), '')
           ) is null`;
}

/**
 * Closes the organization's OPEN coverage gap ticket for every capability that
 * just graded covered, and stamps COVERED_AFTER_RESOLUTION_KEY on any of those
 * capabilities' tickets a person resolved by hand. One statement for the whole
 * pass; the two halves touch disjoint rows (open versus resolved).
 *
 * "Closed" is this table's own vocabulary: status 'resolved' with resolved_at
 * stamped, and resolved_by_account_id / resolved_by_role merged into metadata
 * -- the same record resolveShadowResearchRequirement leaves for a manual
 * close. The actor is whoever ran the recompute; the attribution keys go LAST
 * in the merge so nothing already in metadata can overwrite them.
 *
 * Returns the rows it closed, so the caller can record them.
 */
export async function resolveCoveredCapabilityGapRequirements(input: {
  organizationId: string;
  covered: ReadonlyArray<{ capabilityKey: string; matchedSources: number }>;
  resolvedByAccountId: string;
  resolvedByRole: string;
}): Promise<Array<{ research_requirement_id: number; capability_key: string }>> {
  if (input.covered.length === 0) {
    return [];
  }

  return query<{ research_requirement_id: number; capability_key: string }>(
    `with covered as (
       select * from unnest($4::text[], $5::int[]) as v(capability_key, matched_sources)
     ),
     stamped as (
       update pilot.shadow_research_requirements
       set metadata = metadata || jsonb_build_object($9::text, now())
       from covered v
       where organization_id = $1
         and source_event_name = $2
         and source_entity_type = $3
         and source_entity_id = v.capability_key
         and status = 'resolved'
         and metadata->>'resolution' is distinct from $6
         and not (metadata ? $9::text)
         and ${namesNoAthleteSql()}
       returning research_requirement_id
     )
     update pilot.shadow_research_requirements
     set status = 'resolved',
         resolved_at = now(),
         metadata = metadata || jsonb_build_object(
           'resolved_matched_sources', v.matched_sources,
           'resolution', $6::text,
           'resolved_by_account_id', $7::text,
           'resolved_by_role', $8::text
         )
     from covered v
     where organization_id = $1
       and source_event_name = $2
       and source_entity_type = $3
       and source_entity_id = v.capability_key
       and status = 'open'
       and ${namesNoAthleteSql()}
     returning research_requirement_id, source_entity_id as capability_key`,
    [
      input.organizationId,
      CAPABILITY_GAP_SOURCE_EVENT_NAME,
      CAPABILITY_GAP_SOURCE_ENTITY_TYPE,
      input.covered.map((item) => item.capabilityKey),
      input.covered.map((item) => item.matchedSources),
      CAPABILITY_COVERED_RESOLUTION,
      input.resolvedByAccountId,
      input.resolvedByRole,
      COVERED_AFTER_RESOLUTION_KEY,
    ],
  );
}

/**
 * Puts a capability's gap ticket in the state the coverage check just graded,
 * in ONE statement, and says whether anything changed.
 *
 * The unique index allows one ticket per capability, so every case lands on
 * the same row:
 * - no row yet: insert it, open;
 * - an OPEN row whose text, status or coverage metadata differ from the gap
 *   as graded now (uncovered became partial, the matched count moved):
 *   refresh it in place, so the ticket never keeps a gap it no longer has;
 * - a RESOLVED row the check may reopen -- closed by the check itself, or
 *   resolved by a person and covered since (COVERED_AFTER_RESOLUTION_KEY):
 *   reopen it with the gap as it stands now. The closure's own keys are
 *   removed so an open row does not name who resolved it, and when that
 *   closure happened is kept as metadata.reopened_after_resolution_at;
 * - anything else (an open row already saying exactly this, a person's
 *   resolution not covered since, a row that names an athlete): untouched.
 *
 * Returns the ticket's id when a row was inserted, refreshed or reopened, and
 * null when nothing was written -- which is what lets the caller record a gap
 * event only for a gap that actually opened or changed.
 */
export async function syncCapabilityGapRequirement(input: {
  organizationId: string;
  capabilityKey: string;
  researchRequirement: string;
  knowledgeGap: string;
  sourceStatus: string;
  createdByAccountId: string;
  createdByRole: string;
  metadata: Record<string, unknown>;
}): Promise<number | null> {
  const row = await queryOne<{ research_requirement_id: number }>(
    `insert into pilot.shadow_research_requirements as t
       (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement, knowledge_gap, evidence_label, source_status, source_confidence_tier, source_verification_state, created_by_account_id, created_by_role, metadata)
     values ($1, $2, $3, $4, $5, $6, $4, $7, 'INSUFFICIENT', 'unknown', $8, $9, $10::jsonb)
     on conflict (organization_id, source_event_name, source_entity_type, source_entity_id)
     do update set
       status = 'open',
       resolved_at = null,
       research_requirement = excluded.research_requirement,
       knowledge_gap = excluded.knowledge_gap,
       source_status = excluded.source_status,
       metadata = case
         when t.status = 'resolved' then (
           t.metadata
             - 'resolution'
             - 'resolved_by_account_id'
             - 'resolved_by_role'
             - 'resolved_matched_sources'
             - $12::text
         ) || excluded.metadata || jsonb_build_object('reopened_after_resolution_at', t.resolved_at)
         else t.metadata || excluded.metadata
       end
     where ${namesNoAthleteSql('t')}
       and (
         (
           t.status = 'open'
           and (
             t.research_requirement is distinct from excluded.research_requirement
             or t.knowledge_gap is distinct from excluded.knowledge_gap
             or t.source_status is distinct from excluded.source_status
             -- A merge that changes anything. Not @>: array containment is a
             -- subset test, so a shrunk required_source_types would read as unchanged.
             or (t.metadata || excluded.metadata) is distinct from t.metadata
           )
         )
         or (
           t.status = 'resolved'
           and (t.metadata->>'resolution' = $11 or t.metadata ? $12::text)
         )
       )
     returning research_requirement_id`,
    [
      input.organizationId,
      CAPABILITY_GAP_SOURCE_EVENT_NAME,
      CAPABILITY_GAP_SOURCE_ENTITY_TYPE,
      input.capabilityKey,
      input.researchRequirement,
      input.knowledgeGap,
      input.sourceStatus,
      input.createdByAccountId,
      input.createdByRole,
      JSON.stringify(input.metadata),
      CAPABILITY_COVERED_RESOLUTION,
      COVERED_AFTER_RESOLUTION_KEY,
    ],
  );

  return row?.research_requirement_id ?? null;
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

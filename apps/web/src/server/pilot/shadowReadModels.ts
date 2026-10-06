import { accessibleAthleteIds, athleteIdsForCoach, isOrganizationAdminRole } from './access';
import type { PilotRole } from './contracts';
import { query } from './db';
import { athleteNotDeletedSql } from './deletedAthletes';
import { guardianAthleteIds } from './guardianAccess';
import { PAIN_REPORT_PENDING_REVIEW_EVENT_NAME, classifyPainReporter, readPainReporter } from './formulas/painReportAlert';

export interface ShadowReadContext {
  organizationId: string;
  actorAccountId: string;
  actorRole: PilotRole;
  athleteId?: string | null;
}

export type ShadowReviewState = 'pending_review' | 'approved' | 'rejected' | 'promoted' | 'unknown';

export interface ShadowListFilters {
  limit?: number;
  offset?: number;
  entityType?: string;
  entityId?: string;
  correlationId?: string;
  eventName?: string;
  metricName?: string;
  action?: string;
  allowed?: boolean;
  createdAfter?: string;
}

export interface ShadowEventRow {
  shadow_event_id: number;
  organization_id: string;
  event_name: string;
  entity_type: string;
  entity_id: string;
  actor_account_id: string | null;
  actor_role: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface ShadowTelemetryRow {
  shadow_telemetry_event_id: number;
  organization_id: string;
  metric_name: string;
  actor_account_id: string | null;
  actor_role: string | null;
  dimensions: Record<string, unknown>;
  created_at: string;
}

export interface ShadowAuthorityCheckRow {
  authority_check_id: number;
  organization_id: string;
  actor_account_id: string | null;
  actor_role: string | null;
  action: string;
  automation_mode: string;
  confidence_tier: string;
  allowed: boolean;
  reason: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ShadowReviewProjectionItem {
  intake_case_id: string;
  status: 'pending_review' | 'approved' | 'rejected' | 'promoted';
  summary: string;
  primary_athlete_id: string | null;
  created_at: string;
  updated_at: string;
  document_count: number;
  shadow_event_name: string | null;
  shadow_event_at: string | null;
}

export interface ShadowKnowledgeProjectionItem {
  type: 'Observation' | 'Pattern' | 'Finding' | 'Validated Lesson';
  title: string;
  source_event_name: string;
  entity_type: string;
  entity_id: string;
  review_state: ShadowReviewState;
  created_at: string;
}

export interface ShadowResearchProjectionItem {
  event_id: number;
  requirement: string | null;
  knowledge_gap: string | null;
  evidence_label: string | null;
  source_status: string;
  review_state: ShadowReviewState;
  source_event_name: string;
  created_at: string;
}

export interface ShadowObservationProjectionItem {
  id: string;
  source: 'event' | 'telemetry';
  label: string;
  entity_type: string | null;
  entity_id: string | null;
  review_state: ShadowReviewState;
  created_at: string;
}

// Floored as well as clamped (audit CL-C24): these arrive from a JSON body and
// are bound as Postgres bigint, which refuses 2.5 and the caller got a 500.
function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(Number(value))));
}

function clampOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(Number(value)));
}

/**
 * Two independent questions, one per field. They were previously entangled in
 * `restrictToAthleteIds` + `excludeAthleteScoped`, which could not express the
 * one combination a coach needs -- "these athletes, AND the rows that belong
 * to no athlete at all" -- and that gap is what left the coach branch with no
 * athlete restriction whatsoever.
 */
interface AthleteScope {
  // WHICH athlete-tied rows may this actor see?
  // A list: only rows tied to these athlete IDs (athlete: themselves; parent:
  // their linked athletes; coach: their assigned + actively covered roster).
  // The EMPTY list is a real answer -- "no athlete-tied row at all" -- and is
  // what every role that assertActorCanAccessAthlete refuses outright gets.
  // Null means unrestricted and is reserved for the organization admin, who
  // administers the whole gym's records.
  restrictToAthleteIds: string[] | null;
  // May this actor ALSO see rows that are tied to no athlete -- intake, job,
  // formula and library events, and intake cases with no primary athlete?
  // These carry no athlete subject to protect, and they are the bulk of an
  // operational feed. False for the two roles whose whole read is one child:
  // an athlete and a guardian have no business in the gym's operational
  // stream, and that is the behaviour they already had.
  includeUnscopedRows: boolean;
}

/**
 * Mirrors assertActorCanAccessAthlete (access.ts) so SHADOW read-model access
 * matches the actor's real athlete scope everywhere in the app -- the same
 * relationship, evaluated on every read.
 *
 * The coach branch is the one that was missing. A coach fell through to "no
 * athlete restriction at all", so /api/pilot/shadow/events answered a
 * caller-supplied `entity_id` for ANY athlete in the organization, and
 * roleCanViewSensitivePayload returns true for a coach, so the pain-report
 * payload came back with body site, pain type and severity intact. The
 * sanitizer is not the defect: a coach seeing pain location and severity for
 * THEIR OWN athlete is load-bearing (describePainReportEvent below renders
 * exactly those fields into the coach's feed label). Restricting the coach to
 * athleteIdsForCoach -- the same coach_id-of-record UNION active-coverage
 * contract the escalations, readiness board and Coach Cards reads already use
 * -- is what makes the unredacted payload legitimate.
 *
 * Roles that assertActorCanAccessAthlete refuses outright get the empty list,
 * not null. That was already the intent for a volunteer; volunteer was simply
 * the only one of the four that had been written down. staff falls through the
 * same refusal; platform_owner and board are refused by name there, and
 * shadowRoleSets.ts states the Omega tier is broader in breadth but strictly
 * narrower in depth and "must never reach protected health information ... in
 * any organization" -- which an org-wide unredacted pain-report read is.
 *
 * The default is the empty list, so a role added to PilotRole later reaches no
 * athlete-tied row until someone decides it should. It fails closed.
 */
async function resolveAthleteScope(context: ShadowReadContext): Promise<AthleteScope> {
  if (context.actorRole === 'athlete') {
    // Through the guard's own batched answer, not the bare id: a session that
    // outlived the athlete's deletion carries the same id, and the bare id
    // admitted it to every row tied to the deleted athlete. A deleted (or
    // never-existing) athlete reaches no athlete-tied row, like a parent with
    // no linked child.
    const ownIds = context.athleteId
      ? await accessibleAthleteIds(
          {
            accountId: context.actorAccountId,
            role: context.actorRole,
            organizationId: context.organizationId,
            athleteId: context.athleteId,
          },
          [context.athleteId],
        )
      : new Set<string>();
    return {
      restrictToAthleteIds: ownIds.size > 0 ? [...ownIds] : ['__unbound_athlete__'],
      includeUnscopedRows: false,
    };
  }

  if (context.actorRole === 'parent') {
    const athleteIds = await guardianAthleteIds(context.organizationId, context.actorAccountId);
    return { restrictToAthleteIds: athleteIds.length > 0 ? athleteIds : ['__unbound_athlete__'], includeUnscopedRows: false };
  }

  if (context.actorRole === 'coach') {
    // Empty is a real answer here too: a coach who currently reaches nobody
    // reads the operational feed and no athlete's rows. Never null.
    return {
      restrictToAthleteIds: await athleteIdsForCoach(context.organizationId, context.actorAccountId),
      includeUnscopedRows: true,
    };
  }

  if (isOrganizationAdminRole(context.actorRole)) {
    return { restrictToAthleteIds: null, includeUnscopedRows: true };
  }

  return { restrictToAthleteIds: [], includeUnscopedRows: true };
}

function roleCanViewSensitivePayload(role: PilotRole): boolean {
  return role === 'platform_owner' || role === 'organization_admin' || role === 'admin' || role === 'coach';
}

function pickSafeRecord(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in input) {
      out[key] = input[key];
    }
  }
  return out;
}

/**
 * Library research questions are staff only (Jason 2026-10-06, CL-A3): coaches
 * and organization admins read them; platform_owner is not staff and gets no
 * org-private access by default. roleCanViewSensitivePayload passes
 * platform_owner the whole payload, and a SHADOW_LIBRARY_CLAIM_* payload's
 * knowledge_gap quotes the question a member typed (shadowLibrary.ts), so for
 * those events platform_owner gets a fixed set of operational keys. It is an
 * allowlist so that a key added to the emitter later is withheld until someone
 * decides it is safe. Every other event keeps its payload for platform_owner;
 * the remaining non-staff roles already get the safe keys below, none of which
 * a claim event carries text in.
 */
function roleCanReadLibraryQuestions(role: PilotRole): boolean {
  return role === 'organization_admin' || role === 'admin' || role === 'coach';
}

const LIBRARY_CLAIM_OPERATIONAL_KEYS = [
  'scope',
  'subject_id',
  'status',
  'evidence_count',
  'confidence_level',
  'distinct_source_count',
  'research_requirement_id',
  // A fixed template naming only the scope ("Strengthen SHADOW Library
  // evidence for <scope> claim"); no member text.
  'research_requirement',
];

function sanitizeEventPayload(payload: Record<string, unknown>, role: PilotRole, eventName: string): Record<string, unknown> {
  if (roleCanViewSensitivePayload(role)) {
    if (eventName.toUpperCase().startsWith('SHADOW_LIBRARY_CLAIM_') && !roleCanReadLibraryQuestions(role)) {
      return pickSafeRecord(payload, LIBRARY_CLAIM_OPERATIONAL_KEYS);
    }
    return payload;
  }

  return pickSafeRecord(payload, [
    'intake_case_id',
    'intake_document_id',
    'document_type',
    'classification',
    'routed_queue',
    'automation_mode',
    'review_status',
    'entity_type',
    'entity_id',
    'has_guardian',
  ]);
}

function sanitizeDimensions(dimensions: Record<string, unknown>, role: PilotRole): Record<string, unknown> {
  if (roleCanViewSensitivePayload(role)) {
    return dimensions;
  }

  return pickSafeRecord(dimensions, [
    'document_type',
    'classification',
    'routed_queue',
    'automation_mode',
    'entity_type',
    'entity_id',
  ]);
}

function sanitizeAuthorityMetadata(metadata: Record<string, unknown>, role: PilotRole): Record<string, unknown> {
  if (roleCanViewSensitivePayload(role)) {
    return metadata;
  }

  return pickSafeRecord(metadata, ['file_name', 'document_type', 'intake_case_id', 'intake_document_id']);
}

function toReviewState(eventName: string): ShadowReviewState {
  const normalized = eventName.toUpperCase();
  if (normalized.includes('PROMOTED')) return 'promoted';
  if (normalized.includes('APPROVED')) return 'approved';
  if (normalized.includes('REJECTED')) return 'rejected';
  if (normalized.includes('PENDING') || normalized.includes('UPLOADED') || normalized.includes('ROUTED')) return 'pending_review';
  return 'unknown';
}

/**
 * The athletes a shadow_events row names, read from anywhere in its payload.
 *
 * The events reader used to tie a row to an athlete only through entity_type
 * 'athlete' or a TOP-LEVEL payload athlete_id / owner_entity_id, and treated
 * every other row as athlete-free (audit CL-A1 = CL-C6, 2026-10-05). Two
 * writers name the athlete elsewhere: writePilotAuditEvent mirrors every audit
 * event as { event_type, details }, so a PIN sign-in or a film-study
 * observation carries it at details.athlete_id; the Library emitters carry it
 * as subject_id next to the question text. Those rows reached every coach,
 * staff, volunteers and the platform owner -- the last refused athlete records
 * outright by assertActorCanAccessAthlete.
 *
 * So the tie is computed over every object at every depth of the payload
 * (jsonpath strict $.**), not over a list of known places:
 *   - athlete_ids: the entity_id of an entity_type 'athlete' row; the athlete
 *     behind the account an entity_type 'account' row is about (sign-out, PIN
 *     change and reset name only the account) and behind an acting athlete's
 *     account; the string value of any athlete_id / owner_entity_id /
 *     subject_id key, or of any key ending athlete..._id / athlete...Id
 *     (mentor_athlete_id, athleteId, ...); and the string elements of any
 *     array under a key containing "athlete" (athlete_ids, ...).
 *   - unresolved_athlete: an athlete account with no athlete id, or an object
 *     or a non-string array element under an athlete key. Such a row names
 *     someone this reader cannot identify, so only org-wide roles read it.
 *   - mentions_athlete: some key containing "athlete" holds a non-null value.
 *     A row that names an athlete without an id (athlete_name alone) is then
 *     neither provably anyone's nor athlete-free, and fails closed to the roles
 *     with organization-wide reach.
 * owner_entity_id and subject_id are read as athlete ids whatever they hold, as
 * the old predicate did for owner_entity_id; a non-athlete value there hides
 * the row from restricted roles rather than showing it.
 */
const SHADOW_EVENT_ATHLETE_TIE_SQL = `cross join lateral (
       select
         array(
           select distinct named.athlete_id
           from (
             select e.entity_id as athlete_id
             where e.entity_type = 'athlete'
             union all
             -- The athlete behind an account: the account row an entity_type
             -- 'account' event is about (sign-in, sign-out, PIN change or
             -- reset), and the account of an athlete who acted.
             select account.athlete_id
             from pilot.accounts account
             where account.organization_id = e.organization_id
               and (
                 (e.entity_type = 'account' and account.account_id = e.entity_id)
                 or (e.actor_role = 'athlete' and account.account_id = e.actor_account_id)
               )
             union all
             select pair.value #>> '{}'
             from jsonb_path_query(coalesce(e.payload, '{}'::jsonb), 'strict $.**') as node(value)
             cross join lateral jsonb_each(case when jsonb_typeof(node.value) = 'object' then node.value else '{}'::jsonb end) as pair
             where jsonb_typeof(pair.value) = 'string'
               and (pair.key in ('athlete_id', 'owner_entity_id', 'subject_id') or pair.key ~ '[Aa]thlete\\w*(_id|Id)$')
             union all
             select element.value #>> '{}'
             from jsonb_path_query(coalesce(e.payload, '{}'::jsonb), 'strict $.**') as node(value)
             cross join lateral jsonb_each(case when jsonb_typeof(node.value) = 'object' then node.value else '{}'::jsonb end) as pair
             cross join lateral jsonb_array_elements(case when jsonb_typeof(pair.value) = 'array' then pair.value else '[]'::jsonb end) as element(value)
             where pair.key ~* 'athlete'
               and jsonb_typeof(element.value) = 'string'
           ) as named
           where named.athlete_id is not null and named.athlete_id <> ''
         ) as athlete_ids,
         exists (
           select 1
           from jsonb_path_query(coalesce(e.payload, '{}'::jsonb), 'strict $.**') as node(value)
           cross join lateral jsonb_each(case when jsonb_typeof(node.value) = 'object' then node.value else '{}'::jsonb end) as pair
           where pair.key ~* 'athlete'
             and jsonb_typeof(pair.value) <> 'null'
         ) as mentions_athlete,
         (
           -- An athlete account with no athlete id behind it.
           exists (
             select 1
             from pilot.accounts account
             where account.organization_id = e.organization_id
               and account.role = 'athlete'
               and account.athlete_id is null
               and (
                 (e.entity_type = 'account' and account.account_id = e.entity_id)
                 or (e.actor_role = 'athlete' and account.account_id = e.actor_account_id)
               )
           )
           -- Structured data under an athlete key (athletes: [{ id }]) whose
           -- ids this reader cannot pick out.
           or exists (
             select 1
             from jsonb_path_query(coalesce(e.payload, '{}'::jsonb), 'strict $.**') as node(value)
             cross join lateral jsonb_each(case when jsonb_typeof(node.value) = 'object' then node.value else '{}'::jsonb end) as pair
             where pair.key ~* 'athlete'
               and (
                 jsonb_typeof(pair.value) = 'object'
                 or (jsonb_typeof(pair.value) = 'array' and jsonb_path_exists(pair.value, 'strict $[*] ? (@.type() != "string")'))
               )
           )
         ) as unresolved_athlete
     ) as tie`;

export async function listShadowEvents(context: ShadowReadContext, filters: ShadowListFilters = {}): Promise<ShadowEventRow[]> {
  const limit = clampLimit(filters.limit, 25, 200);
  const offset = clampOffset(filters.offset);
  const scope = await resolveAthleteScope(context);

  const rows = await query<ShadowEventRow>(
    `select
       shadow_event_id,
       organization_id,
       event_name,
       entity_type,
       entity_id,
       actor_account_id,
       actor_role,
       payload,
       created_at
     from pilot.shadow_events e
     ${SHADOW_EVENT_ATHLETE_TIE_SQL}
     where organization_id = $1
       and ($2::text is null or entity_type = $2)
       and ($3::text is null or entity_id = $3)
       and ($4::text is null or event_name = $4)
       and ($5::text is null or created_at >= $5::timestamptz)
       and (
         $6::text is null
         or entity_id = $6
         or payload->>'intake_case_id' = $6
         or payload->>'intake_document_id' = $6
         or payload->>'correlation_id' = $6
       )
       -- The access boundary. Two disjuncts, one per AthleteScope field: the
       -- athlete-tied rows this actor may see, plus -- separately -- the rows
       -- tied to no athlete. Keeping them separate is the whole point. With
       -- the athlete list alone the predicate is EXCLUSIVE: scoping a coach
       -- to their roster and stopping there deletes every athlete-free
       -- operational event (intake, library, formula, job) from their feed,
       -- which is most of it. Measured on a real Postgres over an
       -- eight-row fixture: five rows survive with this predicate, one
       -- without the second disjunct.
       --
       -- Which athletes a row names comes from tie (SHADOW_EVENT_ATHLETE_TIE_SQL),
       -- not from a top-level key list: an athlete-tied row is shown only when
       -- EVERY athlete it names is one this actor reaches, and a row that
       -- mentions an athlete without an id is never athlete-free.
       and (
         $9::text[] is null
         or (cardinality(tie.athlete_ids) > 0 and tie.athlete_ids <@ $9::text[] and not tie.unresolved_athlete)
         or ($10::boolean and cardinality(tie.athlete_ids) = 0 and not tie.mentions_athlete and not tie.unresolved_athlete)
       )
     order by created_at desc
     limit $7
     offset $8`,
    [
      context.organizationId,
      filters.entityType?.trim() || null,
      filters.entityId?.trim() || null,
      filters.eventName?.trim() || null,
      filters.createdAfter?.trim() || null,
      filters.correlationId?.trim() || null,
      limit,
      offset,
      scope.restrictToAthleteIds,
      scope.includeUnscopedRows,
    ],
  );

  return rows.map((row) => ({
    ...row,
    // The row's own actor column is the identifier of whoever wrote the event,
    // usually staff. The payload sanitizer never touched it, so every
    // non-staff caller received staff account ids (intake lane review,
    // 2026-10-06). actor_role stays: it is a label, not an identity.
    actor_account_id: roleCanViewSensitivePayload(context.actorRole) ? row.actor_account_id : null,
    payload: sanitizeEventPayload((row.payload ?? {}) as Record<string, unknown>, context.actorRole, row.event_name),
  }));
}

export async function listShadowTelemetry(context: ShadowReadContext, filters: ShadowListFilters = {}): Promise<ShadowTelemetryRow[]> {
  const limit = clampLimit(filters.limit, 25, 200);
  const offset = clampOffset(filters.offset);
  const scope = await resolveAthleteScope(context);

  const rows = await query<ShadowTelemetryRow>(
    `select
       shadow_telemetry_event_id,
       organization_id,
       metric_name,
       actor_account_id,
       actor_role,
       dimensions,
       created_at
     from pilot.shadow_telemetry_events
     where organization_id = $1
       and ($2::text is null or metric_name = $2)
       and ($3::text is null or created_at >= $3::timestamptz)
       and (
         $4::text is null
         or dimensions->>'intake_case_id' = $4
         or dimensions->>'intake_document_id' = $4
         or dimensions->>'entity_id' = $4
         or dimensions->>'correlation_id' = $4
       )
       -- Same two disjuncts as listShadowEvents. The athlete-free test is
       -- stricter than the athlete_id-is-null test it replaces: a dimensions blob
       -- naming an athlete through entity_type/entity_id or owner_entity_id is
       -- athlete-tied whether or not it also carries athlete_id, and reading
       -- it as unscoped would hand it straight back through the second
       -- disjunct to exactly the roles the first one just excluded.
       and (
         (
           $7::text[] is null
           or dimensions->>'athlete_id' = any($7::text[])
           or dimensions->>'entity_id' = any($7::text[])
           or dimensions->>'owner_entity_id' = any($7::text[])
         )
         or (
           $8::boolean
           and dimensions->>'athlete_id' is null
           and dimensions->>'owner_entity_id' is null
           and dimensions->>'entity_type' is distinct from 'athlete'
         )
       )
     order by created_at desc
     limit $5
     offset $6`,
    [
      context.organizationId,
      filters.metricName?.trim() || null,
      filters.createdAfter?.trim() || null,
      filters.correlationId?.trim() || null,
      limit,
      offset,
      scope.restrictToAthleteIds,
      scope.includeUnscopedRows,
    ],
  );

  return rows.map((row) => ({
    ...row,
    dimensions: sanitizeDimensions((row.dimensions ?? {}) as Record<string, unknown>, context.actorRole),
  }));
}

/**
 * The authority ledger, scoped the way its two siblings are.
 *
 * This reader shipped without an athlete-scope predicate while listShadowEvents
 * and listShadowTelemetry both carried one, and #569 -- the commit that made
 * the SHADOW read models mirror the athlete access contract -- did not touch
 * it. The gap mattered because assertShadowAuthority persists whatever metadata
 * its caller hands it, and two callers hand it an athlete id: the medical-status
 * route writes { athlete_id, status, expires_at } on every clearance change, and
 * intake domain-upsert writes { athlete_id } for entity types including
 * `medical` and `emergency_contact`.
 *
 * The sanitizer was no protection here. sanitizeAuthorityMetadata redacts only
 * for roles outside roleCanViewSensitivePayload, and all four roles this route
 * admits are inside it -- so the redacting branch was unreachable and the blob
 * came back whole.
 *
 * What that produced was a clean bypass of a restriction this file's own
 * neighbours call deliberate. SHADOW_PHI_ROLES excludes platform_owner because
 * "clearance is organization-private health information; the platform owner tier
 * has no legitimate need for it" -- so the medical-status route answers Omega
 * 403, and assertActorCanAccessAthlete refuses it every athlete-scoped record by
 * name. It could then read the same clearance status, athlete by athlete, out of
 * the ledger. A coach could read the clearance of an athlete they neither coach
 * nor cover, which assertCoachAssignedToAthlete refuses everywhere else.
 *
 * `action` is caller-supplied and reaches the `action = $2` predicate directly,
 * so the rows were targetable by name rather than needing to be found.
 */
export async function listShadowAuthorityChecks(context: ShadowReadContext, filters: ShadowListFilters = {}): Promise<ShadowAuthorityCheckRow[]> {
  const limit = clampLimit(filters.limit, 25, 200);
  const offset = clampOffset(filters.offset);
  const scope = await resolveAthleteScope(context);

  const rows = await query<ShadowAuthorityCheckRow>(
    `select
       authority_check_id,
       organization_id,
       actor_account_id,
       actor_role,
       action,
       automation_mode,
       confidence_tier,
       allowed,
       reason,
       metadata,
       created_at
     from pilot.shadow_authority_checks
     where organization_id = $1
       and ($2::text is null or action = $2)
       and ($3::boolean is null or allowed = $3)
       and ($4::text is null or created_at >= $4::timestamptz)
       and (
         $5::text is null
         or metadata->>'intake_case_id' = $5
         or metadata->>'intake_document_id' = $5
         or metadata->>'correlation_id' = $5
       )
       -- The same two disjuncts listShadowEvents and listShadowTelemetry carry,
       -- and for the same reason: most authority rows name no athlete at all
       -- (every upload, every review action, and every refusal assertShadowAuthority
       -- records before it throws), so scoping on the first disjunct alone would
       -- empty the governance console for the coaches and admins it is built for.
       --
       -- The athlete-free test is stricter than an athlete_id-is-null test, which
       -- is the trap the telemetry reader documents: a metadata blob naming an
       -- athlete through entity_type/entity_id or owner_entity_id is athlete-tied
       -- whether or not it also carries athlete_id, and reading it as unscoped
       -- would hand it back through the second disjunct to precisely the roles
       -- the first one just excluded.
       and (
         (
           $8::text[] is null
           or metadata->>'athlete_id' = any($8::text[])
           or metadata->>'entity_id' = any($8::text[])
           or metadata->>'owner_entity_id' = any($8::text[])
         )
         or (
           $9::boolean
           and metadata->>'athlete_id' is null
           and metadata->>'owner_entity_id' is null
           and metadata->>'entity_type' is distinct from 'athlete'
         )
       )
     order by created_at desc
     limit $6
     offset $7`,
    [
      context.organizationId,
      filters.action?.trim() || null,
      typeof filters.allowed === 'boolean' ? filters.allowed : null,
      filters.createdAfter?.trim() || null,
      filters.correlationId?.trim() || null,
      limit,
      offset,
      scope.restrictToAthleteIds,
      scope.includeUnscopedRows,
    ],
  );

  return rows.map((row) => ({
    ...row,
    metadata: sanitizeAuthorityMetadata((row.metadata ?? {}) as Record<string, unknown>, context.actorRole),
  }));
}

export async function getShadowEventTimeline(
  context: ShadowReadContext,
  params: { entityType?: string; entityId?: string; correlationId?: string; limit?: number } = {},
): Promise<ShadowEventRow[]> {
  return listShadowEvents(context, {
    limit: params.limit ?? 50,
    entityType: params.entityType,
    entityId: params.entityId,
    correlationId: params.correlationId,
  });
}

// Deletion scope B (OD-2026-09-29-002 item 10, "10 C") for an intake case: the
// athlete its column names is not deleted, and neither is any athlete one of
// its documents is bound to. The second half covers a case promoted before
// the column was written whose documents name two athletes, which keeps a
// NULL column. A case bound to nobody passes both. Built per call, not at
// import, so a module that mocks deletedAthletes can still import this one.
function intakeCaseAthleteNotDeletedSql(): string {
  return `${athleteNotDeletedSql('c', 'primary_athlete_id')}
       and not exists (
         select 1
         from pilot.intake_documents owner_doc
         join pilot.athletes owner_athlete
           on owner_athlete.organization_id = owner_doc.organization_id
          and owner_athlete.athlete_id = owner_doc.owner_entity_id
         where owner_doc.organization_id = c.organization_id
           and owner_doc.intake_case_id = c.intake_case_id
           and owner_doc.owner_entity_type = 'athlete'
           and owner_athlete.deleted_at is not null)`;
}

// Which intake cases a reader may see in the review queue: exactly the cases
// assertActorCanAccessIntakeCase (intake.ts) would let them open (CL-A10).
// The queue used to scope on primary_athlete_id alone and admit every case
// with that column NULL to any coach. The column is NULL for the whole
// pending window and stays NULL on a promoted case whose documents name two
// athletes, so the queue handed any coach the summary -- "SHADOW upload:
// <file name>", often the child's name -- of cases the case gate refuses
// them. The gate's two branches, in SQL:
//   - the case names athletes (the column, or an athlete document owner):
//     the reader must reach EVERY one of them -- reaching one of two is not
//     authority over a case that discloses both;
//   - it names nobody: only an organization admin (restrictParam null) or
//     the account that filed it, and only for a scope that admits unscoped
//     rows at all (guardians and athletes never see an unattributed case).
// Built per call from the parameter numbers so the items and count queries
// carry the identical boundary.
function intakeCaseReaderScopeSql(restrictParam: number, unscopedParam: number, actorParam: number): string {
  return `(
         $${restrictParam}::text[] is null
         or (
           cardinality(subj.athlete_ids) > 0
           and subj.athlete_ids <@ $${restrictParam}::text[]
         )
         or (
           cardinality(subj.athlete_ids) = 0
           and $${unscopedParam}::boolean
           and c.submitted_by_account_id = $${actorParam}::text
         )
       )`;
}

// Every athlete an intake case names, from both places resolveIntakeCaseAuthority
// reads (intake.ts): the column and the athlete owners of its documents.
const INTAKE_CASE_SUBJECTS_JOIN = `left join lateral (
       select coalesce(array_agg(distinct subject.athlete_id), '{}'::text[]) as athlete_ids
       from (
         select c.primary_athlete_id as athlete_id
         where c.primary_athlete_id is not null
         union
         select owner_doc.owner_entity_id
         from pilot.intake_documents owner_doc
         where owner_doc.organization_id = c.organization_id
           and owner_doc.intake_case_id = c.intake_case_id
           and owner_doc.owner_entity_type = 'athlete'
           and owner_doc.owner_entity_id is not null
       ) subject
     ) subj on true`;

export async function getShadowReviewProjection(
  context: ShadowReadContext,
  filters: ShadowListFilters = {},
): Promise<{ items: ShadowReviewProjectionItem[]; total: number }> {
  const limit = clampLimit(filters.limit, 25, 200);
  const offset = clampOffset(filters.offset);
  const scope = await resolveAthleteScope(context);

  const items = await query<ShadowReviewProjectionItem>(
    `select
       c.intake_case_id,
       case
         when se.event_name ilike '%PROMOTED%' then 'promoted'
         when se.event_name ilike '%APPROVED%' then 'approved'
         when se.event_name ilike '%REJECTED%' then 'rejected'
         when se.event_name is not null then 'pending_review'
         else c.status
       end as status,
       c.summary,
       c.primary_athlete_id,
       c.created_at,
       greatest(c.updated_at, coalesce(se.created_at, c.updated_at)) as updated_at,
       coalesce(dc.document_count, 0)::int as document_count,
       se.event_name as shadow_event_name,
       se.created_at as shadow_event_at
     from pilot.intake_cases c
     left join lateral (
       select event_name, created_at
       from pilot.shadow_events e
       where e.organization_id = c.organization_id
         and (
           (e.entity_type = 'intake_case' and e.entity_id = c.intake_case_id::text)
           or e.payload->>'intake_case_id' = c.intake_case_id::text
         )
       order by e.created_at desc
       limit 1
     ) se on true
     left join lateral (
       select count(*)::int as document_count
       from pilot.intake_documents d
       where d.organization_id = c.organization_id
         and d.intake_case_id = c.intake_case_id
     ) dc on true
     ${INTAKE_CASE_SUBJECTS_JOIN}
     where c.organization_id = $1
       and ($2::text is null or c.intake_case_id::text = $2)
       and ($3::text is null or c.status = $3)
       -- The case gate's own rule (intakeCaseReaderScopeSql). A case filed
       -- before its athlete record exists stays in the queue for the admin
       -- and for the coach who filed it; it no longer reaches every coach.
       and ${intakeCaseReaderScopeSql(6, 7, 8)}
       -- A deleted athlete's case leaves the queue; a case with no athlete
       -- yet stays (intakeCaseAthleteNotDeletedSql).
       and ${intakeCaseAthleteNotDeletedSql()}
     order by coalesce(se.created_at, c.updated_at) desc
     limit $4
     offset $5`,
    [
      context.organizationId,
      filters.entityId?.trim() || filters.correlationId?.trim() || null,
      filters.eventName?.trim() || null,
      limit,
      offset,
      scope.restrictToAthleteIds,
      scope.includeUnscopedRows,
      context.actorAccountId,
    ],
  );

  const totalRows = await query<{ count: string }>(
    `select count(*)::text as count
     from pilot.intake_cases c
     ${INTAKE_CASE_SUBJECTS_JOIN}
     where c.organization_id = $1
       and ($2::text is null or c.intake_case_id::text = $2)
       and ($3::text is null or c.status = $3)
       -- Must stay identical to the items query's boundary above, or the
       -- caller pages through one set of rows against another set's count.
       and ${intakeCaseReaderScopeSql(4, 5, 6)}
       and ${intakeCaseAthleteNotDeletedSql()}`,
    [
      context.organizationId,
      filters.entityId?.trim() || filters.correlationId?.trim() || null,
      filters.eventName?.trim() || null,
      scope.restrictToAthleteIds,
      scope.includeUnscopedRows,
      context.actorAccountId,
    ],
  );

  return {
    items,
    total: Number(totalRows[0]?.count ?? '0'),
  };
}

export async function getShadowKnowledgeProjection(
  context: ShadowReadContext,
  filters: ShadowListFilters = {},
): Promise<ShadowKnowledgeProjectionItem[]> {
  const events = await listShadowEvents(context, {
    ...filters,
    limit: filters.limit ?? 100,
  });

  return events
    .map((event): ShadowKnowledgeProjectionItem | null => {
      const reviewState = toReviewState(event.event_name);
      let type: ShadowKnowledgeProjectionItem['type'];

      // An approved or promoted intake case is still an observation -- a
      // reviewer accepted it, nothing validated it as a lesson. It used to be
      // filed under 'Validated Lesson' on its review state alone. The review
      // outcome travels in review_state, which the page shows as a badge; the
      // Validated Lesson stream stays empty until something real feeds it.
      if (event.event_name.toUpperCase().includes('PATTERN')) {
        type = 'Pattern';
      } else if (event.event_name.toUpperCase().includes('FINDING')) {
        type = 'Finding';
      } else {
        type = 'Observation';
      }

      if (
        !event.event_name.toUpperCase().includes('SHADOW')
        && !event.event_name.toUpperCase().includes('INTAKE')
        && !event.event_name.toUpperCase().includes('AUDIT')
      ) {
        return null;
      }

      return {
        type,
        title: event.event_name,
        source_event_name: event.event_name,
        entity_type: event.entity_type,
        entity_id: event.entity_id,
        review_state: reviewState,
        created_at: event.created_at,
      };
    })
    .filter((item): item is ShadowKnowledgeProjectionItem => item !== null);
}

export async function getShadowResearchProjection(
  context: ShadowReadContext,
  filters: ShadowListFilters = {},
): Promise<ShadowResearchProjectionItem[]> {
  const events = await listShadowEvents(context, {
    ...filters,
    limit: filters.limit ?? 100,
  });

  return events
    .map((event): ShadowResearchProjectionItem | null => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const eventName = event.event_name.toUpperCase();
      // 'GAP' catches SHADOW_LIBRARY_CLAIM_GAP_DETECTED (the Library Q&A
      // chat's auto-logged knowledge gap) and SHADOW_LIBRARY_CAPABILITY_GAP_DETECTED --
      // neither contains INTAKE/EVIDENCE/RESEARCH/UPLOAD, so both silently
      // fell out of this panel despite each one opening a research
      // requirement that's already visible in Operational Research
      // Requirements below, on this same page.
      const isResearchLike =
        eventName.includes('INTAKE')
        || eventName.includes('EVIDENCE')
        || eventName.includes('RESEARCH')
        || eventName.includes('UPLOAD')
        || eventName.includes('GAP');

      if (!isResearchLike) {
        return null;
      }

      return {
        event_id: event.shadow_event_id,
        requirement: typeof payload.research_requirement === 'string' ? payload.research_requirement : null,
        knowledge_gap: typeof payload.knowledge_gap === 'string' ? payload.knowledge_gap : null,
        evidence_label: typeof payload.classification === 'string' ? payload.classification : null,
        source_status: typeof payload.source_status === 'string' ? payload.source_status : 'observed',
        review_state: toReviewState(event.event_name),
        source_event_name: event.event_name,
        created_at: event.created_at,
      };
    })
    .filter((item): item is ShadowResearchProjectionItem => item !== null);
}

/**
 * Human labels for pain-report events in the mixed SHADOW observation feed.
 *
 * Without this, the feed renders the bare event name
 * (SHADOW_ATHLETE_PAIN_REPORT_PENDING_REVIEW) with no name, severity, or body
 * location -- see docs/WORK_QUEUE.md's description of this exact gap. The
 * dedicated "Athlete Pain Reports" panel elsewhere on the coach's screen
 * already resolves the athlete's name via pilot.athletes, so this mirrors
 * that lookup for the events that need it rather than joining on every event
 * in the feed regardless of type.
 */
async function resolveAthleteNames(
  organizationId: string,
  athleteIds: readonly string[],
): Promise<Map<string, string>> {
  if (athleteIds.length === 0) {
    return new Map();
  }

  const rows = await query<{ athlete_id: string; full_name: string | null }>(
    `select athlete_id, full_name
     from pilot.athletes
     where organization_id = $1
       and athlete_id = any($2::text[])`,
    [organizationId, [...athleteIds]],
  );

  const names = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.full_name === 'string' && row.full_name.trim().length > 0) {
      names.set(row.athlete_id, row.full_name.trim());
    }
  }
  return names;
}

function painReportPayloadText(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function describePainReportEvent(event: ShadowEventRow, athleteNames: ReadonlyMap<string, string>): string {
  const payload = event.payload ?? {};
  const athleteId = painReportPayloadText(payload, 'athlete_id') ?? event.entity_id;
  const athleteName = athleteNames.get(athleteId) ?? `Athlete ${athleteId}`;
  const location = painReportPayloadText(payload, 'location');
  const painType = painReportPayloadText(payload, 'pain_type');
  // Number.isFinite, not just typeof -- matches the guard toCoachPainReport
  // (painReportAlert.ts) already uses on this same field. The current sole
  // writer (alertCoachToPainReport -> emitShadowEvent's JSON.stringify)
  // cannot produce NaN/Infinity here, but jsonb accepts a raw insert or
  // backfill that bypasses that normalization, and node-postgres parses an
  // out-of-range numeric literal (e.g. 1e400) to Infinity on the way back.
  const severity = typeof payload.severity_1_10 === 'number' && Number.isFinite(payload.severity_1_10)
    ? payload.severity_1_10
    : null;

  const where = location ? ` at ${location}` : '';
  const type = painType ? ` (${painType})` : '';
  const score = severity === null ? '' : `, severity ${severity}/10`;

  /* WHO REPORTED IT, on the label a coach reads in the observation feed.
     Preferring the payload over actor_role because the payload carries the
     classification computed at write time, while actor_role is a raw role
     string; both are consulted so an event written before reporter_role was
     persisted still resolves from its actor, and a truly unestablished one
     resolves to 'unknown' rather than to the athlete.

     Only a non-athlete reporter is named. An athlete's own report reads as it
     always has, because that is the sentence that was true for it. */
  const stored = painReportPayloadText(payload, 'reporter_role');
  const reporter = stored !== null
    ? readPainReporter(stored)
    : classifyPainReporter(event.actor_role);
  const by = reporter === 'athlete' ? ''
    : reporter === 'coach' ? ' (entered by a coach)'
    : reporter === 'staff_admin' ? ' (entered by staff)'
    : ' (reporter not recorded)';

  return `Pain report: ${athleteName}${where}${type}${score}${by}, pending review`;
}

export async function getShadowObservationProjection(
  context: ShadowReadContext,
  filters: ShadowListFilters = {},
): Promise<ShadowObservationProjectionItem[]> {
  const events = await listShadowEvents(context, {
    ...filters,
    limit: Math.floor((filters.limit ?? 60) / 2),
  });

  const telemetry = await listShadowTelemetry(context, {
    ...filters,
    limit: Math.floor((filters.limit ?? 60) / 2),
  });

  const painReportAthleteIds = events
    .filter((event) => event.event_name === PAIN_REPORT_PENDING_REVIEW_EVENT_NAME)
    .map((event) => painReportPayloadText(event.payload ?? {}, 'athlete_id') ?? event.entity_id);
  const athleteNames = await resolveAthleteNames(context.organizationId, [...new Set(painReportAthleteIds)]);

  const observationEvents = events.map<ShadowObservationProjectionItem>((event) => ({
    id: `event-${event.shadow_event_id}`,
    source: 'event',
    label: event.event_name === PAIN_REPORT_PENDING_REVIEW_EVENT_NAME
      ? describePainReportEvent(event, athleteNames)
      : event.event_name,
    entity_type: event.entity_type,
    entity_id:
      event.entity_id
      || (typeof event.payload?.athlete_id === 'string' ? event.payload.athlete_id : null)
      || (typeof event.payload?.entity_id === 'string' ? event.payload.entity_id : null),
    review_state: toReviewState(event.event_name),
    created_at: event.created_at,
  }));

  const observationTelemetry = telemetry.map<ShadowObservationProjectionItem>((metric) => ({
    id: `telemetry-${metric.shadow_telemetry_event_id}`,
    source: 'telemetry',
    label: metric.metric_name,
    entity_type: typeof metric.dimensions.entity_type === 'string' ? metric.dimensions.entity_type : null,
    entity_id: typeof metric.dimensions.entity_id === 'string' ? metric.dimensions.entity_id : null,
    review_state: 'unknown',
    created_at: metric.created_at,
  }));

  return [...observationEvents, ...observationTelemetry]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, clampLimit(filters.limit, 60, 200));
}

import { athleteIdsForCoach, isOrganizationAdminRole } from './access';
import type { PilotRole } from './contracts';
import { query } from './db';
import { guardianAthleteIds } from './guardianAccess';
import { PAIN_REPORT_PENDING_REVIEW_EVENT_NAME } from './formulas/painReportAlert';

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

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Number(value)));
}

function clampOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Number(value));
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
    return { restrictToAthleteIds: [context.athleteId ?? '__unbound_athlete__'], includeUnscopedRows: false };
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

function sanitizeEventPayload(payload: Record<string, unknown>, role: PilotRole): Record<string, unknown> {
  if (roleCanViewSensitivePayload(role)) {
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
     from pilot.shadow_events
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
       and (
         (
           $9::text[] is null
           or (entity_type = 'athlete' and entity_id = any($9::text[]))
           or payload->>'athlete_id' = any($9::text[])
           or payload->>'owner_entity_id' = any($9::text[])
         )
         or ($10::boolean and entity_type <> 'athlete' and payload->>'athlete_id' is null and payload->>'owner_entity_id' is null)
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
    payload: sanitizeEventPayload((row.payload ?? {}) as Record<string, unknown>, context.actorRole),
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
     where c.organization_id = $1
       and ($2::text is null or c.intake_case_id::text = $2)
       and ($3::text is null or c.status = $3)
       -- Same two disjuncts again. Without the second one, scoping a coach
       -- here would drop every intake case that has no primary athlete yet --
       -- a case filed before the athlete record exists is precisely what a
       -- review queue is for -- so the fix to one leak would have emptied the
       -- queue it protects.
       and (
         $6::text[] is null
         or c.primary_athlete_id = any($6::text[])
         or ($7::boolean and c.primary_athlete_id is null)
       )
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
    ],
  );

  const totalRows = await query<{ count: string }>(
    `select count(*)::text as count
     from pilot.intake_cases c
     where c.organization_id = $1
       and ($2::text is null or c.intake_case_id::text = $2)
       and ($3::text is null or c.status = $3)
       -- Must stay identical to the items query's boundary above, or the
       -- caller pages through one set of rows against another set's count.
       and (
         $4::text[] is null
         or c.primary_athlete_id = any($4::text[])
         or ($5::boolean and c.primary_athlete_id is null)
       )`,
    [
      context.organizationId,
      filters.entityId?.trim() || filters.correlationId?.trim() || null,
      filters.eventName?.trim() || null,
      scope.restrictToAthleteIds,
      scope.includeUnscopedRows,
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

      if (event.event_name.toUpperCase().includes('PATTERN')) {
        type = 'Pattern';
      } else if (event.event_name.toUpperCase().includes('FINDING')) {
        type = 'Finding';
      } else if (reviewState === 'approved' || reviewState === 'promoted') {
        type = 'Validated Lesson';
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

  return `Pain report: ${athleteName}${where}${type}${score}, pending review`;
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

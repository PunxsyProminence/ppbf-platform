import type { PilotRole } from './contracts';
import { query } from './db';

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

interface AthleteScope {
  // Non-null: restrict rows to only these athlete IDs (parent: their linked
  // athletes; athlete: themselves). Null: no athlete-based restriction.
  restrictToAthleteIds: string[] | null;
  // True: strip out any row tied to a specific athlete entirely (volunteer --
  // pilot.access.ts's assertActorCanAccessAthlete denies volunteers athlete
  // access outright, so read-models must not leak athlete-scoped rows either).
  excludeAthleteScoped: boolean;
}

// Mirrors the guardian-link authorization check in
// assertActorCanAccessAthlete (access.ts) so a parent's SHADOW read-model
// access matches their actual linked-athlete scope everywhere in the app.
async function resolveAthleteScope(context: ShadowReadContext): Promise<AthleteScope> {
  if (context.actorRole === 'athlete') {
    return { restrictToAthleteIds: [context.athleteId ?? '__unbound_athlete__'], excludeAthleteScoped: false };
  }

  if (context.actorRole === 'parent') {
    const rows = await query<{ athlete_id: string }>(
      `select gl.athlete_id
       from pilot.guardian_links gl
       where gl.organization_id = $1
         and gl.parent_id in (
           select parent_id from pilot.parents where organization_id = $1 and account_id = $2
         )`,
      [context.organizationId, context.actorAccountId],
    );
    const athleteIds = rows.map((row) => row.athlete_id);
    return { restrictToAthleteIds: athleteIds.length > 0 ? athleteIds : ['__unbound_athlete__'], excludeAthleteScoped: false };
  }

  if (context.actorRole === 'volunteer') {
    return { restrictToAthleteIds: null, excludeAthleteScoped: true };
  }

  return { restrictToAthleteIds: null, excludeAthleteScoped: false };
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
       and (
         ($9::text[] is null and not $10::boolean)
         or ($9::text[] is not null and (
           (entity_type = 'athlete' and entity_id = any($9::text[]))
           or payload->>'athlete_id' = any($9::text[])
           or payload->>'owner_entity_id' = any($9::text[])
         ))
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
      scope.excludeAthleteScoped,
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
       and (
         ($7::text[] is null and not $8::boolean)
         or ($7::text[] is not null and (
           dimensions->>'athlete_id' = any($7::text[])
           or dimensions->>'entity_id' = any($7::text[])
           or dimensions->>'owner_entity_id' = any($7::text[])
         ))
         or ($8::boolean and dimensions->>'athlete_id' is null)
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
      scope.excludeAthleteScoped,
    ],
  );

  return rows.map((row) => ({
    ...row,
    dimensions: sanitizeDimensions((row.dimensions ?? {}) as Record<string, unknown>, context.actorRole),
  }));
}

export async function listShadowAuthorityChecks(context: ShadowReadContext, filters: ShadowListFilters = {}): Promise<ShadowAuthorityCheckRow[]> {
  const limit = clampLimit(filters.limit, 25, 200);
  const offset = clampOffset(filters.offset);

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
       and ($6::text[] is null or c.primary_athlete_id = any($6::text[]))
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
    ],
  );

  const totalRows = await query<{ count: string }>(
    `select count(*)::text as count
     from pilot.intake_cases c
     where c.organization_id = $1
       and ($2::text is null or c.intake_case_id::text = $2)
       and ($3::text is null or c.status = $3)
       and ($4::text[] is null or c.primary_athlete_id = any($4::text[]))`,
    [
      context.organizationId,
      filters.entityId?.trim() || filters.correlationId?.trim() || null,
      filters.eventName?.trim() || null,
      scope.restrictToAthleteIds,
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
      const isResearchLike =
        eventName.includes('INTAKE')
        || eventName.includes('EVIDENCE')
        || eventName.includes('RESEARCH')
        || eventName.includes('UPLOAD');

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

  const observationEvents = events.map<ShadowObservationProjectionItem>((event) => ({
    id: `event-${event.shadow_event_id}`,
    source: 'event',
    label: event.event_name,
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

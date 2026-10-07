import { query } from './db';

/**
 * Which athlete an audit row is ABOUT, read from the record the row names in
 * entity_id rather than from whatever the writer happened to copy into
 * details.
 *
 * WHY. audit/get scopes a coach's rows to the athletes that coach can reach,
 * and it learned who a row names by reading details. Many writers name the
 * child only through entity_id -- an intervention execution's outcome update
 * writes {outcome}, a coach review writes {session_id}, a mentorship end
 * writes {ended_on}, a coverage revoke writes {action: 'revoke'} -- so #1289
 * (CL-A13) made those rows fail CLOSED for coaches: hidden from every coach,
 * including the one assigned to the child. That was the safe half of the
 * fix; this is the other half. Each type below resolves entity_id to the
 * owning athlete through the entity's own table, so the assigned coach sees
 * their athlete's row again and still never sees another coach's.
 *
 * ONE TABLE, TWO READERS. The route's "athlete-owned" set is the key set of
 * this table (AUDIT_ATHLETE_OWNED_ENTITY_TYPES), so a type cannot be owned
 * without a resolver or resolved without being owned. A type that is not
 * here (announcement, drill, floor_plan, ...) is gym-wide and is never
 * resolved.
 *
 * FAIL CLOSED stays. An entity_id with no row (deleted, mistyped, another
 * organization's), or whose athlete column is null (video_sessions on
 * teaching footage), resolves to nothing -- the route then has only what
 * details name to gate on, and when that is nobody too the row is hidden
 * from coaches, as #1289 left it. Nothing
 * here decides access: the ids it returns go through accessibleAthleteIds,
 * which is where the assigned-coach, coverage, deleted-athlete and
 * platform_owner rules live.
 *
 * Every statement is bound to the caller's organization ($1), and composite
 * keys are joined on both halves because the same session_id or execution_id
 * can name a different child in another gym. Each statement returns
 * (entity_id text, athlete_id text|null); a type that names two athletes
 * (mentorship) returns one row per athlete, and the route requires the coach
 * to reach every one of them.
 *
 * Writer sites, so the entity_id shape here can be checked against them:
 *   athlete_milestone            achievements/milestones/route.ts   `${athleteId}:${milestone_key}`
 *   athlete_program              achievements/milestones/route.ts   athleteId
 *   coach_coverage               admin/coach-coverage/route.ts      coverage_id (uuid)
 *   coach_note                   parent-tasks/route.ts              note_id (uuid, pilot.coach_observations)
 *   coach_review                 coach-reviews/route.ts             review_id
 *   external_competition_entry   operations/external-competition/entries/route.ts  entry_id
 *   goal                         goals/route.ts, goals/update, goals/personal      goal_id
 *   intervention_evidence_link   coach/intervention-review/route.ts link_id
 *   intervention_execution       coach/intervention-executions/route.ts            execution_id
 *   intervention_outcome_review  coach/intervention-review/route.ts review_id
 *   mentorship                   achievements/mentorships/route.ts  mentorship_id
 *   one_percent_nomination       coach/one-percent-club/route.ts    nomination_id
 *   recognition                  achievements/recognition/route.ts  recognition_id
 *   scheduler_coaching_request   scheduler/route.ts                 request_id
 *   session                      sessions/route.ts, sessions/update session_id
 *   video_session                video/review-link, scan-review, [videoId]/archive, release  video_session_id
 *   wrestling_league_roster_entry operations/wrestling-league/roster/route.ts      entry_id
 */
const OWNER_LOOKUP_SQL: Readonly<Record<string, string>> = {
  athlete_milestone: `select athlete_id || ':' || milestone_key as entity_id, athlete_id
     from pilot.athlete_milestones
     where organization_id = $1 and athlete_id || ':' || milestone_key = any($2::text[])`,
  athlete_program: `select athlete_id as entity_id, athlete_id
     from pilot.athletes
     where organization_id = $1 and athlete_id = any($2::text[])`,
  coach_coverage: `select coverage_id::text as entity_id, athlete_id
     from pilot.coach_coverage
     where organization_id = $1 and coverage_id::text = any($2::text[])`,
  coach_note: `select note_id::text as entity_id, athlete_id
     from pilot.coach_observations
     where organization_id = $1 and note_id::text = any($2::text[])`,
  coach_review: `select r.review_id as entity_id, s.athlete_id
     from pilot.coach_reviews r
     join pilot.sessions s
       on s.organization_id = r.organization_id and s.session_id = r.session_id
     where r.organization_id = $1 and r.review_id = any($2::text[])`,
  external_competition_entry: `select entry_id as entity_id, athlete_id
     from pilot.external_competition_entries
     where organization_id = $1 and entry_id = any($2::text[])`,
  goal: `select goal_id as entity_id, athlete_id
     from pilot.goals
     where organization_id = $1 and goal_id = any($2::text[])`,
  intervention_evidence_link: `select l.link_id as entity_id, e.athlete_id
     from pilot.intervention_evidence_links l
     join pilot.intervention_executions e
       on e.organization_id = l.organization_id and e.execution_id = l.execution_id
     where l.organization_id = $1 and l.link_id = any($2::text[])`,
  intervention_execution: `select execution_id as entity_id, athlete_id
     from pilot.intervention_executions
     where organization_id = $1 and execution_id = any($2::text[])`,
  intervention_outcome_review: `select r.review_id as entity_id, e.athlete_id
     from pilot.intervention_outcome_reviews r
     join pilot.intervention_executions e
       on e.organization_id = r.organization_id and e.execution_id = r.execution_id
     where r.organization_id = $1 and r.review_id = any($2::text[])`,
  mentorship: `select mentorship_id as entity_id, mentor_athlete_id as athlete_id
     from pilot.mentorships
     where organization_id = $1 and mentorship_id = any($2::text[])
     union all
     select mentorship_id as entity_id, mentee_athlete_id as athlete_id
     from pilot.mentorships
     where organization_id = $1 and mentorship_id = any($2::text[])`,
  one_percent_nomination: `select nomination_id as entity_id, athlete_id
     from pilot.one_percent_nominations
     where organization_id = $1 and nomination_id = any($2::text[])`,
  recognition: `select recognition_id as entity_id, athlete_id
     from pilot.recognitions
     where organization_id = $1 and recognition_id = any($2::text[])`,
  scheduler_coaching_request: `select request_id as entity_id, athlete_id
     from pilot.scheduler_coaching_requests
     where organization_id = $1 and request_id = any($2::text[])`,
  session: `select session_id as entity_id, athlete_id
     from pilot.sessions
     where organization_id = $1 and session_id = any($2::text[])`,
  video_session: `select video_session_id as entity_id, athlete_id
     from pilot.video_sessions
     where organization_id = $1 and video_session_id = any($2::text[])`,
  wrestling_league_roster_entry: `select entry_id as entity_id, athlete_id
     from pilot.wrestling_league_roster_entries
     where organization_id = $1 and entry_id = any($2::text[])`,
};

/** The audit entity types whose every record is about an athlete. */
export const AUDIT_ATHLETE_OWNED_ENTITY_TYPES: ReadonlySet<string> = new Set(Object.keys(OWNER_LOOKUP_SQL));

export interface AuditEntityRef {
  entity_type: string;
  entity_id: string;
}

/** entity_type -> entity_id -> the athlete ids that entity is about (never empty). */
export type AuditEntityOwners = ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;

/**
 * Resolves the owning athlete(s) of every athlete-owned ref, one statement per
 * entity type present. Refs of a type that is not athlete-owned are ignored.
 * A ref that resolves to no live athlete is simply absent from the result.
 */
export async function resolveAuditEntityOwners(
  organizationId: string,
  refs: readonly AuditEntityRef[],
): Promise<AuditEntityOwners> {
  const idsByType = new Map<string, Set<string>>();
  for (const ref of refs) {
    if (!AUDIT_ATHLETE_OWNED_ENTITY_TYPES.has(ref.entity_type)) continue;
    if (typeof ref.entity_id !== 'string' || ref.entity_id === '') continue;
    let ids = idsByType.get(ref.entity_type);
    if (!ids) {
      ids = new Set();
      idsByType.set(ref.entity_type, ids);
    }
    ids.add(ref.entity_id);
  }

  // One statement per type, issued together: a page of up to 500 rows can
  // span every type, and 17 sequential round trips is a wait the reader
  // would feel.
  const lookups = await Promise.all(
    [...idsByType].map(async ([entityType, ids]) => {
      const rows = await query<{ entity_id: string; athlete_id: string | null }>(
        OWNER_LOOKUP_SQL[entityType],
        [organizationId, [...ids]],
      );
      return [entityType, rows] as const;
    }),
  );

  const result = new Map<string, Map<string, string[]>>();
  for (const [entityType, rows] of lookups) {
    const byId = new Map<string, string[]>();
    for (const row of rows) {
      // A null athlete (teaching footage) is "about nobody we can name", which
      // for the coach gate means unresolved, not org-wide.
      if (typeof row.athlete_id !== 'string' || row.athlete_id === '') continue;
      const owners = byId.get(row.entity_id) ?? [];
      if (!owners.includes(row.athlete_id)) owners.push(row.athlete_id);
      byId.set(row.entity_id, owners);
    }
    result.set(entityType, byId);
  }
  return result;
}

/** The athletes a resolved ref is about, or null when it did not resolve. */
export function auditEntityOwnersOf(
  owners: AuditEntityOwners,
  entityType: string,
  entityId: string,
): readonly string[] | null {
  const found = owners.get(entityType)?.get(entityId);
  return found && found.length > 0 ? found : null;
}

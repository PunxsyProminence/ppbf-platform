import { NextResponse, type NextRequest } from 'next/server';

import { accessibleAthleteIds, requireRole } from '@/src/server/pilot/access';
import { query } from '@/src/server/pilot/db';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// A coach's view of the org-wide audit trace is an ALLOW-list, not a
// deny-list. This route shipped excluding exactly one type (training_hold),
// and the 2026-08-25 audit found the rot that shape guarantees: by then
// parent_barrier_report, guardian_media_consent, guardian_link,
// athlete_check_in, intake_case and intake_document had all joined the
// vocabulary, and any coach could enumerate them org-wide for children they
// never coach. A deny-list must be re-curated every time a writer adds a
// type; this list fails CLOSED instead -- a new entity type is invisible to
// coaches until someone deliberately adds it here, under review.
//
// What belongs here: training-floor operational records. What never does:
// guardian/consent, intake, medical, account/credential, payment, platform,
// board, or safety-scoped types -- each of those has a dedicated route whose
// own gate decides what a coach may see of it (training-holds/route.ts is
// the model), and this general-purpose reader must not become the back door
// around any of them.
//
// The type allow-list is necessary but NOT sufficient: several allow-listed
// operational types (goal, session, intervention_*, recognition, ...) still
// carry an athlete identity in details.athlete_id, so a bare type gate would
// let a coach enumerate WHICH unrelated children had that activity -- the
// platform's coach boundary is relationship-scoped, and this general reader
// must honour it. So for a coach, rows that name an athlete are additionally
// constrained to the athletes that coach can actually reach
// (accessibleAthleteIds, the same central relationship gate the intervention
// reads use); org-wide rows that name no athlete are kept. Org admins keep
// organization-wide reach.
const COACH_ALLOWED_ENTITY_TYPES = new Set([
  'announcement',
  'athlete_milestone',
  'athlete_program',
  'behavior_standard',
  'coach_coverage',
  'coach_note',
  'coach_review',
  'drill',
  'external_competition_entry',
  'floor_plan',
  'goal',
  'intervention_evidence_link',
  'intervention_execution',
  'intervention_outcome_review',
  'intervention_protocol',
  'mentorship',
  'one_percent_nomination',
  'program_phase',
  'rabbit_hole',
  'recognition',
  'scheduler_coaching_request',
  'session',
  'video_session',
  'wrestling_league_roster_entry',
]);

/**
 * A present-but-non-string filter is a bad request, not a server fault:
 * body.x?.trim() throws a TypeError on a number/object and jsonError would
 * report that as an opaque 500. Validate to a 400 (ValidationError) instead,
 * and treat empty/whitespace as "no filter".
 */
function optionalFilter(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ValidationError(`Unsupported ${field}: must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach']);

    const body = (await request.json()) as Record<string, unknown>;
    const entityType = optionalFilter(body.entity_type, 'entity_type');
    const entityId = optionalFilter(body.entity_id, 'entity_id');
    const isCoach = principal.role === 'coach';

    if (isCoach && entityType && !COACH_ALLOWED_ENTITY_TYPES.has(entityType)) {
      throw new Error('Forbidden: role not allowed to read this entity type');
    }

    const limit = Math.max(1, Math.min(100, Number(body.limit ?? 20)));

    // A coach's rows are athlete-scoped below the type gate, and that filter
    // runs in application code, so fetch a wider window than the requested
    // page and slice back down -- otherwise a coach with a handful of athletes
    // could see almost nothing even when their own athletes have plenty of
    // recent activity. An org admin needs no post-filter and takes exactly the
    // page they asked for.
    const fetchLimit = isCoach ? Math.min(500, Math.max(limit * 5, 100)) : limit;

    const rows = await query<{ entity_type: string; details: Record<string, unknown> | null }>(
      `select *
       from pilot.audit_events
       where organization_id = $1
         and ($2::text is null or entity_type = $2)
         and ($3::text is null or entity_id = $3)
         and ($5::boolean is not true or entity_type = any($4::text[]))
       order by created_at desc
       limit $6`,
      [
        principal.organizationId,
        entityType,
        entityId,
        [...COACH_ALLOWED_ENTITY_TYPES],
        isCoach,
        fetchLimit,
      ],
    );

    if (!isCoach) {
      return NextResponse.json({ ok: true, events: rows });
    }

    // Athlete-scope: a row that names an athlete in details.athlete_id is
    // visible only if the coach can reach that athlete; a row that names no
    // athlete is org-wide operational data and is kept. accessibleAthleteIds
    // is the same central relationship gate assertActorCanAccessAthlete uses.
    const namedAthleteIds = rows
      .map((row) => row.details?.athlete_id)
      .filter((id): id is string => typeof id === 'string');
    const reachable = await accessibleAthleteIds(principal, namedAthleteIds);
    const scoped = rows
      .filter((row) => {
        const athleteId = row.details?.athlete_id;
        return typeof athleteId !== 'string' || reachable.has(athleteId);
      })
      .slice(0, limit);

    return NextResponse.json({ ok: true, events: scoped });
  } catch (error) {
    return jsonError(error);
  }
}

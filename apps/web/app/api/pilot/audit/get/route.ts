import { NextResponse, type NextRequest } from 'next/server';

import { accessibleAthleteIds, requireRole } from '@/src/server/pilot/access';
import {
  AUDIT_ATHLETE_OWNED_ENTITY_TYPES,
  auditEntityOwnersOf,
  resolveAuditEntityOwners,
} from '@/src/server/pilot/auditEntityOwners';
import {
  COACH_ALLOWED_AUDIT_ENTITY_TYPES,
  WITHHELD_AUDIT_ENTITY_TYPE_PREFIX,
} from '@/src/server/pilot/auditReadAllowlist';
import { query } from '@/src/server/pilot/db';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Which entity types a coach may read here, and which calibration rows no
// caller may, live in auditReadAllowlist.ts: the SHADOW event feed applies
// the same lists to the audit rows mirrored into pilot.shadow_events, so
// neither reader is the way around the other. Read the reasons there.
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
const COACH_ALLOWED_ENTITY_TYPES = COACH_ALLOWED_AUDIT_ENTITY_TYPES;

// Withheld in the SQL, for every caller, so a page still fills to its limit
// and a filter that names such a type (or one of its entity ids) answers
// exactly as a type with no rows does. The rows themselves are untouched.
const WITHHELD_ENTITY_TYPE_PREFIX = WITHHELD_AUDIT_ENTITY_TYPE_PREFIX;

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

// Allow-listed types whose every record is ABOUT an athlete, even when an
// audit row for it names none. Many writers put the child only in entity_id
// (intervention execution/outcome updates, coach_review {session_id},
// mentorship end, coverage revoke), so "names no athlete" did not mean
// "org-wide" and those rows reached every coach. For a coach, a row of one of
// these types is gated on the athlete its ENTITY is about, resolved from
// entity_id through the entity's own table (auditEntityOwners.ts), in union
// with whatever details name. A row whose owner cannot be resolved -- no such
// record, another gym's id, teaching footage with no athlete -- is gated on
// the athletes details name alone, and when details name nobody either it
// stays hidden: it fails CLOSED. Types left out (announcement, behavior_standard, drill,
// floor_plan, intervention_protocol, program_phase, rabbit_hole) are gym-wide.
// The set is the resolver table's key set, so a type cannot be owned here
// without a resolver there.
const ATHLETE_OWNED_ENTITY_TYPES = AUDIT_ATHLETE_OWNED_ENTITY_TYPES;

// Every athlete a details blob names, under ANY athlete-named key, at any
// depth. Reading details.athlete_id alone let mentorship rows -- which carry
// mentor_athlete_id / mentee_athlete_id and no athlete_id -- count as naming
// nobody and reach every coach (CL-A13). The key test is the one the SHADOW
// read models use (shadowReadModels.ts): athlete_id, or any key matching
// athlete...(_id|Id); plus athlete...(_ids|Ids) arrays of ids.
const ATHLETE_ID_KEY = /[Aa]thlete\w*(_id|Id)$/;
const ATHLETE_IDS_KEY = /[Aa]thlete\w*(_ids|Ids)$/;

function athleteIdsNamedIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) athleteIdsNamedIn(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && child !== '' && ATHLETE_ID_KEY.test(key)) {
        found.push(child);
      } else if (Array.isArray(child) && ATHLETE_IDS_KEY.test(key)) {
        for (const id of child) if (typeof id === 'string' && id !== '') found.push(id);
      } else {
        athleteIdsNamedIn(child, found);
      }
    }
  }
  return found;
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

    const rows = await query<{ entity_type: string; entity_id: string; details: Record<string, unknown> | null }>(
      `select *
       from pilot.audit_events
       where organization_id = $1
         and ($2::text is null or entity_type = $2)
         and ($3::text is null or entity_id = $3)
         and ($5::boolean is not true or entity_type = any($4::text[]))
         and left(entity_type, length($7::text)) <> $7::text
       order by created_at desc
       limit $6`,
      [
        principal.organizationId,
        entityType,
        entityId,
        [...COACH_ALLOWED_ENTITY_TYPES],
        isCoach,
        fetchLimit,
        WITHHELD_ENTITY_TYPE_PREFIX,
      ],
    );

    if (!isCoach) {
      return NextResponse.json({ ok: true, events: rows });
    }

    // Athlete-scope: a row is visible only if the coach can reach EVERY
    // athlete it is about -- the ones details name AND, for an athlete-owned
    // type, the one(s) the entity in entity_id belongs to. A row about nobody
    // is org-wide operational data and is kept, unless its type is athlete-
    // owned, in which case "nobody" means "unresolved" and it is hidden.
    // accessibleAthleteIds is the same central relationship gate
    // assertActorCanAccessAthlete uses.
    const owners = await resolveAuditEntityOwners(
      principal.organizationId,
      rows.filter((row) => ATHLETE_OWNED_ENTITY_TYPES.has(row.entity_type)),
    );
    const aboutByRow = rows.map((row) => {
      const named = athleteIdsNamedIn(row.details);
      const owned = auditEntityOwnersOf(owners, row.entity_type, row.entity_id) ?? [];
      return [...new Set([...named, ...owned])];
    });
    const reachable = await accessibleAthleteIds(principal, [...new Set(aboutByRow.flat())]);
    const scoped = rows
      .filter((row, index) => {
        const about = aboutByRow[index];
        if (about.length === 0) return !ATHLETE_OWNED_ENTITY_TYPES.has(row.entity_type);
        return about.every((id) => reachable.has(id));
      })
      .slice(0, limit);

    return NextResponse.json({ ok: true, events: scoped });
  } catch (error) {
    return jsonError(error);
  }
}

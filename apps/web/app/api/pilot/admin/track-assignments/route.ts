import { NextResponse, type NextRequest } from 'next/server';

import { allTrackIds, type TrackID } from '@/components/trackAssignments';
import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { query, queryOne, withTransaction } from '@/src/server/pilot/db';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// The gym's own admins only. A track is set per athlete of one gym, which is
// gym work; platform_owner is refused on both verbs (OD-2026-10-02-015 D3;
// OD-2026-10-08-003 R2).
const TRACK_ADMIN_ROLES = ['organization_admin', 'admin'] as const;

// The map is stored whole as jsonb, so its size is whatever the client sends.
const MAX_ASSIGNED_ATHLETES = 2000;
const MAX_ATHLETE_ID_LENGTH = 200;

type Assignments = Record<string, TrackID[]>;

interface TrackChange {
  athlete_id: string;
  from: string[] | null;
  to: string[] | null;
}

/**
 * A map with no prototype. The keys here are whatever a client or an old row
 * supplied, and on an ordinary object `map['__proto__'] = tracks` sets the
 * prototype instead of a key: the entry vanishes, the athlete check never sees
 * it, and the rest is saved as if nothing was wrong. Likewise a stored key
 * named `constructor` would read back as a function. With no prototype every
 * key is just a key.
 */
function emptyMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** What is on the row, read leniently: it may predate the checks POST now makes. */
function storedAssignments(value: unknown): Record<string, string[]> {
  const result = emptyMap<string[]>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return result;
  }

  for (const [key, rawTracks] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(rawTracks)) {
      result[key] = rawTracks.filter((item): item is string => typeof item === 'string');
    }
  }
  return result;
}

/**
 * What a client asks to store, read strictly. Nothing is dropped or defaulted:
 * a map that is saved minus the rows that were wrong reads as saved, and the
 * admin would never learn which athletes it did not take.
 */
function parseAssignments(value: unknown): Assignments {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('Unsupported assignments: expected an object of athlete id to track ids');
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ASSIGNED_ATHLETES) {
    throw new ValidationError(`Unsupported assignments: at most ${MAX_ASSIGNED_ATHLETES} athletes`);
  }

  const result: Assignments = emptyMap<TrackID[]>();
  for (const [athleteId, rawTracks] of entries) {
    if (!athleteId.trim() || athleteId !== athleteId.trim()) {
      throw new ValidationError('Unsupported assignments: an athlete id is blank or padded');
    }
    // A NUL cannot be sent to Postgres as text (SQLSTATE 22021); refused here
    // it is the caller's 400, not a 500 that reads as an outage.
    if (athleteId.length > MAX_ATHLETE_ID_LENGTH || athleteId.includes('\u0000')) {
      throw new ValidationError('Unsupported assignments: an athlete id is too long or has control characters');
    }
    if (!Array.isArray(rawTracks)) {
      throw new ValidationError('Unsupported assignments: each athlete needs a list of track ids');
    }
    const unknownTrack = rawTracks.find(
      (track) => typeof track !== 'string' || !allTrackIds.includes(track as TrackID),
    );
    if (unknownTrack !== undefined) {
      throw new ValidationError('Unsupported assignments: unknown track id');
    }
    result[athleteId] = [...new Set(rawTracks as TrackID[])];
  }
  return result;
}

/** The ids among `athleteIds` that are athletes of this gym and not deleted. */
async function liveAthleteIds(organizationId: string, athleteIds: string[]): Promise<Set<string>> {
  if (athleteIds.length === 0) {
    return new Set();
  }
  const rows = await query<{ athlete_id: string }>(
    `select athlete_id
       from pilot.athletes
      where organization_id = $1
        and athlete_id = any($2::text[])
        and deleted_at is null`,
    [organizationId, athleteIds],
  );
  return new Set(rows.map((row) => row.athlete_id));
}

function sameTracks(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.length === right.length && left.every((track, index) => track === right[index]);
}

/** One entry per athlete whose tracks differ between the stored map and the new one. */
function trackChanges(from: Record<string, string[]>, to: Record<string, string[]>): TrackChange[] {
  return [...new Set([...Object.keys(from), ...Object.keys(to)])]
    .filter((athleteId) => !sameTracks(from[athleteId], to[athleteId]))
    .sort()
    .map((athleteId) => ({
      athlete_id: athleteId,
      from: from[athleteId] ?? null,
      to: to[athleteId] ?? null,
    }));
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...TRACK_ADMIN_ROLES]);

    const row = await queryOne<{ assignments: unknown }>(
      `select assignments
       from pilot.admin_track_assignments
       where organization_id = $1`,
      [principal.organizationId],
    );

    // Only rows for athletes this gym has today. A row stored before POST
    // checked its keys, or for an athlete deleted since, is not an assignment
    // to anyone (OD-2026-10-07-010 ruling 3: tracks are for real athletes).
    const stored = storedAssignments(row?.assignments);
    const live = await liveAthleteIds(principal.organizationId, Object.keys(stored));
    const assignments = emptyMap<string[]>();
    for (const [athleteId, tracks] of Object.entries(stored)) {
      if (live.has(athleteId)) {
        assignments[athleteId] = tracks;
      }
    }

    return NextResponse.json({ ok: true, assignments });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...TRACK_ADMIN_ROLES]);

    const body = (await request.json().catch(() => null)) as { assignments?: unknown } | null;
    const assignments = parseAssignments(body?.assignments);

    // Every key must be an athlete of the CALLER's gym, alive today. The
    // organization is the principal's; nothing in the body can name another.
    const athleteIds = Object.keys(assignments);
    const live = await liveAthleteIds(principal.organizationId, athleteIds);
    const unknownAthleteIds = athleteIds.filter((athleteId) => !live.has(athleteId));
    if (unknownAthleteIds.length > 0) {
      throw new ValidationError(
        `Unsupported assignments: ${unknownAthleteIds.length} athlete id(s) are not athletes of this gym. Nothing was saved.`,
      );
    }

    // ONE TRANSACTION: the lock, the read of what is there, the write and the
    // audit record. The audit row is written on the same client, so a map
    // that changed always has its record and a failed record leaves the map
    // as it was -- the caller's "not saved" is then true. The lock is per gym,
    // so two admins saving at once are taken one after the other and each
    // one's "from" is the row it actually replaced.
    await withTransaction(async (client) => {
      await client.query(
        `select pg_advisory_xact_lock(hashtext('ppbf.track-assignments:' || $1::text))`,
        [principal.organizationId],
      );
      const previous = await client.query<{ assignments: unknown }>(
        `select assignments
           from pilot.admin_track_assignments
          where organization_id = $1`,
        [principal.organizationId],
      );

      const changes = trackChanges(storedAssignments(previous.rows[0]?.assignments), assignments);
      // The screen saves on load as well as on a click. A save that changes
      // nothing writes nothing and records nothing: no change happened.
      if (changes.length === 0) {
        return;
      }

      await client.query(
        `insert into pilot.admin_track_assignments (
           organization_id,
           assignments,
           updated_by_account_id,
           updated_at
         ) values ($1, $2, $3, now())
         on conflict (organization_id) do update
         set assignments = excluded.assignments,
             updated_by_account_id = excluded.updated_by_account_id,
             updated_at = now()`,
        [principal.organizationId, JSON.stringify(assignments), principal.accountId],
      );

      // Only the athletes whose tracks changed, each with its before and
      // after, and the athlete id as a value rather than a jsonb key.
      await writePilotAuditEvent({
        event_type: 'update',
        actor_account_id: principal.accountId,
        actor_role: principal.role,
        organization_id: principal.organizationId,
        entity_type: 'admin_track_assignments',
        entity_id: principal.organizationId,
        details: { action: 'track_assignments_replaced', changes },
      }, client);
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}

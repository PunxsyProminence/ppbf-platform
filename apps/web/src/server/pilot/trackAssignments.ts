import { allTrackIds, type TrackID } from '@/components/trackAssignments';
import { queryOne } from '@/src/server/pilot/db';

/**
 * The tracks one athlete is on, read from the gym's saved map
 * (pilot.admin_track_assignments: one jsonb row per gym, athlete id to track
 * ids), the same record the admin's Tracks control writes.
 *
 * ONLY THAT ATHLETE'S ENTRY IS SELECTED. `assignments -> $2` picks the one
 * key in the database, so a read made for one athlete never brings the rest
 * of the gym's map into the request.
 *
 * KNOWN TRACK IDS ONLY, in the manifest's order. The row may predate the
 * checks the admin route now makes on a save, so anything that is not a track
 * this app knows is left out rather than shown. No entry, or an entry that is
 * not a list, is no tracks: nothing is defaulted.
 *
 * The caller decides who may ask. This reads whatever athlete it is given.
 */
export async function readAthleteTracks(organizationId: string, athleteId: string): Promise<TrackID[]> {
  const row = await queryOne<{ tracks: unknown }>(
    `select assignments -> $2::text as tracks
       from pilot.admin_track_assignments
      where organization_id = $1`,
    [organizationId, athleteId],
  );

  const tracks = row?.tracks;
  if (!Array.isArray(tracks)) {
    return [];
  }
  return allTrackIds.filter((trackId) => tracks.includes(trackId));
}

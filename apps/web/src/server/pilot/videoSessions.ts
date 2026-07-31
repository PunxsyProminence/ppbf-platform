import { queryOne } from './db';

export interface VideoSessionRecord {
  video_session_id: string;
  organization_id: string;
  athlete_id: string | null;
  // Read by the Film Study executor to fetch the source clip. Never taken
  // from a request: the row is the authority for which blob gets analyzed.
  blob_path: string;
  // Uploads are born 'quarantined' pending scan (#125). Film Study refuses
  // anything that has not reached 'ready', so an unscanned or infected file
  // is never opened by the worker.
  status: string;
}

export async function getVideoSessionById(
  organizationId: string,
  videoSessionId: string,
): Promise<VideoSessionRecord | null> {
  return queryOne<VideoSessionRecord>(
    `select video_session_id, organization_id, athlete_id, blob_path, status
     from pilot.video_sessions
     where organization_id = $1 and video_session_id = $2`,
    [organizationId, videoSessionId],
  );
}

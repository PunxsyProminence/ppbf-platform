import { queryOne } from './db';

export interface VideoSessionRecord {
  video_session_id: string;
  organization_id: string;
  athlete_id: string | null;
}

export async function getVideoSessionById(
  organizationId: string,
  videoSessionId: string,
): Promise<VideoSessionRecord | null> {
  return queryOne<VideoSessionRecord>(
    `select video_session_id, organization_id, athlete_id
     from pilot.video_sessions
     where organization_id = $1 and video_session_id = $2`,
    [organizationId, videoSessionId],
  );
}

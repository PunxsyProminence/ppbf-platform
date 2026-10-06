import { queryOne } from './db';
import { ValidationError } from './errors';
import { listLiveTagSubjects } from './videoClipTags';

/*
 * IS THIS VIDEO OF THIS ATHLETE?
 *
 * A write that files something about one athlete against a video must cite a
 * video of that athlete. The caller's athlete access check clears the athlete
 * named in the body and says nothing about the video, so without this a coach
 * cleared for one child could cite another child's bout (audit CL-A16).
 *
 * "Of the athlete" means (owner ruling, relayed by overwatch 2026-10-06):
 *   - the video's own athlete_id is that athlete, or
 *   - that athlete is a LIVE tag subject of the video (a removed tag no
 *     longer counts).
 * An untagged group video with no athlete_id is of nobody yet, and is refused
 * until someone tags the athlete in it.
 *
 * Missing, another gym's and another child's video all give the same answer,
 * so the refusal is not an existence oracle.
 */
export class VideoNotOfAthleteError extends ValidationError {
  constructor() {
    super(
      'This video is not of that athlete. Tag the athlete in the video first.',
      'VIDEO_NOT_OF_ATHLETE',
    );
  }
}

export async function assertVideoConcernsAthlete(
  organizationId: string,
  videoSessionId: string,
  athleteId: string,
): Promise<void> {
  const video = await queryOne<{ athlete_id: string | null }>(
    `select athlete_id from pilot.video_sessions
      where organization_id = $1 and video_session_id = $2`,
    [organizationId, videoSessionId],
  );
  if (!video) throw new VideoNotOfAthleteError();
  if (video.athlete_id === athleteId) return;

  const subjects = await listLiveTagSubjects(organizationId, videoSessionId);
  if (subjects.some((subject) => subject.athlete_id === athleteId)) return;

  throw new VideoNotOfAthleteError();
}

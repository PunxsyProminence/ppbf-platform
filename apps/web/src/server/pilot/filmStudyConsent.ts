import { NotFoundError } from './errors';
import { assertGuardianMediaConsent } from './guardianConsent';
import { listLiveTagSubjects } from './videoClipTags';
import { assertConsentCoversVideo } from './videoPlaybackConsent';

/*
 * FILM STUDY CONSENT: the one question both ends of Film Study ask -- the
 * request route before it queues, and the worker before it reads the blob.
 *
 * It composes two existing gates rather than writing a third:
 *
 *   1. assertConsentCoversVideo (videoPlaybackConsent.ts, the playback gate):
 *      a withdrawn, photo-only or unreadable consent refuses. Before this,
 *      the video's OWN athlete went through assertGuardianMediaConsent alone,
 *      which tests status === 'signed' and never reads covers_video, so a
 *      photo-only guardian did not stop analysis of their child's video.
 *   2. assertGuardianMediaConsent: Film Study's existing, stricter rule that
 *      every linked guardian has signed. Missing consent refuses here, unlike
 *      playback -- unchanged from before.
 *
 * Applied to the video's own athlete and to every athlete a live tag names
 * on it (owner, 2026-10-03: any tagged athlete's consent block blocks the
 * whole clip). A tag naming a deleted athlete refuses as not-found, the same
 * answer the route gave before.
 *
 * The worker calls this AGAIN at run time because consent can be withdrawn
 * between the request and the job, and a queued job carries no consent of
 * its own -- only the request that was allowed at the time.
 */
export class FilmStudyTaggedAthleteDeletedError extends NotFoundError {
  constructor() {
    super('Video session not found.');
  }
}

export async function assertFilmStudyConsent(
  organizationId: string,
  videoSessionId: string,
  athleteId: string,
): Promise<void> {
  const subjects = await listLiveTagSubjects(organizationId, videoSessionId);
  if (subjects.some((subject) => subject.athlete_deleted)) {
    throw new FilmStudyTaggedAthleteDeletedError();
  }
  const athleteIds = [athleteId, ...subjects.map((subject) => subject.athlete_id)];
  for (const id of new Set(athleteIds)) {
    await assertConsentCoversVideo(organizationId, id);
    await assertGuardianMediaConsent(organizationId, id);
  }
}

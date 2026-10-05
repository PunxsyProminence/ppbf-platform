import { withTransaction } from './db';
import { NotFoundError, PilotError } from './errors';
import {
  assertGuardianMediaConsent,
  GuardianConsentMissingError,
  lockGuardianLinksForAthletes,
  type QueryExecutor,
} from './guardianConsent';
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
 *      which only asks whether every guardian signed and never reads covers_video, so a
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
  client?: QueryExecutor,
): Promise<void> {
  // Passed on only when present, so the pooled reads are called exactly as
  // they were before a client existed.
  const inTx: [] | [QueryExecutor] = client ? [client] : [];
  const subjects = await listLiveTagSubjects(organizationId, videoSessionId, ...inTx);
  if (subjects.some((subject) => subject.athlete_deleted)) {
    throw new FilmStudyTaggedAthleteDeletedError();
  }
  const athleteIds = [...new Set([athleteId, ...subjects.map((subject) => subject.athlete_id)])];
  // Every athlete's guardian links in ONE pass, in the shared order, before
  // the per-athlete reads below (which then re-take rows already held). The
  // loop visits the video's own athlete first, which is not athlete_id order,
  // and a reader holding several athletes' links in its own order can
  // deadlock against the retention purge. Refusal order is unchanged.
  if (client) await lockGuardianLinksForAthletes(client, organizationId, athleteIds, 'share');
  for (const id of athleteIds) {
    await assertConsentCoversVideo(organizationId, id, ...inTx);
    await assertGuardianMediaConsent(organizationId, id, ...inTx);
  }
}

/*
 * CHECK AND WRITE AS ONE TRANSACTION. Given a client, the consent read holds
 * every subject athlete's guardian links FOR SHARE, and withdrawMediaConsent
 * takes FOR UPDATE on the same row before it records a withdrawal. So a
 * withdrawal already in flight is waited for and then read as withdrawn (the
 * write never runs), and one that starts after the check waits until the
 * write has committed. A proposal never lands after a withdrawal the check
 * missed.
 */
export async function writeUnderFilmStudyConsent<T>(
  organizationId: string,
  videoSessionId: string,
  athleteId: string,
  write: (client: QueryExecutor) => Promise<T>,
): Promise<T> {
  return withTransaction(async (client) => {
    await assertFilmStudyConsent(organizationId, videoSessionId, athleteId, client);
    return write(client);
  });
}

/*
 * THE JOB FAILURE CODE FOR A CONSENT REFUSAL, or null for anything else.
 * Withdrawn and photo-only get their own codes so the coach's page can say
 * which it was; missing, unreadable and a tag naming a deleted athlete share
 * the general one. Each is a guardian's decision or a record to fix, never a
 * blip, so the worker retries none of them.
 */
export const FILM_STUDY_CONSENT_FAILURE_CODES = [
  'SHADOW_FILM_CONSENT_WITHDRAWN',
  'SHADOW_FILM_CONSENT_EXCLUDES_VIDEO',
  'SHADOW_FILM_CONSENT_BLOCKED',
] as const;

export function filmStudyConsentFailureCode(
  error: unknown,
): (typeof FILM_STUDY_CONSENT_FAILURE_CODES)[number] | null {
  if (error instanceof PilotError && error.code === 'GUARDIAN_CONSENT_WITHDRAWN') {
    return 'SHADOW_FILM_CONSENT_WITHDRAWN';
  }
  if (error instanceof PilotError && error.code === 'GUARDIAN_CONSENT_EXCLUDES_VIDEO') {
    return 'SHADOW_FILM_CONSENT_EXCLUDES_VIDEO';
  }
  // Named, not "any 409 or 404": the locked step also runs the proposal
  // insert, and an unrelated conflict there must stay retryable rather than
  // be filed as a guardian's decision.
  if (
    error instanceof GuardianConsentMissingError
    || error instanceof FilmStudyTaggedAthleteDeletedError
    || (error instanceof PilotError && error.code === 'GUARDIAN_CONSENT_UNREADABLE')
  ) {
    return 'SHADOW_FILM_CONSENT_BLOCKED';
  }
  return null;
}

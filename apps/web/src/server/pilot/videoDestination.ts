import { queryOne } from './db';

/*
 * THE OTHER DIRECTION OF THE BOUNDARY.
 *
 * assertVideoClippable (calibration/projects.ts) stops Film Study footage
 * becoming recognition evidence. This stops the reverse: Teach Shadow footage
 * being used as Film Study media -- analysed, proposed as a coaching
 * observation, published, or played back through the ordinary video route.
 *
 * WHY A SEPARATE CHECK AND NOT A LIST FILTER. The list read was separated
 * first, and that turned out to be navigation rather than an invariant: four
 * paths accept a video_session_id directly and never see the list at all. A
 * caller who already holds a ready Teach Shadow id reaches every one of them.
 * Separation that only holds while everybody navigates politely is not
 * separation.
 *
 * capture_take_id IS THE DISCRIMINATOR because Teach Shadow capture always
 * sends a take and Film Study never does. A null take means "not teaching
 * footage", which is the question these callers are asking, and it is the same
 * column the corpus side reads from the other direction.
 *
 * WHAT THIS DOES NOT GUARD. Compliance and safeguarding paths are deliberately
 * left alone: a genuine incident may need to cite teaching footage, and that
 * is evidence of a safeguarding matter rather than promotion into Film Study.
 * Their own organization and athlete checks still apply.
 *
 * FAILS CLOSED, INCLUDING ON A MISSING ROW. A video this organization cannot
 * see is refused here rather than falling through to be treated as Film Study,
 * because "I could not tell" must never resolve to "allowed" on a boundary the
 * owner has ruled categorical.
 */
export class VideoDestinationError extends Error {
  constructor() {
    super(
      'Forbidden: this footage was recorded to teach Shadow, so it cannot be used as Film Study media',
    );
    this.name = 'VideoDestinationError';
  }
}

export async function assertVideoIsFilmStudyMedia(
  organizationId: string,
  videoSessionId: string,
): Promise<void> {
  const row = await queryOne<{ capture_take_id: string | null }>(
    `select capture_take_id from pilot.video_sessions
      where organization_id = $1 and video_session_id = $2`,
    [organizationId, videoSessionId],
  );

  /*
   * A caller that already proved the video exists still reaches this with a
   * row; one that did not gets the same refusal as teaching footage rather
   * than an existence oracle. Neither answer tells an outsider whether a
   * particular id is real.
   */
  if (!row || row.capture_take_id !== null) {
    throw new VideoDestinationError();
  }
}

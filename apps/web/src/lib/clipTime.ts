/**
 * MEDIA OFFSETS IN MILLISECONDS -- formatting, clamping, and the conversion to
 * and from the seconds a <video> element speaks.
 *
 * WHY THIS FILE EXISTS. The repository had no media-offset formatter at all.
 * `formatGymStamp` is wall-clock -- it turns a timestamptz into "Thu 6:15 PM",
 * which is the right answer for a session that happened and the wrong answer
 * for "3.250 seconds into this clip". Every existing <video> in the app is a
 * bare `<video src controls>` with no ref and no currentTime handling, so
 * nothing had ever needed one. The annotation player needs one on every
 * readout, and a formatter invented inline in a component is a formatter that
 * gets invented again, differently, in the next component.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: FRAMES.
 *
 * There is no frame number anywhere in this module and there must not be one.
 * The platform stores no frame rate -- pilot.video_sessions carries file name,
 * size, mime type and scan state, and nothing else about the encoding -- and
 * the browser exposes no reliable frame index either (HTMLVideoElement gives
 * `currentTime` in seconds as a float; requestVideoFrameCallback is neither
 * universal nor a frame COUNT). So any frame number this code could print
 * would be a division by a frame rate somebody guessed, displayed to a coach
 * as though it were read off the file.
 *
 * That is the failure direction that matters here: a fabricated precision is
 * worse than a coarse one, because a coach who sees "frame 412" reasonably
 * believes the platform knows what frame 412 is, and a disagreement study
 * built on invented frame boundaries would be measuring the guess. If frame
 * context is ever displayed, it must be labelled approximate at the point of
 * display and derived from a frame rate the platform actually stored.
 *
 * MILLISECONDS ARE THE UNIT OF RECORD. The database columns are `integer`
 * milliseconds in VIDEO coordinates (the same origin as
 * pilot.calibration_clips.start_ms), so every function here that produces a
 * stored value returns a whole number of milliseconds, and every function that
 * consumes one takes milliseconds. Seconds appear in exactly two places -- the
 * two conversions below -- because that is the only place the DOM forces them.
 */

/** One second, in the unit of record. */
export const MS_PER_SECOND = 1_000;

/**
 * The playhead, as a media offset: `m:ss.mmm`, or `h:mm:ss.mmm` past an hour.
 *
 * Milliseconds are shown in full rather than rounded to tenths. An annotator
 * marking the start of a jab is choosing between values tens of milliseconds
 * apart, and a readout that rounded to 0.1s would show two different marks as
 * the same number -- which makes the control look broken and, worse, makes two
 * annotators' marks look identical when they are not. The display is the only
 * evidence a person has of what they are about to store.
 *
 * Negative input is not clamped to zero here: it is formatted with a leading
 * '-' so a caller that has produced one sees it rather than having it silently
 * become 0:00.000. Clamping is clampMsToClip's job, and doing it in a
 * formatter as well would hide the bug from whoever needs to fix it.
 */
export function formatMediaOffset(ms: number): string {
  if (!Number.isFinite(ms)) {
    // A NaN currentTime is what an unloaded or errored media element reports.
    // Printing "NaN:aN.aNb" would read as a rendering bug; this reads as what
    // it is -- no position yet.
    return '--:--.---';
  }

  const sign = ms < 0 ? '-' : '';
  const total = Math.abs(Math.round(ms));
  const millis = total % 1000;
  const totalSeconds = Math.floor(total / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const fraction = String(millis).padStart(3, '0');
  const secondsText = String(seconds).padStart(2, '0');

  if (hours > 0) {
    return `${sign}${hours}:${String(minutes).padStart(2, '0')}:${secondsText}.${fraction}`;
  }
  return `${sign}${minutes}:${secondsText}.${fraction}`;
}

/**
 * A duration, in seconds to one decimal -- for "this clip is 6.5s long", never
 * for a playhead.
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms)) return '--';
  return `${(Math.round(ms) / MS_PER_SECOND).toFixed(1)}s`;
}

/**
 * THE CLAMP. The one predicate that keeps an annotator inside the span they
 * were asked to look at.
 *
 * Every seek, every step, every scrub and every timestamp captured off the
 * playhead passes through this. A clip is a sampling decision -- "these six
 * seconds, chosen because they contain a simultaneous exchange" -- and an
 * annotator who drifts three seconds past the end is watching footage that was
 * never sampled for the study, of an athlete whose guardian consented to video
 * being held rather than to a coach browsing it. The database refuses to STORE
 * an event outside the clip (pilot_calibration_events_within_clip), so the
 * failure this prevents is not corrupt data; it is a person doing work outside
 * the clip and then being told none of it can be saved.
 *
 * INCLUSIVE ON BOTH ENDS, matching the database's containment CHECK: an event
 * may start at exactly the clip start and end at exactly the clip end.
 *
 * Returns clipStartMs for a non-finite input rather than propagating it. NaN
 * is what an errored media element reports for currentTime, and letting it
 * through would put NaN into a form field the annotator then submits.
 */
export function clampMsToClip(ms: number, clipStartMs: number, clipEndMs: number): number {
  if (!Number.isFinite(ms)) return clipStartMs;
  if (ms < clipStartMs) return clipStartMs;
  if (ms > clipEndMs) return clipEndMs;
  return Math.round(ms);
}

/**
 * True when a span lies wholly inside the clip.
 *
 * Mirrors the database's containment constraint so the UI can refuse before
 * the round trip -- NOT so the round trip can be trusted less.
 * recordAnnotationEvent checks the same thing server-side and the CHECK
 * constraint checks it under that; this exists only so the annotator is told
 * at the moment they mark the bound rather than at the moment they save.
 */
export function isSpanWithinClip(
  startMs: number,
  endMs: number,
  clipStartMs: number,
  clipEndMs: number,
): boolean {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  if (startMs >= endMs) return false;
  return startMs >= clipStartMs && endMs <= clipEndMs;
}

/**
 * The DOM boundary, both directions.
 *
 * HTMLMediaElement.currentTime is a double in SECONDS. Rounding on the way in
 * is what keeps a stored offset a whole millisecond: 1.234000000000000191 *
 * 1000 is 1234.0000000000002, `Number.isInteger` says false, and
 * requireOffsetMs in the calibration modules rejects it with "expected a whole
 * number of milliseconds" -- a refusal the annotator could do nothing about.
 */
export function msFromMediaSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.round(seconds * MS_PER_SECOND);
}

export function mediaSecondsFromMs(ms: number): number {
  return ms / MS_PER_SECOND;
}

/**
 * The step ladder for the transport controls.
 *
 * Deliberately round milliseconds rather than frames -- see this file's
 * header. 40 ms is the finest step offered because it is a number a person can
 * reason about, NOT because it is one frame at 25fps, and nothing in the UI
 * calls it a frame.
 */
export const STEP_MS = {
  fine: 40,
  small: 250,
  large: 1_000,
} as const;

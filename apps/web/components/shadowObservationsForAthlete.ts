/**
 * What an athlete reads of SHADOW's observation feed.
 *
 * The feed (POST /api/pilot/shadow/observation-projection) carries system
 * bookkeeping beside real notes: bare event names such as
 * "SHADOW_AUDIT_LOGIN_ACCOUNT" or "shadow.audit.login", a source of "event" or
 * "telemetry", a state of "unknown". An athlete was shown all three, word for
 * word, under "What SHADOW has noticed" (audit F-005). A sign-in record is not
 * something SHADOW noticed about their training, so the athlete's screens
 * leave bare event names off the list (Overwatch, lane L14, 2026-10-15). A
 * note the feed wrote as a sentence is kept exactly as written. The coach's
 * view rewords event names instead (CoachWorkspace.tsx, LC-04); this file
 * changes nothing there.
 */

export type ShadowObservationReviewState = 'pending_review' | 'approved' | 'rejected' | 'promoted' | 'unknown';

/** A label made only of letters, digits, dots and underscores is an event
 *  name, not a sentence anyone wrote. */
export function isSystemEventName(label: string): boolean {
  return /^[A-Za-z0-9._]+$/.test(label.trim());
}

export function observationsForAthlete<T extends { readonly label: string }>(items: readonly T[]): T[] {
  return items.filter((item) => item.label.trim() !== '' && !isSystemEventName(item.label));
}

/**
 * The review state, in words a kid can act on. Moved here from the athlete's
 * film page so the workspace's SHADOW tab says the same thing; 'unknown' is a
 * real member of the union and gets the honest reading rather than a guess.
 */
export function reviewStateLine(state: ShadowObservationReviewState): string {
  switch (state) {
    case 'pending_review':
      return 'Waiting on a coach to look at it.';
    case 'approved':
      return 'A coach looked at it and agreed.';
    case 'rejected':
      return 'A coach looked at it and set it aside.';
    case 'promoted':
      return 'A coach took this one further.';
    default:
      return 'Nobody has said either way yet.';
  }
}

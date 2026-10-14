import { ConflictError } from './errors';

/**
 * What a coach is told when the record they were saving to is not the record
 * they loaded: it was closed, corrected, reviewed, revised or retired first.
 * Their own write is refused whole, and the words say what to do next. They do
 * not say WHO changed it -- the same refusal answers a coach's own second tab.
 *
 * Thrown only AFTER the row was found in the caller's organization, and every
 * route reaches these functions after authorizing the caller on that row, so
 * it tells nobody that a record exists who could not already read it. A record
 * that is not there at all stays the null the routes answer as a hidden
 * not-found.
 */
export const RECORD_CHANGED_MESSAGE =
  'This record has changed since you opened it, so this was not saved. '
  + 'Reload to see it as it stands now, then make your change again.';
export const RECORD_CHANGED_CODE = 'INTERVENTION_RECORD_CHANGED';

export function recordChanged(): ConflictError {
  return new ConflictError(RECORD_CHANGED_MESSAGE, RECORD_CHANGED_CODE);
}

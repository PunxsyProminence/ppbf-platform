import { ConflictError, ValidationError } from './errors';

/**
 * A SAVE IS WRITTEN AS THE PERSON WHO MADE IT, OR NOT AT ALL (W4 item 7, the offline save queue;
 * OD-2026-11-21-006, OW27-34 A: a kept save is "tied to the account that made it"; App Overwatch's
 * answer to Q3 on #2158).
 *
 * A save whose answer is lost is kept in the open page and sent again later. The page drops what
 * it holds when the person signs out or the signed-in account changes, but a resend already on
 * its way at that moment would arrive with the NEXT person's session cookie, and the route would
 * write it as theirs. So a resend names the account that made it, in this body field, and the
 * route refuses it, writing nothing, when that is not the signed-in account.
 *
 * Only on the two routes whose writes are not already tied to their owner: adding a staff note
 * and logging an intervention. A run's actions and here taps act only on the caller's own live
 * run (requireOwnLiveRun, lockOwnLiveRun), so another account's resend there is refused already.
 *
 * Optional: a body without the field is answered exactly as before. The check only refuses; it
 * gives no one anything they could not already do.
 */
export const SAVE_MADE_BY_FIELD = 'made_by_account_id';

const NUL = '\u0000';

export function refuseSaveMadeByAnotherAccount(
  body: Record<string, unknown>,
  principal: { accountId: string },
): void {
  const madeBy = body[SAVE_MADE_BY_FIELD];
  if (madeBy === undefined || madeBy === null) return;
  if (typeof madeBy !== 'string' || madeBy === '' || madeBy.includes(NUL)) {
    throw new ValidationError(`${SAVE_MADE_BY_FIELD} must be an account id`);
  }
  if (madeBy !== principal.accountId) {
    throw new ConflictError(
      'This was saved by someone who is no longer signed in here, so it was not saved.',
      'SAVE_MADE_BY_ANOTHER_ACCOUNT',
    );
  }
}

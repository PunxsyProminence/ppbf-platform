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
 * and logging an intervention. A run's actions (sessionScriptRuns.ts requireOwnLiveRun,
 * sessionRunClass.ts lockOwnLiveRun) and here taps (the presence module, which checks the run's
 * delivering coach itself) act only on the caller's own live run, so
 * another account's resend there is refused already. Starting a run is not tied that way, and it is
 * not one of the run actions the page keeps (the actions of runs/[runId]/route.ts, as the plan of
 * record, W4_SIZING.md item 7, names them).
 *
 * The id is compared exactly: no trimming and no case folding, since an account id is not a name.
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
      'This save was made by a different account from the one signed in now, so it was not saved.',
      'SAVE_MADE_BY_ANOTHER_ACCOUNT',
    );
  }
}

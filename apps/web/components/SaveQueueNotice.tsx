'use client';

import { useSyncExternalStore } from 'react';

import {
  dismissFailedSaves,
  emptySaveQueueState,
  readSaveQueue,
  subscribeSaveQueue,
} from '@/src/lib/saveQueue';

/*
 * What a page that keeps saves says about them (W4 item 7; src/lib/saveQueue.ts):
 *   - the saves still waiting to go through (a polite live region, mounted always so the first
 *     line is announced);
 *   - the saves the server refused, with the screen's own words for why (an alert), and apart from
 *     them, under their own heading, the saves whose resend was refused when whether an earlier send
 *     landed could not be checked: never said to be not saved (Overwatch condition 2 on #2158);
 *   - after the queue dropped unsent saves, how many, with no names, and only to the person who made
 *     them (the queue decides that);
 *   - while the page checks again who is signed in, only how many saves it holds, with no names.
 * Nothing of a dropped save is shown to the next person on a shared tablet. A refused save is a
 * save failure, not a safety or governance refusal, so OK clears it. No colour carries the state;
 * the words do. Words PROPOSED (UI not tied down, OD-2026-10-02-004). Floor sizes (design-system
 * README, rule 5): --t-md text on the lines; the OK button is .btn--kiosk, --tap tall, with --t-md
 * text on a kiosk surface (the coach floor pages are one) and 19px off one, the sheet's own
 * 0.1px gap (ppbf-foundation.css, the .btn--kiosk note).
 */

const LINE =
  'rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]';

export const WAITING_WORDS = 'Not saved yet. This page keeps sending these while it stays open:';
export const WAITING_COST = 'Closing this page, or signing out, loses them.';
export const FAILED_WORDS = 'Not saved:';
export const UNKNOWN_WORDS = 'Not known whether these were saved. Check before doing them again:';
export function checkingWords(count: number): string {
  return count === 1
    ? 'Not saved: 1 save on this page. It shows again once the page has checked who is signed in.'
    : `Not saved: ${count} saves on this page. They show again once the page has checked who is signed in.`;
}
export function notSentWords(count: number): string {
  return count === 1
    ? '1 save on this page was not sent. Check it before saving again.'
    : `${count} saves on this page were not sent. Check them before saving again.`;
}

export default function SaveQueueNotice() {
  const state = useSyncExternalStore(subscribeSaveQueue, readSaveQueue, emptySaveQueueState);
  const failedLine = state.failed.length > 0 || state.notSent > 0;
  const refused = state.failed.filter((item) => item.known);
  const unknown = state.failed.filter((item) => !item.known);
  const statusLine = state.waiting.length > 0 || state.checking > 0;
  return (
    <div className={statusLine || failedLine ? 'mt-[var(--s3)] grid gap-[var(--s2)]' : undefined}>
      <div role="status" className={statusLine ? LINE : 'sr-only'}>
        {state.checking > 0 ? <p>{checkingWords(state.checking)}</p> : null}
        {state.waiting.length > 0 ? (
          <>
            <p>{WAITING_WORDS}</p>
            <ul className="mt-[var(--s1)] list-disc pl-[var(--s4)]">
              {state.waiting.map((label, index) => (
                <li key={`${index}-${label}`}>{label}</li>
              ))}
            </ul>
            <p className="mt-[var(--s1)]">{WAITING_COST}</p>
          </>
        ) : null}
      </div>
      {failedLine ? (
        <div role="alert" className={LINE}>
          {state.notSent > 0 ? <p>{notSentWords(state.notSent)}</p> : null}
          {refused.length > 0 ? (
            <>
              <p>{FAILED_WORDS}</p>
              <ul className="mt-[var(--s1)] list-disc pl-[var(--s4)]">
                {refused.map((item, index) => (
                  <li key={`${index}-${item.label}`}>
                    {item.label}: {item.words}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {unknown.length > 0 ? (
            <>
              <p>{UNKNOWN_WORDS}</p>
              <ul className="mt-[var(--s1)] list-disc pl-[var(--s4)]">
                {unknown.map((item, index) => (
                  <li key={`${index}-${item.label}`}>
                    {item.label}: {item.words}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {/* .btn--kiosk carries the floor sizes in the sheet itself: Tailwind utilities on a .btn
              lose to the unlayered sheet (ppbf-leather-brass.css). */}
          <button type="button" className="btn btn--kiosk mt-[var(--s2)]" onClick={dismissFailedSaves}>
            OK
          </button>
        </div>
      ) : null}
    </div>
  );
}

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
 *   - the saves the server refused, with the screen's own words for why (an alert);
 *   - after the queue dropped unsent saves, how many, with no names, and only to the person who made
 *     them (the queue decides that).
 * Nothing of a dropped save is shown to the next person on a shared tablet. A refused save is a
 * save failure, not a safety or governance refusal, so OK clears it. No colour carries the state;
 * the words do. Words PROPOSED (UI not tied down, OD-2026-10-02-004). Floor sizes on any surface:
 * --t-md text and a --tap tall button (design-system README, rule 5).
 */

const LINE =
  'rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]';

export const WAITING_WORDS = 'Not saved yet. This page keeps sending these while it stays open:';
export const WAITING_COST = 'Closing this page, or signing out, loses them.';
export const FAILED_WORDS = 'Not saved:';
export function notSentWords(count: number): string {
  return count === 1
    ? '1 save on this page was not sent because the sign-in changed. Check it before saving again.'
    : `${count} saves on this page were not sent because the sign-in changed. Check them before saving again.`;
}

export default function SaveQueueNotice() {
  const state = useSyncExternalStore(subscribeSaveQueue, readSaveQueue, emptySaveQueueState);
  const failedLine = state.failed.length > 0 || state.notSent > 0;
  return (
    <div className="mt-[var(--s3)] grid gap-[var(--s2)]">
      <div role="status" className={state.waiting.length > 0 ? LINE : 'sr-only'}>
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
          {state.failed.length > 0 ? (
            <>
              <p>{FAILED_WORDS}</p>
              <ul className="mt-[var(--s1)] list-disc pl-[var(--s4)]">
                {state.failed.map((item, index) => (
                  <li key={`${index}-${item.label}`}>
                    {item.label}: {item.words}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <button
            type="button"
            className="btn mt-[var(--s2)] min-h-[var(--tap)] text-[length:var(--t-md)]"
            onClick={dismissFailedSaves}
          >
            OK
          </button>
        </div>
      ) : null}
    </div>
  );
}

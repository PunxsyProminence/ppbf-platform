'use client';

import { useSyncExternalStore } from 'react';

import {
  dismissFailedSaves,
  emptySaveQueueState,
  readSaveQueue,
  subscribeSaveQueue,
} from '@/src/lib/saveQueue';

/*
 * What a page that keeps saves says about them (W4 item 7; src/lib/saveQueue.ts). Two lines, each
 * only when it has something to say: the saves still waiting to go through, and the saves the
 * server refused, with the screen's own words for why. Nothing of a save stays after the queue
 * drops it at sign-out or an account change, so the next person on a shared tablet sees nothing of
 * the last person's saves. Words PROPOSED (UI not tied down, OD-2026-10-02-004). Floor sizes: the
 * text is --t-md and the button is a .btn, which meets --tap (design-system README, rule 5).
 */

const LINE =
  'rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]';

export const WAITING_WORDS = 'Waiting to save. This page keeps trying until the connection is back:';
export const FAILED_WORDS = 'Not saved:';

export default function SaveQueueNotice() {
  const state = useSyncExternalStore(subscribeSaveQueue, readSaveQueue, emptySaveQueueState);
  if (state.waiting.length === 0 && state.failed.length === 0) return null;
  return (
    <div className="mt-[var(--s3)] grid gap-[var(--s2)]">
      {state.waiting.length > 0 ? (
        <div role="status" className={LINE}>
          <p>{WAITING_WORDS}</p>
          <ul className="mt-[var(--s1)] list-disc pl-[var(--s4)]">
            {state.waiting.map((label, index) => (
              <li key={`${index}-${label}`}>{label}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {state.failed.length > 0 ? (
        <div role="alert" className={LINE}>
          <p>{FAILED_WORDS}</p>
          <ul className="mt-[var(--s1)] list-disc pl-[var(--s4)]">
            {state.failed.map((item, index) => (
              <li key={`${index}-${item.label}`}>
                {item.label}: {item.words}
              </li>
            ))}
          </ul>
          <button type="button" className="btn mt-[var(--s2)]" onClick={dismissFailedSaves}>
            OK
          </button>
        </div>
      ) : null}
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { apiBase } from '@/lib/apiBase';

/**
 * THE "ON THE FLOOR NOW" LINE, for coaches and the gym admin (lane W4-3, FN-3;
 * W4 item 3). It reads GET /api/pilot/on-the-floor (onTheFloor.ts, FN-1) once,
 * when the page opens; a refresh of the page reads it again. Nothing polls and
 * nothing is pushed live (Jason, FN0-Q2 A: "the line refreshes when the page
 * opens or is refreshed").
 *
 * THE WORDS are Jason's (FN0-Q2 A) and App Overwatch's QA A (#2192, 7164371671):
 *   - "On the floor now: [names]"
 *   - "Nobody is counted on the floor right now."
 *   - "Who is on the floor could not be checked."
 *   - "Checking who is on the floor..." while the read is in progress.
 * A failed or unfinished read never reads as "Nobody" (FN-0 F15; the kernel
 * floor, "an unknown value never looks complete or zero").
 *
 * Names only for now (QB): the class, the round and the count come later from
 * the shared FN-4a read. Presence only (FN-0 F12): no hold, pain or readiness.
 * Nothing from the line is kept in device storage (FN-0 F10; GO correction d).
 * No warning colour: a neutral line in the page's body type, at the floor size.
 */

interface CountedAthlete {
  readonly athlete_id: string;
  readonly full_name: string;
}

type ReadState =
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | { readonly state: 'read'; readonly athletes: readonly CountedAthlete[] };

function isCountedAthlete(value: unknown): value is CountedAthlete {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  // A blank name would read "On the floor now: " with nobody after it, so it is a malformed answer.
  return typeof row.athlete_id === 'string' && typeof row.full_name === 'string' && row.full_name.trim() !== '';
}

export const ON_THE_FLOOR_WORDS = {
  checking: 'Checking who is on the floor...',
  failed: 'Who is on the floor could not be checked.',
  nobody: 'Nobody is counted on the floor right now.',
  lead: 'On the floor now: ',
} as const;

export default function OnTheFloorStaffLine() {
  const [read, setRead] = useState<ReadState>({ state: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/on-the-floor`, {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (controller.signal.aborted) return;
        const athletes = payload.athletes;
        if (!response.ok || payload.ok !== true || !Array.isArray(athletes) || !athletes.every(isCountedAthlete)) {
          setRead({ state: 'failed' });
          return;
        }
        setRead({ state: 'read', athletes });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setRead({ state: 'failed' });
      }
    })();
    return () => controller.abort();
  }, []);

  let line: string;
  if (read.state === 'loading') line = ON_THE_FLOOR_WORDS.checking;
  else if (read.state === 'failed') line = ON_THE_FLOOR_WORDS.failed;
  else if (read.athletes.length === 0) line = ON_THE_FLOOR_WORDS.nobody;
  else line = `${ON_THE_FLOOR_WORDS.lead}${read.athletes.map((athlete) => athlete.full_name).join(', ')}`;

  return (
    <section aria-label="Who is on the floor" className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
      <p className="t-body" style={{ fontSize: 'var(--t-md)' }} aria-live="polite" aria-busy={read.state === 'loading'}>
        {line}
      </p>
    </section>
  );
}

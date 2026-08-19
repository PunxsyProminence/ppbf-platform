'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import CoachMentorshipPairing from '@/components/CoachMentorshipPairing';
import CoachMilestoneMarker from '@/components/CoachMilestoneMarker';
import CoachRecognitionPad, { type RosterAthlete } from '@/components/CoachRecognitionPad';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

/**
 * THE ROOM WHERE A COACH SAYS SOMETHING GOOD.
 *
 * Its own surface rather than another tab inside the coach workspace, for one
 * reason: this has to be reachable in the time between two rounds. A coach who
 * has to find the workspace, find the right tab, and scroll past a review queue
 * is a coach who does it on Sunday from a laptop, if at all — and a compliment
 * delivered on Sunday about Tuesday is a report, not a moment.
 *
 * The page holds the roster and hands it to both panels, so picking a name is
 * one request per visit rather than one per panel.
 */
function CoachRecognitionRoom() {
  const [roster, setRoster] = useState<RosterAthlete[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const body = (await response.json()) as { items?: RosterAthlete[] };
        if (controller.signal.aborted) return;
        setRoster(body.items ?? []);
      } catch {
        /* The pad fetches its own roster too and reports its own failure; this
           copy exists only so the pairing panel does not need a second one. */
      }
    })();
    return () => controller.abort();
  }, []);

  return (
    <main className="room room--floor min-h-screen bg-[var(--hide-950)] px-[var(--s5)] py-[var(--s6)] text-[color:var(--bone-200)]">
      <div className="mx-auto max-w-5xl">
        <header className="border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Coach</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-2xl)]">Recognition</h1>
          <p className="t-body mt-[var(--s3)] max-w-3xl text-[color:var(--bone-300)]">
            The platform could tell an athlete what they had not done yet, and could not tell them
            they had done well. This is that, and it is built to be used with taped hands in the
            forty seconds you actually have.
          </p>
          <Link href="/coach/environment/intake-router" className="btn btn--ghost mt-[var(--s4)]">
            Back to Coach Workspace
          </Link>
        </header>

        <div className="mt-[var(--s6)] space-y-[var(--s6)]">
          <CoachRecognitionPad />
          <CoachMilestoneMarker roster={roster} />
          <CoachMentorshipPairing roster={roster} />
        </div>
      </div>
    </main>
  );
}

export default function CoachRecognitionPage() {
  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <CoachRecognitionRoom />
    </RoleSessionGate>
  );
}

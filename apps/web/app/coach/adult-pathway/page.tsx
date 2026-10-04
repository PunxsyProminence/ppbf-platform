'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import AdultPathwayPanel from '@/components/AdultPathwayPanel';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import {
  ADULT_PATHWAY_CAVEAT,
  ADULT_PATHWAY_SCOPE,
  ADULT_PATHWAY_STAGES,
} from '@/src/shared/adultPathwayStages';

// The adult pathway: four stages, their rough time ranges, and the goals a
// coach checks off in each.
//
// The ladder itself is static. Above it, each athlete this coach may open
// (the pathway route's accessible_athletes, so a coach sees their own and
// covered athletes, an admin the whole gym) with a closed AdultPathwayPanel:
// where a coach has placed them, the goals a coach has ticked, and for minors
// the allowance. Nothing on this page moves anyone up, and nothing here is
// worked out from hours or levels (OD-2026-10-04-002).

interface RosterAthlete { athlete_id: string; full_name?: string }

function useRoster(): { roster: RosterAthlete[] | null; failed: boolean } {
  const [roster, setRoster] = useState<RosterAthlete[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/pilot/athletes/list`, { method: 'GET', credentials: 'include' });
        const payload = res.ok ? ((await res.json()) as { items?: unknown } | null) : null;
        if (!payload || !Array.isArray(payload.items)) throw new Error('roster');
        const all = payload.items as RosterAthlete[];
        const allowedRes = await fetch(`${apiBase()}/api/pilot/coach/adult-pathway`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'accessible_athletes', athlete_ids: all.map((a) => a.athlete_id) }),
        });
        const allowed = allowedRes.ok ? ((await allowedRes.json()) as { athlete_ids?: unknown } | null) : null;
        if (!allowed || !Array.isArray(allowed.athlete_ids)) throw new Error('roster');
        const ids = new Set(allowed.athlete_ids as string[]);
        setRoster(all.filter((a) => ids.has(a.athlete_id)));
      } catch {
        // A roster that could not be read is never shown as "no athletes".
        setFailed(true);
      }
    })();
  }, []);
  return { roster, failed };
}

function CoachAdultPathway() {
  const { roster, failed } = useRoster();
  return (
    <main className="room room--office min-h-screen bg-[var(--hide-950)] px-[var(--s5)] py-[var(--s6)] text-[color:var(--bone-200)]">
      <div className="mx-auto max-w-5xl">
        <header className="border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Coach</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-2xl)]">Adult Pathway</h1>
          <p className="t-body mt-[var(--s3)] max-w-3xl text-[color:var(--bone-300)]">{ADULT_PATHWAY_SCOPE}</p>
          <p className="t-body mt-[var(--s3)] max-w-3xl text-[color:var(--bone-200)]">{ADULT_PATHWAY_CAVEAT}</p>
          <Link href="/coach/cohorts" className="btn btn--ghost mt-[var(--s4)]">
            Back to cohorts
          </Link>
        </header>

        <section className="mt-[var(--s6)]" aria-labelledby="pathway-athletes">
          <h2 id="pathway-athletes" className="t-command text-[length:var(--t-lg)]">Athletes</h2>
          {failed ? (
            <p className="t-body mt-[var(--s3)]" role="alert">Your roster could not be loaded. Reload to try again.</p>
          ) : roster === null ? (
            <p className="t-body mt-[var(--s3)]" role="status">Loading your roster…</p>
          ) : roster.length === 0 ? (
            <p className="t-body mt-[var(--s3)]">No athletes you can open.</p>
          ) : (
            <ul className="mt-[var(--s3)] space-y-[var(--s3)]" data-pathway-roster="">
              {roster.map((athlete) => (
                <li key={athlete.athlete_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                  <span className="t-body font-semibold text-[color:var(--bone-100)]">
                    {athlete.full_name || athlete.athlete_id}
                  </span>
                  <AdultPathwayPanel athleteId={athlete.athlete_id} athleteName={athlete.full_name || athlete.athlete_id} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <h2 className="t-command mt-[var(--s6)] text-[length:var(--t-lg)]">The stages</h2>
        <ol className="mt-[var(--s3)] space-y-[var(--s5)]" data-pathway-ladder="">
          {ADULT_PATHWAY_STAGES.map((stage, index) => (
            <li key={stage.key} className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
              <div className="flex flex-wrap items-baseline gap-[var(--s3)]">
                <span className="plaque">Stage {index + 1}</span>
                <h3 className="t-command text-[length:var(--t-lg)]">{stage.name}</h3>
              </div>
              <p className="t-label mt-[var(--s2)]">{stage.typicalRange}</p>

              <h4 className="t-eyebrow mt-[var(--s4)]">Checkpoints a coach confirms</h4>
              <ul className="mt-[var(--s2)] list-disc space-y-[var(--s1)] pl-[var(--s5)]">
                {stage.goals.map((goal) => (
                  <li key={goal.key} className="t-body text-[color:var(--bone-200)]">{goal.text}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </div>
    </main>
  );
}

export default function CoachAdultPathwayPage() {
  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <CoachAdultPathway />
    </RoleSessionGate>
  );
}

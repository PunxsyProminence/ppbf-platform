'use client';

import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import {
  ADULT_PATHWAY_CAVEAT,
  ADULT_PATHWAY_SCOPE,
  ADULT_PATHWAY_STAGES,
} from '@/src/shared/adultPathwayStages';

// The adult pathway: four stages, their rough time ranges, and the goals a
// coach checks off in each.
//
// READS NO DATA. This is the ladder itself, not anyone's place on it. Placing
// an adult on a stage and confirming goals is coach-set (owner decision
// 2026-10-03) and arrives with its own storage; nothing on this page moves
// anyone up, and nothing here is worked out from hours or levels.

function CoachAdultPathway() {
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

        <ol className="mt-[var(--s6)] space-y-[var(--s5)]">
          {ADULT_PATHWAY_STAGES.map((stage, index) => (
            <li key={stage.key} className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
              <div className="flex flex-wrap items-baseline gap-[var(--s3)]">
                <span className="plaque">Stage {index + 1}</span>
                <h2 className="t-command text-[length:var(--t-lg)]">{stage.name}</h2>
              </div>
              <p className="t-label mt-[var(--s2)]">{stage.typicalRange}</p>

              <h3 className="t-eyebrow mt-[var(--s4)]">Checkpoints a coach confirms</h3>
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

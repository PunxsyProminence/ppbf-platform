import Link from 'next/link';

import { readGymSetupStatus, type SetupLineState } from '@/src/server/pilot/gymSetupStatus';
import { requirePageRole } from '@/src/server/pilot/pageGuard';

/**
 * /admin/setup -- what is left before the gym's first class (lane L31 P5).
 *
 * The organization admin's own gym only, read-only. Each line says what the
 * records show and links to the screen where the step is done; nothing here
 * writes. The platform owner has no gym of its own here and goes to its desk.
 */
export const dynamic = 'force-dynamic';

const STATE_LABEL: Record<SetupLineState, string> = {
  done: 'Done',
  to_do: 'To do',
  manual: 'Outside the app',
  unavailable: 'Could not read',
};

const STATE_STAMP: Record<SetupLineState, string> = {
  done: 'stamp stamp--green',
  to_do: 'stamp',
  manual: 'stamp',
  unavailable: 'stamp',
};

export default async function GymSetupPage() {
  const principal = await requirePageRole(['organization_admin']);
  const lines = await readGymSetupStatus(principal.organizationId);
  const left = lines.filter((line) => line.state === 'to_do' || line.state === 'unavailable').length;

  return (
    <main className="room room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-4xl space-y-[var(--s5)] px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
        <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
          <p className="t-eyebrow">Gym Setup</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Before The First Class</h1>
          <p className="t-body mt-[var(--s3)] max-w-3xl">
            {left === 0
              ? 'Every step below is done, or is done outside the app.'
              : `${left} ${left === 1 ? 'step is' : 'steps are'} left. Each line says what the records show now and links to the screen where it is done.`}
          </p>
        </header>

        <ol className="space-y-[var(--s3)]" aria-label="Setup steps">
          {lines.map((line) => (
            <li
              key={line.key}
              data-state={line.state}
              className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s4)]"
            >
              <div className="flex flex-wrap items-start justify-between gap-[var(--s3)]">
                <div className="max-w-2xl">
                  <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>{line.title}</h2>
                  <p className="t-body mt-[var(--s2)]">{line.detail}</p>
                </div>
                <span className={STATE_STAMP[line.state]}>{STATE_LABEL[line.state]}</span>
              </div>
              <div className="mt-[var(--s3)]">
                <Link href={line.href} className="btn btn--ghost">{line.linkLabel}</Link>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </main>
  );
}

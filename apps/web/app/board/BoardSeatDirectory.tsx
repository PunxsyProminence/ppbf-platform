'use client';

import Link from 'next/link';

import { useBoardSession } from '@/components/BoardRoleGate';

import { boardSeatConfigs, resolveBoardSeatAccess } from './boardWorkspaceConfig';

// The seat directory, showing every seat but offering a way in only to the
// ones the viewer can actually open.
//
// The workspace itself sends a member who does not hold a seat back to this
// hub, so a link on every card would be a link that returns you to where you
// pressed it. Which seats a viewer may open is resolved by the same function
// the workspace uses, so the two cannot disagree about what is reachable.
export default function BoardSeatDirectory() {
  const session = useBoardSession();

  return (
    <section className="mt-[var(--s5)] grid gap-[var(--s4)] md:grid-cols-2 xl:grid-cols-3">
      {boardSeatConfigs.map((seat) => {
        const access = resolveBoardSeatAccess({
          role: session?.role ?? null,
          seats: session?.seats ?? [],
          seat: seat.slug,
        });

        return (
          <article key={seat.slug} className="mat-leather--raised flex flex-col rounded-[var(--r-lg)] p-[var(--s5)]">
            <p className="t-eyebrow">Board Seat</p>
            <h2 className="t-command mt-[var(--s2)] text-[length:var(--t-lg)]">{seat.seatLabel}</h2>

            <div className="mt-[var(--s4)] space-y-[var(--s3)]">
              <div>
                <p className="t-label">Role Description</p>
                <p className="t-body mt-[var(--s1)]">{seat.roleDescription}</p>
              </div>

              <div>
                <p className="t-label">Primary Responsibilities</p>
                <ul className="mt-[var(--s1)] space-y-[var(--s1)]">
                  {seat.primaryResponsibilities.map((item) => (
                    <li key={item} className="t-body">{item}</li>
                  ))}
                </ul>
              </div>
            </div>

            {access.allowed ? (
              <Link
                href={`/board/${seat.slug}`}
                className="btn btn--ghost mt-[var(--s4)] w-full"
              >
                {access.mode === 'seat-holder' ? 'Open Your Workspace' : 'Open Governance Workspace'}
              </Link>
            ) : (
              // Law 7: a governance refusal is a static ink mark, not a
              // dimmed control or an empty slot where the button would be.
              <div className="mt-[var(--s4)]">
                <p>
                  <span className="stamp stamp--flat">
                    <span aria-hidden="true">✕ </span>
                    <span>Seat held</span>
                  </span>
                </p>
                <p className="t-muted mt-[var(--s2)]">
                  Held by another seat. The president and chair can open any workspace; every other seat opens its own.
                </p>
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}

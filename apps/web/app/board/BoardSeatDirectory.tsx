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
    <section className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {boardSeatConfigs.map((seat) => {
        const access = resolveBoardSeatAccess({
          role: session?.role ?? null,
          seats: session?.seats ?? [],
          seat: seat.slug,
        });

        return (
          <article key={seat.slug} className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-950)]/80 p-5">
            <p className="text-[12px] font-mono uppercase tracking-[0.2em] text-[#8f7f72]">Board Seat</p>
            <h2 className="mt-2 text-2xl font-black text-[color:var(--bone-200)]">{seat.seatLabel}</h2>

            <div className="mt-4 space-y-3">
              <div>
                <p className="text-[12px] font-mono uppercase tracking-[0.15em] text-[color:var(--brass-300)]">Role Description</p>
                <p className="mt-1 text-[15px] leading-6 text-[#cbb8a8]">{seat.roleDescription}</p>
              </div>

              <div>
                <p className="text-[12px] font-mono uppercase tracking-[0.15em] text-[color:var(--brass-300)]">Primary Responsibilities</p>
                <ul className="mt-1 space-y-1">
                  {seat.primaryResponsibilities.map((item) => (
                    <li key={item} className="text-[15px] leading-6 text-[var(--bone-300)]">{item}</li>
                  ))}
                </ul>
              </div>
            </div>

            {access.allowed ? (
              <Link
                href={`/board/${seat.slug}`}
                className="mt-4 inline-flex min-h-[44px] items-center justify-center border-2 border-[color:var(--brass-700)] bg-[#2f1717] px-4 text-sm font-mono font-bold uppercase tracking-[0.14em] text-[color:var(--bone-200)] transition hover:border-[color:var(--brass-300)] hover:text-[color:var(--brass-300)]"
              >
                {access.mode === 'seat-holder' ? 'Open Your Workspace' : 'Open Governance Workspace'}
              </Link>
            ) : (
              <p className="mt-4 text-[13px] leading-6 text-[var(--bone-400)]">
                Held by another seat. The president and chair can open any workspace; every other seat opens its own.
              </p>
            )}
          </article>
        );
      })}
    </section>
  );
}

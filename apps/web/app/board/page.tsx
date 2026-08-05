import Link from 'next/link';
import { boardSeatConfigs } from './boardWorkspaceConfig';

export default function BoardHubPage() {
  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-4 border-b-4 border-[var(--black)] pb-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--red-primary)]">Board Hub</p>
            <h1 className="text-4xl font-black tracking-tight md:text-5xl">One board governance framework</h1>
            <p className="max-w-4xl text-base leading-7 text-[var(--gray-dark)] md:text-lg">
              Board Hub is the board seat directory, governance control surface, and mission oversight launcher. Every seat opens the same board workspace shell with role-aware visibility for nonprofit governance.
            </p>
          </div>
        </header>

        <section className="mt-8 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
          <h2 className="text-lg font-black text-[var(--black)]">Aggregate boundary</h2>
          <p className="mt-3 max-w-4xl text-sm leading-6 text-[var(--gray-dark)]">
            Board access is organization-level and aggregate-only. Small cohorts are suppressed, missing data remains unavailable, and athlete records, messages, notes, intake records, video, safety review, and administrative controls remain outside this role.
          </p>
        </section>

        <section className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {boardSeatConfigs.map((seat) => (
            <article key={seat.slug} className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)]/80 p-5">
              <p className="text-[12px] font-mono uppercase tracking-[0.2em] text-[var(--gray-dark)]">Board Seat</p>
              <h2 className="mt-2 text-2xl font-black text-[var(--black)]">{seat.seatLabel}</h2>

              <div className="mt-4 space-y-3">
                <div>
                  <p className="text-[12px] font-mono uppercase tracking-[0.15em] text-[var(--red-primary)]">Role Description</p>
                  <p className="mt-1 text-[15px] leading-6 text-[var(--gray-dark)]">{seat.roleDescription}</p>
                </div>

                <details className="border border-[var(--black)] bg-[var(--canvas-tan-light)] p-2">
                  <summary className="cursor-pointer text-[12px] font-mono uppercase tracking-[0.15em] text-[var(--red-primary)]">Primary Responsibilities</summary>
                  <ul className="mt-2 space-y-1 text-[14px] leading-6 text-[var(--gray-dark)]">
                    {seat.primaryResponsibilities.map((responsibility) => (
                      <li key={responsibility}>- {responsibility}</li>
                    ))}
                  </ul>
                </details>

                <div className="grid grid-cols-2 gap-2">
                  <div className="border border-[var(--black)] bg-[var(--canvas-tan-light)] p-2">
                    <p className="text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--gray-dark)]">Board Actions Pending</p>
                    <p className="mt-1 text-xl font-black text-[var(--black)]">{seat.openTasksCount}</p>
                  </div>
                  <div className="border border-[var(--black)] bg-[var(--canvas-tan-light)] p-2">
                    <p className="text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--gray-dark)]">Policy Reviews Due</p>
                    <p className="mt-1 text-xl font-black text-[var(--black)]">{seat.pendingReviewsCount}</p>
                  </div>
                  <div className="border border-[var(--black)] bg-[var(--canvas-tan-light)] p-2">
                    <p className="text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--gray-dark)]">Compliance Calendar Events</p>
                    <p className="mt-1 text-xl font-black text-[var(--black)]">{seat.meetingItemsCount}</p>
                  </div>
                  <div className="border border-[var(--black)] bg-[var(--canvas-tan-light)] p-2">
                    <p className="text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--gray-dark)]">Risk Review Items</p>
                    <p className="mt-1 text-xl font-black text-[var(--black)]">{seat.complianceItemsCount}</p>
                  </div>
                </div>
              </div>

              <Link
                href={`/board/${seat.slug}`}
                className="tactical-btn mt-4"
              >
                Open Governance Workspace
              </Link>
            </article>
          ))}
        </section>
      </div>
    </main>
  );
}

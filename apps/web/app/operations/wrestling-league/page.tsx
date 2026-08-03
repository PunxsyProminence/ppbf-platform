import Link from 'next/link';

export default function WrestlingLeagueManagementPage() {
  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto w-full max-w-6xl px-6 py-10 lg:px-10">
        <header className="space-y-3 border-b-[3px] border-[var(--black)] pb-6">
          <p className="text-xs font-mono uppercase tracking-[0.18em] text-[color:var(--brass-800)]">Operations Workspace</p>
          <h1 className="font-display text-4xl font-black">Wrestling League Management</h1>
          <p className="text-sm font-mono uppercase tracking-[0.14em] text-[color:var(--brass-800)]">PLANNED | NOT YET IMPLEMENTED</p>
          <p className="max-w-4xl text-sm leading-6 text-[var(--gray-dark)]">
            Front-end scaffold for future league operations. No registration, scheduling engine, or competition backend logic is implemented.
          </p>
        </header>

        <section className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[
            'League Season Planner Placeholder',
            'Team/Club Registry Placeholder',
            'Match Card Builder Placeholder',
            'Weight Class Board Placeholder',
            'Official Assignment Placeholder',
            'League Results History Placeholder',
          ].map((item) => (
            <article key={item} className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
              <h2 className="text-sm font-bold uppercase tracking-[0.08em]">{item}</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">Planned surface only. Not yet implemented.</p>
            </article>
          ))}
        </section>

        <div className="mt-8">
          <Link
            href="/operations"
            className="inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.08em]"
          >
            Back to Mission Control
          </Link>
        </div>
      </div>
    </main>
  );
}

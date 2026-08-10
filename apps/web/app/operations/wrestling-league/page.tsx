import Link from 'next/link';

export default function WrestlingLeagueManagementPage() {
  return (
    <main className="min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
        <header className="space-y-[var(--s4)] border-b-2 border-[color:var(--brass-700)] pb-[var(--s6)]">
          <p className="t-eyebrow tracking-[0.18em]">Operations Workspace</p>
          <h1 className="t-command" style={{ fontSize: 'var(--t-2xl)' }}>Wrestling League Management</h1>
          {/* Law 7: the unbuilt state is a stamp — ink on the page, in brass so
              the safety ladder keeps its colour. */}
          <span className="stamp stamp--brass">PLANNED | NOT YET IMPLEMENTED</span>
          <p className="t-body max-w-[80ch]">
            Front-end scaffold for future league operations. No registration, scheduling engine, or competition backend logic is implemented.
          </p>
        </header>

        <section className="mt-[var(--s6)] grid gap-[var(--s4)] md:grid-cols-2 xl:grid-cols-3">
          {[
            'League Season Planner Placeholder',
            'Team/Club Registry Placeholder',
            'Match Card Builder Placeholder',
            'Weight Class Board Placeholder',
            'Official Assignment Placeholder',
            'League Results History Placeholder',
          ].map((item) => (
            <article key={item} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
              <h2 className="t-command" style={{ fontSize: 'var(--t-sm)' }}>{item}</h2>
              <p className="t-body mt-[var(--s3)]">Planned surface only. Not yet implemented.</p>
            </article>
          ))}
        </section>

        <div className="mt-[var(--s6)]">
          <Link href="/operations" className="btn btn--ghost">
            Back to Mission Control
          </Link>
        </div>
      </div>
    </main>
  );
}

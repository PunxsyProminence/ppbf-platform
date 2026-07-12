import Link from 'next/link';

const boardMembers = [
  { slug: 'chair', label: 'Board Chair', role: 'Strategic direction and meeting leadership' },
  { slug: 'vice-chair', label: 'Vice Chair', role: 'Continuity, support, and committee oversight' },
  { slug: 'treasurer', label: 'Treasurer', role: 'Budget, financial integrity, and ledger review' },
  { slug: 'secretary', label: 'Secretary', role: 'Minutes, records, and official documentation' },
  { slug: 'safety-director', label: 'Program & Safety Director', role: 'Youth protection and compliance validation' },
  { slug: 'community-director', label: 'Community & Development Director', role: 'Partnerships, fundraising, and grants' },
  { slug: 'at-large', label: 'Director-at-Large', role: 'Independent oversight and voting participation' },
];

export default function BoardHubPage() {
  return (
    <main className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5]">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 lg:px-10">
        <header className="flex flex-col gap-4 border-b-4 border-[#8b0000] pb-6 md:flex-row md:items-end md:justify-between">
          <div className="space-y-3">
            <p className="text-xs font-mono uppercase tracking-[0.35em] text-[#c85a17]/80">Board Hub</p>
            <h1 className="text-4xl font-black tracking-tight md:text-5xl">One dashboard per board member</h1>
            <p className="max-w-3xl text-sm leading-6 text-[#a0a0a0] md:text-base">
              Select a seat to open a focused governance dashboard with only the essentials for that member.
            </p>
          </div>
          <Link
            href="/operations"
            className="inline-flex items-center justify-center border-2 border-[#8b0000] bg-[#4a0000]/10 px-4 py-2 text-xs font-mono font-bold text-[#c85a17] transition hover:bg-[#4a0000]/20 hover:text-[#ff6b6b]"
          >
            Operations Hub
          </Link>
        </header>

        <section className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {boardMembers.map((member) => (
            <Link
              key={member.slug}
              href={`/board/${member.slug}`}
              className="border-2 border-[#8b0000] bg-[#0f0f0f]/70 p-5 transition hover:border-[#dc2626]/30 hover:bg-[#4a0000]/10"
            >
              <p className="text-[11px] font-mono uppercase tracking-[0.2em] text-[#8a8a8a]">Board seat</p>
              <h2 className="mt-2 text-xl font-black text-[#e5e5e5]">{member.label}</h2>
              <p className="mt-2 text-sm leading-6 text-[#a0a0a0]">{member.role}</p>
              <div className="mt-4 text-xs font-mono text-[#c85a17]">Open dashboard</div>
            </Link>
          ))}
        </section>
      </div>
    </main>
  );
}
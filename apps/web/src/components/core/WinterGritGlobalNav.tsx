import Link from 'next/link';

const DIRECTORY_LINKS = [
  { label: '[Role 1] Athlete View', href: '/athlete/dashboard' },
  { label: '[Role 2] Guardian Safety', href: '/guardian/dashboard' },
  { label: '[Role 3] Coach Review Queue', href: '/coach/review-queue' },
  { label: '[Role 3] Coach Operations', href: '/coach/operations' },
  { label: '[Roles 5,7,8] Board Command Center', href: '/board/dashboard' },
  { label: '[Role 9] Incident Command (Director)', href: '/director/dashboard' },
  { label: '[Package 1] Curriculum Engine', href: '/admin/curriculum' },
  { label: '[Package 2] Media and Comms Hub', href: '/admin/communications' },
  { label: '[Package 3] Macro Analytics', href: '/admin/macro-analytics' },
  { label: '[QA] Retro Lab Sandbox', href: '/admin/retro-lab' },
];

export default function WinterGritGlobalNav() {
  return (
    <section className="bg-[#09090b] font-mono text-slate-300 p-4 border-b border-zinc-800">
      <div className="mx-auto w-full max-w-[1500px]">
        <h2 className="text-sm uppercase tracking-[0.2em] text-slate-200">Global Command Directory</h2>
        <p className="mt-2 text-xs text-zinc-500">v21.1 Route Architecture Navigation</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {DIRECTORY_LINKS.map((entry) => (
            <Link
              key={entry.href}
              href={entry.href}
              className="bg-black border border-zinc-800 hover:bg-zinc-900 rounded-none p-3 text-left transition-colors"
            >
              <span className="text-sm text-slate-200">{entry.label}</span>
              <span className="mt-1 block text-xs text-zinc-500">{entry.href}</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import TutorialButton from '@/components/TutorialButton';

const adminPanels = [
  'Compliance Dashboard',
  'Policy Review Queue',
  'Required Review Dates',
  'Board Compliance Alerts',
  'Safety Governance Monitoring',
  'Annual Filing Placeholder',
  'Public Charity Compliance Placeholder',
  'Conflict of Interest Review Placeholder',
  'Youth Safety Review Placeholder',
  'Audit Monitoring Placeholder',
];

export default function AdminComplianceCenterPage() {
  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <main className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6]">
        <div className="mx-auto max-w-7xl px-6 py-10">
          <header className="space-y-3 border-b-4 border-[#8b4444] pb-6">
            <p className="text-xs font-mono uppercase tracking-[0.22em] text-[#d4a574]">Admin Hub</p>
            <h1 className="text-4xl font-black tracking-tight">Compliance Center</h1>
            <p className="text-sm font-mono uppercase tracking-[0.14em] text-[#d4a574]">PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED</p>
            <p className="max-w-4xl text-sm leading-6 text-[#cfbfae]">
              Admin operational companion to board compliance monitoring. No legal automation, no filing automation, and no backend reminders are active in this pass.
            </p>
            <TutorialButton anchor="planned-capabilities-guide" className="border-[#8b4444] bg-[#1a1a1a] text-[#d4a574] hover:bg-[#2a1a1a]" />
          </header>

          <section className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {adminPanels.map((panel) => (
              <article key={panel} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
                <h2 className="text-sm font-bold uppercase tracking-[0.08em]">{panel}</h2>
                <p className="mt-2 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">
                  FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED
                </p>
              </article>
            ))}
          </section>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/admin" className="inline-flex min-h-[42px] items-center border-2 border-[#8b4444] bg-[#2a1a1a] px-4 text-xs font-bold uppercase tracking-[0.08em] text-[#f2e7da]">
              Back to Admin Hub
            </Link>
            <Link href="/board/compliance-monitoring" className="inline-flex min-h-[42px] items-center border-2 border-[#8b4444] bg-[#1a1a1a] px-4 text-xs font-bold uppercase tracking-[0.08em] text-[#d4a574]">
              Board Compliance Watch
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}

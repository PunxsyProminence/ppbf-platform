import SampleDataNotice from '@/components/SampleDataNotice';
import MacroCommandCenter from '@/src/components/analytics/MacroCommandCenter';
import { requirePageRole } from '@/src/server/pilot/pageGuard';

export const dynamic = 'force-dynamic';

export default async function AdminMacroAnalyticsPage() {
  // 'organization_admin' is the canonical organization administrator;
  // 'admin' is the legacy row name kept for compatibility (see roleEquals in
  // src/server/pilot/access.ts). This gate listed only the legacy name, so
  // every real organization admin was refused and bounced.
  await requirePageRole(['organization_admin', 'admin']);

  return (
    <main className="min-h-screen bg-[var(--hide-950)] font-mono text-[color:var(--bone-300)] p-4">
      <SampleDataNotice
        what="The athlete counts, attendance figures, and SafeSport and background-check statuses on this page are illustrative. Never treat a name here as a cleared adult."
        realHref="/admin/compliance-center"
        realLabel="the Compliance Center"
      />
      <MacroCommandCenter />
    </main>
  );
}

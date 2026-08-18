import SampleDataNotice from '@/components/SampleDataNotice';
import CurriculumProgressionEngine from '@/src/components/curriculum/CurriculumProgressionEngine';
import { requirePageRole } from '@/src/server/pilot/pageGuard';

export const dynamic = 'force-dynamic';

export default async function AdminCurriculumPage() {
  // 'organization_admin' is the canonical organization administrator;
  // 'admin' is the legacy row name kept for compatibility (see roleEquals in
  // src/server/pilot/access.ts). This gate listed only the legacy name, so
  // every real organization admin was refused and bounced.
  await requirePageRole(['organization_admin', 'admin', 'coach']);

  return (
    <main className="min-h-screen bg-[#09090b] font-mono text-slate-300 p-4">
      <SampleDataNotice
        what="The curriculum lanes, athlete placements, and badges on this page are illustrative and describe no real athlete."
      />
      <CurriculumProgressionEngine />
    </main>
  );
}

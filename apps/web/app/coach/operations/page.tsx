import SampleDataNotice from '@/components/SampleDataNotice';
import FloorOperationsDesk from '@/src/components/coach/FloorOperationsDesk';
import { requirePageRole } from '@/src/server/pilot/pageGuard';

export const dynamic = 'force-dynamic';

export default async function CoachOperationsPage() {
  await requirePageRole(['coach']);

  return (
    <main className="min-h-screen bg-[#09090b] font-mono text-slate-300 p-4">
      <SampleDataNotice
        what="The floor assignments, session figures, and athlete rows on this page are illustrative and describe no real session."
      />
      <FloorOperationsDesk />
    </main>
  );
}

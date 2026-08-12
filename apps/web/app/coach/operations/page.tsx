import FloorOperationsDesk from '@/src/components/coach/FloorOperationsDesk';
import { requirePageRole } from '@/src/server/pilot/pageGuard';

export const dynamic = 'force-dynamic';

export default async function CoachOperationsPage() {
  await requirePageRole(['coach']);

  return (
    <main className="min-h-screen bg-[#09090b] font-mono text-slate-300 p-4">
      <FloorOperationsDesk />
    </main>
  );
}

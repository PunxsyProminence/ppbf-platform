import AthleteDailyCheckIn from '@/src/components/athlete/AthleteDailyCheckIn';
import { requirePageRole } from '@/src/server/pilot/pageGuard';

export const dynamic = 'force-dynamic';

export default async function AthleteDashboardPage() {
  await requirePageRole(['athlete']);

  return (
    <main className="min-h-screen bg-[#09090b] text-slate-300 font-mono">
      <div className="mx-auto w-full max-w-4xl px-4 py-6">
        <AthleteDailyCheckIn />
      </div>
    </main>
  );
}

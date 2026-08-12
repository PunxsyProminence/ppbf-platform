import GuardianSafetyControls from '@/src/components/guardian/GuardianSafetyControls';
import { requirePageRole } from '@/src/server/pilot/pageGuard';

export const dynamic = 'force-dynamic';

export default async function GuardianDashboardPage() {
  // 'parent' is the canonical guardian-family role in this codebase.
  await requirePageRole(['parent']);

  return (
    <main className="min-h-screen bg-[#09090b] font-mono text-slate-300">
      <div className="mx-auto w-full max-w-4xl px-4 py-6">
        <GuardianSafetyControls />
      </div>
    </main>
  );
}

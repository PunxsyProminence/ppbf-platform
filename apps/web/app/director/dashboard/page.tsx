import IncidentCommandCenter from '@/src/components/director/IncidentCommandCenter';
import { requirePageRole } from '@/src/server/pilot/pageGuard';

export const dynamic = 'force-dynamic';

export default async function DirectorDashboardPage() {
  // Program & Safety Director maps to the canonical organization-admin role.
  await requirePageRole(['organization_admin']);

  return (
    <main className="min-h-screen bg-[#09090b] font-mono text-slate-300 p-4">
      <IncidentCommandCenter />
    </main>
  );
}

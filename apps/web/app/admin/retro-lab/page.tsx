import DevToolsQAConsole from '@/src/components/core/DevToolsQAConsole';
import PunxsyEcosystemCore from '@/src/components/core/PunxsyEcosystemCore';
import { requirePageRole } from '@/src/server/pilot/pageGuard';

export const dynamic = 'force-dynamic';

export default async function AdminRetroLabPage() {
  // Spec term `org_admin` maps to this codebase's `organization_admin` role.
  await requirePageRole(['organization_admin', 'platform_owner']);

  return (
    <main className="min-h-screen bg-[var(--hide-950)]">
      <PunxsyEcosystemCore />
      <DevToolsQAConsole />
    </main>
  );
}

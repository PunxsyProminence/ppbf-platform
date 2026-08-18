import SampleDataNotice from '@/components/SampleDataNotice';
import DevToolsQAConsole from '@/src/components/core/DevToolsQAConsole';
import PunxsyEcosystemCore from '@/src/components/core/PunxsyEcosystemCore';
import { requirePageRole } from '@/src/server/pilot/pageGuard';

export const dynamic = 'force-dynamic';

export default async function AdminRetroLabPage() {
  // Spec term `org_admin` maps to this codebase's `organization_admin` role.
  await requirePageRole(['organization_admin', 'platform_owner']);

  return (
    <main className="min-h-screen bg-[var(--hide-950)]">
      <SampleDataNotice
        what="Every panel on this page is a prototype surface running on hardcoded values. Nothing here reads or writes the organization's records."
      />
      <PunxsyEcosystemCore />
      <DevToolsQAConsole />
    </main>
  );
}

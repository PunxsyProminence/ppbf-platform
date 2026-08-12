import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest } from 'next/server';

import DevToolsQAConsole from '@/src/components/core/DevToolsQAConsole';
import PunxsyEcosystemCore from '@/src/components/core/PunxsyEcosystemCore';
import { requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const dynamic = 'force-dynamic';

export default async function AdminRetroLabPage() {
  try {
    const incomingHeaders = await headers();
    const request = new NextRequest('http://localhost/admin/retro-lab', {
      headers: new Headers(incomingHeaders),
    });
    const principal = await requirePrincipal(request);
    // Spec term `org_admin` maps to this codebase's `organization_admin` role.
    requireRole(principal, ['organization_admin', 'platform_owner']);
  } catch {
    redirect('/login');
  }

  return (
    <main className="min-h-screen bg-[#09090b]">
      <PunxsyEcosystemCore />
      <DevToolsQAConsole />
    </main>
  );
}

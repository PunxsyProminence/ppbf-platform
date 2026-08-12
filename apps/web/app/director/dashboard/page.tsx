import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest } from 'next/server';

import IncidentCommandCenter from '@/src/components/director/IncidentCommandCenter';
import { requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const dynamic = 'force-dynamic';

export default async function DirectorDashboardPage() {
  try {
    const incomingHeaders = await headers();
    const request = new NextRequest('http://localhost/director/dashboard', {
      headers: new Headers(incomingHeaders),
    });

    const principal = await requirePrincipal(request);
    // Program & Safety Director maps to the canonical organization-admin role.
    requireRole(principal, ['organization_admin']);
  } catch {
    redirect('/login');
  }

  return (
    <main className="min-h-screen bg-[#09090b] font-mono text-slate-300 p-4">
      <IncidentCommandCenter />
    </main>
  );
}

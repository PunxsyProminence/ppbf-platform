import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest } from 'next/server';

import MediaAndCommsHub from '@/src/components/communications/MediaAndCommsHub';
import { requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const dynamic = 'force-dynamic';

export default async function AdminCommunicationsPage() {
  try {
    const incomingHeaders = await headers();
    const request = new NextRequest('http://localhost/admin/communications', {
      headers: new Headers(incomingHeaders),
    });

    const principal = await requirePrincipal(request);
    // 'organization_admin' is the canonical organization administrator;
    // 'admin' is the legacy row name kept for compatibility (see roleEquals in
    // src/server/pilot/access.ts). This gate listed only the legacy name, so
    // every real organization admin was refused and bounced.
    requireRole(principal, ['organization_admin', 'admin', 'staff']);
  } catch {
    redirect('/login');
  }

  return (
    <main className="min-h-screen bg-[#09090b] font-mono text-slate-300 p-4">
      <MediaAndCommsHub />
    </main>
  );
}

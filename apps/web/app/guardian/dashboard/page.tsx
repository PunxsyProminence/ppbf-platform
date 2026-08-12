import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest } from 'next/server';

import GuardianSafetyControls from '@/src/components/guardian/GuardianSafetyControls';
import { requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const dynamic = 'force-dynamic';

export default async function GuardianDashboardPage() {
  try {
    const incomingHeaders = await headers();
    const request = new NextRequest('http://localhost/guardian/dashboard', {
      headers: new Headers(incomingHeaders),
    });

    const principal = await requirePrincipal(request);
    // 'parent' is the canonical guardian-family role in this codebase.
    requireRole(principal, ['parent']);
  } catch {
    redirect('/login');
  }

  return (
    <main className="min-h-screen bg-[#09090b] font-mono text-slate-300">
      <div className="mx-auto w-full max-w-4xl px-4 py-6">
        <GuardianSafetyControls />
      </div>
    </main>
  );
}

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextRequest } from 'next/server';

import BoardViewportSwitcher from '@/src/components/board/BoardViewportSwitcher';
import { requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const dynamic = 'force-dynamic';

export default async function BoardDashboardPage() {
  try {
    const incomingHeaders = await headers();
    const request = new NextRequest('http://localhost/board/dashboard', {
      headers: new Headers(incomingHeaders),
    });

    const principal = await requirePrincipal(request);
    requireRole(principal, ['board']);
  } catch {
    redirect('/login');
  }

  return (
    <main className="min-h-screen bg-[#09090b] font-mono text-slate-300 p-4">
      <BoardViewportSwitcher />
    </main>
  );
}

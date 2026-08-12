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
    // platform_owner is admitted for the same reason BoardRoleGate admits it in
    // app/board/layout.tsx, and for the same reason /api/pilot/board/summary and
    // /api/pilot/board/compliance-rules admit it: the platform owner has
    // oversight of board surfaces but holds no seat. This gate named 'board'
    // alone, so it refused a role the layout above it and the API beneath it
    // both allow -- the owner reached every other page in this subtree and was
    // ejected from exactly this one.
    requireRole(principal, ['board', 'platform_owner']);
  } catch {
    redirect('/login');
  }

  return (
    <main className="min-h-screen bg-[#09090b] font-mono text-slate-300 p-4">
      <BoardViewportSwitcher />
    </main>
  );
}

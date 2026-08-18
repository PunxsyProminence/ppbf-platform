import BoardViewportSwitcher from '@/src/components/board/BoardViewportSwitcher';
import { requirePageRole } from '@/src/server/pilot/pageGuard';

export const dynamic = 'force-dynamic';

export default async function BoardDashboardPage() {
  // platform_owner is admitted for the same reason BoardRoleGate admits it in
  // app/board/layout.tsx, and for the same reason /api/pilot/board/summary and
  // /api/pilot/board/compliance-rules admit it: the platform owner has
  // oversight of board surfaces but holds no seat. This gate named 'board'
  // alone, so it refused a role the layout above it and the API beneath it
  // both allow -- the owner reached every other page in this subtree and was
  // ejected from exactly this one.
  await requirePageRole(['board', 'platform_owner']);

  return (
    <main className="min-h-screen bg-[var(--hide-950)] font-mono text-[color:var(--bone-300)] p-4">
      <BoardViewportSwitcher />
    </main>
  );
}

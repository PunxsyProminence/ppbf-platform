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

  // This page declared no room at all and stood on the night ground in mono
  // type -- After Hours clothes on a governance surface. It is a board page,
  // so it paints the board room like every other page in this subtree.
  return (
    <main className="room room--board min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-7xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
        <BoardViewportSwitcher />
      </div>
    </main>
  );
}

import SampleDataNotice from '@/components/SampleDataNotice';
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
    <main className="min-h-screen bg-[#09090b] font-mono text-slate-300 p-4">
      <SampleDataNotice
        what="The budget lines, grant pipeline, and policy risk scores on this page are illustrative and are not this organization's finances."
        realHref="/admin/grants"
        realLabel="Grants"
      />
      <BoardViewportSwitcher />
    </main>
  );
}

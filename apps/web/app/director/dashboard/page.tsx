import Link from 'next/link';

import { requirePageRole } from '@/src/server/pilot/pageGuard';

export const dynamic = 'force-dynamic';

// This route used to mount IncidentCommandCenter -- a prototype rendering a
// hardcoded escalation queue, invented near-misses, and a heavy-bag matrix
// about athletes who do not exist, behind a live organization_admin guard.
// Fabricated safety incidents on a real safeguarding surface are the exact
// class of false reassurance this codebase deletes rather than stamps (see
// the guardian dashboard's identical treatment). The real escalation queue
// -- open, acknowledge, resolve, pattern-scan, all persisted and audited --
// lives at /admin/escalations, so this page now just points there. The
// prototype component and the two orphaned nav components that were this
// route's only referrers are deleted.
export default async function DirectorDashboardPage() {
  await requirePageRole(['organization_admin']);

  return (
    <main className="room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-4xl px-[var(--s5)] py-[var(--s6)]">
        <header className="space-y-[var(--s3)] border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Director</p>
          <h1 className="t-command text-[length:var(--t-2xl)]">The incident center moved to the real queue</h1>
          <p className="t-body max-w-[70ch] text-[color:var(--bone-300)]">
            This page used to show a demonstration escalation queue with invented incidents. Real safety
            escalations &mdash; the ones staff actually raise, acknowledge, and resolve &mdash; live on the
            escalation queue, and the board-facing severity counts live on the escalation ladder.
          </p>
        </header>
        <div className="mt-[var(--s5)] flex flex-wrap gap-[var(--s3)]">
          <Link href="/admin/escalations" className="btn">
            Open the Escalation Queue
          </Link>
          <Link href="/admin/safety-review" className="btn btn--ghost">
            Safety Review Rollup
          </Link>
        </div>
      </div>
    </main>
  );
}

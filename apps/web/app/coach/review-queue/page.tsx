import Link from 'next/link';

import { requirePageRole } from '@/src/server/pilot/pageGuard';

export const dynamic = 'force-dynamic';

// This route used to mount a hardcoded mock review queue -- fictional
// athletes, an Approve button that discarded everything on unmount, and a
// "break my 40% rule" override concept. The owner ruled (2026-08-14) that
// none of that ships as operational UI: the real review queue gets built
// later from actual backend recommendation/readiness/decision records, and
// any future human override must be explicit, auditable, rationale-required,
// and must never bypass medical, safeguarding, or training-hold gates.
// Until then this page says what it is, the same way the other planned
// scaffolds do, and points at the working coach hub. The intended design
// for the real page is recorded in src/design/PAGE_MAP.md.
export default async function CoachReviewQueuePage() {
  await requirePageRole(['coach']);

  return (
    <main className="room room--floor min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-4xl px-[var(--s5)] py-[var(--s6)]">
        <header className="space-y-[var(--s3)] border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Coach Workspace</p>
          <h1 className="t-command text-[length:var(--t-2xl)]">Review Queue</h1>
          <p><span className="stamp stamp--brass stamp--flat">Planned — Not Yet Implemented</span></p>
          <p className="t-body max-w-4xl text-[color:var(--bone-300)]">
            The session review queue will be built from real recommendation, readiness, and decision
            records once those exist to review. Nothing here reads or writes data yet. Daily coaching
            work — intake review, floor plans, coach reviews, and pain reports — lives in the coach
            workspace.
          </p>
        </header>
        <div className="mt-[var(--s5)]">
          <Link href="/coach/environment/intake-router" className="btn">
            Open the Coach Workspace
          </Link>
        </div>
      </div>
    </main>
  );
}

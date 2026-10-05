'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';

import { useBoardSession } from '@/components/BoardRoleGate';
import RefusalStamp from '@/components/RefusalStamp';

/* F-003. BoardRoleGate (app/board/layout.tsx) admits platform_owner to the
   whole subtree, because the hub, the seat pages and /board/dashboard read
   routes that serve it. These pages do not: every route behind them gates on
   ['board'] alone, and the owner decided (OD-2026-10-05, option A) that the
   platform owner is not served board aggregates. Left to RoleSessionGate the
   owner was either shown a 403 as "Unavailable" or redirected after the
   requests had already fired. This says what it is instead, and renders
   nothing that fetches.

   A missing session (no BoardRoleGate above, as in a unit test) falls through
   to the page's own RoleSessionGate, which still decides. */
export default function BoardOnlyNotice({ children }: Readonly<{ children: ReactNode }>) {
  const session = useBoardSession();

  if (session?.role === 'platform_owner') {
    return (
      <main className="room room--board grid min-h-screen place-items-center bg-[var(--hide-950)] px-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="max-w-xl">
          <RefusalStamp
            kind="wrong_door"
            detail="these figures are served to board members only"
            className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]"
          />
          <Link href="/board" className="btn btn--ghost mt-[var(--s5)]">
            Back to Board Hub
          </Link>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}

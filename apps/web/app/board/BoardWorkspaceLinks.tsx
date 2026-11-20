'use client';

import { useId } from 'react';
import Link from 'next/link';

import { useBoardSession } from '@/components/BoardRoleGate';

import type { BoardSeatSlug } from './boardWorkspaceConfig';

/* Lane AS-12 (app scrub BOA-03, BOA-04, BOA-07): the board's three reads, one
   row, directly under the header of the page a board member lands on -- their
   seat workspace, or the Board Hub when they hold no seat. Each label is the
   title of the page it opens (OD-2026-10-17-001 ruling 1).

   Who is shown what follows who each page serves, so no link ends in a
   refusal:
     - the three reads serve 'board' alone (their RoleSessionGate and every
       route behind them), so only a board session is shown them. The platform
       owner reads the hub and the seat pages as an observer and is refused by
       all three (BoardOnlyNotice, F-003);
     - Board Seats serves the gym admin and 'board'. It is offered on the hub
       and on the President workspace, because seat assignment is the
       President's one administrative control.
   A page with no board session above it (a unit test without BoardRoleGate) is
   shown none of the role-bound links. */

const BOARD_READS = [
  { label: 'Program Aggregates', href: '/board/aggregates' },
  { label: 'Escalation Ladder', href: '/board/escalation-monitoring' },
  { label: 'Hand-Filed Compliance Register', href: '/board/compliance-monitoring' },
] as const;

interface BoardWorkspaceLinksProps {
  /** The seat workspace this row stands on. Omitted on the Board Hub. */
  seat?: BoardSeatSlug;
}

export default function BoardWorkspaceLinks({ seat }: Readonly<BoardWorkspaceLinksProps>) {
  const session = useBoardSession();
  const headingId = useId();
  const isBoard = session?.role === 'board';
  const onHub = seat === undefined;

  const links: Array<{ label: string; href: string }> = [
    // The hub does not link itself.
    ...(onHub ? [] : [{ label: 'Board Hub', href: '/board' }]),
    ...(isBoard ? BOARD_READS : []),
    ...(isBoard && (onHub || seat === 'president') ? [{ label: 'Board Seats', href: '/admin/board-seats' }] : []),
  ];

  // The platform owner on the hub has nowhere to be sent: no empty panel.
  if (links.length === 0) {
    return null;
  }

  return (
    <nav
      aria-labelledby={headingId}
      className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]"
    >
      <h2 id={headingId} className="t-command">Workspace Links</h2>
      <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
        {links.map((link) => (
          <Link key={link.href} href={link.href} className="btn btn--ghost">
            {link.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

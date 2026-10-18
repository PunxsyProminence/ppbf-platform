'use client';

import Link from 'next/link';
import { useSyncExternalStore } from 'react';
import { boardSeatMap, isBoardSeatSlug } from '@/app/board/boardWorkspaceConfig';
import { getPilotRoleDestination } from '@/src/shared/pilotRoleRouting';
import { getRoleSessionSnapshot, subscribeRoleSession } from './roleSession';
import type { RoleSession } from './roleSession';

/**
 * THE ONE "BACK" LINK: it goes to the signed-in person's own home.
 *
 * Lane U2, audit UX-A A-5/A-7 (2026-10-16). Pages used to hard-code where
 * "back" went -- "Back to Coach Workspace" on pages that admit admins, "Back to
 * admin" on pages that admit coaches -- and the page behind the link refused
 * the person who clicked it, so RoleSessionGate quietly sent them to their own
 * home with no word why. This link asks the same question the sign-in does
 * (getPilotRoleDestination), so it can only ever open a page that admits the
 * person reading it.
 *
 * It reads the cached session RoleSessionGate already stored, as the header
 * does: no extra request. With no session (or a role the routing table does
 * not know) it points at /dashboard, which resolves the role on the server.
 *
 * Labels name the home page by its title (PROPOSED copy; "Gym Office" is
 * Jason's ruled word, 2026-10-17).
 */

const HOME_TITLES: Readonly<Record<string, string>> = {
  coach: 'Coach Workspace',
  admin: 'Gym Office',
  platform_owner: 'Omega',
  athlete: 'Athlete Workspace',
  parent: 'Parent Hub',
  board: 'Board Hub',
  staff: 'Staff Workspace',
  volunteer: 'Volunteer Workspace',
};

export interface BackHomeTarget {
  readonly href: string;
  readonly label: string;
}

export function backHomeTarget(session: RoleSession | null): BackHomeTarget {
  const role = session?.role ?? null;
  const href = (role && getPilotRoleDestination(role, session?.boardSeat)) || '/dashboard';
  // A seat holder lands on their seat page, titled "<Seat> Workspace"
  // (BoardMemberDashboard.tsx), so the label names that page.
  const seat = role === 'board' && isBoardSeatSlug(session?.boardSeat) ? boardSeatMap[session.boardSeat] : null;
  const title = seat ? `${seat.seatLabel} Workspace` : role ? HOME_TITLES[role] : undefined;
  return { href, label: title ? `Back to ${title}` : 'Back to your home page' };
}

export default function BackHome({ className = 'btn btn--ghost' }: { readonly className?: string }) {
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  const { href, label } = backHomeTarget(session);
  return (
    <Link href={href} className={className}>
      {label}
    </Link>
  );
}

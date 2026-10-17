'use client';

import Link from 'next/link';
import { useSyncExternalStore, type ReactNode } from 'react';
import type { ClubRole } from './roleRoutes';
import { getRoleSessionSnapshot, subscribeRoleSession } from './roleSession';

/**
 * A link that renders only for the roles the page behind it admits.
 *
 * Lane U2, audit UX-A A-5: pages that admit a coach offered links to
 * admin-only pages, and the coach who clicked one was bounced home by
 * RoleSessionGate with nothing said. Pass the TARGET page's own
 * `allowedRoles`; the check is the gate's own (membership, as in
 * isRoleSessionAllowed), so the link and the page cannot disagree. The general
 * form of OperationsLink.
 *
 * IT IS NOT A GUARD: hiding a control protects nothing, and the target page's
 * gate stays the authority. Null while the session resolves, which hides it.
 */
interface RoleLinkProps {
  readonly href: string;
  /** The target page's RoleSessionGate allowedRoles. */
  readonly roles: readonly ClubRole[];
  readonly className?: string;
  readonly children: ReactNode;
}

export default function RoleLink({ href, roles, className, children }: RoleLinkProps) {
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  // RoleSessionGate's own test (isRoleSessionAllowed): membership of the role.
  if (!session || !roles.includes(session.role)) {
    return null;
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

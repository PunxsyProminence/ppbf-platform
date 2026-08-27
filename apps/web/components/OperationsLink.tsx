'use client';

import Link from 'next/link';
import { useSyncExternalStore, type ReactNode } from 'react';

import { canUseOperationsHub } from './operationsAccess';
import { getRoleSessionSnapshot, subscribeRoleSession } from './roleSession';

/**
 * A link to the Operations hub that renders for the roles which can actually
 * open it, and renders nothing for the rest.
 *
 * WHY THIS EXISTS RATHER THAN A ROLE CHECK IN EACH PAGE. Twenty-one pages
 * hard-coded `<Link href="/operations">`, and the ones that matter sit on
 * surfaces the owner decision of 2026-08-26 now refuses: a parent's Guardian
 * Portal offered "The Ring", `/help` offered "Mission Control" to a
 * signed-out visitor, and two coach surfaces under the `/operations/` prefix
 * offered "Back to Operations" -- a back button into a redirect. Copying a
 * session read and a role comparison into each of them would be eight more
 * places for this policy to drift out of step with operationsAccess.ts, which
 * is the failure this whole change is undoing.
 *
 * A link that leads to a refusal is worse than no link. This page's reader
 * cannot tell the difference between "you may not go here" and "the button is
 * broken": RoleSessionGate answers a refused role with router.replace, so
 * they land back on their own dashboard with nothing said. Removing the
 * control is the honest treatment.
 *
 * IT IS NOT A GUARD. Same rule as buildingMap.ts: hiding a control protects
 * nothing, and the hub's own RoleSessionGate is the authority. This exists so
 * the interface stops offering doors that bounce people.
 */

interface OperationsLinkProps {
  /** The link classes the surrounding page already uses. */
  readonly className?: string;
  /** The page's own wording -- "Mission Control", "Back to Operations". */
  readonly children: ReactNode;
}

export default function OperationsLink({ className, children }: OperationsLinkProps) {
  /* Null while the session resolves, and null for a signed-out visitor on an
     ungated page like /help. Both are refused, which is the closed side. */
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);

  if (!canUseOperationsHub(session?.role ?? null)) {
    return null;
  }

  return (
    <Link href="/operations" className={className}>
      {children}
    </Link>
  );
}

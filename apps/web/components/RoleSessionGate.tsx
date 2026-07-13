'use client';

import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { clearRoleSession, getPostLoginRoute, getRoleSessionSnapshot, subscribeRoleSession } from './roleSession';
import type { ClubRole } from './roleRoutes';

interface RoleSessionGateProps {
  readonly allowedRoles: ClubRole[];
  readonly children: ReactNode;
}

export default function RoleSessionGate({ allowedRoles, children }: RoleSessionGateProps) {
  const router = useRouter();
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);

  const allowed = !!session && (session.role === 'admin' || allowedRoles.includes(session.role));

  useEffect(() => {
    if (!session) {
      clearRoleSession();
      router.replace('/login');
      return;
    }

    if (!allowed) {
      router.replace(getPostLoginRoute(session));
    }

  }, [allowed, router, session]);

  if (!session || !allowed) {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-6 text-[var(--black)]">
        <div className="text-center">
          <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--red-primary)]">Secure Session</p>
          <h1 className="mt-3 font-display text-3xl tracking-tight">Checking access</h1>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}

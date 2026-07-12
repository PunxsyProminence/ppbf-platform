'use client';

import { useEffect, useMemo, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { clearRoleSession, getPostLoginRoute, readRoleSession, type RoleSession } from './roleSession';
import type { ClubRole } from './roleRoutes';

interface RoleSessionGateProps {
  allowedRoles: ClubRole[];
  children: ReactNode;
}

export default function RoleSessionGate({ allowedRoles, children }: RoleSessionGateProps) {
  const router = useRouter();
  const session = useMemo<RoleSession | null>(
    () => (typeof window !== 'undefined' ? readRoleSession() : null),
    [],
  );
  const allowed = !!session && (session.role === 'admin' || allowedRoles.includes(session.role));

  useEffect(() => {
    if (!session) {
      clearRoleSession();
      router.replace('/login');
      return;
    }

    if (!allowed) {
      router.replace(getPostLoginRoute(session));
      return;
    }

  }, [allowed, router, session]);

  if (!session || !allowed) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#0a0a0a] px-6 text-[#e8d7c6]">
        <div className="text-center">
          <p className="text-xs font-mono uppercase tracking-[0.35em] text-[#d4a574]">Secure Session</p>
          <h1 className="mt-3 font-display text-3xl tracking-tight">Checking access</h1>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}

'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { clearRoleSession, getRoleSessionRoute, readRoleSession, type RoleSession } from './roleSession';
import type { ClubRole } from './roleRoutes';

interface RoleSessionGateProps {
  allowedRoles: ClubRole[];
  children: ReactNode;
}

export default function RoleSessionGate({ allowedRoles, children }: RoleSessionGateProps) {
  const router = useRouter();
  const [session, setSession] = useState<RoleSession | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const currentSession = readRoleSession();

    if (!currentSession) {
      clearRoleSession();
      router.replace('/login');
      return;
    }

    if (!allowedRoles.includes(currentSession.role)) {
      router.replace(getRoleSessionRoute());
      return;
    }

    setSession(currentSession);
    setReady(true);
  }, [allowedRoles, router]);

  if (!ready) {
    return (
      <main className="min-h-screen bg-[#030712] text-slate-100 grid place-items-center px-6">
        <div className="text-center">
          <p className="text-xs font-mono uppercase tracking-[0.35em] text-emerald-300/80">Secure Session</p>
          <h1 className="mt-3 text-2xl font-black">Checking access</h1>
        </div>
      </main>
    );
  }

  return <>{session ? children : null}</>;
}

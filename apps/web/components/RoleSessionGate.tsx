'use client';

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { clearRoleSession, getPostLoginRoute, getRoleSessionSnapshot, subscribeRoleSession } from './roleSession';
import type { ClubRole } from './roleRoutes';
import { apiBase } from '@/lib/apiBase';

interface RoleSessionGateProps {
  readonly allowedRoles: ClubRole[];
  readonly children: ReactNode;
}

export default function RoleSessionGate({ allowedRoles, children }: RoleSessionGateProps) {
  const router = useRouter();
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  const [verifiedAssuranceSessionKey, setVerifiedAssuranceSessionKey] = useState<string | null>(null);

  const allowed = !!session && (session.role === 'admin' || allowedRoles.includes(session.role));
  const requiresHighAssurance = !!session && session.role !== 'athlete';
  const sessionKey = session ? `${session.role}:${session.expiresAt ?? 'none'}` : null;
  const assuranceVerified = !requiresHighAssurance || verifiedAssuranceSessionKey === sessionKey;

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

    if (!requiresHighAssurance) {
      return;
    }

    let canceled = false;

    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/auth/session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });

        const payload = (await response.json().catch(() => ({ authenticated: false }))) as {
          authenticated?: boolean;
          auth_provider?: 'ppbf_local' | 'microsoft';
        };

        if (canceled) {
          return;
        }

        const highAssurance = !!payload.authenticated && payload.auth_provider === 'microsoft';
        if (!highAssurance) {
          clearRoleSession();
          router.replace('/login?error=privileged_auth_required');
          return;
        }

        setVerifiedAssuranceSessionKey(sessionKey);
      } catch {
        if (canceled) {
          return;
        }
        clearRoleSession();
        router.replace('/login?error=privileged_auth_required');
      }
    })();

    return () => {
      canceled = true;
    };

  }, [allowed, requiresHighAssurance, router, session, sessionKey]);

  if (!session || !allowed || !assuranceVerified) {
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

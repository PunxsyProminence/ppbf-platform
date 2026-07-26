'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { clearRoleSession } from './roleSession';
import type { ClubRole } from './roleRoutes';
import { mapPilotLoginRoleToClubRole } from '@/src/client/loginPageHelpers';
import { fetchPilotSession, getPilotSessionAuthProvider, getPilotSessionRedirectPath } from '@/src/client/pilotSession';

interface RoleSessionGateProps {
  readonly allowedRoles: ClubRole[];
  readonly children: ReactNode;
}

export default function RoleSessionGate({ allowedRoles, children }: RoleSessionGateProps) {
  const router = useRouter();
  const [sessionChecking, setSessionChecking] = useState(true);
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    let canceled = false;

    void (async () => {
      try {
        const payload = await fetchPilotSession();

        if (canceled) {
          return;
        }

        if (!payload.authenticated || !payload.role) {
          clearRoleSession();
          router.replace('/login');
          return;
        }

        const normalizedRole = mapPilotLoginRoleToClubRole(payload.role);
        const allowed = normalizedRole === 'admin' || allowedRoles.includes(normalizedRole);
        const authProvider = getPilotSessionAuthProvider(payload);
        const requiresHighAssurance = normalizedRole !== 'athlete';

        if (!allowed) {
          clearRoleSession();
          router.replace(getPilotSessionRedirectPath(payload));
          return;
        }

        if (requiresHighAssurance && authProvider !== 'microsoft') {
          clearRoleSession();
          router.replace('/login?error=privileged_auth_required');
          return;
        }

        setAuthorized(true);
      } catch {
        if (canceled) {
          return;
        }
        clearRoleSession();
        router.replace('/login?error=privileged_auth_required');
      } finally {
        if (!canceled) {
          setSessionChecking(false);
        }
      }
    })();

    return () => {
      canceled = true;
    };

  }, [allowedRoles, router]);

  if (sessionChecking || !authorized) {
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

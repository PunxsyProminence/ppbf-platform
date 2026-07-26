'use client';

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { clearRoleSession, getPostLoginRoute, getRoleSessionSnapshot, subscribeRoleSession } from './roleSession';
import { getRoleRoute, type ClubRole } from './roleRoutes';

interface RoleSessionGateProps {
  readonly allowedRoles: ClubRole[];
  readonly children: ReactNode;
}

interface SessionResponse {
  authenticated?: boolean;
  role?: string;
}

function mapPrincipalRoleToClubRole(role: string | null | undefined): ClubRole | null {
  switch (role) {
    case 'platform_owner':
    case 'organization_admin':
    case 'admin':
      return 'admin';
    case 'coach':
      return 'coach';
    case 'athlete':
      return 'athlete';
    case 'parent':
      return 'parent';
    case 'board_president':
      return 'board-president';
    case 'board_chair':
      return 'board-chair';
    case 'board_vice_chair':
      return 'board-vice-chair';
    case 'board_treasurer':
      return 'board-treasurer';
    case 'board_secretary':
      return 'board-secretary';
    case 'board_safety_director':
      return 'board-safety-director';
    case 'board_community_director':
      return 'board-community-director';
    case 'board_at_large':
      return 'board-at-large';
    default:
      return null;
  }
}

export default function RoleSessionGate({ allowedRoles, children }: RoleSessionGateProps) {
  const router = useRouter();
  const session = useSyncExternalStore(subscribeRoleSession, getRoleSessionSnapshot, () => null);
  const [serverRole, setServerRole] = useState<ClubRole | null>(null);
  const [serverChecked, setServerChecked] = useState(false);

  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        const response = await fetch('/api/pilot/auth/session', {
          method: 'POST',
          credentials: 'include',
        });

        if (!response.ok) {
          if (active) {
            setServerRole(null);
          }
          return;
        }

        const payload = (await response.json()) as SessionResponse;
        if (!active) {
          return;
        }

        if (!payload.authenticated) {
          setServerRole(null);
          return;
        }

        setServerRole(mapPrincipalRoleToClubRole(payload.role));
      } catch {
        if (active) {
          setServerRole(null);
        }
      } finally {
        if (active) {
          setServerChecked(true);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const effectiveRole = useMemo(() => {
    if (serverRole) {
      return serverRole;
    }
    return null;
  }, [serverRole]);

  const allowed = !!effectiveRole && (effectiveRole === 'admin' || allowedRoles.includes(effectiveRole));

  useEffect(() => {
    if (!serverChecked) {
      return;
    }

    if (!effectiveRole) {
      clearRoleSession();
      router.replace('/login');
      return;
    }

    if (!allowed) {
      router.replace(getRoleRoute(effectiveRole));
    }

    if (session && session.role !== effectiveRole) {
      clearRoleSession();
    }
  }, [allowed, effectiveRole, router, serverChecked, session]);

  if (!serverChecked || !allowed) {
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

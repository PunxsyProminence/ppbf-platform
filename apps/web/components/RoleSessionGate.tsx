'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  clearRoleSession,
  persistAuthoritativeRoleSession,
  isRoleSessionAllowed,
  loadAuthoritativeRoleSession,
} from './roleSession';
import type { ClubRole } from './roleRoutes';
import { groundClasses } from './roleGround';
import { apiBase } from '@/lib/apiBase';

interface RoleSessionGateProps {
  readonly allowedRoles: ClubRole[];
  readonly children: ReactNode;
}

export default function RoleSessionGate({ allowedRoles, children }: RoleSessionGateProps) {
  const router = useRouter();
  const [accessResult, setAccessResult] = useState<{
    verificationKey: string;
    state: 'authorized' | 'retryable';
  } | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const allowedRolesKey = [...allowedRoles].sort().join('|');
  const verificationKey = `${allowedRolesKey}:${retryNonce}`;
  const accessState = accessResult?.verificationKey === verificationKey
    ? accessResult.state
    : 'checking';

  useEffect(() => {
    const controller = new AbortController();
    const expectedRoles = allowedRolesKey
      .split('|')
      .filter((role): role is ClubRole => role.length > 0);

    void (async () => {
      try {
        const resolution = await loadAuthoritativeRoleSession(
          `${apiBase()}/api/pilot/auth/session`,
          { signal: controller.signal },
        );

        if (controller.signal.aborted) {
          return;
        }

        if (!resolution.ok) {
          if (resolution.reason === 'server_error') {
            setAccessResult({ verificationKey, state: 'retryable' });
            return;
          }

          // Still on the gym-issued starting PIN. The session is valid, so
          // this must not clear it or route to /login -- signing in again
          // would only arrive back in the same state. Send them to the one
          // page the server still allows.
          if (resolution.reason === 'pin_change_required') {
            router.replace('/change-pin');
            return;
          }

          clearRoleSession();
          const errorPath = resolution.reason === 'privileged_auth_required'
            ? '/login?error=privileged_auth_required'
            : resolution.reason === 'unsupported_role'
              ? '/login?error=unsupported_role'
              : '/login';
          router.replace(errorPath);
          return;
        }

        const session = persistAuthoritativeRoleSession(resolution.session);
        if (!isRoleSessionAllowed(session, expectedRoles)) {
          router.replace(resolution.destination);
          return;
        }

        setAccessResult({ verificationKey, state: 'authorized' });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return;
        }
        setAccessResult({ verificationKey, state: 'retryable' });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [allowedRolesKey, router, verificationKey]);

  if (accessState !== 'authorized') {
    return (
      <main className={`grid min-h-screen place-items-center px-[var(--s5)] ${groundClasses(allowedRoles)}`}>
        <div className="text-center">
          <p className="text-xs font-mono uppercase tracking-[0.35em] text-[color:var(--brass-600)]">Secure Session</p>
          <h1 className="mt-3 font-display text-3xl tracking-tight">
            {accessState === 'retryable' ? 'Unable to verify access' : 'Checking access'}
          </h1>
          {accessState === 'retryable' && (
            <button
              type="button"
              onClick={() => setRetryNonce((value) => value + 1)}
              className="btn mt-[var(--s5)]"
            >
              Retry
            </button>
          )}
        </div>
      </main>
    );
  }

  return <>{children}</>;
}

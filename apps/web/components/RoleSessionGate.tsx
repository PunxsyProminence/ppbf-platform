'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  clearRoleSession,
  persistAuthoritativeRoleSession,
  isRoleSessionAllowed,
  loadAuthoritativeRoleSession,
} from './roleSession';
import { requiresDocumentLoad } from './cameraDocuments';
import type { ClubRole } from './roleRoutes';
import { groundClasses } from './roleGround';
import { apiBase } from '@/lib/apiBase';

interface RoleSessionGateProps {
  readonly allowedRoles: ClubRole[];
  readonly children: ReactNode;
}

export default function RoleSessionGate({ allowedRoles, children }: RoleSessionGateProps) {
  const router = useRouter();

  /*
   * THE GATE ITSELF CAN LEAVE A CAMERA DOCUMENT, and it does so more often
   * than any link.
   *
   * This component wraps both recorders. When it finds an expired session, a
   * starting PIN, or a role that may not be here, it redirects -- and
   * router.replace is a SOFT navigation, so the login page it sends the coach
   * to would run inside the document that was served camera=(self). The
   * capability would outlive the session that was just cleared.
   *
   * Every redirect out of here therefore goes through this, which loads a
   * document when either end is a camera route and otherwise behaves exactly
   * as before. See components/cameraDocuments.ts.
   *
   * The current path is read from window.location rather than from
   * usePathname, and that is the more correct of the two as well as the less
   * invasive: what decides which Permissions-Policy is in force is the
   * DOCUMENT that was served, and window.location is that document. The
   * router's pathname is the route it believes it is showing, which after a
   * soft navigation is a different thing.
   */
  const leaveFor = useCallback((destination: string) => {
    const here = typeof window === 'undefined' ? null : window.location.pathname;
    if (requiresDocumentLoad(here, destination)) {
      window.location.replace(destination);
      return;
    }
    router.replace(destination);
  }, [router]);
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
        // POST: /api/pilot/auth/session only ever implemented POST (see its
        // route.ts -- there is no GET export). This briefly read 'GET' here,
        // which 405s on every request; loadAuthoritativeRoleSession treats
        // any non-401 failure status as 'unauthenticated', so every gated
        // page cleared a perfectly valid session and bounced its owner to
        // /login on arrival -- indistinguishable from being logged out.
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
            leaveFor('/change-pin');
            return;
          }

          if (resolution.reason === 'unauthenticated' || resolution.statusCode === 401) {
            clearRoleSession();
            leaveFor('/login');
            return;
          }

          clearRoleSession();
          const errorPath = resolution.reason === 'privileged_auth_required'
            ? '/login?error=privileged_auth_required'
            : resolution.reason === 'unsupported_role'
              ? '/login?error=unsupported_role'
              : '/login';
          leaveFor(errorPath);
          return;
        }

        const session = persistAuthoritativeRoleSession(resolution.session);
        if (!isRoleSessionAllowed(session, expectedRoles)) {
          leaveFor(resolution.destination);
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

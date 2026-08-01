'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

import {
  clearRoleSession,
  persistAuthoritativeRoleSession,
  resolveAuthoritativeRoleSession,
  type AuthoritativePilotSessionPayload,
} from './roleSession';
import { readBoardSeatsFromSession, type BoardSeatSlug } from '@/app/board/boardWorkspaceConfig';
import { apiBase } from '@/lib/apiBase';

export interface BoardSession {
  readonly role: 'board' | 'platform_owner';
  readonly seats: readonly BoardSeatSlug[];
}

// The board subtree resolves the session once, here, and hands the seats down.
// A seat workspace that fetched the session again could disagree with the gate
// that already admitted it, and the disagreement would be invisible.
const BoardSessionContext = createContext<BoardSession | null>(null);

export function useBoardSession(): BoardSession | null {
  return useContext(BoardSessionContext);
}

type GateState =
  | { status: 'checking' }
  | { status: 'retryable' }
  | { status: 'authorized'; session: BoardSession };

export default function BoardRoleGate({
  children,
}: Readonly<{ children: ReactNode }>) {
  const router = useRouter();
  const [gate, setGate] = useState<GateState>({ status: 'checking' });
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/auth/session`, {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });

        if (controller.signal.aborted) return;

        if (!response.ok) {
          if (response.status >= 500) {
            setGate({ status: 'retryable' });
            return;
          }
          clearRoleSession();
          router.replace('/login');
          return;
        }

        const payload = await response.json().catch(() => null) as AuthoritativePilotSessionPayload | null;
        if (controller.signal.aborted) return;

        const resolution = resolveAuthoritativeRoleSession(payload);
        if (!resolution.ok) {
          // A valid session still on the gym-issued starting PIN. Bouncing it
          // to /login would loop, because signing in again arrives back here.
          if (resolution.reason === 'pin_change_required') {
            router.replace('/change-pin');
            return;
          }

          clearRoleSession();
          router.replace(
            resolution.reason === 'privileged_auth_required'
              ? '/login?error=privileged_auth_required'
              : resolution.reason === 'unsupported_role'
                ? '/login?error=unsupported_role'
                : '/login',
          );
          return;
        }

        const { role } = resolution.session;
        if (role !== 'board' && role !== 'platform_owner') {
          // Signed in, just not to this surface. Their own dashboard is a
          // better answer than a login form they have already satisfied.
          persistAuthoritativeRoleSession(resolution.session);
          router.replace(resolution.destination);
          return;
        }

        persistAuthoritativeRoleSession(resolution.session);
        setGate({
          status: 'authorized',
          session: {
            role,
            // Seat assignments are an organization fact the server reports.
            // Platform owner holds no board seat and is never treated as one.
            seats: role === 'board' ? readBoardSeatsFromSession(payload) : [],
          },
        });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return;
        }
        setGate({ status: 'retryable' });
      }
    })();

    return () => controller.abort();
  }, [retryNonce, router]);

  if (gate.status !== 'authorized') {
    return (
      <main className="grid min-h-screen place-items-center bg-[#0a0a0a] px-6 text-[#e8d7c6]">
        <div className="text-center">
          <p className="text-xs font-mono uppercase tracking-[0.35em] text-[#d4a574]">
            Board Session
          </p>
          <h1 className="mt-3 text-3xl font-black tracking-tight">
            {gate.status === 'retryable' ? 'Unable to verify access' : 'Checking aggregate access'}
          </h1>
          {gate.status === 'retryable' && (
            <button
              type="button"
              onClick={() => setRetryNonce((value) => value + 1)}
              className="mt-5 min-h-[44px] border-2 border-[#8b4444] bg-[#2f1717] px-5 text-sm font-mono font-bold uppercase tracking-[0.12em] text-[#e8d7c6]"
            >
              Retry
            </button>
          )}
        </div>
      </main>
    );
  }

  return (
    <BoardSessionContext.Provider value={gate.session}>
      {children}
    </BoardSessionContext.Provider>
  );
}

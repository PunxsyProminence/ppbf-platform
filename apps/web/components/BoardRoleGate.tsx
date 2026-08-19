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
import useGymSound from './useGymSound';
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

  /* Law 7: a refusal is static ink that sits until somebody acts on it, and
     the stamp below is the whole message on its own. This is the same impact
     in the audio channel — a rubber stamp driven into paper, the physics of
     --e-stamp — fired by the stamp appearing rather than by the fetch failing,
     so the sound and the ink are the same event. Silent unless this browser
     opted in, which a board member at a desk plausibly has and a floor kiosk
     has not. */
  const { play } = useGymSound();
  const refused = gate.status === 'retryable';
  useEffect(() => {
    if (refused) {
      play('stamp');
    }
  }, [refused, play]);

  if (gate.status !== 'authorized') {
    return (
      <main className="room room--board grid min-h-screen place-items-center bg-[var(--hide-950)] px-[var(--s5)] text-[color:var(--bone-200)]">
        {/* The gate stands in the board room like everything behind it, and its
            interim states sit on raised leather so they carry their own ground
            wherever the wall's plaster/wainscot seam falls. */}
        <div className="mat-leather--raised max-w-xl rounded-[var(--r-lg)] p-[var(--s6)] text-center">
          <p className="t-eyebrow tracking-[0.35em]">
            Board Session
          </p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">
            {gate.status === 'retryable' ? 'Unable to verify access' : 'Checking aggregate access'}
          </h1>
          {gate.status === 'retryable' && (
            <>
              {/* Law 7: the refusal itself is static ink, not a toast. The
                  button below is the way back in; the stamp is the state. */}
              <p className="mt-[var(--s4)]">
                <span className="stamp stamp--flat">
                  <span aria-hidden="true">✕ </span>
                  <span>Not verified</span>
                </span>
              </p>
              <button
                type="button"
                onClick={() => setRetryNonce((value) => value + 1)}
                className="btn mt-[var(--s5)]"
              >
                Retry
              </button>
            </>
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

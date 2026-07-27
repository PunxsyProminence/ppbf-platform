'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

import {
  clearRoleSession,
  createPersistentRoleSession,
} from './roleSession';
import { apiBase } from '@/lib/apiBase';

export default function BoardRoleGate({
  children,
}: Readonly<{ children: ReactNode }>) {
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/auth/session`, {
          method: 'POST',
          credentials: 'include',
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null) as {
          authenticated?: unknown;
          role?: unknown;
        } | null;
        if (controller.signal.aborted) return;

        if (
          response.ok
          && payload?.authenticated === true
          && payload.role === 'board'
        ) {
          // Seat labels are display choices only. The server-authenticated
          // aggregate Board role is the sole browser session authority.
          createPersistentRoleSession('board');
          setAllowed(true);
          return;
        }

        if (
          response.ok
          && payload?.authenticated === true
          && typeof payload.role === 'string'
          && payload.role.startsWith('board-')
        ) {
          clearRoleSession();
          router.replace('/board');
          return;
        }

        clearRoleSession();
        router.replace('/login');
      } catch {
        if (controller.signal.aborted) return;
        clearRoleSession();
        router.replace('/login');
      }
    })();

    return () => controller.abort();
  }, [router]);

  if (!allowed) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#0a0a0a] px-6 text-[#e8d7c6]">
        <div className="text-center">
          <p className="text-xs font-mono uppercase tracking-[0.35em] text-[#d4a574]">
            Board Session
          </p>
          <h1 className="mt-3 text-3xl font-black tracking-tight">
            Checking aggregate access
          </h1>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  clearRoleSession,
  persistAuthoritativeRoleSession,
  loadAuthoritativeRoleSession,
} from '@/components/roleSession';
import { apiBase } from '@/lib/apiBase';

export default function DashboardEntryPage() {
  const router = useRouter();
  const [retryableForNonce, setRetryableForNonce] = useState<number | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const retryable = retryableForNonce === retryNonce;

  useEffect(() => {
    const controller = new AbortController();

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
            setRetryableForNonce(retryNonce);
            return;
          }
          clearRoleSession();
          router.replace('/login');
          return;
        }

        persistAuthoritativeRoleSession(resolution.session);
        router.replace(resolution.destination);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return;
        }
        setRetryableForNonce(retryNonce);
      }
    })();

    return () => controller.abort();
  }, [retryNonce, router]);

  return (
    <main className="min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col items-center justify-center px-6 py-10 text-center lg:px-10">
        <p className="text-xs font-mono uppercase tracking-[0.35em] text-[color:var(--brass-300)]">Dashboard Entry</p>
        <h1 className="mt-3 text-4xl font-black tracking-tight md:text-5xl">The Bell</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[color:var(--bone-400)] md:text-base">
          Your verified server session decides where you land.
        </p>
        {retryable && (
          <button
            type="button"
            onClick={() => setRetryNonce((value) => value + 1)}
            className="mt-5 min-h-[44px] border border-[color:var(--brass-700)] bg-[var(--hide-900)] px-5 text-sm font-black uppercase tracking-[0.12em] text-[color:var(--bone-200)]"
          >
            Retry
          </button>
        )}
      </div>
    </main>
  );
}

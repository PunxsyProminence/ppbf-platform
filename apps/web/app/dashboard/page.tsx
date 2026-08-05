'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
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
    /* Ink ground (Law 6): this is a staff-side routing hub, not a family
       surface. Most visitors see it for under a second before the redirect
       lands, so it reads as one riveted brass frame around a leather panel —
       the same wayfinding chassis the consoles use — rather than a bare page. */
    <main className="min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto flex min-h-screen w-full max-w-[610px] flex-col items-stretch justify-center px-[var(--s5)] py-[var(--s6)]">
        <div className="frame">
          <span className="rivet rivet--tl" />
          <span className="rivet rivet--tr" />
          <span className="rivet rivet--bl" />
          <span className="rivet rivet--br" />
          <div className="frame-in mat-leather text-center" style={{ padding: 'var(--s6)' }}>
            <p className="t-eyebrow tracking-[0.35em]">Dashboard Entry</p>
            <h1 className="t-command mt-[var(--s4)]" style={{ fontSize: 'var(--t-2xl)' }}>
              The Bell
            </h1>
            <p className="t-body mx-auto mt-[var(--s4)] max-w-[52ch]">
              Your verified server session decides where you land.
            </p>
            {retryable && (
              <div className="mt-[var(--s5)] grid justify-items-center gap-[var(--s4)]">
                {/* Law 3: the failed check carries a glyph and an uppercase
                    label, not colour alone. */}
                <span className="badge badge--locked">
                  <i>✕</i>Session check failed
                </span>
                <button
                  type="button"
                  onClick={() => setRetryNonce((value) => value + 1)}
                  className="btn"
                >
                  Retry
                </button>
                <Link href="/login" className="btn btn--ghost">
                  Back to sign in
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

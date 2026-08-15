'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

// Payments settings: the "Connect Stripe account" button
// (docs/PAYMENT_SERVICE_SLOT.md -- "Connecting an account is a button, not a
// copy-paste"). One slot per lane; connecting sends the admin to
// Stripe-hosted onboarding and the platform stores only the returned account
// id. Reconnecting swaps the account in place; disconnecting happens from
// the gym's own Stripe dashboard and lands here via webhook.
//
// Nothing on this page moves money. Charging does not exist in this
// repository and CAP-012 stays BLOCKED until the owner's compliance
// sign-off; what this page enables is onboarding, for this gym and for
// every future gym identically.

interface AccountRow {
  lane: 'giving' | 'program';
  stripe_account_id: string;
  status: 'connected' | 'disconnected';
  connected_at: string;
  revoked_at: string | null;
}

interface SetupStatus {
  ready: boolean;
  enabled: boolean;
  remainingSteps: string[];
}

const LANES: Array<{ lane: 'giving' | 'program'; label: string; description: string }> = [
  {
    lane: 'giving',
    label: 'Giving',
    description: 'Donations and recurring giving. Charitable, tax-deductible, receipted with the IRS no-goods-or-services language. Start this one first — its 501(c)(3) verification is the slow step and unlocks the nonprofit rate.',
  },
  {
    lane: 'program',
    label: 'Program',
    description: 'Class fees, merchandise, and B2B wholesale. Earned revenue in exchange for goods and services — not tax-deductible, ordinary receipt language.',
  },
];

const CONNECT_OUTCOMES: Record<string, string> = {
  ok: 'Stripe account connected.',
  denied: 'The connection was declined on Stripe’s side. Nothing was stored.',
  'state-mismatch': 'That connect link was stale or not started by this organization. Start again from this page.',
  'missing-code': 'Stripe returned without a code. Start again from this page.',
  'exchange-failed': 'Stripe refused the exchange. Start again; if it repeats, the platform credentials need checking.',
  'not-configured': 'The platform Stripe account is not registered yet.',
};

function PaymentsSettings() {
  const searchParams = useSearchParams();
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const connectOutcome = searchParams.get('connect');

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const [accountsResponse, setupResponse] = await Promise.all([
          fetch(`${apiBase()}/api/pilot/payments/accounts`, { credentials: 'include', signal: controller.signal }),
          fetch(`${apiBase()}/api/pilot/payments/setup-status`, { credentials: 'include', signal: controller.signal }),
        ]);
        if (!accountsResponse.ok || !setupResponse.ok) throw new Error('Unable to load payment settings.');
        const accountsPayload = (await accountsResponse.json()) as { items?: AccountRow[] };
        const setupPayload = (await setupResponse.json()) as SetupStatus;
        if (controller.signal.aborted) return;
        setAccounts(accountsPayload.items ?? []);
        setSetup(setupPayload);
        setErrorMessage(null);
        setLoading(false);
      } catch (error) {
        // An aborted load is the page unmounting, not a failure to report.
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load payment settings.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const accountFor = (lane: 'giving' | 'program') =>
    accounts.find((row) => row.lane === lane);

  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <main className="room--office min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Revenue</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Payment Accounts</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              Each lane connects its own Stripe account. Connecting happens on Stripe&rsquo;s side —
              this platform stores only the returned account id, never a key. Nothing charges until
              compliance sign-off; this page is setup only.
            </p>
          </header>

          {connectOutcome && CONNECT_OUTCOMES[connectOutcome] && (
            <div className={connectOutcome === 'ok' ? 'alert alert--info' : 'alert alert--critical'} role="status">
              <span className="alert-icon" aria-hidden="true">{connectOutcome === 'ok' ? '✓' : '✕'}</span>
              <div className="alert-body">
                <p className="alert-title">{connectOutcome === 'ok' ? 'Connected' : 'Not connected'}</p>
                <p className="alert-msg">{CONNECT_OUTCOMES[connectOutcome]}</p>
              </div>
            </div>
          )}

          {errorMessage && (
            <div className="alert alert--critical" role="alert">
              <span className="alert-icon" aria-hidden="true">✕</span>
              <div className="alert-body">
                <p className="alert-title">Failed</p>
                <p className="alert-msg">{errorMessage}</p>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-[var(--s7)]">
              <span className="working">Loading payment settings...</span>
            </div>
          ) : (
            <>
              <div className="grid gap-[var(--s4)] md:grid-cols-2">
                {LANES.map(({ lane, label, description }) => {
                  const row = accountFor(lane);
                  const connected = row?.status === 'connected';
                  return (
                    <section key={lane} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                      <div className="flex flex-wrap items-center gap-[var(--s3)]">
                        <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>{label}</h2>
                        {connected ? (
                          <span className="badge badge--cleared"><i aria-hidden="true">✓</i>connected</span>
                        ) : row?.status === 'disconnected' ? (
                          <span className="badge badge--locked"><i aria-hidden="true">✕</i>disconnected</span>
                        ) : (
                          <span className="badge badge--monitor"><i aria-hidden="true">◉</i>not connected</span>
                        )}
                      </div>
                      <p className="t-body mt-[var(--s3)]" style={{ fontSize: 'var(--t-sm)' }}>{description}</p>
                      {row && (
                        <p className="t-data mt-[var(--s3)]" style={{ fontSize: 'var(--t-xs)' }}>
                          Account {row.stripe_account_id}
                          {row.status === 'disconnected' ? ' — revoked from the Stripe dashboard; connect again to resume.' : ''}
                        </p>
                      )}
                      <div className="mt-[var(--s4)]">
                        <a
                          className="btn"
                          href={`${apiBase()}/api/pilot/payments/connect/start?lane=${lane}`}
                        >
                          {connected ? 'Swap Stripe account' : 'Connect Stripe account'}
                        </a>
                      </div>
                    </section>
                  );
                })}
              </div>

              {setup && setup.remainingSteps.length > 0 && (
                <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)]">
                  <h2 className="t-command" style={{ fontSize: 'var(--t-sm)' }}>Remaining setup</h2>
                  <ol className="t-body mt-[var(--s3)] list-decimal space-y-[var(--s2)] pl-[var(--s5)]" style={{ fontSize: 'var(--t-sm)' }}>
                    {setup.remainingSteps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </section>
              )}

              <p className="t-body mt-[var(--s4)] text-[color:var(--bone-300)]" style={{ fontSize: 'var(--t-sm)' }}>
                To disconnect, use the gym&rsquo;s own Stripe dashboard; the platform is notified and
                stops using the account immediately. Reconnecting or swapping is this page&rsquo;s button.
              </p>
            </>
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/admin" className="btn btn--ghost">Back to Admin</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}

// useSearchParams needs a Suspense boundary to prerender (same pattern as
// /auth/link and /login).
export default function PaymentsSettingsPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-[42rem] p-[var(--s6)]"><p className="t-body">Loading payment settings…</p></main>}>
      <PaymentsSettings />
    </Suspense>
  );
}

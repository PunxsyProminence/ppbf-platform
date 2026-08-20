'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { getRoleSessionSnapshot } from '@/components/roleSession';
import { apiBase } from '@/lib/apiBase';
import { DEFAULT_ACTIVATION_TTL_HOURS } from '@/src/server/pilot/activationPolicy';
import { formatGymStamp } from '@/src/lib/gymTime';

interface OutstandingActivationCodeItem {
  account_id: string;
  athlete_id: string | null;
  organization_id: string;
  issued_by_account_id: string;
  created_at: string;
  expires_at: string;
  is_expired: boolean;
}

interface IssuedCodeState {
  account_id: string;
  activation_code: string;
  expires_at: string;
}

function ActivationCodesConsoleContent() {
  const [codes, setCodes] = useState<OutstandingActivationCodeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Issue form state
  const [accountId, setAccountId] = useState('');
  const [ttlHours, setTtlHours] = useState<number>(DEFAULT_ACTIVATION_TTL_HOURS);
  const [issuing, setIssuing] = useState(false);
  const [issuedCode, setIssuedCode] = useState<IssuedCodeState | null>(null);
  const [issueError, setIssueError] = useState('');

  const loadCodes = useCallback(async () => {
    setError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/activation-codes`, {
        method: 'GET',
        credentials: 'include',
      });

      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        codes?: OutstandingActivationCodeItem[];
        error?: string;
      };

      if (!response.ok || !payload.ok || !Array.isArray(payload.codes)) {
        throw new Error(payload.error || 'Unable to load outstanding activation codes');
      }

      setCodes(payload.codes);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load activation codes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCodes();
  }, [loadCodes]);

  async function submitIssueCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIssueError('');
    setIssuedCode(null);

    const targetAccountId = accountId.trim();
    if (!targetAccountId) {
      setIssueError('Account ID is required.');
      return;
    }

    setIssuing(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/activation-codes`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: targetAccountId,
          ttl_hours: ttlHours,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        account_id?: string;
        activation_code?: string;
        expires_at?: string;
        error?: string;
      };

      if (!response.ok || !payload.ok || !payload.activation_code) {
        throw new Error(payload.error || 'Failed to issue activation code');
      }

      setIssuedCode({
        account_id: payload.account_id || targetAccountId,
        activation_code: payload.activation_code,
        expires_at: payload.expires_at || '',
      });
      setAccountId('');
      setLoading(true);
      await loadCodes();
    } catch (submitErr) {
      setIssueError(submitErr instanceof Error ? submitErr.message : 'Failed to issue activation code');
    } finally {
      setIssuing(false);
    }
  }

  return (
    <main className="room room--office min-h-screen bg-[var(--hide-950)] px-[var(--s4)] py-[var(--s5)] text-[color:var(--bone-200)] sm:px-[var(--s5)]">
      <div className="mx-auto w-full max-w-4xl space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
          <p className="t-eyebrow">Gym Admin Activation Control</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>
            Issue Athlete Activation Codes
          </h1>
          <p className="t-body mt-[var(--s3)]">
            Issue one-time 12-character activation codes for pending athlete accounts. The code is shown exactly once and cannot be re-displayed later.
          </p>
        </header>

        {error && (
          <div
            className="rounded-[var(--r-md)] border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-[var(--s4)] py-[var(--s3)] text-[length:var(--t-sm)] text-[color:var(--locked-ink)]"
            role="alert"
          >
            {error}
          </div>
        )}

        <div className="grid gap-[var(--s5)] lg:grid-cols-[1.618fr_1fr]">
          <section className="frame">
            <span className="rivet rivet--tl" />
            <span className="rivet rivet--tr" />
            <span className="rivet rivet--bl" />
            <span className="rivet rivet--br" />
            <div className="frame-in mat-leather p-[var(--s4)]">
              <h2 className="t-eyebrow">Outstanding Activation Codes</h2>
              {loading ? (
                <p className="t-body mt-[var(--s4)]">Loading activation codes...</p>
              ) : (
                <ul className="mt-[var(--s3)] space-y-[var(--s2)]">
                  {codes.map((item) => {
                    const statusLabel = item.is_expired ? 'Expired' : 'Pending Redemption';
                    return (
                      <li
                        key={item.account_id}
                        className="mat-leather rounded-[var(--r-md)] border border-[color:var(--hide-700)] p-[var(--s3)]"
                      >
                        <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">
                          Account: {item.account_id}
                        </p>
                        {item.athlete_id && (
                          <p className="t-data mt-[var(--s1)] text-[color:var(--bone-400)]">
                            Athlete Record: {item.athlete_id}
                          </p>
                        )}
                        <p className="t-data mt-[var(--s1)] text-[color:var(--bone-400)]">
                          Issued by: {item.issued_by_account_id}
                        </p>
                        <p className="t-data mt-[var(--s1)] text-[color:var(--bone-400)]">
                          Expires: {formatGymStamp(item.expires_at)}
                        </p>
                        <p className="mt-[var(--s2)]">
                          <span
                            className={`badge ${item.is_expired ? 'badge--restricted' : 'badge--cleared'}`}
                          >
                            <i>{item.is_expired ? '▲' : '✓'}</i>
                            {statusLabel}
                          </span>
                        </p>
                      </li>
                    );
                  })}
                  {codes.length === 0 && (
                    <li className="t-body mt-[var(--s2)]">No outstanding activation codes for this organization.</li>
                  )}
                </ul>
              )}
            </div>
          </section>

          <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s4)]">
            <h2 className="t-eyebrow">Issue New Code</h2>
            <form className="mt-[var(--s3)] space-y-[var(--s3)]" onSubmit={submitIssueCode}>
              <div className="field">
                <label htmlFor="issue-account-id" className="t-label">
                  Athlete Account ID
                </label>
                <input
                  id="issue-account-id"
                  type="text"
                  value={accountId}
                  onChange={(event) => setAccountId(event.target.value)}
                  className="input font-mono"
                  placeholder="e.g. ath-001"
                />
              </div>

              <div className="field">
                <label htmlFor="issue-ttl-hours" className="t-label">
                  Expiration (Hours)
                </label>
                <input
                  id="issue-ttl-hours"
                  type="number"
                  min={1}
                  max={2160}
                  value={ttlHours}
                  onChange={(event) => setTtlHours(Number.parseInt(event.target.value, 10) || DEFAULT_ACTIVATION_TTL_HOURS)}
                  className="input font-mono"
                />
              </div>

              {issueError && (
                <p
                  className="rounded-[var(--r-md)] border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-[var(--s3)] py-[var(--s2)] text-[length:var(--t-sm)] text-[color:var(--locked-ink)]"
                  role="alert"
                >
                  {issueError}
                </p>
              )}

              {issuedCode && (
                <div className="rounded-[var(--r-md)] border border-[color:var(--cleared)] bg-[color-mix(in_srgb,var(--cleared)_16%,var(--hide-950))] p-[var(--s4)] space-y-[var(--s2)]">
                  <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--cleared-ink)]">
                    ✓ Code Issued Successfully
                  </p>
                  <p className="t-data text-[color:var(--bone-300)]">Account: {issuedCode.account_id}</p>
                  <div className="rounded-[var(--r-sm)] border border-[color:rgba(255,255,255,.2)] bg-[var(--hide-950)] p-[var(--s3)] text-center">
                    <p className="t-label text-[color:var(--brass-500)]">Activation Code</p>
                    <p className="mt-[var(--s1)] font-mono text-[length:var(--t-lg)] font-bold tracking-widest text-[color:var(--bone-100)]">
                      {issuedCode.activation_code}
                    </p>
                  </div>
                  <p className="text-[length:var(--t-xs)] text-[color:var(--brass-400)] font-semibold">
                    ▲ Write down or print this code now. It is shown ONCE and cannot be recovered later.
                  </p>
                </div>
              )}

              <button
                type="submit"
                disabled={issuing || !accountId.trim()}
                className="btn w-full disabled:cursor-not-allowed disabled:opacity-50"
              >
                {issuing ? 'Issuing...' : 'Issue Activation Code'}
              </button>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}

function WrongRoleNotice() {
  return (
    <main className="room room--office room--lit-center grid min-h-screen place-items-center bg-[var(--hide-950)] px-[var(--s5)] text-[color:var(--bone-200)]">
      <div className="mx-auto max-w-xl space-y-[var(--s5)] text-center">
        <p className="t-eyebrow">Different Console</p>
        <h1 className="t-command" style={{ fontSize: 'var(--t-xl)' }}>
          Activation codes are managed per gym
        </h1>
        <p className="t-body">
          This console issues activation codes for individual athletes, which belongs to that gym&apos;s administrator. As platform owner you create organizations and appoint their admins.
        </p>
        <Link href="/admin/platform" className="btn btn--ghost">
          Platform console
        </Link>
      </div>
    </main>
  );
}

function ActivationCodesRoleSwitch({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = getRoleSessionSnapshot();

  if (session?.role === 'platform_owner') {
    return <WrongRoleNotice />;
  }

  return <>{children}</>;
}

export default function ActivationCodesManagementPage() {
  return (
    <RoleSessionGate allowedRoles={['admin', 'platform_owner']}>
      <ActivationCodesRoleSwitch>
        <ActivationCodesConsoleContent />
      </ActivationCodesRoleSwitch>
    </RoleSessionGate>
  );
}

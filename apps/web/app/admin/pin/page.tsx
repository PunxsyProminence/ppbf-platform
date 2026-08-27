'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { getRoleSessionSnapshot } from '@/components/roleSession';
import { apiBase } from '@/lib/apiBase';

interface AthletePinItem {
  athlete_id: string;
  full_name: string;
  account_id: string | null;
  account_active: boolean | null;
  has_pin: boolean;
  account_updated_at: string | null;
}

/* THIS DESK STOPPED ISSUING PINS, AND THE PAGE HAD NOT NOTICED.
   ------------------------------------------------------------------------
   It used to POST {account_id, pin, mode} and tell the administrator to read
   the PIN out to the athlete. The shared-PIN retirement rewrote
   /api/pilot/admin/accounts/pin-reset to read ONLY account_id and answer with
   a one-time activation code; `pin` and `mode` are ignored.

   So every click here did this: the typed PIN was discarded, the athlete's
   account was DEACTIVATED and their sessions revoked (the route's reset path),
   an activation code was minted and returned -- and this page dropped it on
   the floor, because nothing in it read the response body. The athlete was
   locked out, the administrator was told "PIN activated. Tell the athlete this
   PIN", and the one credential that could have let them back in was gone.

   The page now does what the route does: it issues a code and shows it once. */
type IssuedCode = { code: string; expiresAt: string | null; athleteName: string };

function PinManagementPageContent() {
  const [items, setItems] = useState<AthletePinItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedAthleteId, setSelectedAthleteId] = useState('');
  const [issued, setIssued] = useState<IssuedCode | null>(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [createAccountId, setCreateAccountId] = useState('');
  const [createError, setCreateError] = useState('');
  const [createSuccess, setCreateSuccess] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  const selectedItem = useMemo(
    () => items.find((item) => item.athlete_id === selectedAthleteId) ?? null,
    [items, selectedAthleteId],
  );

  const loadDirectory = useCallback(async () => {
    setError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/athlete-pin-directory`, {
        method: 'GET',
        credentials: 'include',
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        items?: AthletePinItem[];
        error?: string;
      };

      if (!response.ok || !payload.ok || !Array.isArray(payload.items)) {
        throw new Error(payload.error || 'Unable to load athlete list');
      }

      const nextItems = payload.items;
      setItems(nextItems);
      setSelectedAthleteId((previous) => previous || nextItems[0]?.athlete_id || '');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load athlete list');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDirectory();
  }, [loadDirectory]);

  async function submitPinAction(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSuccess('');
    setIssued(null);

    if (!selectedItem?.account_id) {
      setError('This athlete does not have a linked account ID yet.');
      return;
    }

    setSaving(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/accounts/pin-reset`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // account_id ONLY. The route ignores anything else, and sending a PIN
        // it will not store is how this page came to lie about what it did.
        body: JSON.stringify({ account_id: selectedItem.account_id }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        activation_code?: string;
        expires_at?: string | null;
      };

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Could not issue an activation code');
      }

      // The account has just been deactivated and its sessions revoked, and
      // this code is the only way back in. If it did not arrive, say so
      // loudly rather than reporting success -- an administrator who walks
      // away from this screen without the code has locked the athlete out.
      if (!payload.activation_code) {
        throw new Error(
          'The code did not come back. This athlete is now deactivated and cannot sign in. '
          + 'Issue another code from Activation Codes before they next come to the gym.',
        );
      }

      setIssued({
        code: payload.activation_code,
        expiresAt: payload.expires_at ?? null,
        athleteName: selectedItem.full_name,
      });
      setLoading(true);
      await loadDirectory();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not issue an activation code');
    } finally {
      setSaving(false);
    }
  }

  // The missing first step of the workflow this page always implied: an
  // athlete with no account row cannot have a PIN activated, and until now
  // creating that row had no UI at all (re-landed from PR #20).
  async function submitCreateAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateError('');
    setCreateSuccess('');

    const athleteId = selectedAthleteId.trim();
    const accountId = createAccountId.trim();

    if (!athleteId) {
      setCreateError('Select an athlete first.');
      return;
    }
    if (!accountId) {
      setCreateError('Account ID is required.');
      return;
    }
    if (selectedItem?.account_id) {
      setCreateError('This athlete already has a linked account. Use Activate or Reset PIN instead.');
      return;
    }

    setCreateBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/athlete-accounts`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId,
          athlete_id: athleteId,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Unable to create athlete account');
      }

      setCreateAccountId('');
      setCreateSuccess('Athlete account created. Next step: activate PIN.');
      setLoading(true);
      await loadDirectory();
    } catch (createAccountError) {
      setCreateError(createAccountError instanceof Error ? createAccountError.message : 'Unable to create athlete account');
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <main className="room room--office min-h-screen bg-[var(--hide-950)] px-[var(--s4)] py-[var(--s5)] text-[color:var(--bone-200)] sm:px-[var(--s5)]">
      <div className="mx-auto w-full max-w-4xl space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
          <p className="t-eyebrow">Gym Admin Credential Control</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Issue an Athlete Activation Code</h1>
          <p className="t-body mt-[var(--s3)]">
            Select an athlete and issue a one-time code. They redeem it and choose a PIN only they
            know -- no administrator sets or sees an athlete&apos;s PIN.
          </p>
        </header>

        <div className="grid gap-[var(--s5)] lg:grid-cols-[1.618fr_1fr]">
          <section className="frame">
            <span className="rivet rivet--tl" />
            <span className="rivet rivet--tr" />
            <span className="rivet rivet--bl" />
            <span className="rivet rivet--br" />
            <div className="frame-in mat-leather p-[var(--s4)]">
            <h2 className="t-eyebrow">Athlete / User List</h2>
            {loading ? (
              <p className="t-body mt-[var(--s4)]">Loading athletes...</p>
            ) : (
              <ul className="mt-[var(--s3)] space-y-[var(--s2)]">
                {items.map((item) => {
                  const selected = selectedAthleteId === item.athlete_id;
                  const statusLabel = !item.account_id
                    ? 'No account'
                    : !item.account_active
                      ? 'Inactive'
                      : item.has_pin
                        ? 'Active'
                        : 'No PIN';
                  return (
                    <li key={item.athlete_id}>
                      <button
                        type="button"
                        onClick={() => setSelectedAthleteId(item.athlete_id)}
                        className={`w-full rounded-[var(--r-md)] border px-[var(--s3)] py-[var(--s3)] text-left transition ${
                          selected
                            ? 'mat-leather--raised border-[color:var(--brass-400)] bg-[rgb(var(--brass-400-rgb)_/_.07)]'
                            : 'mat-leather border-[color:var(--hide-700)] hover:border-[color:var(--brass-700)]'
                        }`}
                      >
                        <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">{item.full_name}</p>
                        <p className="t-data mt-[var(--s2)] text-[color:var(--bone-400)]">Athlete ID: {item.athlete_id}</p>
                        <p className="t-data mt-[var(--s1)] text-[color:var(--bone-400)]">Account ID: {item.account_id ?? 'Unlinked'}</p>
                        <p className="mt-[var(--s2)]">
                          {/* Credential states ride the badge ladder: a key
                              that works is cleared, a pending or missing key
                              is restricted, a switched-off account is locked. */}
                          <span
                            className={`badge ${
                              statusLabel === 'Active'
                                ? 'badge--cleared'
                                : statusLabel === 'Inactive'
                                  ? 'badge--locked'
                                  : 'badge--restricted'
                            }`}
                          >
                            <i>{statusLabel === 'Active' ? '✓' : statusLabel === 'Inactive' ? '✕' : '▲'}</i>
                            {statusLabel}
                          </span>
                        </p>
                      </button>
                    </li>
                  );
                })}
                {items.length === 0 && <li className="t-body">No athletes found in this organization.</li>}
              </ul>
            )}
            </div>
          </section>

          <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s4)]">
            <h2 className="t-eyebrow">PIN Action</h2>
            <form className="mt-[var(--s3)] space-y-[var(--s3)] border-b border-[color:var(--hide-600)] pb-[var(--s4)]" onSubmit={submitCreateAccount}>
              <h3 className="t-command" style={{ fontSize: 'var(--t-sm)' }}>Create Athlete Account</h3>
              <p className="t-muted">Creates a pending account for the selected athlete. Then run Activate PIN.</p>
              <div className="field">
                <label htmlFor="create-account-id" className="t-label">
                  New Account ID
                </label>
                <input
                  id="create-account-id"
                  type="text"
                  value={createAccountId}
                  onChange={(event) => setCreateAccountId(event.target.value)}
                  className="input font-mono"
                  placeholder="athlete-account-id"
                />
              </div>

              {createError && (
                <div role="alert" className="alert alert--critical alert--tight">
                  <span className="alert-icon" aria-hidden="true">✕</span>
                  <div className="alert-body">
                    <p className="alert-msg">{createError}</p>
                  </div>
                </div>
              )}
              {createSuccess && (
                <div className="alert alert--success alert--tight">
                  <span className="alert-icon" aria-hidden="true">✓</span>
                  <div className="alert-body">
                    <p className="alert-msg">{createSuccess}</p>
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={createBusy || !selectedAthleteId || !!selectedItem?.account_id}
                className="btn btn--ghost w-full disabled:cursor-not-allowed disabled:opacity-50"
              >
                {createBusy ? 'Creating...' : 'Create Athlete Account'}
              </button>
            </form>

            <form className="mt-[var(--s3)] space-y-[var(--s3)]" onSubmit={submitPinAction}>
              <p className="t-body">
                Issues a one-time activation code for{' '}
                <strong>{selectedItem?.full_name ?? 'the selected athlete'}</strong>. This
                deactivates the account and revokes every open session, so the athlete cannot
                sign in until they redeem the code and choose their own PIN.
              </p>
              <p className="t-body">
                You will never see their PIN. Nobody but the athlete ever knows it.
              </p>

              {error && (
                <div role="alert" className="alert alert--critical alert--tight">
                  <span className="alert-icon" aria-hidden="true">✕</span>
                  <div className="alert-body">
                    <p className="alert-msg">{error}</p>
                  </div>
                </div>
              )}
              {success && (
                <div className="alert alert--success alert--tight">
                  <span className="alert-icon" aria-hidden="true">✓</span>
                  <div className="alert-body">
                    <p className="alert-msg">{success}</p>
                  </div>
                </div>
              )}

              {/* THE CODE ITSELF. This block is the whole repair: the route has
                  been returning it all along and this page discarded it, so the
                  athlete was left deactivated with no way back.

                  role="status" and aria-live so a screen-reader administrator is
                  told it arrived -- it appears without any navigation, and an
                  announcement is the only way they learn it is on screen. */}
              {issued && (
                <div
                  role="status"
                  aria-live="polite"
                  className="mat-leather--raised rounded-[var(--r-md)] border border-[color:var(--brass-400)] p-[var(--s4)]"
                >
                  <p className="t-eyebrow">One-time code for {issued.athleteName}</p>
                  <p className="t-data mt-[var(--s3)] select-all break-all text-[color:var(--bone-100)]" style={{ fontSize: 'var(--t-lg)' }}>
                    {issued.code}
                  </p>
                  <p className="t-body mt-[var(--s3)]">
                    Write it down or hand it over now. It is shown once, it works once, and it
                    cannot be read back from anywhere.
                  </p>
                  {issued.expiresAt && (
                    <p className="t-data mt-[var(--s2)] text-[color:var(--bone-400)]">
                      Expires {issued.expiresAt}
                    </p>
                  )}
                  <p className="t-body mt-[var(--s3)]">
                    The athlete redeems it at <strong>/activate</strong> and chooses their own PIN.
                    Until they do, they cannot sign in.
                  </p>
                  <button
                    type="button"
                    onClick={() => setIssued(null)}
                    className="btn btn--ghost mt-[var(--s3)] w-full"
                  >
                    Done — I have written it down
                  </button>
                </div>
              )}

              <button
                type="submit"
                disabled={saving || !selectedItem?.account_id}
                className="btn w-full disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? 'Issuing...' : 'Issue Activation Code'}
              </button>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}

/**
 * Shown to a platform owner who reaches this console. Every route behind it is
 * organization-scoped and refuses that role by design -- athlete credentials
 * belong to the gym's own administrator. Without this they would see a desk
 * whose every request failed, which is the pattern this codebase keeps having
 * to remove.
 */
function WrongRoleNotice() {
  return (
    <main className="room room--office room--lit-center grid min-h-screen place-items-center bg-[var(--hide-950)] px-[var(--s5)] text-[color:var(--bone-200)]">
      <div className="mx-auto max-w-xl space-y-[var(--s5)] text-center">
        <p className="t-eyebrow">Different Desk</p>
        <h1 className="t-command" style={{ fontSize: 'var(--t-xl)' }}>Athlete PINs are managed per gym</h1>
        <p className="t-body">
          This desk issues and resets the credentials of individual athletes, which belongs to that
          gym&apos;s administrator. As platform owner you create organizations and appoint their admins.
        </p>
        <Link href="/admin/platform" className="btn btn--ghost">
          The platform desk
        </Link>
      </div>
    </main>
  );
}

// RoleSessionGate admits both admin flavours; this narrows to the one whose
// APIs will actually answer.
function PinConsoleRoleSwitch({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = getRoleSessionSnapshot();

  if (session?.role === 'platform_owner') {
    return <WrongRoleNotice />;
  }

  return <>{children}</>;
}

export default function PinManagementPage() {
  return (
    <RoleSessionGate allowedRoles={['admin', 'platform_owner']}>
      <PinConsoleRoleSwitch>
      <PinManagementPageContent />
      </PinConsoleRoleSwitch>
    </RoleSessionGate>
  );
}

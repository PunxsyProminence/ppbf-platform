'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { getRoleSessionSnapshot } from '@/components/roleSession';
import { apiBase } from '@/lib/apiBase';
import { DEFAULT_PIN_LENGTH } from '@/src/server/pilot/pinPolicy';

interface AthletePinItem {
  athlete_id: string;
  full_name: string;
  account_id: string | null;
  account_active: boolean | null;
  has_pin: boolean;
  account_updated_at: string | null;
}

type PinActionMode = 'activate' | 'reset';

const PIN_REGEX = /^\d{6}$/;

function PinManagementPageContent() {
  const [items, setItems] = useState<AthletePinItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedAthleteId, setSelectedAthleteId] = useState('');
  const [mode, setMode] = useState<PinActionMode>('activate');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
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

    if (!selectedItem?.account_id) {
      setError('This athlete does not have a linked account ID yet.');
      return;
    }

    if (!PIN_REGEX.test(pin)) {
      setError('PIN must be exactly 6 digits.');
      return;
    }

    if (pin !== confirmPin) {
      setError('PIN and confirmation do not match.');
      return;
    }

    setSaving(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/accounts/pin-reset`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: selectedItem.account_id,
          pin,
          mode,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'PIN operation failed');
      }

      setPin('');
      setConfirmPin('');
      // Both messages now say what the athlete has to do next, because both
      // paths set must_change_pin: the PIN typed on this screen is one the
      // administrator knows, so it gets the athlete in once and no further.
      // Saying only "activated successfully" left an admin telling a kid a
      // PIN and believing that was the end of it.
      setSuccess(
        mode === 'activate'
          ? 'PIN activated. Tell the athlete this PIN -- they will be asked to choose their own the first time they sign in, and it will not work for anything else until they do.'
          : 'PIN reset successfully. Existing sessions were revoked, and the athlete will be asked to choose their own PIN on their next sign-in.',
      );
      setLoading(true);
      await loadDirectory();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'PIN operation failed');
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
          <p className="t-eyebrow">Gym Admin PIN Control</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Activate or Reset Athlete PIN</h1>
          <p className="t-body mt-[var(--s3)]">
            Select an athlete, choose activate or reset, then save a 6-digit PIN. Stored PIN values are never displayed.
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
              <fieldset className="space-y-[var(--s2)]">
                <legend className="t-label">Action</legend>
                <label className="flex items-center gap-[var(--s2)] text-[length:var(--t-sm)] text-[color:var(--bone-200)]">
                  <input
                    type="radio"
                    name="pin-mode"
                    value="activate"
                    checked={mode === 'activate'}
                    onChange={() => setMode('activate')}
                    className="accent-[var(--brass-500)]"
                  />
                  Activate PIN
                </label>
                <label className="flex items-center gap-[var(--s2)] text-[length:var(--t-sm)] text-[color:var(--bone-200)]">
                  <input
                    type="radio"
                    name="pin-mode"
                    value="reset"
                    checked={mode === 'reset'}
                    onChange={() => setMode('reset')}
                    className="accent-[var(--brass-500)]"
                  />
                  Reset PIN
                </label>
              </fieldset>

              <div className="field">
                <label htmlFor="pin-value" className="t-label">
                  Enter PIN
                </label>
                <input
                  id="pin-value"
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={pin}
                  maxLength={DEFAULT_PIN_LENGTH}
                  onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, DEFAULT_PIN_LENGTH))}
                  className="input font-mono"
                  placeholder="6 digits"
                  autoComplete="new-password"
                />
              </div>

              <div className="field">
                <label htmlFor="pin-confirm" className="t-label">
                  Confirm PIN
                </label>
                <input
                  id="pin-confirm"
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={confirmPin}
                  maxLength={DEFAULT_PIN_LENGTH}
                  onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, '').slice(0, DEFAULT_PIN_LENGTH))}
                  className="input font-mono"
                  placeholder="Repeat 6 digits"
                  autoComplete="new-password"
                />
              </div>

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

              <button
                type="submit"
                disabled={saving || !selectedItem?.account_id}
                className="btn w-full disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? 'Saving...' : mode === 'activate' ? 'Activate PIN' : 'Reset PIN'}
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

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

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
  const [createError, setCreateError] = useState('');
  const [createSuccess, setCreateSuccess] = useState('');
  const [createAccountId, setCreateAccountId] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [selectedAthleteId, setSelectedAthleteId] = useState('');
  const [mode, setMode] = useState<PinActionMode>('activate');
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');

  const selectedItem = useMemo(
    () => items.find((item) => item.athlete_id === selectedAthleteId) ?? null,
    [items, selectedAthleteId],
  );

  const loadDirectory = useCallback(async () => {
    setError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/athlete-pin-directory`, {
        method: 'GET',
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
      setSuccess(mode === 'activate' ? 'PIN activated successfully.' : 'PIN reset successfully. Existing sessions were revoked.');
      setLoading(true);
      await loadDirectory();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'PIN operation failed');
    } finally {
      setSaving(false);
    }
  }

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
    <main className="min-h-screen bg-[var(--canvas-tan)] px-4 py-6 text-[var(--black)] sm:px-6">
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <header className="rounded-2xl border border-[rgba(0,0,0,0.16)] bg-white p-5 shadow-[var(--shadow-md)]">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--red-primary)]">Gym Admin PIN Control</p>
          <h1 className="mt-2 text-2xl font-black tracking-tight">Activate or Reset Athlete PIN</h1>
          <p className="mt-2 text-sm text-[var(--gray-dark)]">
            Select an athlete, choose activate or reset, then save a 6-digit PIN. Stored PIN values are never displayed.
          </p>
        </header>

        <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
          <section className="rounded-2xl border border-[rgba(0,0,0,0.14)] bg-white p-4 shadow-[var(--shadow-sm)]">
            <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--gray-dark)]">Athlete / User List</h2>
            {loading ? (
              <p className="mt-4 text-sm">Loading athletes...</p>
            ) : (
              <ul className="mt-3 space-y-2">
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
                        className={`w-full rounded-xl border px-3 py-3 text-left transition ${
                          selected
                            ? 'border-[var(--red-primary)] bg-[rgba(184,59,52,0.08)]'
                            : 'border-[rgba(0,0,0,0.14)] bg-white hover:border-[rgba(0,0,0,0.3)]'
                        }`}
                      >
                        <p className="text-sm font-semibold">{item.full_name}</p>
                        <p className="mt-1 text-xs text-[var(--gray-dark)]">Athlete ID: {item.athlete_id}</p>
                        <p className="mt-1 text-xs text-[var(--gray-dark)]">Account ID: {item.account_id ?? 'Unlinked'}</p>
                        <p className="mt-1 text-xs font-semibold uppercase tracking-[0.1em] text-[var(--red-primary)]">{statusLabel}</p>
                      </button>
                    </li>
                  );
                })}
                {items.length === 0 && <li className="text-sm text-[var(--gray-dark)]">No athletes found in this organization.</li>}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border border-[rgba(0,0,0,0.14)] bg-white p-4 shadow-[var(--shadow-sm)]">
            <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-[var(--gray-dark)]">PIN Action</h2>
            <form className="mt-3 space-y-3 border-b border-[rgba(0,0,0,0.1)] pb-4" onSubmit={submitCreateAccount}>
              <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--gray-dark)]">Create Athlete Account</h3>
              <p className="text-xs text-[var(--gray-dark)]">Creates a pending account for the selected athlete. Then run Activate PIN.</p>
              <div>
                <label htmlFor="create-account-id" className="block text-xs font-semibold uppercase tracking-[0.15em] text-[var(--gray-dark)]">
                  New Account ID
                </label>
                <input
                  id="create-account-id"
                  type="text"
                  value={createAccountId}
                  onChange={(event) => setCreateAccountId(event.target.value)}
                  className="mt-1 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.14)] px-3"
                  placeholder="athlete-account-id"
                />
              </div>

              {createError && <p className="rounded-lg border border-[var(--red-primary)] bg-[rgba(184,59,52,0.06)] px-3 py-2 text-sm" role="alert">{createError}</p>}
              {createSuccess && <p className="rounded-lg border border-[rgba(16,120,40,0.5)] bg-[rgba(16,120,40,0.1)] px-3 py-2 text-sm">{createSuccess}</p>}

              <button
                type="submit"
                disabled={createBusy || !selectedAthleteId || !!selectedItem?.account_id}
                className="min-h-[48px] w-full rounded-xl border border-[var(--black)] bg-[var(--black)] px-4 text-sm font-black uppercase tracking-[0.12em] text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {createBusy ? 'Creating...' : 'Create Athlete Account'}
              </button>
            </form>

            <form className="mt-3 space-y-3" onSubmit={submitPinAction}>
              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase tracking-[0.15em] text-[var(--gray-dark)]">Action</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="pin-mode"
                    value="activate"
                    checked={mode === 'activate'}
                    onChange={() => setMode('activate')}
                  />
                  Activate PIN
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="pin-mode"
                    value="reset"
                    checked={mode === 'reset'}
                    onChange={() => setMode('reset')}
                  />
                  Reset PIN
                </label>
              </fieldset>

              <div>
                <label htmlFor="pin-value" className="block text-xs font-semibold uppercase tracking-[0.15em] text-[var(--gray-dark)]">
                  Enter PIN
                </label>
                <input
                  id="pin-value"
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={pin}
                  onChange={(event) => setPin(event.target.value)}
                  className="mt-1 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.14)] px-3"
                  placeholder="6 digits"
                  autoComplete="new-password"
                />
              </div>

              <div>
                <label htmlFor="pin-confirm" className="block text-xs font-semibold uppercase tracking-[0.15em] text-[var(--gray-dark)]">
                  Confirm PIN
                </label>
                <input
                  id="pin-confirm"
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={confirmPin}
                  onChange={(event) => setConfirmPin(event.target.value)}
                  className="mt-1 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.14)] px-3"
                  placeholder="Repeat 6 digits"
                  autoComplete="new-password"
                />
              </div>

              {error && <p className="rounded-lg border border-[var(--red-primary)] bg-[rgba(184,59,52,0.06)] px-3 py-2 text-sm" role="alert">{error}</p>}
              {success && <p className="rounded-lg border border-[rgba(16,120,40,0.5)] bg-[rgba(16,120,40,0.1)] px-3 py-2 text-sm">{success}</p>}

              <button
                type="submit"
                disabled={saving || !selectedItem?.account_id}
                className="min-h-[50px] w-full rounded-xl border border-[var(--red-primary)] bg-[var(--red-primary)] px-4 text-sm font-black uppercase tracking-[0.16em] text-white disabled:cursor-not-allowed disabled:opacity-50"
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

export default function PinManagementPage() {
  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <PinManagementPageContent />
    </RoleSessionGate>
  );
}

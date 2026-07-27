'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { isOrganizationAdminSessionRole, usePilotSession } from '@/components/usePilotSession';
import { apiBase } from '@/lib/apiBase';

interface Member {
  account_id: string;
  login_email: string | null;
  auth_provider: 'ppbf_local' | 'microsoft';
  role: string;
  athlete_id: string | null;
  active_flag: boolean;
  has_pin: boolean;
  membership_active: boolean;
}

interface OutstandingCode {
  account_id: string;
  athlete_id: string | null;
  created_at: string;
  expires_at: string;
  is_expired: boolean;
}

type Tab = 'people' | 'invite-staff' | 'add-athlete';

const STAFF_ROLES = [
  { value: 'coach', label: 'Coach', blurb: 'Works with assigned athletes; sees their sessions and notes.' },
  { value: 'staff', label: 'Staff', blurb: 'General gym staff without coaching assignments.' },
  { value: 'volunteer', label: 'Volunteer', blurb: 'Limited helper access.' },
  { value: 'parent', label: 'Parent / Guardian', blurb: 'Sees only the athletes they are linked to.' },
];

function roleLabel(role: string): string {
  if (role === 'organization_admin' || role === 'admin') return 'Gym Admin';
  if (role === 'platform_owner') return 'Platform Owner';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * Describes whether a person can actually sign in right now, which is the
 * question an admin is really asking when they look at this list. A row can
 * exist and still be unusable in two very different ways, and they have
 * different fixes.
 */
function signInStatus(member: Member): { label: string; tone: 'ok' | 'pending' | 'blocked' } {
  if (!member.active_flag || !member.membership_active) {
    return { label: 'Deactivated', tone: 'blocked' };
  }

  if (member.auth_provider === 'microsoft') {
    return { label: 'Signs in with Microsoft', tone: 'ok' };
  }

  if (!member.has_pin) {
    return { label: 'Has not set a PIN yet', tone: 'pending' };
  }

  return { label: 'PIN set', tone: 'ok' };
}

/**
 * Shown when someone reaches this page whose role cannot use it -- in
 * practice a platform owner arriving by bookmark or typed URL, since the
 * header entry point is hidden for them.
 *
 * Every route behind this console is organization-scoped and rejects a
 * platform owner by design: managing a gym's roster belongs to that gym's
 * admin. Rather than let the roster fetch fail with a bare "Forbidden", say
 * why and point at the surface that does the caller's job.
 */
function WrongRoleNotice() {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-6 text-[var(--black)]">
      <div className="mx-auto max-w-xl space-y-5 text-center">
        <p className="text-xs font-mono uppercase tracking-[0.3em] text-[var(--red-primary)]">Different Console</p>
        <h1 className="font-display text-3xl font-black">People is managed per gym</h1>
        <p className="text-sm leading-7 text-[var(--gray-dark)]">
          This console belongs to a gym admin — it manages one organization&apos;s coaches, staff, and athletes. As
          platform owner you create organizations and appoint their admins, and they take it from there.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/admin/organizations"
            className="inline-flex min-h-[48px] items-center justify-center rounded-full border-2 border-[var(--red-primary)] bg-[var(--red-primary)] px-6 text-sm font-black uppercase tracking-[0.12em] text-white transition hover:bg-[var(--red-highlight)]"
          >
            Organization Provisioning
          </Link>
          <Link
            href="/admin"
            className="inline-flex min-h-[48px] items-center justify-center rounded-full border border-[rgba(0,0,0,0.14)] bg-white px-6 text-sm font-black uppercase tracking-[0.12em] transition hover:bg-[var(--canvas-tan)]"
          >
            Admin Home
          </Link>
        </div>
      </div>
    </main>
  );
}

function PeopleConsoleContent() {
  const [tab, setTab] = useState<Tab>('people');
  const [members, setMembers] = useState<Member[]>([]);
  const [codes, setCodes] = useState<OutstandingCode[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  // Invite staff form
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('coach');

  // Add athlete form
  const [athleteAccountId, setAthleteAccountId] = useState('');
  const [athleteId, setAthleteId] = useState('');

  // The one-time code, held only in component state. It is never refetchable.
  const [issuedCode, setIssuedCode] = useState<{ accountId: string; code: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const [membersResponse, codesResponse] = await Promise.all([
        fetch(`${apiBase()}/api/pilot/admin/staff`, { method: 'GET', credentials: 'include' }),
        fetch(`${apiBase()}/api/pilot/admin/activation-codes`, { method: 'GET', credentials: 'include' }),
      ]);

      const membersPayload = (await membersResponse.json().catch(() => ({}))) as {
        ok?: boolean;
        members?: Member[];
        organization_id?: string;
        error?: string;
      };

      if (!membersResponse.ok || !membersPayload.ok) {
        throw new Error(membersPayload.error || 'Unable to load your gym roster');
      }

      setMembers(membersPayload.members || []);
      setOrganizationId(membersPayload.organization_id || '');

      // Outstanding codes are supplementary; a failure here should not blank
      // out the roster the admin came to see.
      const codesPayload = (await codesResponse.json().catch(() => ({}))) as {
        ok?: boolean;
        codes?: OutstandingCode[];
      };
      if (codesResponse.ok && codesPayload.ok) {
        setCodes(codesPayload.codes || []);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load your gym roster');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const pendingAthletes = useMemo(
    () => members.filter((member) => member.auth_provider === 'ppbf_local' && !member.has_pin),
    [members],
  );

  const codesByAccount = useMemo(() => {
    const map = new Map<string, OutstandingCode>();
    for (const code of codes) {
      if (!code.is_expired) {
        map.set(code.account_id, code);
      }
    }
    return map;
  }, [codes]);

  async function inviteStaff(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);

    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ login_email: inviteEmail.trim(), role: inviteRole }),
      });

      const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Could not add that person');
      }

      setNotice(
        `${inviteEmail.trim()} is now a ${roleLabel(inviteRole)} in your gym. They must also be a guest in the PPBF Microsoft tenant before they can sign in.`,
      );
      setInviteEmail('');
      await load();
      setTab('people');
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : 'Could not add that person');
    } finally {
      setBusy(false);
    }
  }

  async function addAthlete(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);

    try {
      const createResponse = await fetch(`${apiBase()}/api/pilot/admin/athlete-accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ account_id: athleteAccountId.trim(), athlete_id: athleteId.trim() }),
      });

      const createPayload = (await createResponse.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!createResponse.ok || !createPayload.ok) {
        throw new Error(createPayload.error || 'Could not create that athlete account');
      }

      // Immediately mint the code so the admin leaves this form holding the
      // thing they actually need to hand the athlete.
      await issueCode(athleteAccountId.trim());

      setAthleteAccountId('');
      setAthleteId('');
      await load();
      setTab('people');
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : 'Could not create that athlete account');
    } finally {
      setBusy(false);
    }
  }

  async function issueCode(accountId: string) {
    setError('');
    setCopied(false);

    const response = await fetch(`${apiBase()}/api/pilot/admin/activation-codes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ account_id: accountId }),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      activation_code?: string;
      expires_at?: string;
    };

    if (!response.ok || !payload.ok || !payload.activation_code) {
      throw new Error(payload.error || 'Could not create an activation code');
    }

    setIssuedCode({
      accountId,
      code: payload.activation_code,
      expiresAt: payload.expires_at || '',
    });
  }

  async function handleIssueCode(accountId: string) {
    setBusy(true);
    setNotice('');
    try {
      await issueCode(accountId);
      await load();
    } catch (issueError) {
      setError(issueError instanceof Error ? issueError.message : 'Could not create an activation code');
    } finally {
      setBusy(false);
    }
  }

  const activationUrl = issuedCode
    ? `${typeof window === 'undefined' ? '' : window.location.origin}/activate?code=${encodeURIComponent(issuedCode.code)}`
    : '';

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] px-4 py-8 text-[var(--black)] sm:px-6">
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <header className="rounded-2xl border border-[rgba(0,0,0,0.16)] bg-white p-6 shadow-[var(--shadow-md)]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--red-primary)]">People</p>
              <h1 className="mt-2 font-display text-3xl font-black tracking-tight">Manage Your Gym</h1>
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                Add coaches and staff, create athlete accounts, and hand out activation codes.
                {organizationId && (
                  <>
                    {' '}Gym: <span className="font-mono font-semibold text-[var(--black)]">{organizationId}</span>
                  </>
                )}
              </p>
            </div>
            <Link
              href="/admin"
              className="inline-flex min-h-[44px] items-center rounded-full border border-[rgba(0,0,0,0.14)] bg-white px-5 text-sm font-bold uppercase tracking-[0.1em] transition hover:bg-[var(--canvas-tan)]"
            >
              Admin Home
            </Link>
          </div>
        </header>

        {/* The one-time code panel. Shown until dismissed, because closing it
            loses the code permanently. */}
        {issuedCode && (
          <section className="rounded-2xl border-2 border-[var(--red-primary)] bg-white p-5 shadow-[var(--shadow-md)]">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-black">Activation code for {issuedCode.accountId}</h2>
                <p className="mt-1 text-sm text-[var(--gray-dark)]">
                  Give this to the athlete now. It is shown once and cannot be looked up again — if it is lost, issue a
                  new one.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIssuedCode(null)}
                className="min-h-[40px] rounded-full border border-[rgba(0,0,0,0.14)] px-4 text-xs font-bold uppercase tracking-[0.1em]"
              >
                Done
              </button>
            </div>

            <p className="mt-4 rounded-xl border border-[rgba(0,0,0,0.12)] bg-[var(--canvas-tan-light)] px-4 py-4 text-center font-mono text-2xl font-black tracking-[0.2em]">
              {issuedCode.code}
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(issuedCode.code).then(() => setCopied(true));
                }}
                className="min-h-[44px] rounded-xl border-2 border-[var(--red-primary)] bg-[var(--red-primary)] px-4 text-xs font-black uppercase tracking-[0.12em] text-white"
              >
                {copied ? 'Copied' : 'Copy Code'}
              </button>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(activationUrl).then(() => setCopied(true));
                }}
                className="min-h-[44px] rounded-xl border border-[rgba(0,0,0,0.14)] bg-white px-4 text-xs font-black uppercase tracking-[0.12em]"
              >
                Copy Sign-Up Link
              </button>
            </div>

            {issuedCode.expiresAt && (
              <p className="mt-3 text-xs text-[var(--gray-dark)]">
                Expires {new Date(issuedCode.expiresAt).toLocaleDateString()}.
              </p>
            )}
          </section>
        )}

        {error && (
          <p role="alert" className="rounded-xl border border-[var(--red-primary)] bg-[rgba(184,59,52,0.06)] px-4 py-3 text-sm font-semibold text-[var(--red-primary)]">
            {error}
          </p>
        )}
        {notice && (
          <p className="rounded-xl border border-[rgba(16,120,40,0.5)] bg-[rgba(16,120,40,0.08)] px-4 py-3 text-sm font-semibold text-[#1b5e20]">
            {notice}
          </p>
        )}

        <nav className="flex flex-wrap gap-2 rounded-2xl border border-[rgba(0,0,0,0.12)] bg-white p-2">
          {([
            ['people', `Everyone${members.length ? ` (${members.length})` : ''}`],
            ['invite-staff', 'Add Coach or Staff'],
            ['add-athlete', 'Add Athlete'],
          ] as Array<[Tab, string]>).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={`min-h-[44px] flex-1 rounded-xl px-4 text-sm font-bold uppercase tracking-[0.1em] transition ${
                tab === key
                  ? 'bg-[var(--red-primary)] text-white'
                  : 'bg-transparent text-[var(--gray-dark)] hover:bg-[var(--canvas-tan)]'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab === 'people' && (
          <section className="space-y-4">
            {pendingAthletes.length > 0 && (
              <div className="rounded-2xl border border-[rgba(184,59,52,0.35)] bg-[rgba(184,59,52,0.04)] p-4">
                <p className="text-sm font-bold">
                  {pendingAthletes.length} athlete{pendingAthletes.length === 1 ? '' : 's'} cannot sign in yet
                </p>
                <p className="mt-1 text-sm text-[var(--gray-dark)]">
                  They need an activation code to set their own PIN. Use the “Give code” button on their row.
                </p>
              </div>
            )}

            <div className="overflow-hidden rounded-2xl border border-[rgba(0,0,0,0.14)] bg-white shadow-[var(--shadow-sm)]">
              {loading ? (
                <p className="p-6 text-sm text-[var(--gray-dark)]">Loading your gym roster...</p>
              ) : members.length === 0 ? (
                <div className="space-y-3 p-6 text-center">
                  <p className="text-sm font-semibold">Nobody here yet.</p>
                  <p className="text-sm text-[var(--gray-dark)]">
                    Start by adding a coach, or create your first athlete account.
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-[rgba(0,0,0,0.08)]">
                  {members.map((member) => {
                    const status = signInStatus(member);
                    const outstanding = codesByAccount.get(member.account_id);
                    const isPendingAthlete = member.auth_provider === 'ppbf_local' && !member.has_pin;

                    return (
                      <li key={member.account_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold">{member.login_email || member.account_id}</p>
                          <p className="mt-1 text-xs text-[var(--gray-dark)]">
                            {roleLabel(member.role)}
                            {member.athlete_id && <> · Athlete ID {member.athlete_id}</>}
                          </p>
                          <p
                            className={`mt-1 text-xs font-bold uppercase tracking-[0.1em] ${
                              status.tone === 'ok'
                                ? 'text-[#1b5e20]'
                                : status.tone === 'pending'
                                  ? 'text-[var(--red-primary)]'
                                  : 'text-[var(--gray-dark)]'
                            }`}
                          >
                            {status.label}
                            {outstanding && isPendingAthlete && <> · code issued, unclaimed</>}
                          </p>
                        </div>

                        {isPendingAthlete && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleIssueCode(member.account_id)}
                            className="min-h-[44px] shrink-0 rounded-xl border-2 border-[var(--red-primary)] bg-white px-4 text-xs font-black uppercase tracking-[0.1em] text-[var(--red-primary)] transition hover:bg-[rgba(184,59,52,0.06)] disabled:opacity-50"
                          >
                            {outstanding ? 'New Code' : 'Give Code'}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        )}

        {tab === 'invite-staff' && (
          <form onSubmit={inviteStaff} className="space-y-4 rounded-2xl border border-[rgba(0,0,0,0.14)] bg-white p-6 shadow-[var(--shadow-sm)]">
            <div>
              <h2 className="text-lg font-black">Add a coach or staff member</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                Staff sign in with Microsoft, not a PIN. Enter the Microsoft email address they will use.
              </p>
            </div>

            <div className="rounded-xl border border-[rgba(184,59,52,0.25)] bg-[rgba(184,59,52,0.04)] p-4">
              <p className="text-xs font-bold uppercase tracking-[0.1em] text-[var(--red-primary)]">Two steps, not one</p>
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                This form gives them a role in PPBF. If they are outside your Microsoft organization, someone also has to
                invite them as a guest in Entra ID — until that is done, their sign-in will be rejected.
              </p>
            </div>

            <div>
              <label htmlFor="invite-email" className="block text-sm font-semibold">
                Microsoft email address
              </label>
              <input
                id="invite-email"
                type="email"
                required
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="coach@example.com"
                className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 focus:border-[var(--red-primary)] focus:outline-none focus:ring-2 focus:ring-[rgba(184,59,52,0.2)]"
              />
            </div>

            <fieldset>
              <legend className="text-sm font-semibold">Role</legend>
              <div className="mt-2 space-y-2">
                {STAFF_ROLES.map((option) => (
                  <label
                    key={option.value}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${
                      inviteRole === option.value
                        ? 'border-[var(--red-primary)] bg-[rgba(184,59,52,0.05)]'
                        : 'border-[rgba(0,0,0,0.12)] hover:border-[rgba(0,0,0,0.3)]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="invite-role"
                      value={option.value}
                      checked={inviteRole === option.value}
                      onChange={() => setInviteRole(option.value)}
                      className="mt-1 accent-[var(--red-primary)]"
                    />
                    <span>
                      <span className="block text-sm font-semibold">{option.label}</span>
                      <span className="mt-0.5 block text-xs text-[var(--gray-dark)]">{option.blurb}</span>
                    </span>
                  </label>
                ))}
              </div>
              <p className="mt-3 text-xs text-[var(--gray-dark)]">
                Adding another gym admin is a platform-owner action — ask PPBF to do it.
              </p>
            </fieldset>

            <button
              type="submit"
              disabled={busy || !inviteEmail.trim()}
              className="min-h-[50px] w-full rounded-xl border-2 border-[var(--red-primary)] bg-[var(--red-primary)] px-4 text-sm font-black uppercase tracking-[0.14em] text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Adding...' : 'Add To My Gym'}
            </button>
          </form>
        )}

        {tab === 'add-athlete' && (
          <form onSubmit={addAthlete} className="space-y-4 rounded-2xl border border-[rgba(0,0,0,0.14)] bg-white p-6 shadow-[var(--shadow-sm)]">
            <div>
              <h2 className="text-lg font-black">Add an athlete</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                This creates the account and immediately gives you a one-time activation code to hand them. They choose
                their own PIN — you never see it.
              </p>
            </div>

            <div>
              <label htmlFor="athlete-account-id" className="block text-sm font-semibold">
                Sign-in ID
              </label>
              <p className="mt-1 text-xs text-[var(--gray-dark)]">
                What the athlete types to sign in. Keep it simple and unique, like <code>jsmith</code>.
              </p>
              <input
                id="athlete-account-id"
                type="text"
                required
                value={athleteAccountId}
                onChange={(event) => setAthleteAccountId(event.target.value.trim())}
                placeholder="jsmith"
                className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 font-mono focus:border-[var(--red-primary)] focus:outline-none focus:ring-2 focus:ring-[rgba(184,59,52,0.2)]"
              />
            </div>

            <div>
              <label htmlFor="athlete-id" className="block text-sm font-semibold">
                Athlete record ID
              </label>
              <p className="mt-1 text-xs text-[var(--gray-dark)]">
                The athlete&apos;s existing record in your roster that this login connects to.
              </p>
              <input
                id="athlete-id"
                type="text"
                required
                value={athleteId}
                onChange={(event) => setAthleteId(event.target.value.trim())}
                placeholder="ath-001"
                className="mt-2 min-h-[48px] w-full rounded-xl border border-[rgba(0,0,0,0.16)] px-3 font-mono focus:border-[var(--red-primary)] focus:outline-none focus:ring-2 focus:ring-[rgba(184,59,52,0.2)]"
              />
            </div>

            <button
              type="submit"
              disabled={busy || !athleteAccountId.trim() || !athleteId.trim()}
              className="min-h-[50px] w-full rounded-xl border-2 border-[var(--red-primary)] bg-[var(--red-primary)] px-4 text-sm font-black uppercase tracking-[0.14em] text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Creating...' : 'Create Account & Get Code'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

function PeopleConsoleRoleSwitch() {
  const session = usePilotSession();

  if (session.loading) {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-6 text-[var(--black)]">
        <p className="text-sm text-[var(--gray-dark)]">Loading...</p>
      </main>
    );
  }

  // RoleSessionGate already proved the caller is some flavour of admin; this
  // narrows further, because 'admin' there also covers platform owners.
  if (!isOrganizationAdminSessionRole(session.role)) {
    return <WrongRoleNotice />;
  }

  return <PeopleConsoleContent />;
}

export default function PeopleConsolePage() {
  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <PeopleConsoleRoleSwitch />
    </RoleSessionGate>
  );
}

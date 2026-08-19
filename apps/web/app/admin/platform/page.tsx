'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { apiBase } from '@/lib/apiBase';
import { usePilotSession } from '@/components/usePilotSession';

type FeedbackKind = 'success' | 'error' | 'info';

interface OrganizationSummary {
  organization_id: string;
  organization_name: string;
  status: string;
}

interface CountMetric {
  status: 'available' | 'unavailable' | 'insufficient_data';
  count: number | null;
}

interface BoardSummary {
  activeAthletes: CountMetric;
  trainingSessions30Days: CountMetric & { completedCount: number | null; completionRate: number | null };
  goalStatusBuckets: { active: CountMetric; completed: CountMetric; other: CountMetric };
  coachReviews30Days: CountMetric & { approvedCount: number | null; approvalRate: number | null };
}

interface GrowthMetrics {
  totalInteractions: number;
  avgSatisfaction: number | null;
  recommendationsMade: number;
  researchRequirementsCreated: number;
  researchRequirementsClosed: number;
}

interface GymSummary {
  organization_id: string;
  board: BoardSummary;
  growth: GrowthMetrics;
  capabilityAccess: Record<string, boolean>;
  trackAssignments: Record<string, string[]>;
}

const INVITABLE_ROLES = [
  { value: 'organization_admin', label: 'Organization Admin' },
  { value: 'coach', label: 'Coach' },
  { value: 'staff', label: 'Staff' },
  { value: 'volunteer', label: 'Volunteer' },
  { value: 'board', label: 'Board' },
];

const DEMOTE_ROLES = [
  { value: 'coach', label: 'Coach' },
  { value: 'admin', label: 'Admin' },
  { value: 'staff', label: 'Staff' },
  { value: 'volunteer', label: 'Volunteer' },
  { value: 'parent', label: 'Parent / Guardian' },
  { value: 'athlete', label: 'Athlete' },
];

const ORG_STATUSES = ['active', 'inactive', 'suspended', 'pending'] as const;
type OrgStatus = (typeof ORG_STATUSES)[number];

async function postJson(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${path}`);
  }
  return payload;
}

function metricLabel(metric: CountMetric): string {
  if (metric.status === 'available') {
    return String(metric.count);
  }
  if (metric.status === 'insufficient_data') {
    return 'Too few athletes to show';
  }
  return 'No data yet';
}

export default function PlatformConsole() {
  const session = usePilotSession();
  const isMicrosoftSession = session.authProvider === 'microsoft';
  const sessionRole = session.role;
  const authChecked = !session.loading;
  const hasPlatformAccess = isMicrosoftSession && sessionRole === 'platform_owner';

  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState('');
  const [summary, setSummary] = useState<GymSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: FeedbackKind; text: string } | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState(INVITABLE_ROLES[0].value);

  const [athleteAccountId, setAthleteAccountId] = useState('');
  const [athleteRosterId, setAthleteRosterId] = useState('');

  // Promote an existing account, already a member of the selected gym, to
  // organization_admin -- POST /api/pilot/platform/organizations/assign-admin.
  const [promoteAccountId, setPromoteAccountId] = useState('');

  // Swap the gym's admin seat -- POST /api/pilot/platform/organizations/transfer-admin.
  // The outgoing admin does not go anywhere without a landing role, so the
  // form requires one; the six values are exactly what the API accepts.
  const [transferFromAccountId, setTransferFromAccountId] = useState('');
  const [transferToAccountId, setTransferToAccountId] = useState('');
  const [transferDemoteRole, setTransferDemoteRole] = useState(DEMOTE_ROLES[0].value);

  // Suspend or restore any non-athlete account in the selected gym --
  // POST /api/pilot/platform/users/status. The API itself refuses an athlete
  // target (that credential belongs to the gym's own admin), so this form
  // does not need to pre-filter by role -- the refusal reason comes back
  // from the server and is shown as-is.
  const [statusAccountId, setStatusAccountId] = useState('');

  // Grants/revokes has_master_shadow_access -- a standing, platform-wide
  // (not gym-scoped) privilege flag -- POST /api/pilot/platform/users/master-shadow-access.
  const [shadowAccountId, setShadowAccountId] = useState('');

  useEffect(() => {
    if (!hasPlatformAccess) {
      return;
    }
    void (async () => {
      const response = await fetch(`${apiBase()}/api/pilot/platform/organizations`, { credentials: 'include' });
      if (!response.ok) {
        return;
      }
      const data = (await response.json()) as { organizations?: OrganizationSummary[] };
      setOrganizations(data.organizations ?? []);
    })();
  }, [hasPlatformAccess]);

  useEffect(() => {
    if (!selectedOrgId) {
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingSummary(true);
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `${apiBase()}/api/pilot/platform/gym-summary?organization_id=${encodeURIComponent(selectedOrgId)}`,
          { credentials: 'include', signal: controller.signal },
        );
        if (response.ok) {
          setSummary((await response.json()) as GymSummary);
        } else {
          setSummary(null);
        }
      } catch {
        // Ignore -- an abort from switching gyms quickly is expected.
      } finally {
        if (!controller.signal.aborted) {
          setLoadingSummary(false);
        }
      }
    })();
    return () => controller.abort();
  }, [selectedOrgId]);

  function showFeedback(kind: FeedbackKind, text: string) {
    setFeedback({ kind, text });
    if (kind === 'success') {
      setTimeout(() => setFeedback(null), 5000);
    }
  }

  async function inviteStaff() {
    const email = inviteEmail.trim();
    if (!selectedOrgId) {
      showFeedback('error', 'Choose a gym first');
      return;
    }
    if (!email) {
      showFeedback('error', 'Enter a Microsoft email address');
      return;
    }

    setIsBusy(true);
    try {
      await postJson('/api/pilot/platform/staff', {
        organization_id: selectedOrgId,
        login_email: email,
        role: inviteRole,
      });
      showFeedback('success', `${email} invited as ${inviteRole.replace('_', ' ')}. If they're outside your Microsoft tenant, invite them as an Entra guest too.`);
      setInviteEmail('');
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Failed to invite');
    } finally {
      setIsBusy(false);
    }
  }

  async function createAthleteShell() {
    const accountId = athleteAccountId.trim();
    const rosterId = athleteRosterId.trim();
    if (!selectedOrgId) {
      showFeedback('error', 'Choose a gym first');
      return;
    }
    if (!accountId || !rosterId) {
      showFeedback('error', 'Enter both an account ID and the athlete’s roster ID');
      return;
    }

    setIsBusy(true);
    try {
      const result = await postJson('/api/pilot/platform/athlete-shell', {
        organization_id: selectedOrgId,
        account_id: accountId,
        athlete_id: rosterId,
      });
      showFeedback('success', String(result.next_step || 'Account shell created.'));
      setAthleteAccountId('');
      setAthleteRosterId('');
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Failed to create account');
    } finally {
      setIsBusy(false);
    }
  }

  async function promoteToOrganizationAdmin() {
    const accountId = promoteAccountId.trim();
    if (!selectedOrgId) {
      showFeedback('error', 'Choose a gym first');
      return;
    }
    if (!accountId) {
      showFeedback('error', 'Enter the account ID to promote');
      return;
    }

    setIsBusy(true);
    try {
      await postJson('/api/pilot/platform/organizations/assign-admin', {
        account_id: accountId,
        organization_id: selectedOrgId,
      });
      showFeedback('success', `${accountId} is now the organization admin. Their sessions were revoked, so they will need to sign in again.`);
      setPromoteAccountId('');
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Failed to promote that account');
    } finally {
      setIsBusy(false);
    }
  }

  async function transferOrganizationAdminSeat() {
    const fromAccountId = transferFromAccountId.trim();
    const toAccountId = transferToAccountId.trim();
    if (!selectedOrgId) {
      showFeedback('error', 'Choose a gym first');
      return;
    }
    if (!fromAccountId || !toAccountId) {
      showFeedback('error', 'Enter both the current admin and the incoming admin');
      return;
    }

    setIsBusy(true);
    try {
      await postJson('/api/pilot/platform/organizations/transfer-admin', {
        organization_id: selectedOrgId,
        from_account_id: fromAccountId,
        to_account_id: toAccountId,
        demote_role: transferDemoteRole,
      });
      showFeedback(
        'success',
        `${toAccountId} is now the organization admin. ${fromAccountId} was moved to ${transferDemoteRole}. Both accounts' sessions were revoked.`,
      );
      setTransferFromAccountId('');
      setTransferToAccountId('');
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Failed to transfer the admin seat');
    } finally {
      setIsBusy(false);
    }
  }

  async function changeOrganizationStatus(status: OrgStatus) {
    if (!selectedOrgId) {
      showFeedback('error', 'Choose a gym first');
      return;
    }

    setIsBusy(true);
    try {
      await postJson('/api/pilot/platform/organizations/status', {
        organization_id: selectedOrgId,
        status,
      });
      showFeedback(
        'success',
        status === 'active'
          ? `${selectedOrgId} is active again.`
          : `${selectedOrgId} is now ${status}. Every session scoped to this gym was revoked.`,
      );
      setOrganizations((current) =>
        current.map((org) => (org.organization_id === selectedOrgId ? { ...org, status } : org)),
      );
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Failed to change gym status');
    } finally {
      setIsBusy(false);
    }
  }

  async function changeAccountStatus(activeFlag: boolean) {
    const accountId = statusAccountId.trim();
    if (!selectedOrgId) {
      showFeedback('error', 'Choose a gym first');
      return;
    }
    if (!accountId) {
      showFeedback('error', 'Enter the account ID');
      return;
    }

    setIsBusy(true);
    try {
      await postJson('/api/pilot/platform/users/status', {
        organization_id: selectedOrgId,
        account_id: accountId,
        active_flag: activeFlag,
      });
      showFeedback(
        'success',
        activeFlag ? `${accountId} is active again.` : `${accountId} is disabled. Their sessions were revoked.`,
      );
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Failed to change that account’s status');
    } finally {
      setIsBusy(false);
    }
  }

  async function changeMasterShadowAccess(granted: boolean) {
    const accountId = shadowAccountId.trim();
    if (!accountId) {
      showFeedback('error', 'Enter the account ID');
      return;
    }

    setIsBusy(true);
    try {
      await postJson('/api/pilot/platform/users/master-shadow-access', {
        account_id: accountId,
        granted,
      });
      showFeedback(
        'success',
        granted
          ? `${accountId} now holds master SHADOW access across every organization.`
          : `${accountId}’s master SHADOW access was revoked.`,
      );
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Failed to change master SHADOW access');
    } finally {
      setIsBusy(false);
    }
  }

  if (!authChecked) {
    return (
      <main className="room--office grid min-h-screen place-items-center bg-[var(--hide-950)] px-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="text-center">
          <p className="t-eyebrow">Checking Access</p>
          <h1 className="t-command mt-[var(--s4)]" style={{ fontSize: 'var(--t-lg)' }}>Loading...</h1>
        </div>
      </main>
    );
  }

  if (!hasPlatformAccess) {
    return (
      <main className="room--office grid min-h-screen place-items-center bg-[var(--hide-950)] px-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mat-leather mx-auto max-w-2xl space-y-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s6)] text-center">
          <p className="t-eyebrow">Access Denied</p>
          <h1 className="t-command" style={{ fontSize: 'var(--t-xl)' }}>Platform Owner Access Required</h1>
          <p className="t-body">
            This console is for PPBF platform administrators only.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-[var(--s4)]">
            <Link href="/login" className="btn">
              Sign In With Microsoft
            </Link>
            <Link href="/admin" className="btn btn--ghost">
              Go To Admin Dashboard
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-3xl space-y-[var(--s6)] px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
        <header className="mat-leather space-y-[var(--s4)] rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
          <p className="t-eyebrow">Platform Console</p>
          <h1 className="t-command" style={{ fontSize: 'var(--t-xl)' }}>Omega</h1>
          <p className="t-body">
            View any gym individually here, or see every gym at once in the overview. Reaches across
            organizations for operational data only -- never medical/PHI records, which stay each gym&apos;s own.
          </p>
          <div className="flex flex-wrap gap-[var(--s4)] pt-[var(--s3)]">
            <Link href="/admin/platform/overview" className="btn btn--ghost">
              All Gyms Overview
            </Link>
            <Link href="/admin/organizations" className="btn btn--ghost">
              Onboard A New Gym
            </Link>
          </div>
        </header>

        {feedback && (
          <div
            role={feedback.kind === 'error' ? 'alert' : 'status'}
            className={`alert ${
              feedback.kind === 'error'
                ? 'alert--critical'
                : feedback.kind === 'success'
                  ? 'alert--success'
                  : 'alert--info'
            }`}
          >
            <span className="alert-icon">
              {feedback.kind === 'error' ? '✕' : feedback.kind === 'success' ? '✓' : '◉'}
            </span>
            <span className="alert-msg font-semibold">{feedback.text}</span>
          </div>
        )}

        <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
          <label className="field">
            <span className="t-label">Choose A Gym</span>
            <select
              value={selectedOrgId}
              onChange={(event) => setSelectedOrgId(event.target.value)}
              className="select"
            >
              <option value="">Select a gym...</option>
              {organizations.map((org) => (
                <option key={org.organization_id} value={org.organization_id}>
                  {org.organization_name} ({org.status})
                </option>
              ))}
            </select>
          </label>

          {loadingSummary && <p className="t-muted mt-[var(--s4)]">Loading summary...</p>}

          {summary && summary.organization_id === selectedOrgId && (
            <div className="mt-[var(--s5)] grid grid-cols-2 gap-[var(--s4)] sm:grid-cols-4">
              <div className="border border-[color:var(--hide-700)] bg-[var(--hide-900)] p-[var(--s4)]">
                <p className="t-eyebrow">Active Athletes</p>
                <p className="mt-[var(--s2)] text-[length:var(--t-lg)] font-black text-[color:var(--bone-100)]">{metricLabel(summary.board.activeAthletes)}</p>
              </div>
              <div className="border border-[color:var(--hide-700)] bg-[var(--hide-900)] p-[var(--s4)]">
                <p className="t-eyebrow">Sessions (30d)</p>
                <p className="mt-[var(--s2)] text-[length:var(--t-lg)] font-black text-[color:var(--bone-100)]">{metricLabel(summary.board.trainingSessions30Days)}</p>
              </div>
              <div className="border border-[color:var(--hide-700)] bg-[var(--hide-900)] p-[var(--s4)]">
                <p className="t-eyebrow">Coach Reviews (30d)</p>
                <p className="mt-[var(--s2)] text-[length:var(--t-lg)] font-black text-[color:var(--bone-100)]">{metricLabel(summary.board.coachReviews30Days)}</p>
              </div>
              <div className="border border-[color:var(--hide-700)] bg-[var(--hide-900)] p-[var(--s4)]">
                <p className="t-eyebrow">SHADOW Uses (30d)</p>
                <p className="mt-[var(--s2)] text-[length:var(--t-lg)] font-black text-[color:var(--bone-100)]">{summary.growth.totalInteractions}</p>
              </div>
            </div>
          )}
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Invite Staff Or A Gym Admin</h2>
          <p className="t-body mt-[var(--s3)]">
            Sends a Microsoft-authenticated invite into the selected gym.
          </p>
          <div className="mt-[var(--s4)] space-y-[var(--s4)]">
            <label className="field">
              <span className="t-label">Microsoft email</span>
              <input
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                placeholder="name@example.org"
                className="input"
              />
            </label>
            <label className="field">
              <span className="t-label">Role</span>
              <select
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value)}
                className="select"
              >
                {INVITABLE_ROLES.map((role) => (
                  <option key={role.value} value={role.value}>{role.label}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={isBusy || !selectedOrgId}
              onClick={() => void inviteStaff()}
              className="btn w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isBusy ? 'Working...' : 'Send Invite'}
            </button>
          </div>
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Prepare An Athlete Account</h2>
          <p className="t-body mt-[var(--s3)]">
            Creates the login shell only -- no PIN, cannot sign in yet. The gym&apos;s own admin
            must finish activation from Admin &gt; People before this athlete can log in.
          </p>
          <div className="mt-[var(--s4)] space-y-[var(--s4)]">
            <label className="field">
              <span className="t-label">Account ID (how they&apos;ll sign in)</span>
              <input
                type="text"
                value={athleteAccountId}
                onChange={(event) => setAthleteAccountId(event.target.value)}
                placeholder="Account ID (how they'll sign in)"
                className="input"
              />
            </label>
            <label className="field">
              <span className="t-label">Existing athlete roster ID</span>
              <input
                type="text"
                value={athleteRosterId}
                onChange={(event) => setAthleteRosterId(event.target.value)}
                placeholder="Existing athlete roster ID"
                className="input"
              />
            </label>
            <button
              type="button"
              disabled={isBusy || !selectedOrgId}
              onClick={() => void createAthleteShell()}
              className="btn w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isBusy ? 'Working...' : 'Create Account Shell'}
            </button>
          </div>
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Organization Admin</h2>
          <p className="t-body mt-[var(--s3)]">
            Promote an existing member of the selected gym to organization admin, or hand the seat from
            one admin to another in a single step. Every account involved has its sessions revoked.
          </p>

          <div className="mt-[var(--s5)] space-y-[var(--s3)] border-t border-[color:var(--hide-700)] pt-[var(--s4)]">
            <p className="t-eyebrow">Promote to organization admin</p>
            <label className="field">
              <span className="t-label">Account ID (already a member of this gym)</span>
              <input
                type="text"
                value={promoteAccountId}
                onChange={(event) => setPromoteAccountId(event.target.value)}
                placeholder="account-id"
                className="input font-mono"
              />
            </label>
            <button
              type="button"
              disabled={isBusy || !selectedOrgId}
              onClick={() => void promoteToOrganizationAdmin()}
              className="btn btn--ghost w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isBusy ? 'Working...' : 'Promote To Organization Admin'}
            </button>
          </div>

          <div className="mt-[var(--s5)] space-y-[var(--s3)] border-t border-[color:var(--hide-700)] pt-[var(--s4)]">
            <p className="t-eyebrow">Transfer the admin seat</p>
            <label className="field">
              <span className="t-label">Current admin&apos;s account ID</span>
              <input
                type="text"
                value={transferFromAccountId}
                onChange={(event) => setTransferFromAccountId(event.target.value)}
                placeholder="current-admin-account-id"
                className="input font-mono"
              />
            </label>
            <label className="field">
              <span className="t-label">Incoming admin&apos;s account ID</span>
              <input
                type="text"
                value={transferToAccountId}
                onChange={(event) => setTransferToAccountId(event.target.value)}
                placeholder="incoming-admin-account-id"
                className="input font-mono"
              />
            </label>
            <label className="field">
              <span className="t-label">Move the outgoing admin to</span>
              <select
                value={transferDemoteRole}
                onChange={(event) => setTransferDemoteRole(event.target.value)}
                className="select"
              >
                {DEMOTE_ROLES.map((role) => (
                  <option key={role.value} value={role.value}>{role.label}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={isBusy || !selectedOrgId}
              onClick={() => void transferOrganizationAdminSeat()}
              className="btn btn--ghost w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isBusy ? 'Working...' : 'Transfer Admin Seat'}
            </button>
          </div>
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Organization Status</h2>
          <p className="t-body mt-[var(--s3)]">
            {selectedOrgId
              ? `${selectedOrgId} is currently ${organizations.find((org) => org.organization_id === selectedOrgId)?.status ?? 'unknown'}.`
              : 'Choose a gym above to change its status.'}
            {' '}Setting anything other than active revokes every session scoped to this gym.
          </p>
          <div className="mt-[var(--s4)] grid gap-[var(--s3)] sm:grid-cols-2">
            {ORG_STATUSES.map((status) => (
              <button
                key={status}
                type="button"
                disabled={isBusy || !selectedOrgId}
                onClick={() => void changeOrganizationStatus(status)}
                className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-50"
              >
                Set {status}
              </button>
            ))}
          </div>
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Account Status</h2>
          <p className="t-body mt-[var(--s3)]">
            Disable or restore any coach, staff, volunteer, board, or admin account in the selected gym.
            Athlete accounts are refused here by design — that credential belongs to the gym&apos;s own
            admin.
          </p>
          <div className="mt-[var(--s4)] space-y-[var(--s3)]">
            <label className="field">
              <span className="t-label">Account ID</span>
              <input
                type="text"
                value={statusAccountId}
                onChange={(event) => setStatusAccountId(event.target.value)}
                placeholder="account-id"
                className="input font-mono"
              />
            </label>
            <div className="grid gap-[var(--s3)] sm:grid-cols-2">
              <button
                type="button"
                disabled={isBusy || !selectedOrgId}
                onClick={() => void changeAccountStatus(false)}
                className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-50"
              >
                Disable Account
              </button>
              <button
                type="button"
                disabled={isBusy || !selectedOrgId}
                onClick={() => void changeAccountStatus(true)}
                className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-50"
              >
                Restore Account
              </button>
            </div>
          </div>
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Master SHADOW Access</h2>
          <p className="t-body mt-[var(--s3)]">
            Grants or revokes a standing, platform-wide privilege flag — not scoped to the gym selected
            above. Athlete and parent accounts are refused by the server; there is no legitimate reason
            for a minor-linked account to hold cross-organization access.
          </p>
          <div className="mt-[var(--s4)] space-y-[var(--s3)]">
            <label className="field">
              <span className="t-label">Account ID</span>
              <input
                type="text"
                value={shadowAccountId}
                onChange={(event) => setShadowAccountId(event.target.value)}
                placeholder="account-id"
                className="input font-mono"
              />
            </label>
            <div className="grid gap-[var(--s3)] sm:grid-cols-2">
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void changeMasterShadowAccess(true)}
                className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-50"
              >
                Grant Access
              </button>
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void changeMasterShadowAccess(false)}
                className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-50"
              >
                Revoke Access
              </button>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

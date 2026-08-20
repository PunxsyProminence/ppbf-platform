'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { apiBase } from '@/lib/apiBase';
import { useDialogFocusTrap } from '@/src/lib/useDialogFocusTrap';
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

// Closing a gym IS `inactive`. The owner's word for the job is "close a gym";
// `inactive` is what the column stores and what the audit event records. The
// two are named together everywhere below rather than one replacing the other,
// the same way #514 kept machine identifiers in a "filed as" line instead of
// deleting them out of the prose.
const CLOSED_STATUS: Exclude<OrgStatus, 'active'> = 'inactive';

// Law 3: colour is never the only channel. Every standing carries a glyph and
// an uppercase label as well as its rung, and the badge class only ever says
// the same thing the label already said.
//
// Rungs: `active` is the cleared rung. `suspended` is --restricted because a
// hold is an action state -- somebody has to end it. `inactive` and `pending`
// are --filed, which ppbf.css reserves for exactly this ("lifecycle/account
// states -- Deactivated, Unfilled, Archived, Unknown -- never for anything
// Layer 11 or a queue outcome actually gates on"). A closed gym is a
// lifecycle state, not a safety state; spending the safety red on it is what
// makes the safety red stop meaning anything.
const GYM_STANDING: Record<string, { badgeClass: string; glyph: string; label: string; meaning: string }> = {
  active: {
    badgeClass: 'badge badge--cleared',
    glyph: '\u2713',
    label: 'open',
    meaning: 'Open. Everyone signs in and works as normal.',
  },
  inactive: {
    badgeClass: 'badge badge--filed',
    glyph: '\u25A0',
    label: 'closed',
    meaning: 'Closed. Nobody can sign in to it. Every record it holds is still on file.',
  },
  suspended: {
    badgeClass: 'badge badge--restricted',
    glyph: '\u25B2',
    label: 'on hold',
    meaning: 'On hold. Nobody can sign in to it while the hold is on.',
  },
  pending: {
    badgeClass: 'badge badge--filed',
    glyph: '\u25CB',
    label: 'not open yet',
    meaning: 'Not open yet. Nobody can sign in until somebody opens it.',
  },
};

const UNKNOWN_STANDING = {
  badgeClass: 'badge badge--filed',
  glyph: '?',
  label: 'unknown',
  meaning: 'This desk could not read its standing. Refresh the page before you act on it.',
};

// What the confirmation slip says for each of the three standings that sign
// everybody out. `active` is not here on purpose: opening a gym is the way
// back, it revokes nothing, and putting a confirmation in front of the way
// back is how somebody stays locked out.
const STANDING_CHANGE: Record<
  Exclude<OrgStatus, 'active'>,
  { trigger: string; title: (gym: string) => string; body: string; confirmLabel: string; done: (gym: string) => string }
> = {
  inactive: {
    trigger: 'Close This Gym',
    title: (gym) => `Close ${gym}?`,
    body:
      'This closes the gym the moment you confirm. It is not a delete \u2014 every record it holds stays'
      + ' on file \u2014 and you can open it again whenever you want it back.',
    confirmLabel: 'YES, CLOSE THIS GYM',
    done: (gym) =>
      `${gym} is closed. Everyone scoped to it was signed out. Nothing was deleted \u2014 set it open again`
      + ' whenever you want it back.',
  },
  suspended: {
    trigger: 'Put This Gym On Hold',
    title: (gym) => `Put ${gym} on hold?`,
    body:
      'This puts the hold on the moment you confirm. It is not a delete \u2014 every record it holds stays'
      + ' on file \u2014 and you can open it again whenever the hold is done.',
    confirmLabel: 'YES, PUT IT ON HOLD',
    done: (gym) => `${gym} is on hold. Everyone scoped to it was signed out. Nothing was deleted.`,
  },
  pending: {
    trigger: 'Mark Not Open Yet',
    title: (gym) => `Mark ${gym} not open yet?`,
    body:
      'This sends the gym back to not-open-yet the moment you confirm. It is not a delete \u2014 every record'
      + ' it holds stays on file \u2014 and you can open it again when its onboarding is finished.',
    confirmLabel: 'YES, MARK IT NOT OPEN YET',
    done: (gym) => `${gym} is marked not open yet. Everyone scoped to it was signed out. Nothing was deleted.`,
  },
};

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

  // The standing this desk has been ASKED for and has not been given yet.
  // Nothing is posted while this is set -- it is the whole reason the
  // confirmation exists, so `changeOrganizationStatus` is unreachable for
  // these three standings except through `confirmStandingChange` below.
  const [pendingStanding, setPendingStanding] = useState<Exclude<OrgStatus, 'active'> | null>(null);
  // closeOnEscape: false, for the same reason /admin's bulk-delete confirm
  // sets it: this slip's own copy says the two buttons are the two ways out,
  // and an incidental Escape must not become an undocumented third.
  const standingConfirmRef = useDialogFocusTrap<HTMLElement>({
    open: pendingStanding !== null,
    onClose: () => setPendingStanding(null),
    closeOnEscape: false,
  });

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

  const selectedOrg = organizations.find((org) => org.organization_id === selectedOrgId);
  // The gym's NAME wherever there is one. Every sentence about closing a gym
  // is read by somebody deciding whether to close that gym, and "Punxsy
  // Prominence" is what they know it as; the id is what the code knows it as.
  const selectedGymName = selectedOrg?.organization_name || selectedOrgId;
  const selectedStanding = selectedOrg ? GYM_STANDING[selectedOrg.status] ?? UNKNOWN_STANDING : null;

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

  // The one write. Unchanged machinery: the same POST to the same
  // platform_owner-only route, which does the same session revocation and
  // writes the same audit event. Everything this ticket added is the wording
  // and the confirmation in front of it.
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
          ? `${selectedGymName} is open again. Everyone signs in as normal.`
          : STANDING_CHANGE[status].done(selectedGymName),
      );
      setOrganizations((current) =>
        current.map((org) => (org.organization_id === selectedOrgId ? { ...org, status } : org)),
      );
      setPendingStanding(null);
    } catch (error) {
      showFeedback('error', error instanceof Error ? error.message : 'Failed to change gym status');
    } finally {
      setIsBusy(false);
    }
  }

  // The only path from the three sign-everybody-out standings to the POST.
  async function confirmStandingChange() {
    if (!pendingStanding) {
      return;
    }
    await changeOrganizationStatus(pendingStanding);
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
      <main className="room room--office room--lit-center grid min-h-screen place-items-center px-[var(--s5)]">
        <div className="text-center">
          <p className="t-eyebrow">Checking Access</p>
          <h1 className="t-command mt-[var(--s4)]" style={{ fontSize: 'var(--t-lg)' }}>Loading...</h1>
        </div>
      </main>
    );
  }

  if (!hasPlatformAccess) {
    return (
      <main className="room room--office room--lit-center grid min-h-screen place-items-center px-[var(--s5)]">
        <div className="mat-leather mx-auto max-w-2xl space-y-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s6)] text-center">
          <p className="t-eyebrow">Access Denied</p>
          <h1 className="t-command" style={{ fontSize: 'var(--t-xl)' }}>Platform Owner Access Required</h1>
          <p className="t-body">
            This desk is for PPBF platform administrators only.
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
    <main className="room room--office min-h-screen">
      <div className="mx-auto w-full max-w-3xl space-y-[var(--s6)] px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
        <header className="mat-leather space-y-[var(--s4)] rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
          <p className="t-eyebrow">Platform Desk</p>
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
              onChange={(event) => {
                // A confirmation slip names one gym. Moving the desk to
                // another gym while one is open would leave a slip on screen
                // that asks about a gym nobody is looking at any more.
                setPendingStanding(null);
                setSelectedOrgId(event.target.value);
              }}
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
            This makes the account only. It has no PIN and cannot sign in yet: the gym&apos;s own admin
            finishes it from Admin &gt; People before the athlete can log in.
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
              {/* The h2 above already says it in the clerk's words -- "Prepare
                  An Athlete Account" -- and then the button that does it said
                  "Create Account Shell", which is what the code calls the row,
                  not what the desk calls the job. */}
              {isBusy ? 'Working...' : 'Prepare The Account'}
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

        {/* Closing a gym used to be one option in a four-button status
            dropdown reading "Set active / Set inactive / Set suspended / Set
            pending", and the only sentence that named the consequence --
            "Every session scoped to this gym was revoked" -- appeared AFTER
            the change had already gone through. The owner asked whether a
            platform admin can delete an organization; the answer is that
            there is no delete, and this is the control that was already doing
            the job people were looking for a delete to do. So it is named for
            the job, the consequences are stated before the click rather than
            after it, and the fact that it is NOT a deletion is on the form
            itself, where the question gets asked. */}
        <section className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Close A Gym</h2>

          <p className="t-eyebrow mt-[var(--s4)]">Standing right now</p>
          {selectedStanding ? (
            <div className="mt-[var(--s3)] flex flex-wrap items-center gap-[var(--s3)]">
              <span className={selectedStanding.badgeClass}>
                <i aria-hidden="true">{selectedStanding.glyph}</i>
                {selectedStanding.label}
              </span>
              <span className="t-body">
                <strong>{selectedGymName}</strong> — {selectedStanding.meaning}
              </span>
            </div>
          ) : (
            <p className="t-body mt-[var(--s3)]">
              Choose a gym above and this desk will tell you where it stands.
            </p>
          )}

          {/* The room's own Feel line is "paper forms", and this is the form.
              .btn--lever rather than .btn--ghost because the ground here is
              paper: ppbf.css documents ghost-on-light as grey-on-grey. */}
          <div className="mat-paper mt-[var(--s5)] rounded-[var(--r-md)] p-[var(--s5)]">
            <p className="t-eyebrow">Before you close it</p>
            <p className="t-body mt-[var(--s3)]">
              Read this first. Closing a gym takes it off the platform the moment you confirm, and it
              reaches everybody who works there.
            </p>
            <ul className="t-body mt-[var(--s3)] list-disc space-y-[var(--s2)] pl-[var(--s5)]">
              <li>
                <strong>Everyone is signed out.</strong> Every session scoped to this gym is revoked
                — coaches, staff, board, volunteers, athletes — and nobody can sign back in
                while it is closed.
              </li>
              <li>
                <strong>Nothing is deleted.</strong> Closing is not a delete, and there is no delete on
                this desk. Athletes, training sessions, notes, consents and audit records all stay
                exactly where they are.
              </li>
              <li>
                <strong>You can open it again.</strong> Set the gym open whenever you want it back and
                everyone signs in as normal. Nothing has to be rebuilt.
              </li>
            </ul>
            <button
              type="button"
              disabled={isBusy || !selectedOrgId}
              onClick={() => setPendingStanding(CLOSED_STATUS)}
              className="btn--lever mt-[var(--s4)] w-full justify-center disabled:cursor-not-allowed disabled:opacity-50"
            >
              {STANDING_CHANGE[CLOSED_STATUS].trigger}
            </button>
          </div>

          <div className="mt-[var(--s5)] space-y-[var(--s3)] border-t border-[color:var(--hide-700)] pt-[var(--s4)]">
            <p className="t-eyebrow">The other standings</p>
            <p className="t-body">
              Opening a gym is the way back from every standing on this desk, and it is the one that
              asks nothing of you first — it revokes nothing. A hold and a not-open-yet sign
              everybody out exactly the way closing does, so this desk asks you to confirm those the
              same way.
            </p>
            <div className="grid gap-[var(--s3)] sm:grid-cols-3">
              <button
                type="button"
                disabled={isBusy || !selectedOrgId}
                onClick={() => void changeOrganizationStatus('active')}
                className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-50"
              >
                Open This Gym
              </button>
              <button
                type="button"
                disabled={isBusy || !selectedOrgId}
                onClick={() => setPendingStanding('suspended')}
                className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-50"
              >
                {STANDING_CHANGE.suspended.trigger}
              </button>
              <button
                type="button"
                disabled={isBusy || !selectedOrgId}
                onClick={() => setPendingStanding('pending')}
                className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-50"
              >
                {STANDING_CHANGE.pending.trigger}
              </button>
            </div>
            {/* #514's move: a machine identifier belongs in a mono line of its
                own, not deleted out of the room and not left sitting in the
                clerk's prose. These are the values the status column stores
                and the audit event records, and the line is generated from
                ORG_STATUSES rather than typed out, so a standing that this
                desk can set can never quietly go missing from the list of the
                standings this desk can set. */}
            <p className="t-muted">
              Filed as{' '}
              {ORG_STATUSES.map((status, index) => (
                <span key={status}>
                  {index === 0 ? null : index === ORG_STATUSES.length - 1 ? ' and ' : ', '}
                  <span className="t-data">{status}</span> ({GYM_STANDING[status].label})
                </span>
              ))}
              .
            </p>
          </div>

          {/* The confirmation. Law 7 -- a demand for confirmation is a stamp:
              it sits in the flow and waits. Deliberately the same .pickconfirm
              /admin's bulk delete already uses, and deliberately not an
              overlay with a backdrop a stray click dismisses. The two buttons
              are the two ways out, cancel first in the DOM so the first thing
              a keyboard user reaches and the first thing a screen reader
              announces after the warning is the way back. */}
          {pendingStanding && (
            <article
              ref={standingConfirmRef}
              className="pickconfirm mt-[var(--s5)]"
              role="alertdialog"
              aria-modal="true"
              aria-label="Confirm a change to this gym"
            >
              <h3 className="pickconfirm-title">{STANDING_CHANGE[pendingStanding].title(selectedGymName)}</h3>
              <p className="pickconfirm-body">{STANDING_CHANGE[pendingStanding].body}</p>
              <ul className="pickconfirm-list">
                <li>Every session scoped to this gym is revoked — everybody there is signed out.</li>
                <li>No records are deleted. Everything this gym holds stays on file.</li>
                <li>Reversible — open the gym again and everybody signs back in as normal.</li>
              </ul>
              <div className="pickconfirm-actions">
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => setPendingStanding(null)}
                  className="btn disabled:cursor-not-allowed disabled:opacity-50"
                >
                  KEEP IT AS IT IS
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  aria-busy={isBusy}
                  onClick={() => void confirmStandingChange()}
                  className="btn btn--danger disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isBusy ? 'WORKING...' : STANDING_CHANGE[pendingStanding].confirmLabel}
                </button>
              </div>
            </article>
          )}
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

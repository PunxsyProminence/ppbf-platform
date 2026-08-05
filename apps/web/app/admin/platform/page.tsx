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

  if (!authChecked) {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-6 text-[var(--black)]">
        <div className="text-center">
          <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--red-primary)]">Checking Access</p>
          <h1 className="mt-3 font-display text-2xl tracking-tight">Loading...</h1>
        </div>
      </main>
    );
  }

  if (!hasPlatformAccess) {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-6 text-[var(--black)]">
        <div className="mx-auto max-w-2xl space-y-6 text-center">
          <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--red-primary)]">Access Denied</p>
          <h1 className="font-display text-3xl font-black">Platform Owner Access Required</h1>
          <p className="text-sm leading-7 text-[var(--gray-dark)]">
            This console is for PPBF platform administrators only.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link href="/login" className="tactical-btn tactical-btn-critical">
              Sign In With Microsoft
            </Link>
            <Link href="/admin" className="tactical-btn tactical-btn-ghost border-2 border-[var(--black)]">
              Go To Admin Dashboard
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto w-full max-w-3xl space-y-8 px-6 py-12 lg:px-10">
        <header className="space-y-4 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6 shadow-[var(--shadow-md)]">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--red-primary)]">Platform Console</p>
          <h1 className="font-display text-4xl font-black">Omega</h1>
          <p className="text-base leading-7 text-[var(--gray-dark)]">
            View any gym individually here, or see every gym at once in the overview. Reaches across
            organizations for operational data only -- never medical/PHI records, which stay each gym&apos;s own.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            <Link href="/admin/platform/overview" className="tactical-btn tactical-btn-ghost border-2 border-[var(--black)]">
              All Gyms Overview
            </Link>
            <Link href="/admin/organizations" className="tactical-btn tactical-btn-ghost border-2 border-[var(--black)]">
              Onboard A New Gym
            </Link>
          </div>
        </header>

        {feedback && (
          <div
            className={`border-2 px-4 py-3 ${
              feedback.kind === 'error'
                ? 'border-[var(--red-primary)] bg-[rgba(139,0,0,0.08)]'
                : feedback.kind === 'success'
                  ? 'border-[var(--status-ready)] bg-[rgba(74,93,35,0.08)]'
                  : 'border-[var(--gray-medium)] bg-[rgba(0,0,0,0.03)]'
            }`}
          >
            <p
              className={`text-sm font-semibold ${
                feedback.kind === 'error' ? 'text-[var(--red-primary)]' : feedback.kind === 'success' ? 'text-[var(--status-ready)]' : 'text-[var(--gray-dark)]'
              }`}
            >
              {feedback.kind === 'error' && '❌ '}
              {feedback.kind === 'success' && '✓ '}
              {feedback.text}
            </p>
          </div>
        )}

        <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6">
          <label className="block text-sm font-semibold text-[var(--black)]">Choose A Gym</label>
          <select
            value={selectedOrgId}
            onChange={(event) => setSelectedOrgId(event.target.value)}
            className="mt-2 tactical-input"
          >
            <option value="">Select a gym...</option>
            {organizations.map((org) => (
              <option key={org.organization_id} value={org.organization_id}>
                {org.organization_name} ({org.status})
              </option>
            ))}
          </select>

          {loadingSummary && <p className="mt-4 text-sm text-[var(--gray-dark)]">Loading summary...</p>}

          {summary && summary.organization_id === selectedOrgId && (
            <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="border border-[var(--black)] p-3">
                <p className="text-[10px] uppercase tracking-[0.1em] text-[var(--gray-dark)]">Active Athletes</p>
                <p className="mt-1 text-xl font-black">{metricLabel(summary.board.activeAthletes)}</p>
              </div>
              <div className="border border-[var(--black)] p-3">
                <p className="text-[10px] uppercase tracking-[0.1em] text-[var(--gray-dark)]">Sessions (30d)</p>
                <p className="mt-1 text-xl font-black">{metricLabel(summary.board.trainingSessions30Days)}</p>
              </div>
              <div className="border border-[var(--black)] p-3">
                <p className="text-[10px] uppercase tracking-[0.1em] text-[var(--gray-dark)]">Coach Reviews (30d)</p>
                <p className="mt-1 text-xl font-black">{metricLabel(summary.board.coachReviews30Days)}</p>
              </div>
              <div className="border border-[var(--black)] p-3">
                <p className="text-[10px] uppercase tracking-[0.1em] text-[var(--gray-dark)]">SHADOW Uses (30d)</p>
                <p className="mt-1 text-xl font-black">{summary.growth.totalInteractions}</p>
              </div>
            </div>
          )}
        </section>

        <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6">
          <h2 className="text-lg font-bold">Invite Staff Or A Gym Admin</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
            Sends a Microsoft-authenticated invite into the selected gym.
          </p>
          <div className="mt-4 space-y-3">
            <input
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="name@example.org"
              className="tactical-input"
            />
            <select
              value={inviteRole}
              onChange={(event) => setInviteRole(event.target.value)}
              className="tactical-input"
            >
              {INVITABLE_ROLES.map((role) => (
                <option key={role.value} value={role.value}>{role.label}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={isBusy || !selectedOrgId}
              onClick={() => void inviteStaff()}
              className="tactical-btn tactical-btn-critical w-full"
            >
              {isBusy ? 'Working...' : 'Send Invite'}
            </button>
          </div>
        </section>

        <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-6">
          <h2 className="text-lg font-bold">Prepare An Athlete Account</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
            Creates the login shell only -- no PIN, cannot sign in yet. The gym&apos;s own admin
            must finish activation from Admin &gt; People before this athlete can log in.
          </p>
          <div className="mt-4 space-y-3">
            <input
              type="text"
              value={athleteAccountId}
              onChange={(event) => setAthleteAccountId(event.target.value)}
              placeholder="Account ID (how they'll sign in)"
              className="tactical-input"
            />
            <input
              type="text"
              value={athleteRosterId}
              onChange={(event) => setAthleteRosterId(event.target.value)}
              placeholder="Existing athlete roster ID"
              className="tactical-input"
            />
            <button
              type="button"
              disabled={isBusy || !selectedOrgId}
              onClick={() => void createAthleteShell()}
              className="tactical-btn tactical-btn-critical w-full"
            >
              {isBusy ? 'Working...' : 'Create Account Shell'}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}

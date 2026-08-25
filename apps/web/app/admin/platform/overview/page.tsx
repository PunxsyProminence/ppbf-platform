'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { apiBase } from '@/lib/apiBase';
import { usePilotSession } from '@/components/usePilotSession';

interface CountMetric {
  status: 'available' | 'unavailable' | 'insufficient_data';
  count: number | null;
}

interface BoardSummary {
  activeAthletes: CountMetric;
  trainingSessions30Days: CountMetric;
  coachReviews30Days: CountMetric;
}

interface GrowthMetrics {
  totalInteractions: number;
}

interface GymOverviewRow {
  organizationId: string;
  organizationName: string;
  status: string;
  board: BoardSummary | null;
  growth: GrowthMetrics | null;
  capabilityCount: number;
  trackAssignmentCount: number;
  error?: string;
}

function metricLabel(metric: CountMetric | undefined): string {
  if (!metric) {
    return '—';
  }
  if (metric.status === 'available') {
    return String(metric.count);
  }
  if (metric.status === 'insufficient_data') {
    return 'n/a';
  }
  return '—';
}

export default function PlatformOverview() {
  const session = usePilotSession();
  const isMicrosoftSession = session.authProvider === 'microsoft';
  const authChecked = !session.loading;
  const hasPlatformAccess = isMicrosoftSession && session.role === 'platform_owner';

  const [gyms, setGyms] = useState<GymOverviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!hasPlatformAccess) {
      return;
    }
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/platform/overview`, { credentials: 'include' });
        if (!response.ok) {
          setLoadError('Failed to load gyms overview');
          return;
        }
        const data = (await response.json()) as { gyms?: GymOverviewRow[] };
        setGyms(data.gyms ?? []);
      } catch {
        setLoadError('Failed to load gyms overview');
      } finally {
        setLoading(false);
      }
    })();
  }, [hasPlatformAccess]);

  if (!authChecked) {
    return (
      <main className="room room--office room--lit-center grid min-h-screen place-items-center bg-[var(--hide-950)] px-[var(--s5)] text-[color:var(--bone-200)]">
        <p className="t-eyebrow">Loading...</p>
      </main>
    );
  }

  if (!hasPlatformAccess) {
    return (
      <main className="room room--office room--lit-center grid min-h-screen place-items-center bg-[var(--hide-950)] px-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mat-leather mx-auto max-w-2xl space-y-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s6)] text-center">
          <p className="t-eyebrow">Access Denied</p>
          <h1 className="t-command" style={{ fontSize: 'var(--t-xl)' }}>Platform Owner Access Required</h1>
          <Link href="/admin" className="btn btn--ghost">
            Go To Admin Dashboard
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="room room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-5xl space-y-[var(--s6)] px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
        <header className="mat-leather space-y-[var(--s4)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
          <p className="t-eyebrow">Platform Desk</p>
          <h1 className="t-command" style={{ fontSize: 'var(--t-xl)' }}>All Gyms Overview</h1>
          <p className="t-body">
            Every gym on the platform, one row each. Aggregate operational figures only.
          </p>
          <Link href="/admin/platform" className="btn btn--ghost">
            Back To Gym Switcher
          </Link>
        </header>

        {loading && <p className="t-muted">Loading...</p>}
        {loadError && (
          <p role="alert" className="alert alert--critical">
            <span className="alert-icon">✕</span>
            <span className="alert-msg">{loadError}</span>
          </p>
        )}

        {!loading && !loadError && (
          <div className="mat-leather overflow-x-auto rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)]">
            <table className="w-full min-w-[720px] text-left text-[length:var(--t-sm)]">
              <thead>
                <tr className="border-b border-[color:rgb(var(--brass-400-rgb)_/_.28)]">
                  <th className="t-label px-[var(--s4)] py-[var(--s4)]">Gym</th>
                  <th className="t-label px-[var(--s4)] py-[var(--s4)]">Status</th>
                  <th className="t-label px-[var(--s4)] py-[var(--s4)]">Active Athletes</th>
                  <th className="t-label px-[var(--s4)] py-[var(--s4)]">Sessions (30d)</th>
                  <th className="t-label px-[var(--s4)] py-[var(--s4)]">Coach Reviews (30d)</th>
                  <th className="t-label px-[var(--s4)] py-[var(--s4)]">SHADOW Uses (30d)</th>
                  <th className="t-label px-[var(--s4)] py-[var(--s4)]">Features On</th>
                </tr>
              </thead>
              <tbody>
                {gyms.map((gym) => (
                  <tr key={gym.organizationId} className="border-b border-[color:var(--hide-700)] last:border-0">
                    <td className="px-[var(--s4)] py-[var(--s4)] font-semibold text-[color:var(--bone-100)]">{gym.organizationName}</td>
                    <td className="t-data px-[var(--s4)] py-[var(--s4)] uppercase">{gym.status}</td>
                    {gym.error ? (
                      <td className="px-[var(--s4)] py-[var(--s4)] text-[color:var(--bone-300)]" colSpan={4}>
                        <span aria-hidden>▲</span> {gym.error}
                      </td>
                    ) : (
                      <>
                        <td className="t-data px-[var(--s4)] py-[var(--s4)]">{metricLabel(gym.board?.activeAthletes)}</td>
                        <td className="t-data px-[var(--s4)] py-[var(--s4)]">{metricLabel(gym.board?.trainingSessions30Days)}</td>
                        <td className="t-data px-[var(--s4)] py-[var(--s4)]">{metricLabel(gym.board?.coachReviews30Days)}</td>
                        <td className="t-data px-[var(--s4)] py-[var(--s4)]">{gym.growth?.totalInteractions ?? '—'}</td>
                      </>
                    )}
                    <td className="t-data px-[var(--s4)] py-[var(--s4)]">{gym.capabilityCount}</td>
                  </tr>
                ))}
                {gyms.length === 0 && (
                  <tr>
                    <td className="t-muted px-[var(--s4)] py-[var(--s5)] text-center" colSpan={7}>No gyms yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

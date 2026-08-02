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
      <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-6 text-[var(--black)]">
        <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--safety-locked)]">Loading...</p>
      </main>
    );
  }

  if (!hasPlatformAccess) {
    return (
      <main className="grid min-h-screen place-items-center bg-[var(--canvas-tan)] px-6 text-[var(--black)]">
        <div className="mx-auto max-w-2xl space-y-6 text-center">
          <p className="text-xs font-mono uppercase tracking-[0.35em] text-[var(--safety-locked)]">Access Denied</p>
          <h1 className="font-display text-3xl font-black">Platform Owner Access Required</h1>
          <Link href="/admin" className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-[rgba(0,0,0,0.14)] bg-white px-6 text-sm font-black uppercase tracking-[0.12em] text-[var(--black)] transition hover:bg-[var(--canvas-tan)]">
            Go To Admin Dashboard
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
      <div className="mx-auto w-full max-w-5xl space-y-8 px-6 py-12 lg:px-10">
        <header className="space-y-4 rounded-[28px] border border-[rgba(0,0,0,0.14)] bg-white p-6 shadow-[var(--shadow-md)]">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--safety-locked)]">Platform Console</p>
          <h1 className="font-display text-4xl font-black">All Gyms Overview</h1>
          <p className="text-base leading-7 text-[var(--gray-dark)]">
            Every gym on the platform, one row each. Aggregate operational figures only.
          </p>
          <Link href="/admin/platform" className="inline-flex min-h-[44px] items-center justify-center rounded-full border border-[rgba(0,0,0,0.14)] bg-white px-4 text-xs font-black uppercase tracking-[0.1em] text-[var(--black)] transition hover:bg-[var(--canvas-tan)]">
            Back To Gym Switcher
          </Link>
        </header>

        {loading && <p className="text-sm text-[var(--gray-dark)]">Loading...</p>}
        {loadError && <p className="text-sm text-[var(--safety-locked)]">{loadError}</p>}

        {!loading && !loadError && (
          <div className="overflow-x-auto rounded-2xl border-2 border-[rgba(0,0,0,0.14)] bg-white">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-[rgba(0,0,0,0.1)] text-[10px] uppercase tracking-[0.1em] text-[var(--gray-dark)]">
                  <th className="px-4 py-3">Gym</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Active Athletes</th>
                  <th className="px-4 py-3">Sessions (30d)</th>
                  <th className="px-4 py-3">Coach Reviews (30d)</th>
                  <th className="px-4 py-3">SHADOW Uses (30d)</th>
                  <th className="px-4 py-3">Features On</th>
                </tr>
              </thead>
              <tbody>
                {gyms.map((gym) => (
                  <tr key={gym.organizationId} className="border-b border-[rgba(0,0,0,0.06)] last:border-0">
                    <td className="px-4 py-3 font-semibold">{gym.organizationName}</td>
                    <td className="px-4 py-3">{gym.status}</td>
                    {gym.error ? (
                      <td className="px-4 py-3 text-[var(--safety-locked)]" colSpan={4}>{gym.error}</td>
                    ) : (
                      <>
                        <td className="px-4 py-3">{metricLabel(gym.board?.activeAthletes)}</td>
                        <td className="px-4 py-3">{metricLabel(gym.board?.trainingSessions30Days)}</td>
                        <td className="px-4 py-3">{metricLabel(gym.board?.coachReviews30Days)}</td>
                        <td className="px-4 py-3">{gym.growth?.totalInteractions ?? '—'}</td>
                      </>
                    )}
                    <td className="px-4 py-3">{gym.capabilityCount}</td>
                  </tr>
                ))}
                {gyms.length === 0 && (
                  <tr>
                    <td className="px-4 py-6 text-center text-[var(--gray-dark)]" colSpan={7}>No gyms yet.</td>
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

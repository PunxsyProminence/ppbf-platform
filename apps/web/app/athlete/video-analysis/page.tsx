'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import RoleStandaloneView from '@/components/RoleStandaloneView';

const capabilityStatus = 'PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED | HUMAN REVIEW REQUIRED';

interface ShadowObservationItem {
  id: string;
  source: 'event' | 'telemetry';
  label: string;
  entity_type: string | null;
  entity_id: string | null;
  review_state: 'pending_review' | 'approved' | 'rejected' | 'promoted' | 'unknown';
  created_at: string;
}

const athletePanels = [
  'Athlete Feedback',
  'Film Review',
  'Session Comparison',
  'Before / After Comparison',
  'Analysis History',
  'Skill Recognition Placeholder',
  'Technique Scoring Placeholder',
];

export default function AthleteVideoAnalysisPage() {
  const [observations, setObservations] = useState<ShadowObservationItem[]>([]);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/pilot/shadow/observation-projection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 30 }),
        });

        if (!response.ok) {
          throw new Error('Unable to load SHADOW observation projection.');
        }

        const payload = (await response.json()) as { items?: ShadowObservationItem[] };
        setObservations(payload.items ?? []);
        setErrorMessage('');
      } catch {
        setObservations([]);
        setErrorMessage('Unable to load SHADOW observation projection.');
      }
    })();
  }, []);

  return (
    <RoleStandaloneView roleLabel="Athlete Workspace" routeLabel="/athlete/video-analysis" allowedRoles={['athlete']} showShellHeader={false}>
      <div className="space-y-6">
        <header className="border-2 border-[#8b4444] bg-[#111111] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">AI / ML Video Analysis</p>
          <h1 className="mt-2 text-3xl font-black text-[#f2e7da]">Athlete Film Feedback Lane</h1>
          <p className="mt-2 text-sm text-[#cfbfae]">Athlete-facing video review and feedback visibility surface.</p>
          <p className="mt-2 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">
            {capabilityStatus}
          </p>
        </header>

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {athletePanels.map((panel) => (
            <article key={panel} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
              <p className="text-sm font-semibold text-[#e8d7c6]">{panel}</p>
              <p className="mt-1 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">
                {observations.length > 0 ? `LIVE | ${observations.length} signals` : capabilityStatus}
              </p>
            </article>
          ))}
        </section>

        <section className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
          <h2 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Video Signal Stream</h2>
          <div className="mt-3 space-y-2">
            {observations.slice(0, 5).map((item) => (
              <article key={item.id} className="border border-[#5a4a3a] bg-[#101010] p-3">
                <p className="text-sm font-semibold text-[#e8d7c6]">{item.label}</p>
                <p className="mt-1 text-xs text-[#cfbfae]">Review State: {item.review_state}</p>
              </article>
            ))}
            {!errorMessage && observations.length === 0 ? <p className="text-xs text-[#cfbfae]">No SHADOW observations available.</p> : null}
          </div>
        </section>

        <div className="flex flex-wrap gap-3">
          <Link href="/athlete/dashboard" className="border-2 border-[#8b4444] bg-[#2a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574]">
            Back to Athlete Workspace
          </Link>
          <Link href="/coach/video-analysis" className="border-2 border-[#4a4a4a] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#b0b0b0]">
            Coach Video Analysis Surface
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}

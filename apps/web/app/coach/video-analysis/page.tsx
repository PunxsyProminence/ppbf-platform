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

const analysisPanels = [
  { title: 'Skill Recognition Placeholder', detail: capabilityStatus },
  { title: 'Punch Detection Placeholder', detail: capabilityStatus },
  { title: 'Footwork Analysis Placeholder', detail: capabilityStatus },
  { title: 'Technique Scoring Placeholder', detail: `${capabilityStatus} | ML REQUIRED` },
  { title: 'Movement Analysis Placeholder', detail: capabilityStatus },
];

const reviewComparisons = [
  {
    title: 'Session Comparison',
    body: 'Compare Session A vs Session B clips, coaching notes, and mock trend flags.',
    state: capabilityStatus,
  },
  {
    title: 'Before / After Comparison',
    body: 'Side-by-side frame placeholder for earlier and current training cycle clips.',
    state: capabilityStatus,
  },
  {
    title: 'Analysis History',
    body: 'Mock history of analysis runs, reviewer notes, and role-attributed review checkpoints.',
    state: capabilityStatus,
  },
];

export default function CoachVideoAnalysisPage() {
  const [observations, setObservations] = useState<ShadowObservationItem[]>([]);
  const [observationError, setObservationError] = useState('');

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
        setObservationError('');
      } catch (error) {
        setObservations([]);
        setObservationError(error instanceof Error ? error.message : 'Unable to load SHADOW observation projection.');
      }
    })();
  }, []);

  return (
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/video-analysis" allowedRoles={['coach']} showShellHeader={false}>
      <div className="space-y-6">
        <header className="border-2 border-[#8b4444] bg-[#111111] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">AI / ML Video Analysis</p>
          <h1 className="mt-2 text-3xl font-black text-[#f2e7da]">Coach Video Analysis Console</h1>
          <p className="mt-2 text-sm leading-6 text-[#cfbfae]">
            AI Video Analysis - Planned. All results in this route are mock display only.
          </p>
          <p className="mt-2 text-xs font-mono uppercase tracking-[0.09em] text-[#d4a574]">
            {capabilityStatus}
          </p>
        </header>

        <section className="grid gap-4 lg:grid-cols-2">
          <article className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
            <h2 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Video Observation Stream</h2>
            <div className="mt-3 space-y-2">
              {observationError ? <p className="text-xs text-[#f0c4c4]">{observationError}</p> : null}
              {!observationError && observations.length === 0 ? <p className="text-xs text-[#cfbfae]">No SHADOW observations available.</p> : null}
              {observations.slice(0, 6).map((item) => (
                <div key={item.id} className="border border-[#5a4a3a] bg-[#101010] p-3">
                  <p className="text-sm font-semibold text-[#e8d7c6]">{item.label}</p>
                  <p className="mt-1 text-xs text-[#cfbfae]">Source: {item.source}</p>
                  <p className="mt-1 text-xs text-[#cfbfae]">Review State: {item.review_state}</p>
                </div>
              ))}
            </div>
          </article>

          <article className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
            <h2 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Video Upload Placeholder</h2>
            <div className="mt-3 border border-[#5a4a3a] bg-[#101010] p-4">
              <p className="text-sm text-[#e8d7c6]">Upload interaction is front-end placeholder only in this pass.</p>
              <p className="mt-2 text-xs text-[#cfbfae]">No video processing, no ML inference, and no computer-vision code is running.</p>
              <p className="mt-2 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">
                {capabilityStatus}
              </p>
            </div>
          </article>
        </section>

        <section className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
          <h2 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Film Review | Coach Annotation | Athlete Feedback</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <div className="border border-[#5a4a3a] bg-[#101010] p-3">
              <p className="text-sm font-semibold text-[#e8d7c6]">Film Review</p>
              <p className="mt-1 text-xs text-[#cfbfae]">Timeline markers and review lanes are mock display placeholders.</p>
            </div>
            <div className="border border-[#5a4a3a] bg-[#101010] p-3">
              <p className="text-sm font-semibold text-[#e8d7c6]">Coach Annotation</p>
              <p className="mt-1 text-xs text-[#cfbfae]">Annotation cards are static mock examples for front-end placement only.</p>
            </div>
            <div className="border border-[#5a4a3a] bg-[#101010] p-3">
              <p className="text-sm font-semibold text-[#e8d7c6]">Athlete Feedback</p>
              <p className="mt-1 text-xs text-[#cfbfae]">Feedback display is visible, but no live sync or automation exists.</p>
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <article className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
            <h2 className="font-mono text-sm font-bold uppercase text-[#d4a574]">AI/ML Status: Planned</h2>
            <div className="mt-3 space-y-2">
              {analysisPanels.map((panel) => (
                <div key={panel.title} className="border border-[#5a4a3a] bg-[#101010] p-3">
                  <p className="text-sm font-semibold text-[#e8d7c6]">{panel.title}</p>
                  <p className="mt-1 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">{panel.detail}</p>
                </div>
              ))}
            </div>
          </article>

          <article className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
            <h2 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Comparison And History</h2>
            <div className="mt-3 space-y-2">
              {reviewComparisons.map((item) => (
                <div key={item.title} className="border border-[#5a4a3a] bg-[#101010] p-3">
                  <p className="text-sm font-semibold text-[#e8d7c6]">{item.title}</p>
                  <p className="mt-1 text-xs text-[#cfbfae]">{item.body}</p>
                  <p className="mt-1 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">{item.state}</p>
                </div>
              ))}
            </div>
          </article>
        </section>

        <div className="flex flex-wrap gap-3">
          <Link href="/coach/review-queue" className="border-2 border-[#8b4444] bg-[#2a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574]">
            Back to Coach Workspace
          </Link>
          <Link href="/operations" className="border-2 border-[#4a4a4a] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#b0b0b0]">
            Mission Control
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}

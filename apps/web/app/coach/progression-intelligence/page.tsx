'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
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

interface ShadowReviewItem {
  intake_case_id: string;
  status: 'pending_review' | 'approved' | 'rejected' | 'promoted';
  summary: string;
  primary_athlete_id: string | null;
  created_at: string;
  updated_at: string;
}

export default function CoachProgressionIntelligencePage() {
  const [observations, setObservations] = useState<ShadowObservationItem[]>([]);
  const [reviews, setReviews] = useState<ShadowReviewItem[]>([]);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const [observationResponse, reviewResponse] = await Promise.all([
          fetch('/api/pilot/shadow/observation-projection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 10 }) }),
          fetch('/api/pilot/shadow/review-projection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 10 }) }),
        ]);

        if (!observationResponse.ok || !reviewResponse.ok) {
          throw new Error('Unable to load live coach progression signals.');
        }

        const observationPayload = (await observationResponse.json()) as { items?: ShadowObservationItem[] };
        const reviewPayload = (await reviewResponse.json()) as { queue?: ShadowReviewItem[] };

        setObservations(observationPayload.items ?? []);
        setReviews(reviewPayload.queue ?? []);
        setErrorMessage('');
      } catch (error) {
        setObservations([]);
        setReviews([]);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load live coach progression signals.');
      }
    })();
  }, []);

  const coachTrendPanels = useMemo(
    () => [
      { title: 'Readiness Trends', note: observations.length > 0 ? `${observations.length} live observations available.` : 'No live observations yet.', label: observations.length > 0 ? 'LIVE' : 'EMPTY' },
      { title: 'Coach Review Trends', note: reviews.length > 0 ? `${reviews.length} items in review projection.` : 'No review items yet.', label: reviews.some((item) => item.status === 'pending_review') ? 'COACH REVIEW REQUIRED' : 'LIVE' },
      { title: 'Goal Progression', note: observations.some((item) => item.review_state === 'approved') ? 'Approved signals are present in the projection.' : 'Goal progression remains observational.', label: 'HUMAN REVIEW REQUIRED' },
      { title: 'Skill Progression', note: observations.some((item) => item.label.toLowerCase().includes('skill')) ? 'Skill-related signals detected.' : 'No skill-specific signals yet.', label: 'LIVE' },
    ],
    [observations, reviews],
  );

  const queueItems = useMemo(
    () => [
      reviews.some((item) => item.status === 'pending_review') ? 'Coach Action Queue Live' : 'Coach Action Queue Clear',
      observations.length > 0 ? 'Closed-Loop Feedback Visible' : 'Closed-Loop Feedback Waiting',
      reviews.length > 0 ? 'Development Recommendation Stream Live' : 'Development Recommendation Stream Empty',
      observations.length > 0 ? 'Assessment History Stream Live' : 'Assessment History Stream Empty',
    ],
    [observations, reviews],
  );

  return (
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/progression-intelligence" allowedRoles={['coach']} showShellHeader={false}>
      <div className="space-y-6">
        <header className="border-2 border-[#8b4444] bg-[#111111] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">Closed-Loop Progression Intelligence</p>
          <h1 className="mt-2 text-3xl font-black text-[#f2e7da]">Coach Progression Review Lane</h1>
          <p className="mt-2 text-sm text-[#cfbfae]">
            Front-end visibility only. Recommendation logic, predictive scoring, and automation are not implemented.
          </p>
          <p className="mt-2 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">
            {capabilityStatus}
          </p>
          {errorMessage ? <p className="mt-2 text-xs text-[#f0c4c4]">{errorMessage}</p> : null}
        </header>

        <section className="grid gap-4 lg:grid-cols-2">
          {coachTrendPanels.map((panel) => (
            <article key={panel.title} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
              <p className="text-sm font-semibold text-[#e8d7c6]">{panel.title}</p>
              <p className="mt-1 text-xs text-[#cfbfae]">{panel.note}</p>
              <p className="mt-2 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">{panel.label}</p>
            </article>
          ))}
        </section>

        <section className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
          <h2 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Coach Queue + Timeline</h2>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {queueItems.map((item) => (
              <div key={item} className="border border-[#5a4a3a] bg-[#101010] p-3">
                <p className="text-sm font-semibold text-[#e8d7c6]">{item}</p>
                <p className="mt-1 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">{capabilityStatus}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="flex flex-wrap gap-3">
          <Link href="/coach/review-queue" className="border-2 border-[#8b4444] bg-[#2a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574]">
            Back to Coach Workspace
          </Link>
          <Link href="/athlete/progression-intelligence" className="border-2 border-[#4a4a4a] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#b0b0b0]">
            Athlete Progression View
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}

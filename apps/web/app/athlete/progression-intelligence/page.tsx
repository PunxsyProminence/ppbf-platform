'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';

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

export default function AthleteProgressionIntelligencePage() {
  const [observations, setObservations] = useState<ShadowObservationItem[]>([]);
  const [reviews, setReviews] = useState<ShadowReviewItem[]>([]);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const [observationResponse, reviewResponse] = await Promise.all([
          fetch(`${apiBase()}/api/pilot/shadow/observation-projection`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 12 }) }),
          fetch(`${apiBase()}/api/pilot/shadow/review-projection`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 8 }) }),
        ]);

        if (!observationResponse.ok || !reviewResponse.ok) {
          throw new Error('Unable to load live progression signals.');
        }

        const observationPayload = (await observationResponse.json()) as { items?: ShadowObservationItem[] };
        const reviewPayload = (await reviewResponse.json()) as { queue?: ShadowReviewItem[] };

        setObservations(observationPayload.items ?? []);
        setReviews(reviewPayload.queue ?? []);
        setErrorMessage('');
      } catch (error) {
        setObservations([]);
        setReviews([]);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load live progression signals.');
      }
    })();
  }, []);

  const overviewStats = useMemo(
    () => [
      { label: 'Progression Intelligence Overview', value: observations.length > 0 ? 'LIVE' : 'EMPTY' },
      { label: 'Assessment History', value: String(observations.length) },
      { label: 'Goal Progression', value: reviews.some((item) => item.status === 'approved') ? 'In Review' : 'Observed' },
      { label: 'Skill Progression', value: observations.some((item) => item.review_state === 'approved') ? 'Validated' : 'Observed' },
      { label: 'Readiness Trends', value: observations.length > 0 ? 'Live' : 'Waiting' },
      { label: 'Coach Review Trends', value: String(reviews.length) },
    ],
    [observations, reviews],
  );

  const timelineItems = useMemo(
    () =>
      observations.slice(0, 3).map((item, index) => ({
        period: `Signal ${index + 1}`,
        note: item.label,
        status: item.review_state.toUpperCase(),
      })),
    [observations],
  );

  const recommendationCards = useMemo(
    () => [
      { title: 'Development Recommendation Queue', state: reviews.length > 0 ? `${reviews.length} active` : 'No active queue' },
      { title: 'Closed-Loop Feedback', state: observations.length > 0 ? 'Visible in projection' : 'No projection data' },
      { title: 'Coach Action Queue', state: reviews.some((item) => item.status === 'pending_review') ? 'Pending review' : 'Clear' },
      { title: 'Parent-Support Visibility', state: observations.length > 0 ? 'Available' : 'Not yet observed' },
    ],
    [observations, reviews],
  );

  return (
    <RoleStandaloneView roleLabel="Athlete Workspace" routeLabel="/athlete/progression-intelligence" allowedRoles={['athlete']} showShellHeader={false}>
      <div className="space-y-6">
        <header className="border-2 border-[#8b4444] bg-[#111111] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">Closed-Loop Progression Intelligence</p>
          <h1 className="mt-2 text-3xl font-black text-[#f2e7da]">Athlete Development Timeline</h1>
          <p className="mt-2 text-sm text-[#cfbfae]">
            Closed-Loop Progression Intelligence - Planned. Recommendation and scoring logic is not automated in this pass.
          </p>
          <p className="mt-2 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">
            {capabilityStatus}
          </p>
          {errorMessage ? <p className="mt-2 text-xs text-[#f0c4c4]">{errorMessage}</p> : null}
        </header>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {overviewStats.map((item) => (
            <article key={item.label} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-3">
              <p className="text-[11px] font-mono uppercase tracking-[0.12em] text-[#d4a574]">{item.label}</p>
              <p className="mt-2 text-sm font-semibold text-[#e8d7c6]">{item.value}</p>
            </article>
          ))}
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <article className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
            <h2 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Training History + Assessment History</h2>
            <div className="mt-3 space-y-2">
              {timelineItems.map((item) => (
                <div key={item.period} className="border border-[#5a4a3a] bg-[#101010] p-3">
                  <p className="text-sm font-semibold text-[#e8d7c6]">{item.period}</p>
                  <p className="mt-1 text-xs text-[#cfbfae]">{item.note}</p>
                  <p className="mt-1 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">{item.status}</p>
                </div>
              ))}
            </div>
          </article>

          <article className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
            <h2 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Recommendation And Feedback Lane</h2>
            <div className="mt-3 space-y-2">
              {recommendationCards.map((card) => (
                <div key={card.title} className="border border-[#5a4a3a] bg-[#101010] p-3">
                  <p className="text-sm font-semibold text-[#e8d7c6]">{card.title}</p>
                  <p className="mt-1 text-xs font-mono uppercase tracking-[0.08em] text-[#d4a574]">{card.state}</p>
                </div>
              ))}
            </div>
          </article>
        </section>

        <div className="border-2 border-[#8b4444] bg-[#0f0f0f] p-4">
          <p className="text-sm font-semibold text-[#d4a574]">Human Governance Boundary</p>
          <p className="mt-1 text-xs text-[#cfbfae]">
            Coach Review Required | Human Review Required. No automated athlete decisioning is performed.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link href="/athlete/dashboard" className="border-2 border-[#8b4444] bg-[#2a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574]">
            Back to Athlete Workspace
          </Link>
          <Link href="/parent/progression-visibility" className="border-2 border-[#4a4a4a] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#b0b0b0]">
            Parent Support Visibility
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import FeatureSurface from '@/components/FeatureSurface';

interface ShadowResearchItem {
  event_id: number;
  requirement: string | null;
  knowledge_gap: string | null;
  evidence_label: string | null;
  source_status: string;
  review_state: 'pending_review' | 'approved' | 'rejected' | 'promoted' | 'unknown';
  source_event_name: string;
  created_at: string;
}

export default function ResearchIntakePage() {
  const [items, setItems] = useState<ShadowResearchItem[]>([]);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/pilot/shadow/research-projection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 120 }),
        });

        if (!response.ok) {
          throw new Error('Unable to load SHADOW research projection.');
        }

        const payload = (await response.json()) as { items?: ShadowResearchItem[] };
        setItems(payload.items ?? []);
        setErrorMessage('');
      } catch (error) {
        setItems([]);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load SHADOW research projection.');
      }
    })();
  }, []);

  const counts = useMemo(() => {
    return {
      pending: items.filter((item) => item.review_state === 'pending_review').length,
      approved: items.filter((item) => item.review_state === 'approved').length,
      rejected: items.filter((item) => item.review_state === 'rejected').length,
      promoted: items.filter((item) => item.review_state === 'promoted').length,
    };
  }, [items]);

  return (
    <FeatureSurface
      eyebrow="Research Intake"
      title="Research Inbox and intake lane"
      description="SHADOW research projection showing requirements, gaps, evidence labels, and review state."
      status="ready"
      currentStage="research"
      primaryLinks={[
        { label: 'Q&A Research Chat', href: '/research/chat' },
        { label: 'Evidence review', href: '/evidence' },
        { label: 'Pipeline publish stage', href: '/source-control#publish' },
      ]}
      stats={[
        { label: 'Mode', value: 'Research Projection' },
        { label: 'Current Stage', value: 'Research Intake' },
        { label: 'Items', value: String(items.length) },
        { label: 'Pending Review', value: String(counts.pending) },
      ]}
    >
      <div className="space-y-4">
        {errorMessage ? (
          <section className="border-2 border-[#8b4444] bg-[#151515] p-4 text-sm text-[#f0c4c4]">{errorMessage}</section>
        ) : null}

        {!errorMessage && items.length === 0 ? (
          <section className="border-2 border-[#8b4444] bg-[#151515] p-4">
            <p className="text-[12px] font-mono uppercase tracking-[0.18em] text-[#d4a574]">Empty State</p>
            <p className="mt-2 text-[14px] text-[#cfbfae]">No SHADOW research projection items exist for this organization yet.</p>
          </section>
        ) : null}

        <section className="border-2 border-[#8b4444] bg-[#151515] p-4">
          <p className="text-[12px] font-mono uppercase tracking-[0.18em] text-[#d4a574]">Review State Summary</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: 'Pending', value: counts.pending },
              { label: 'Approved', value: counts.approved },
              { label: 'Rejected', value: counts.rejected },
              { label: 'Promoted', value: counts.promoted },
            ].map((entry) => (
              <article key={entry.label} className="border border-[#5a4a3a] bg-[#0f0f0f] p-3">
                <p className="text-[11px] font-mono uppercase tracking-[0.14em] text-[#b0a095]">{entry.label}</p>
                <p className="mt-2 text-2xl font-black text-[#e8d7c6]">{entry.value}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="space-y-3 border-2 border-[#8b4444] bg-[#151515] p-4">
          <p className="text-[12px] font-mono uppercase tracking-[0.18em] text-[#d4a574]">Research Intake Cards</p>
          {items.map((item) => (
            <article key={item.event_id} className="border border-[#8b4444] bg-[#1a1a1a]/70 p-4">
              <div className="grid gap-2 md:grid-cols-2">
                <p className="text-[16px] font-bold text-[#e8d7c6]">{item.source_event_name}</p>
                <p className="text-[13px] font-mono uppercase tracking-[0.1em] text-[#d4a574]">Status: {item.review_state}</p>
                <p className="text-[14px] text-[#cfbfae]">Requirement: {item.requirement || 'Not provided'}</p>
                <p className="text-[14px] text-[#cfbfae]">Knowledge Gap: {item.knowledge_gap || 'Not provided'}</p>
                <p className="text-[14px] text-[#cfbfae]">Evidence Label: {item.evidence_label || 'Not provided'}</p>
                <p className="text-[14px] text-[#cfbfae]">Source Status: {item.source_status}</p>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-[#5a4a3a] pt-3">
                <p className="font-mono text-[12px] uppercase tracking-[0.12em] text-[#d4a574]">Next: Evidence Review</p>
                <Link
                  href="/evidence"
                  className="inline-flex min-h-[44px] items-center border border-[#8b4444] bg-[#2a1414] px-3 text-[12px] font-bold text-[#e8d7c6] transition hover:border-[#d4a574]"
                >
                  Move to Evidence -&gt;
                </Link>
              </div>
            </article>
          ))}
        </section>
      </div>
    </FeatureSurface>
  );
}
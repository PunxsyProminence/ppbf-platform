'use client';

import { useEffect, useMemo, useState } from 'react';
import FeatureSurface from '@/components/FeatureSurface';
import { apiBase } from '@/lib/apiBase';

interface ShadowObservationItem {
  id: string;
  source: 'event' | 'telemetry';
  label: string;
  entity_type: string | null;
  entity_id: string | null;
  review_state: 'pending_review' | 'approved' | 'rejected' | 'promoted' | 'unknown';
  created_at: string;
}

export default function EvidenceReviewPage() {
  const [items, setItems] = useState<ShadowObservationItem[]>([]);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/shadow/observation-projection`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 120 }),
        });

        if (!response.ok) {
          throw new Error('Unable to load SHADOW observation projection.');
        }

        const payload = (await response.json()) as { items?: ShadowObservationItem[] };
        setItems(payload.items ?? []);
        setErrorMessage('');
      } catch (error) {
        setItems([]);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load SHADOW observation projection.');
      }
    })();
  }, []);

  const grouped = useMemo(() => {
    return {
      pending: items.filter((item) => item.review_state === 'pending_review'),
      approved: items.filter((item) => item.review_state === 'approved'),
      rejected: items.filter((item) => item.review_state === 'rejected'),
      other: items.filter((item) => !['pending_review', 'approved', 'rejected'].includes(item.review_state)),
    };
  }, [items]);

  return (
    <FeatureSurface
      eyebrow="Evidence Review"
      title="Verification lane for submitted intake items"
      description="SHADOW observation projection read model for review and validation workflows."
      status="ready"
      currentStage="evidence"
      primaryLinks={[
        { label: 'Research intake', href: '/research' },
        { label: 'Knowledge graph', href: '/knowledge-graph' },
      ]}
      stats={[
        { label: 'Current Stage', value: 'Evidence Review' },
        { label: 'Next Stage', value: 'Knowledge Graph' },
        { label: 'Review Mode', value: 'SHADOW Projection' },
        { label: 'Items', value: String(items.length) },
      ]}
    >
      <div className="space-y-4">
        {errorMessage ? <section className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4 text-sm text-[#f0c4c4]">{errorMessage}</section> : null}

        {!errorMessage && items.length === 0 ? (
          <section className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
            <p className="text-[12px] font-mono uppercase tracking-[0.16em] text-[#d4a574]">Empty State</p>
            <p className="mt-2 text-[14px] text-[#cfbfae]">No SHADOW observation records are available yet.</p>
          </section>
        ) : null}

        {[
          { title: 'Needs Review', items: grouped.pending },
          { title: 'Accepted', items: grouped.approved },
          { title: 'Rejected', items: grouped.rejected },
          { title: 'Other States', items: grouped.other },
        ].map((group) => (
          <section key={group.title} className="border-2 border-[#8b4444] bg-[#1a1a1a]/60 p-4">
            <p className="text-[12px] font-mono uppercase tracking-[0.16em] text-[#d4a574]">{group.title}</p>
            {group.items.length === 0 ? (
              <p className="mt-2 text-sm text-[#b0a095]">No items.</p>
            ) : (
              <div className="mt-3 space-y-3">
                {group.items.map((item) => (
                  <article key={item.id} className="border border-[#5a4a3a] bg-[#101010] p-3">
                    <p className="text-[16px] font-bold text-[#e8d7c6]">{item.label}</p>
                    <div className="mt-2 grid gap-1 text-[14px] text-[#cfbfae] md:grid-cols-2">
                      <p>Source: {item.source}</p>
                      <p>Review State: {item.review_state}</p>
                      <p>Entity Type: {item.entity_type || 'n/a'}</p>
                      <p>Entity ID: {item.entity_id || 'n/a'}</p>
                    </div>
                    <p className="mt-2 font-mono text-[12px] uppercase tracking-[0.1em] text-[#d4a574]">-&gt; Points to Knowledge Graph</p>
                  </article>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </FeatureSurface>
  );
}
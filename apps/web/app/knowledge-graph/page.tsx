'use client';

import { useEffect, useMemo, useState } from 'react';
import FeatureSurface from '@/components/FeatureSurface';
import { apiBase } from '@/lib/apiBase';

interface ShadowKnowledgeNode {
  type: 'Observation' | 'Pattern' | 'Finding' | 'Validated Lesson';
  title: string;
  source_event_name: string;
  entity_type: string;
  entity_id: string;
  review_state: 'pending_review' | 'approved' | 'rejected' | 'promoted' | 'unknown';
  created_at: string;
}

export default function KnowledgeGraphPage() {
  const [nodes, setNodes] = useState<ShadowKnowledgeNode[]>([]);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/shadow/knowledge-projection`, {
        credentials: 'include',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 120 }),
        });

        if (!response.ok) {
          throw new Error('Unable to load SHADOW knowledge projection.');
        }

        const payload = (await response.json()) as { items?: ShadowKnowledgeNode[] };
        setNodes(payload.items ?? []);
        setErrorMessage('');
      } catch (error) {
        setNodes([]);
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load SHADOW knowledge projection.');
      }
    })();
  }, []);

  const grouped = useMemo(() => {
    return {
      observation: nodes.filter((item) => item.type === 'Observation'),
      pattern: nodes.filter((item) => item.type === 'Pattern'),
      finding: nodes.filter((item) => item.type === 'Finding'),
      validated: nodes.filter((item) => item.type === 'Validated Lesson'),
    };
  }, [nodes]);

  return (
    <FeatureSurface
      eyebrow="Knowledge Graph"
      title="Concept relationship map"
      description="SHADOW event-derived knowledge projection for observation, pattern, finding, and validated lesson streams."
      status="ready"
      currentStage="knowledge"
      primaryLinks={[
        { label: 'Research intake', href: '/research' },
        { label: 'Evidence review', href: '/evidence' },
        { label: 'Scenario simulator', href: '/simulator' },
      ]}
      stats={[
        { label: 'Current Stage', value: 'Knowledge Graph' },
        { label: 'Source', value: 'SHADOW Projection' },
        { label: 'Node Count', value: String(nodes.length) },
        { label: 'Mode', value: 'Read Model' },
      ]}
    >
      <div className="space-y-4">
        {errorMessage ? (
          <section className="border-2 border-[var(--patina-700)] bg-[var(--hide-900)]/60 p-4 text-sm text-[var(--locked-ink)]">{errorMessage}</section>
        ) : null}

        {!errorMessage && nodes.length === 0 ? (
          <section className="border-2 border-[var(--patina-700)] bg-[var(--hide-900)]/60 p-4">
            <p className="text-[12px] font-mono uppercase tracking-[0.16em] text-[var(--brass-300)]">Empty State</p>
            <p className="mt-2 text-[14px] text-[var(--bone-300)]">No SHADOW knowledge projection data exists for this organization yet.</p>
          </section>
        ) : null}

        {[
          { title: 'Observation', items: grouped.observation },
          { title: 'Pattern', items: grouped.pattern },
          { title: 'Finding', items: grouped.finding },
          { title: 'Validated Lesson', items: grouped.validated },
        ].map((group) => (
          <section key={group.title} className="border-2 border-[var(--patina-700)] bg-[var(--hide-900)]/60 p-4">
            <p className="text-[12px] font-mono uppercase tracking-[0.16em] text-[var(--brass-300)]">{group.title}</p>
            {group.items.length === 0 ? (
              <p className="mt-2 text-sm text-[var(--bone-400)]">No items.</p>
            ) : (
              <div className="mt-3 space-y-2">
                {group.items.map((item) => (
                  <article key={`${item.entity_type}-${item.entity_id}-${item.created_at}`} className="border border-[var(--hide-500)] bg-[var(--hide-950)] px-3 py-2 text-[14px] text-[var(--bone-200)]">
                    <p className="font-semibold">{item.title}</p>
                    <p className="mt-1 text-xs text-[var(--bone-300)]">{item.entity_type} / {item.entity_id}</p>
                    <p className="text-xs text-[var(--bone-300)]">Review State: {item.review_state}</p>
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
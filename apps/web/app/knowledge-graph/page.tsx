'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import DevelopmentPipelineBanner from '@/components/DevelopmentPipelineBanner';
import ShadowChatButton from '@/components/ShadowChatButton';
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

/* Law 3: a review state is a queue outcome, so it rides the status ladder with
   glyph + uppercase label rather than a bare lowercase word. 'unknown' is not
   an outcome and stays off the saturated rungs. */
const REVIEW_STATE_BADGES: Record<ShadowKnowledgeNode['review_state'], { className: string; glyph: string; label: string }> = {
  pending_review: { className: 'badge badge--monitor', glyph: '◉', label: 'Pending Review' },
  approved: { className: 'badge badge--cleared', glyph: '✓', label: 'Approved' },
  rejected: { className: 'badge badge--locked', glyph: '✕', label: 'Rejected' },
  promoted: { className: 'badge badge--cleared', glyph: '✓', label: 'Promoted' },
  /* The sheet's own administrative rung (badge--filed) replaced the
     hand-rolled chip this entry used to carry -- same ◌, same job. */
  unknown: { className: 'badge badge--filed', glyph: '◌', label: 'Unknown' },
};

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

  const stats = [
    { label: 'Current Stage', value: 'Knowledge Graph' },
    { label: 'Source', value: 'SHADOW Projection' },
    { label: 'Node Count', value: String(nodes.length) },
    { label: 'Mode', value: 'Read Model' },
  ];

  return (
    /* Room--file: the research wall -- cork, gooseneck light. Each knowledge
       stream is a column of paper records pinned to it. */
    <main className="room--file min-h-screen bg-[var(--hide-950)]">
      <header className="mat-leather--raised border-b border-[color:rgba(212,175,74,.22)] px-[var(--s5)] py-[var(--s5)]">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-end justify-between gap-[var(--s4)]">
          <div>
            <p className="t-eyebrow">Knowledge Graph</p>
            <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-xl)' }}>
              Concept Relationship Map
            </h1>
            <p className="t-body mt-[var(--s3)] max-w-[64ch]">
              SHADOW event-derived knowledge projection for observation, pattern, finding, and validated lesson streams.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-[var(--s3)]">
            <ShadowChatButton context="Knowledge Graph" />
            <Link href="/research" className="btn btn--ghost">
              Research Intake
            </Link>
            <Link href="/evidence" className="btn btn--ghost">
              Evidence Review
            </Link>
            <Link href="/simulator" className="btn btn--ghost">
              Simulator
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1200px] space-y-[var(--s5)] p-[var(--s5)]">
        <DevelopmentPipelineBanner currentStage="knowledge" />

        <section aria-label="Knowledge graph status" className="flex flex-wrap gap-[var(--s3)]">
          {stats.map((item) => (
            <span key={item.label} className="plaque">
              {item.label.toUpperCase()}: {item.value.toUpperCase()}
            </span>
          ))}
        </section>

        {errorMessage ? (
          <section role="alert" className="mat-leather rounded-[var(--r-md)] border-2 border-[color:var(--locked)] p-[var(--s4)]">
            <span className="badge badge--locked">
              <i>✕</i>Projection Unavailable
            </span>
            <p className="t-body mt-[var(--s3)]">{errorMessage}</p>
          </section>
        ) : null}

        {!errorMessage && nodes.length === 0 ? (
          <section className="mat-paper note-torn rounded-[var(--r-sm)] p-[var(--s5)]">
            <p className="font-mono text-[length:var(--t-xs)] font-bold uppercase tracking-[0.13em] text-[color:var(--hide-600)]">Empty State</p>
            <p className="t-typed mt-[var(--s2)] text-[length:var(--t-sm)]">
              No SHADOW knowledge projection data exists for this organization yet.
            </p>
          </section>
        ) : null}

        <div className="grid gap-[var(--s5)] lg:grid-cols-2">
          {[
            { title: 'Observation', items: grouped.observation },
            { title: 'Pattern', items: grouped.pattern },
            { title: 'Finding', items: grouped.finding },
            { title: 'Validated Lesson', items: grouped.validated },
          ].map((group) => (
            <section key={group.title} className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
              <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
                {group.title}
              </h2>
              {group.items.length === 0 ? (
                <p className="t-muted mt-[var(--s3)]">No items.</p>
              ) : (
                <div className="mt-[var(--s4)] space-y-[var(--s3)]">
                  {group.items.map((item) => {
                    const badge = REVIEW_STATE_BADGES[item.review_state];
                    return (
                      <article
                        key={`${item.entity_type}-${item.entity_id}-${item.created_at}`}
                        className="relative mat-paper rounded-[var(--r-sm)] p-[var(--s4)]"
                      >
                        <span className="pin pin--brass" aria-hidden="true" />
                        <div className="flex flex-wrap items-start justify-between gap-[var(--s3)]">
                          <p className="t-typed text-[length:var(--t-sm)] font-bold">{item.title}</p>
                          <span className={badge.className}>
                            <i>{badge.glyph}</i>
                            {badge.label}
                          </span>
                        </div>
                        {/* Law 4: entity identifiers are auditable records -- mono voice. */}
                        <p className="t-data mt-[var(--s2)] !text-[color:var(--hide-800)]">
                          {item.entity_type} / {item.entity_id}
                        </p>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';

import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';

type ReviewState = 'pending_review' | 'approved' | 'rejected';

interface ReviewSource {
  source_id: string;
  title: string;
  publisher: string | null;
  source_type: string;
  status: string;
  approval_state: ReviewState;
  verification_state: string;
}

interface ReviewDocument {
  document_id: string;
  source_id: string;
  document_name: string;
  ingest_state: string;
  index_completed_at: string | null;
  approval_state: ReviewState;
  verification_state: string;
  extraction_error: string | null;
  chunk_count: number;
}

interface ReviewQueue {
  sources: ReviewSource[];
  documents: ReviewDocument[];
}

/* Law 3: approval state is a queue outcome -- glyph + uppercase label on the
   ladder. Law 7 handles the rejected outcome separately, as an ink stamp. */
const APPROVAL_BADGES: Record<ReviewState, { className: string; glyph: string; label: string }> = {
  pending_review: { className: 'badge badge--monitor', glyph: '◉', label: 'Pending Review' },
  approved: { className: 'badge badge--cleared', glyph: '✓', label: 'Approved' },
  rejected: { className: 'badge badge--locked', glyph: '✕', label: 'Rejected' },
};

export default function EvidenceReviewPage() {
  const [queue, setQueue] = useState<ReviewQueue>({ sources: [], documents: [] });
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState('');
  // Before the first read resolved, this page asserted both of its empty
  // sentences at once -- an admin opening it saw "No sources" and "No
  // documents" while the request was still in flight. /research already
  // solved this; the aria-busy note is the same one it renders.
  const [loading, setLoading] = useState(true);

  const fetchQueue = useCallback(async (): Promise<ReviewQueue> => {
    const response = await fetch(`${apiBase()}/api/pilot/shadow/evidence/review?limit=200`, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Unable to load the evidence review queue.');
    return response.json() as Promise<ReviewQueue>;
  }, []);

  useEffect(() => {
    void fetchQueue().then(
      setQueue,
      (loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load evidence.');
      },
    ).finally(() => setLoading(false));
  }, [fetchQueue]);

  const update = async (payload: Record<string, string>) => {
    const key = `${payload.entityType}:${payload.entityId}:${payload.action}`;
    setBusyKey(key);
    setError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/evidence/review`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? 'Evidence review failed.');
      }
      setQueue(await fetchQueue());
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Evidence review failed.');
    } finally {
      setBusyKey('');
    }
  };

  const reviewButtons = (entityType: 'source' | 'document', entityId: string) => (
    <div className="flex flex-wrap gap-[var(--s3)]">
      {(['approved', 'rejected'] as const).map((approvalState) => {
        const key = `${entityType}:${entityId}:review`;
        return (
          <button
            key={approvalState}
            type="button"
            disabled={busyKey === key}
            onClick={() => void update({
              entityType,
              entityId,
              action: 'review',
              approvalState,
            })}
            /* Law 2: the reject control is a control, not a status -- it stays
               off the safety red and wears the ghost chassis. The outcome it
               produces is what gets the stamp. */
            className={`${approvalState === 'approved' ? 'btn' : 'btn btn--ghost'} disabled:cursor-not-allowed disabled:opacity-60`}
          >
            {approvalState === 'approved' ? 'Approve + verify' : 'Reject'}
          </button>
        );
      })}
    </div>
  );

  return (
    <RoleStandaloneView
      roleLabel="Evidence Review"
      routeLabel="/evidence"
      allowedRoles={['admin', 'platform_owner']}
      room="file"
    >
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
          <p className="t-eyebrow">SHADOW Evidence</p>
          <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-xl)' }}>
            Evidence Review Queue
          </h1>
          <p className="t-body mt-[var(--s3)] max-w-[64ch]">
            Only approved, verified, fully indexed documents can support SHADOW citations.
          </p>
          {/* The read returns the whole library with anything pending sorted
              to the top -- it is not filtered to a queue. Saying so is what
              makes the empty states below mean what they say. */}
          <p className="t-muted mt-[var(--s3)] max-w-[64ch]">
            Every source and document held for this organization is listed, with anything awaiting review sorted
            first.
          </p>
        </header>

        {error ? (
          <div role="alert" className="mat-leather rounded-[var(--r-md)] border-2 border-[color:var(--locked)] p-[var(--s4)]">
            <span className="badge badge--locked">
              <i>✕</i>Review Error
            </span>
            <p className="t-body mt-[var(--s3)]">{error}</p>
          </div>
        ) : null}

        {loading ? (
          <section aria-busy="true" className="mat-paper note-torn rounded-[var(--r-sm)] p-[var(--s5)]">
            {/* .working pins --brass-300, which is tuned for leather and
                measures about 1.2:1 on paper. --brass-800 is the rung
                .mat-paper already restates .t-eyebrow to for exactly this
                reason (6.49:1); the glyph is a ::before on this element, so
                the ink has to be set here rather than on a child. */}
            <span className="working" style={{ color: 'var(--brass-800)' }}>Loading the evidence library...</span>
          </section>
        ) : null}

        <section className="space-y-[var(--s4)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
            <span className="text-[color:var(--hide-900)]">Sources</span>
          </h2>
          {/* The ink goes on a child span, exactly as the heading above does.
              ppbf.css is unlayered and .t-body states a bone colour, so a
              Tailwind text-[…] utility on the same element loses the cascade
              and never lands -- this line was rendering bone-on-cork at
              2.34:1. A span carries no .t-body of its own, so it wins. */}
          {!loading && queue.sources.length === 0 ? (
            <p className="t-body">
              <span className="text-[color:var(--hide-800)]">
                No sources have been recorded for this organization yet. This is an empty library, not a cleared
                queue.
              </span>
            </p>
          ) : null}
          {queue.sources.map((source) => {
            const badge = APPROVAL_BADGES[source.approval_state];
            return (
              <article key={source.source_id} className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
                <div className="flex flex-wrap items-start justify-between gap-[var(--s4)]">
                  <div>
                    <div className="flex flex-wrap items-center gap-[var(--s3)]">
                      <h3 className="t-body font-bold text-[color:var(--bone-100)]">{source.title}</h3>
                      <span className={badge.className}>
                        <i>{badge.glyph}</i>
                        {badge.label}
                      </span>
                    </div>
                    <p className="t-muted mt-[var(--s2)]">
                      {source.publisher || 'Publisher unavailable'} · {source.source_type} · {source.status}
                    </p>
                    {/* Law 4: the review record itself is auditable -- mono voice. */}
                    <p className="t-data mt-[var(--s2)] text-[color:var(--bone-300)]">
                      {source.approval_state} / {source.verification_state}
                    </p>
                    {/* Law 7: a rejection is a governance refusal, so it is a
                        static ink stamp on the record -- never a dismissible
                        notice. */}
                    {source.approval_state === 'rejected' ? (
                      <span className="stamp mt-[var(--s4)]">Rejected</span>
                    ) : null}
                  </div>
                  {reviewButtons('source', source.source_id)}
                </div>
              </article>
            );
          })}
        </section>

        <section className="space-y-[var(--s4)]">
          <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
            <span className="text-[color:var(--hide-900)]">Documents</span>
          </h2>
          {!loading && queue.documents.length === 0 ? (
            <p className="t-body">
              <span className="text-[color:var(--hide-800)]">
                No documents have been recorded for this organization yet. This is an empty library, not a cleared
                queue.
              </span>
            </p>
          ) : null}
          {queue.documents.map((document) => {
            const badge = APPROVAL_BADGES[document.approval_state];
            return (
              <article key={document.document_id} className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
                <div className="flex flex-wrap items-start justify-between gap-[var(--s4)]">
                  <div>
                    <div className="flex flex-wrap items-center gap-[var(--s3)]">
                      <h3 className="t-body font-bold text-[color:var(--bone-100)]">{document.document_name}</h3>
                      <span className={badge.className}>
                        <i>{badge.glyph}</i>
                        {badge.label}
                      </span>
                    </div>
                    {/* chunk_count counts every chunk row for the document
                        regardless of state (listShadowLibraryReviewQueue does
                        a plain count over shadow_library_chunks), so calling
                        them 'indexed' contradicted the ingest_state printed
                        two words earlier -- 'chunking · 14 indexed chunks'
                        named as indexed exactly the chunks the retrieval gate
                        would refuse. Indexing is confirmed by
                        index_completed_at and by nothing else, so that is the
                        field that gets to say so. */}
                    <p className="t-muted mt-[var(--s2)]">
                      {document.ingest_state} · {document.chunk_count} chunk
                      {document.chunk_count === 1 ? '' : 's'} stored ·{' '}
                      {document.index_completed_at ? 'indexing confirmed' : 'indexing not confirmed'}
                    </p>
                    <p className="t-data mt-[var(--s2)] text-[color:var(--bone-300)]">
                      {document.approval_state} / {document.verification_state}
                    </p>
                    {document.approval_state === 'rejected' ? (
                      <span className="stamp mt-[var(--s4)]">Rejected</span>
                    ) : null}
                    {/* Law 7: a document that cannot be approved carries the
                        refusal as ink on the record, with the reason beside it. */}
                    {document.extraction_error ? (
                      <div className="mt-[var(--s4)]">
                        <span className="stamp stamp--flat">Cannot Approve</span>
                        <p className="t-muted mt-[var(--s2)]">Extraction failed; this document cannot be approved.</p>
                      </div>
                    ) : null}
                  </div>
                  <div className="space-y-[var(--s3)]">
                    {document.chunk_count > 0 && !document.index_completed_at ? (
                      <button
                        type="button"
                        disabled={busyKey === `document:${document.document_id}:complete_indexing`}
                        onClick={() => void update({
                          entityType: 'document',
                          entityId: document.document_id,
                          action: 'complete_indexing',
                        })}
                        className="btn btn--ghost block disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Confirm index complete
                      </button>
                    ) : null}
                    {reviewButtons('document', document.document_id)}
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      </div>
    </RoleStandaloneView>
  );
}

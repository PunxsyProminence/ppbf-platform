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

export default function EvidenceReviewPage() {
  const [queue, setQueue] = useState<ReviewQueue>({ sources: [], documents: [] });
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState('');

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
    );
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
    <div className="flex gap-2">
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
            className="border border-[#8b4444] bg-[#211717] px-3 py-1 text-xs font-mono uppercase text-[#e8d7c6] disabled:opacity-50"
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
      allowedRoles={['admin']}
    >
      <div className="space-y-6">
        <header className="border-2 border-[#8b4444] bg-[#111] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">SHADOW evidence</p>
          <h1 className="mt-2 text-3xl font-black text-[#f2e7da]">Evidence Review Queue</h1>
          <p className="mt-2 text-sm text-[#cfbfae]">
            Only approved, verified, fully indexed documents can support SHADOW citations.
          </p>
        </header>

        {error ? <p className="border border-[#8b4444] bg-[#2a1414] p-3 text-sm text-[#f0c4c4]">{error}</p> : null}

        <section className="space-y-3">
          <h2 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Sources</h2>
          {queue.sources.length === 0 ? <p className="text-sm text-[#cfbfae]">No sources are awaiting review.</p> : null}
          {queue.sources.map((source) => (
            <article key={source.source_id} className="border border-[#5a4a3a] bg-[#151515] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-[#f2e7da]">{source.title}</h3>
                  <p className="text-xs text-[#cfbfae]">
                    {source.publisher || 'Publisher unavailable'} · {source.source_type} · {source.status}
                  </p>
                  <p className="mt-1 text-xs font-mono text-[#a99a8b]">
                    {source.approval_state} / {source.verification_state}
                  </p>
                </div>
                {reviewButtons('source', source.source_id)}
              </div>
            </article>
          ))}
        </section>

        <section className="space-y-3">
          <h2 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Documents</h2>
          {queue.documents.length === 0 ? <p className="text-sm text-[#cfbfae]">No documents are awaiting review.</p> : null}
          {queue.documents.map((document) => (
            <article key={document.document_id} className="border border-[#5a4a3a] bg-[#151515] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-[#f2e7da]">{document.document_name}</h3>
                  <p className="text-xs text-[#cfbfae]">
                    {document.ingest_state} · {document.chunk_count} indexed chunks
                  </p>
                  <p className="mt-1 text-xs font-mono text-[#a99a8b]">
                    {document.approval_state} / {document.verification_state}
                  </p>
                  {document.extraction_error ? (
                    <p className="mt-1 text-xs text-[#f0c4c4]">Extraction failed; this document cannot be approved.</p>
                  ) : null}
                </div>
                <div className="space-y-2">
                  {document.chunk_count > 0 && !document.index_completed_at ? (
                    <button
                      type="button"
                      disabled={busyKey === `document:${document.document_id}:complete_indexing`}
                      onClick={() => void update({
                        entityType: 'document',
                        entityId: document.document_id,
                        action: 'complete_indexing',
                      })}
                      className="block border border-[#5a4a3a] bg-[#171d21] px-3 py-1 text-xs font-mono uppercase text-[#d4a574] disabled:opacity-50"
                    >
                      Confirm index complete
                    </button>
                  ) : null}
                  {reviewButtons('document', document.document_id)}
                </div>
              </div>
            </article>
          ))}
        </section>
      </div>
    </RoleStandaloneView>
  );
}

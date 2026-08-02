'use client';

import { useCallback, useEffect, useState } from 'react';

import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';

type ReviewState = 'new' | 'contacted' | 'archived';

interface Submission {
  submission_id: string;
  full_name: string;
  email: string;
  phone: string | null;
  visitor_type: string;
  program_interest: string;
  preferred_contact_method: string;
  message: string | null;
  review_state: ReviewState;
  created_at: string;
}

function reviewStateTone(state: ReviewState): string {
  if (state === 'new') return 'border-[color:var(--brass-700)] bg-[var(--rust-900)] text-[var(--locked-ink)]';
  if (state === 'contacted') return 'border-[var(--patina-500)] bg-[color-mix(in_srgb,var(--cleared)_14%,var(--hide-950))] text-[var(--cleared-ink)]';
  return 'border-[color:var(--hide-600)] bg-[var(--hide-900)] text-[color:var(--bone-400)]';
}

export default function PublicInterestReviewPage() {
  const [items, setItems] = useState<Submission[]>([]);
  const [filter, setFilter] = useState<'ALL' | ReviewState>('new');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');

  const fetchItems = useCallback(async (): Promise<Submission[]> => {
    const params = filter === 'ALL' ? '' : `&review_state=${filter}`;
    const response = await fetch(`${apiBase()}/api/pilot/public-interest/review?limit=100${params}`, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Unable to load public interest submissions.');
    const payload = (await response.json()) as { items?: Submission[] };
    return payload.items ?? [];
  }, [filter]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    void fetchItems().then(
      (loaded) => {
        setItems(loaded);
        setError('');
      },
      (loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load submissions.');
      },
    ).finally(() => setLoading(false));
  }, [fetchItems]);

  async function setReviewState(submissionId: string, reviewState: ReviewState) {
    setBusyId(submissionId);
    setError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/public-interest/review`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submission_id: submissionId, review_state: reviewState }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Unable to update this submission.');
      }
      setItems(await fetchItems());
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Unable to update this submission.');
    } finally {
      setBusyId('');
    }
  }

  return (
    <RoleStandaloneView
      roleLabel="Public Interest Review"
      routeLabel="/admin/public-interest"
      allowedRoles={['admin', 'platform_owner']}
    >
      <div className="space-y-6">
        <header className="border-2 border-[color:var(--brass-700)] bg-[#111] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[color:var(--brass-300)]">Public Portal</p>
          <h1 className="mt-2 text-3xl font-black text-[color:var(--bone-100)]">Public Interest Submissions</h1>
          <p className="mt-2 text-sm text-[color:var(--bone-300)]">
            Real submissions from the public marketing site&apos;s interest-intake form. This is real contact
            information for prospective members, volunteers, and partners -- follow up, then mark each one
            Contacted or Archived.
          </p>
        </header>

        <div className="flex flex-wrap gap-2">
          {(['new', 'contacted', 'archived', 'ALL'] as const).map((state) => (
            <button
              key={state}
              type="button"
              onClick={() => setFilter(state)}
              className={`border-2 px-3 py-1 text-xs font-mono font-bold uppercase tracking-[0.08em] transition ${
                filter === state
                  ? 'border-[color:var(--brass-300)] bg-[var(--hide-800)] text-[color:var(--brass-300)]'
                  : 'border-[color:var(--hide-600)] bg-[var(--hide-950)] text-[color:var(--bone-300)] hover:border-[color:var(--brass-700)]'
              }`}
            >
              {state}
            </button>
          ))}
        </div>

        {error ? <p className="border border-[color:var(--brass-700)] bg-[var(--rust-900)] p-3 text-sm text-[var(--locked-ink)]">{error}</p> : null}
        {loading ? <p className="text-sm text-[color:var(--hide-800)]">Loading submissions...</p> : null}
        {!loading && items.length === 0 && !error ? (
          <p className="text-sm text-[color:var(--hide-800)]">No submissions match this filter.</p>
        ) : null}

        <section className="space-y-3">
          {items.map((item) => (
            <article key={item.submission_id} className="border border-[color:var(--hide-600)] bg-[var(--hide-950)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-[color:var(--bone-100)]">{item.full_name}</h3>
                    <span className={`border px-2 py-0.5 text-[10px] font-mono font-bold uppercase ${reviewStateTone(item.review_state)}`}>
                      {item.review_state}
                    </span>
                  </div>
                  <p className="text-xs text-[color:var(--bone-300)]">
                    {item.email}{item.phone ? ` · ${item.phone}` : ''} · Prefers: {item.preferred_contact_method}
                  </p>
                  <p className="text-xs text-[var(--bone-400)]">
                    {item.visitor_type} · {item.program_interest} · {new Date(item.created_at).toLocaleString()}
                  </p>
                  {item.message ? <p className="mt-1 text-xs italic text-[color:var(--bone-300)]">&quot;{item.message}&quot;</p> : null}
                </div>
                <div className="flex gap-2">
                  {(['contacted', 'archived'] as const).map((state) => (
                    <button
                      key={state}
                      type="button"
                      disabled={busyId === item.submission_id || item.review_state === state}
                      onClick={() => void setReviewState(item.submission_id, state)}
                      className="border border-[color:var(--brass-700)] bg-[var(--hide-900)] px-3 py-1 text-xs font-mono uppercase text-[color:var(--bone-200)] disabled:opacity-50"
                    >
                      Mark {state}
                    </button>
                  ))}
                </div>
              </div>
            </article>
          ))}
        </section>
      </div>
    </RoleStandaloneView>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';

import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatGymStamp } from '@/src/lib/gymTime';

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

// Law 3: review state is a queue outcome, so it rides the badge ladder with a
// glyph and an uppercase label rather than colour alone. New submissions await
// action (restricted), contacted ones are settled (cleared), archived ones are
// merely tracked (monitor).
function reviewStateBadge(state: ReviewState): { rung: string; glyph: string } {
  if (state === 'new') return { rung: 'badge--restricted', glyph: '▲' };
  if (state === 'contacted') return { rung: 'badge--cleared', glyph: '✓' };
  return { rung: 'badge--monitor', glyph: '◉' };
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
      /* Law 6: every screen inherits exactly one room, and this one inherited
         none -- the shell renders the bare ink ground when no room is named,
         so the page stood on a wall-less floor. The office is what
         buildingMap.ts already tells the corridor and the catalog this door
         opens onto, and it is the right room for the work: an intake queue
         somebody works through from a desk. */
      room="office"
    >
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
          <p className="t-eyebrow">Public Portal</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Public Interest Submissions</h1>
          <p className="t-body mt-[var(--s3)]">
            Real submissions from the public marketing site&apos;s interest-intake form. This is real contact
            information for prospective members, volunteers, and partners -- follow up, then mark each one
            Contacted or Archived.
          </p>
        </header>

        <div className="flex flex-wrap gap-[var(--s3)]" role="group" aria-label="Filter submissions by review state">
          {(['new', 'contacted', 'archived', 'ALL'] as const).map((state) => (
            <button
              key={state}
              type="button"
              onClick={() => setFilter(state)}
              aria-pressed={filter === state}
              className={`inline-flex min-h-[44px] items-center rounded-[var(--r-sm)] border px-[var(--s4)] font-mono text-[length:var(--t-xs)] font-bold uppercase tracking-[0.08em] transition ${
                filter === state
                  ? 'border-[color:var(--brass-300)] bg-[var(--hide-800)] text-[color:var(--brass-300)]'
                  : 'border-[color:var(--hide-600)] bg-[var(--hide-950)] text-[color:var(--bone-300)] hover:border-[color:var(--brass-700)]'
              }`}
            >
              {state}
            </button>
          ))}
        </div>

        {error ? (
          <p role="alert" className="alert alert--critical">
            <span className="alert-icon">✕</span>
            <span className="alert-msg">{error}</span>
          </p>
        ) : null}
        {loading ? <p className="t-body">Loading submissions...</p> : null}
        {!loading && items.length === 0 && !error ? (
          <p className="t-body">No submissions match this filter.</p>
        ) : null}

        <section className="space-y-[var(--s4)]">
          {items.map((item) => {
            const badge = reviewStateBadge(item.review_state);
            return (
              <article key={item.submission_id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <div className="flex flex-wrap items-start justify-between gap-[var(--s4)]">
                  <div className="space-y-[var(--s2)]">
                    <div className="flex flex-wrap items-center gap-[var(--s3)]">
                      <h3 className="t-command" style={{ fontSize: 'var(--t-md)' }}>{item.full_name}</h3>
                      <span className={`badge ${badge.rung}`}><i>{badge.glyph}</i>{item.review_state}</span>
                    </div>
                    <p className="t-data">
                      {item.email}{item.phone ? ` · ${item.phone}` : ''} · Prefers: {item.preferred_contact_method}
                    </p>
                    <p className="t-muted">
                      {item.visitor_type} · {item.program_interest} · {formatGymStamp(item.created_at)}
                    </p>
                    {item.message ? <p className="t-body mt-[var(--s2)] italic">&quot;{item.message}&quot;</p> : null}
                  </div>
                  <div className="flex gap-[var(--s3)]">
                    {(['contacted', 'archived'] as const).map((state) => (
                      <button
                        key={state}
                        type="button"
                        disabled={busyId === item.submission_id || item.review_state === state}
                        onClick={() => void setReviewState(item.submission_id, state)}
                        className="btn--lever min-h-[44px]"
                      >
                        Mark {state}
                      </button>
                    ))}
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

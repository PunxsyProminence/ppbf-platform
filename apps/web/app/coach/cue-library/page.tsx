'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

// The cue library (register module 114, owner decision 2026-08-16): the
// cues coaches already wrote into drill records, browsable as a library
// instead of locked inside one drill at a time. Read-only -- authoring
// stays on the drill, where the cue-family discipline lives. No invented
// content: an empty library means nobody has written cues yet, and says so.

interface CueRow {
  cue_id: string;
  cue_text: string;
  cue_family: string;
  focus_type: string;
  evidence_note: string;
  drill_id: string;
  drill_name: string;
  discipline: string;
  category: string;
}

const FOCUS_TYPES = ['external', 'internal', 'analogy', 'constraint', 'unspecified'] as const;

export default function CueLibraryPage() {
  const [cues, setCues] = useState<CueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [focusType, setFocusType] = useState<string>('');

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const params = new URLSearchParams();
        if (focusType) params.set('focus_type', focusType);
        if (search.trim()) params.set('search', search.trim());
        const response = await fetch(`${apiBase()}/api/pilot/coach/cue-library?${params}`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Unable to load the cue library.');
        const payload = (await response.json()) as { items?: CueRow[] };
        if (controller.signal.aborted) return;
        setCues(payload.items ?? []);
        setErrorMessage(null);
        setLoading(false);
      } catch (error) {
        // An aborted load is the page unmounting, not a failure to report.
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load the cue library.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [search, focusType]);

  // Grouped by cue family -- the scaling manual's own organizing unit.
  const families = useMemo(() => {
    const byFamily = new Map<string, CueRow[]>();
    for (const cue of cues) {
      const family = cue.cue_family || '(no family)';
      const list = byFamily.get(family) ?? [];
      list.push(cue);
      byFamily.set(family, list);
    }
    return [...byFamily.entries()];
  }, [cues]);

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <main className="room room--floor min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Coach Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Cue Library</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              Every coaching cue written into the active drill library, searchable in one place.
              Read-only: cues are authored on their drills, where the cue-family discipline lives.
            </p>
          </header>

          <div className="mb-[var(--s4)] grid gap-[var(--s3)] md:grid-cols-2">
            <div className="field">
              <label className="t-label" htmlFor="cue-search">Search</label>
              <input id="cue-search" className="input" value={search} placeholder="Cue text, family, or drill name…"
                onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="field">
              <label className="t-label" htmlFor="focus-type">Focus type</label>
              <select id="focus-type" className="select" value={focusType} onChange={(e) => setFocusType(e.target.value)}>
                <option value="">All</option>
                {FOCUS_TYPES.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </div>
          </div>

          {errorMessage && (
            <div className="alert alert--critical" role="alert">
              <span className="alert-icon" aria-hidden="true">✕</span>
              <div className="alert-body">
                <p className="alert-title">Failed</p>
                <p className="alert-msg">{errorMessage} Cues may exist that are not shown here.</p>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-[var(--s7)]">
              <span className="working">Loading cues...</span>
            </div>
          ) : !errorMessage && cues.length === 0 ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">No cues found</div>
                <p className="empty-msg mx-auto">
                  {search || focusType
                    ? 'Nothing matches this filter.'
                    : 'Cues written into drill records appear here — nobody has written any yet.'}
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-[var(--s4)]">
              {families.map(([family, familyCues]) => (
                <section key={family} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                  <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>{family}</h2>
                  <ul className="mt-[var(--s3)] space-y-[var(--s3)]">
                    {familyCues.map((cue) => (
                      <li key={cue.cue_id}>
                        <p className="t-body font-semibold text-[color:var(--bone-100)]">&ldquo;{cue.cue_text}&rdquo;</p>
                        <p className="t-data mt-[var(--s1)]" style={{ fontSize: 'var(--t-xs)' }}>
                          {cue.focus_type} · from <Link className="underline" href={`/coach/drills?drill_id=${encodeURIComponent(cue.drill_id)}`}>{cue.drill_name}</Link> ({cue.discipline} / {cue.category})
                        </p>
                        {cue.evidence_note ? (
                          <p className="t-body mt-[var(--s1)] text-[color:var(--bone-300)]" style={{ fontSize: 'var(--t-sm)' }}>{cue.evidence_note}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/coach/drills" className="btn btn--ghost">Open the Drill Library</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}

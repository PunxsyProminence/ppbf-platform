'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import type { DrillLibraryResponse, PilotDrill } from '@/src/server/pilot/drills';

// The gym's drill library, written by the coaches who teach it.
//
// A drill written here is the thing an assignment points at, so the same drill
// means the same thing across every athlete and every coach. Before this, an
// assignment carried only the name a coach typed, and two coaches assigning the
// same drill produced two unrelated strings.

// The server's own row type, not a restatement of it. The restatement had two
// drifts at once: it read the list under `drills` when the route sends `items`,
// and it declared `active_flag` where the route sends `active`. The first made
// the library render empty; the second was dead weight waiting to do the same.
// Type-only import, so nothing server-side is pulled into this client bundle.
type Drill = PilotDrill;

const DIFFICULTIES = ['beginner', 'intermediate', 'advanced', 'elite'] as const;

function CoachDrillLibrary() {
  const [drills, setDrills] = useState<Drill[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [focus, setFocus] = useState('');
  const [cues, setCues] = useState('');
  const [difficulty, setDifficulty] = useState<string>('beginner');

  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [formError, setFormError] = useState('');
  const [saved, setSaved] = useState('');

  // No state is set before the first await: a synchronous setState inside an
  // effect cascades a render before the request has even left.
  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/drills`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('The drill library could not be loaded.');
      // Typed from the route's own response contract rather than restated
      // here. It was restated here, as `drills`, and the route has always sent
      // `items` -- so the library rendered empty from the day it shipped. Route
      // tests and component tests both passed; nothing covered the seam, which
      // is the only place the defect lived.
      const payload = (await response.json()) as Partial<DrillLibraryResponse>;
      setDrills(payload.items ?? []);
      setLoadError('');
    } catch (error) {
      setDrills([]);
      setLoadError(error instanceof Error ? error.message : 'The drill library could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred behind an await so no state is set while the effect body runs.
    void (async () => {
      await load();
    })();
  }, [load]);

  async function createDrill() {
    // Held in a ref as well as state: a second click lands before React has
    // re-rendered the disabled button, and a duplicate drill is a duplicate
    // anchor that splits a lesson across two names.
    if (savingRef.current) return;

    if (!name.trim() || !category.trim() || !focus.trim()) {
      setFormError('A drill needs a name, a category, and what it is for.');
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setFormError('');
    setSaved('');

    try {
      const response = await fetch(`${apiBase()}/api/pilot/drills`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          category: category.trim(),
          focus: focus.trim(),
          difficulty,
          cues: cues.split('\n').map((cue) => cue.trim()).filter(Boolean),
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'The drill could not be saved.');
      }

      setSaved(`"${name.trim()}" is in the library.`);
      setName('');
      setCategory('');
      setFocus('');
      setCues('');
      setDifficulty('beginner');
      await load();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'The drill could not be saved.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <main className="room--office min-h-screen bg-[var(--hide-950)] px-[var(--s5)] py-[var(--s6)] text-[color:var(--bone-200)]">
      <div className="mx-auto max-w-5xl">
        <header className="border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Coach</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-2xl)]">Drill Library</h1>
          <p className="t-body mt-[var(--s3)] max-w-3xl text-[color:var(--bone-300)]">
            Drills written here are what athletes see and what assignments point at. Writing one once
            means the same drill means the same thing for every coach and every athlete.
          </p>
          <Link href="/coach/environment/intake-router" className="btn btn--ghost mt-[var(--s4)]">
            Back to Coach Workspace
          </Link>
        </header>

        <section className="mat-leather mt-[var(--s6)] rounded-[var(--r-lg)] p-[var(--s5)]">
          <h2 className="t-command text-[length:var(--t-lg)]">Add a drill</h2>

          <div className="mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2">
            <div className="field">
              <label htmlFor="drill-name" className="t-label">Name</label>
              <input
                id="drill-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="input"
                placeholder="Straight jab retraction"
              />
            </div>
            <div className="field">
              <label htmlFor="drill-category" className="t-label">Category</label>
              <input
                id="drill-category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                className="input"
                placeholder="Striking"
              />
            </div>
          </div>

          <div className="field mt-[var(--s4)]">
            <label htmlFor="drill-focus" className="t-label">What it is for</label>
            <textarea
              id="drill-focus"
              value={focus}
              onChange={(event) => setFocus(event.target.value)}
              rows={2}
              className="textarea"
              placeholder="Quick fist return to protect the chin after the jab."
            />
          </div>

          <div className="mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2">
            <div className="field">
              <label htmlFor="drill-cues" className="t-label">
                Coaching cues, one per line
              </label>
              <textarea
                id="drill-cues"
                value={cues}
                onChange={(event) => setCues(event.target.value)}
                rows={4}
                className="textarea font-mono"
                placeholder={'Elbow tucked\nShoulder covers chin\nSnap the fist back'}
              />
            </div>
            <div className="field">
              <label htmlFor="drill-difficulty" className="t-label">Difficulty</label>
              <select
                id="drill-difficulty"
                value={difficulty}
                onChange={(event) => setDifficulty(event.target.value)}
                className="select"
              >
                {DIFFICULTIES.map((level) => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
            </div>
          </div>

          {formError && (
            <p role="alert" className="mt-[var(--s4)] rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-sm)] font-semibold text-[var(--locked-ink)]">
              {formError}
            </p>
          )}
          {saved && (
            <p className="mt-[var(--s4)] rounded-[var(--r-md)] border-2 border-[var(--cleared)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-sm)] font-semibold text-[var(--cleared-ink)]">
              ✓ {saved}
            </p>
          )}

          <button
            type="button"
            onClick={() => void createDrill()}
            disabled={saving}
            className="btn mt-[var(--s5)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? 'Saving...' : 'Add drill'}
          </button>
        </section>

        <section className="mt-[var(--s6)]">
          <h2 className="t-command text-[length:var(--t-lg)]">In the library</h2>

          {loading && <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Loading...</p>}

          {!loading && loadError && (
            <div className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
              <p className="text-[length:var(--t-sm)] font-semibold text-[var(--locked-ink)]">{loadError}</p>
              <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                This is a failure to load, not an empty library.
              </p>
            </div>
          )}

          {!loading && !loadError && drills.length === 0 && (
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              Nothing yet. The first drill you add is the first one your athletes will see.
            </p>
          )}

          <div className="mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2">
            {drills.map((drill) => (
              <article key={drill.drill_id} className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s4)]">
                <div className="flex items-baseline justify-between gap-[var(--s3)]">
                  <h3 className="t-command text-[length:var(--t-md)]">{drill.name}</h3>
                  <span className="plaque">{drill.difficulty}</span>
                </div>
                <p className="t-label mt-[var(--s2)]">
                  {drill.category}
                </p>
                <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">{drill.focus}</p>
                {drill.cues.length > 0 && (
                  <ul className="mt-[var(--s3)] flex flex-wrap gap-[var(--s2)]">
                    {drill.cues.map((cue) => (
                      <li key={`${drill.drill_id}-${cue}`} className="rounded-[var(--r-sm)] border border-[color:rgba(212,175,74,.22)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                        {cue}
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

export default function CoachDrillLibraryPage() {
  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <CoachDrillLibrary />
    </RoleSessionGate>
  );
}

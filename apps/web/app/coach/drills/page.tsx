'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

// The gym's drill library, written by the coaches who teach it.
//
// A drill written here is the thing an assignment points at, so the same drill
// means the same thing across every athlete and every coach. Before this, an
// assignment carried only the name a coach typed, and two coaches assigning the
// same drill produced two unrelated strings.

interface Drill {
  drill_id: string;
  name: string;
  category: string;
  focus: string;
  cues: string[];
  difficulty: string;
  active_flag: boolean;
}

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
      const payload = (await response.json()) as { drills?: Drill[] };
      setDrills(payload.drills ?? []);
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
    <main className="min-h-screen bg-[var(--canvas-tan)] px-6 py-10 text-[var(--black)]">
      <div className="mx-auto max-w-5xl">
        <header className="border-b-[3px] border-[var(--black)] pb-6">
          <p className="text-xs font-mono uppercase tracking-[0.22em] text-[var(--accent-quiet)]">Coach</p>
          <h1 className="mt-2 text-4xl font-black tracking-tight">Drill Library</h1>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-[var(--gray-dark)]">
            Drills written here are what athletes see and what assignments point at. Writing one once
            means the same drill means the same thing for every coach and every athlete.
          </p>
          <Link
            href="/coach/review-queue"
            className="mt-4 inline-flex min-h-[44px] items-center rounded-full border border-[rgba(0,0,0,0.16)] bg-white px-4 text-xs font-bold uppercase tracking-[0.1em]"
          >
            Back to review queue
          </Link>
        </header>

        <section className="mt-8 rounded-2xl border-2 border-[var(--black)] bg-white p-6">
          <h2 className="text-xl font-black">Add a drill</h2>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="drill-name" className="block text-xs font-bold uppercase tracking-[0.12em]">Name</label>
              <input
                id="drill-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-lg border-2 border-[var(--black)] px-3"
                placeholder="Straight jab retraction"
              />
            </div>
            <div>
              <label htmlFor="drill-category" className="block text-xs font-bold uppercase tracking-[0.12em]">Category</label>
              <input
                id="drill-category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-lg border-2 border-[var(--black)] px-3"
                placeholder="Striking"
              />
            </div>
          </div>

          <div className="mt-4">
            <label htmlFor="drill-focus" className="block text-xs font-bold uppercase tracking-[0.12em]">What it is for</label>
            <textarea
              id="drill-focus"
              value={focus}
              onChange={(event) => setFocus(event.target.value)}
              rows={2}
              className="mt-1 w-full rounded-lg border-2 border-[var(--black)] px-3 py-2"
              placeholder="Quick fist return to protect the chin after the jab."
            />
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="drill-cues" className="block text-xs font-bold uppercase tracking-[0.12em]">
                Coaching cues, one per line
              </label>
              <textarea
                id="drill-cues"
                value={cues}
                onChange={(event) => setCues(event.target.value)}
                rows={4}
                className="mt-1 w-full rounded-lg border-2 border-[var(--black)] px-3 py-2 font-mono text-sm"
                placeholder={'Elbow tucked\nShoulder covers chin\nSnap the fist back'}
              />
            </div>
            <div>
              <label htmlFor="drill-difficulty" className="block text-xs font-bold uppercase tracking-[0.12em]">Difficulty</label>
              <select
                id="drill-difficulty"
                value={difficulty}
                onChange={(event) => setDifficulty(event.target.value)}
                className="mt-1 min-h-[44px] w-full rounded-lg border-2 border-[var(--black)] px-3"
              >
                {DIFFICULTIES.map((level) => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
            </div>
          </div>

          {formError && (
            <p role="alert" className="mt-4 rounded-lg border-2 border-[var(--safety-locked)] bg-[color-mix(in_srgb,var(--safety-locked)_6%,white)] px-3 py-2 text-sm font-semibold text-[var(--safety-locked)]">
              {formError}
            </p>
          )}
          {saved && (
            <p className="mt-4 rounded-lg border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-2 text-sm font-semibold">
              {saved}
            </p>
          )}

          <button
            type="button"
            onClick={() => void createDrill()}
            disabled={saving}
            className="mt-5 min-h-[48px] rounded-xl border-2 border-[var(--black)] bg-[var(--accent-strong)] px-6 text-sm font-black uppercase tracking-[0.14em] text-[var(--accent-ink)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? 'Saving...' : 'Add drill'}
          </button>
        </section>

        <section className="mt-8">
          <h2 className="text-xl font-black">In the library</h2>

          {loading && <p className="mt-3 text-sm text-[var(--gray-dark)]">Loading...</p>}

          {!loading && loadError && (
            <div className="mt-3 rounded-lg border-2 border-[var(--safety-locked)] bg-white p-4">
              <p className="text-sm font-semibold text-[var(--safety-locked)]">{loadError}</p>
              <p className="mt-1 text-sm text-[var(--gray-dark)]">
                This is a failure to load, not an empty library.
              </p>
            </div>
          )}

          {!loading && !loadError && drills.length === 0 && (
            <p className="mt-3 text-sm text-[var(--gray-dark)]">
              Nothing yet. The first drill you add is the first one your athletes will see.
            </p>
          )}

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {drills.map((drill) => (
              <article key={drill.drill_id} className="rounded-2xl border-2 border-[var(--black)] bg-white p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-base font-black">{drill.name}</h3>
                  <span className="text-[11px] font-mono uppercase tracking-[0.1em] text-[var(--accent-quiet)]">
                    {drill.difficulty}
                  </span>
                </div>
                <p className="mt-1 text-[12px] font-mono uppercase tracking-[0.1em] text-[var(--gray-dark)]">
                  {drill.category}
                </p>
                <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">{drill.focus}</p>
                {drill.cues.length > 0 && (
                  <ul className="mt-3 flex flex-wrap gap-1">
                    {drill.cues.map((cue) => (
                      <li key={`${drill.drill_id}-${cue}`} className="rounded bg-[var(--canvas-tan-light)] px-2 py-1 text-xs">
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

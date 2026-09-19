'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import DrillDetail from '@/components/drills/DrillDetail';
import { fromCoachDrillDetail, type DrillDetailView } from '@/components/drills/drillDetailView';
import { apiBase } from '@/lib/apiBase';
import { equipmentLabel, humanizeContactLevel } from '@/src/lib/drillPresentation';
import type { DrillLibraryRow, DrillWithDetail } from '@/src/server/pilot/drillLibraryV3';
import type { DrillLibraryResponse, PilotDrill } from '@/src/server/pilot/drills';

// The gym's drill library: the reference drills it can adopt, and the
// operational drills -- promoted from the reference library or written here --
// that assignments point at.
//
// An operational drill is the thing an assignment points at, so the same drill
// means the same thing across every athlete and every coach. Before this, an
// assignment carried only the name a coach typed, and two coaches assigning the
// same drill produced two unrelated strings.

// The server's own row type, not a restatement of it. The restatement had two
// drifts at once: it read the list under `drills` when the route sends `items`,
// and it declared `active_flag` where the route sends `active`. The first made
// the library render empty; the second was dead weight waiting to do the same.
// Type-only import, so nothing server-side is pulled into this client bundle.
type Drill = PilotDrill;
type ReferenceDrill = DrillLibraryRow;

const DIFFICULTIES = ['beginner', 'intermediate', 'advanced', 'elite'] as const;

const REFERENCE_NOT_FOUND = "This reference drill is not in this gym's library.";

function CoachDrillLibrary() {
  const [drills, setDrills] = useState<Drill[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [referenceDrills, setReferenceDrills] = useState<ReferenceDrill[]>([]);
  const [referenceLoading, setReferenceLoading] = useState(true);
  const [referenceLoadError, setReferenceLoadError] = useState('');

  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [focus, setFocus] = useState('');
  const [cues, setCues] = useState('');
  const [difficulty, setDifficulty] = useState<string>('beginner');

  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [formError, setFormError] = useState('');
  const [saved, setSaved] = useState('');

  // Promotion -- OD-2026-09-16-001. Held per reference drill so one card's
  // in-flight state cannot disable the others, and mirrored in a ref because a
  // second click lands before React has re-rendered the disabled button and a
  // duplicate promotion is the thing the unique index exists to refuse.
  const [promotingReferenceId, setPromotingReferenceId] = useState('');
  const promotingRef = useRef(false);
  const [promoteError, setPromoteError] = useState('');
  // Promotion state is held separately from the rendered list because the two
  // answer different questions. The list shows what the gym teaches now; the
  // reference is reserved by ANY promotion of it, including a retired one --
  // pilot_drills_one_reference_per_org deliberately ignores `active`. Reading
  // both from one active-only list would offer Promote on a reference whose
  // every click must 409.
  // Keyed by reference drill id: true when an ACTIVE operational drill points at
  // it, false when every promotion of it is retired. Retired promotions still
  // reserve the reference, but "Already promoted" alone would tell a coach the
  // drill is live when athletes cannot read it.
  const [promotionState, setPromotionState] = useState<Record<string, boolean>>({});
  const [promoteNotice, setPromoteNotice] = useState('');

  // The informed decision surface (OD-2026-09-19-001). A reference drill is
  // opened in full -- instruction, safety, scaling, source and version -- and
  // Promote lives there, not on the one-line card: adoption is consequential,
  // so it happens where the coach can see what they are adopting.
  const [openReferenceId, setOpenReferenceId] = useState('');
  const [openReference, setOpenReference] = useState<DrillDetailView | null>(null);
  const [openReferenceLoading, setOpenReferenceLoading] = useState(false);
  const [openReferenceError, setOpenReferenceError] = useState('');
  const openRequestRef = useRef(0);
  const referenceSectionRef = useRef<HTMLElement | null>(null);
  const openerRef = useRef('');

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
      if (!Array.isArray(payload.items)) throw new Error('The drill library returned an invalid response.');
      setDrills(payload.items);
      setLoadError('');
    } catch (error) {
      setDrills([]);
      setLoadError(error instanceof Error ? error.message : 'The drill library could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  // The author-facing promotion census. Uses the drills route's existing
  // include_retired capability rather than a new endpoint, and its rows are never
  // rendered -- only their reference pointers are kept. A failure here leaves the
  // set as it was rather than claiming nothing is promoted, because claiming that
  // would re-offer Promote on a reserved reference.
  const loadPromotionState = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/drills?include_retired=true`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) return;
      const payload = (await response.json()) as Partial<DrillLibraryResponse>;
      if (!Array.isArray(payload.items)) return;
      const state: Record<string, boolean> = {};
      for (const drill of payload.items) {
        if (!drill.reference_drill_id) continue;
        state[drill.reference_drill_id] = Boolean(state[drill.reference_drill_id]) || drill.active !== false;
      }
      setPromotionState(state);
    } catch {
      // Deliberately silent: promotion state is a refinement of the reference
      // cards, not their content, and the reference list has its own error state.
    }
  }, []);

  const loadReferenceLibrary = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/drill-library`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('The reference drill library could not be loaded.');
      const payload = (await response.json()) as { drills?: ReferenceDrill[] };
      if (!Array.isArray(payload.drills)) throw new Error('The reference drill library returned an invalid response.');
      setReferenceDrills(payload.drills);
      setReferenceLoadError('');
    } catch (error) {
      setReferenceDrills([]);
      setReferenceLoadError(error instanceof Error ? error.message : 'The reference drill library could not be loaded.');
    } finally {
      setReferenceLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred behind an await so no state is set while the effect body runs.
    void (async () => {
      await Promise.all([load(), loadReferenceLibrary(), loadPromotionState()]);
    })();
  }, [load, loadReferenceLibrary, loadPromotionState]);

  // Promoted state comes from the operational drills' own pointers, never from a
  // name match: two drills can share a name for reasons that have nothing to do
  // with promotion, and inferring provenance from one would be the false link
  // reference_drill_id exists to replace. The census includes retired rows, which
  // is why it is its own read.
  const isPromoted = (referenceDrillId: string) => referenceDrillId in promotionState;
  const promotionLabel = (referenceDrillId: string) =>
    promotionState[referenceDrillId] ? 'Already promoted' : 'Promoted · retired';

  // Reading only: the coach detail endpoint is a GET. A request counter keeps a
  // slow answer for a drill the coach has already left from landing on the one
  // they opened next.
  async function openReferenceDrill(referenceDrillId: string, openerId: string) {
    const request = openRequestRef.current + 1;
    openRequestRef.current = request;
    openerRef.current = openerId;
    setPromoteNotice('');
    setOpenReferenceId(referenceDrillId);
    setOpenReference(null);
    setOpenReferenceError('');
    setOpenReferenceLoading(true);
    setPromoteError('');
    // The detail renders in the reference section; an operational card far
    // below it opens it too, so bring the coach to where it appears.
    referenceSectionRef.current?.scrollIntoView?.({ block: 'start' });
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/drill-library?drill_id=${encodeURIComponent(referenceDrillId)}`,
        { method: 'GET', credentials: 'include' },
      );
      // 404 is an answer, not a failure: the drill is not in this gym's library.
      if (response.status === 404) throw new Error(REFERENCE_NOT_FOUND);
      if (!response.ok) throw new Error('This reference drill could not be loaded.');
      const payload = (await response.json()) as { drill?: DrillWithDetail };
      if (!payload.drill) throw new Error('This reference drill could not be loaded.');
      if (openRequestRef.current !== request) return;
      setOpenReference(fromCoachDrillDetail(payload.drill));
    } catch (error) {
      if (openRequestRef.current !== request) return;
      setOpenReferenceError(error instanceof Error ? error.message : 'This reference drill could not be loaded.');
    } finally {
      if (openRequestRef.current === request) setOpenReferenceLoading(false);
    }
  }

  // Back returns focus -- and the page -- to the control that opened the
  // drill, including an operational card far below the reference grid.
  function closeReferenceDrill() {
    openRequestRef.current += 1;
    setOpenReferenceId('');
    setOpenReference(null);
    setOpenReferenceError('');
    setOpenReferenceLoading(false);
    const openerId = openerRef.current;
    if (openerId && typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        const opener = document.getElementById(openerId);
        opener?.scrollIntoView?.({ block: 'center' });
        opener?.focus();
      });
    }
  }

  async function promoteReference(referenceDrillId: string) {
    if (promotingRef.current) return;

    promotingRef.current = true;
    setPromotingReferenceId(referenceDrillId);
    setPromoteError('');
    setPromoteNotice('');

    try {
      const response = await fetch(`${apiBase()}/api/pilot/drills/promote`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference_drill_id: referenceDrillId }),
      });

      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'The drill could not be promoted.');
      }

      // Reload rather than patching local state: the server decides what this
      // gym has adopted, and "Already promoted" should be its answer, not this
      // component's optimism. Both reads: the new drill belongs in the rendered
      // list, and its pointer belongs in the census.
      await Promise.all([load(), loadPromotionState()]);
      setPromoteNotice('Promoted. It is now an operational drill: coaches can assign it, and athletes in this gym can read it in Learn.');
    } catch (error) {
      setPromoteError(error instanceof Error ? error.message : 'The drill could not be promoted.');
    } finally {
      promotingRef.current = false;
      setPromotingReferenceId('');
    }
  }

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
    <main className="ge-drillcase room room--floor min-h-screen bg-[var(--hide-950)] px-[var(--s5)] py-[var(--s6)] text-[color:var(--bone-200)]">
      <div className="mx-auto max-w-5xl">
        <header className="border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Coach</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-2xl)]">Drill Library</h1>
          {/* Truthful since W-D2: athletes read a drill in Learn only when it was
              promoted from the reference library. A drill written by hand here
              is assignable, and its name and purpose reach the athlete on the
              assignment, but it has no reference instructions to read. */}
          <p className="t-body mt-[var(--s3)] max-w-3xl text-[color:var(--bone-300)]">
            Operational drills are what assignments point at, so the same drill means the same thing for
            every coach and every athlete. Athletes can read a drill&apos;s full instructions once this gym
            promotes it from the reference library.
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

        <section ref={referenceSectionRef} className="mt-[var(--s6)]">
          <h2 className="t-command text-[length:var(--t-lg)]">Reference library</h2>
          <p className="t-body mt-[var(--s2)] max-w-3xl text-[color:var(--bone-300)]">
            Seeded coaching material for planning and review. The reference source stays read-only. Open a
            drill to read all of it; promoting it from there adopts that exact version into this gym&apos;s
            operational drills below, where assignments point. Once promoted, athletes in this gym can read
            it in Learn. Promoting does not assign the drill to any athlete.
          </p>

          {promoteNotice && (
            <p role="status" className="t-body mt-[var(--s3)] text-[color:var(--bone-200)]">{promoteNotice}</p>
          )}

          {promoteError && (
            <div className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[var(--restricted)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
              <p className="text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">{promoteError}</p>
              <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                This is a failure to promote. The reference library below is unchanged.
              </p>
            </div>
          )}

          {referenceLoading && <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Loading reference drills...</p>}

          {!referenceLoading && referenceLoadError && (
            <div className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[var(--restricted)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
              <p className="text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">{referenceLoadError}</p>
              <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                This is a failure to load, not an empty reference library.
              </p>
            </div>
          )}

          {!referenceLoading && !referenceLoadError && referenceDrills.length === 0 && (
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">No reference drills are available.</p>
          )}

          {/* LEVEL 2: the opened reference drill, with Promote on it. */}
          {openReferenceId && (
            <div className="mt-[var(--s4)] space-y-[var(--s4)]">
              <button type="button" onClick={closeReferenceDrill} className="btn btn--ghost">
                Back to the reference library
              </button>
              {openReferenceLoading && <p className="t-body text-[color:var(--bone-300)]">Loading the drill...</p>}
              {!openReferenceLoading && openReferenceError && (
                <p className="t-body text-[color:var(--bone-300)]">
                  {openReferenceError}
                  {openReferenceError !== REFERENCE_NOT_FOUND ? ' This is a failure to load, not a missing drill.' : ''}
                </p>
              )}
              {!openReferenceLoading && openReference && (
                <DrillDetail
                  view={openReference}
                  audience="coach"
                  focusOnMount
                  actions={isPromoted(openReference.id) ? (
                    <p className="t-label text-[color:var(--bone-300)]">{promotionLabel(openReference.id)}</p>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void promoteReference(openReference.id)}
                      disabled={promotingReferenceId !== ''}
                      className="btn"
                    >
                      {promotingReferenceId === openReference.id ? 'Promoting...' : 'Promote'}
                    </button>
                  )}
                />
              )}
            </div>
          )}

          {/* LEVEL 1: concise cards. Equipment is labelled as equipment -- it
              used to be printed under "Setup:", which for most of the corpus
              made an equipment word look like the setup instructions. */}
          <div className={`mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2${openReferenceId ? ' hidden' : ''}`}>
            {referenceDrills.map((drill) => (
              <article key={drill.drill_id} className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s4)]">
                <div className="flex items-baseline justify-between gap-[var(--s3)]">
                  <h3 className="t-command text-[length:var(--t-md)]">{drill.name}</h3>
                  <span className="plaque">{drill.difficulty}</span>
                </div>
                <p className="t-label mt-[var(--s2)]">{drill.discipline} · {drill.category}</p>
                <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">{drill.purpose}</p>
                <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
                  <span className="font-semibold text-[color:var(--bone-200)]">Contact:</span> {humanizeContactLevel(drill.contact_level)}
                </p>
                {equipmentLabel(drill.equipment_needed) && (
                  <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                    <span className="font-semibold text-[color:var(--bone-200)]">Equipment:</span> {equipmentLabel(drill.equipment_needed)}
                  </p>
                )}
                {drill.requires_coach_authorization && (
                  <p className="mt-[var(--s3)] text-[length:var(--t-xs)] font-semibold text-[var(--locked-ink)]">
                    Coach authorization required
                  </p>
                )}
                <div className="mt-[var(--s4)] flex flex-wrap items-center gap-[var(--s3)]">
                  <button
                    type="button"
                    id={`view-reference-${drill.drill_id}`}
                    onClick={() => void openReferenceDrill(drill.drill_id, `view-reference-${drill.drill_id}`)}
                    className="btn btn--ghost"
                    aria-label={`View drill: ${drill.name}`}
                  >
                    View drill
                  </button>
                  {isPromoted(drill.drill_id) && (
                    <p className="t-label text-[color:var(--bone-300)]">{promotionLabel(drill.drill_id)}</p>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-[var(--s6)]">
          {/* "Gym-authored" was false for every promoted drill (OD-2026-09-19-001).
              These are the gym's operational drills -- promoted or written here --
              and each one says which. */}
          <h2 className="t-command text-[length:var(--t-lg)]">Operational drills</h2>
          <p className="t-body mt-[var(--s2)] max-w-3xl text-[color:var(--bone-300)]">
            The drills this gym runs and assigns: promoted from the reference library, or written here.
          </p>

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
              Nothing yet. Promote a drill from the reference library, or add one above; assignments can only
              point at operational drills.
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
                  {drill.category} · {drill.reference_drill_id ? 'From the reference library' : 'Written by this gym'}
                </p>
                <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">{drill.focus}</p>
                {/* A promoted drill's instructions live on its reference drill, so
                    this opens that exact reference -- the pointer, never a name
                    match. A hand-written drill has no reference to open. */}
                {drill.reference_drill_id && (
                  <button
                    type="button"
                    id={`view-instructions-${drill.drill_id}`}
                    onClick={() => void openReferenceDrill(drill.reference_drill_id as string, `view-instructions-${drill.drill_id}`)}
                    className="btn btn--ghost mt-[var(--s3)]"
                    aria-label={`View instructions: ${drill.name}`}
                  >
                    View instructions
                  </button>
                )}
                {drill.cues.length > 0 && (
                  <ul className="mt-[var(--s3)] flex flex-wrap gap-[var(--s2)]">
                    {drill.cues.map((cue) => (
                      <li key={`${drill.drill_id}-${cue}`} className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
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

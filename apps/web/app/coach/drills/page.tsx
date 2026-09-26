'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import DrillDetail from '@/components/drills/DrillDetail';
import { fromCoachDrillDetail, type DrillDetailView } from '@/components/drills/drillDetailView';
import { apiBase } from '@/lib/apiBase';
import { adoptionReadiness } from '@/src/lib/drillAdoptionReadiness';
import { equipmentLabel, humanizeContactLevel } from '@/src/lib/drillPresentation';
import type {
  DrillLibraryRow,
  DrillWithDetail,
  ReferenceLifecycle,
  ReferenceLifecycleState,
} from '@/src/server/pilot/drillLibraryV3';
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

// Where a reference drill stands in this gym (W-D4C), as the server derives it
// from durable rows on every read. Worded for the coach deciding what to do.
const LIFECYCLE_LABELS: Record<ReferenceLifecycleState, string> = {
  available: 'Not adopted',
  operational: 'Operational in this gym',
  retired: 'Retired in this gym',
  superseded: 'A newer version exists',
  unavailable: 'Withdrawn',
};

// DISCOVERY (W-D4C): every filter reads a durable, structured column -- an
// enum the database CHECKs, the discipline registry, the stored category, the
// coach-authorization flag, or the server-derived lifecycle. None is inferred
// from prose, so there is no solo/partner, space or equipment filter: nothing
// records those as data. Search matches the drill's NAME only.
type FilterKey = 'discipline' | 'category' | 'difficulty' | 'contact' | 'authorization' | 'lifecycle';

interface FilterSpec {
  key: FilterKey;
  label: string;
  valueOf: (drill: ReferenceDrill, lifecycle: ReferenceLifecycle | undefined) => string;
  labelOf: (value: string) => string;
}

const FILTERS: FilterSpec[] = [
  { key: 'discipline', label: 'Discipline', valueOf: (drill) => drill.discipline, labelOf: (value) => value },
  { key: 'category', label: 'Category', valueOf: (drill) => drill.category, labelOf: (value) => value },
  { key: 'difficulty', label: 'Difficulty', valueOf: (drill) => drill.difficulty, labelOf: (value) => value },
  { key: 'contact', label: 'Contact', valueOf: (drill) => drill.contact_level, labelOf: humanizeContactLevel },
  {
    key: 'authorization',
    label: 'Coach authorization',
    valueOf: (drill) => (drill.requires_coach_authorization ? 'required' : 'not_required'),
    labelOf: (value) => (value === 'required' ? 'Required' : 'Not required'),
  },
  {
    key: 'lifecycle',
    label: 'In this gym',
    valueOf: (_drill, lifecycle) => lifecycle?.state ?? '',
    labelOf: (value) => LIFECYCLE_LABELS[value as ReferenceLifecycleState] ?? value,
  },
];

// What is known after a failed action, and after the re-read that follows it.
// A refusal changed nothing. A 409 changed nothing either, but it can mean
// this page's picture of the drill is out of date (another coach promoted,
// retired or restored it) -- or not (a name another drill already holds) --
// so the drill's status is read again without guessing which. A fault or a
// dropped connection may have landed after the write committed, so its
// outcome is unknown. Each sentence claims only what the page then knows,
// including whether the re-read itself worked.
type ActionOutcome = 'refused' | 'reread' | 'reread_failed' | 'unknown' | 'unknown_unread';

const OUTCOME_EXPLANATIONS: Record<ActionOutcome, string> = {
  refused: 'Nothing was changed. This drill is as it was.',
  reread: 'Nothing was changed. This drill\'s status in this gym was read again.',
  reread_failed: 'Nothing was changed, but this drill\'s status in this gym could not be read again. Reload the page before trying again.',
  unknown: 'It is not known whether this change was saved. This drill\'s status in this gym was read again; check it before trying again.',
  unknown_unread: 'It is not known whether this change was saved, and this drill\'s status in this gym could not be read again. Reload the page before trying again.',
};

const NO_FILTERS: Record<FilterKey, string> = {
  discipline: '',
  category: '',
  difficulty: '',
  contact: '',
  authorization: '',
  lifecycle: '',
};

// The decision surface for one reference drill: what it is in this gym, and
// the one action that state allows. An unread state offers no action at all,
// rather than defaulting to Promote. A component rather than a helper called
// during render, so the page's ref-guarded handlers are only ever passed down
// as event handlers.
function ReferenceActions({
  referenceDrillId,
  state,
  detail,
  promotingReferenceId,
  changingLifecycle,
  busy,
  onPromote,
  onChangeLifecycle,
}: {
  referenceDrillId: string;
  state: ReferenceLifecycle | undefined;
  detail: DrillWithDetail | null;
  promotingReferenceId: string;
  changingLifecycle: boolean;
  /**
   * An action is still running -- its request or any re-read after it. No
   * action may start then: its re-reads can change this drill's state and
   * so the button offered, and a second action would interleave its answer
   * with the first one's.
   */
  busy: boolean;
  onPromote: (referenceDrillId: string) => void;
  onChangeLifecycle: (referenceDrillId: string, operationalDrillId: string, restoring: boolean) => void;
}) {
  if (!state) {
    return <p className="t-label text-[color:var(--bone-300)]">This drill&apos;s status in this gym could not be read.</p>;
  }
  const label = <p className="t-label text-[color:var(--bone-300)]">{LIFECYCLE_LABELS[state.state]}</p>;
  if (state.state === 'available') {
    const readiness = detail ? adoptionReadiness(detail) : null;
    if (readiness && !readiness.ready) {
      return (
        <div className="basis-full space-y-[var(--s2)]">
          <p className="ge-drillcase__not-ready t-label text-[color:var(--restricted-ink)]">Not ready to adopt</p>
          <ul className="list-disc space-y-[var(--s1)] pl-[var(--s5)] text-[length:var(--t-sm)] text-[color:var(--bone-300)]">
            {readiness.missing.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      );
    }
    return (
      <button
        type="button"
        id={`lifecycle-${referenceDrillId}`}
        onClick={() => onPromote(referenceDrillId)}
        disabled={busy}
        className="btn"
      >
        {promotingReferenceId === referenceDrillId ? 'Promoting...' : 'Promote'}
      </button>
    );
  }
  // A retired adoption whose reference was since withdrawn cannot come back:
  // the server refuses that restore, so no button offers it.
  if (state.state === 'retired' && detail && !detail.active) {
    return (
      <>
        {label}
        <p className="t-label text-[color:var(--bone-300)]">Its reference has been withdrawn, so it cannot be restored.</p>
      </>
    );
  }
  if ((state.state === 'operational' || state.state === 'retired') && state.operational_drill_id) {
    const restoring = state.state === 'retired';
    const operationalDrillId = state.operational_drill_id;
    // Athletes read nothing of a withdrawn reference -- not in Learn, not on
    // open work -- so the usual Retire consequence would promise what is
    // already gone, and Restore would be refused afterwards.
    const withdrawn = detail?.active === false;
    return (
      <>
        {label}
        <button
          type="button"
          id={`lifecycle-${referenceDrillId}`}
          onClick={() => onChangeLifecycle(referenceDrillId, operationalDrillId, restoring)}
          disabled={busy}
          className="btn btn--ghost"
        >
          {changingLifecycle ? 'Saving...' : restoring ? 'Restore' : 'Retire'}
        </button>
        {/* What the action does, before it is taken -- no confirmation step,
            which would be ceremony: both actions are undone by the other. */}
        <p className="basis-full text-[length:var(--t-sm)] text-[color:var(--bone-300)]">
          {restoring
            ? 'Restoring brings back this same drill: coaches can assign it again, and athletes can read it in Learn.'
            : withdrawn
              ? 'Retiring stops new assignments. Its reference has been withdrawn, so athletes already cannot read it, and once retired it cannot be restored.'
              : 'Retiring stops new assignments and takes it out of Learn. Assigned work that is still open keeps its instructions.'}
        </p>
      </>
    );
  }
  return label;
}

/* THE EQUIPMENT IN THIS ROOM.
 *
 * The drill cabinet is a room, not a document, so its three parts are three
 * pieces of equipment standing in it rather than three sections you scroll
 * past: the cabinet you read from, the shelf of drills this gym actually runs,
 * and the workbench where a new one gets written. Walking to one is what the
 * rail below does.
 *
 * `hidden` IS THE ATTRIBUTE, NOT THE TAILWIND CLASS, and that is the whole
 * reason this is testable. The utility class is CSS, jsdom compiles none, and a
 * class-hidden panel stays in the accessibility tree here while disappearing in
 * a browser -- so every query in page.test.tsx would go on passing at exactly
 * the configuration where the contract is false. The attribute is honoured by
 * the UA sheet AND by the accessibility tree jsdom builds, so one station is
 * reachable at a time in both, and no scope rule below sets `display` on these
 * three hooks to out-rank it.
 *
 * THE PANELS STAY MOUNTED. Switching station hides a panel, it does not unmount
 * it, so a half-typed drill on the workbench and a chosen filter on the shelf
 * are both still there when the coach walks back. Unmounting would have made
 * the rail quietly destructive.
 */
type Station = 'library' | 'gym' | 'workbench';

const STATIONS: readonly { readonly id: Station; readonly label: string; readonly note: string }[] = [
  { id: 'library', label: 'Reference cabinet', note: 'Read and adopt' },
  { id: 'gym', label: 'This gym’s shelf', note: 'What we run' },
  { id: 'workbench', label: 'Workbench', note: 'Write a new one' },
];

function CoachDrillLibrary() {
  const [drills, setDrills] = useState<Drill[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [referenceDrills, setReferenceDrills] = useState<ReferenceDrill[]>([]);
  const [referenceLoading, setReferenceLoading] = useState(true);
  const [referenceLoadError, setReferenceLoadError] = useState('');
  /* Which station the coach is standing at. 'library' because the cabinet is
     what this room is for; the workbench opened the page once and put the rare
     path in front of the usual one. */
  const [station, setStation] = useState<Station>('library');

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
  // Where each reference drill stands in this gym, keyed by reference drill id
  // (W-D4C). Derived by the SERVER from durable rows and sent with the list, so
  // it can never disagree with them -- it replaced a client census that, when
  // its read failed, silently showed every drill as never adopted and offered
  // Promote on references the server would refuse.
  const [lifecycle, setLifecycle] = useState<Record<string, ReferenceLifecycle>>({});
  const [promoteNotice, setPromoteNotice] = useState('');

  // Retire and Restore (OD-2026-09-19-001 LIFECYCLE): one in-flight change at
  // a time, mirrored in a ref for the same double-click reason as Promote.
  const [changingLifecycle, setChangingLifecycle] = useState(false);
  const changingLifecycleRef = useRef(false);
  // What the alert says a failed action did (ActionOutcome, above).
  const [actionOutcome, setActionOutcome] = useState<ActionOutcome>('refused');
  const [focusRequest, setFocusRequest] = useState<{ referenceDrillId: string } | null>(null);

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Record<FilterKey, string>>(NO_FILTERS);

  // The informed decision surface (OD-2026-09-19-001). A reference drill is
  // opened in full -- instruction, safety, scaling, source and version -- and
  // Promote lives there, not on the one-line card: adoption is consequential,
  // so it happens where the coach can see what they are adopting.
  const [openReferenceId, setOpenReferenceId] = useState('');
  const [openReference, setOpenReference] = useState<DrillDetailView | null>(null);
  // The raw detail as well as the view: adoption readiness is judged on the
  // server's own fields, by the same function the promote route enforces.
  const [openReferenceDetail, setOpenReferenceDetail] = useState<DrillWithDetail | null>(null);
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

  const loadReferenceLibrary = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/drill-library`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('The reference drill library could not be loaded.');
      const payload = (await response.json()) as {
        drills?: ReferenceDrill[];
        lifecycle?: Record<string, ReferenceLifecycle>;
      };
      if (!Array.isArray(payload.drills)) throw new Error('The reference drill library returned an invalid response.');
      setReferenceDrills(payload.drills);
      setLifecycle(payload.lifecycle ?? {});
      setReferenceLoadError('');
      return true;
    } catch (error) {
      setReferenceDrills([]);
      // A stale map would keep offering the action from before the change the
      // coach just made; with none, the open drill says its status could not be
      // read and offers nothing.
      setLifecycle({});
      setReferenceLoadError(error instanceof Error ? error.message : 'The reference drill library could not be loaded.');
      return false;
    } finally {
      setReferenceLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred behind an await so no state is set while the effect body runs.
    void (async () => {
      await Promise.all([load(), loadReferenceLibrary()]);
    })();
  }, [load, loadReferenceLibrary]);

  // While a Promote, Retire or Restore is running -- its request, and every
  // re-read after it -- the coach stays on the drill it is for and starts
  // nothing else: Back, every control that opens a drill and the drill's own
  // actions are disabled. Its notice, its alert, its re-read detail and its
  // focus move all describe THAT action on THAT drill, so none of them may
  // land on another drill or be mixed up with a second action.
  const actionInFlight = promotingReferenceId !== '' || changingLifecycle;

  // Name search and the durable filters, applied to the list the server sent.
  const searchTerm = search.trim().toLowerCase();
  const visibleReferenceDrills = referenceDrills.filter((drill) => {
    if (searchTerm && !drill.name.toLowerCase().includes(searchTerm)) return false;
    return FILTERS.every((spec) => !filters[spec.key] || spec.valueOf(drill, lifecycle[drill.drill_id]) === filters[spec.key]);
  });
  const filtering = searchTerm !== '' || FILTERS.some((spec) => filters[spec.key] !== '');
  // Options are the values actually present, so a filter never offers a choice
  // that can only return nothing -- except the one already chosen. An action can
  // empty the chosen state (restoring the only retired drill); the select must
  // go on showing that choice, which is still what narrows the list, rather
  // than fall back to "Any" while the list stays narrowed.
  const filterOptions = (spec: FilterSpec) =>
    [...new Set([
      ...referenceDrills.map((drill) => spec.valueOf(drill, lifecycle[drill.drill_id])),
      filters[spec.key],
    ].filter(Boolean))].sort();

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
    setOpenReferenceDetail(null);
    setOpenReferenceError('');
    setOpenReferenceLoading(true);
    setPromoteError('');
    // The detail renders at the reference cabinet; a card on the gym's shelf
    // opens it too, so walk the coach to the equipment it appears on before
    // scrolling -- otherwise the scroll targets a panel the attribute hides.
    setStation('library');
    referenceSectionRef.current?.scrollIntoView?.({ block: 'start' });
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/drill-library?drill_id=${encodeURIComponent(referenceDrillId)}`,
        { method: 'GET', credentials: 'include' },
      );
      // 404 is an answer, not a failure: the drill is not in this gym's library.
      if (response.status === 404) throw new Error(REFERENCE_NOT_FOUND);
      if (!response.ok) throw new Error('This reference drill could not be loaded.');
      const payload = (await response.json()) as { drill?: DrillWithDetail; lifecycle?: ReferenceLifecycle | null };
      if (!payload.drill) throw new Error('This reference drill could not be loaded.');
      if (openRequestRef.current !== request) return;
      setOpenReference(fromCoachDrillDetail(payload.drill));
      setOpenReferenceDetail(payload.drill);
      // The detail's own lifecycle is read with the drill, so it is fresher
      // than the list's; it replaces this drill's entry.
      const fresh = payload.lifecycle;
      if (fresh) {
        setLifecycle((prev) => ({ ...prev, [referenceDrillId]: fresh }));
      }
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
    // A notice ("Retired. It can no longer...") speaks of the drill being
    // left; above the library it would name no drill at all.
    setPromoteNotice('');
    setOpenReferenceId('');
    setOpenReference(null);
    setOpenReferenceDetail(null);
    setOpenReferenceError('');
    setOpenReferenceLoading(false);
    setPromoteError('');
    const openerId = openerRef.current;
    if (openerId && typeof window !== 'undefined') {
      /* THE CONTROL SAYS "BACK TO THE REFERENCE LIBRARY", SO THAT IS WHERE THIS
         LANDS. The card that opened the detail can be on the gym's shelf, and an
         earlier draft of this walked the coach back to that shelf so focus could
         return to the exact card -- which contradicted the only promise the
         button makes, and moved a coach to a station they had not asked for.
         page.test.tsx said so immediately: the search and filters did not come
         back.

         So the station is always the cabinet, and the opener gets focus only if
         it STANDS at the cabinet. When it does not -- or has been filtered away
         -- the fallbacks below take it, and both of those stand here too.

         SYNCHRONOUSLY, not inside the frame: the frame below is the one that
         focuses, React flushes this before it runs, and doing it in the frame
         would have needed a second one -- silently changing the contract every
         caller that counts frames is measuring. */
      setStation('library');
      window.requestAnimationFrame(() => {
        // The card that opened it can be gone by now -- filtered out by the
        // state an action just changed, or retired off the operational list --
        // and then the search box, at the head of the list, takes focus rather
        // than the page body; if the library itself failed to load, so there is
        // no search box either, the section's heading does.
        const openedFrom = document.getElementById(openerId);
        const atTheCabinet = openedFrom?.closest('[data-station]')?.getAttribute('data-station') === 'library'
          ? openedFrom
          : null;
        const opener = atTheCabinet
          ?? document.getElementById('reference-search')
          ?? document.getElementById('reference-library-heading');
        opener?.scrollIntoView?.({ block: 'center' });
        opener?.focus();
      });
    }
  }

  // After an action, succeeded or failed: focus goes to the drill's lifecycle
  // control, re-rendered under the same id with its new label -- or, when the
  // new state offers no action, to the drill's heading, so it never falls to
  // the page body. Requested in the same render as the action's end, so the
  // control is enabled again by the time the effect runs, then moved on the
  // next frame -- but only from where the action left it (the page body, once
  // the button it was on was disabled or removed, or somewhere in this drill).
  // Focus the coach moved elsewhere while it saved -- into the Create a gym drill
  // form, say -- stays there.
  function focusLifecycleControl(referenceDrillId: string) {
    setFocusRequest({ referenceDrillId });
  }
  useEffect(() => {
    if (!focusRequest) return;
    const id = focusRequest.referenceDrillId;
    window.requestAnimationFrame(() => {
      const heading = document.getElementById(`drill-detail-${id}`);
      const drill = heading?.closest('article');
      const current = document.activeElement;
      if (current && current !== document.body && !drill?.contains(current)) return;
      (document.getElementById(`lifecycle-${id}`) ?? heading)?.focus();
    });
  }, [focusRequest]);

  // The open drill's own detail, read again after a refusal the page may have
  // been out of date for: whether its reference is still in the library, and
  // what it lacks to be adopted, come from the detail, not the list. Only for
  // the drill that was open when the action STARTED (`openRequest`, the open
  // counter captured then) and is open still -- navigation is disabled while
  // the action runs, and this holds even if it were not. A failed read keeps
  // what is shown.
  async function rereadOpenDetail(referenceDrillId: string, openRequest: number) {
    if (openRequestRef.current !== openRequest) return;
    const request = openRequest;
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/drill-library?drill_id=${encodeURIComponent(referenceDrillId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) return;
      const payload = (await response.json()) as { drill?: DrillWithDetail; lifecycle?: ReferenceLifecycle | null };
      if (!payload.drill || openRequestRef.current !== request) return;
      setOpenReference(fromCoachDrillDetail(payload.drill));
      setOpenReferenceDetail(payload.drill);
      const fresh = payload.lifecycle;
      if (fresh) {
        setLifecycle((prev) => ({ ...prev, [referenceDrillId]: fresh }));
      }
    } catch {
      // Keep what is shown; the list's status was already read again.
    }
  }

  // After a failed action: re-read what it may have left out of date (both
  // lists, then the open drill's detail) and say what is then known. A plain
  // refusal left the page current, so nothing is read. The alert is shown only
  // after this settles, so it never describes a re-read still in flight.
  async function afterFailedAction(status: number | null, referenceDrillId: string, openRequest: number): Promise<ActionOutcome> {
    const unknown = status === null || status >= 500;
    if (!unknown && status !== 409) return 'refused';
    const [, libraryRead] = await Promise.all([load(), loadReferenceLibrary()]);
    if (libraryRead) await rereadOpenDetail(referenceDrillId, openRequest);
    if (unknown) return libraryRead ? 'unknown' : 'unknown_unread';
    return libraryRead ? 'reread' : 'reread_failed';
  }

  async function promoteReference(referenceDrillId: string) {
    if (promotingRef.current || changingLifecycleRef.current) return;

    promotingRef.current = true;
    const openRequest = openRequestRef.current;
    setPromotingReferenceId(referenceDrillId);
    setPromoteError('');
    setPromoteNotice('');
    setActionOutcome('refused');

    let status: number | null = null;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/drills/promote`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference_drill_id: referenceDrillId }),
      });
      status = response.status;

      const payload = (await response.json().catch(() => ({}))) as { error?: string; missing?: string[] };
      if (!response.ok) {
        const missing = Array.isArray(payload.missing) && payload.missing.length > 0 ? ` ${payload.missing.join(' ')}` : '';
        throw new Error(`${payload.error || 'The drill could not be promoted.'}${missing}`);
      }

      // Reload rather than patching local state: the server decides what this
      // gym has adopted, and the lifecycle shown should be its answer, not this
      // component's optimism.
      await Promise.all([load(), loadReferenceLibrary()]);
      setPromoteNotice('Promoted. It is now an operational drill: coaches can assign it, and athletes in this gym can read it in Learn.');
    } catch (error) {
      const outcome = await afterFailedAction(status, referenceDrillId, openRequest);
      setActionOutcome(outcome);
      setPromoteError(error instanceof Error ? error.message : 'The drill could not be promoted.');
    } finally {
      promotingRef.current = false;
      setPromotingReferenceId('');
      focusLifecycleControl(referenceDrillId);
    }
  }

  // Retire or Restore the gym's adoption of a reference drill -- always the SAME
  // operational identity (the adopted lineage's newest version), through the
  // drills route's PATCH, whose restore guard the server enforces for every
  // caller. Nothing is created: promoting again after a retirement is refused.
  async function changeLifecycle(referenceDrillId: string, operationalDrillId: string, active: boolean) {
    if (changingLifecycleRef.current || promotingRef.current) return;
    changingLifecycleRef.current = true;
    const openRequest = openRequestRef.current;
    setChangingLifecycle(true);
    setPromoteError('');
    setPromoteNotice('');
    setActionOutcome('refused');
    // Whether Restore will be possible afterwards: not when the reference itself
    // has been withdrawn, so the notice must not promise it then.
    const restorable = openReferenceDetail?.active !== false;
    let status: number | null = null;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/drills`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drill_id: operationalDrillId, active }),
      });
      status = response.status;
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || (active ? 'The drill could not be restored.' : 'The drill could not be retired.'));
      }
      await Promise.all([load(), loadReferenceLibrary()]);
      setPromoteNotice(active
        ? 'Restored. It is operational again: coaches can assign it, and athletes in this gym can read it in Learn.'
        : restorable
          ? 'Retired. It can no longer be newly assigned, and athletes no longer find it in Learn. Assigned work that is still open keeps its instructions. Restore brings the same drill back.'
          : 'Retired. It can no longer be newly assigned. Its reference has been withdrawn, so it cannot be restored.');
    } catch (error) {
      const outcome = await afterFailedAction(status, referenceDrillId, openRequest);
      setActionOutcome(outcome);
      setPromoteError(error instanceof Error ? error.message : 'The drill could not be changed.');
    } finally {
      changingLifecycleRef.current = false;
      setChangingLifecycle(false);
      focusLifecycleControl(referenceDrillId);
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

  // THE ORDER IS THE JOURNEY (owner redesign, 2026-09-20): find a reference
  // drill, open it, decide; then what this gym already runs; then, last and
  // quietest, writing a drill of the gym's own. The create form used to open
  // the page, which put the rare path ahead of the usual one. Every control,
  // handler and state below is the one that was here -- only where each sits,
  // and what it is dressed in, changed. The three section headings gained ids
  // so each section is a region named by its heading.
  return (
    /* NO `bg-[var(--hide-950)]` AND NO `max-w-6xl` ANY MORE.

       The opaque utility background was painting over the room's own ground,
       which since the 2026-09-26 mix ruling is a photograph of this gym behind
       a scrim -- an unlayered Tailwind background on <main> would have hidden
       it and the failure would have looked like "the plate does not work".

       The column is gone with it. It was `mx-auto max-w-6xl`: 1152px of content
       with dead ground down both sides of any real screen. The reading measure
       moved onto the prose, where a measure belongs, and the room now runs wall
       to wall the way the two shells measured for this ruling do. */
    <main className="ge-drillcase room min-h-screen text-[color:var(--bone-200)]">
      <div className="ge-drillcase__room">
        <div className="ge-drillcase__rail">
          {/* The nameplate, on the stile rather than across the top. A masthead
              band spanning the full width is the column's last habit: it costs
              the same vertical space on a phone as on a 27in monitor and tells
              the coach nothing they did not already know from the door. */}
          <header className="ge-drillcase__masthead">
            <p className="t-eyebrow">Coach</p>
            <h1 className="t-command mt-[var(--s2)] text-[length:var(--t-xl)]">Drill Library</h1>
            <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
              Find, inspect and adopt drills for this gym.
            </p>
          </header>

        {/* THE RAIL: the equipment standing in this room, and walking to one.
            BUTTONS WITH `aria-current`, NOT role="tablist". role="tablist"
            appears nowhere in this application, and a real tablist owes every
            child role="tab", aria-selected and arrow-key ownership that this
            rail does not implement -- claiming the role without them tells a
            screen reader to expect a keyboard contract that is not there.
            CoachWorkspace made this same call for its own rail. */}
          <nav aria-label="Equipment in this room" className="ge-drillcase__stations">
            {STATIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setStation(item.id)}
              /* THE RAIL IS INSIDE THE ACTION LOCK. W-D4C binds the coach to a
                 drill until its action and every re-read after it have finished,
                 so that nothing it reports can land on another drill. Walking to
                 another piece of equipment is exactly the kind of "something
                 else" that lock exists to stop -- it was the first thing this
                 rail broke, and page.test.tsx's own lock cases are what said so.
                 Disabled rather than hidden: the row is the coach's map of the
                 room, and a map that loses an entry while a save is in flight is
                 worse than one that is briefly untouchable. */
                disabled={actionInFlight}
                aria-current={station === item.id ? 'true' : undefined}
                className="ge-drillcase__station"
              >
                <span className="ge-drillcase__station-name t-command">{item.label}</span>
                <span className="ge-drillcase__station-note t-label">{item.note}</span>
              </button>
            ))}
          </nav>

          {/* The way out, at the foot of the stile. It was beside the title in
              the masthead band, which put "leave" at the same weight as the
              room's own name. */}
          <Link href="/coach/environment/intake-router" className="btn btn--ghost ge-drillcase__leave">
            Back to Coach Workspace
          </Link>
        </div>

        <div className="ge-drillcase__surface">

        {/* 1. THE REFERENCE LIBRARY -- the primary workspace: the drill cabinet. */}
        <section
          ref={referenceSectionRef}
          data-station="library"
          hidden={station !== 'library'}
          aria-labelledby="reference-library-heading"
          className="ge-drillcase__cabinet mt-[var(--s6)] rounded-[var(--r-lg)] p-[var(--s4)] md:p-[var(--s5)]"
        >
          <div className="ge-drillcase__cabinet-head">
            <h2 id="reference-library-heading" tabIndex={-1} className="t-command text-[length:var(--t-xl)]">Reference library</h2>
            {/* Truthful since W-D2: athletes read a drill in Learn only when it was
                promoted from the reference library. */}
            <p className="t-body mt-[var(--s2)] max-w-3xl text-[color:var(--bone-300)]">
              Seeded coaching material for planning and review. The reference source stays read-only: open a
              drill to read all of it before deciding whether to adopt it. Promoting adopts that exact drill and
              version into this gym, where it becomes an operational drill in the list below, and athletes in
              this gym can then read its full instructions in Learn.
            </p>
            {/* Its own line, not the tail of a paragraph: adopting and assigning
                are different acts, and this is the one sentence that says so. */}
            <p className="ge-drillcase__boundary mt-[var(--s3)]">Promoting does not assign the drill to any athlete.</p>
          </div>

          {promoteNotice && (
            <p role="status" className="t-body mt-[var(--s4)] text-[color:var(--bone-200)]">{promoteNotice}</p>
          )}

          {promoteError && (
            <div role="alert" className="mt-[var(--s4)] rounded-[var(--r-md)] border-2 border-[var(--restricted)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
              <p className="text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">{promoteError}</p>
              <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                {OUTCOME_EXPLANATIONS[actionOutcome]}
              </p>
            </div>
          )}

          {referenceLoading && <p className="t-body mt-[var(--s4)] text-[color:var(--bone-300)]">Loading reference drills...</p>}

          {!referenceLoading && referenceLoadError && (
            <div className="mt-[var(--s4)] rounded-[var(--r-md)] border-2 border-[var(--restricted)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
              <p className="text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">{referenceLoadError}</p>
              <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                This is a failure to load, not an empty reference library.
              </p>
            </div>
          )}

          {!referenceLoading && !referenceLoadError && referenceDrills.length === 0 && (
            <p className="t-body mt-[var(--s4)] text-[color:var(--bone-300)]">No reference drills are available.</p>
          )}

          {/* LEVEL 2: the opened reference drill, with Promote on it -- the card
              pulled from the cabinet and laid on the work surface. It REPLACES
              the discovery rail and the card grid below (both hidden while it is
              open); it is not a pane beside them. */}
          {openReferenceId && (
            <div className="ge-drillcase__worksurface mt-[var(--s4)] space-y-[var(--s4)] rounded-[var(--r-lg)] p-[var(--s3)] md:p-[var(--s5)]">
              <button type="button" onClick={closeReferenceDrill} disabled={actionInFlight} className="btn btn--ghost">
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
                  actions={(
                    // The lifecycle boundary: where this drill stands in this gym,
                    // and the one action that state allows.
                    <div className="ge-drillcase__adopt flex w-full flex-wrap items-center gap-[var(--s3)] rounded-[var(--r-md)] p-[var(--s3)]">
                      <ReferenceActions
                        referenceDrillId={openReference.id}
                        state={lifecycle[openReference.id]}
                        detail={openReferenceDetail}
                        promotingReferenceId={promotingReferenceId}
                        changingLifecycle={changingLifecycle}
                        busy={actionInFlight}
                        onPromote={(id) => void promoteReference(id)}
                        onChangeLifecycle={(id, operationalId, restoring) => void changeLifecycle(id, operationalId, restoring)}
                      />
                    </div>
                  )}
                />
              )}
            </div>
          )}

          {/* DISCOVERY: name search and durable filters (W-D4C). Hidden while a
              drill is open, with the grid it narrows. */}
          {!referenceLoading && !referenceLoadError && referenceDrills.length > 0 && (
            <div className={`mat-leather mt-[var(--s4)] rounded-[var(--r-lg)] p-[var(--s4)]${openReferenceId ? ' hidden' : ''}`}>
              <div className="grid items-end gap-[var(--s3)] sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
                <div className="field sm:col-span-2 md:col-span-3 xl:col-span-6">
                  <label htmlFor="reference-search" className="t-label">Search by name</label>
                  <input
                    id="reference-search"
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    className="input"
                    autoComplete="off"
                  />
                </div>
                {FILTERS.map((spec) => (
                  <div key={spec.key} className="field">
                    <label htmlFor={`reference-filter-${spec.key}`} className="t-label">{spec.label}</label>
                    <select
                      id={`reference-filter-${spec.key}`}
                      value={filters[spec.key]}
                      onChange={(event) => setFilters((prev) => ({ ...prev, [spec.key]: event.target.value }))}
                      className="select"
                    >
                      <option value="">Any</option>
                      {filterOptions(spec).map((value) => (
                        <option key={value} value={value}>{spec.labelOf(value)}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <div className="mt-[var(--s3)] flex flex-wrap items-center gap-[var(--s3)]">
                <p role="status" className="t-label text-[color:var(--bone-300)]">
                  Showing {visibleReferenceDrills.length} of {referenceDrills.length} reference drills
                </p>
                {filtering && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch('');
                      setFilters(NO_FILTERS);
                      document.getElementById('reference-search')?.focus();
                    }}
                    className="btn btn--ghost"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            </div>
          )}

          {!referenceLoading && !referenceLoadError && referenceDrills.length > 0 && visibleReferenceDrills.length === 0 && !openReferenceId && (
            <p className="t-body mt-[var(--s4)] text-[color:var(--bone-300)]">No reference drills match this search and these filters.</p>
          )}

          {/* LEVEL 1: concise index cards. Equipment is labelled as equipment --
              it used to be printed under "Setup:", which for most of the corpus
              made an equipment word look like the setup instructions. A card
              carries no Promote: adoption is decided on the opened drill. */}
          <div className={`mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2 xl:grid-cols-3${openReferenceId ? ' hidden' : ''}`}>
            {visibleReferenceDrills.map((drill) => (
              <article key={drill.drill_id} className="ge-drillcase__card mat-leather--raised flex flex-col rounded-[var(--r-lg)] p-[var(--s4)]">
                <div className="flex items-start justify-between gap-[var(--s3)]">
                  <h3 className="t-command text-[length:var(--t-md)]">{drill.name}</h3>
                  <span className="plaque shrink-0">{drill.difficulty}</span>
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
                  <p className="ge-drillcase__authorization mt-[var(--s3)]">
                    Coach authorization required
                  </p>
                )}
                {/* The state stamp sits above the button rather than beside it, so
                    every card's View drill lands on the same line of its row. */}
                <div className="mt-auto flex flex-col items-start gap-[var(--s3)] pt-[var(--s4)]">
                  {lifecycle[drill.drill_id] && lifecycle[drill.drill_id].state !== 'available' && (
                    <p className="ge-drillcase__state t-label">{LIFECYCLE_LABELS[lifecycle[drill.drill_id].state]}</p>
                  )}
                  <button
                    type="button"
                    id={`view-reference-${drill.drill_id}`}
                    onClick={() => void openReferenceDrill(drill.drill_id, `view-reference-${drill.drill_id}`)}
                    disabled={actionInFlight}
                    className="btn btn--ghost"
                    aria-label={`View drill: ${drill.name}`}
                  >
                    View drill
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* 2. IN THIS GYM -- the gym's operational drills, the ones assignments
            point at. "Gym-authored" was false for every promoted drill
            (OD-2026-09-19-001), so each card says which kind it is. Working
            ledger cards rather than index cards, so a drill the gym runs never
            reads as one it is only browsing. */}
        <section
          data-station="gym"
          hidden={station !== 'gym'}
          aria-labelledby="gym-drills-heading"
          className="mt-[var(--s7)]"
        >
          <div className="ge-drillcase__shelf-head">
            <p className="t-eyebrow">Operational drills</p>
            <h2 id="gym-drills-heading" className="t-command mt-[var(--s2)] text-[length:var(--t-lg)]">In this gym</h2>
            <p className="t-body mt-[var(--s2)] max-w-3xl text-[color:var(--bone-300)]">
              These are the drills this gym currently runs and can assign.
            </p>
          </div>

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
              Nothing yet. Promote a drill from the reference library, or create one below; assignments can only
              point at operational drills.
            </p>
          )}

          <div className="mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2 xl:grid-cols-3">
            {drills.map((drill) => (
              <article key={drill.drill_id} className="ge-drillcase__ledger mat-leather--raised flex flex-col rounded-[var(--r-lg)] p-[var(--s4)]">
                <div className="flex items-start justify-between gap-[var(--s3)]">
                  <h3 className="t-command text-[length:var(--t-md)]">{drill.name}</h3>
                  <span className="plaque shrink-0">{drill.difficulty}</span>
                </div>
                <p className="t-label mt-[var(--s2)]">{drill.category}</p>
                <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">{drill.focus}</p>
                {drill.cues.length > 0 && (
                  <ul className="mt-[var(--s3)] flex flex-wrap gap-[var(--s2)]">
                    {drill.cues.map((cue) => (
                      <li key={`${drill.drill_id}-${cue}`} className="rounded-[var(--r-sm)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                        {cue}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-auto flex flex-wrap items-center gap-[var(--s3)] pt-[var(--s4)]">
                  <p className={`ge-drillcase__provenance${drill.reference_drill_id ? ' ge-drillcase__provenance--reference' : ''}`}>
                    {drill.reference_drill_id ? 'From reference library' : 'Written by this gym'}
                  </p>
                  {/* A promoted drill's instructions live on its reference drill, so
                      this opens that exact reference -- the pointer, never a name
                      match. A hand-written drill has no reference to open. */}
                  {drill.reference_drill_id && (
                    <button
                      type="button"
                      id={`view-instructions-${drill.drill_id}`}
                      onClick={() => void openReferenceDrill(drill.reference_drill_id as string, `view-instructions-${drill.drill_id}`)}
                      disabled={actionInFlight}
                      className="btn btn--ghost"
                      aria-label={`View instructions: ${drill.name}`}
                    >
                      View instructions
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* 3. CREATE A GYM DRILL -- the secondary workbench, for a drill the
            reference library does not have. Its fields, validation, saving and
            messages are exactly the Add a drill form that used to open the page.
            A drill written here is assignable, and its name and purpose reach
            the athlete on the assignment, but it has no reference instructions
            to read in Learn. */}
        <section
          data-station="workbench"
          hidden={station !== 'workbench'}
          aria-labelledby="create-drill-heading"
          className="ge-drillcase__workbench mat-leather mt-[var(--s7)] rounded-[var(--r-lg)] p-[var(--s4)] md:p-[var(--s5)]"
        >
          <h2 id="create-drill-heading" className="t-command text-[length:var(--t-md)]">Create a gym drill</h2>
          <p className="t-body mt-[var(--s2)] max-w-3xl text-[color:var(--bone-300)]">
            For a drill this gym needs that the reference library does not have. It becomes an operational drill
            coaches can assign, but it has no reference instructions for athletes to read.
          </p>

          <div className="mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2 xl:grid-cols-[1fr_1fr_1.4fr_1.6fr_0.9fr]">
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
            <div className="field md:col-span-2 xl:col-span-1">
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
        </div>
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

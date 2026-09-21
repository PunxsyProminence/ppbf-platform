/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import CoachDrillLibraryPage from './page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

// Each read gets its own copy, as a real response would: a test that changes
// a payload later cannot reach into what the page already holds.
function jsonResponse(body: unknown, ok = true, status = 200) {
  const text = JSON.stringify(body);
  return { ok, status, json: async () => JSON.parse(text) as unknown } as Response;
}

const authored = {
  drill_id: 'authored-1',
  reference_drill_id: null,
  name: 'Corner exit',
  category: 'Footwork',
  focus: 'Leave the ropes safely.',
  difficulty: 'beginner',
  cues: ['Turn first'],
};

const reference = {
  drill_id: 'reference-1',
  name: 'Seeded jab return',
  discipline: 'boxing',
  category: 'striking',
  difficulty: 'fundamentals',
  purpose: 'Return the hand to guard.',
  standard_setup: 'Partners at technical distance.',
  equipment_needed: 'focus mitts',
  contact_level: 'light_technical',
  requires_coach_authorization: true,
};

// The coach detail shape (getDrillWithDetail): every reference column plus the
// three child sets. What the detail surface is for is showing THIS before a
// coach adopts anything.
const referenceDetail = {
  ...reference,
  organization_id: 'org-1',
  lineage_id: 'reference-1',
  version: 1,
  supersedes_drill_id: null,
  superseded_at: null,
  skill_id: 'SK-JAB-01',
  target_behavior: 'Return the hand to guard.',
  execution: 'Jab at the mitt.\n\nReturn the hand to the chin.\n\nReset the stance.',
  what_good_looks_like: 'Hand back before the next beat\nChin stays down',
  what_bad_looks_like: 'Hand drops on the way back',
  common_errors: 'Pawing the jab',
  corrections: 'Coach calls "home" on every return',
  transfer: 'Protects the chin in exchanges [A2-070]',
  content_class: 'COACHING CRAFT - PPBF source manual v3',
  source_ref: 'Punxsy_Drill_Library_Source_v3.docx',
  grounding_claim_ids: ['A2-070'],
  field_provenance: 'PPBF source manual v3',
  active: true,
  created_by_account_id: null,
  created_by_role: null,
  created_at: '2026-09-16T00:00:00.000Z',
  updated_at: '2026-09-16T00:00:00.000Z',
  scale_levels: [
    { organization_id: 'org-1', scale_id: 's-a', drill_id: 'reference-1', scale_level: 'A', is_starting_point: false, demand_description: 'Slow the pace.', constraint_applied: '', contact_level: 'light_technical', coach_watch_point: 'Is the athlete repeating it unprompted?', authoring_state: 'authored' },
    { organization_id: 'org-1', scale_id: 's-b', drill_id: 'reference-1', scale_level: 'B', is_starting_point: true, demand_description: 'The drill as designed.', constraint_applied: '', contact_level: 'light_technical', coach_watch_point: 'Can the athlete respond to one cue?', authoring_state: 'authored' },
    { organization_id: 'org-1', scale_id: 's-c', drill_id: 'reference-1', scale_level: 'C', is_starting_point: false, demand_description: 'Add a partner counter.', constraint_applied: '', contact_level: 'light_technical', coach_watch_point: 'Does the lesson survive?', authoring_state: 'authored' },
  ],
  stop_rules: [
    { organization_id: 'org-1', stop_rule_id: 'st-1', drill_id: 'reference-1', ordinal: 1, condition_text: 'Stop when fatigue breaks decision quality.', scope: 'universal', rule_kind: 'fatigue' },
    { organization_id: 'org-1', stop_rule_id: 'st-2', drill_id: 'reference-1', ordinal: 2, condition_text: 'Stop when the hand stops coming home.', scope: 'drill_specific', rule_kind: 'technique_degradation' },
  ],
  cues: [
    { organization_id: 'org-1', cue_id: 'c-1', drill_id: 'reference-1', cue_text: 'Hand home first', cue_family: 'Jab', focus_type: 'external', evidence_note: 'Coaching craft.', source_ref: null },
  ],
  secondary_skills: [],
};

const promoted = {
  drill_id: 'authored-2',
  reference_drill_id: 'reference-1',
  name: 'Seeded jab return',
  category: 'striking',
  focus: 'Return the hand to guard.',
  difficulty: 'intermediate',
  cues: ['Hand home first'],
};

// W-D4C: where a reference drill stands in this gym, as the drill-library
// route derives it and sends it beside the list.
type LifecycleState = 'available' | 'operational' | 'retired' | 'superseded' | 'unavailable';
interface Lifecycle { state: LifecycleState; operational_drill_id: string | null }
type LifecycleMap = Record<string, Lifecycle>;

const NOT_ADOPTED: Lifecycle = { state: 'available', operational_drill_id: null };
// The adopted lineage's HEAD. Deliberately not the id of any row the page can
// see, so a Retire or Restore that sends anything else is caught.
const OPERATIONAL_HEAD = 'operational-head-7';

type ReferenceRow = typeof reference;

interface RouteOptions {
  operational?: unknown[];
  references?: ReferenceRow[];
  /** Coach detail payloads by reference drill id; reference-1 is always there. */
  details?: Record<string, unknown>;
  /** The list payload's lifecycle map. `null` sends a list with no lifecycle at all. */
  lifecycle?: LifecycleMap | null;
  promote?: () => Response;
  onPromote?: () => void;
  patch?: (body: { drill_id: string; active: boolean }) => Response;
  /**
   * The write LANDS -- the lifecycle changes as it would -- and then this is
   * the answer the page gets: the fault or dropped connection that hides a
   * committed change.
   */
  answerAfterCommit?: () => Response;
  /** Answers the Nth read of the library list (1-based) instead, when it returns a response. */
  libraryRead?: (readNumber: number) => Response | undefined;
  /**
   * Another coach acted after the list was read: the server's lifecycle is this
   * by the time the drill's detail is read, so the detail carries the newer
   * answer, and so does every list read after it.
   */
  changedBeforeDetail?: LifecycleMap;
  /** The detail answers with the drill alone, without a lifecycle. */
  detailWithoutLifecycle?: boolean;
  /** Answers the Nth read of a drill's detail (1-based) instead, when it returns a response. */
  detailRead?: (readNumber: number) => Response | undefined;
}

/**
 * One stub for every route the page reads, so each test only states what is
 * different about it. It answers like the server: a promotion or a successful
 * Retire / Restore changes the lifecycle the NEXT list read returns, so the
 * page can only show the new state by reloading it. The detail read is matched
 * on its query string: a stub that answered it with the list would let a
 * broken detail pass. Anything the page was not built to call gets a 500.
 */
function routes(options: RouteOptions = {}) {
  let operational = options.operational ?? [authored];
  const references = options.references ?? [reference];
  const details: Record<string, unknown> = { [reference.drill_id]: referenceDetail, ...options.details };
  let lifecycle: LifecycleMap | null = options.lifecycle === undefined
    ? { [reference.drill_id]: NOT_ADOPTED }
    : options.lifecycle;
  let changedBeforeDetail = options.changedBeforeDetail;
  let libraryReads = 0;
  let detailReads = 0;

  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url === '/api/pilot/drills/promote' && method === 'POST') {
      options.onPromote?.();
      if (options.promote) return options.promote();
      const { reference_drill_id: referenceDrillId } = JSON.parse(String(init?.body)) as { reference_drill_id: string };
      operational = [...operational, promoted];
      lifecycle = { ...lifecycle, [referenceDrillId]: { state: 'operational', operational_drill_id: promoted.drill_id } };
      if (options.answerAfterCommit) return options.answerAfterCommit();
      return jsonResponse({ ok: true, drill: promoted }, true, 201);
    }

    if (url === '/api/pilot/drills' && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as { drill_id: string; active: boolean };
      if (options.patch) return options.patch(body);
      const next: LifecycleMap = {};
      for (const [id, entry] of Object.entries(lifecycle ?? {})) {
        next[id] = entry.operational_drill_id === body.drill_id
          ? { ...entry, state: body.active ? 'operational' : 'retired' }
          : entry;
      }
      lifecycle = next;
      if (options.answerAfterCommit) return options.answerAfterCommit();
      return jsonResponse({ item: { ...promoted, drill_id: body.drill_id, active: body.active } });
    }

    if (method !== 'GET') return jsonResponse({ error: 'unexpected write' }, false, 500);

    if (url.startsWith('/api/pilot/drill-library?drill_id=')) {
      const id = decodeURIComponent(url.slice(url.indexOf('drill_id=') + 'drill_id='.length));
      if (changedBeforeDetail) {
        lifecycle = { ...lifecycle, ...changedBeforeDetail };
        changedBeforeDetail = undefined;
      }
      detailReads += 1;
      const heldOrFailed = options.detailRead?.(detailReads);
      if (heldOrFailed) return heldOrFailed;
      if (!details[id]) return jsonResponse({ error: 'DRILL_NOT_FOUND' }, false, 404);
      return jsonResponse(options.detailWithoutLifecycle
        ? { drill: details[id] }
        : { drill: details[id], lifecycle: lifecycle?.[id] ?? null });
    }
    if (url === '/api/pilot/drill-library') {
      libraryReads += 1;
      const answer = options.libraryRead?.(libraryReads);
      if (answer) return answer;
      return jsonResponse(lifecycle === null ? { drills: references } : { drills: references, lifecycle });
    }
    if (url === '/api/pilot/drills') return jsonResponse({ items: operational });
    return jsonResponse({ error: 'unexpected read' }, false, 500);
  });
}

type FetchMock = ReturnType<typeof routes>;

/** Every non-GET call, as the server would receive it. */
function writes(fetchMock: FetchMock) {
  return fetchMock.mock.calls
    .filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') !== 'GET')
    .map(([url, init]) => ({
      method: (init as RequestInit).method,
      url: String(url),
      body: JSON.parse(String((init as RequestInit).body)) as unknown,
    }));
}

/** How many times one exact URL was read. */
function readsOf(fetchMock: FetchMock, url: string) {
  return fetchMock.mock.calls.filter(
    ([called, init]) => String(called) === url && ((init as RequestInit | undefined)?.method ?? 'GET') === 'GET',
  ).length;
}

/** Opens a REFERENCE card's detail (the first "View drill" of that name in document order). */
async function openReference(name = 'Seeded jab return') {
  const [referenceCardButton] = await screen.findAllByRole('button', { name: `View drill: ${name}` });
  fireEvent.click(referenceCardButton);
  return screen.findByRole('article', { name });
}

/** A reference card: the article holding that drill's "View drill" control. */
function referenceCard(name: string) {
  return screen.getByRole('button', { name: `View drill: ${name}` }).closest('article') as HTMLElement;
}

/** The reference cards currently listed, by name, in the order shown. */
function listedReferenceNames() {
  return screen
    .queryAllByRole('button', { name: /^View drill: / })
    .map((button) => (button.getAttribute('aria-label') ?? '').replace('View drill: ', ''));
}

/** The discovery panel: the search box and the filters beside it. */
function discoveryPanel() {
  return screen.getByRole('searchbox', { name: 'Search by name' }).closest('div.mat-leather') as HTMLElement;
}

/**
 * A discovery filter by its label. Scoped to the panel because "Category" and
 * "Difficulty" also label the Create a gym drill form's controls.
 */
function filterSelect(label: string) {
  return within(discoveryPanel()).getByRole('combobox', { name: label }) as HTMLSelectElement;
}

function optionTexts(select: HTMLElement) {
  return within(select).getAllByRole('option').map((option) => option.textContent);
}

const LIFECYCLE_ACTIONS = ['Promote', 'Retire', 'Restore'];

function expectNoLifecycleAction(container: HTMLElement) {
  for (const name of LIFECYCLE_ACTIONS) {
    expect(within(container).queryByRole('button', { name })).not.toBeInTheDocument();
  }
}

// The page's own sentences, written out once so a test cannot pass on a near miss.
const STATUS_UNREAD = "This drill's status in this gym could not be read.";
const RETIRE_CONSEQUENCE =
  'Retiring stops new assignments and takes it out of Learn. Assigned work that is still open keeps its instructions.';
const RESTORE_CONSEQUENCE =
  'Restoring brings back this same drill: coaches can assign it again, and athletes can read it in Learn.';
const CANNOT_RESTORE = 'Its reference has been withdrawn, so it cannot be restored.';
const RETIRED_NOTICE =
  'Retired. It can no longer be newly assigned, and athletes no longer find it in Learn. Assigned work that is still open keeps its instructions.';
const RESTORE_PROMISE = ' Restore brings the same drill back.';
const OUTCOME_UNKNOWN =
  "It is not known whether this change was saved. This drill's status in this gym was read again; check it before trying again.";
const UNKNOWN_UNREAD =
  "It is not known whether this change was saved, and this drill's status in this gym could not be read again. Reload the page before trying again.";
const REREAD_FAILED =
  "Nothing was changed, but this drill's status in this gym could not be read again. Reload the page before trying again.";
const NOTHING_CHANGED = 'Nothing was changed. This drill is as it was.';
const CONFLICT_REREAD = "Nothing was changed. This drill's status in this gym was read again.";
const DETAIL_URL = '/api/pilot/drill-library?drill_id=reference-1';
const RETIRED_WITHDRAWN_NOTICE =
  'Retired. It can no longer be newly assigned. Its reference has been withdrawn, so it cannot be restored.';
const RETIRE_WITHDRAWN_CONSEQUENCE =
  'Retiring stops new assignments. Its reference has been withdrawn, so athletes already cannot read it, and once retired it cannot be restored.';

const operationalAt = (operationalDrillId: string): Lifecycle => ({ state: 'operational', operational_drill_id: operationalDrillId });
const retiredAt = (operationalDrillId: string): Lifecycle => ({ state: 'retired', operational_drill_id: operationalDrillId });

/**
 * Holds every animation frame the page asks for until the test runs them, so
 * "focus moves on the next frame" is asserted as exactly that: not before the
 * frame, and on it. Restored after each test.
 */
function holdAnimationFrames() {
  const pending: FrameRequestCallback[] = [];
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    pending.push(callback);
    return pending.length;
  });
  return {
    /** Runs the frames asked for so far; returns how many there were. */
    run() {
      const frames = pending.splice(0);
      act(() => {
        for (const frame of frames) frame(performance.now());
      });
      return frames.length;
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('shows reference drills separately from the operational drills assignments point at', async () => {
  global.fetch = routes() as unknown as typeof fetch;

  render(<CoachDrillLibraryPage />);

  expect(await screen.findByText('Seeded jab return')).toBeInTheDocument();
  expect(screen.getByText('Corner exit')).toBeInTheDocument();
  expect(screen.getByText(/reference source stays read-only/i)).toBeInTheDocument();
  expect(screen.getByText(/does not assign the drill to any athlete/i)).toBeInTheDocument();
  expect(screen.getByText('Coach authorization required')).toBeInTheDocument();
});

it('keeps drill creation on the operational drills endpoint', async () => {
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') return jsonResponse({ item: authored }, true, 201);
    return url.endsWith('/drill-library')
      ? jsonResponse({ drills: [reference], lifecycle: { [reference.drill_id]: NOT_ADOPTED } })
      : jsonResponse({ items: [authored] });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<CoachDrillLibraryPage />);
  await screen.findByText('Seeded jab return');

  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Slip line' } });
  // The reference filters have a "Category" too; this is the form's text field.
  fireEvent.change(screen.getByRole('textbox', { name: 'Category' }), { target: { value: 'Defense' } });
  fireEvent.change(screen.getByLabelText('What it is for'), { target: { value: 'Head movement' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add drill' }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/pilot/drills', expect.objectContaining({ method: 'POST' })));
  expect(fetchMock).not.toHaveBeenCalledWith('/api/pilot/drill-library', expect.objectContaining({ method: 'POST' }));
});

it('reports a malformed successful response instead of calling it empty', async () => {
  global.fetch = jest.fn(async () => jsonResponse({ items: [] })) as unknown as typeof fetch;

  render(<CoachDrillLibraryPage />);

  expect(await screen.findByText(/reference drill library returned an invalid response/i)).toBeInTheDocument();
  expect(screen.getByText(/not an empty reference library/i)).toBeInTheDocument();
});

it('lets the operational drills load even when the reference endpoint fails', async () => {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => String(input).endsWith('/drill-library')
    ? jsonResponse({}, false, 500)
    : jsonResponse({ items: [authored] })) as unknown as typeof fetch;

  render(<CoachDrillLibraryPage />);

  expect(await screen.findByText('Corner exit')).toBeInTheDocument();
  expect(screen.getByText(/reference drill library could not be loaded/i)).toBeInTheDocument();
});

// W-D4A, OD-2026-09-19-001: the card is LEVEL 1, concise and truthful.
describe('the reference card', () => {
  it('labels equipment as equipment, not as setup, and carries no Promote of its own', async () => {
    global.fetch = routes() as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    await screen.findByText('Seeded jab return');
    // Scoped to the card: the Contact filter offers the same words as an option.
    const card = referenceCard('Seeded jab return');

    // "Setup:" printed the equipment word for most of the corpus.
    expect(within(card).queryByText(/^Setup:/)).not.toBeInTheDocument();
    expect(within(card).getByText('focus mitts')).toBeInTheDocument();
    expect(within(card).getByText('Light technical contact')).toBeInTheDocument();
    // Adoption is consequential, so it is not on the one-line card.
    expect(screen.queryByRole('button', { name: 'Promote' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View drill: Seeded jab return' })).toBeInTheDocument();
  });
});

// LEVEL 2: the informed decision surface.
describe('the reference drill detail', () => {
  it('opens the full drill: safety first, ordered steps, scaling, stop rules and its source', async () => {
    const fetchMock = routes();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pilot/drill-library?drill_id=reference-1',
      expect.objectContaining({ method: 'GET' }),
    );

    const safety = within(detail).getByRole('region', { name: 'Safety' });
    expect(within(safety).getByText(/Light technical contact/)).toBeInTheDocument();
    expect(within(safety).getByText(/Only run this drill with a coach who has approved it/)).toBeInTheDocument();
    expect(within(safety).getByText('Stop when the hand stops coming home.')).toBeInTheDocument();
    expect(within(safety).getByText('Stop when fatigue breaks decision quality.')).toBeInTheDocument();

    // Execution as the three steps the author wrote, in order.
    const steps = within(detail).getAllByRole('listitem').map((item) => item.textContent);
    const first = steps.indexOf('Jab at the mitt.');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(steps.slice(first, first + 3)).toEqual([
      'Jab at the mitt.',
      'Return the hand to the chin.',
      'Reset the stance.',
    ]);

    expect(within(detail).getByText('Hand back before the next beat')).toBeInTheDocument();
    expect(within(detail).getByText('Pawing the jab')).toBeInTheDocument();
    expect(within(detail).getByText('Partners at technical distance.')).toBeInTheDocument();
    expect(within(detail).getByText(/Standard \(B\) · where to start/)).toBeInTheDocument();
    // Coach-only context is there for the coach.
    expect(within(detail).getByText('Can the athlete respond to one cue?')).toBeInTheDocument();
    expect(within(detail).getByText('PPBF source manual v3')).toBeInTheDocument();
  });

  it('puts Promote on the detail, and promotes through the promote endpoint only', async () => {
    const fetchMock = routes();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    const listReadsBefore = readsOf(fetchMock, '/api/pilot/drill-library');

    fireEvent.click(within(detail).getByRole('button', { name: 'Promote' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/pilot/drills/promote', expect.objectContaining({ method: 'POST' })),
    );
    // The one write, and only to the promote endpoint.
    expect(writes(fetchMock)).toEqual([
      { method: 'POST', url: '/api/pilot/drills/promote', body: { reference_drill_id: 'reference-1' } },
    ]);

    // The server's lifecycle, reloaded with the library list, is what turns
    // Promote into the operational state and its Retire.
    expect(await within(detail).findByText('Operational in this gym')).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'Promote' })).not.toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Retire' })).toBeInTheDocument();
    expect(readsOf(fetchMock, '/api/pilot/drill-library')).toBe(listReadsBefore + 1);
    // And the coach is told what that did, including that athletes can now read it.
    const notice = screen.getByText(/^Promoted\./);
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveTextContent(/athletes in this gym can read it in Learn/);
  });

  it('writes nothing just by being opened', async () => {
    const fetchMock = routes();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    await openReference();

    expect(writes(fetchMock)).toEqual([]);
  });

  it('goes back to the library, un-hiding the card grid it hid', async () => {
    global.fetch = routes() as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    await openReference();
    // jsdom loads no CSS, so visibility is asserted on the class that hides it.
    const grid = screen.getByRole('button', { name: 'View drill: Seeded jab return' }).closest('div.grid');
    expect(grid?.classList.contains('hidden')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Back to the reference library' }));

    expect(screen.queryByRole('article', { name: 'Seeded jab return' })).not.toBeInTheDocument();
    expect(grid?.classList.contains('hidden')).toBe(false);
  });

  it('shows an equipment-only setup as equipment, never as setup instructions', async () => {
    // The corpus case: 114 of 119 reference drills store the equipment word in
    // standard_setup as well. Printed under "Setup" it reads as instructions.
    const equipmentOnly = { ...referenceDetail, standard_setup: 'focus mitt', equipment_needed: 'focus mitt' };
    global.fetch = routes({
      references: [{ ...reference, standard_setup: 'focus mitt', equipment_needed: 'focus mitt' }],
      details: { [reference.drill_id]: equipmentOnly },
    }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    expect(within(detail).queryByRole('heading', { name: 'Setup' })).not.toBeInTheDocument();
    expect(within(detail).getByRole('heading', { name: 'Equipment' })).toBeInTheDocument();
    expect(within(detail).getByText('focus mitt')).toBeInTheDocument();
  });

  it('says what content it is and whether it is current, next to the Promote it informs', async () => {
    global.fetch = routes() as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    expect(within(detail).getByText('Content: PPBF source manual v3. Current version.')).toBeInTheDocument();
  });
});

// Promotion state, per OD-2026-09-16-001, now per W-D4C: the SERVER derives
// where each reference stands from durable rows and sends it with the library
// list. The page keeps no census of its own and infers nothing from names.
describe('promotion state', () => {
  it('offers Promote on the detail of a reference this gym has not adopted', async () => {
    global.fetch = routes() as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    expect(within(detail).getByRole('button', { name: 'Promote' })).toBeEnabled();
    expect(within(detail).queryByText('Not ready to adopt')).not.toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'Retire' })).not.toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
  });

  it('reads where each reference stands from the library list, and never asks for the retired census', async () => {
    const fetchMock = routes();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    fireEvent.click(within(detail).getByRole('button', { name: 'Promote' }));
    await within(detail).findByRole('button', { name: 'Retire' });

    // The census it replaced read every retired drill to reconstruct this; a
    // failure of that read silently re-offered Promote on reserved references.
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.includes('include_retired'))).toEqual([]);
    expect(urls.filter((url) => url.startsWith('/api/pilot/drills?'))).toEqual([]);
  });

  it('shows a reference drill as operational when the server says an active drill points at it', async () => {
    global.fetch = routes({
      operational: [authored, promoted],
      lifecycle: { [reference.drill_id]: { state: 'operational', operational_drill_id: promoted.drill_id } },
    }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);

    expect(await screen.findAllByText('Seeded jab return')).toHaveLength(2);
    expect(within(referenceCard('Seeded jab return')).getByText('Operational in this gym')).toBeInTheDocument();
    const detail = await openReference();
    expect(within(detail).queryByRole('button', { name: 'Promote' })).not.toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Retire' })).toBeInTheDocument();
  });

  it('takes adoption from the server lifecycle, not from operational pointers it could count itself', async () => {
    // An operational drill points at reference-1, but the server's answer is
    // what the page shows: it no longer derives adoption on the client.
    global.fetch = routes({ operational: [authored, promoted] }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    await screen.findByText('Corner exit');

    expect(within(referenceCard('Seeded jab return')).queryByText('Operational in this gym')).not.toBeInTheDocument();
    const detail = await openReference();
    expect(within(detail).getByRole('button', { name: 'Promote' })).toBeEnabled();
  });

  it('shows a retired adoption as retired in this gym without reading any retired drill', async () => {
    const fetchMock = routes({
      operational: [authored],
      lifecycle: { [reference.drill_id]: { state: 'retired', operational_drill_id: OPERATIONAL_HEAD } },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    await screen.findByText('Corner exit');

    // Reserved, but not live: "operational" would tell a coach athletes can
    // read it, and they cannot.
    const card = referenceCard('Seeded jab return');
    expect(within(card).getByText('Retired in this gym')).toBeInTheDocument();
    expect(within(card).queryByText('Operational in this gym')).not.toBeInTheDocument();
    // The retired drill is not smuggled into the active list to get that answer.
    expect(screen.getByText('Corner exit')).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { name: 'Seeded jab return' })).toHaveLength(1);
    expect(fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('include_retired'))).toEqual([]);
  });

  it('does not treat a same-named operational drill as a promotion', async () => {
    const sameName = { ...authored, drill_id: 'authored-3', name: 'Seeded jab return' };
    global.fetch = routes({ operational: [sameName] }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    expect(within(detail).getByRole('button', { name: 'Promote' })).toBeInTheDocument();
    expect(within(detail).queryByText('Operational in this gym')).not.toBeInTheDocument();
  });

  it('reports a failed promotion as a promotion failure, not as an empty library', async () => {
    global.fetch = routes({
      promote: () => jsonResponse({ error: 'This reference drill has already been promoted.' }, false, 409),
    }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    fireEvent.click(within(detail).getByRole('button', { name: 'Promote' }));

    expect(await screen.findByText(/already been promoted/i)).toBeInTheDocument();
    expect(screen.queryByText('No reference drills are available.')).not.toBeInTheDocument();
  });

  it('shows the server\'s own list of what is missing when it refuses a promotion as not ready', async () => {
    const fetchMock = routes({
      promote: () => jsonResponse({
        error: 'This reference drill is not ready to adopt.',
        code: 'NOT_READY_TO_ADOPT',
        missing: ['It has no setup.', 'It has no stop rules.'],
      }, false, 409),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    fireEvent.click(within(detail).getByRole('button', { name: 'Promote' }));

    expect(await screen.findByText('This reference drill is not ready to adopt. It has no setup. It has no stop rules.'))
      .toBeInTheDocument();
    expect(screen.queryByText(/^Promoted\./)).not.toBeInTheDocument();
  });
});

// W-D4C LIFECYCLE: the opened reference offers the one action its state allows.
describe('reference lifecycle', () => {
  it('labels each card with where the drill stands in this gym, and leaves a not-adopted card unlabelled', async () => {
    const references: ReferenceRow[] = [
      reference,
      { ...reference, drill_id: 'reference-2', name: 'Slip and counter' },
      { ...reference, drill_id: 'reference-3', name: 'Sprawl reset' },
      { ...reference, drill_id: 'reference-4', name: 'Heavy bag rounds' },
      { ...reference, drill_id: 'reference-5', name: 'Clinch break' },
      { ...reference, drill_id: 'reference-6', name: 'Pivot out' },
    ];
    global.fetch = routes({
      references,
      lifecycle: {
        'reference-1': NOT_ADOPTED,
        'reference-2': { state: 'operational', operational_drill_id: 'operational-2' },
        'reference-3': { state: 'retired', operational_drill_id: 'operational-3' },
        'reference-4': { state: 'superseded', operational_drill_id: null },
        'reference-5': { state: 'unavailable', operational_drill_id: null },
        // reference-6: no entry at all.
      },
    }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    await screen.findByText('Pivot out');

    const labels = ['Not adopted', 'Operational in this gym', 'Retired in this gym', 'A newer version exists', 'Withdrawn'];
    const expected: Record<string, string | null> = {
      'Seeded jab return': null,
      'Slip and counter': 'Operational in this gym',
      'Sprawl reset': 'Retired in this gym',
      'Heavy bag rounds': 'A newer version exists',
      'Clinch break': 'Withdrawn',
      'Pivot out': null,
    };
    for (const [name, label] of Object.entries(expected)) {
      const shown = labels.filter((candidate) => within(referenceCard(name)).queryByText(candidate));
      expect({ name, shown }).toEqual({ name, shown: label ? [label] : [] });
    }
  });

  it('offers no Promote on a reference that is not ready to adopt, and says what it lacks', async () => {
    const unready = { ...referenceDetail, standard_setup: '  ', stop_rules: [] };
    const fetchMock = routes({ details: { [reference.drill_id]: unready } });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    const heading = within(detail).getByText('Not ready to adopt');
    // The same sentences the promote route would refuse with, in its order.
    expect(within(heading.parentElement as HTMLElement).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'It has no setup.',
      'It has no stop rules.',
    ]);
    expectNoLifecycleAction(detail);
    expect(writes(fetchMock)).toEqual([]);
  });

  it('retires an operational drill by its adopted identity, then shows the reloaded state', async () => {
    const fetchMock = routes({
      operational: [authored, promoted],
      lifecycle: { [reference.drill_id]: { state: 'operational', operational_drill_id: OPERATIONAL_HEAD } },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    expect(within(detail).getByText('Operational in this gym')).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'Promote' })).not.toBeInTheDocument();
    const retire = within(detail).getByRole('button', { name: 'Retire' });
    expect(retire).toHaveAttribute('id', 'lifecycle-reference-1');

    const libraryReads = readsOf(fetchMock, '/api/pilot/drill-library');
    const operationalReads = readsOf(fetchMock, '/api/pilot/drills');
    fireEvent.click(retire);

    const notice = await screen.findByText(/^Retired\./);
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveTextContent('Assigned work that is still open keeps its instructions.');
    // Exactly one write: the drills route's PATCH, on the lineage head the
    // server named -- not the reference id, not a row the page listed.
    expect(writes(fetchMock)).toEqual([
      { method: 'PATCH', url: '/api/pilot/drills', body: { drill_id: OPERATIONAL_HEAD, active: false } },
    ]);
    // Both lists were read again, and the new state is the server's answer.
    expect(readsOf(fetchMock, '/api/pilot/drill-library')).toBe(libraryReads + 1);
    expect(readsOf(fetchMock, '/api/pilot/drills')).toBe(operationalReads + 1);
    expect(within(detail).getByText('Retired in this gym')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Restore' })).toBeEnabled();
    expect(within(detail).queryByRole('button', { name: 'Retire' })).not.toBeInTheDocument();
  });

  it('restores a retired drill as the same identity, then shows it operational again', async () => {
    const fetchMock = routes({
      lifecycle: { [reference.drill_id]: { state: 'retired', operational_drill_id: OPERATIONAL_HEAD } },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    expect(within(detail).getByText('Retired in this gym')).toBeInTheDocument();
    // Promoting again after a retirement is refused; Restore is the way back.
    expect(within(detail).queryByRole('button', { name: 'Promote' })).not.toBeInTheDocument();
    const restore = within(detail).getByRole('button', { name: 'Restore' });
    expect(restore).toHaveAttribute('id', 'lifecycle-reference-1');

    const libraryReads = readsOf(fetchMock, '/api/pilot/drill-library');
    fireEvent.click(restore);

    const notice = await screen.findByText(/^Restored\./);
    expect(notice).toHaveAttribute('role', 'status');
    expect(writes(fetchMock)).toEqual([
      { method: 'PATCH', url: '/api/pilot/drills', body: { drill_id: OPERATIONAL_HEAD, active: true } },
    ]);
    expect(readsOf(fetchMock, '/api/pilot/drill-library')).toBe(libraryReads + 1);
    expect(within(detail).getByText('Operational in this gym')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Retire' })).toBeEnabled();
  });

  it.each([
    ['reference_withdrawn', "This drill's reference has been withdrawn, so it cannot be restored.", true],
    ['another_version_active', 'Another version of this drill is already active.', false],
  ] as const)('shows a refused restore (%s) as the server words it, reads the drill again, and offers what it then allows', async (code, refusal, withdrawnMeanwhile) => {
    // The reference may have been withdrawn after the drill was opened: the
    // detail the page read then is stale, and only reading it again shows it.
    const liveDetail: Record<string, unknown> = { ...referenceDetail };
    const fetchMock = routes({
      details: { [reference.drill_id]: liveDetail },
      lifecycle: { [reference.drill_id]: { state: 'retired', operational_drill_id: OPERATIONAL_HEAD } },
      patch: () => {
        if (withdrawnMeanwhile) liveDetail.active = false;
        return jsonResponse({ error: refusal, code }, false, 409);
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    const libraryReads = readsOf(fetchMock, '/api/pilot/drill-library');
    const detailReads = readsOf(fetchMock, DETAIL_URL);

    fireEvent.click(within(detail).getByRole('button', { name: 'Restore' }));

    const alert = await screen.findByRole('alert');
    // Shown only once the re-read has settled: the list and the drill were
    // both read again, once each, before the alert said so.
    expect(readsOf(fetchMock, '/api/pilot/drill-library')).toBe(libraryReads + 1);
    expect(readsOf(fetchMock, DETAIL_URL)).toBe(detailReads + 1);
    expect(within(alert).getByText(refusal)).toBeInTheDocument();
    expect(within(alert).getByText(CONFLICT_REREAD)).toBeInTheDocument();
    expect(screen.queryByText(/^Restored\./)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Retired\./)).not.toBeInTheDocument();
    expect(within(detail).getByText('Retired in this gym')).toBeInTheDocument();
    if (withdrawnMeanwhile) {
      // The page's own rule, from the fresh detail: no Restore, and why.
      expect(await within(detail).findByText(CANNOT_RESTORE)).toBeInTheDocument();
      expectNoLifecycleAction(detail);
      expect(within(detail).queryByText(RESTORE_CONSEQUENCE)).not.toBeInTheDocument();
    } else {
      await waitFor(() => expect(within(detail).getByRole('button', { name: 'Restore' })).toBeEnabled());
      expect(within(detail).queryByText(CANNOT_RESTORE)).not.toBeInTheDocument();
    }
    expect(writes(fetchMock)).toHaveLength(1);
  });

  it('explains a name-collision refusal of Promote without claiming the drill changed', async () => {
    const refusal = 'This gym already has a drill named "Seeded jab return".';
    const fetchMock = routes({ promote: () => jsonResponse({ error: refusal }, false, 409) });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    fireEvent.click(within(detail).getByRole('button', { name: 'Promote' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(refusal)).toBeInTheDocument();
    expect(within(alert).getByText(CONFLICT_REREAD)).toBeInTheDocument();
    // Nothing about this drill changed anywhere: the alert must not say so.
    expect(alert.textContent).not.toMatch(/changed elsewhere|out of date/);
    // The same drill, the same state, the same action: what is true.
    await waitFor(() => expect(within(detail).getByRole('button', { name: 'Promote' })).toBeEnabled());
    expect(writes(fetchMock)).toHaveLength(1);
  });

  it('shows what a refused Promote was missing when the re-read drill is no longer ready to adopt', async () => {
    const liveDetail: Record<string, unknown> = { ...referenceDetail };
    const fetchMock = routes({
      details: { [reference.drill_id]: liveDetail },
      promote: () => {
        liveDetail.stop_rules = [];
        return jsonResponse({ error: 'This reference drill is not ready to adopt.', code: 'NOT_READY_TO_ADOPT', missing: ['It has no stop rules.'] }, false, 409);
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    fireEvent.click(within(detail).getByRole('button', { name: 'Promote' }));

    await screen.findByRole('alert');
    // From the fresh detail: the not-ready list, and no Promote to press again.
    expect(await within(detail).findByText('Not ready to adopt')).toBeInTheDocument();
    expect(within(detail).getByText('It has no stop rules.')).toBeInTheDocument();
    expectNoLifecycleAction(detail);
    expect(writes(fetchMock)).toHaveLength(1);
  });

  it('shows the alert only once the re-read after a 409 has answered', async () => {
    let answerReread: (response: Response) => void = () => {};
    const heldReread = new Promise<Response>((resolve) => { answerReread = resolve; });
    const fetchMock = routes({
      lifecycle: { [reference.drill_id]: operationalAt(OPERATIONAL_HEAD) },
      patch: () => jsonResponse({ error: 'The server refused this change.' }, false, 409),
      // The re-read after the refusal is held open until the test answers it.
      libraryRead: (readNumber) => (readNumber > 1 ? (heldReread as unknown as Response) : undefined),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    fireEvent.click(within(detail).getByRole('button', { name: 'Retire' }));

    // The re-read is in flight: no alert describes it yet, and the action is
    // still saving.
    await waitFor(() => expect(readsOf(fetchMock, '/api/pilot/drill-library')).toBe(2));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Saving...' })).toBeDisabled();

    await act(async () => {
      answerReread(jsonResponse({ drills: [reference], lifecycle: { [reference.drill_id]: operationalAt(OPERATIONAL_HEAD) } }));
    });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(CONFLICT_REREAD)).toBeInTheDocument();
    await waitFor(() => expect(within(detail).getByRole('button', { name: 'Retire' })).toBeEnabled());
  });

  it('says the status could not be read again when the re-read after a 409 fails', async () => {
    const fetchMock = routes({
      lifecycle: { [reference.drill_id]: operationalAt(OPERATIONAL_HEAD) },
      patch: () => jsonResponse({ error: 'The server refused this change.' }, false, 409),
      libraryRead: (readNumber) => (readNumber > 1 ? jsonResponse({ error: 'unavailable' }, false, 503) : undefined),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    const detailReads = readsOf(fetchMock, DETAIL_URL);
    fireEvent.click(within(detail).getByRole('button', { name: 'Retire' }));

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(REREAD_FAILED)).toBeInTheDocument();
    expect(within(alert).queryByText(CONFLICT_REREAD)).not.toBeInTheDocument();
    // Nothing current to offer, and the drill is not read on a failed list.
    expect(await within(detail).findByText(STATUS_UNREAD)).toBeInTheDocument();
    expectNoLifecycleAction(detail);
    expect(readsOf(fetchMock, DETAIL_URL)).toBe(detailReads);
    expect(writes(fetchMock)).toHaveLength(1);
  });

  it.each([
    ['superseded', 'A newer version exists', { superseded_at: '2026-09-18T00:00:00.000Z' }],
    ['unavailable', 'Withdrawn', { active: false }],
  ] as const)('shows the %s state as its label and no action', async (state, label, detailOverrides) => {
    const fetchMock = routes({
      details: { [reference.drill_id]: { ...referenceDetail, ...detailOverrides } },
      lifecycle: { [reference.drill_id]: { state, operational_drill_id: null } },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    expect(within(detail).getByText(label)).toBeInTheDocument();
    expectNoLifecycleAction(detail);
    // A label, not the readiness verdict: readiness decides only between
    // Promote and not-ready for a drill that could be adopted at all.
    expect(within(detail).queryByText('Not ready to adopt')).not.toBeInTheDocument();
    expect(writes(fetchMock)).toEqual([]);
  });

  it('offers no Retire or Restore when the server names no operational drill to act on', async () => {
    global.fetch = routes({
      lifecycle: { [reference.drill_id]: { state: 'operational', operational_drill_id: null } },
    }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    expect(within(detail).getByText('Operational in this gym')).toBeInTheDocument();
    expectNoLifecycleAction(detail);
  });

  it.each([
    ['the list carries no lifecycle at all', null],
    ['the lifecycle has no entry for this drill', {}],
  ] as const)('says the status could not be read, and offers no action, when %s', async (_case, lifecycle) => {
    global.fetch = routes({ lifecycle }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    await screen.findByText('Corner exit');
    expect(within(referenceCard('Seeded jab return')).queryByText(/in this gym|Not adopted|Withdrawn|newer version/))
      .not.toBeInTheDocument();

    const detail = await openReference();

    // The census this replaced fell back to "never adopted" and offered
    // Promote on references the server would refuse.
    expect(within(detail).getByText("This drill's status in this gym could not be read.")).toBeInTheDocument();
    expectNoLifecycleAction(detail);
  });
});

// W-D4C repair: the opened drill acts on the freshest status the page has, and
// on none at all rather than a stale one.
describe('the opened drill\'s status', () => {
  it('takes the status its own detail read carries over the older list entry', async () => {
    // The list was read while the drill was not adopted; another coach promoted
    // it before this one opened it, so the detail -- read later -- says so.
    const fetchMock = routes({
      lifecycle: { [reference.drill_id]: NOT_ADOPTED },
      changedBeforeDetail: { [reference.drill_id]: operationalAt(OPERATIONAL_HEAD) },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    await screen.findByText('Corner exit');
    // The list's answer, on the card: not adopted, so unlabelled.
    expect(within(referenceCard('Seeded jab return')).queryByText('Operational in this gym')).not.toBeInTheDocument();

    const detail = await openReference();

    expect(within(detail).getByText('Operational in this gym')).toBeInTheDocument();
    // Promote here would be refused by the server: the drill is already adopted.
    expect(within(detail).queryByRole('button', { name: 'Promote' })).not.toBeInTheDocument();
    const retire = within(detail).getByRole('button', { name: 'Retire' });
    expect(retire).toHaveAttribute('id', 'lifecycle-reference-1');

    // And the action acts on the identity the detail named.
    fireEvent.click(retire);
    await screen.findByText(/^Retired\./);
    expect(writes(fetchMock)).toEqual([
      { method: 'PATCH', url: '/api/pilot/drills', body: { drill_id: OPERATIONAL_HEAD, active: false } },
    ]);
    expect(await within(detail).findByRole('button', { name: 'Restore' })).toBeEnabled();
  });

  it('keeps the list entry when the detail carries no status of its own', async () => {
    global.fetch = routes({
      lifecycle: { [reference.drill_id]: operationalAt(OPERATIONAL_HEAD) },
      detailWithoutLifecycle: true,
    }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    expect(within(detail).getByText('Operational in this gym')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Retire' })).toBeEnabled();
    expect(within(detail).queryByText(STATUS_UNREAD)).not.toBeInTheDocument();
  });

  it.each([
    ['succeeds', undefined, /^Retired\./],
    ['fails with a server fault', () => jsonResponse({ error: 'The server could not finish this change.' }, false, 500), UNKNOWN_UNREAD],
  ] as const)('stops offering an action when the library cannot be read again after a Retire that %s', async (_case, patch, shown) => {
    const fetchMock = routes({
      operational: [authored, promoted],
      lifecycle: { [reference.drill_id]: operationalAt(OPERATIONAL_HEAD) },
      patch,
      // The first list read (on load) succeeds; every one after it fails.
      libraryRead: (readNumber) => (readNumber > 1 ? jsonResponse({ error: 'unavailable' }, false, 503) : undefined),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    expect(within(detail).getByRole('button', { name: 'Retire' })).toBeEnabled();

    fireEvent.click(within(detail).getByRole('button', { name: 'Retire' }));

    await screen.findByText(shown);
    // The status read before the change is no longer shown as current: it
    // would keep offering the action from before it. Nothing is offered.
    expect(await within(detail).findByText(STATUS_UNREAD)).toBeInTheDocument();
    expectNoLifecycleAction(detail);
    expect(within(detail).queryByText('Operational in this gym')).not.toBeInTheDocument();
    expect(within(detail).queryByText(RETIRE_CONSEQUENCE)).not.toBeInTheDocument();
    expect(screen.getByText('The reference drill library could not be loaded.')).toBeInTheDocument();
    expect(readsOf(fetchMock, '/api/pilot/drill-library')).toBe(2);
    // The one PATCH, never retried.
    expect(writes(fetchMock)).toHaveLength(1);
  });
});

// W-D4C repair: what an action does is said before it is taken, and the page
// never offers or promises an action the server would refuse.
describe('before a lifecycle action', () => {
  it.each([
    ['Retire', 'operational', RETIRE_CONSEQUENCE, RESTORE_CONSEQUENCE],
    ['Restore', 'retired', RESTORE_CONSEQUENCE, RETIRE_CONSEQUENCE],
  ] as const)('says beside %s what it will do, before anything is pressed', async (action, state, line, otherLine) => {
    const fetchMock = routes({
      lifecycle: { [reference.drill_id]: { state, operational_drill_id: OPERATIONAL_HEAD } },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    const button = within(detail).getByRole('button', { name: action });
    const consequence = within(detail).getByText(line);
    // Beside the button it describes: the same row of actions.
    expect(consequence.parentElement).toBe(button.parentElement);
    expect(within(detail).queryByText(otherLine)).not.toBeInTheDocument();
    expect(writes(fetchMock)).toEqual([]);
  });

  it('says neither consequence beside Promote', async () => {
    global.fetch = routes() as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    expect(within(detail).getByRole('button', { name: 'Promote' })).toBeEnabled();
    expect(within(detail).queryByText(RETIRE_CONSEQUENCE)).not.toBeInTheDocument();
    expect(within(detail).queryByText(RESTORE_CONSEQUENCE)).not.toBeInTheDocument();
  });

  it('offers no Restore when the retired drill\'s reference has been withdrawn, and says why', async () => {
    const fetchMock = routes({
      details: { [reference.drill_id]: { ...referenceDetail, active: false } },
      lifecycle: { [reference.drill_id]: retiredAt(OPERATIONAL_HEAD) },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    // Still retired in this gym -- that is what it is -- but it cannot come back.
    expect(within(detail).getByText('Retired in this gym')).toBeInTheDocument();
    expect(within(detail).getByText(CANNOT_RESTORE)).toBeInTheDocument();
    expectNoLifecycleAction(detail);
    expect(within(detail).queryByText(RESTORE_CONSEQUENCE)).not.toBeInTheDocument();
    expect(writes(fetchMock)).toEqual([]);
  });

  it('says what Retire does when the adopted drill\'s reference has been withdrawn', async () => {
    const fetchMock = routes({
      details: { [reference.drill_id]: { ...referenceDetail, active: false } },
      lifecycle: { [reference.drill_id]: operationalAt(OPERATIONAL_HEAD) },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    // Athletes already read nothing of a withdrawn reference, so the usual
    // consequence (out of Learn, open work keeps it) would be false.
    const retire = within(detail).getByRole('button', { name: 'Retire' });
    const consequence = within(detail).getByText(RETIRE_WITHDRAWN_CONSEQUENCE);
    expect(consequence.parentElement).toBe(retire.parentElement);
    expect(within(detail).queryByText(RETIRE_CONSEQUENCE)).not.toBeInTheDocument();
    expect(writes(fetchMock)).toEqual([]);
  });

  it.each([
    ['is still in the reference library', true, `${RETIRED_NOTICE}${RESTORE_PROMISE}`],
    ['has been withdrawn', false, RETIRED_WITHDRAWN_NOTICE],
  ] as const)('promises Restore after a Retire only when the reference %s', async (_case, active, expected) => {
    global.fetch = routes({
      details: { [reference.drill_id]: { ...referenceDetail, active } },
      lifecycle: { [reference.drill_id]: operationalAt(OPERATIONAL_HEAD) },
    }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    fireEvent.click(within(detail).getByRole('button', { name: 'Retire' }));

    const notice = await screen.findByText(/^Retired\./);
    expect(notice.textContent).toBe(expected);
    expect(notice).toHaveAttribute('role', 'status');
    // What the page then offers agrees with what the notice promised.
    if (active) {
      expect(await within(detail).findByRole('button', { name: 'Restore' })).toBeEnabled();
      expect(within(detail).queryByText(CANNOT_RESTORE)).not.toBeInTheDocument();
    } else {
      expect(await within(detail).findByText(CANNOT_RESTORE)).toBeInTheDocument();
      expectNoLifecycleAction(detail);
    }
  });
});

// W-D4C repair: after a lifecycle action, where focus goes and what the coach
// is told about an outcome the page cannot know.
describe('after a lifecycle action', () => {
  it.each([
    ['Promote', NOT_ADOPTED, /^Promoted\./, 'Retire'],
    ['Retire', operationalAt(OPERATIONAL_HEAD), /^Retired\./, 'Restore'],
    ['Restore', retiredAt(OPERATIONAL_HEAD), /^Restored\./, 'Retire'],
  ] as const)('moves focus to the drill\'s lifecycle control on the next frame after a successful %s', async (action, state, notice, next) => {
    const frames = holdAnimationFrames();
    global.fetch = routes({ lifecycle: { [reference.drill_id]: state } }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    frames.run();

    fireEvent.click(within(detail).getByRole('button', { name: action }));
    await screen.findByText(notice);
    const control = await within(detail).findByRole('button', { name: next });
    await waitFor(() => expect(control).toBeEnabled());
    expect(control).toHaveAttribute('id', 'lifecycle-reference-1');

    // Not before the frame: the control was just re-rendered under its id.
    expect(document.activeElement).not.toBe(control);
    expect(frames.run()).toBeGreaterThan(0);
    expect(document.activeElement).toBe(control);
  });

  it.each([
    ['Promote', NOT_ADOPTED],
    ['Retire', operationalAt(OPERATIONAL_HEAD)],
    ['Restore', retiredAt(OPERATIONAL_HEAD)],
  ] as const)('returns focus to the %s control on the next frame when it is refused', async (action, state) => {
    const frames = holdAnimationFrames();
    global.fetch = routes({
      lifecycle: { [reference.drill_id]: state },
      promote: () => jsonResponse({ error: 'Refused.' }, false, 403),
      patch: () => jsonResponse({ error: 'Refused.' }, false, 403),
    }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    frames.run();

    fireEvent.click(within(detail).getByRole('button', { name: action }));
    await screen.findByRole('alert');
    const control = within(detail).getByRole('button', { name: action });
    await waitFor(() => expect(control).toBeEnabled());
    expect(control).toHaveAttribute('id', 'lifecycle-reference-1');

    // Not before the frame, and not to the page body after it.
    expect(document.activeElement).not.toBe(control);
    await waitFor(() => expect(frames.run()).toBeGreaterThan(0));
    expect(document.activeElement).toBe(control);
  });

  it('leaves focus where the coach moved it while the action was saving', async () => {
    const frames = holdAnimationFrames();
    global.fetch = routes({ lifecycle: { [reference.drill_id]: operationalAt(OPERATIONAL_HEAD) } }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    frames.run();

    fireEvent.click(within(detail).getByRole('button', { name: 'Retire' }));
    // Before the answer: the coach goes to the Create a gym drill form and types.
    const nameField = screen.getByLabelText('Name') as HTMLInputElement;
    nameField.focus();
    await screen.findByText(/^Retired\./);
    await waitFor(() => expect(within(detail).getByRole('button', { name: 'Restore' })).toBeEnabled());

    await waitFor(() => expect(frames.run()).toBeGreaterThan(0));
    expect(document.activeElement).toBe(nameField);
  });

  it('moves focus to the drill\'s heading when the new state offers no action', async () => {
    const frames = holdAnimationFrames();
    global.fetch = routes({
      details: { [reference.drill_id]: { ...referenceDetail, active: false } },
      lifecycle: { [reference.drill_id]: operationalAt(OPERATIONAL_HEAD) },
    }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    frames.run();

    // Retiring a drill whose reference was withdrawn leaves nothing to press.
    // Focus is on the button, as a real click or keypress leaves it.
    const retire = within(detail).getByRole('button', { name: 'Retire' });
    retire.focus();
    expect(document.activeElement).toBe(retire);
    fireEvent.click(retire);
    expect(await within(detail).findByText(CANNOT_RESTORE)).toBeInTheDocument();
    expectNoLifecycleAction(detail);
    // The button it was on is gone; until the frame, focus is nowhere useful.
    expect(document.activeElement).not.toBe(within(detail).getByRole('heading', { name: 'Seeded jab return' }));

    await waitFor(() => expect(frames.run()).toBeGreaterThan(0));
    expect(document.activeElement).toBe(within(detail).getByRole('heading', { name: 'Seeded jab return' }));
  });

  const ACTIONS = [
    ['Promote', NOT_ADOPTED],
    ['Retire', operationalAt(OPERATIONAL_HEAD)],
    ['Restore', retiredAt(OPERATIONAL_HEAD)],
  ] as const;
  const FAILURES = [
    ['a 500', () => jsonResponse({ error: 'The server could not finish this change.' }, false, 500), 'The server could not finish this change.', 'unknown'],
    ['a 503', () => jsonResponse({ error: 'The server is unavailable.' }, false, 503), 'The server is unavailable.', 'unknown'],
    ['a dropped connection', () => { throw new TypeError('Failed to fetch'); }, 'Failed to fetch', 'unknown'],
    ['a 409 conflict', () => jsonResponse({ error: 'The server refused this change.' }, false, 409), 'The server refused this change.', 'conflict'],
    ['a 403 refusal', () => jsonResponse({ error: 'You cannot change this drill.' }, false, 403), 'You cannot change this drill.', 'refused'],
  ] as const;
  const CASES = ACTIONS.flatMap(([action, state]) =>
    FAILURES.map(([failure, answer, message, outcome]) => [action, failure, state, answer, message, outcome] as const));
  // Every explanation the page has; exactly the expected one may appear.
  const OUTCOME_TEXT = {
    unknown: OUTCOME_UNKNOWN,
    conflict: CONFLICT_REREAD,
    refused: NOTHING_CHANGED,
    reread_failed: REREAD_FAILED,
    unknown_unread: UNKNOWN_UNREAD,
  } as const;

  it.each(CASES)('when %s fails with %s, says what is known about it', async (action, _failure, state, answer, message, outcome) => {
    const fetchMock = routes({
      operational: [authored, promoted],
      lifecycle: { [reference.drill_id]: state },
      promote: answer,
      patch: answer,
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    const libraryReads = readsOf(fetchMock, '/api/pilot/drill-library');
    const operationalReads = readsOf(fetchMock, '/api/pilot/drills');

    fireEvent.click(within(detail).getByRole('button', { name: action }));

    // Settled: the action's own button is back, which it is only once every
    // read the failure started has finished.
    expect(await within(detail).findByRole('button', { name: action })).toBeEnabled();

    // One alert, announced: the server's words, then what they mean.
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(message)).toBeInTheDocument();
    // Exactly one of the page's explanations, and none of the others.
    for (const [kind, text] of Object.entries(OUTCOME_TEXT)) {
      if (kind === outcome) expect(within(alert).getByText(text)).toBeInTheDocument();
      else expect(within(alert).queryByText(text)).not.toBeInTheDocument();
    }
    if (outcome === 'refused') {
      // A plain refusal changed nothing and left the page current: no reads.
      expect(readsOf(fetchMock, '/api/pilot/drill-library')).toBe(libraryReads);
      expect(readsOf(fetchMock, '/api/pilot/drills')).toBe(operationalReads);
    } else {
      // Unknown or out of date: both lists were read again, once each, as the alert says.
      await waitFor(() => expect(readsOf(fetchMock, '/api/pilot/drill-library')).toBe(libraryReads + 1));
      expect(readsOf(fetchMock, '/api/pilot/drills')).toBe(operationalReads + 1);
    }
    expect(screen.queryByText(/^(Promoted|Retired|Restored)\./)).not.toBeInTheDocument();
    expect(writes(fetchMock)).toHaveLength(1);
  });

  it.each([
    ['Promote', NOT_ADOPTED, 'Operational in this gym', 'Retire'],
    ['Retire', operationalAt(OPERATIONAL_HEAD), 'Retired in this gym', 'Restore'],
  ] as const)('shows what the server saved when a %s landed but its answer was lost', async (action, state, label, next) => {
    const fetchMock = routes({
      operational: [authored],
      lifecycle: { [reference.drill_id]: state },
      answerAfterCommit: () => { throw new TypeError('Failed to fetch'); },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    fireEvent.click(within(detail).getByRole('button', { name: action }));

    expect(await screen.findByText(OUTCOME_UNKNOWN)).toBeInTheDocument();
    // The re-read is what shows the change that did land.
    expect(await within(detail).findByText(label)).toBeInTheDocument();
    expect(await within(detail).findByRole('button', { name: next })).toBeEnabled();
    expect(within(detail).queryByRole('button', { name: action })).not.toBeInTheDocument();
  });
});

// W-D4C DISCOVERY: name search and filters on durable, structured fields only.
describe('reference discovery', () => {
  // Each filter below selects a DIFFERENT set of these drills, so a filter
  // reading any field but its own shows the wrong cards. Purposes carry the
  // filter and search words ("jab", "boxing", "defense") on drills whose own
  // fields do not, so prose matching shows up as well.
  const discoveryReferences: ReferenceRow[] = [
    {
      ...reference,
      requires_coach_authorization: false,
    },
    {
      ...reference,
      drill_id: 'reference-2',
      name: 'Slip and counter',
      discipline: 'boxing',
      category: 'defense',
      difficulty: 'intermediate',
      purpose: 'Slip the jab and counter over it.',
      contact_level: 'none',
      requires_coach_authorization: true,
    },
    {
      ...reference,
      drill_id: 'reference-3',
      name: 'Sprawl reset',
      discipline: 'wrestling',
      category: 'defense',
      difficulty: 'fundamentals',
      purpose: 'Defend the shot and reset to a boxing stance.',
      contact_level: 'conditioned',
      requires_coach_authorization: false,
    },
    {
      ...reference,
      drill_id: 'reference-4',
      name: 'Heavy bag rounds',
      discipline: 'conditioning',
      category: 'conditioning',
      difficulty: 'advanced',
      purpose: 'Rounds that hold defense together under fatigue.',
      contact_level: 'light_technical',
      requires_coach_authorization: true,
    },
  ];
  const discoveryLifecycle: LifecycleMap = {
    'reference-1': NOT_ADOPTED,
    'reference-2': { state: 'operational', operational_drill_id: 'operational-2' },
    'reference-3': { state: 'retired', operational_drill_id: 'operational-3' },
    'reference-4': { state: 'superseded', operational_drill_id: null },
    // The server derives a state for every reference in the gym, including a
    // withdrawn one the list leaves out. It is not listed, so it is not an option.
    'reference-9': { state: 'unavailable', operational_drill_id: null },
  };
  const ALL = ['Seeded jab return', 'Slip and counter', 'Sprawl reset', 'Heavy bag rounds'];

  async function renderDiscovery(options: RouteOptions = {}) {
    const fetchMock = routes({
      operational: [authored, promoted],
      references: discoveryReferences,
      details: Object.fromEntries(
        discoveryReferences.map((row) => [row.drill_id, { ...referenceDetail, ...row, lineage_id: row.drill_id }]),
      ),
      lifecycle: discoveryLifecycle,
      ...options,
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CoachDrillLibraryPage />);
    await screen.findByText('Heavy bag rounds');
    return fetchMock;
  }

  it('lists every reference drill and says how many it is showing', async () => {
    await renderDiscovery();

    expect(listedReferenceNames()).toEqual(ALL);
    expect(screen.getByText('Showing 4 of 4 reference drills')).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search by name' })).toHaveValue('');
  });

  it('searches names case-insensitively, and never matches purpose text', async () => {
    await renderDiscovery();
    const search = screen.getByRole('searchbox', { name: 'Search by name' });

    // "Slip and counter" says "jab" in its purpose; only the NAME counts.
    fireEvent.change(search, { target: { value: 'JAB' } });
    expect(listedReferenceNames()).toEqual(['Seeded jab return']);
    expect(screen.getByText('Showing 1 of 4 reference drills')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: '  sPrAwL ' } });
    expect(listedReferenceNames()).toEqual(['Sprawl reset']);

    // A word only a purpose carries matches nothing.
    fireEvent.change(search, { target: { value: 'fatigue' } });
    expect(listedReferenceNames()).toEqual([]);
    expect(screen.getByText('Showing 0 of 4 reference drills')).toBeInTheDocument();
  });

  it.each([
    ['Discipline', 'boxing', ['Seeded jab return', 'Slip and counter']],
    ['Category', 'defense', ['Slip and counter', 'Sprawl reset']],
    ['Difficulty', 'fundamentals', ['Seeded jab return', 'Sprawl reset']],
    ['Contact', 'light_technical', ['Seeded jab return', 'Heavy bag rounds']],
    ['Coach authorization', 'required', ['Slip and counter', 'Heavy bag rounds']],
    ['In this gym', 'retired', ['Sprawl reset']],
  ])('narrows by %s = %s on that field alone', async (label, value, expected) => {
    await renderDiscovery();

    fireEvent.change(filterSelect(label), { target: { value } });

    expect(filterSelect(label)).toHaveValue(value);
    expect(listedReferenceNames()).toEqual(expected);
    expect(screen.getByText(`Showing ${expected.length} of 4 reference drills`)).toHaveAttribute('role', 'status');
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });

  it('combines the search with the filters', async () => {
    await renderDiscovery();

    fireEvent.change(filterSelect('Discipline'), { target: { value: 'boxing' } });
    fireEvent.change(filterSelect('Category'), { target: { value: 'defense' } });
    expect(listedReferenceNames()).toEqual(['Slip and counter']);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search by name' }), { target: { value: 'jab' } });
    expect(listedReferenceNames()).toEqual([]);
  });

  it('offers only the values the listed drills actually have', async () => {
    await renderDiscovery();

    expect(optionTexts(filterSelect('Discipline'))).toEqual(['Any', 'boxing', 'conditioning', 'wrestling']);
    expect(optionTexts(filterSelect('Category'))).toEqual(['Any', 'conditioning', 'defense', 'striking']);
    expect(optionTexts(filterSelect('Difficulty'))).toEqual(['Any', 'advanced', 'fundamentals', 'intermediate']);
    expect(optionTexts(filterSelect('Contact'))).toEqual(['Any', 'Conditioned contact', 'Light technical contact', 'No contact']);
    expect(optionTexts(filterSelect('Coach authorization'))).toEqual(['Any', 'Not required', 'Required']);
    // No "Withdrawn": the only withdrawn reference is not in the list.
    expect(optionTexts(filterSelect('In this gym'))).toEqual([
      'Any',
      'Not adopted',
      'Operational in this gym',
      'Retired in this gym',
      'A newer version exists',
    ]);
  });

  it('clears the search and every filter at once', async () => {
    await renderDiscovery();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search by name' }), { target: { value: 'slip' } });
    fireEvent.change(filterSelect('Discipline'), { target: { value: 'boxing' } });
    fireEvent.change(filterSelect('In this gym'), { target: { value: 'operational' } });
    expect(listedReferenceNames()).toEqual(['Slip and counter']);

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(listedReferenceNames()).toEqual(ALL);
    expect(screen.getByText('Showing 4 of 4 reference drills')).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search by name' })).toHaveValue('');
    for (const label of ['Discipline', 'Category', 'Difficulty', 'Contact', 'Coach authorization', 'In this gym']) {
      expect(filterSelect(label)).toHaveValue('');
    }
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('puts focus in the search box when the filters are cleared, not on the page body', async () => {
    await renderDiscovery();
    const search = screen.getByRole('searchbox', { name: 'Search by name' });
    fireEvent.change(search, { target: { value: 'slip' } });
    fireEvent.change(filterSelect('Discipline'), { target: { value: 'boxing' } });

    // Where focus is as the button is pressed, by keyboard or pointer.
    const clear = screen.getByRole('button', { name: 'Clear filters' });
    clear.focus();
    expect(document.activeElement).toBe(clear);

    fireEvent.click(clear);

    // The button that held focus is gone with the filters it cleared.
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(search);
    expect(search).toHaveValue('');
  });

  it('says when nothing matches, and does not call the library empty', async () => {
    await renderDiscovery();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search by name' }), { target: { value: 'guard' } });

    expect(screen.getByText('No reference drills match this search and these filters.')).toBeInTheDocument();
    expect(screen.getByText('Showing 0 of 4 reference drills')).toBeInTheDocument();
    expect(listedReferenceNames()).toEqual([]);
    expect(screen.queryByText('No reference drills are available.')).not.toBeInTheDocument();
  });

  it('hides the search and filters while a drill is open, and brings them back', async () => {
    await renderDiscovery();
    // Filter down to nothing, then open a drill from its operational card.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search by name' }), { target: { value: 'zzz' } });
    expect(screen.getByText('No reference drills match this search and these filters.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'View instructions: Seeded jab return' }));
    await screen.findByRole('article', { name: 'Seeded jab return' });

    // jsdom loads no CSS, so visibility is asserted on the class that hides it.
    expect(discoveryPanel().classList.contains('hidden')).toBe(true);
    expect(screen.queryByText('No reference drills match this search and these filters.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back to the reference library' }));

    expect(discoveryPanel().classList.contains('hidden')).toBe(false);
    expect(screen.getByRole('searchbox', { name: 'Search by name' })).toHaveValue('zzz');
  });

  it('writes nothing, and reads nothing new, while opening, searching and filtering', async () => {
    const fetchMock = await renderDiscovery();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search by name' }), { target: { value: 'slip' } });
    for (const [label, value] of [
      ['Discipline', 'boxing'],
      ['Category', 'defense'],
      ['Difficulty', 'intermediate'],
      ['Contact', 'none'],
      ['Coach authorization', 'required'],
      ['In this gym', 'operational'],
    ]) {
      fireEvent.change(filterSelect(label), { target: { value } });
    }
    expect(listedReferenceNames()).toEqual(['Slip and counter']);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await openReference('Slip and counter');
    fireEvent.click(screen.getByRole('button', { name: 'Back to the reference library' }));
    await openReference('Sprawl reset');

    expect(writes(fetchMock)).toEqual([]);
    // Filtering narrows the list the server already sent; it is not a query.
    expect(readsOf(fetchMock, '/api/pilot/drill-library')).toBe(1);
    expect(readsOf(fetchMock, '/api/pilot/drills')).toBe(1);
  });
});

// The cabinet redesign (2026-09-20): the page reads in the order a coach
// works. It used to open on the create form, ahead of the library.
describe('the page order', () => {
  it('reads reference library, then the gym\'s own drills, then creating one', async () => {
    global.fetch = routes({ operational: [authored, promoted] }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    await screen.findByText('Corner exit');

    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Reference library',
      'In this gym',
      'Create a gym drill',
    ]);
    // The whole create form -- every field and its button -- comes after the
    // gym's drills, not before the library.
    const gymDrills = screen.getByRole('heading', { name: 'In this gym' });
    const form = ['drill-name', 'drill-category', 'drill-focus', 'drill-cues', 'drill-difficulty']
      .map((id) => document.getElementById(id) as HTMLElement);
    for (const control of [...form, screen.getByRole('button', { name: 'Add drill' })]) {
      expect(gymDrills.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // Each part is a named region holding its own controls.
    const library = screen.getByRole('region', { name: 'Reference library' });
    expect(library).toContainElement(screen.getByRole('searchbox', { name: 'Search by name' }));
    expect(library).toContainElement(screen.getByRole('button', { name: 'View drill: Seeded jab return' }));
    expect(screen.getByRole('region', { name: 'In this gym' }))
      .toContainElement(screen.getByRole('button', { name: 'View instructions: Seeded jab return' }));
    expect(screen.getByRole('region', { name: 'Create a gym drill' }))
      .toContainElement(screen.getByRole('button', { name: 'Add drill' }));
  });

  it('says adopting is not assigning in a sentence of its own, not the tail of a paragraph', async () => {
    global.fetch = routes() as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    await screen.findByText('Corner exit');

    // An exact-text match finds only an element whose own text is the sentence.
    expect(screen.getByText('Promoting does not assign the drill to any athlete.')).toBeInTheDocument();
  });

  it('points an empty gym at the create form below it, where the form now is', async () => {
    global.fetch = routes({ operational: [] }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);

    expect(await screen.findByText(/^Nothing yet\. Promote a drill from the reference library, or create one below;/))
      .toBeInTheDocument();
  });
});

// "Gym-authored" was false for every promoted drill (OD-2026-09-19-001).
describe('the in-this-gym section', () => {
  it('is called In this gym and stamps where each drill came from', async () => {
    global.fetch = routes({ operational: [authored, promoted] }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    await screen.findByText('Corner exit');

    expect(screen.getByRole('heading', { name: 'In this gym' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Operational drills' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Gym-authored/i)).not.toBeInTheDocument();

    const written = screen.getByRole('heading', { name: 'Corner exit' }).closest('article') as HTMLElement;
    expect(within(written).getByText('Footwork')).toBeInTheDocument();
    expect(within(written).getByText('Written by this gym')).toBeInTheDocument();
    expect(within(written).queryByText('From reference library')).not.toBeInTheDocument();

    const adopted = screen.getByRole('button', { name: 'View instructions: Seeded jab return' }).closest('article') as HTMLElement;
    expect(within(adopted).getByText('striking')).toBeInTheDocument();
    expect(within(adopted).getByText('From reference library')).toBeInTheDocument();
    expect(within(adopted).queryByText('Written by this gym')).not.toBeInTheDocument();
  });

  it('offers nothing but View instructions on a gym drill: no assign, retire, restore, edit or delete', async () => {
    global.fetch = routes({ operational: [authored, promoted] }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    await screen.findByText('Corner exit');

    const written = screen.getByRole('heading', { name: 'Corner exit' }).closest('article') as HTMLElement;
    const adopted = screen.getByRole('button', { name: 'View instructions: Seeded jab return' }).closest('article') as HTMLElement;
    expect(within(written).queryAllByRole('button')).toHaveLength(0);
    expect(within(adopted).getAllByRole('button').map((button) => button.textContent)).toEqual(['View instructions']);
  });

  it('opens a promoted drill\'s exact reference by its pointer; a hand-written drill has nothing to open', async () => {
    const fetchMock = routes({
      operational: [authored, promoted],
      lifecycle: { [reference.drill_id]: { state: 'operational', operational_drill_id: promoted.drill_id } },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    await screen.findByText('Corner exit');

    // The operational card's control is named for what it opens -- the drill's
    // instructions -- so it is not a second "View drill" with the same name.
    expect(screen.getAllByRole('button', { name: 'View drill: Seeded jab return' })).toHaveLength(1);
    const instructions = screen.getByRole('button', { name: 'View instructions: Seeded jab return' });
    expect(screen.queryByRole('button', { name: 'View instructions: Corner exit' })).not.toBeInTheDocument();

    fireEvent.click(instructions);
    expect(await screen.findByRole('article', { name: 'Seeded jab return' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/pilot/drill-library?drill_id=reference-1',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

// W-D4C round-2 repair: a filter whose chosen value an action has just emptied
// must go on showing that value -- it is still what narrows the list -- rather
// than show "Any" while filtering everything out.
describe('discovery after a lifecycle action', () => {
  it('keeps showing the chosen "In this gym" filter after Restore empties it, and "Any" then lists the drill', async () => {
    const fetchMock = routes({ lifecycle: { [reference.drill_id]: retiredAt(OPERATIONAL_HEAD) } });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    await screen.findAllByRole('button', { name: 'View drill: Seeded jab return' });
    fireEvent.change(filterSelect('In this gym'), { target: { value: 'retired' } });
    expect(listedReferenceNames()).toEqual(['Seeded jab return']);

    const detail = await openReference();
    fireEvent.click(within(detail).getByRole('button', { name: 'Restore' }));
    await screen.findByText(/^Restored\./);
    fireEvent.click(screen.getByRole('button', { name: 'Back to the reference library' }));

    const select = filterSelect('In this gym');
    expect(select.value).toBe('retired');
    expect(select.selectedOptions[0]?.textContent).toBe('Retired in this gym');
    expect(listedReferenceNames()).toEqual([]);
    expect(screen.getByText('Showing 0 of 1 reference drills')).toBeInTheDocument();
    expect(screen.getByText('No reference drills match this search and these filters.')).toBeInTheDocument();

    fireEvent.change(select, { target: { value: '' } });
    expect(listedReferenceNames()).toEqual(['Seeded jab return']);
    // Once no longer chosen, the emptied state is no longer offered.
    expect(optionTexts(filterSelect('In this gym'))).toEqual(['Any', 'Operational in this gym']);
    expect(writes(fetchMock)).toHaveLength(1);
  });
});

describe('Back after the opening card is gone', () => {
  it('focuses the search box when the card that opened the drill is filtered out', async () => {
    const frames = holdAnimationFrames();
    global.fetch = routes({ lifecycle: { [reference.drill_id]: retiredAt(OPERATIONAL_HEAD) } }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    await screen.findAllByRole('button', { name: 'View drill: Seeded jab return' });
    fireEvent.change(filterSelect('In this gym'), { target: { value: 'retired' } });
    const detail = await openReference();
    fireEvent.click(within(detail).getByRole('button', { name: 'Restore' }));
    await screen.findByText(/^Restored\./);
    await waitFor(() => expect(frames.run()).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Back to the reference library' }));
    // The restored drill no longer matches "Retired in this gym": no card.
    expect(listedReferenceNames()).toEqual([]);
    expect(frames.run()).toBeGreaterThan(0);
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search by name' }));
  });
});

// W-D4C round-4/5 repair: an action binds the coach to its drill until it has
// finished -- its request AND every re-read after it -- and nothing else can
// start meanwhile, so nothing it reports can land on another drill or be
// mixed up with a second action.
describe('while an action is running', () => {
  const otherReference = { ...reference, drill_id: 'reference-2', name: 'Other reference drill' };
  const otherOperational = { ...promoted, drill_id: 'authored-3', reference_drill_id: 'reference-2', name: 'Other promoted drill' };
  const ACTION_NAMES = ['Promote', 'Retire', 'Restore', 'Saving...', 'Promoting...'];

  /** The Create a gym drill form -- every field and its button -- is never part of the lock. */
  function expectAddDrillFormUsable() {
    for (const id of ['drill-name', 'drill-category', 'drill-focus', 'drill-cues', 'drill-difficulty']) {
      expect(document.getElementById(id)).toBeEnabled();
    }
    expect(screen.getByRole('button', { name: 'Add drill' })).toBeEnabled();
  }

  /** Every navigation and action control the lock covers, by the name it has now. */
  function lockedControls(detail: HTMLElement) {
    const own = within(detail).queryAllByRole('button').filter((button) => ACTION_NAMES.includes(button.textContent ?? ''));
    expect(own.length).toBeGreaterThan(0);
    return [
      screen.getByRole('button', { name: 'Back to the reference library' }),
      screen.getByRole('button', { name: 'View instructions: Other promoted drill' }),
      screen.getByRole('button', { name: 'View drill: Other reference drill' }),
      ...own,
    ];
  }

  const PHASES = ['the save request', 'the list re-read', 'the drill re-read'] as const;
  const CASES = (['Retire', 'Promote'] as const).flatMap((action) => PHASES.map((phase) => [action, phase] as const));

  it.each(CASES)('keeps the coach on the drill, starting nothing, while %s waits on %s', async (action, phase) => {
    let answer: (response: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => { answer = resolve; });
    const state = action === 'Retire' ? operationalAt(OPERATIONAL_HEAD) : NOT_ADOPTED;
    const lifecycle = { [reference.drill_id]: state, [otherReference.drill_id]: NOT_ADOPTED };
    const write = phase === 'the save request'
      ? () => held as unknown as Response
      : () => jsonResponse({ error: 'The server refused this change.' }, false, 409);
    const fetchMock = routes({
      operational: [authored, otherOperational],
      references: [reference, otherReference],
      details: { [otherReference.drill_id]: { ...referenceDetail, ...otherReference } },
      lifecycle,
      patch: write,
      promote: write,
      libraryRead: (n) => (phase === 'the list re-read' && n === 2 ? (held as unknown as Response) : undefined),
      detailRead: (n) => (phase === 'the drill re-read' && n === 2 ? (held as unknown as Response) : undefined),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    fireEvent.click(within(detail).getByRole('button', { name: action }));

    // Wait until the held phase is the one running.
    if (phase === 'the list re-read') await waitFor(() => expect(readsOf(fetchMock, '/api/pilot/drill-library')).toBe(2));
    if (phase === 'the drill re-read') await waitFor(() => expect(readsOf(fetchMock, DETAIL_URL)).toBe(2));

    // Held: nothing that leaves the drill or starts an action is enabled, and
    // pressing them does nothing. The Create a gym drill form is not locked.
    const locked = lockedControls(detail);
    for (const control of locked) expect(control).toBeDisabled();
    for (const control of locked) fireEvent.click(control);
    expect(readsOf(fetchMock, '/api/pilot/drill-library?drill_id=reference-2')).toBe(0);
    expect(writes(fetchMock)).toHaveLength(1);
    expectAddDrillFormUsable();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => {
      answer(phase === 'the save request'
        ? jsonResponse({ error: 'The server refused this change.' }, false, 409)
        : phase === 'the list re-read'
          ? jsonResponse({ drills: [reference, otherReference], lifecycle })
          : jsonResponse({ drill: referenceDetail, lifecycle: state }));
    });
    await screen.findByRole('alert');
    // Finished: the same drill is still the one open, and everything is enabled again.
    expect(screen.getByRole('article', { name: 'Seeded jab return' })).toBeInTheDocument();
    await waitFor(() => {
      for (const control of lockedControls(detail)) expect(control).toBeEnabled();
    });
    expect(writes(fetchMock)).toHaveLength(1);
  });

  it.each([
    ['Retire', operationalAt(OPERATIONAL_HEAD), retiredAt(OPERATIONAL_HEAD), /^Retired\./],
    ['Promote', NOT_ADOPTED, operationalAt(promoted.drill_id), /^Promoted\./],
  ] as const)('keeps the coach on the drill, starting nothing, while a successful %s re-reads the lists', async (action, before, after, notice) => {
    let answer: (response: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => { answer = resolve; });
    const fetchMock = routes({
      operational: [authored, otherOperational],
      references: [reference, otherReference],
      details: { [otherReference.drill_id]: { ...referenceDetail, ...otherReference } },
      lifecycle: { [reference.drill_id]: before, [otherReference.drill_id]: NOT_ADOPTED },
      // The write succeeds; the list re-read after it is held.
      libraryRead: (n) => (n === 2 ? (held as unknown as Response) : undefined),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    fireEvent.click(within(detail).getByRole('button', { name: action }));
    await waitFor(() => expect(readsOf(fetchMock, '/api/pilot/drill-library')).toBe(2));

    const locked = lockedControls(detail);
    for (const control of locked) expect(control).toBeDisabled();
    for (const control of locked) fireEvent.click(control);
    expect(readsOf(fetchMock, '/api/pilot/drill-library?drill_id=reference-2')).toBe(0);
    expect(writes(fetchMock)).toHaveLength(1);
    expectAddDrillFormUsable();
    // The notice speaks of this drill's new state: not before it is read.
    expect(screen.queryByText(notice)).not.toBeInTheDocument();

    await act(async () => {
      answer(jsonResponse({ drills: [reference, otherReference], lifecycle: { [reference.drill_id]: after, [otherReference.drill_id]: NOT_ADOPTED } }));
    });
    expect(await screen.findByText(notice)).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Seeded jab return' })).toBeInTheDocument();
    await waitFor(() => {
      for (const control of lockedControls(detail)) expect(control).toBeEnabled();
    });
    expect(writes(fetchMock)).toHaveLength(1);
  });

  it('offers the next action only once a refused Promote\'s re-reads have finished', async () => {
    // Promoted elsewhere: the list re-read shows the drill operational while
    // the drill's own re-read is still held. Retire appears -- disabled.
    let answerDetail: (response: Response) => void = () => {};
    const heldDetail = new Promise<Response>((resolve) => { answerDetail = resolve; });
    const fetchMock = routes({
      promote: () => jsonResponse({ error: 'This drill is already promoted in this gym.' }, false, 409),
      libraryRead: (n) => (n === 2
        ? jsonResponse({ drills: [reference], lifecycle: { [reference.drill_id]: operationalAt(OPERATIONAL_HEAD) } })
        : undefined),
      detailRead: (n) => (n === 2 ? (heldDetail as unknown as Response) : undefined),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    fireEvent.click(within(detail).getByRole('button', { name: 'Promote' }));

    const retire = await within(detail).findByRole('button', { name: 'Retire' });
    expect(retire).toBeDisabled();
    fireEvent.click(retire);
    expect(writes(fetchMock)).toHaveLength(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => {
      answerDetail(jsonResponse({ drill: referenceDetail, lifecycle: operationalAt(OPERATIONAL_HEAD) }));
    });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('This drill is already promoted in this gym.')).toBeInTheDocument();
    await waitFor(() => expect(within(detail).getByRole('button', { name: 'Retire' })).toBeEnabled());
    expect(writes(fetchMock)).toHaveLength(1);
  });

  it('shows the alert only once the drill\'s own re-read has answered', async () => {
    let answerDetail: (response: Response) => void = () => {};
    const heldDetail = new Promise<Response>((resolve) => { answerDetail = resolve; });
    const fetchMock = routes({
      promote: () => jsonResponse({ error: 'This gym already has a drill named "Seeded jab return".' }, false, 409),
      // The first detail read opens the drill; the second -- the re-read after
      // the refusal -- is held open until the test answers it.
      detailRead: (readNumber) => (readNumber === 2 ? (heldDetail as unknown as Response) : undefined),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    fireEvent.click(within(detail).getByRole('button', { name: 'Promote' }));

    await waitFor(() => expect(readsOf(fetchMock, DETAIL_URL)).toBe(2));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: 'Promoting...' })).toBeDisabled();

    await act(async () => {
      answerDetail(jsonResponse({ drill: referenceDetail, lifecycle: NOT_ADOPTED }));
    });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(CONFLICT_REREAD)).toBeInTheDocument();
  });
});

describe('Back', () => {
  it('returns focus to the card that opened the drill when it is still there', async () => {
    const frames = holdAnimationFrames();
    global.fetch = routes() as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    await openReference();
    frames.run();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the reference library' }));
    expect(frames.run()).toBeGreaterThan(0);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'View drill: Seeded jab return' }));
  });

  it('focuses the Reference library heading when the library could not be read again', async () => {
    const frames = holdAnimationFrames();
    global.fetch = routes({
      lifecycle: { [reference.drill_id]: operationalAt(OPERATIONAL_HEAD) },
      patch: () => jsonResponse({ error: 'The server refused this change.' }, false, 409),
      libraryRead: (readNumber) => (readNumber > 1 ? jsonResponse({ error: 'unavailable' }, false, 503) : undefined),
    }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    fireEvent.click(within(detail).getByRole('button', { name: 'Retire' }));
    await screen.findByText(REREAD_FAILED);
    const back = screen.getByRole('button', { name: 'Back to the reference library' });
    await waitFor(() => expect(back).toBeEnabled());
    frames.run();

    fireEvent.click(back);
    // No card and no search box: the library did not load.
    expect(screen.queryByRole('searchbox', { name: 'Search by name' })).not.toBeInTheDocument();
    expect(frames.run()).toBeGreaterThan(0);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Reference library' }));
  });
});

describe('the notice after an action', () => {
  it('goes when the coach goes Back, since it speaks of the drill being left', async () => {
    global.fetch = routes({ lifecycle: { [reference.drill_id]: operationalAt(OPERATIONAL_HEAD) } }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();
    fireEvent.click(within(detail).getByRole('button', { name: 'Retire' }));
    await screen.findByText(/^Retired\./);
    const back = screen.getByRole('button', { name: 'Back to the reference library' });
    await waitFor(() => expect(back).toBeEnabled());

    fireEvent.click(back);
    expect(screen.queryByText(/^Retired\./)).not.toBeInTheDocument();
  });
});

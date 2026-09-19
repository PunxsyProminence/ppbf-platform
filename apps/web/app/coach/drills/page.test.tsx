/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
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

/**
 * One stub for every route the page reads, so each test only states what is
 * different about it. The detail read is matched on its query string: a stub
 * that answered it with the list would let a broken detail pass.
 */
function routes(options: {
  operational?: unknown[];
  census?: unknown[];
  promote?: () => Response;
  onPromote?: () => void;
} = {}) {
  const operational = options.operational ?? [authored];
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/drills/promote') && init?.method === 'POST') {
      options.onPromote?.();
      return options.promote ? options.promote() : jsonResponse({ ok: true, drill: promoted }, true, 201);
    }
    if (url.includes('/drill-library?drill_id=')) {
      return url.endsWith(`drill_id=${reference.drill_id}`)
        ? jsonResponse({ drill: referenceDetail })
        : jsonResponse({ error: 'DRILL_NOT_FOUND' }, false, 404);
    }
    if (url.endsWith('/drill-library')) return jsonResponse({ drills: [reference] });
    if (url.includes('include_retired=true')) return jsonResponse({ items: options.census ?? operational });
    return jsonResponse({ items: operational });
  });
}

/** Opens the REFERENCE card's detail (the first "View drill" in document order). */
async function openReference() {
  const [referenceCardButton] = await screen.findAllByRole('button', { name: 'View drill: Seeded jab return' });
  fireEvent.click(referenceCardButton);
  return screen.findByRole('article', { name: 'Seeded jab return' });
}

beforeEach(() => {
  jest.clearAllMocks();
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
      ? jsonResponse({ drills: [reference] })
      : jsonResponse({ items: [authored] });
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<CoachDrillLibraryPage />);
  await screen.findByText('Seeded jab return');

  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Slip line' } });
  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'Defense' } });
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

    // "Setup:" printed the equipment word for most of the corpus.
    expect(screen.queryByText(/^Setup:/)).not.toBeInTheDocument();
    expect(screen.getByText('focus mitts')).toBeInTheDocument();
    expect(screen.getByText('Light technical contact')).toBeInTheDocument();
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
    let operational: unknown[] = [authored];
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/drills/promote') && init?.method === 'POST') {
        operational = [authored, promoted];
        return jsonResponse({ ok: true, drill: promoted }, true, 201);
      }
      if (url.includes('/drill-library?drill_id=')) return jsonResponse({ drill: referenceDetail });
      if (url.endsWith('/drill-library')) return jsonResponse({ drills: [reference] });
      return jsonResponse({ items: operational });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    fireEvent.click(within(detail).getByRole('button', { name: 'Promote' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/pilot/drills/promote', expect.objectContaining({ method: 'POST' })),
    );
    const promoteCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/drills/promote'));
    expect(JSON.parse(String((promoteCall?.[1] as RequestInit).body))).toEqual({ reference_drill_id: 'reference-1' });
    expect(fetchMock).not.toHaveBeenCalledWith('/api/pilot/drill-library', expect.objectContaining({ method: 'POST' }));

    // The server's census, reloaded, is what turns the control off.
    expect(await within(detail).findByText('Already promoted')).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'Promote' })).not.toBeInTheDocument();
    // And the coach is told what that did, including that athletes can now read it.
    expect(screen.getByRole('status')).toHaveTextContent(/athletes in this gym can read it in Learn/);
  });

  it('writes nothing just by being opened', async () => {
    const fetchMock = routes();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    await openReference();

    const writes = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method && (init as RequestInit).method !== 'GET');
    expect(writes).toEqual([]);
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
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/drill-library?drill_id=')) return jsonResponse({ drill: equipmentOnly });
      if (url.endsWith('/drill-library')) return jsonResponse({ drills: [{ ...reference, standard_setup: 'focus mitt', equipment_needed: 'focus mitt' }] });
      return jsonResponse({ items: [authored] });
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

// Promotion state, per OD-2026-09-16-001: read from the operational drills'
// reference_drill_id, never inferred from a matching name.
describe('promotion state', () => {
  it('offers Promote on the detail of a reference this gym has not promoted', async () => {
    global.fetch = routes() as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    expect(within(detail).getByRole('button', { name: 'Promote' })).toBeEnabled();
    expect(screen.queryByText('Already promoted')).not.toBeInTheDocument();
  });

  it('shows a reference drill as already promoted when an operational drill points at it', async () => {
    global.fetch = routes({ operational: [authored, promoted] }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);

    expect(await screen.findAllByText('Seeded jab return')).toHaveLength(2);
    expect(screen.getByText('Already promoted')).toBeInTheDocument();
    const detail = await openReference();
    expect(within(detail).queryByRole('button', { name: 'Promote' })).not.toBeInTheDocument();
  });

  it('shows a retired promotion as promoted-and-retired, because the reference is still reserved', async () => {
    const retired = { ...promoted, drill_id: 'authored-retired', active: false };
    global.fetch = routes({ operational: [authored], census: [authored, retired] }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);

    // Reserved, but not live: "Already promoted" alone would tell a coach
    // athletes can read it, and they cannot.
    expect(await screen.findByText('Promoted · retired')).toBeInTheDocument();
    expect(screen.queryByText('Already promoted')).not.toBeInTheDocument();
    // The retired drill is not smuggled into the active list to get that answer.
    expect(screen.getByText('Corner exit')).toBeInTheDocument();
    expect(screen.queryAllByText('Seeded jab return')).toHaveLength(1);
  });

  it('does not treat a same-named operational drill as a promotion', async () => {
    const sameName = { ...authored, drill_id: 'authored-3', name: 'Seeded jab return' };
    global.fetch = routes({ operational: [sameName] }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    const detail = await openReference();

    expect(within(detail).getByRole('button', { name: 'Promote' })).toBeInTheDocument();
    expect(screen.queryByText('Already promoted')).not.toBeInTheDocument();
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
});

// "Gym-authored" was false for every promoted drill (OD-2026-09-19-001).
describe('the operational drills section', () => {
  it('is called Operational drills and says where each drill came from', async () => {
    global.fetch = routes({ operational: [authored, promoted] }) as unknown as typeof fetch;

    render(<CoachDrillLibraryPage />);
    await screen.findByText('Corner exit');

    expect(screen.getByRole('heading', { name: 'Operational drills' })).toBeInTheDocument();
    expect(screen.queryByText(/Gym-authored/i)).not.toBeInTheDocument();
    expect(screen.getByText('Footwork · Written by this gym')).toBeInTheDocument();
    expect(screen.getByText('striking · From the reference library')).toBeInTheDocument();
  });

  it('opens a promoted drill\'s exact reference by its pointer; a hand-written drill has nothing to open', async () => {
    const fetchMock = routes({ operational: [authored, promoted] });
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

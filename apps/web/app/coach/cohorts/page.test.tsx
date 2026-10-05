/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import CoachCohortsPage from './page';
import { COMPETENCE_DOMAINS } from '@/src/server/pilot/competenceCohorts';

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

// Only COMPETENCE_DOMAINS is read from the server module; its pg import cannot load under jsdom.
jest.mock('@/src/server/pilot/db', () => ({}));

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

const LEVELS = [
  { level_key: 'exploring', ordinal: 1, display_name: 'Exploring', observable_test: 'Can hold the stance for one round.', typical_scale: 'A' },
];

const OPEN_FLOOR = {
  cohort_id: 'coh-open',
  cohort_name: 'Open Floor',
  discipline: 'boxing',
  min_level_ordinal: null,
  max_level_ordinal: 2,
  required_domains: '',
  tenure_bands: 'insufficient_history,introduction',
  min_age_regulatory: null,
  max_age_regulatory: null,
  regulatory_basis: '',
  contact_permitted: 'none',
  requires_coach_approval: true,
  notes: 'Entry room.',
  active_flag: true,
};

const SPARRING = {
  ...OPEN_FLOOR,
  cohort_id: 'coh-spar',
  cohort_name: 'Pressure Group',
  min_level_ordinal: 4,
  max_level_ordinal: 6,
  required_domains: 'defense,composure',
  min_age_regulatory: 15,
  regulatory_basis: 'USA Boxing Rulebook 2026 s.3.1',
  contact_permitted: 'controlled_sparring',
  notes: '',
};

function report(overrides: Record<string, unknown> = {}) {
  return {
    athlete_id: 'ath-1',
    tenure: { sessions_logged: 40, hours_logged: '52.5', tenure_band: 'fundamentals' },
    age_years: 17,
    competence: [
      { competence_id: 'c-1', domain: 'defense', display_name: 'Adapting', ordinal: 4 },
    ],
    fits: [
      { cohort_id: 'coh-open', cohort_name: 'Open Floor', eligible: true, unmet: [], requires_coach_approval: true, contact_permitted: 'none', regulatory_basis: '' },
      { cohort_id: 'coh-spar', cohort_name: 'Pressure Group', eligible: false, unmet: ['No assessed level in composure.'], requires_coach_approval: true, contact_permitted: 'controlled_sparring', regulatory_basis: 'USA Boxing Rulebook 2026 s.3.1' },
    ],
    ...overrides,
  };
}

function mockFetch(handler: (url: string) => Response) {
  const fetchMock = jest.fn(async (input: RequestInfo | URL) => handler(String(input)));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function rulesOnly() {
  return mockFetch(() => jsonResponse({ levels: LEVELS, cohorts: [OPEN_FLOOR, SPARRING] }));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('coach cohorts page -- the rooms', () => {
  it('lists the cohorts and the ladder', async () => {
    rulesOnly();

    render(<CoachCohortsPage />);

    expect(await screen.findByText('Open Floor')).toBeInTheDocument();
    expect(screen.getByText('Pressure Group')).toBeInTheDocument();
    expect(screen.getByText('Exploring')).toBeInTheDocument();
  });

  it('reads the payload keys the route actually sends', async () => {
    mockFetch(() => jsonResponse({ items: [OPEN_FLOOR] }));

    render(<CoachCohortsPage />);

    expect(await screen.findByText(/No cohorts defined yet/i)).toBeInTheDocument();
  });

  it('distinguishes a failed load from an empty set of rooms', async () => {
    mockFetch(() => jsonResponse({}, false, 500));

    render(<CoachCohortsPage />);

    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByText(/not an empty set of rooms/i)).toBeInTheDocument();
  });

  it('never shows an age bound without the rulebook that imposes it', async () => {
    // A bare age number with no citation is an invented age band -- the exact
    // thing pilot_cohortdef_reg_basis exists to reject.
    rulesOnly();

    render(<CoachCohortsPage />);

    const bound = await screen.findByText(/Regulatory age bound/);
    expect(bound.textContent).toContain('USA Boxing Rulebook 2026 s.3.1');
  });

  it('shows no age line at all for a room with no age bound', async () => {
    mockFetch(() => jsonResponse({ levels: [], cohorts: [OPEN_FLOOR] }));

    render(<CoachCohortsPage />);

    await screen.findByText('Open Floor');
    expect(screen.queryByText(/Regulatory age bound/)).not.toBeInTheDocument();
  });

  it('shows the observable test for each level, not just its name', async () => {
    rulesOnly();

    render(<CoachCohortsPage />);

    expect(await screen.findByText('Can hold the stance for one round.')).toBeInTheDocument();
  });
});

describe('coach cohorts page -- one athlete', () => {
  it('offers coach-visible athlete names instead of requiring a memorized id', async () => {
    mockFetch((url) => {
      if (url.includes('/athletes/list')) {
        return jsonResponse({ items: [{ athlete_id: 'ath-1', full_name: 'Alex Rivera' }] });
      }
      return jsonResponse({ levels: LEVELS, cohorts: [OPEN_FLOOR] });
    });

    render(<CoachCohortsPage />);

    // Not findByRole('option'). A <datalist> is a completion source rather
    // than a listbox, so its options are not exposed with role=option; that
    // query matched only under an older aria-query and stopped matching when
    // the floating range moved under us. The DOM never changed -- the option
    // still renders with the coach-visible name and the id as its value.
    //
    // Reaching it by its text and then pinning what it IS asserts strictly
    // more than the role query did: that the element is an <option>, that it
    // carries the athlete id, and that it hangs off the datalist this page's
    // input names -- which the role query never checked.
    const option = await screen.findByText('Alex Rivera');
    expect(option.tagName).toBe('OPTION');
    expect(option).toHaveValue('ath-1');
    expect(option.closest('datalist')).toHaveAttribute('id', 'cohort-athletes');
    expect(screen.getByLabelText(/athlete id/i)).toHaveAttribute('list', 'cohort-athletes');
  });

  function withReport() {
    return mockFetch((url) => (url.includes('athlete_id')
      ? jsonResponse({ report: report() })
      : jsonResponse({ levels: LEVELS, cohorts: [OPEN_FLOOR, SPARRING] })));
  }

  // Wrapped in act so the fetch promise settles inside the test's own render
  // pass; without it every assertion races the state update it depends on.
  async function lookUp(id = 'ath-1') {
    fireEvent.change(await screen.findByLabelText(/athlete id/i), { target: { value: id } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /look up/i }));
    });
  }

  it('shows which rooms fit and which do not', async () => {
    withReport();
    render(<CoachCohortsPage />);
    await lookUp();

    expect(await screen.findByText('Fits')).toBeInTheDocument();
    expect(screen.getByText('Not yet')).toBeInTheDocument();
  });

  it('gives the reason a room does not fit, not just a refusal', async () => {
    withReport();
    render(<CoachCohortsPage />);
    await lookUp();

    expect(await screen.findByText('No assessed level in composure.')).toBeInTheDocument();
  });

  it('still says coach sign-off is needed for a room that fits', async () => {
    // Passing the rules is not the same as being cleared into the room.
    withReport();
    render(<CoachCohortsPage />);
    await lookUp();

    expect(await screen.findByText(/needs a coach to sign off/i)).toBeInTheDocument();
  });

  it('reports no logged training rather than showing zero hours', async () => {
    mockFetch((url) => (url.includes('athlete_id')
      ? jsonResponse({ report: report({ tenure: null, competence: [], fits: [] }) })
      : jsonResponse({ levels: [], cohorts: [] })));

    render(<CoachCohortsPage />);
    await lookUp();

    expect(await screen.findByText(/No logged training yet/i)).toBeInTheDocument();
  });

  it('surfaces an unknown athlete as its own message', async () => {
    mockFetch((url) => (url.includes('athlete_id')
      ? jsonResponse({ error: 'ATHLETE_NOT_FOUND' }, false, 404)
      : jsonResponse({ levels: [], cohorts: [] })));

    render(<CoachCohortsPage />);
    await lookUp('nope');

    expect(await screen.findByRole('alert')).toHaveTextContent(/No athlete with that id/i);
  });

  it('clears a stale report when a different athlete is looked up', async () => {
    let first = true;
    mockFetch((url) => {
      if (url.includes('athlete_id')) {
        if (first) { first = false; return jsonResponse({ report: report() }); }
        return jsonResponse({ report: report({ competence: [], fits: [], tenure: null }) });
      }
      return jsonResponse({ levels: [], cohorts: [] });
    });

    render(<CoachCohortsPage />);
    await lookUp('ath-1');
    expect(await screen.findByText('No assessed level in composure.')).toBeInTheDocument();

    await lookUp('ath-2');

    // The first athlete's assessment must not linger under the second's id.
    expect(await screen.findByText(/No assessed competence levels yet/i)).toBeInTheDocument();
    expect(screen.queryByText('No assessed level in composure.')).not.toBeInTheDocument();
  });

  it('clears the displayed report as soon as the athlete id is edited', async () => {
    withReport();
    render(<CoachCohortsPage />);
    await lookUp('ath-1');
    expect(await screen.findByText('No assessed level in composure.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/athlete id/i), { target: { value: 'ath-2' } });

    expect(screen.queryByText('No assessed level in composure.')).not.toBeInTheDocument();
  });

  it('clears a stale error when a later look-up succeeds', async () => {
    let first = true;
    mockFetch((url) => {
      if (url.includes('athlete_id')) {
        if (first) { first = false; return jsonResponse({}, false, 404); }
        return jsonResponse({ report: report() });
      }
      return jsonResponse({ levels: [], cohorts: [] });
    });

    render(<CoachCohortsPage />);
    await lookUp('nope');
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await lookUp('ath-1');

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('does not fire a look-up for a blank or whitespace id', async () => {
    const fetchMock = rulesOnly();
    render(<CoachCohortsPage />);
    await screen.findByText('Open Floor');
    const before = fetchMock.mock.calls.length;

    fireEvent.change(screen.getByLabelText(/athlete id/i), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));

    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('encodes the athlete id in the request', async () => {
    const fetchMock = withReport();
    render(<CoachCohortsPage />);
    await lookUp('ath/with space');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`athlete_id=${encodeURIComponent('ath/with space')}`),
        expect.anything(),
      );
    });
  });
});

describe('coach cohorts page -- setting a level', () => {
  const LADDER = [
    ...LEVELS,
    { level_key: 'adapting', ordinal: 4, display_name: 'Adapting', observable_test: 'Adapts under pressure.', typical_scale: 'B' },
  ];

  // GET of the rules, GET of the report, and the POST under test.
  function withSave(postResponse: () => Response) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === 'POST') return postResponse();
      if (url.includes('athlete_id=')) return jsonResponse({ report: report() });
      return jsonResponse({ levels: LADDER, cohorts: [OPEN_FLOOR, SPARRING] });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return calls;
  }

  async function openReport() {
    render(<CoachCohortsPage />);
    fireEvent.change(await screen.findByLabelText(/athlete id/i), { target: { value: 'ath-1' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /look up/i }));
    });
    await screen.findByText('Set a level');
  }

  async function chooseAndSave(domain: string, levelKey: string, note = '') {
    fireEvent.change(screen.getByLabelText('Area'), { target: { value: domain } });
    fireEvent.change(screen.getByLabelText('Level'), { target: { value: levelKey } });
    if (note) fireEvent.change(screen.getByLabelText(/what you saw/i), { target: { value: note } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save level' }));
    });
  }

  it('offers exactly the domains the server accepts', async () => {
    withSave(() => jsonResponse({}));
    await openReport();

    const options = Array.from((screen.getByLabelText('Area') as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual([...COMPETENCE_DOMAINS]);
  });

  it('offers the gym ladder as the levels, and cannot save until one is chosen', async () => {
    withSave(() => jsonResponse({}));
    await openReport();

    const levelOptions = Array.from((screen.getByLabelText('Level') as HTMLSelectElement).options).map((o) => o.value);
    expect(levelOptions).toEqual(['', 'exploring', 'adapting']);
    expect(screen.getByRole('button', { name: 'Save level' })).toBeDisabled();
  });

  it('posts the choice for the looked-up athlete and shows the rooms the route returns', async () => {
    const updated = report({
      competence: [
        { competence_id: 'c-1', domain: 'defense', display_name: 'Adapting', ordinal: 4 },
        { competence_id: 'c-2', domain: 'composure', display_name: 'Adapting', ordinal: 4 },
      ],
      fits: [
        { cohort_id: 'coh-spar', cohort_name: 'Pressure Group', eligible: true, unmet: [], requires_coach_approval: false, contact_permitted: 'controlled_sparring', regulatory_basis: '' },
      ],
    });
    const calls = withSave(() => jsonResponse({ result: { changed: true }, report: updated }));
    await openReport();
    expect(screen.getByText('Not yet')).toBeInTheDocument();

    await chooseAndSave('composure', 'adapting', 'held shape under pressure');

    const post = calls.find((call) => call.init?.method === 'POST');
    expect(post?.url).toBe('/api/pilot/competence-cohorts');
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      athlete_id: 'ath-1',
      domain: 'composure',
      level_key: 'adapting',
      evidence_note: 'held shape under pressure',
    });
    expect(await screen.findByText('Saved. The rooms below are updated.')).toBeInTheDocument();
    expect(screen.getByText('composure: Adapting')).toBeInTheDocument();
    expect(screen.getByText('Fits')).toBeInTheDocument();
    expect(screen.queryByText('Not yet')).not.toBeInTheDocument();
  });

  it('says so when the athlete already holds that level', async () => {
    withSave(() => jsonResponse({ result: { changed: false }, report: report() }));
    await openReport();

    await chooseAndSave('defense', 'adapting');

    expect(await screen.findByText('No change: that is already the level.')).toBeInTheDocument();
  });

  it('names the reason when the coach does not coach or cover the athlete', async () => {
    withSave(() => jsonResponse({ error: 'Forbidden' }, false, 403));
    await openReport();

    await chooseAndSave('footwork', 'exploring');

    expect(await screen.findByRole('alert')).toHaveTextContent('You can only set levels for athletes you coach or cover.');
    expect(screen.queryByText(/Saved\./)).not.toBeInTheDocument();
  });

  it('reports any other failure as not saved, keeping the old rooms', async () => {
    withSave(() => jsonResponse({ error: 'Internal server error' }, false, 500));
    await openReport();

    await chooseAndSave('footwork', 'exploring');

    expect(await screen.findByRole('alert')).toHaveTextContent('That level could not be saved.');
    expect(screen.getByText('Not yet')).toBeInTheDocument();
  });

  it('keeps the note when nothing changed, because nothing was recorded', async () => {
    withSave(() => jsonResponse({ result: { changed: false }, report: report() }));
    await openReport();

    await chooseAndSave('defense', 'adapting', 'still solid');

    expect(await screen.findByText('No change: that is already the level.')).toBeInTheDocument();
    expect(screen.getByLabelText(/what you saw/i)).toHaveValue('still solid');
  });

  it('never carries a note about one athlete over to the next after a failed save', async () => {
    withSave(() => jsonResponse({ error: 'Internal server error' }, false, 500));
    await openReport();
    await chooseAndSave('footwork', 'exploring', 'note about the first child');
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/athlete id/i), { target: { value: 'ath-2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /look up/i }));
    });
    await screen.findByText('Set a level');

    expect(screen.getByLabelText(/what you saw/i)).toHaveValue('');
    expect(screen.getByLabelText('Level')).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('locks the athlete id while a save is in flight', async () => {
    let finish: (response: Response) => void = () => {};
    withSave(() => jsonResponse({}));
    const fetchMock = global.fetch as jest.Mock;
    const realImpl = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'POST'
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : realImpl(input, init)));
    await openReport();

    await chooseAndSave('footwork', 'exploring');

    expect(screen.getByLabelText(/athlete id/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: /look up/i })).toBeDisabled();
    await act(async () => {
      finish(jsonResponse({ result: { changed: true }, report: report() }));
    });
    expect(screen.getByLabelText(/athlete id/i)).not.toBeDisabled();
  });

  it('clears the saved message when another athlete id is typed', async () => {
    withSave(() => jsonResponse({ result: { changed: true }, report: report() }));
    await openReport();
    await chooseAndSave('footwork', 'exploring');
    expect(await screen.findByText('Saved. The rooms below are updated.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/athlete id/i), { target: { value: 'ath-2' } });

    expect(screen.queryByText('Saved. The rooms below are updated.')).not.toBeInTheDocument();
    expect(screen.queryByText('Set a level')).not.toBeInTheDocument();
  });
});

/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import CoachCohortsPage from './page';

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

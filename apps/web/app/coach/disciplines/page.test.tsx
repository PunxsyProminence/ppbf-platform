/**
 * @jest-environment jsdom
 */

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import CoachDisciplinesPage from './page';

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

const GRAPPLING = {
  discipline: 'grappling',
  display_name: 'Grappling',
  lane: 'grappling',
  exposure_model: 'neck_and_joint',
  governing_body: 'IBJJF',
  age_policy_source: 'IBJJF Youth Rules 2026 s.2',
  youth_permitted: true,
  adult_permitted: true,
  mixed_age_permitted: false,
  evidence_note: 'Separate risk model from striking.',
  active: true,
};

const BOXING = {
  ...GRAPPLING,
  discipline: 'boxing',
  display_name: 'Boxing',
  lane: 'striking',
  exposure_model: 'head_contact',
  governing_body: null,
  age_policy_source: null,
  evidence_note: '',
};

function exposureRow(overrides: Record<string, unknown> = {}) {
  return {
    exposure_id: 'exp-1',
    segment_number: 1,
    round_type: 'positional',
    duration_sec: 180,
    coach_observed_intensity: 'light',
    neck_exposure: 'none',
    joint_exposure: 'none',
    impact_to_head: 'none',
    athlete_presentation: 'normal',
    stopped_early: false,
    stop_reason: null,
    coach_note: '',
    ...overrides,
  };
}

function mockFetch(handler: (url: string) => Response) {
  const fetchMock = jest.fn(async (input: RequestInfo | URL) => handler(String(input)));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function lookUp(id = 'ath-1') {
  fireEvent.change(await screen.findByLabelText(/athlete id/i), { target: { value: id } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('coach disciplines page -- what the gym runs', () => {
  it('lists the disciplines', async () => {
    mockFetch(() => jsonResponse({ disciplines: [BOXING, GRAPPLING] }));

    render(<CoachDisciplinesPage />);

    expect(await screen.findByText('Boxing')).toBeInTheDocument();
    expect(screen.getByText('Grappling')).toBeInTheDocument();
  });

  it('reads the payload key the route actually sends', async () => {
    mockFetch(() => jsonResponse({ items: [BOXING] }));

    render(<CoachDisciplinesPage />);

    expect(await screen.findByText(/No disciplines defined yet/i)).toBeInTheDocument();
  });

  it('distinguishes a failed load from an empty list', async () => {
    mockFetch(() => jsonResponse({}, false, 500));

    render(<CoachDisciplinesPage />);

    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByText(/not an empty list of disciplines/i)).toBeInTheDocument();
  });

  it('shows an age policy with its cited source', async () => {
    mockFetch(() => jsonResponse({ disciplines: [GRAPPLING] }));

    render(<CoachDisciplinesPage />);

    expect(await screen.findByText(/IBJJF Youth Rules 2026 s.2/)).toBeInTheDocument();
  });

  it('omits the age policy line entirely when no source is recorded', async () => {
    mockFetch(() => jsonResponse({ disciplines: [BOXING] }));

    render(<CoachDisciplinesPage />);

    await screen.findByText('Boxing');
    expect(screen.queryByText(/Age policy:/)).not.toBeInTheDocument();
  });

  it('shows each discipline its own exposure model rather than a shared one', async () => {
    mockFetch(() => jsonResponse({ disciplines: [BOXING, GRAPPLING] }));

    render(<CoachDisciplinesPage />);

    expect(await screen.findByText('head contact')).toBeInTheDocument();
    expect(screen.getByText('neck and joint')).toBeInTheDocument();
  });
});

describe('coach disciplines page -- grappling exposure history', () => {
  it('offers coach-visible athlete names instead of requiring a memorized id', async () => {
    mockFetch((url) => {
      if (url.includes('/athletes/list')) {
        return jsonResponse({ items: [{ athlete_id: 'ath-1', full_name: 'Alex Rivera' }] });
      }
      return jsonResponse({ disciplines: [GRAPPLING] });
    });

    render(<CoachDisciplinesPage />);

    const option = await screen.findByRole('option', { name: 'Alex Rivera' });
    expect(option).toHaveValue('ath-1');
    expect(screen.getByLabelText(/athlete id/i)).toHaveAttribute('list', 'discipline-athletes');
  });

  function withExposure(rows: Record<string, unknown>[]) {
    return mockFetch((url) => (url.includes('athlete_id')
      ? jsonResponse({ exposure: rows, participation: [] })
      : jsonResponse({ disciplines: [GRAPPLING] })));
  }

  it('says so plainly when an athlete has no recorded exposure', async () => {
    withExposure([]);
    render(<CoachDisciplinesPage />);
    await lookUp();

    expect(await screen.findByText(/No grappling exposure recorded/i)).toBeInTheDocument();
  });

  it('lists a recorded segment with its neck and joint exposure', async () => {
    withExposure([exposureRow({ neck_exposure: 'positional_pressure' })]);
    render(<CoachDisciplinesPage />);
    await lookUp();

    expect(await screen.findByText(/Neck: positional pressure/)).toBeInTheDocument();
  });

  it('always shows the coach note on a completed choke', async () => {
    // The module refuses to record a completed choke without a note, so the
    // note is never absent here -- and must never be collapsed into the label.
    withExposure([exposureRow({
      neck_exposure: 'choke_completed',
      coach_note: 'Partner held position after the tap; both athletes spoken to.',
    })]);
    render(<CoachDisciplinesPage />);
    await lookUp();

    expect(await screen.findByText(/Partner held position after the tap/)).toBeInTheDocument();
  });

  it('surfaces an early stop with its reason', async () => {
    withExposure([exposureRow({ stopped_early: true, stop_reason: 'Athlete reported neck discomfort.' })]);
    render(<CoachDisciplinesPage />);
    await lookUp();

    expect(await screen.findByText(/Athlete reported neck discomfort/)).toBeInTheDocument();
  });

  it('calls out an athlete who did not present normally', async () => {
    withExposure([exposureRow({ athlete_presentation: 'unsteady' })]);
    render(<CoachDisciplinesPage />);
    await lookUp();

    expect(await screen.findByText(/presented unsteady/i)).toBeInTheDocument();
  });

  it('says nothing about presentation when it was normal', async () => {
    withExposure([exposureRow({ athlete_presentation: 'normal' })]);
    render(<CoachDisciplinesPage />);
    await lookUp();

    await screen.findByText(/Segment 1/);
    expect(screen.queryByText(/presented/i)).not.toBeInTheDocument();
  });

  it('clears a previous athlete\'s history when another is looked up', async () => {
    let first = true;
    mockFetch((url) => {
      if (url.includes('athlete_id')) {
        if (first) {
          first = false;
          return jsonResponse({ exposure: [exposureRow({ coach_note: 'First athlete note.' })], participation: [] });
        }
        return jsonResponse({ exposure: [], participation: [] });
      }
      return jsonResponse({ disciplines: [] });
    });

    render(<CoachDisciplinesPage />);
    await lookUp('ath-1');
    expect(await screen.findByText('First athlete note.')).toBeInTheDocument();

    await lookUp('ath-2');

    expect(await screen.findByText(/No grappling exposure recorded/i)).toBeInTheDocument();
    expect(screen.queryByText('First athlete note.')).not.toBeInTheDocument();
  });

  it('clears displayed history as soon as the athlete id is edited', async () => {
    withExposure([exposureRow({ coach_note: 'First athlete note.' })]);
    render(<CoachDisciplinesPage />);
    await lookUp('ath-1');
    expect(await screen.findByText('First athlete note.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/athlete id/i), { target: { value: 'ath-2' } });

    expect(screen.queryByText('First athlete note.')).not.toBeInTheDocument();
  });

  it('clears a stale error when a later look-up succeeds', async () => {
    let first = true;
    mockFetch((url) => {
      if (url.includes('athlete_id')) {
        if (first) { first = false; return jsonResponse({}, false, 500); }
        return jsonResponse({ exposure: [], participation: [] });
      }
      return jsonResponse({ disciplines: [] });
    });

    render(<CoachDisciplinesPage />);
    await lookUp('nope');
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await lookUp('ath-1');

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  it('does not fire a look-up for a blank id', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ disciplines: [GRAPPLING] }));
    render(<CoachDisciplinesPage />);
    await screen.findByText('Grappling');
    const before = fetchMock.mock.calls.length;

    fireEvent.change(screen.getByLabelText(/athlete id/i), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: /look up/i }));

    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('shows the current participation level alongside the history', async () => {
    mockFetch((url) => (url.includes('athlete_id')
      ? jsonResponse({
        exposure: [],
        participation: [{ participation_id: 'p-1', discipline: 'grappling', participation_level: 'technique_only' }],
      })
      : jsonResponse({ disciplines: [] })));

    render(<CoachDisciplinesPage />);
    await lookUp();

    expect(await screen.findByText(/grappling: technique only/i)).toBeInTheDocument();
  });
});

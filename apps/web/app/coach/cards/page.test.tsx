/**
 * @jest-environment jsdom
 */

// Coach Cards page. What these pin: the form's two modes really swap the
// target picker (athlete roster vs program catalog); a group issue posts
// program_id and then renders the issued/skipped report VERBATIM -- a card
// that reached 2 of 3 members must say who was skipped, not imply everyone
// got it; the verify button wires into the EXISTING completions verify
// endpoint with the card's own athlete_id; and the no-frequency semantics
// (four 25% logs complete a card) are stated to the coach rather than
// silently imposed.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

import CoachCardsPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

// full_name, because that is what getAthletesForCoach selects and therefore
// what /api/pilot/athletes/list sends. The first version of this mock said
// display_name -- a key the server has never produced -- so it pinned the
// page's bug in place instead of catching it.
const ROSTER = [
  { athlete_id: 'ath-1', full_name: 'Anna Cards' },
  { athlete_id: 'ath-2', full_name: 'Bela Cards' },
];

const PROGRAMS = [
  { program_id: 'prog-1', program_name: 'Junior Boxing', status: 'active', active_member_count: 3 },
  { program_id: 'prog-2', program_name: 'Old Guard', status: 'archived', active_member_count: 0 },
];

const REPORT = {
  program_id: 'prog-1',
  program_name: 'Junior Boxing',
  issuance_id: 'issuance-1',
  issued: [
    { athlete_id: 'ath-1', athlete_name: 'Anna Cards', assignment_id: 'asg-1' },
    { athlete_id: 'ath-3', athlete_name: 'Cora Cards', assignment_id: 'asg-2' },
  ],
  skipped: [{ athlete_id: 'ath-2', athlete_name: 'Bela Cards' }],
};

const CARD_GROUP = {
  issuance_id: 'issuance-1',
  assigned_at: '2026-08-20T10:00:00Z',
  cards: [
    {
      assignment_id: 'asg-1',
      athlete_id: 'ath-1',
      athlete_name: 'Anna Cards',
      issuance_id: 'issuance-1',
      drill_name: 'Jump rope',
      drill_description: 'Ten minutes, no misses',
      drill_display_name: 'Jump rope',
      drill_display_description: 'Ten minutes, no misses',
      drill_difficulty: 'beginner',
      rep_count: null,
      duration_minutes: null,
      frequency_per_week: 3,
      due_date: null,
      status: 'in_progress',
      completion_percentage: 33,
      assigned_at: '2026-08-20T10:00:00Z',
      completions: [
        {
          completion_id: 'comp-1',
          completed_at: '2026-08-21T09:00:00Z',
          reps_completed: null,
          notes: 'Before school',
          verification_status: 'pending',
          verified_at: null,
        },
      ],
    },
  ],
};

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function installFetch(options: { cardsPostResponse?: unknown } = {}) {
  const calls: FetchCall[] = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/api/pilot/athletes/list')) {
      return { ok: true, status: 200, json: async () => ({ items: ROSTER }) };
    }
    if (url.includes('/api/pilot/admin/programs')) {
      return { ok: true, status: 200, json: async () => ({ items: PROGRAMS }) };
    }
    if (url.includes('/api/pilot/drills')) {
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }
    if (url.includes('/api/pilot/coach/cards') && init?.method === 'POST') {
      return { ok: true, status: 201, json: async () => options.cardsPostResponse ?? REPORT };
    }
    if (url.includes('/api/pilot/coach/cards')) {
      return { ok: true, status: 200, json: async () => ({ items: [CARD_GROUP] }) };
    }
    if (url.includes('/api/pilot/progression/completions')) {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  }) as unknown as typeof fetch;
  return calls;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('the two form modes swap the target picker: roster athletes vs ACTIVE programs only', async () => {
  installFetch();

  await act(async () => {
    render(<CoachCardsPage />);
  });

  // Athlete mode is the default: the roster select is present, and it shows
  // the athlete's NAME. Asserting the id is absent is the half that matters
  // -- the bug this pins rendered `display_name || athlete_id`, and since
  // display_name was a key the server never sends, every option silently
  // fell back to the raw id. A test that only looked for a truthy option,
  // or matched on the id, would have passed straight through that.
  const athleteSelect = screen.getByLabelText('Athlete');
  const options = within(athleteSelect).getAllByRole('option');
  // Placeholder plus the two roster rows.
  expect(options.map((option) => option.textContent)).toEqual([
    'Choose from roster…',
    'Anna Cards',
    'Bela Cards',
  ]);
  // The value stays the id -- it is what gets POSTed -- while the label is
  // the name. Both halves are checked so a fix that swapped them would fail.
  expect(options.map((option) => (option as HTMLOptionElement).value)).toEqual(['', 'ath-1', 'ath-2']);
  expect(within(athleteSelect).queryByText('ath-1')).toBeNull();
  expect(screen.queryByLabelText('Program')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Whole program' }));

  const programSelect = screen.getByLabelText('Program');
  expect(within(programSelect).getByText('Junior Boxing (3 active)')).toBeTruthy();
  // Archived programs are history, not a target for new work.
  expect(within(programSelect).queryByText(/Old Guard/)).toBeNull();
  expect(screen.queryByLabelText('Athlete')).toBeNull();
});

test('a group issue posts program_id and renders the issued/skipped report verbatim', async () => {
  const calls = installFetch();

  await act(async () => {
    render(<CoachCardsPage />);
  });

  fireEvent.click(screen.getByRole('button', { name: 'Whole program' }));
  fireEvent.change(screen.getByLabelText('Program'), { target: { value: 'prog-1' } });
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Jump rope' } });
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Ten minutes, no misses' } });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Issue to program' }));
  });

  const post = calls.find((call) => call.url.includes('/api/pilot/coach/cards') && call.init?.method === 'POST');
  expect(post).toBeTruthy();
  const body = JSON.parse(String(post!.init!.body));
  expect(body.program_id).toBe('prog-1');
  expect(body.athlete_id).toBeUndefined();
  expect(body.title).toBe('Jump rope');

  // The report, verbatim: who got it AND who did not.
  const reportSection = await screen.findByLabelText('Issuance report');
  expect(within(reportSection).getByText('2 issued, 1 skipped.')).toBeTruthy();
  expect(within(reportSection).getByText('Cora Cards')).toBeTruthy();
  expect(within(reportSection).getByText('Bela Cards')).toBeTruthy();
  expect(within(reportSection).getByText(/Skipped/)).toBeTruthy();
});

test('verify and dispute wire into the existing completions endpoint with the card\'s athlete', async () => {
  const calls = installFetch();

  await act(async () => {
    render(<CoachCardsPage />);
  });

  // 'Anna Cards' also sits in the roster select; the card list is ready
  // once the issued card's title is on the page.
  await screen.findByText('Jump rope');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
  });

  await waitFor(() => {
    const verifyCall = calls.find((call) => call.url.includes('/api/pilot/progression/completions'));
    expect(verifyCall).toBeTruthy();
    const body = JSON.parse(String(verifyCall!.init!.body));
    expect(body).toEqual({
      completion_id: 'comp-1',
      athlete_id: 'ath-1',
      verify: true,
      verified: true,
    });
  });
});

test('the no-frequency auto-complete semantics are stated to the coach, not silently imposed', async () => {
  installFetch();

  await act(async () => {
    render(<CoachCardsPage />);
  });

  expect(screen.getByText(/each logged session counts 25% and four logs complete the card/)).toBeTruthy();
  // No default is written into the field for the coach.
  expect((screen.getByLabelText('Sessions per week (optional)') as HTMLInputElement).value).toBe('');
});

// Leaving the page mid-load must abandon the load, not finish writing into
// an unmounted tree. The failure this prevents is not abstract on this
// page: the finally block's setLoading(false) would swap "Loading cards…"
// for "No cards issued yet", which is a claim about the gym made by a
// request nobody is waiting for any more.
test('unmounting mid-load aborts every request and writes no state after', async () => {
  const controllers: AbortSignal[] = [];
  let resolveRoster: ((value: unknown) => void) | undefined;

  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal) controllers.push(init.signal);
    if (String(input).includes('/api/pilot/athletes/list')) {
      // Hold the first read open so the unmount lands mid-flight.
      return new Promise((resolve) => {
        resolveRoster = resolve;
      });
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  }) as unknown as typeof fetch;

  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  const view = render(<CoachCardsPage />);
  // Every fetch the effect started carries the effect's signal.
  expect(controllers.length).toBeGreaterThan(0);
  expect(controllers.every((signal) => signal.aborted === false)).toBe(true);

  view.unmount();

  // The cleanup aborted them all.
  expect(controllers.every((signal) => signal.aborted)).toBe(true);

  // Let the held request settle after unmount; nothing may be written.
  await act(async () => {
    resolveRoster?.({ ok: true, status: 200, json: async () => ({ items: [{ athlete_id: 'ath-1', full_name: 'Anna Cards' }] }) });
  });

  // React logs an act/update-after-unmount warning through console.error if
  // state is written into an unmounted tree.
  expect(errorSpy).not.toHaveBeenCalled();
  errorSpy.mockRestore();
});

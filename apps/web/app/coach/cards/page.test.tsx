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

const ROSTER = [
  { athlete_id: 'ath-1', display_name: 'Anna Cards' },
  { athlete_id: 'ath-2', display_name: 'Bela Cards' },
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

  // Athlete mode is the default: the roster select is present.
  const athleteSelect = screen.getByLabelText('Athlete');
  expect(within(athleteSelect).getByText('Anna Cards')).toBeTruthy();
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

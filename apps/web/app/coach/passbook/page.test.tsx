/**
 * @jest-environment jsdom
 */

/*
 * One athlete's Passbook for staff (work order N7-01). What is pinned here:
 * nothing is fetched until an athlete is chosen; exactly one athlete_id goes
 * per request; a refusal, a missing book and a failed load each read as what
 * they are and never as an empty book; a slow book for the previous athlete
 * never renders under the next; ?athlete_id= opens only an athlete on the
 * coach's own roster; account ids and date of birth are not rendered; gap text
 * is shown as the server sent it.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import CoachPassbookPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

// Shaped like AthletePassbook for a staff reader (src/server/pilot/passbook.ts).
function book(athleteId: string, name: string) {
  return {
    athlete: {
      athlete_id: athleteId,
      full_name: name,
      dob: '2012-03-04',
      weight_class: '57 kg',
      gym_status: 'active',
      active_flag: true,
      coach_id: 'coach.login@example.org',
      created_at: '2026-01-01T00:00:00.000Z',
      canonical_gym_status: 'active',
      gym_status_domain: 'canonical',
    },
    pages: {
      attendance: [
        { attendance_id: 'a1', attendance_date: '2026-10-01', status: 'present', canonical_status: 'present', stamp_code: 'PRESENT', domain_status: 'canonical', notes: 'Came early' },
      ],
      sessions: [
        // rpe is nullable in the type (session_rpe_semantics migration); kept to pin the 'not recorded' branch.
        { session_id: 's1', date: '2026-10-01', rpe: null, notes: 'Felt slow', completed_flag: true },
        { session_id: 's2', date: '2026-09-28', rpe: 6, completed_flag: false },
      ],
      readiness: [{ readiness_id: 'rd1', score: 72, category: 'green', measured_at: '2026-10-01' }],
      goals: [{ goal_id: 'go1', title: 'Make weight', target_date: '2026-11-15', metric: 'kg', status: 'active' }],
      corner: {
        coach: { account_id: 'coach.login@example.org' },
        guardians: [{ parent_id: 'p1', full_name: 'Pat Parent', relationship_to_athlete: 'mother' }],
        observations: [
          { note_id: 'n1', coach_account_id: 'coach.login@example.org', note_type: 'coach_observation', note_text: 'Guard is higher', created_at: '2026-10-02T12:00:00.000Z' },
        ],
      },
      progression_gaps: [
        { gap_id: 'g1', gap_type: 'endurance', gap_description: 'Missed 3 of the last 4 sessions (rule: 3 in 14 days)', severity: 'high', detected_from: 'attendance', status: 'identified', created_at: '2026-10-03T00:00:00.000Z' },
      ],
    },
  };
}

let passbookResponses: Record<string, { status: number; body: unknown }>;
let holdAna: Promise<void> | null;
let holdAnaOnce: Promise<void> | null;
let fetchMock: jest.Mock;

beforeEach(() => {
  holdAna = null;
  holdAnaOnce = null;
  passbookResponses = {
    'ath-1': { status: 200, body: { passbook: book('ath-1', 'Ana Boxer') } },
    'ath-2': { status: 200, body: { passbook: { ...book('ath-2', 'Ben Boxer'), pages: { ...book('ath-2', 'Ben Boxer').pages, attendance: [], sessions: [], readiness: [], goals: [], progression_gaps: [], corner: { coach: {}, guardians: [], observations: [] } } } } },
  };
  window.history.replaceState(null, '', '/coach/passbook');
  fetchMock = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const respond = (status: number, body: unknown) =>
      ({ ok: status < 400, status, json: async () => body }) as Response;
    if (url.endsWith('/api/pilot/coach/athletes')) {
      return respond(200, { items: [
        { athlete_id: 'ath-1', full_name: 'Ana Boxer' },
        { athlete_id: 'ath-2', full_name: 'Ben Boxer' },
      ] });
    }
    const match = /\/api\/pilot\/passbook\?athlete_id=([^&]+)$/.exec(url);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (id === 'ath-1' && holdAna) await holdAna;
      const r = passbookResponses[id] ?? { status: 404, body: { error: 'Not found' } };
      if (id === 'ath-1' && holdAnaOnce) {
        const wait = holdAnaOnce;
        holdAnaOnce = null;
        await wait;
        return respond(500, {});
      }
      return respond(r.status, r.body);
    }
    return respond(404, {});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

function passbookCalls(): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/api/pilot/passbook'));
}

async function open(id = 'ath-1') {
  render(<CoachPassbookPage />);
  await act(async () => {});
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: id } });
  });
}

test('nothing is fetched until an athlete is chosen', async () => {
  render(<CoachPassbookPage />);
  await act(async () => {});
  expect(passbookCalls()).toEqual([]);
  expect(screen.queryByText('Attendance')).toBeNull();
});

test('opens one athlete\'s book with exactly one athlete_id', async () => {
  await open();
  expect(passbookCalls()).toHaveLength(1);
  expect(passbookCalls()[0]).toMatch(/\/api\/pilot\/passbook\?athlete_id=ath-1$/);
  const text = document.body.textContent ?? '';
  expect(screen.getByRole('heading', { name: 'Ana Boxer' })).toBeTruthy();
  expect(text).toContain('PRESENT');
  expect(text).toContain('Came early');
  expect(text).toContain('RPE not recorded');
  expect(text).toContain('RPE 6');
  expect(text).toContain('Guard is higher');
  expect(text).toContain('Pat Parent (mother)');
  // Gap text is the server's, shown verbatim, rule numbers and all, for staff.
  expect(text).toContain('Missed 3 of the last 4 sessions (rule: 3 in 14 days)');
  // Date-only columns render as the stored calendar day, not the day before.
  expect(text).toContain('October 1, 2026: PRESENT');
  expect(text).toContain('Make weight · kg · by November 15, 2026');
  // An empty page says so instead of vanishing.
  const readiness = screen.getByRole('heading', { name: 'Readiness' }).closest('section')!;
  expect(readiness.textContent).not.toContain('Nothing recorded.');
});

test('account ids and date of birth are not rendered', async () => {
  await open();
  const text = document.body.textContent ?? '';
  expect(text).not.toContain('coach.login@example.org');
  expect(text).not.toContain('2012');
});

test('a refused athlete shows the refusal and nothing from any book', async () => {
  passbookResponses['ath-1'] = { status: 403, body: { error: 'Forbidden' } };
  await open();
  expect(screen.getByRole('alert').textContent).toContain('You do not have access to this athlete');
  expect(screen.queryByRole('heading', { name: 'Attendance' })).toBeNull();
  expect(document.body.textContent).not.toContain('Nothing recorded.');
});

test('a missing book reads as missing, not empty', async () => {
  passbookResponses['ath-1'] = { status: 404, body: { error: 'Not found' } };
  await open();
  expect(document.body.textContent).toContain('No passbook was found for this athlete.');
  expect(screen.queryByRole('heading', { name: 'Attendance' })).toBeNull();
});

test('a failed load reads as unavailable, never as an empty book', async () => {
  passbookResponses['ath-1'] = { status: 500, body: { error: 'boom' } };
  await open();
  expect(screen.getByRole('alert').textContent).toContain('This passbook could not be loaded.');
  expect(document.body.textContent).not.toContain('Nothing recorded.');
});

test('a book for a different athlete than the one asked for is not shown', async () => {
  passbookResponses['ath-1'] = { status: 200, body: { passbook: book('ath-2', 'Ben Boxer') } };
  await open();
  expect(screen.getByRole('alert').textContent).toContain('This passbook could not be loaded.');
  expect(screen.queryByRole('heading', { name: 'Ben Boxer' })).toBeNull();
});

test('a slow book for the previous athlete never renders under the next', async () => {
  let release!: () => void;
  holdAna = new Promise<void>((resolve) => { release = resolve; });
  render(<CoachPassbookPage />);
  await act(async () => {});
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-1' } });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-2' } });
  });
  await act(async () => { release(); });
  expect(screen.getByRole('heading', { name: 'Ben Boxer' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Ana Boxer' })).toBeNull();
  expect(document.body.textContent).not.toContain('Guard is higher');
});

test('?athlete_id= opens a rostered athlete', async () => {
  window.history.replaceState(null, '', '/coach/passbook?athlete_id=ath-2');
  render(<CoachPassbookPage />);
  await act(async () => {});
  await act(async () => {});
  expect(passbookCalls()).toEqual([expect.stringMatching(/athlete_id=ath-2$/)]);
  expect(screen.getByRole('heading', { name: 'Ben Boxer' })).toBeTruthy();
});

test('?athlete_id= for an athlete not on the roster is ignored, not fetched', async () => {
  window.history.replaceState(null, '', '/coach/passbook?athlete_id=ath-9');
  render(<CoachPassbookPage />);
  await act(async () => {});
  await act(async () => {});
  expect(passbookCalls()).toEqual([]);
  expect((screen.getByLabelText('Which athlete') as HTMLSelectElement).value).toBe('');
});

test('a roster that fails to load is not read as having no athletes', async () => {
  fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response);
  render(<CoachPassbookPage />);
  await act(async () => {});
  expect(screen.getByRole('alert').textContent).toContain('This is not a statement that you have none');
  expect(document.body.textContent).not.toContain('No athletes are on your list.');
});

test('an empty page of the book says so', async () => {
  await open('ath-2');
  const goals = screen.getByRole('heading', { name: 'Goals' }).closest('section')!;
  expect(goals.textContent).toContain('Nothing recorded.');
});

test('while a book loads, it says so and shows no page of any book', async () => {
  let release!: () => void;
  holdAna = new Promise<void>((resolve) => { release = resolve; });
  await open();
  expect(document.body.textContent).toContain('Loading…');
  expect(screen.queryByRole('heading', { name: 'Attendance' })).toBeNull();
  await act(async () => { release(); });
  expect(screen.getByRole('heading', { name: 'Attendance' })).toBeTruthy();
});

test('a lapsed sign-in (401) is not told it has no access to the athlete', async () => {
  passbookResponses['ath-1'] = { status: 401, body: { error: 'Unauthorized' } };
  await open();
  expect(screen.getByRole('alert').textContent).toContain('This passbook could not be loaded.');
  expect(document.body.textContent).not.toContain('You do not have access');
});

test('a late failure from an earlier pick never hides a newer book for the same athlete', async () => {
  let release!: () => void;
  holdAnaOnce = new Promise<void>((resolve) => { release = resolve; });
  await open('ath-1');
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-2' } });
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Which athlete'), { target: { value: 'ath-1' } });
  });
  await act(async () => { release(); });
  expect(screen.getByRole('heading', { name: 'Ana Boxer' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

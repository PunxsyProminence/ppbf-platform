/**
 * @jest-environment jsdom
 */

// Repeat weekly on Schedule Class (lane LW). The coach ticks it, picks a number
// of weeks (default 4) or a last date, sees what will be made, and one press
// makes them. Every press carries a request key: kept when the answer never
// came, so pressing again cannot make the classes twice; replaced once the
// server has answered.

import '@testing-library/jest-dom';

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { readonly href: string; readonly children: ReactNode }) => <a href={href}>{children}</a>,
}));

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import SchedulerPage from './page';

type PostAnswer = 'lost' | Record<string, unknown>;

function installFetchMock(answers: PostAnswer[]): jest.Mock {
  const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (payload: unknown, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(payload) } as Response);

    if (url.endsWith('/api/pilot/auth/session')) return json({ authenticated: true, role: 'coach', athlete_id: null });
    if (url.endsWith('/api/pilot/athletes/list')) return json({ items: [] });
    if (url.endsWith('/api/pilot/scheduler') && init?.method === 'POST') {
      const answer = answers.shift() ?? { ok: true, class_ids: ['c-1'] };
      if (answer === 'lost') return Promise.reject(new TypeError('Failed to fetch'));
      return json(answer, answer.ok === true);
    }
    if (url.endsWith('/api/pilot/scheduler')) {
      return json({ ok: true, role: 'coach', classes: [], registrations: [], coaching_requests: [], attendance: [] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function creates(fetchMock: jest.Mock): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith('/api/pilot/scheduler') && (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>)
    .filter((body) => body.action === 'create_class');
}

async function renderPage() {
  render(<SchedulerPage />);
  await screen.findByText('Class Schedule');
}

function fillClass() {
  fireEvent.change(screen.getByPlaceholderText('Class title'), { target: { value: 'Evening boxing' } });
  // Tuesday; the clocks go back on Sunday 1 November 2026.
  fireEvent.change(screen.getByLabelText('Class starts'), { target: { value: '2026-10-27T18:00' } });
  fireEvent.change(screen.getByLabelText('Class ends'), { target: { value: '2026-10-27T19:30' } });
  fireEvent.change(screen.getByPlaceholderText('Location'), { target: { value: 'Main Floor' } });
}

async function pressSchedule() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Schedule Class' }));
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Repeat weekly on Schedule Class', () => {
  test('ticked: 4 weeks by default, the dates shown before sending, and the press asks for 4', async () => {
    const fetchMock = installFetchMock([{ ok: true, class_ids: ['c-1', 'c-2', 'c-3', 'c-4'], already_created: false }]);
    await renderPage();
    fillClass();
    expect(screen.queryByLabelText('Number of weeks')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Repeat weekly'));
    expect(screen.getByLabelText('Number of weeks')).toHaveValue(4);
    expect(screen.getByText('Makes 4 classes, Tue, Oct 27 to Tue, Nov 17, 6:00 PM each week.')).toBeInTheDocument();

    await pressSchedule();
    const [sent] = creates(fetchMock);
    expect(sent).toMatchObject({ action: 'create_class', title: 'Evening boxing', start_at: '2026-10-27T18:00', repeat_weeks: 4 });
    expect(sent).not.toHaveProperty('repeat_until');
    expect(typeof sent.request_key).toBe('string');
    expect(await screen.findByText('4 weekly classes scheduled.')).toBeInTheDocument();
  });

  test('the weeks box can be cleared and retyped', async () => {
    installFetchMock([]);
    await renderPage();
    fillClass();
    fireEvent.click(screen.getByLabelText('Repeat weekly'));
    const weeks = screen.getByLabelText('Number of weeks');

    fireEvent.change(weeks, { target: { value: '' } });
    expect(weeks).toHaveValue(null);
    expect(screen.getByText('Repeat weekly runs for 1 to 12 weeks.')).toBeInTheDocument();

    fireEvent.change(weeks, { target: { value: '8' } });
    expect(weeks).toHaveValue(8);
    expect(screen.getByText('Makes 8 classes, Tue, Oct 27 to Tue, Dec 15, 6:00 PM each week.')).toBeInTheDocument();
  });

  test('until a date sends the date, and a range past 12 weeks says so before sending', async () => {
    const fetchMock = installFetchMock([{ ok: true, class_ids: ['c-1', 'c-2', 'c-3'] }]);
    await renderPage();
    fillClass();
    fireEvent.click(screen.getByLabelText('Repeat weekly'));
    fireEvent.change(screen.getByLabelText('Repeat for'), { target: { value: 'until' } });

    fireEvent.change(screen.getByLabelText('Last class on or before'), { target: { value: '2027-03-01' } });
    expect(screen.getByText('Repeat weekly runs for at most 12 weeks. Pick an earlier end date.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Last class on or before'), { target: { value: '2026-11-10' } });
    expect(screen.getByText('Makes 3 classes, Tue, Oct 27 to Tue, Nov 10, 6:00 PM each week.')).toBeInTheDocument();

    await pressSchedule();
    const [sent] = creates(fetchMock);
    expect(sent).toMatchObject({ repeat_until: '2026-11-10' });
    expect(sent).not.toHaveProperty('repeat_weeks');
  });

  test('not ticked: one class, no repeat asked for', async () => {
    const fetchMock = installFetchMock([{ ok: true, class_ids: ['c-1'] }]);
    await renderPage();
    fillClass();
    await pressSchedule();
    const [sent] = creates(fetchMock);
    expect(sent).not.toHaveProperty('repeat_weeks');
    expect(sent).not.toHaveProperty('repeat_until');
    expect(await screen.findByText('Class scheduled successfully.')).toBeInTheDocument();
  });

  test('a lost answer keeps the key, so pressing again is the same request; an answer replaces it', async () => {
    const fetchMock = installFetchMock([
      'lost',
      { ok: true, class_ids: ['c-1', 'c-2', 'c-3', 'c-4'], already_created: true },
      { ok: true, class_ids: ['c-9'] },
    ]);
    await renderPage();
    fillClass();
    fireEvent.click(screen.getByLabelText('Repeat weekly'));

    await pressSchedule();
    await pressSchedule();
    expect(await screen.findByText('Already scheduled: your earlier tap went through. Nothing was added twice.')).toBeInTheDocument();

    fillClass();
    await pressSchedule();
    const sent = creates(fetchMock);
    expect(sent).toHaveLength(3);
    expect(sent[1].request_key).toBe(sent[0].request_key);
    expect(sent[2].request_key).not.toBe(sent[1].request_key);
  });

  test('a refusal from the server replaces the key too: nothing was made under it', async () => {
    const fetchMock = installFetchMock([
      { ok: false, error: 'end_at must be after start_at' },
      { ok: true, class_ids: ['c-1'] },
    ]);
    await renderPage();
    fillClass();
    await pressSchedule();
    expect(await screen.findByText('end_at must be after start_at')).toBeInTheDocument();
    await pressSchedule();
    const sent = creates(fetchMock);
    expect(sent[1].request_key).not.toBe(sent[0].request_key);
  });
});

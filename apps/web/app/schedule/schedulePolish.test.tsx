/**
 * @jest-environment jsdom
 */

// Pilot polish on /schedule (lane LPOL; audit F-167 and the Repeat weekly leftover).
//   - Title, Location and Places have visible labels, not placeholder text only.
//   - After Schedule Class saves, the list never says "no upcoming classes" while
//     the re-read that will show the new class is still in flight.
//   - A Schedule Class press whose answer never came keeps its request key across
//     a reload, and the key is dropped once the server answers.
// Every case fails on main (checked in a scratch worktree at origin/main): the
// labels, the "Updating the list" line and the stored key do not exist there, and
// the cases fill the form by its new labels.

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

const STORAGE_KEY = 'ppbf.schedule.pendingCreateClassKey';

const PAST_CLASS = {
  class_id: 'class-past', title: 'Last Month Boxing',
  start_at: '2026-09-01T22:00:00.000Z', end_at: '2026-09-01T23:00:00.000Z',
  location: 'Main Floor', capacity: 16, coach_account_id: 'acct-coach', status: 'open', registered_count: 0,
};
const NEW_CLASS = {
  class_id: 'class-new', title: 'Evening boxing',
  start_at: new Date(Date.now() + 86_400_000).toISOString(), end_at: new Date(Date.now() + 90_000_000).toISOString(),
  location: 'Main Floor', capacity: 16, coach_account_id: 'acct-coach', status: 'open', registered_count: 0,
};

type PostAnswer = 'lost' | Record<string, unknown>;

interface Setup {
  /** What the first scheduler GET returns. */
  firstClasses: unknown[];
  /** POST answers, in order; the default is a plain yes. */
  answers?: PostAnswer[];
  /** When set, every scheduler GET after the first waits for this promise's resolve. */
  hold?: { release: (classes: unknown[]) => void };
}

function install({ firstClasses, answers = [], hold }: Setup): jest.Mock {
  let schedulerGets = 0;
  let held: Promise<unknown[]> | null = null;
  if (hold) {
    held = new Promise<unknown[]>((resolve) => { hold.release = resolve; });
  }
  const json = (payload: unknown, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(payload) } as Response);
  const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/pilot/auth/session')) return json({ authenticated: true, role: 'coach', athlete_id: null });
    if (url.endsWith('/api/pilot/athletes/list')) return json({ items: [] });
    if (url.endsWith('/api/pilot/scheduler') && init?.method === 'POST') {
      const answer = answers.shift() ?? { ok: true, class_ids: ['class-new'] };
      if (answer === 'lost') return Promise.reject(new TypeError('Failed to fetch'));
      return json(answer, answer.ok === true);
    }
    if (url.endsWith('/api/pilot/scheduler')) {
      schedulerGets += 1;
      const body = (classes: unknown[]) => ({ ok: true, role: 'coach', classes, registrations: [], coaching_requests: [], attendance: [] });
      if (schedulerGets > 1 && held) return held.then((classes) => ({ ok: true, json: () => Promise.resolve(body(classes)) }) as Response);
      return json(body(firstClasses));
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
  const view = render(<SchedulerPage />);
  await screen.findByText('Class Schedule');
  return view;
}

function fillClass() {
  fireEvent.change(screen.getByLabelText('Class title'), { target: { value: 'Evening boxing' } });
  fireEvent.change(screen.getByLabelText('Class starts'), { target: { value: '2026-10-27T18:00' } });
  fireEvent.change(screen.getByLabelText('Class ends'), { target: { value: '2026-10-27T19:30' } });
  fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Main Floor' } });
}

async function pressSchedule() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Schedule Class' }));
  });
}

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  jest.restoreAllMocks();
  window.sessionStorage.clear();
});

describe('Schedule New Class: visible labels (F-167)', () => {
  test('Class title, Location and Places in the class each have a visible label tied to the box', async () => {
    install({ firstClasses: [] });
    await renderPage();

    for (const [text, box] of [
      ['Class title', 'new-class-title'],
      ['Location', 'new-class-location'],
      ['Places in the class', 'new-class-places'],
    ] as const) {
      const label = screen.getByText(text, { selector: 'label' });
      expect(label).toBeVisible();
      expect(label).toHaveAttribute('for', box);
      expect(document.getElementById(box)).not.toBeNull();
    }
  });
});

describe('after Schedule Class saves (F-167)', () => {
  test('the list says it is updating, not "No classes scheduled yet", until the re-read answers; then the class shows', async () => {
    const hold: { release: (classes: unknown[]) => void } = { release: () => {} };
    const fetchMock = install({ firstClasses: [], hold });
    await renderPage();
    expect(screen.getByText('No classes scheduled yet.')).toBeInTheDocument();

    fillClass();
    await pressSchedule();

    expect(await screen.findByText('Class scheduled successfully.')).toBeInTheDocument();
    expect(creates(fetchMock)).toHaveLength(1);
    expect(screen.queryByText('No classes scheduled yet.')).toBeNull();
    expect(screen.getByText('Updating the list…')).toBeInTheDocument();

    await act(async () => {
      hold.release([NEW_CLASS]);
    });
    expect(await screen.findByText('Evening boxing')).toBeInTheDocument();
    expect(screen.queryByText('Updating the list…')).toBeNull();
    expect(screen.queryByText('No upcoming classes.')).toBeNull();
  });

  test('with only past classes on the list, "No upcoming classes." waits for the re-read too', async () => {
    const hold: { release: (classes: unknown[]) => void } = { release: () => {} };
    install({ firstClasses: [PAST_CLASS], hold });
    await renderPage();
    expect(screen.getByText('No upcoming classes.')).toBeInTheDocument();

    fillClass();
    await pressSchedule();

    expect(await screen.findByText('Class scheduled successfully.')).toBeInTheDocument();
    expect(screen.queryByText('No upcoming classes.')).toBeNull();
    expect(screen.getByText('Updating the list…')).toBeInTheDocument();

    await act(async () => {
      hold.release([PAST_CLASS, NEW_CLASS]);
    });
    expect(await screen.findByText('Evening boxing')).toBeInTheDocument();
    expect(screen.queryByText('Updating the list…')).toBeNull();
  });
});

describe('a Schedule Class press nobody answered keeps its key across a reload (lane LW leftover)', () => {
  test('a lost answer, then a reload: the next press sends the same key; an answer clears it', async () => {
    const fetchMock = install({
      firstClasses: [],
      answers: ['lost', { ok: true, class_ids: ['c-1'], already_created: true }, { ok: true, class_ids: ['c-2'] }],
    });
    const first = await renderPage();
    fillClass();
    await pressSchedule();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(creates(fetchMock)[0].request_key);

    // The tab is reloaded before the person presses again: a new page, the same tab.
    first.unmount();
    await renderPage();
    fillClass();
    await pressSchedule();
    expect(await screen.findByText('Already scheduled: your earlier tap went through. Nothing was added twice.')).toBeInTheDocument();
    const sent = creates(fetchMock);
    expect(sent).toHaveLength(2);
    expect(sent[1].request_key).toBe(sent[0].request_key);

    // The server answered, so the key is dropped and the next press is a new request.
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    fillClass();
    await pressSchedule();
    expect(creates(fetchMock)[2].request_key).not.toBe(sent[1].request_key);
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test('a refusal is an answer: the key is dropped after it', async () => {
    const fetchMock = install({
      firstClasses: [],
      answers: [{ ok: false, error: 'end_at must be after start_at' }, { ok: true, class_ids: ['c-1'] }],
    });
    const first = await renderPage();
    fillClass();
    await pressSchedule();
    expect(await screen.findByText('end_at must be after start_at')).toBeInTheDocument();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();

    first.unmount();
    await renderPage();
    fillClass();
    await pressSchedule();
    const sent = creates(fetchMock);
    expect(sent[1].request_key).not.toBe(sent[0].request_key);
  });

  test('a stored value that is not a request key is ignored, not sent', async () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'x');
    const fetchMock = install({ firstClasses: [] });
    await renderPage();
    fillClass();
    await pressSchedule();
    const [sent] = creates(fetchMock);
    expect(sent.request_key).not.toBe('x');
    expect(String(sent.request_key)).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });

  test('when the tab refuses storage, the page still schedules a class and keeps the key in memory', async () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('blocked'); });
    const fetchMock = install({ firstClasses: [], answers: ['lost', { ok: true, class_ids: ['c-1'] }] });
    await renderPage();
    fillClass();
    await pressSchedule();
    await pressSchedule();

    const sent = creates(fetchMock);
    expect(sent).toHaveLength(2);
    expect(sent[1].request_key).toBe(sent[0].request_key);
    expect(await screen.findByText('Class scheduled successfully.')).toBeInTheDocument();
  });
});

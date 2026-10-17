/**
 * @jest-environment jsdom
 */

// UXB-L9 (lane U3): the schedule keeps its place after a tap, clears a sent
// form, reads a broken reply as words, offers Check again, shows coaches by
// name only, and asks twice before declining a coaching request. Every case
// fails on main except "keeps what was typed when the request is refused",
// which guards that clearing happens on success only.

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { readonly href: string; readonly children: ReactNode }) => <a href={href}>{children}</a>,
}));
jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import SchedulerPage from './page';

type Role = 'coach' | 'organization_admin';

const CLASSES = [{
  class_id: 'class-1', title: 'Youth Boxing',
  start_at: new Date(Date.now() + 86_400_000).toISOString(), end_at: new Date(Date.now() + 90_000_000).toISOString(),
  location: 'Main Floor', capacity: 16, coach_account_id: 'acct-jane', status: 'open', registered_count: 0,
}];
const REQUESTS = [
  { request_id: 'req-1', athlete_id: 'athlete-1', preferred_at: '2099-01-01T15:00:00.000Z', goals: 'Footwork', status: 'pending', created_at: '2026-10-01T00:00:00.000Z' },
];
const MEMBERS = [
  { account_id: 'acct-a', login_email: 'jane.doe@gym.example', role: 'coach', active_flag: true, membership_active: true },
  { account_id: 'acct-b', login_email: 'jane_doe@other.example', role: 'coach', active_flag: true, membership_active: true },
];

interface Options {
  role?: Role;
  schedulerBroken?: () => boolean;
  /** Every scheduler GET after the first stays unanswered: a reload in flight. */
  reloadHangs?: boolean;
  /** What a POST answers: ok, a refusal, or a reply that is not JSON. */
  post?: 'ok' | 'refused' | 'broken';
  authBroken?: boolean;
}

const notJson = (): Promise<Response> => Promise.resolve({
  ok: false, status: 502, json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
} as Response);

function json(payload: unknown, ok = true): Promise<Response> {
  return Promise.resolve({ ok, status: ok ? 200 : 502, json: () => Promise.resolve(payload) } as Response);
}

function install({ role = 'coach', schedulerBroken, reloadHangs, post = 'ok', authBroken }: Options = {}): jest.Mock {
  let schedulerGets = 0;
  const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/pilot/auth/session')) {
      return authBroken ? notJson() : json({ authenticated: true, role, athlete_id: null });
    }
    if (url.endsWith('/api/pilot/athletes/list')) return json({ items: [{ athlete_id: 'athlete-1', full_name: 'My Athlete' }] });
    if (url.endsWith('/api/pilot/admin/staff')) return json({ ok: true, members: MEMBERS });
    if (url.endsWith('/api/pilot/scheduler') && init?.method === 'POST') {
      if (post === 'broken') return notJson();
      return post === 'refused' ? json({ ok: false, error: 'This class was cancelled.' }, false) : json({ ok: true });
    }
    if (url.endsWith('/api/pilot/scheduler')) {
      schedulerGets += 1;
      if (reloadHangs && schedulerGets > 1) return new Promise<Response>(() => {});
      if (schedulerBroken?.()) {
        // A proxy's HTML error page: not JSON at all.
        return Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')) } as Response);
      }
      return json({ ok: true, role, classes: CLASSES, registrations: [], coaching_requests: REQUESTS, attendance: [] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function posts(fetchMock: jest.Mock): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith('/api/pilot/scheduler') && (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('after a tap the page keeps its place and clears what was sent (UXB-16)', () => {
  test('scheduling a class re-reads without "Loading scheduler…" and empties the form', async () => {
    // The re-read never answers, so a page that blanked for it would still be blank.
    const fetchMock = install({ reloadHangs: true });
    render(<SchedulerPage />);
    await screen.findByText('Class Schedule');

    fireEvent.change(screen.getByPlaceholderText('Class title'), { target: { value: 'Saturday Sparring' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Ring' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Schedule Class' }));
    });

    await waitFor(() => expect(posts(fetchMock).map((p) => p.action)).toEqual(['create_class']));
    await screen.findByText('Class scheduled successfully.');
    // The page was never blanked behind the loading line.
    expect(screen.queryByText('Loading scheduler…')).toBeNull();
    expect(screen.getByText('Class Schedule')).toBeTruthy();
    expect((screen.getByPlaceholderText('Class title') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Location') as HTMLInputElement).value).toBe('');
  });
});

describe('the coaching request form', () => {
  test('clears after it is sent (UXB-16)', async () => {
    install();
    render(<SchedulerPage />);
    await screen.findByText('Class Schedule');

    fireEvent.change(screen.getByPlaceholderText('Goals and focus areas'), { target: { value: 'Southpaw footwork' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit Request' }));
    });

    await screen.findByText('Coaching request submitted.');
    expect((screen.getByPlaceholderText('Goals and focus areas') as HTMLTextAreaElement).value).toBe('');
  });

  test('keeps what was typed when the request is refused', async () => {
    install({ post: 'refused' });
    render(<SchedulerPage />);
    await screen.findByText('Class Schedule');

    fireEvent.change(screen.getByPlaceholderText('Goals and focus areas'), { target: { value: 'Southpaw footwork' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit Request' }));
    });

    await screen.findByText('This class was cancelled.');
    expect((screen.getByPlaceholderText('Goals and focus areas') as HTMLTextAreaElement).value).toBe('Southpaw footwork');
  });
});

describe('a broken reply reads as words, with Check again (UXB-09, UXB-13)', () => {
  test('an action reply that is not JSON is words, never a parse error', async () => {
    install({ post: 'broken' });
    render(<SchedulerPage />);
    await screen.findByText('Class Schedule');

    fireEvent.change(screen.getByPlaceholderText('Goals and focus areas'), { target: { value: 'x' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit Request' }));
    });

    expect(await screen.findByText('That did not go through. Check the schedule before trying again.')).toBeTruthy();
    expect(screen.queryByText(/Unexpected token|JSON/)).toBeNull();
  });

  test('a sign-in check that did not read is not "Authentication required"', async () => {
    install({ authBroken: true });
    render(<SchedulerPage />);

    expect(await screen.findByText('Your sign-in could not be checked just now. Try again.')).toBeTruthy();
    expect(screen.queryByText('Authentication required')).toBeNull();
  });

  test('a proxy error page is "could not be loaded", never a parse error; Check again reads again', async () => {
    let broken = true;
    install({ schedulerBroken: () => broken });
    render(<SchedulerPage />);

    expect(await screen.findAllByText('The schedule could not be loaded just now.')).not.toHaveLength(0);
    expect(screen.queryByText(/Unexpected token|JSON/)).toBeNull();

    broken = false;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    });
    expect(await screen.findByText('Youth Boxing')).toBeTruthy();
  });
});

describe('the header says who is signed in, in words (UXB-31)', () => {
  test('no role code and no "Unified Scheduler"', async () => {
    install({ role: 'organization_admin' });
    render(<SchedulerPage />);
    await screen.findByText('Class Schedule');

    // The role in words through the shared roleWords (#1696), never the code.
    expect(screen.getByText('Role: Gym Admin')).toBeTruthy();
    expect(screen.queryByText(/organization_admin/)).toBeNull();
    expect(screen.queryByText('Unified Scheduler')).toBeNull();
    expect(screen.queryByText(/coach\/admin override/)).toBeNull();
  });
});

describe('coaches by name only (Q3, OD-2026-10-06-025)', () => {
  test('two coaches whose names read the same are numbered, and no sign-in address shows', async () => {
    install({ role: 'organization_admin' });
    render(<SchedulerPage />);

    const picker = await screen.findByLabelText(/Coach to assign/);
    await waitFor(() => expect(within(picker).getAllByRole('option').length).toBeGreaterThan(2));
    const labels = within(picker).getAllByRole('option').map((option) => option.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Coach Jane Doe (1 of 2)', 'Coach Jane Doe (2 of 2)']));
    expect(labels.join(' ')).not.toMatch(/@/);
  });
});

describe('declining a coaching request takes a second press (UXB-14)', () => {
  test('the first press arms and sends nothing; the second declines', async () => {
    const fetchMock = install({ role: 'organization_admin' });
    render(<SchedulerPage />);
    await screen.findByText('Class Schedule');
    const decline = await screen.findByRole('button', { name: 'Decline' });

    // ArmedButton ignores presses in its first moments on screen and between
    // the two presses (ARM_SETTLE_MS); move the clock past each.
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start + 1_000);
    fireEvent.click(decline);
    expect(await screen.findByText('Press again: decline')).toBeTruthy();
    expect(posts(fetchMock)).toEqual([]);

    clock.mockReturnValue(start + 2_000);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Press again: decline' }));
    });
    await waitFor(() => expect(posts(fetchMock)).toEqual([{ action: 'review_coaching_request', request_id: 'req-1', decision: 'decline' }]));
  });
});

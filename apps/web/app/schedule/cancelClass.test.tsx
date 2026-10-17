/**
 * @jest-environment jsdom
 */

// Cancel a class on /schedule (#1536, F-059). Cancel Class shows where the
// server says it would be accepted (can_cancel) and takes a second press. A
// cancelled class, or one that has ended, leaves the upcoming list for "Past
// and cancelled", reads Cancelled, and offers no Register or Cover Class.
//
// Pinned on the rendered DOM (jsdom). How it looks on a phone has not been
// checked; that needs a signed-in view on staging.

import '@testing-library/jest-dom';

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { readonly href: string; readonly children: ReactNode }) => <a href={href}>{children}</a>,
}));

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import SchedulerPage from './page';

const HOUR = 3600 * 1000;
const nowIso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function classRow(id: string, title: string, startOffsetMs: number, extra: Record<string, unknown> = {}) {
  return {
    class_id: id,
    title,
    start_at: nowIso(startOffsetMs),
    end_at: nowIso(startOffsetMs + HOUR),
    location: 'Main Floor',
    capacity: 16,
    coach_account_id: 'account-coach',
    status: 'open',
    registered_count: 0,
    ...extra,
  };
}

function installFetchMock(role: 'coach' | 'athlete', classes: ReturnType<typeof classRow>[]): jest.Mock {
  const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (payload: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);

    if (url.endsWith('/api/pilot/auth/session')) {
      return json({ authenticated: true, role, athlete_id: role === 'athlete' ? 'athlete-1' : null });
    }
    if (url.endsWith('/api/pilot/athletes/list')) {
      return json({ items: [{ athlete_id: 'athlete-1', full_name: 'My Athlete' }] });
    }
    if (url.endsWith('/api/pilot/scheduler') && init?.method === 'POST') {
      return json({ ok: true, class_id: 'upcoming', status: 'cancelled' });
    }
    if (url.endsWith('/api/pilot/scheduler')) {
      return json({ ok: true, role, classes, registrations: [], coaching_requests: [], attendance: [] });
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

function rowFor(title: string): HTMLElement {
  const row = screen.getByText(title).closest('div.mat-leather--raised');
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${title}`);
  return row;
}

async function renderPage() {
  render(<SchedulerPage />);
  await screen.findByText('Class Schedule');
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Cancel Class (#1536)', () => {
  test('shows only where the server would accept it, and cancels on the second press', async () => {
    const fetchMock = installFetchMock('coach', [
      classRow('upcoming', 'Mine Tomorrow', 24 * HOUR, { can_cancel: true }),
      classRow('theirs', 'Theirs Tomorrow', 25 * HOUR, { can_cancel: false }),
    ]);
    await renderPage();

    expect(within(rowFor('Theirs Tomorrow')).queryByRole('button', { name: 'Cancel Class' })).not.toBeInTheDocument();

    fireEvent.click(within(rowFor('Mine Tomorrow')).getByRole('button', { name: 'Cancel Class' }));
    expect(posts(fetchMock)).toEqual([]);

    await act(async () => {
      fireEvent.click(within(rowFor('Mine Tomorrow')).getByRole('button', { name: 'Press again to cancel' }));
    });
    expect(posts(fetchMock)).toEqual([{ action: 'cancel_class', class_id: 'upcoming' }]);
    expect(await screen.findByText('Class cancelled.')).toBeInTheDocument();
  });

  test('a cancelled class and an ended class leave the upcoming list for Past and cancelled', async () => {
    installFetchMock('coach', [
      classRow('upcoming', 'Still On', 24 * HOUR, { can_cancel: true }),
      classRow('gone', 'Called Off', 26 * HOUR, { status: 'cancelled' }),
      classRow('ended', 'Last Week', -7 * 24 * HOUR),
    ]);
    await renderPage();

    const heading = screen.getByText('Past and cancelled');
    const below = (title: string) =>
      Boolean(heading.compareDocumentPosition(screen.getByText(title)) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(below('Still On')).toBe(false);
    expect(below('Called Off')).toBe(true);
    expect(below('Last Week')).toBe(true);
  });

  test('a cancelled class reads Cancelled and offers no Register, Cover Class or Cancel Class', async () => {
    installFetchMock('coach', [classRow('gone', 'Called Off', 26 * HOUR, { status: 'cancelled', can_cancel: false })]);
    await renderPage();

    const row = rowFor('Called Off');
    expect(within(row).getByText('Cancelled')).toHaveClass('badge');
    expect(within(row).getByText('✕')).toBeInTheDocument();
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  });

  test('a class that has started is not offered Cancel Class, even with a stale can_cancel (#1595)', async () => {
    installFetchMock('coach', [
      classRow('running', 'Running Now', -10 * 60 * 1000, { can_cancel: true }),
      classRow('soon', 'Starts Soon', 10 * 60 * 1000, { can_cancel: true }),
    ]);
    await renderPage();

    expect(within(rowFor('Running Now')).queryByRole('button', { name: 'Cancel Class' })).not.toBeInTheDocument();
    expect(within(rowFor('Starts Soon')).getByRole('button', { name: 'Cancel Class' })).toBeInTheDocument();
  });

  test('Cancel Class goes when the class starts while the page is open (#1595)', async () => {
    // Only the interval and the clock are faked; fetch and findBy keep real timers.
    jest.useFakeTimers({
      doNotFake: [
        'setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask',
        'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
        'hrtime', 'performance',
      ],
    });
    try {
      installFetchMock('coach', [classRow('soon', 'Starts Soon', 10_000, { can_cancel: true })]);
      await renderPage();
      expect(within(rowFor('Starts Soon')).getByRole('button', { name: 'Cancel Class' })).toBeInTheDocument();

      act(() => {
        jest.advanceTimersByTime(15_000);
      });

      expect(within(rowFor('Starts Soon')).queryByRole('button', { name: 'Cancel Class' })).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a class that has ended offers no Cover Class', async () => {
    installFetchMock('coach', [classRow('ended', 'Last Week', -7 * 24 * HOUR)]);
    await renderPage();

    expect(within(rowFor('Last Week')).queryByRole('button', { name: 'Cover Class' })).not.toBeInTheDocument();
  });

  test('a family sees a cancelled class as Cancelled, with no Register', async () => {
    installFetchMock('athlete', [
      classRow('upcoming', 'Still On', 24 * HOUR),
      classRow('gone', 'Called Off', 26 * HOUR, { status: 'cancelled' }),
    ]);
    await renderPage();

    expect(within(rowFor('Called Off')).getByText('Cancelled')).toBeInTheDocument();
    expect(within(rowFor('Called Off')).queryByRole('button', { name: 'Register' })).not.toBeInTheDocument();
    expect(within(rowFor('Still On')).getByRole('button', { name: 'Register' })).toBeInTheDocument();
  });

  test('a half-pressed Cancel Class is forgotten when another action runs', async () => {
    const fetchMock = installFetchMock('coach', [
      classRow('upcoming', 'Mine Tomorrow', 24 * HOUR, { can_cancel: true }),
      classRow('other', 'Other Tomorrow', 25 * HOUR),
    ]);
    await renderPage();

    fireEvent.click(within(rowFor('Mine Tomorrow')).getByRole('button', { name: 'Cancel Class' }));
    await act(async () => {
      fireEvent.click(within(rowFor('Other Tomorrow')).getByRole('button', { name: 'Cover Class' }));
    });
    await screen.findByText('Coach cover assignment updated.');

    fireEvent.click(within(rowFor('Mine Tomorrow')).getByRole('button', { name: 'Cancel Class' }));

    expect(posts(fetchMock).map((body) => body.action)).toEqual(['cover_class']);
  });

  test('staff open the register on a class still running, and a cancelled one is not offered in the picker (#1596)', async () => {
    installFetchMock('coach', [
      classRow('gone', 'Called Off', 1 * HOUR, { status: 'cancelled' }),
      classRow('upcoming', 'Still On', 24 * HOUR, { can_cancel: true }),
    ]);
    await renderPage();

    const picker = screen.getByDisplayValue(/Still On/) as HTMLSelectElement;
    expect(picker.value).toBe('upcoming');
    expect(Array.from(picker.options).map((option) => option.textContent)).toEqual([
      expect.stringMatching(/^Still On \(.*\)$/),
    ]);
  });

  test('a cancelled class selected for the register offers no attendance action, for staff or a family', async () => {
    installFetchMock('coach', [classRow('gone', 'Called Off', 1 * HOUR, { status: 'cancelled' })]);
    await renderPage();
    expect(screen.queryByRole('button', { name: 'Update Attendance' })).not.toBeInTheDocument();
  });

  test("a family with a cancelled class of today selected is not offered I'm here", async () => {
    const fetchMock = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const json = (payload: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
      if (url.endsWith('/api/pilot/auth/session')) return json({ authenticated: true, role: 'athlete', athlete_id: 'athlete-1' });
      if (url.endsWith('/api/pilot/scheduler')) {
        return json({
          ok: true,
          role: 'athlete',
          classes: [classRow('gone', 'Called Off', 0, { status: 'cancelled' })],
          registrations: [{ registration_id: 'r1', class_id: 'gone', athlete_id: 'athlete-1', requested_by_role: 'athlete', parent_reviewed: true, status: 'registered', created_at: '2026-10-01T00:00:00.000Z' }],
          coaching_requests: [],
          attendance: [],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await renderPage();

    expect(screen.queryByRole('button', { name: "I'm here" })).not.toBeInTheDocument();
  });
});

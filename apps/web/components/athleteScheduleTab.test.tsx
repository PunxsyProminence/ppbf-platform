/**
 * @jest-environment jsdom
 */
// The athlete Schedule tab's in-place read (WO-N5-01). The unified scheduler
// stays the booking authority; this view only reads GET /api/pilot/scheduler
// and draws the athlete's booked sessions apart from the classes still open.

import '@testing-library/jest-dom';
import { render, screen, waitFor, within } from '@testing-library/react';

import { AthleteScheduleView, scheduleLists, type ScheduleClassRow } from './AthleteWorkspace';

jest.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/athlete',
  useSearchParams: () => new URLSearchParams(),
}));
const router = { push: jest.fn(), replace: jest.fn(), refresh: jest.fn() };

const NOW = Date.parse('2026-10-12T12:00:00Z');
const HOUR = 3_600_000;

function klass(id: string, offsetHours: number, overrides: Partial<ScheduleClassRow> = {}): ScheduleClassRow {
  const start = new Date(NOW + offsetHours * HOUR).toISOString();
  return {
    class_id: id,
    title: `Class ${id}`,
    start_at: start,
    end_at: new Date(NOW + (offsetHours + 1) * HOUR).toISOString(),
    location: 'Main ring',
    capacity: 10,
    status: 'open',
    registered_count: 3,
    ...overrides,
  };
}

function respond(body: unknown, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);
}

const fetchMock = jest.fn();

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'nextTick', 'setImmediate'] });
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

function section(name: string) {
  return screen.getByRole('region', { name });
}

describe('scheduleLists', () => {
  test('booked sessions and the open catalogue are separate, soonest first, past and cancelled left out', () => {
    const classes = [
      klass('later', 48),
      klass('past', -2),
      klass('soon', 2),
      klass('gone', 5, { status: 'cancelled' }),
      klass('booked', 24),
      klass('waiting', 30),
    ];
    const lists = scheduleLists(
      classes,
      [
        { registration_id: 'r1', class_id: 'booked', status: 'registered' },
        { registration_id: 'r2', class_id: 'waiting', status: 'waitlisted' },
        { registration_id: 'r3', class_id: 'later', status: 'cancelled' },
        { registration_id: 'r4', class_id: 'past', status: 'registered' },
      ],
      NOW,
    );
    expect(lists.booked.map((entry) => [entry.item.class_id, entry.registration.status])).toEqual([
      ['booked', 'registered'],
      ['waiting', 'waitlisted'],
    ]);
    expect(lists.available.map((item) => item.class_id)).toEqual(['soon', 'later']);
  });
});

describe('scheduleLists, the booked list', () => {
  test('is soonest first whatever order the registrations arrive in, and lists a class once', () => {
    const lists = scheduleLists(
      [klass('late', 30), klass('early', 4)],
      [
        { registration_id: 'r-late', class_id: 'late', status: 'registered' },
        { registration_id: 'r-early', class_id: 'early', status: 'waitlisted' },
        { registration_id: 'r-early-again', class_id: 'early', status: 'registered' },
      ],
      NOW,
    );
    expect(lists.booked.map((entry) => entry.item.class_id)).toEqual(['early', 'late']);
  });

  test('keeps a booked class that has started but not ended', () => {
    const lists = scheduleLists([klass('now', -0.5)], [{ registration_id: 'r', class_id: 'now', status: 'registered' }], NOW);
    expect(lists.booked.map((entry) => entry.item.class_id)).toEqual(['now']);
    expect(lists.available).toEqual([]);
  });

  test('keeps a booked class the gym cancelled, so it does not vanish from the athlete\'s list', () => {
    const lists = scheduleLists(
      [klass('called-off', 6, { status: 'cancelled' })],
      [{ registration_id: 'r', class_id: 'called-off', status: 'registered' }],
      NOW,
    );
    expect(lists.booked.map((entry) => entry.item.status)).toEqual(['cancelled']);
  });
});

describe('AthleteScheduleView', () => {
  test('reads the unified scheduler once, as the signed-in athlete, and books nothing', async () => {
    fetchMock.mockReturnValue(respond({ ok: true, classes: [], registrations: [] }));
    render(<AthleteScheduleView />);
    await screen.findByText('You have no booked sessions.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/pilot\/scheduler$/);
    expect(init).toMatchObject({ method: 'GET', credentials: 'include' });
  });

  test('no classes: both lists say so in words', async () => {
    fetchMock.mockReturnValue(respond({ ok: true, classes: [], registrations: [] }));
    render(<AthleteScheduleView />);
    expect(await screen.findByText('You have no booked sessions.')).toBeInTheDocument();
    expect(screen.getByText('No upcoming classes are scheduled.')).toBeInTheDocument();
  });

  test('future classes are listed with spots left; past ones are not', async () => {
    fetchMock.mockReturnValue(respond({
      ok: true,
      classes: [klass('a', 3, { title: 'Footwork', capacity: 12, registered_count: 4 }), klass('old', -5, { title: 'Yesterday' })],
      registrations: [],
    }));
    render(<AthleteScheduleView />);
    const upcoming = await waitFor(() => section('Upcoming classes'));
    expect(within(upcoming).getByText('Footwork')).toBeInTheDocument();
    expect(within(upcoming).getByText('8 spots left')).toBeInTheDocument();
    expect(screen.queryByText('Yesterday')).not.toBeInTheDocument();
  });

  test('the date, time and place lines use the kiosk body voice, never a size under the floor (AGENT_KERNEL rule 2)', async () => {
    fetchMock.mockReturnValue(respond({
      ok: true,
      classes: [klass('b', 6, { title: 'Sparring Basics', location: 'Ring' }), klass('c', 8, { title: 'Bag Work', location: 'Floor' })],
      registrations: [{ registration_id: 'r1', class_id: 'b', status: 'registered' }],
    }));
    render(<AthleteScheduleView />);
    await waitFor(() => section('Your sessions'));
    for (const place of ['Ring', 'Floor']) {
      const line = screen.getByText((text) => text.endsWith(` · ${place}`));
      expect(line).toHaveClass('t-body');
      expect(line.className).not.toMatch(/--t-(xs|sm)\b/);
    }
  });

  test('a confirmed booking reads "Booked" under Your sessions and is not repeated under Upcoming classes', async () => {
    fetchMock.mockReturnValue(respond({
      ok: true,
      classes: [klass('b', 6, { title: 'Sparring Basics' }), klass('c', 8, { title: 'Bag Work' })],
      registrations: [{ registration_id: 'r1', class_id: 'b', status: 'registered' }],
    }));
    render(<AthleteScheduleView />);
    const mine = await waitFor(() => section('Your sessions'));
    expect(within(mine).getByText('Sparring Basics')).toBeInTheDocument();
    expect(within(mine).getByText('Booked')).toBeInTheDocument();
    const upcoming = section('Upcoming classes');
    expect(within(upcoming).queryByText('Sparring Basics')).not.toBeInTheDocument();
    expect(within(upcoming).getByText('Bag Work')).toBeInTheDocument();
  });

  test('a waitlisted booking reads "Waitlisted"; a cancelled one is not shown as a session', async () => {
    fetchMock.mockReturnValue(respond({
      ok: true,
      classes: [klass('w', 4, { title: 'Waitlisted Class' }), klass('x', 5, { title: 'Dropped Class' })],
      registrations: [
        { registration_id: 'r1', class_id: 'w', status: 'waitlisted' },
        { registration_id: 'r2', class_id: 'x', status: 'cancelled' },
      ],
    }));
    render(<AthleteScheduleView />);
    const mine = await waitFor(() => section('Your sessions'));
    expect(within(mine).getByText('Waitlisted')).toBeInTheDocument();
    expect(within(mine).queryByText('Dropped Class')).not.toBeInTheDocument();
    expect(within(section('Upcoming classes')).getByText('Dropped Class')).toBeInTheDocument();
  });

  test('a booked class the gym cancelled reads "Class cancelled" under Your sessions', async () => {
    fetchMock.mockReturnValue(respond({
      ok: true,
      classes: [klass('k', 6, { title: 'Called Off', status: 'cancelled' })],
      registrations: [{ registration_id: 'r1', class_id: 'k', status: 'registered' }],
    }));
    render(<AthleteScheduleView />);
    const mine = await waitFor(() => section('Your sessions'));
    expect(within(mine).getByText('Called Off')).toBeInTheDocument();
    expect(within(mine).getByText('Class cancelled')).toBeInTheDocument();
    expect(within(mine).queryByText('Booked')).not.toBeInTheDocument();
  });

  test('a full class reads "Full", whether marked full or out of spots', async () => {
    fetchMock.mockReturnValue(respond({
      ok: true,
      classes: [
        klass('f1', 2, { title: 'Marked Full', status: 'full', registered_count: 2 }),
        klass('f2', 3, { title: 'No Spots', capacity: 5, registered_count: 5 }),
      ],
      registrations: [],
    }));
    render(<AthleteScheduleView />);
    const upcoming = await waitFor(() => section('Upcoming classes'));
    expect(within(upcoming).getAllByText('Full')).toHaveLength(2);
  });

  test.each([
    ['a server error', () => respond({ ok: false, error: 'boom' }, 500)],
    ['an unreadable body', () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('x')) } as Response)],
    ['a network failure', () => Promise.reject(new Error('offline'))],
    // A refused answer is not trusted for its lists, even when it carries some.
    ['an error status carrying lists', () => respond({ ok: true, classes: [klass('z', 2)], registrations: [] }, 503)],
    ['a body that says it did not work', () => respond({ ok: false, classes: [klass('z', 2)], registrations: [] })],
  ])('%s says the schedule could not be loaded, never that there are no classes', async (_label, answer) => {
    fetchMock.mockImplementation(answer);
    render(<AthleteScheduleView />);
    expect(await screen.findByText('Your schedule could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText('You have no booked sessions.')).not.toBeInTheDocument();
    expect(screen.queryByText('No upcoming classes are scheduled.')).not.toBeInTheDocument();
  });
});

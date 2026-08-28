/**
 * @jest-environment jsdom
 */

// The rollup is a staff reporting surface over records the gym already keeps.
// What these pin: the empty state never shows while the request is in flight
// ("no athletes" is a claim about the roster, not the network); a loaded row
// carries its numbers; the readiness trend badge only renders when both
// halves of the window have data; and switching the window refetches with
// the selected window_days.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import PerformanceAnalyticsPage from './page';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

const ITEM = {
  athlete_id: 'ath-1',
  full_name: 'Jordan Doe',
  sessions_total: 4,
  sessions_completed: 3,
  avg_rpe: 6.5,
  training_days: 8,
  readiness_count: 6,
  avg_readiness: 7.1,
  readiness_early_avg: 6.4,
  readiness_late_avg: 7.6,
  open_gaps: 1,
  active_assignments: 2,
  avg_assignment_completion: 55,
};

function mockFetch(responder: (url: string) => Promise<Response> | Response) {
  return jest.fn(async (input: RequestInfo | URL) => responder(String(input))) as unknown as typeof fetch;
}

const okWith = (items: unknown[]) =>
  ({ ok: true, json: async () => ({ window_days: 28, items }) }) as Response;

afterEach(() => {
  jest.restoreAllMocks();
});

test('the empty state is withheld while the rollup is still loading', async () => {
  global.fetch = mockFetch(() => new Promise<Response>(() => {}));

  render(<PerformanceAnalyticsPage />);

  await screen.findByText(/Loading performance rollup/);
  expect(screen.queryByText('No athletes on your roster')).toBeNull();
});

test('the empty state appears once loading settles with an empty roster', async () => {
  global.fetch = mockFetch(() => okWith([]));

  render(<PerformanceAnalyticsPage />);

  await screen.findByText('No athletes on your roster');
  await waitFor(() => expect(screen.queryByText(/Loading performance rollup/)).toBeNull());
});

test('a loaded row shows its numbers and a rising readiness trend', async () => {
  global.fetch = mockFetch(() => okWith([ITEM]));

  render(<PerformanceAnalyticsPage />);

  await screen.findByText('Jordan Doe');
  expect(screen.getByText('3/4')).toBeTruthy();
  expect(screen.getByText('8')).toBeTruthy();
  expect(screen.getByText('rising')).toBeTruthy();
  expect(screen.getByText('55%')).toBeTruthy();
});

test('no trend badge renders when only one half of the window has check-ins', async () => {
  global.fetch = mockFetch(() => okWith([{ ...ITEM, readiness_early_avg: null }]));

  render(<PerformanceAnalyticsPage />);

  await screen.findByText('Jordan Doe');
  expect(screen.queryByText('rising')).toBeNull();
  expect(screen.queryByText('falling')).toBeNull();
  expect(screen.queryByText('steady')).toBeNull();
});

test('switching the window refetches with the selected window_days', async () => {
  const seenUrls: string[] = [];
  global.fetch = mockFetch((url) => {
    seenUrls.push(url);
    return okWith([ITEM]);
  });

  render(<PerformanceAnalyticsPage />);
  await screen.findByText('Jordan Doe');

  fireEvent.click(screen.getByRole('button', { name: '90 days' }));

  await waitFor(() => {
    expect(seenUrls[seenUrls.length - 1]).toContain('window_days=90');
  });
});

/* ------------------------------------------------------------ the floor --- */

/**
 * This page was the only <table> on any gym-floor route: eight columns, one
 * row per athlete, in whatever order the API returned, with nothing saying
 * which row to read first. The room DNA forbids board tables here and asks for
 * cards by urgency, so what these pin is the order and the reason, not the
 * markup for its own sake -- a card list sorted by nothing is the same table
 * with the lines rubbed out.
 */

const STEADY = { ...ITEM, athlete_id: 'ath-steady', full_name: 'Steady Sam', open_gaps: 0, sessions_total: 3, sessions_completed: 3, active_assignments: 0, avg_assignment_completion: null };
const FALLING = { ...STEADY, athlete_id: 'ath-falling', full_name: 'Falling Fran', readiness_early_avg: 7.5, readiness_late_avg: 6.0 };
const GAPS = { ...STEADY, athlete_id: 'ath-gaps', full_name: 'Gappy Gus', open_gaps: 3 };
const MISSED = { ...STEADY, athlete_id: 'ath-missed', full_name: 'Missed Mo', sessions_total: 5, sessions_completed: 3 };

function cardNames(container: HTMLElement): string[] {
  return [...container.querySelectorAll('li')].map(
    (card) => card.querySelector('span')?.textContent ?? '',
  );
}

test('the roster is cards, not a board table', async () => {
  global.fetch = mockFetch(() => okWith([ITEM]));

  const { container } = render(<PerformanceAnalyticsPage />);
  await screen.findByText('Jordan Doe');
  expect(container.querySelector('table')).toBeNull();
  expect(container.querySelectorAll('li')).toHaveLength(1);
});

test('the worst card is first, and the one asking for nothing is last', async () => {
  global.fetch = mockFetch(() => okWith([STEADY, MISSED, GAPS, FALLING]));

  const { container } = render(<PerformanceAnalyticsPage />);
  await screen.findByText('Falling Fran');

  // Readiness falling outranks open gaps outranks a booked session nobody
  // completed; an athlete this window has nothing to say about sorts last.
  expect(cardNames(container)).toEqual(['Falling Fran', 'Gappy Gus', 'Missed Mo', 'Steady Sam']);
});

test('each card says which figure put it where it is', async () => {
  global.fetch = mockFetch(() => okWith([STEADY, GAPS, FALLING, MISSED]));

  render(<PerformanceAnalyticsPage />);
  await screen.findByText('Falling Fran');

  // Law 3: the rung is never colour alone. Every badge carries a glyph and
  // says the reason in words.
  expect(screen.getByText('readiness falling')).toBeTruthy();
  expect(screen.getByText('3 open gaps')).toBeTruthy();
  expect(screen.getByText('2 booked, not completed')).toBeTruthy();
  expect(screen.getByText('Nothing in this window asking for you')).toBeTruthy();
});

test('a rollup never paints the safety gate\'s locked red', async () => {
  // Law 2: saturated colour is a safety/status claim. Arithmetic over session
  // counts and check-ins can say "look here first"; it cannot say "this person
  // may not participate", which is what badge--locked means everywhere else.
  global.fetch = mockFetch(() => okWith([FALLING, GAPS, MISSED, STEADY]));

  const { container } = render(<PerformanceAnalyticsPage />);
  await screen.findByText('Falling Fran');

  expect(container.querySelector('.badge--locked')).toBeNull();
});

test('the same payload always lands in the same order', async () => {
  // A list that reshuffles between two loads of identical data is a list a
  // coach cannot trust to have read.
  global.fetch = mockFetch(() => okWith([GAPS, { ...GAPS, athlete_id: 'ath-gaps-2', full_name: 'Aaron Gaps' }]));

  const first = render(<PerformanceAnalyticsPage />);
  await screen.findByText('Aaron Gaps');
  const order = cardNames(first.container);
  first.unmount();

  const second = render(<PerformanceAnalyticsPage />);
  await screen.findAllByText('Aaron Gaps');
  expect(cardNames(second.container)).toEqual(order);
});

/* ------------------------------------------------- a rollup nobody read --- */

/**
 * This page exists to put the athlete who needs a coach at the top, so its
 * empty state does not read as "no data" -- it reads as "nobody is asking for
 * you". A rollup that failed to load used to render that sentence underneath
 * its own error alert: a screen showing a failure and a contradicting
 * all-clear at the same time, with the all-clear in the larger type.
 */
describe('a rollup nobody could read never reads as "nobody needs you"', () => {
  test('a refused rollup says it could not be read, and does not say the roster is empty', async () => {
    global.fetch = mockFetch(() => ({ ok: false, status: 503, json: async () => ({}) }) as Response);

    render(<PerformanceAnalyticsPage />);

    expect(await screen.findByText('The rollup could not be read')).toBeTruthy();
    // The half that was the defect: the reassuring sentence, gone.
    expect(screen.queryByText('No athletes on your roster')).toBeNull();
  });

  test('a rollup read that throws is treated the same as one the server refused', async () => {
    global.fetch = mockFetch(() => Promise.reject(new Error('Network request failed')));

    render(<PerformanceAnalyticsPage />);

    expect(await screen.findByText('The rollup could not be read')).toBeTruthy();
    expect(screen.queryByText('No athletes on your roster')).toBeNull();
  });

  test('a window that genuinely holds nothing still says so, and does not claim a failure', async () => {
    // Without this, the two tests above are equally satisfied by a page that
    // says "could not be read" on every load -- and a coach who is told that
    // every morning stops reading it.
    global.fetch = mockFetch(() => okWith([]));

    render(<PerformanceAnalyticsPage />);

    expect(await screen.findByText('No athletes on your roster')).toBeTruthy();
    expect(screen.queryByText('The rollup could not be read')).toBeNull();
  });
});

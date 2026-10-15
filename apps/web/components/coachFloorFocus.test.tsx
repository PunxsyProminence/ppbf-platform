/**
 * @jest-environment jsdom
 */

/**
 * The floor view at the top of the coach dashboard: one thing at a time.
 *
 * What is pinned here is what the view must never do, more than how it looks:
 * it fetches nothing until Start a session is tapped (#1523: then the plan list,
 * and a plain start when there are none), "Next" changes no record, the only
 * other write it can reach is the real escalation acknowledge it is handed, and
 * a feed that failed or is still loading is never read out as "nothing needs you".
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import CoachFloorFocus, { type CoachFloorFocusProps, type FocusFeed, type FocusItem } from './CoachFloorFocus';
import { takeArrivalAthlete } from './decisionLoopArrival';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

const LOADED: FocusFeed[] = [
  { name: 'Safety escalations', state: 'loaded' },
  { name: 'Pain reports', state: 'loaded' },
  { name: 'Family barrier reports', state: 'loaded' },
];

function escalation(onAcknowledge = jest.fn()): FocusItem {
  return {
    id: 'escalation:e1',
    kind: 'Safety escalation',
    urgent: true,
    title: 'Ada Rivera',
    meta: 'Near miss · Oct 2',
    badge: { tone: 'locked', label: 'high' },
    details: [],
    body: 'Took a hard shot and kept going.',
    acknowledge: { busy: false, disabled: false, onAcknowledge },
  };
}

const PAIN: FocusItem = {
  id: 'pain:p1',
  kind: 'Pain report',
  urgent: true,
  title: 'Marcus Bell',
  meta: 'Athlete ID ath_2 · recorded Oct 2',
  badge: { tone: 'restricted', label: 'moderate - 5/10' },
  details: [{ label: 'Body location', value: 'Left shoulder' }],
  link: { href: '/coach/decision-loop', label: 'Record what you did' },
};

function props(overrides: Partial<CoachFloorFocusProps> = {}): CoachFloorFocusProps {
  return {
    athletes: [
      { id: 'ath_1', name: 'Ada Rivera', readiness: 'GREEN' },
      { id: 'ath_2', name: 'Marcus Bell', readiness: 'UNKNOWN' },
    ],
    athletesState: 'loaded',
    athletesError: null,
    onSelectAthlete: jest.fn(),
    items: [escalation(), PAIN],
    feeds: LOADED,
    readinessState: 'loaded',
    sessionState: 'loaded',
    sessionLive: false,
    sessionMode: 'Group',
    onSessionMode: jest.fn(),
    everythingElseHref: '#coach-dashboard-details',
    ...overrides,
  };
}

let fetchSpy: jest.Mock;

beforeEach(() => {
  fetchSpy = jest.fn();
  global.fetch = fetchSpy as unknown as typeof fetch;
});

test('shows one thing at a time, and Next moves to the next without fetching or writing anything', () => {
  render(<CoachFloorFocus {...props()} />);

  expect(screen.getByText('Needs you now · 1 of 2')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Ada Rivera' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Marcus Bell' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
  expect(screen.getByText('Needs you now · 2 of 2')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Marcus Bell' })).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
  expect(screen.getByText('Needs you now · 1 of 2')).toBeTruthy();

  expect(fetchSpy).not.toHaveBeenCalled();
});

test('the only write it can reach is the acknowledge it is handed, and only for an escalation', () => {
  const onAcknowledge = jest.fn();
  render(<CoachFloorFocus {...props({ items: [escalation(onAcknowledge), PAIN] })} />);

  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
  expect(onAcknowledge).toHaveBeenCalledTimes(1);

  // A pain report has no acknowledge on the backend, so the view offers none.
  fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Record what you did' }).getAttribute('href')).toBe('/coach/decision-loop');
  expect(screen.getByText('Left shoulder')).toBeTruthy();

  expect(fetchSpy).not.toHaveBeenCalled();
});

test('says nothing needs you only when every feed answered and none had anything', () => {
  render(<CoachFloorFocus {...props({ items: [] })} />);
  expect(screen.getByRole('heading', { name: 'Nothing needs you right now' })).toBeTruthy();
  expect(screen.getByText(/not that everyone is fine/)).toBeTruthy();
});

test('a failed read is put first and is never read out as "nothing needs you"', () => {
  const onRetry = jest.fn();
  const feeds: FocusFeed[] = [
    { name: 'Safety escalations', state: 'loaded' },
    {
      name: 'Pain reports',
      state: 'error',
      error: 'Pain reports could not be loaded.',
      failureMeaning: 'Do not read this as "no athlete reported pain".',
      onRetry,
    },
    { name: 'Family barrier reports', state: 'loaded' },
  ];
  render(<CoachFloorFocus {...props({ items: [], feeds })} />);

  expect(screen.queryByRole('heading', { name: 'Nothing needs you right now' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Could not be read' })).toBeTruthy();
  expect(screen.getByText('Pain reports')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('Do not read this as "no athlete reported pain".');
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test('a feed still loading is never read out as "nothing needs you" either', () => {
  const feeds: FocusFeed[] = [
    { name: 'Safety escalations', state: 'loading' },
    { name: 'Pain reports', state: 'loaded' },
    { name: 'Family barrier reports', state: 'loaded' },
  ];
  render(<CoachFloorFocus {...props({ items: [], feeds })} />);
  expect(screen.queryByRole('heading', { name: 'Nothing needs you right now' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Still checking' })).toBeTruthy();
  expect(screen.getByText('Safety escalations')).toBeTruthy();
});

test('readiness is shown as its band in words, and an athlete with no reading is never shown as fine', () => {
  render(<CoachFloorFocus {...props()} />);
  expect(screen.getByRole('button', { name: 'Ada Rivera: readiness Green' })).toBeTruthy();
  const unknown = screen.getByRole('button', { name: 'Marcus Bell: readiness No reading' });
  expect(unknown.textContent).toContain('No reading');
  expect(unknown.textContent).not.toMatch(/ready|clear|green/i);
});

test('choosing an athlete only hands the id back; the view reads nothing about them', () => {
  const onSelectAthlete = jest.fn();
  render(<CoachFloorFocus {...props({ onSelectAthlete })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Ada Rivera: readiness Green' }));
  expect(onSelectAthlete).toHaveBeenCalledWith('ath_1');
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('a roster that failed to load says so instead of showing an empty floor', () => {
  render(<CoachFloorFocus {...props({ athletes: [], athletesState: 'error', athletesError: 'Roster read failed.' })} />);
  expect(screen.getByText(/Roster read failed\./)).toBeTruthy();
  expect(screen.queryByText('No athletes are assigned to you.')).toBeNull();
});

// Issue #1523 (Jason 2026-10-12, "allow a plain session"; Q2 A): one tap starts a session.
describe('Start a session', () => {
  function respond(scripts: unknown[] | 'fail', start: { status: number; body: Record<string, unknown> } = { status: 201, body: { run: {} } }) {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/session-scripts/runs') && init?.method === 'POST') {
        return { ok: start.status < 400, status: start.status, json: async () => start.body } as Response;
      }
      if (url.includes('/session-scripts')) {
        if (scripts === 'fail') return { ok: false, status: 500, json: async () => ({}) } as Response;
        return { ok: true, status: 200, json: async () => ({ scripts }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
  }
  const posts = () => fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');

  test('with no plans in the gym, one tap starts a plain session and goes to it', async () => {
    respond([]);
    const onGoToSessions = jest.fn();
    render(<CoachFloorFocus {...props({ onGoToSessions })} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start a session' }));
    });

    expect(posts()).toHaveLength(1);
    expect(String(posts()[0][0])).toContain('/api/pilot/session-scripts/runs');
    expect(JSON.parse(String((posts()[0][1] as RequestInit).body))).toEqual({});
    expect(onGoToSessions).toHaveBeenCalledTimes(1);
  });

  test('with plans in the gym, the tap goes to the session page and starts nothing', async () => {
    respond([{ script_id: 'scr-1' }]);
    const onGoToSessions = jest.fn();
    render(<CoachFloorFocus {...props({ onGoToSessions })} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start a session' }));
    });

    expect(posts()).toHaveLength(0);
    expect(onGoToSessions).toHaveBeenCalledTimes(1);
  });

  test('a session already live elsewhere is gone to, not refused', async () => {
    respond([], { status: 409, body: { error: 'SESSION_RUN_ALREADY_LIVE' } });
    const onGoToSessions = jest.fn();
    render(<CoachFloorFocus {...props({ onGoToSessions })} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start a session' }));
    });

    expect(onGoToSessions).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['the plan list could not be read', 'fail' as const, undefined],
    ['the start was refused', [] as unknown[], { status: 500, body: { error: 'boom' } }],
  ])('when %s, it says no session was started and offers the page', async (_label, scripts, start) => {
    respond(scripts, start);
    const onGoToSessions = jest.fn();
    render(<CoachFloorFocus {...props({ onGoToSessions })} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start a session' }));
    });

    expect(onGoToSessions).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('No session was started.');
    expect(screen.getByRole('link', { name: 'Open the session page' }).getAttribute('href')).toBe('/coach/session-scripts');
  });

  test('nothing is fetched until the tap, and a running or unknown session is a link to the page', () => {
    const { rerender } = render(<CoachFloorFocus {...props()} />);
    expect(fetchSpy).not.toHaveBeenCalled();
    rerender(<CoachFloorFocus {...props({ sessionLive: true })} />);
    expect(screen.getByRole('link', { name: 'Return to live delivery' }).getAttribute('href')).toBe('/coach/session-scripts');
    rerender(<CoachFloorFocus {...props({ sessionState: 'error' })} />);
    expect(screen.getByRole('link', { name: 'Open Session Scripts' }).getAttribute('href')).toBe('/coach/session-scripts');
  });
});

test('session mode is a real toggle with its state announced', () => {
  const onSessionMode = jest.fn();
  render(<CoachFloorFocus {...props({ onSessionMode })} />);
  expect(screen.getByRole('button', { name: 'Group' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'One-on-One' }));
  expect(onSessionMode).toHaveBeenCalledWith('One-on-One');
});

test('everything else on the dashboard stays one tap away', () => {
  render(<CoachFloorFocus {...props()} />);
  expect(screen.getByRole('link', { name: /Everything else on the dashboard/ }).getAttribute('href')).toBe('#coach-dashboard-details');
});

/* THE GAUGES. Each is a count the workspace already holds; one that was not
   read is "?" with the reason, never 0. */
function gauge(label: string) {
  const glance = within(screen.getByLabelText('Today at a glance'));
  return glance.getByText(label).closest('.coach-floor-focus__gauge') as HTMLElement;
}

test('the gauges show the counts the board was handed', () => {
  render(<CoachFloorFocus {...props()} />);
  expect(gauge('Athletes').textContent).toContain('2');
  expect(gauge('Needs you').textContent).toContain('2');
  expect(gauge('Needs you').getAttribute('data-gauge-state')).toBe('alert');
  // One GREEN, one UNKNOWN: one reading, out of two.
  expect(gauge('Readings').textContent).toContain('1 of 2');
  expect(gauge('Session').textContent).toContain('None');
  // The mode is the coach's own setting, and says so.
  expect(gauge('Session').textContent).toContain('Your mode: Group');
});

test('a failed feed makes the needs-you gauge "?", never 0', () => {
  const feeds: FocusFeed[] = [
    { name: 'Safety escalations', state: 'error', error: 'boom' },
    { name: 'Pain reports', state: 'loaded' },
    { name: 'Family barrier reports', state: 'loaded' },
  ];
  render(<CoachFloorFocus {...props({ items: [], feeds })} />);
  const needs = gauge('Needs you');
  expect(needs.querySelector('.coach-floor-focus__gauge-value')?.textContent).toBe('?');
  expect(needs.textContent).toContain('A read failed');
  expect(needs.textContent).not.toMatch(/\b0\b/);
});

test('a feed still loading makes the needs-you gauge a wait, never 0', () => {
  const feeds: FocusFeed[] = [
    { name: 'Safety escalations', state: 'loaded' },
    { name: 'Pain reports', state: 'loading' },
    { name: 'Family barrier reports', state: 'loaded' },
  ];
  render(<CoachFloorFocus {...props({ items: [], feeds })} />);
  expect(gauge('Needs you').querySelector('.coach-floor-focus__gauge-value')?.textContent).toBe('…');
});

test('a live-run read that failed is never shown as "no session"', () => {
  render(<CoachFloorFocus {...props({ sessionState: 'error' })} />);
  expect(gauge('Session').textContent).toContain('?');
  expect(gauge('Session').textContent).not.toContain('None');
  expect(screen.queryByRole('link', { name: 'Start a session' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Open Session Scripts' }).getAttribute('href')).toBe('/coach/session-scripts');
});

test('a roster that was not read leaves the athlete and readings gauges unknown', () => {
  render(<CoachFloorFocus {...props({ athletes: [], athletesState: 'error', athletesError: 'Roster read failed.' })} />);
  expect(gauge('Athletes').textContent).toContain('?');
  expect(gauge('Readings').textContent).toContain('?');
  expect(gauge('Readings').querySelector('.coach-floor-focus__dial')).toBeNull();
});

/* THE VIEW FOLLOWS AN ITEM, NOT A POSITION (review finding, 2026-10-03). */
function escalationFor(id: string, title: string, onAcknowledge = jest.fn()): FocusItem {
  return { ...escalation(onAcknowledge), id: `escalation:${id}`, title };
}

test('after an acknowledge, the next child\'s escalation arrives closed, and the coach is told it landed', () => {
  const first = escalationFor('e1', 'Ada Rivera');
  const second = escalationFor('e2', 'Marcus Bell');
  const { rerender } = render(<CoachFloorFocus {...props({ items: [first, second] })} />);

  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
  expect(first.acknowledge?.onAcknowledge).toHaveBeenCalledTimes(1);

  // The workspace drops the acknowledged escalation from the queue.
  rerender(<CoachFloorFocus {...props({ items: [second] })} />);

  expect(screen.getByRole('heading', { name: 'Marcus Bell' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
  expect(screen.getByText(/Acknowledged: Ada Rivera/)).toBeTruthy();
  expect(second.acknowledge?.onAcknowledge).not.toHaveBeenCalled();
});

test('a feed going back to loading does not move the coach onto a different child\'s item', () => {
  const { rerender } = render(<CoachFloorFocus {...props()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  expect(screen.getByRole('heading', { name: 'Marcus Bell' })).toBeTruthy();

  const feeds: FocusFeed[] = [
    { name: 'Safety escalations', state: 'loading' },
    { name: 'Pain reports', state: 'loaded' },
    { name: 'Family barrier reports', state: 'loaded' },
  ];
  rerender(<CoachFloorFocus {...props({ feeds })} />);

  expect(screen.getByRole('heading', { name: 'Marcus Bell' })).toBeTruthy();
  expect(screen.getByText('Needs you now · 3 of 3')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Record what you did' })).toBeTruthy();
});

test('a readiness read that failed makes the readings gauge "?", never 0 of N', () => {
  render(<CoachFloorFocus {...props({ readinessState: 'error' })} />);
  expect(gauge('Readings').textContent).toContain('?');
  expect(gauge('Readings').textContent).toContain('Readiness not read');
  expect(gauge('Readings').querySelector('.coach-floor-focus__dial')).toBeNull();
});

test('an unvalidated check-in is counted and said as "Not validated", never as a band', () => {
  render(
    <CoachFloorFocus
      {...props({
        athletes: [
          { id: 'ath_1', name: 'Ada Rivera', readiness: 'GREEN' },
          { id: 'ath_2', name: 'Marcus Bell', readiness: 'UNKNOWN', unvalidatedReading: true },
          { id: 'ath_3', name: 'Sam Ortiz', readiness: 'UNKNOWN' },
        ],
      })}
    />,
  );
  expect(screen.getByRole('button', { name: 'Marcus Bell: readiness Not validated' })).toBeTruthy();
  expect(gauge('Readings').textContent).toContain('2 of 3');
  expect(gauge('Readings').textContent).toContain('1 not validated');
});

test('an athlete on the roster who is not this coach\'s is marked so', () => {
  render(<CoachFloorFocus {...props({ athletes: [{ id: 'ath_9', name: 'Demo Two', readiness: 'UNKNOWN', isMine: false }] })} />);
  expect(screen.getByText('Not your athlete')).toBeTruthy();
});

test('the all-clear line names the pain window it read', () => {
  render(<CoachFloorFocus {...props({ items: [], painWindowDays: 7 })} />);
  expect(screen.getByText(/No pain report in the last 7 days/)).toBeTruthy();
});

test('a feed that returned fewer than matched makes the needs-you count a floor', () => {
  const feeds: FocusFeed[] = [
    { name: 'Safety escalations', state: 'loaded' },
    { name: 'Pain reports', state: 'loaded', truncatedNote: 'More pain reports matched than are listed.' },
    { name: 'Family barrier reports', state: 'loaded' },
  ];
  render(<CoachFloorFocus {...props({ feeds })} />);
  expect(gauge('Needs you').querySelector('.coach-floor-focus__gauge-value')?.textContent).toBe('2+');
});

test('an empty roster draws no dial', () => {
  render(<CoachFloorFocus {...props({ athletes: [] })} />);
  expect(gauge('Readings').textContent).toContain('0 of 0');
  expect(gauge('Readings').querySelector('.coach-floor-focus__dial')).toBeNull();
});

test('no heading on the board carries a feed panel\'s name, and the session sentence is not repeated', () => {
  const feeds: FocusFeed[] = [
    { name: 'Safety escalations', state: 'loading' },
    { name: 'Pain reports', state: 'error', error: 'boom' },
    { name: 'Family barrier reports', state: 'loaded' },
  ];
  render(<CoachFloorFocus {...props({ feeds })} />);
  for (const heading of screen.getAllByRole('heading')) {
    expect(heading.textContent ?? '').not.toMatch(/safety escalations|pain reports|barrier reports/i);
  }
  fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
  for (const heading of screen.getAllByRole('heading')) {
    expect(heading.textContent ?? '').not.toMatch(/safety escalations|pain reports|barrier reports/i);
  }
  expect(screen.queryByText(/Session in progress|No session in progress/)).toBeNull();
});

test('Start a session sends one start however fast it is tapped, and stays busy while it goes', async () => {
  let finishStart: ((value: Response) => void) | null = null;
  fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/session-scripts/runs') && init?.method === 'POST') {
      return new Promise<Response>((resolve) => { finishStart = resolve; });
    }
    return { ok: true, status: 200, json: async () => ({ scripts: [] }) } as Response;
  });
  const onGoToSessions = jest.fn();
  render(<CoachFloorFocus {...props({ onGoToSessions })} />);

  const button = screen.getByRole('button', { name: 'Start a session' });
  await act(async () => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect((screen.getByRole('button', { name: 'Starting...' }) as HTMLButtonElement).disabled).toBe(true);

  await act(async () => {
    finishStart?.({ ok: true, status: 201, json: async () => ({ run: {} }) } as Response);
  });

  const posts = fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(onGoToSessions).toHaveBeenCalledTimes(1);
  expect((screen.getByRole('button', { name: 'Starting...' }) as HTMLButtonElement).disabled).toBe(true);
});

test('an athlete\'s own check-in today is a reading: counted, said as "Checked in", never as a band (F-040)', () => {
  render(
    <CoachFloorFocus
      {...props({
        athletes: [
          { id: 'ath_1', name: 'Ada Rivera', readiness: 'UNKNOWN', checkedInToday: true },
          { id: 'ath_2', name: 'Marcus Bell', readiness: 'UNKNOWN' },
        ],
      })}
    />,
  );
  expect(screen.getByRole('button', { name: 'Ada Rivera: readiness Checked in' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Marcus Bell: readiness No reading' })).toBeTruthy();
  expect(gauge('Readings').textContent).toContain('1 of 2');
  // A self-report is not one of the staff judgements counted as "not validated".
  expect(gauge('Readings').textContent).not.toContain('not validated');
});

test('a band or an unvalidated staff reading still wins over a check-in, and only staff readings count as "not validated"', () => {
  render(
    <CoachFloorFocus
      {...props({
        athletes: [
          { id: 'ath_1', name: 'Ada Rivera', readiness: 'GREEN', checkedInToday: true },
          { id: 'ath_2', name: 'Marcus Bell', readiness: 'UNKNOWN', unvalidatedReading: true, checkedInToday: true },
          { id: 'ath_3', name: 'Sam Ortiz', readiness: 'UNKNOWN', checkedInToday: true },
        ],
      })}
    />,
  );
  expect(screen.getByRole('button', { name: 'Ada Rivera: readiness Green' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Marcus Bell: readiness Not validated' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sam Ortiz: readiness Checked in' })).toBeTruthy();
  expect(gauge('Readings').textContent).toContain('3 of 3');
  expect(gauge('Readings').textContent).toContain('1 not validated');
});

describe('an athlete an admin marked inactive', () => {
  test('is marked on the roster, and still listed and counted', () => {
    render(
      <CoachFloorFocus
        {...props({
          athletes: [
            { id: 'ath_1', name: 'Ada Rivera', readiness: 'GREEN' },
            { id: 'ath_2', name: 'Marcus Bell', readiness: 'UNKNOWN', isInactive: true },
          ],
        })}
      />,
    );

    const roster = screen.getByRole('region', { name: 'The floor' });
    const row = within(roster).getByRole('button', { name: /^Marcus Bell \(inactive\)/ });
    expect(within(row).getByText('Inactive')).toBeTruthy();
    expect(within(roster).getByRole('button', { name: /^Ada Rivera: readiness/ })).toBeTruthy();
    expect(within(roster).queryAllByText('Inactive')).toHaveLength(1);
    // Marked, not removed: the count still reads what the roster holds.
    expect(screen.getByLabelText('Today at a glance').textContent).toMatch(/Athletes.*2.*on the roster/);
  });
});

// #1474 item 5: "Record what you did" opens the Decision Loop on the athlete
// the report is about. The athlete is handed over in page memory; the address
// stays /coach/decision-loop with no athlete in it (Overwatch, #1474 Q2 = C).
describe('"Record what you did" hands its athlete to the Decision Loop', () => {
  const PAIN_FOR_ATH_2: FocusItem = { ...PAIN, link: { href: '/coach/decision-loop', label: 'Record what you did', athleteId: 'ath_2' } };

  afterEach(() => {
    takeArrivalAthlete();
  });

  function openLink(item: FocusItem): HTMLElement {
    render(<CoachFloorFocus {...props({ items: [item] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    return screen.getByRole('link', { name: 'Record what you did' });
  }

  test('a plain click hands over the athlete, and the address carries none', () => {
    const link = openLink(PAIN_FOR_ATH_2);
    expect(link.getAttribute('href')).toBe('/coach/decision-loop');
    expect(takeArrivalAthlete()).toBeNull();

    fireEvent.click(link);
    expect(takeArrivalAthlete()).toBe('ath_2');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each([
    ['ctrl', { ctrlKey: true }],
    ['cmd', { metaKey: true }],
    ['shift', { shiftKey: true }],
    ['middle button', { button: 1 }],
  ])('a %s click, which opens another tab, hands nothing over', (_name, init) => {
    fireEvent.click(openLink(PAIN_FOR_ATH_2), init);
    expect(takeArrivalAthlete()).toBeNull();
  });

  test('a link with no athlete on it hands nothing over', () => {
    fireEvent.click(openLink(PAIN));
    expect(takeArrivalAthlete()).toBeNull();
  });
});

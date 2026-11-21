/**
 * @jest-environment jsdom
 */

/**
 * The floor view at the top of the coach dashboard: one thing at a time.
 *
 * What is pinned here is what the view must never do, more than how it looks:
 * it fetches nothing until Start a session is tapped (#1523: then the plan list,
 * and a plain start when there are none), and a count that was not read is never
 * shown as 0.
 *
 * The "Needs you now" card and its pager tests left this board for the home's
 * strip in lane 6C7's 7b (coachNeedsYouStrip.test.tsx), with the "Needs you"
 * gauge; the test at the end of this file pins that they are gone from here.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

import CoachFloorFocus, { type CoachFloorFocusProps } from './CoachFloorFocus';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

function props(overrides: Partial<CoachFloorFocusProps> = {}): CoachFloorFocusProps {
  return {
    athletes: [
      { id: 'ath_1', name: 'Ada Rivera', readiness: 'GREEN' },
      { id: 'ath_2', name: 'Marcus Bell', readiness: 'UNKNOWN' },
    ],
    athletesState: 'loaded',
    athletesError: null,
    onSelectAthlete: jest.fn(),
    readinessState: 'loaded',
    sessionState: 'loaded',
    sessionLive: false,
    everythingElseHref: '#coach-dashboard-details',
    ...overrides,
  };
}

let fetchSpy: jest.Mock;

beforeEach(() => {
  fetchSpy = jest.fn();
  global.fetch = fetchSpy as unknown as typeof fetch;
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

  // Lane U2-6a (Overwatch Q5 = A): a live session is on the class screen.
  test('with no plans in the gym, one tap starts a plain session and goes to the class screen', async () => {
    respond([]);
    const onGoToSessions = jest.fn();
    const onGoToClass = jest.fn();
    render(<CoachFloorFocus {...props({ onGoToSessions, onGoToClass })} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start or pick a session' }));
    });

    expect(posts()).toHaveLength(1);
    expect(String(posts()[0][0])).toContain('/api/pilot/session-scripts/runs');
    expect(JSON.parse(String((posts()[0][1] as RequestInit).body))).toEqual({});
    expect(onGoToClass).toHaveBeenCalledTimes(1);
    expect(onGoToClass).toHaveBeenCalledWith(false);
    expect(onGoToSessions).not.toHaveBeenCalled();
  });

  test('with plans in the gym, the tap goes to the session page and starts nothing', async () => {
    respond([{ script_id: 'scr-1' }]);
    const onGoToSessions = jest.fn();
    render(<CoachFloorFocus {...props({ onGoToSessions })} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start or pick a session' }));
    });

    expect(posts()).toHaveLength(0);
    expect(onGoToSessions).toHaveBeenCalledTimes(1);
  });

  test('a session already live elsewhere is gone to on the class screen, not refused', async () => {
    respond([], { status: 409, body: { error: 'SESSION_RUN_ALREADY_LIVE' } });
    const onGoToClass = jest.fn();
    render(<CoachFloorFocus {...props({ onGoToClass })} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start or pick a session' }));
    });

    // true: the class screen says the session was restored, not restarted.
    expect(onGoToClass).toHaveBeenCalledWith(true);
    expect(onGoToClass).toHaveBeenCalledTimes(1);
    expect(posts()).toHaveLength(1);
  });

  test.each([
    ['the plan list could not be read', 'fail' as const, undefined],
    ['the start was refused', [] as unknown[], { status: 500, body: { error: 'boom' } }],
  ])('when %s, it says no session was started and offers the page', async (_label, scripts, start) => {
    respond(scripts, start);
    const onGoToSessions = jest.fn();
    const onGoToClass = jest.fn();
    render(<CoachFloorFocus {...props({ onGoToSessions, onGoToClass })} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start or pick a session' }));
    });

    expect(onGoToSessions).not.toHaveBeenCalled();
    expect(onGoToClass).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('No session was started.');
    expect(screen.getByRole('link', { name: 'Open the session page' }).getAttribute('href')).toBe('/coach/session-scripts');
  });

  test('nothing is fetched until the tap, and a running or unknown session is a link to the page', () => {
    const { rerender } = render(<CoachFloorFocus {...props()} />);
    expect(fetchSpy).not.toHaveBeenCalled();
    rerender(<CoachFloorFocus {...props({ sessionLive: true })} />);
    // Lane U2-6a: the live session runs on the class screen.
    expect(screen.getByRole('link', { name: 'Return to live delivery' }).getAttribute('href')).toBe('/coach/class');
    rerender(<CoachFloorFocus {...props({ sessionState: 'error' })} />);
    expect(screen.getByRole('link', { name: 'Open Session Plans' }).getAttribute('href')).toBe('/coach/session-scripts');
  });
});

/* CF-05 (lane U1), then CF-06 (lane 6C7's 7a-1). The Group / One-on-One toggle switched only the
   coach home's code-written Floor tab template, never the session Start begins, so the board
   stopped offering it and named where it went. The Floor tab and the template are gone now
   (Overwatch Q5 = A on #2043), so the board points at neither. */
test('the board offers no Group / One-on-One toggle and does not point at a Floor tab', () => {
  render(<CoachFloorFocus {...props()} />);
  expect(screen.queryByRole('group', { name: 'Session mode' })).toBeNull();
  expect(screen.queryByRole('button', { name: /^(✓ )?Group$/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /^(✓ )?One-on-One$/ })).toBeNull();
  expect(screen.queryByText(/Floor tab/)).toBeNull();
  expect(screen.queryByText(/block templates/)).toBeNull();
});

/* CF-04 (lane U1). With a plan written the tap opens Session Plans to pick one,
   so the button does not say it starts one outright. */
test('the start button says it may open the plans to pick one', () => {
  render(<CoachFloorFocus {...props()} />);
  expect(screen.queryByRole('button', { name: 'Start a session' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Start or pick a session' })).toBeTruthy();
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
  // One GREEN, one UNKNOWN: one reading, out of two.
  expect(gauge('Readings').textContent).toContain('1 of 2');
  expect(gauge('Session').textContent).toContain('None');
  // No mode here: the board's toggle is gone (CF-05), so the gauge names what it reads.
  expect(gauge('Session').textContent).toContain('Nothing running');
  expect(gauge('Session').textContent).not.toContain('mode');
});

test('a running session reads as live delivery on the session gauge (CF-05)', () => {
  render(<CoachFloorFocus {...props({ sessionLive: true })} />);
  expect(gauge('Session').textContent).toContain('Running');
  expect(gauge('Session').textContent).toContain('Live delivery');
  expect(gauge('Session').textContent).not.toContain('Nothing running');
});

test('a live-run read that failed is never shown as "no session"', () => {
  render(<CoachFloorFocus {...props({ sessionState: 'error' })} />);
  expect(gauge('Session').textContent).toContain('?');
  expect(gauge('Session').textContent).not.toContain('None');
  expect(screen.queryByRole('link', { name: 'Start or pick a session' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Open Session Plans' }).getAttribute('href')).toBe('/coach/session-scripts');
});

test('a roster that was not read leaves the athlete and readings gauges unknown', () => {
  render(<CoachFloorFocus {...props({ athletes: [], athletesState: 'error', athletesError: 'Roster read failed.' })} />);
  expect(gauge('Athletes').textContent).toContain('?');
  expect(gauge('Readings').textContent).toContain('?');
  expect(gauge('Readings').querySelector('.coach-floor-focus__dial')).toBeNull();
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

test('an empty roster draws no dial', () => {
  render(<CoachFloorFocus {...props({ athletes: [] })} />);
  expect(gauge('Readings').textContent).toContain('0 of 0');
  expect(gauge('Readings').querySelector('.coach-floor-focus__dial')).toBeNull();
});

test('no heading on the board carries a feed panel\'s name, and the session sentence is not repeated', () => {
  render(<CoachFloorFocus {...props()} />);
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
  const onGoToClass = jest.fn();
  render(<CoachFloorFocus {...props({ onGoToClass })} />);

  const button = screen.getByRole('button', { name: 'Start or pick a session' });
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
  expect(onGoToClass).toHaveBeenCalledTimes(1);
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

// D4 (OD-2026-10-21-002): the one-tap start ties the session only when exactly one class is under way.
describe('Start a session, and the class', () => {
  const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
  const klass = (id: string) => ({ class_id: id, title: id, start_at: soon(-10), end_at: soon(50), held_by_other_session: false });
  function respond(classes: unknown[] | 'fail') {
    fetchSpy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/session-scripts/runs') && init?.method === 'POST') {
        return { ok: true, status: 201, json: async () => ({ run: {} }) } as Response;
      }
      if (url.includes('classes=today')) {
        if (classes === 'fail') return { ok: false, status: 500, json: async () => ({}) } as Response;
        return { ok: true, status: 200, json: async () => ({ classes }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ scripts: [] }) } as Response;
    });
  }
  const posts = () => fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');

  test('exactly one class under way: the start is tied to it', async () => {
    respond([klass('class-youth')]);
    const onGoToClass = jest.fn();
    render(<CoachFloorFocus {...props({ onGoToClass })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start or pick a session' }));
    });
    expect(JSON.parse(String((posts()[0][1] as RequestInit).body))).toEqual({ class_id: 'class-youth' });
    expect(onGoToClass).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['two classes are under way', [klass('a'), klass('b')]],
    ["today's classes cannot be read", 'fail' as const],
  ])('when %s, the session page asks and nothing starts', async (_label, classes) => {
    respond(classes);
    const onGoToSessions = jest.fn();
    render(<CoachFloorFocus {...props({ onGoToSessions })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start or pick a session' }));
    });
    expect(posts()).toHaveLength(0);
    expect(onGoToSessions).toHaveBeenCalledTimes(1);
  });
});

/* LANE 6C7 7b: the "Needs you now" card is the home's strip now
   (CoachNeedsYouStrip.tsx, stage 2 section 3.4 row 11; Q6 = A), and the
   "Needs you" gauge went with it. The board keeps the roster, the other three
   gauges and Run the room; the strip's own tests carry the pager's protections. */
test('the board carries no "Needs you now" card, no pager and no "Needs you" gauge', () => {
  render(<CoachFloorFocus {...props()} />);
  expect(screen.queryByText(/Needs you now/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Next →' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Acknowledge' })).toBeNull();
  expect(within(screen.getByLabelText('Today at a glance')).queryByText('Needs you')).toBeNull();
  expect(within(screen.getByLabelText('Today at a glance')).getAllByRole('term').map((t) => t.textContent)).toEqual([
    'Athletes', 'Readings', 'Session',
  ]);
});

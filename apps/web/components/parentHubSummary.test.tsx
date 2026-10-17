/**
 * @jest-environment jsdom
 */

/**
 * WO-PH-01: the parent hub's summary tiles and status rows, from the records
 * that already exist for the child on screen.
 *
 *   Progress is what the child has earned (counted as the Progress tab counts
 *   it, from /api/pilot/achievements/milestones), never a score;
 *
 *   Upcoming and Attendance are counts of the same scheduler rows the
 *   Attendance tab lists, for the same child, and no percentage is derived;
 *
 *   every value belongs to the selected child: a sibling's rows in the same
 *   payload, or a sibling's slow answer, never show under this child's name;
 *
 *   a read that did not answer is Unavailable and a real zero is a zero.
 */

import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ParentHub from './ParentHub';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const CLASSES = [
  { class_id: 'cls_past', title: 'Tuesday Fundamentals', start_at: '2020-01-07T23:00:00.000Z', location: 'Main Floor', status: 'open' },
  { class_id: 'cls_sat', title: 'Saturday Sparring', start_at: '2099-06-05T15:00:00.000Z', location: 'Ring Two', status: 'open' },
  { class_id: 'cls_sun', title: 'Sunday Roadwork', start_at: '2099-06-06T15:00:00.000Z', location: 'Track', status: 'open' },
  { class_id: 'cls_off', title: 'Called-off Class', start_at: '2099-06-07T15:00:00.000Z', location: 'Main Floor', status: 'cancelled' },
];

// Two children, deliberately different everywhere, so a value that crossed
// from one to the other is visible.
const SCHEDULE = {
  ok: true,
  classes: CLASSES,
  registrations: [
    { registration_id: 'r1', class_id: 'cls_sat', athlete_id: 'ath_1', status: 'registered' },
    { registration_id: 'r2', class_id: 'cls_sun', athlete_id: 'ath_1', status: 'waitlisted' },
    { registration_id: 'r3', class_id: 'cls_off', athlete_id: 'ath_1', status: 'registered' },
    { registration_id: 'r4', class_id: 'cls_past', athlete_id: 'ath_1', status: 'registered' },
    { registration_id: 'r5', class_id: 'cls_sat', athlete_id: 'ath_2', status: 'registered' },
    { registration_id: 'r6', class_id: 'cls_sun', athlete_id: 'ath_2', status: 'registered' },
    { registration_id: 'r7', class_id: 'cls_off', athlete_id: 'ath_2', status: 'cancelled' },
  ],
  attendance: [
    { attendance_id: 'a1', class_id: 'cls_past', athlete_id: 'ath_1', status: 'present', checked_in_at: '2020-01-07T23:05:00.000Z' },
    { attendance_id: 'a2', class_id: 'cls_past', athlete_id: 'ath_1', status: 'excused', checked_in_at: '2020-01-14T23:05:00.000Z' },
    { attendance_id: 'a3', class_id: 'cls_past', athlete_id: 'ath_2', status: 'absent', checked_in_at: '2020-01-07T23:06:00.000Z' },
    { attendance_id: 'a4', class_id: 'cls_past', athlete_id: 'ath_2', status: 'absent', checked_in_at: '2020-01-14T23:06:00.000Z' },
    { attendance_id: 'a5', class_id: 'cls_past', athlete_id: 'ath_2', status: 'present', checked_in_at: '2020-01-21T23:06:00.000Z' },
  ],
};

// Real catalogue keys (src/shared/achievementPaths.ts), because the count is
// the catalogue's: the session-count milestones are earned from
// completed_sessions with no award row, and an award whose key is not in the
// catalogue is not shown on the Progress tab, so it is not counted here.
//
// ath_1: 12 sessions earns consistency.first_session and consistency.5; two
// coach awards; consistency.5 also stored as an award (counted once); one
// retired key (not counted). 4 earned, as the Progress tab would say.
// ath_2: 1 session earns consistency.first_session; one award. 2 earned.
const MILESTONES: Record<string, unknown> = {
  ath_1: {
    ok: true,
    program: 'boxing',
    completed_sessions: 12,
    items: [
      { athlete_id: 'ath_1', milestone_key: 'conditioning.first_full_round', awarded_by_role: 'coach', note: '', awarded_at: '2026-10-01T12:00:00.000Z' },
      { athlete_id: 'ath_1', milestone_key: 'conditioning.mile_unbroken', awarded_by_role: 'self', note: '', awarded_at: '2026-10-02T12:00:00.000Z' },
      { athlete_id: 'ath_1', milestone_key: 'consistency.5', awarded_by_role: 'coach', note: '', awarded_at: '2026-10-03T12:00:00.000Z' },
      { athlete_id: 'ath_1', milestone_key: 'retired.not_in_catalogue', awarded_by_role: 'coach', note: '', awarded_at: '2026-10-04T12:00:00.000Z' },
    ],
  },
  ath_2: {
    ok: true,
    program: 'boxing',
    completed_sessions: 1,
    items: [
      { athlete_id: 'ath_2', milestone_key: 'conditioning.first_full_round', awarded_by_role: 'coach', note: '', awarded_at: '2026-10-01T12:00:00.000Z' },
    ],
  },
};
const FIRST_PROGRESS = '4 milestones earned · 12 sessions logged';
const SECOND_PROGRESS = '2 milestones earned · 1 session logged';

type MilestoneHandler = (athleteId: string, init?: RequestInit) => Promise<Response>;

function installFetch(options: {
  scheduler?: () => Promise<Response>;
  milestones?: MilestoneHandler;
} = {}): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    // FC-06: the Messages tab's "Sent to your athlete" copy; none here.
    if (url.includes('/api/pilot/parent/athlete-messages')) return jsonResponse({ ok: true, items: [] });
    if (url.includes('/api/pilot/athletes/list')) {
      return jsonResponse({
        items: [
          { athlete_id: 'ath_1', full_name: 'First Child' },
          { athlete_id: 'ath_2', full_name: 'Second Child' },
        ],
      });
    }
    if (url.includes('/api/pilot/scheduler')) {
      return options.scheduler ? options.scheduler() : jsonResponse(SCHEDULE);
    }
    if (url.includes('/api/pilot/achievements/milestones')) {
      const athleteId = new URL(url, 'http://localhost').searchParams.get('athlete_id') ?? '';
      return options.milestones
        ? options.milestones(athleteId, init)
        : jsonResponse(MILESTONES[athleteId] ?? { ok: true, completed_sessions: 0, items: [] });
    }
    if (url.includes('/api/pilot/profile/card')) return jsonResponse({ error: 'not in this test' }, false);
    // Everything else the hub reads answers empty, so a failure here is a
    // failure of the summary and not of a neighbouring panel.
    return jsonResponse({ ok: true, items: [], announcements: [], card: null });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function tileValue(label: string): string {
  // Tab buttons share some labels; the tile's label is the <p> inside the
  // summary grid, which renders before any tab content.
  const labelElement = screen.getAllByText(label).find((element) => element.tagName === 'P');
  const tile = labelElement?.parentElement;
  return tile?.textContent?.replace(label, '').trim() ?? '';
}

/** The Current Status panel on the Overview tab, as text. */
function statusPanelText(): string {
  const heading = screen.getByText('Current Status');
  return heading.parentElement?.textContent ?? '';
}

async function renderHub() {
  await act(async () => {
    render(<ParentHub />);
  });
  await waitFor(() => expect(screen.getByRole('button', { name: 'First Child' })).toBeInTheDocument());
}

async function selectChild(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

afterEach(() => {
  jest.restoreAllMocks();
  // The hub opens on the child remembered last (src/lib/chosenChild.ts); one
  // test's pick must not choose the next test's opening child.
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe('Progress: earned milestones and completed sessions (Q1 = A)', () => {
  test('the tile and the status row show the selected child’s own record, and move with the selection', async () => {
    installFetch();
    await renderHub();

    await waitFor(() => expect(tileValue('Progress')).toBe(FIRST_PROGRESS));
    expect(statusPanelText()).toContain(FIRST_PROGRESS);

    await selectChild('Second Child');
    await waitFor(() => expect(tileValue('Progress')).toBe(SECOND_PROGRESS));
    expect(statusPanelText()).toContain(SECOND_PROGRESS);
    expect(statusPanelText()).not.toContain(FIRST_PROGRESS);
  });

  test('a real zero is a zero', async () => {
    installFetch({ milestones: async () => jsonResponse({ ok: true, completed_sessions: 0, items: [] }) });
    await renderHub();
    await waitFor(() => expect(tileValue('Progress')).toBe('0 milestones earned · 0 sessions logged'));
  });

  test('sessions earn their milestones with no award row, as the Progress tab counts them', async () => {
    installFetch({ milestones: async () => jsonResponse({ ok: true, completed_sessions: 13, items: [] }) });
    await renderHub();
    // consistency.first_session, consistency.5 and consistency.13.
    await waitFor(() => expect(tileValue('Progress')).toBe('3 milestones earned · 13 sessions logged'));
  });

  test('right after a switch, the child left behind’s progress is not shown while the new read is open', async () => {
    let releaseSecond: (() => void) | null = null;
    installFetch({
      milestones: (athleteId) => {
        if (athleteId === 'ath_1') return Promise.resolve(jsonResponse(MILESTONES.ath_1));
        return new Promise<Response>((resolve) => {
          releaseSecond = () => resolve(jsonResponse(MILESTONES.ath_2));
        });
      },
    });
    await renderHub();
    await waitFor(() => expect(tileValue('Progress')).toBe(FIRST_PROGRESS));

    await selectChild('Second Child');
    expect(tileValue('Progress')).toBe('Unavailable');
    expect(statusPanelText()).not.toMatch(/milestones? earned/);

    await act(async () => {
      (releaseSecond as (() => void) | null)?.();
    });
    await waitFor(() => expect(tileValue('Progress')).toBe(SECOND_PROGRESS));
  });

  test('a refused or malformed read is Unavailable, never a zero', async () => {
    installFetch({ milestones: async () => jsonResponse({ error: 'Forbidden' }, false) });
    await renderHub();
    await waitFor(() => expect(tileValue('Progress')).toBe('Unavailable'));
    expect(statusPanelText()).not.toMatch(/milestones? earned/);
  });

  test('an answer without the session count is not read as zero sessions', async () => {
    installFetch({ milestones: async () => jsonResponse({ ok: true, items: [] }) });
    await renderHub();
    await waitFor(() => expect(tileValue('Progress')).toBe('Unavailable'));
  });

  test('no percentage or score is shown', async () => {
    installFetch();
    const { container } = render(<ParentHub />);
    await waitFor(() => expect(tileValue('Progress')).toBe(FIRST_PROGRESS));
    expect(tileValue('Progress')).not.toContain('%');
    expect(container.textContent ?? '').not.toMatch(/awaiting backend progression feed/);
  });

  test('a slow answer for the child left behind never shows under the selected child', async () => {
    let releaseFirst: (() => void) | null = null;
    const fetchMock = installFetch({
      milestones: (athleteId, init) => {
        if (athleteId !== 'ath_1') return Promise.resolve(jsonResponse(MILESTONES[athleteId]));
        // The first child's read hangs until released and does NOT reject on
        // abort: an answer already in the pipe when the guardian switched
        // still arrives, and only the aborted checks keep it off the screen.
        void init;
        return new Promise<Response>((resolve) => {
          releaseFirst = () => resolve(jsonResponse(MILESTONES.ath_1));
        });
      },
    });
    await renderHub();
    expect(tileValue('Progress')).toBe('Unavailable');

    await selectChild('Second Child');
    await waitFor(() => expect(tileValue('Progress')).toBe(SECOND_PROGRESS));

    // The first child's request was aborted when the guardian moved on.
    // (ParentDigest reads the same route for its own panel, without a signal;
    // the summary's read is the one that carries one.)
    const firstCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/api/pilot/achievements/milestones?athlete_id=ath_1')
      && (call[1] as RequestInit | undefined)?.signal);
    expect((firstCall?.[1] as RequestInit).signal?.aborted).toBe(true);

    // Even an answer that lands anyway writes nothing under the second child.
    await act(async () => {
      (releaseFirst as (() => void) | null)?.();
    });
    expect(tileValue('Progress')).toBe(SECOND_PROGRESS);
  });
});

describe('Upcoming: places the selected child holds in sessions still to come', () => {
  test('counts registered, future, not-cancelled sessions for this child only', async () => {
    installFetch();
    await renderHub();
    // ath_1: cls_sat registered (counted); cls_sun waitlisted (not a place);
    // cls_off a cancelled class; cls_past already happened.
    await waitFor(() => expect(tileValue('Upcoming')).toBe('1'));

    // ath_2: cls_sat and cls_sun registered; the cancelled registration is out.
    await selectChild('Second Child');
    expect(tileValue('Upcoming')).toBe('2');
  });

  test('Unavailable while the schedule has not answered', async () => {
    installFetch({ scheduler: () => new Promise<Response>(() => {}) });
    await renderHub();
    expect(tileValue('Upcoming')).toBe('Unavailable');
    expect(tileValue('Attendance')).toBe('Unavailable');
    expect(statusPanelText()).not.toContain('Present 0');
  });

  test('Unavailable when the schedule read fails', async () => {
    installFetch({ scheduler: async () => jsonResponse({ error: 'down' }, false) });
    await renderHub();
    await waitFor(() => expect(tileValue('Upcoming')).toBe('Unavailable'));
  });
});

describe('Attendance: the recorded marks, counted and never divided', () => {
  test('the tile and status row show this child’s marks, and move with the selection', async () => {
    installFetch();
    await renderHub();
    await waitFor(() => expect(tileValue('Attendance')).toMatch(/^Present 1 · Excused 1 · Absent 0Last marked Jan 14, 2020/));
    expect(statusPanelText()).toContain('Present 1 · Excused 1 · Absent 0');
    // Newest mark first: the excused one on the 14th.
    expect(statusPanelText()).toMatch(/Last marked Jan 14, 2020/);

    await selectChild('Second Child');
    expect(tileValue('Attendance')).toMatch(/^Present 1 · Excused 0 · Absent 2Last marked Jan 21, 2020/);
    expect(statusPanelText()).toContain('Present 1 · Excused 0 · Absent 2');
    expect(statusPanelText()).toMatch(/Last marked Jan 21, 2020/);
  });

  test('a child with no marks reads zeros and no last-marked line', async () => {
    installFetch({ scheduler: async () => jsonResponse({ ok: true, classes: [], registrations: [], attendance: [] }) });
    await renderHub();
    await waitFor(() => expect(tileValue('Attendance')).toBe('Present 0 · Excused 0 · Absent 0'));
    expect(statusPanelText()).not.toContain('Last marked');
  });

  test('a failed schedule read is Unavailable on both, not zeros', async () => {
    installFetch({ scheduler: async () => jsonResponse({ error: 'down' }, false) });
    await renderHub();
    await waitFor(() => expect(tileValue('Attendance')).toBe('Unavailable'));
    expect(statusPanelText()).not.toContain('Present 0');
  });

  test('no attendance percentage anywhere on the overview', async () => {
    installFetch();
    const { container } = render(<ParentHub />);
    await waitFor(() => expect(tileValue('Attendance')).toMatch(/^Present 1 · Excused 1 · Absent 0/));
    expect(container.textContent ?? '').not.toMatch(/\d+\s*%/);
  });
});

describe('no child selected', () => {
  test('a schedule that answered before the roster, with the roster failing, is not zero sessions', async () => {
    const fetchMock = jest.fn(async (input: unknown) => {
      const url = String(input);
    // FC-06: the Messages tab's "Sent to your athlete" copy; none here.
    if (url.includes('/api/pilot/parent/athlete-messages')) return jsonResponse({ ok: true, items: [] });
      if (url.includes('/api/pilot/athletes/list')) return jsonResponse({ error: 'down' }, false);
      if (url.includes('/api/pilot/scheduler')) return jsonResponse(SCHEDULE);
      return jsonResponse({ ok: true, items: [], announcements: [], card: null });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await act(async () => {
      render(<ParentHub />);
    });
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/pilot/scheduler'))).toBe(true));
    expect(tileValue('Upcoming')).toBe('Unavailable');
    expect(tileValue('Attendance')).toBe('Unavailable');
    expect(tileValue('Progress')).toBe('Unavailable');
  });
});

describe('what the overview no longer says, and what it still does', () => {
  test('the "Data Availability" box is gone', async () => {
    installFetch();
    await renderHub();
    expect(screen.queryByText('Data Availability')).toBeNull();
    expect(screen.queryByText(/hidden until backend-authoritative feeds/)).toBeNull();
  });

  test('membership, scholarship and community-service rows are unchanged (Q2 = B for this PR)', async () => {
    installFetch();
    await renderHub();
    const text = statusPanelText();
    expect(text).toContain('Membership Status');
    expect(text).toContain('Scholarship Status');
    expect(text).toContain('Community Service Support Status');
  });
});

describe('the paper version (#1596 item 2b)', () => {
  afterEach(() => {
    window.sessionStorage.clear();
  });

  test('the print link carries no child id in the address; the chosen child goes over in tab storage', async () => {
    installFetch();
    await renderHub();
    await selectChild('Second Child');

    const link = screen.getByRole('link', { name: 'Print their card and certificate' });
    expect(link.getAttribute('href')).toBe('/print');
    // Kept on selection, before any click: a middle-click fires no click.
    expect(window.sessionStorage.getItem('ppbf.parent.chosenChild')).toBe('ath_2');
    await selectChild('First Child');
    expect(window.sessionStorage.getItem('ppbf.parent.chosenChild')).toBe('ath_1');
  });
});

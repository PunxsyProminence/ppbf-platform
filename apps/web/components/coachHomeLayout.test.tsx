/**
 * @jest-environment jsdom
 */

/**
 * THE COACH HOME'S LAYOUT (lane 6C7, AS-7 step 7a-2; plan #2043).
 *
 * The design basis is the approved stage 2 coach home (section 3.4 rows 10 to
 * 26 and the 3.9 sketch, quoted by Overwatch on #2043): the tab row directly
 * under the masthead (CF-03); four jobs -- Run tonight's class, Athletes, Plan,
 * Safety -- and a More line, built from the coach's job bar in
 * components/jobBars.ts (#2029); Quick Actions and the Clinic row move into
 * those jobs (rows 21 and 22); "Open class screen" on each class scheduled
 * today (CF-07, Q8); a Passbook link on the athlete the coach chose (AS-11's
 * ask, #2017 Q7 = A).
 *
 * What this suite also holds: the safety lists keep their place above the
 * jobs, and the per-athlete panels do not move (Q4: "Per-athlete health panels
 * do not move in AS-7").
 */

import fs from 'fs';
import path from 'path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import CoachWorkspace from './CoachWorkspace';
import { BUILDING } from './buildingMap';
import { jobBarFor } from './jobBars';
import { ui } from './uiStyles';

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

type Route = () => Response;

interface Routes {
  athletesList?: Route;
  scheduler?: Route;
}

/* Every default is a HEALTHY read that found nothing, as in the workspace's
   other suites, so what renders here is the layout and not a failure state. */
function installFetch(routes: Routes = {}): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/api/pilot/auth/session')) return jsonResponse({ authenticated: true, account_id: 'acct_coach_1' });
    if (url.includes('/api/pilot/athletes/list')) return routes.athletesList ? routes.athletesList() : jsonResponse({ items: [] });
    if (url.includes('/api/pilot/session-scripts/runs')) return jsonResponse({ run: null });
    if (url.includes('/api/pilot/scheduler')) return routes.scheduler ? routes.scheduler() : jsonResponse({ ok: true, classes: [] });
    if (url.includes('/api/pilot/coach/credentials')) return jsonResponse({ ok: true, items: [] });
    if (url.includes('/api/pilot/coach/attendance-today')) {
      return jsonResponse({ ok: true, day: '2026-08-28', covered: ['ath_1'], marks: [] });
    }
    if (url.includes('/api/pilot/coach/development')) return jsonResponse({ ok: true, goals: [], activities: [] });
    if (url.includes('/api/pilot/coach/readiness-board')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/sessions/list')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/floor-plans')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/shadow/review-projection')) return jsonResponse({ queue: [] });
    if (url.includes('/api/pilot/shadow/observation-projection')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/coach-reviews/list')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/announcements/get')) return jsonResponse({ ok: true, announcements: [] });
    if (url.includes('/api/pilot/coach/pain-reports')) {
      return jsonResponse({ ok: true, painReports: [], windowDays: 14, truncated: false });
    }
    if (url.includes('/api/pilot/coach/barrier-reports')) return jsonResponse({ ok: true, barrierReports: [], truncated: false });
    if (url.includes('/api/pilot/escalations')) return jsonResponse({ ok: true, escalations: [] });
    // The classes and rounds above the names (lane W4-3, FN-4b): a healthy read with no class running.
    if (url.includes('/api/pilot/on-the-floor/classes')) return jsonResponse({ ok: true, read_at: '2026-08-28T16:00:00.000Z', classes: [], rounds: [] });
    if (url.includes('/api/pilot/on-the-floor')) return jsonResponse({ ok: true, day: '2026-08-28', athletes: [] });
    // The per-athlete panels a roster tap opens read their own routes; an
    // empty healthy answer is enough here, where only the link is asserted.
    if (url.includes('/api/pilot/')) return jsonResponse({ ok: true, items: [] });
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderWorkspace(routes: Routes = {}): Promise<void> {
  installFetch(routes);
  await act(async () => {
    render(<CoachWorkspace />);
  });
}

const jobs = () => within(screen.getByRole('region', { name: 'Your jobs' }));

/** True when `first` comes before `second` in document order. */
function before(first: Element, second: Element): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

const doorLabel = (href: string) => BUILDING.find((door) => door.href === href)?.label;

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the tab row sits directly under the masthead (CF-03)', () => {
  test('it comes before the floor board, the safety lists and the jobs', async () => {
    await renderWorkspace();

    const dashboardTab = screen.getByRole('button', { name: /^Dashboard/ });
    expect(before(dashboardTab, screen.getByRole('region', { name: 'The floor' }))).toBe(true);
    expect(before(dashboardTab, screen.getByRole('heading', { name: 'Athlete Pain Reports' }))).toBe(true);
    expect(before(dashboardTab, screen.getByRole('heading', { name: 'Safety Escalations' }))).toBe(true);
    expect(before(dashboardTab, screen.getByRole('heading', { name: 'Family Barrier Reports' }))).toBe(true);
    expect(before(dashboardTab, screen.getByRole('region', { name: 'Your jobs' }))).toBe(true);
    // ...and after the masthead's own heading.
    expect(before(screen.getByRole('heading', { level: 2, name: 'Dashboard' }), dashboardTab)).toBe(true);
  });
});

describe('the four jobs and More, from the coach job bar (stage 2 3.9; #2029)', () => {
  const bar = jobBarFor('coach');

  test('four jobs, in the sketch order, each opening its section\'s first page', async () => {
    await renderWorkspace();

    const sections = new Map(bar!.sections.map((section) => [section.label, section.items]));
    const expected: Array<[string, string]> = [
      ["Run tonight's class", sections.get('Class')![0].href],
      ['Athletes', sections.get('Athletes')![0].href],
      ['Plan', sections.get('Plan')![0].href],
      ['Safety', sections.get('Safety')![0].href],
    ];
    // The class screen, Passbook, Class plans and the Clearance Board, as the bar has them today.
    expect(expected.map(([, href]) => href)).toEqual([
      '/coach/class', '/coach/passbook', '/coach/class-plans', '/coach/sports-medicine',
    ]);

    const main = jobs().getAllByRole('link').filter((link) => link.hasAttribute('data-job'));
    expect(main.map((link) => [link.textContent, link.getAttribute('href')])).toEqual(expected);
    // Each button says where it goes, to a screen reader as well as on screen.
    expect(main.map((link) => (link as HTMLElement).getAttribute('aria-describedby') && document.getElementById(link.getAttribute('aria-describedby')!)?.textContent))
      .toEqual(['Opens Class screen', 'Opens Passbook', 'Opens Class plans', 'Opens Clearance Board']);
  });

  test('every page in each section is reachable from its job, by its door label', async () => {
    await renderWorkspace();

    for (const section of bar!.sections.filter((s) => s.label !== 'Home')) {
      const job = within(screen.getByRole('group', { name: section.label }));
      for (const item of section.items) {
        const links = job.getAllByRole('link').filter((link) => link.getAttribute('href') === item.href);
        expect(links.length).toBeGreaterThan(0);
        expect(links.some((link) => link.textContent?.includes(doorLabel(item.href)!) || link.hasAttribute('data-job'))).toBe(true);
      }
    }
  });

  test('the Clinic row moved into Safety: its pages are there (row 22; three since lane AS-5 made Sparring and Limits one page)', async () => {
    await renderWorkspace();

    const safety = within(screen.getByRole('group', { name: 'Safety' }));
    for (const href of ['/coach/sports-medicine', '/coach/athlete-safety', '/coach/sparring-exposure']) {
      const link = safety.getAllByRole('link').find((candidate) => candidate.getAttribute('href') === href);
      expect(link).toBeTruthy();
      // Still one tap from home, as the Clinic row made them: in view, not
      // behind the job's closed "more" list (jsdom draws a closed <details>
      // whole, so this asks the DOM, not the screen).
      expect(link!.closest('details')).toBeNull();
    }
    // The old row is gone, not kept beside it.
    expect(screen.queryByRole('heading', { name: 'Clinic' })).toBeNull();
  });

  test('every Quick Actions page is still one tap from home, inside Class or Plan (row 21)', async () => {
    await renderWorkspace();

    const hrefs = (name: string) =>
      within(screen.getByRole('group', { name })).getAllByRole('link').map((link: HTMLElement) => link.getAttribute('href'));
    expect(hrefs('Class')).toEqual(expect.arrayContaining(['/schedule', '/coach/floor-groups']));
    expect(hrefs('Plan')).toEqual(expect.arrayContaining(['/coach/drills', '/coach/cue-library', '/coach/workout-templates']));
    expect(screen.queryByRole('heading', { name: 'Quick Actions' })).toBeNull();
  });

  test('More lists the bar\'s More pages', async () => {
    await renderWorkspace();

    const more = within(screen.getByRole('group', { name: 'More' }));
    expect(more.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual(bar!.more.map((item) => item.href));
  });

  test('the jobs are the home\'s: another tab does not show them', async () => {
    await renderWorkspace();

    fireEvent.click(screen.getByRole('button', { name: 'Your Growth' }));
    expect(screen.queryByRole('region', { name: 'Your jobs' })).toBeNull();
  });

  test('the safety lists stay above the jobs; notices and Coach Standard sit below them', async () => {
    await renderWorkspace();

    const region = screen.getByRole('region', { name: 'Your jobs' });
    expect(before(screen.getByRole('heading', { name: 'Athlete Pain Reports' }), region)).toBe(true);
    expect(before(screen.getByRole('heading', { name: 'Safety Escalations' }), region)).toBe(true);
    expect(before(screen.getByRole('heading', { name: 'Family Barrier Reports' }), region)).toBe(true);
    expect(before(region, screen.getByText('Coach Standard'))).toBe(true);
    // The pain list keeps its place first among the safety lists, under the board.
    const pain = screen.getByRole('heading', { name: 'Athlete Pain Reports' });
    expect(before(screen.getByRole('region', { name: 'The floor' }), pain)).toBe(true);
    expect(before(pain, screen.getByRole('heading', { name: 'Safety Escalations' }))).toBe(true);
    expect(before(pain, screen.getByRole('heading', { name: 'Family Barrier Reports' }))).toBe(true);
  });
});

describe('who is on the floor now (lane W4-3, FN-3; Jason Q3.3 A)', () => {
  const SESSION_STATUS = 'No session in progress. Session Plans is where a live delivery starts.';
  const floorReads = (fetchMock: jest.Mock) =>
    fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/pilot/on-the-floor')).length;

  test('the line sits below every safety list, on the home and on another tab, and a tab change does not read it again', async () => {
    const fetchMock = installFetch();
    await act(async () => {
      render(<CoachWorkspace />);
    });

    const line = () => screen.getByRole('region', { name: 'Who is on the floor' });
    const belowTheSafetyLists = () => {
      expect(before(screen.getByRole('heading', { name: 'Athlete Pain Reports' }), line())).toBe(true);
      expect(before(screen.getByRole('heading', { name: 'Safety Escalations' }), line())).toBe(true);
      expect(before(screen.getByRole('heading', { name: 'Family Barrier Reports' }), line())).toBe(true);
    };

    expect(within(line()).getByText('Nobody is counted on the floor right now.')).toBeTruthy();
    belowTheSafetyLists();

    fireEvent.click(screen.getByRole('button', { name: 'Your Growth' }));
    belowTheSafetyLists();
    // Beside the session-status line, which the role summary panel carries off the Dashboard.
    expect(before(line(), screen.getByText(SESSION_STATUS))).toBe(true);
    expect(floorReads(fetchMock)).toBe(1);
  });
});

describe('"Open class screen" on each class scheduled today (CF-07, Q8)', () => {
  // The coach home keeps a class when its start falls on today's GYM date
  // (formatGymDateNumeric), but this test used to build "today" from the
  // runner's own clock. Between 00:00 and 05:00 UTC the gym's date is still
  // yesterday, so the classes fell off the list and the test failed. Pin the
  // clock to midday at the gym (16:00 UTC) so both dates agree; only Date is
  // faked, so the async render keeps its real timers.
  const NOW = new Date('2026-06-15T16:00:00Z');
  beforeAll(() => {
    jest.useFakeTimers({
      now: NOW,
      doNotFake: [
        'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame',
        'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate',
        'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
      ],
    });
  });
  afterAll(() => {
    jest.useRealTimers();
  });
  const at = (hour: number) => new Date(NOW.getTime() + (hour - 12) * 3_600_000).toISOString();

  test('a scheduled class opens the class screen on that class; a cancelled one does not', async () => {
    await renderWorkspace({
      scheduler: () => jsonResponse({
        ok: true,
        classes: [
          { class_id: 'cls 1', title: 'Youth Boxing', start_at: at(12), end_at: at(13), status: 'open', location: null },
          { class_id: 'cls_2', title: 'Adult Boxing', start_at: at(14), end_at: at(15), status: 'cancelled', location: null },
        ],
      }),
    });

    const open = screen.getAllByRole('link', { name: /^Open class screen/ });
    expect(open).toHaveLength(1);
    expect(open[0].getAttribute('href')).toBe('/coach/class?class=cls%201');
    expect(open[0].textContent).toContain('Youth Boxing');
  });
});

describe('Passbook on the athlete the coach chose (AS-11 ask, #2017 Q7 = A)', () => {
  test('no link until the coach picks an athlete; then it opens that athlete\'s Passbook', async () => {
    await renderWorkspace({
      athletesList: () => jsonResponse({ items: [{ athlete_id: 'ath_1', full_name: 'Jordan P.' }] }),
    });

    // The roster seeds a selection; a selection nobody made opens nothing.
    expect(screen.queryByRole('link', { name: /^Open Passbook/ })).toBeNull();

    const row = document.querySelector('[data-roster-athlete-id="ath_1"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(row);
    });

    const link = screen.getByRole('link', { name: /^Open Passbook/ });
    expect(link.getAttribute('href')).toBe('/coach/passbook?athlete_id=ath_1');
    expect(link.textContent).toContain('Jordan P.');
  });
});

describe('the Group / One-on-One switch styles left with the switch (7a-1)', () => {
  test('uiStyles carries no modeButton style', () => {
    expect(Object.keys(ui).filter((key) => key.startsWith('modeButton'))).toEqual([]);
    const source = fs.readFileSync(path.join(__dirname, 'uiStyles.ts'), 'utf8');
    expect(source).not.toMatch(/modeButton/);
  });
});

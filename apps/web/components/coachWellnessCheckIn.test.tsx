/**
 * @jest-environment jsdom
 */

/**
 * A-FIN-03 -- a coach reads the wellness check-in of the athlete they picked.
 * A-FIN-08 -- and, in the same panel and on the same click, the note that
 * athlete shared with their coach for today's session.
 *
 * The routes decide WHO may read (see
 * app/api/pilot/coach/athlete-check-in/route.test.ts and
 * app/api/pilot/coach/athlete-session-note/route.test.ts). These cases are
 * about what the coach is then told, and the ways that can go wrong on a
 * screen: a skipped question shown as a number, a failed read shown as "no
 * check-in", a refusal shown as either, one child's answers or one child's
 * message drawn under another child's name, a band/average appearing that
 * nobody measured, or -- the A-FIN-08 one -- text the system wrote presented
 * as something a child said, or a note presented as the athlete's when the
 * row cannot say who wrote it.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import { WELLNESS_SCALES, wellnessAnchor, type WellnessScaleKey } from '@/src/shared/wellnessScales';

import CoachWorkspace from './CoachWorkspace';

const ATHLETES = [
  { athlete_id: 'ath_1', full_name: 'Jordan P.' },
  { athlete_id: 'ath_2', full_name: 'Sam R.' },
] as const;

/** The panel's sentences, pinned here as literals: a test that imported them
 *  from the component would pass whatever the component said. */
const NO_CHECK_IN_TODAY = 'No wellness check-in recorded today.';
/** A value the record does not hold. The owner's wording (2026-09-22): the
 *  panel reports what is stored, so a null is "Not reported" and never the
 *  "Not answered" the athlete's own screen uses about its own form. */
const NOT_REPORTED = 'Not reported';
const READ_FAILED =
  'Today’s wellness check-in could not be loaded. This is not a statement that the athlete did not check in -- try again in a minute.';
/** The refusal sentence as A-FIN-03R1 leaves it: the audience, with no claim
 *  about assignment or coverage. Pinned as a literal for the same reason as
 *  the rest -- imported copy would pass whatever the component said. */
const NO_ACCESS =
  'You don’t have access to this athlete’s wellness check-ins. They are shown to coaches and organization admins in the athlete’s own organization.';

/** The panel's one empty state, which A-FIN-08 made cover both subsections.
 *  The wellness-only sentence it replaces would otherwise have stood beside a
 *  second "select an athlete" line -- one panel telling a coach the same thing
 *  twice, in two wordings, about one roster. */
const NO_SELECTION = 'Select an athlete in the roster to see today’s wellness check-in and session note.';

/** The A-FIN-08 subsection's sentences, pinned as literals for the same reason
 *  as the wellness ones above: copy imported from the component would pass
 *  whatever the component happened to say. */
const NOTE_LOADING = 'Loading today’s session note...';
/** Two different facts about a child's day, in two sets of words: nobody has
 *  begun a session, versus a session is under way carrying no message. */
const NO_SESSION_TODAY = 'No session started today.';
const NO_NOTE_WRITTEN = 'No session note written today.';
const NOTE_READ_FAILED =
  'Today’s session note could not be loaded. This is not a statement that no note was written -- try again.';
/** Where the text lives and the limit of what is known about it. Both halves
 *  are asserted, because dropping either turns it into a claim: without the
 *  first it does not say the text is on the session record, and without the
 *  second the screen stops admitting that the row records no author. */
const NOTE_ATTRIBUTION =
  'Recorded on this session. The session row does not record who wrote or last edited this text.';

/** The two strings pilot.sessions carries when nobody wrote anything: today's
 *  placeholder, and the pre-A-FIN-01 readiness marker that wrote "GREEN" onto
 *  a session for an athlete who touched nothing. Pinned by value rather than
 *  imported from src/shared/sessionNoteSemantics because these are the exact
 *  bytes sitting in rows nobody is rewriting, and the point of the assertions
 *  below is that THESE cannot reach a coach's eye -- a constant imported from
 *  the recogniser would move with it. */
const SYSTEM_PLACEHOLDER = 'No athlete note provided at check-in.';
const HISTORICAL_AUTO_NOTE = 'Auto check-in readiness GREEN';

/** A shared note with the writer's own line break in it: the thing "exactly as
 *  stored" is about. */
const SHARED_NOTE = 'Ankle rolled at school yesterday.\nWould rather do footwork than spar.';

/** The coach-facing name of every 1-5 measure, as the owner listed them. */
const MEASURE_LABELS: Readonly<Record<WellnessScaleKey, string>> = {
  energy: 'Energy',
  soreness: 'Soreness',
  focus: 'Focus',
  motivation: 'Motivation',
  hydration: 'Hydration',
  mental_clarity: 'Mental clarity',
  stress: 'Stress',
  nutrition_compliance: 'Nutrition compliance',
};

const JORDAN_NOTE = 'Left knee is "tight" after sparring.\nStill want to work pads.';

/** A pilot.athlete_check_ins row as the coach route returns it in `today`. */
function checkInRow(athleteId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    organization_id: 'org-1',
    check_in_id: `ci-${athleteId}`,
    athlete_id: athleteId,
    checked_in_on: '2026-09-22',
    energy: 4,
    soreness: 2,
    focus: 5,
    sleep_hours: 7.5,
    hydration: 3,
    motivation: 1,
    mental_clarity: 2,
    stress: 5,
    nutrition_compliance: 4,
    note: JORDAN_NOTE,
    created_at: '2026-09-22T21:05:00.000Z',
    ...overrides,
  };
}

/** A bare check-in: here, and every question skipped. */
function bareRow(athleteId: string): Record<string, unknown> {
  return checkInRow(athleteId, {
    energy: null,
    soreness: null,
    focus: null,
    sleep_hours: null,
    hydration: null,
    motivation: null,
    mental_clarity: null,
    stress: null,
    nutrition_compliance: null,
    note: '',
  });
}

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type AthleteRoute = (athleteId: string, init?: RequestInit) => Promise<Response> | Response;

interface WorkspaceOptions {
  /** Which athletes the attendance read reports as covered today. Default:
   *  both, which is what the rest of these cases assume. */
  readonly covered?: readonly string[];
}

/** The session-note route for the cases that are not about it: a gym day with
 *  no session yet. The quietest true answer, and one whose sentence no
 *  wellness assertion in this file looks for. */
const NO_SESSION_TODAY_ROUTE: AthleteRoute = () => jsonResponse({ today: null });

function installFetch(
  athleteCheckIn: AthleteRoute,
  sessionNote: AthleteRoute = NO_SESSION_TODAY_ROUTE,
  options: WorkspaceOptions = {},
): jest.Mock {
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);

    if (url.includes('/api/pilot/coach/athlete-check-in')) {
      const athleteId = new URL(url, 'http://localhost').searchParams.get('athlete_id') ?? '';
      return athleteCheckIn(athleteId, init);
    }
    if (url.includes('/api/pilot/coach/athlete-session-note')) {
      const athleteId = new URL(url, 'http://localhost').searchParams.get('athlete_id') ?? '';
      return sessionNote(athleteId, init);
    }
    if (url.includes('/api/pilot/athletes/list')) return jsonResponse({ items: ATHLETES });
    if (url.includes('/api/pilot/profile/roster')) return jsonResponse({ ok: true, items: [] });
    if (url.includes('/api/pilot/auth/session')) {
      return jsonResponse({ authenticated: true, account_id: 'acct_coach_1' });
    }
    if (url.includes('/api/pilot/session-scripts/runs')) return jsonResponse({ run: null });
    if (url.includes('/api/pilot/scheduler')) return jsonResponse({ ok: true, classes: [] });
    if (url.includes('/api/pilot/coach/credentials')) return jsonResponse({ ok: true, items: [] });
    if (url.includes('/api/pilot/coach/attendance-today')) {
      return jsonResponse({
        ok: true,
        day: '2026-09-22',
        covered: [...(options.covered ?? ['ath_1', 'ath_2'])],
        marks: [],
      });
    }
    if (url.includes('/api/pilot/coach/development')) return jsonResponse({ ok: true, goals: [], activities: [] });
    if (url.includes('/api/pilot/coach/readiness-board')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/shadow/review-projection')) return jsonResponse({ queue: [] });
    if (url.includes('/api/pilot/shadow/observation-projection')) return jsonResponse({ items: [] });
    if (url.includes('/api/pilot/announcements/get')) return jsonResponse({ ok: true, announcements: [] });
    if (url.includes('/api/pilot/coach/pain-reports')) {
      return jsonResponse({ ok: true, painReports: [], windowDays: 14, truncated: false });
    }
    if (url.includes('/api/pilot/coach/barrier-reports')) {
      return jsonResponse({ ok: true, barrierReports: [], truncated: false });
    }
    if (url.includes('/api/pilot/escalations')) return jsonResponse({ ok: true, escalations: [] });

    throw new Error(`Unexpected fetch: ${url}`);
  });

  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderWorkspace(
  athleteCheckIn: AthleteRoute,
  sessionNote: AthleteRoute = NO_SESSION_TODAY_ROUTE,
  options: WorkspaceOptions = {},
): Promise<jest.Mock> {
  const fetchMock = installFetch(athleteCheckIn, sessionNote, options);
  await act(async () => {
    render(<CoachWorkspace />);
  });
  await screen.findByText('Jordan P.');
  return fetchMock;
}

/** The roster row for an athlete -- the whole card is the select. */
function rosterRow(name: string): HTMLButtonElement {
  const row = screen.getAllByText(name)
    .map((element) => element.closest('button'))
    .find((button): button is HTMLButtonElement => button !== null);
  if (!row) throw new Error(`No roster row for ${name}`);
  return row;
}

async function pickAthlete(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(rosterRow(name));
  });
}

/** Whether a row is wearing the selected look. Pinned to the two classes the
 *  roster uses for it, checked as whole class tokens: the UNSELECTED row
 *  carries `hover:border-[color:var(--brass-500)]`, so a substring test for the
 *  brass border would report every row as selected. */
function looksSelected(row: HTMLButtonElement): boolean {
  return row.classList.contains('bg-[rgb(var(--brass-400-rgb)_/_.10)]')
    && row.classList.contains('border-[color:var(--brass-500)]');
}

function panel(): HTMLElement {
  return screen.getByRole('region', { name: 'Wellness Check-In' });
}

/** The A-FIN-08 subsection inside that panel. It only exists once a coach has
 *  picked somebody, so asking for it is itself an assertion that a pick
 *  happened. */
function notePanel(): HTMLElement {
  return screen.getByRole('region', { name: 'Session note' });
}

/** The rendered note text, read off the DOM rather than matched with
 *  getByText, which normalises whitespace: a note reflowed onto one line would
 *  pass a text match and fail a coach reading a three-line list. Selecting the
 *  pre-wrap paragraph also asserts the class that keeps the line breaks
 *  visible. Null when no note text is drawn at all. */
function noteText(): string | null {
  const paragraph = notePanel().querySelector('p.whitespace-pre-wrap');
  return paragraph === null ? null : paragraph.textContent;
}

/** The displayed value under a measure's label. */
function measure(label: string): string {
  const term = within(panel()).getByText(label, { selector: 'dt' });
  return term.nextElementSibling?.textContent ?? '';
}

function checkInRequests(fetchMock: jest.Mock): Array<[unknown, RequestInit | undefined]> {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/pilot/coach/athlete-check-in')) as Array<
    [unknown, RequestInit | undefined]
  >;
}

function sessionNoteRequests(fetchMock: jest.Mock): Array<[unknown, RequestInit | undefined]> {
  return fetchMock.mock.calls.filter(
    ([input]) => String(input).includes('/api/pilot/coach/athlete-session-note'),
  ) as Array<[unknown, RequestInit | undefined]>;
}

/** /api/pilot/sessions/list keeps the narrower coach-of-record-or-coverage
 *  gate and was deliberately NOT widened for this slice, so the note surface
 *  must never be found asking it. */
function sessionsListRequests(fetchMock: jest.Mock): unknown[] {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/pilot/sessions/list'));
}

let consoleError: jest.SpyInstance;

beforeEach(() => {
  // Failure cases log the status for diagnosis; the log is asserted where it
  // matters and kept out of the test output everywhere else.
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the read starts from a deliberate pick', () => {
  it('reads nothing for the roster\'s seeded selection, and says how to start', async () => {
    const fetchMock = await renderWorkspace(() => jsonResponse({ today: checkInRow('ath_1') }));

    expect(checkInRequests(fetchMock)).toHaveLength(0);
    expect(within(panel()).getByText(NO_SELECTION)).not.toBeNull();
    // And the panel is the only thing on screen making a claim about the
    // selection: nothing is loading, and no answer of any kind is drawn.
    expect(within(panel()).queryAllByRole('term')).toHaveLength(0);
    expect(within(panel()).queryByText(/Loading today's wellness check-in/)).toBeNull();
  });

  it('leaves every roster row unselected while the selection is only the seeded one', async () => {
    /* The roster seeds `selectedAthleteId` with the first athlete when it
       loads (CoachWorkspace.loadAthletes). The seed stays -- other behaviour
       needs it -- but nothing on screen may present it as the coach's choice.

       A lit row and a coach's pick are two different claims, and only the
       second is a person deciding to look at a particular child's
       self-report. So on arrival no row is lit, the panel says how to start,
       and nothing has been asked for. */
    const fetchMock = await renderWorkspace(() => jsonResponse({ today: checkInRow('ath_1') }));

    expect(looksSelected(rosterRow('Jordan P.'))).toBe(false);
    expect(looksSelected(rosterRow('Sam R.'))).toBe(false);
    expect(checkInRequests(fetchMock)).toHaveLength(0);
    expect(within(panel()).queryAllByRole('term')).toHaveLength(0);
  });

  it('asks the coach route for the picked athlete, by GET, with the session cookie', async () => {
    const fetchMock = await renderWorkspace(() => jsonResponse({ today: checkInRow('ath_2') }));

    await pickAthlete('Sam R.');

    const requests = checkInRequests(fetchMock);
    expect(requests).toHaveLength(1);
    const [url, init] = requests[0];
    expect(String(url)).toContain('/api/pilot/coach/athlete-check-in?athlete_id=ath_2');
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('include');
  });

  it('gives the picked row the selected look, and only that row', async () => {
    await renderWorkspace((athleteId) => jsonResponse({ today: checkInRow(athleteId) }));

    await pickAthlete('Sam R.');
    expect(looksSelected(rosterRow('Sam R.'))).toBe(true);
    expect(looksSelected(rosterRow('Jordan P.'))).toBe(false);

    // Including when the coach then picks the athlete the roster had seeded:
    // the look follows the pick, it does not accumulate.
    await pickAthlete('Jordan P.');
    expect(looksSelected(rosterRow('Jordan P.'))).toBe(true);
    expect(looksSelected(rosterRow('Sam R.'))).toBe(false);
  });

  it('reads once for the athlete that was clicked, and for nobody else', async () => {
    const fetchMock = await renderWorkspace(() => jsonResponse({ today: checkInRow('ath_2') }));

    await pickAthlete('Sam R.');

    const requests = checkInRequests(fetchMock).map(([url]) => String(url));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('athlete_id=ath_2');
    expect(requests[0]).not.toContain('athlete_id=ath_1');
    expect(within(panel()).getByText(/Today's report for Sam R\./)).not.toBeNull();
  });
});

describe('a check-in that exists is read back exactly as stored', () => {
  it('shows the date, every measure, sleep in hours and the note verbatim', async () => {
    await renderWorkspace(() => jsonResponse({ today: checkInRow('ath_1') }));
    await pickAthlete('Jordan P.');

    expect(within(panel()).getByText(/checked in on 2026-09-22\./)).not.toBeNull();
    expect(within(panel()).getByText(/Today's report for Jordan P\./)).not.toBeNull();

    // Sleep is a quantity: the stored hours, not a rating and not rounded.
    expect(measure('Sleep')).toBe('7.5 hours');

    // Each 1-5 answer is the stored number AND the words the athlete picked it
    // by -- taken from the shared scales module, not restated here.
    const row = checkInRow('ath_1');
    for (const scale of WELLNESS_SCALES) {
      const value = row[scale.key] as number;
      expect({ key: scale.key, shown: measure(MEASURE_LABELS[scale.key]) })
        .toEqual({ key: scale.key, shown: `${value} — ${wellnessAnchor(scale.key, value)}` });
    }
    // Pinned once by value too, so a change of wording in the shared module
    // is a visible diff here and not only a silent re-derivation.
    expect(measure('Stress')).toBe('5 — Very stressed');
    expect(measure('Soreness')).toBe('2 — A little stiff');

    const noteLabel = within(panel()).getByText("Athlete's note");
    expect(noteLabel.nextElementSibling?.textContent).toBe(JORDAN_NOTE);
  });

  it('lists every measure, including the ones the owner named, and nothing it did not store', async () => {
    await renderWorkspace(() => jsonResponse({ today: checkInRow('ath_1') }));
    await pickAthlete('Jordan P.');

    const terms = within(panel()).getAllByRole('term').map((term) => term.textContent);
    expect(terms).toEqual(['Sleep', ...WELLNESS_SCALES.map((scale) => MEASURE_LABELS[scale.key])]);
  });

  it('shows a stored null as "Not reported" -- never 0, never 3', async () => {
    await renderWorkspace(() => jsonResponse({ today: bareRow('ath_1') }));
    await pickAthlete('Jordan P.');

    expect(measure('Sleep')).toBe(NOT_REPORTED);
    for (const scale of WELLNESS_SCALES) {
      expect({ key: scale.key, shown: measure(MEASURE_LABELS[scale.key]) })
        .toEqual({ key: scale.key, shown: NOT_REPORTED });
    }
    const definitions = within(panel()).getAllByRole('definition').map((node) => node.textContent ?? '');
    for (const text of definitions) {
      expect(text).not.toMatch(/\d/);
    }
    expect(within(panel()).getByText('No note written.')).not.toBeNull();
  });

  it('keeps no record, a null value and an empty note in three separate sets of words', async () => {
    /* A check-in EXISTS here and every field in it is empty, which is the one
       case where the three could be run together. They are not: the row is
       there, so "No wellness check-in recorded today." would be false; each
       missing value says only that it was not reported; and the note gets its
       own sentence rather than the measures' words. */
    await renderWorkspace(() => jsonResponse({ today: bareRow('ath_1') }));
    await pickAthlete('Jordan P.');

    expect(within(panel()).queryByText(NO_CHECK_IN_TODAY)).toBeNull();
    expect(within(panel()).getAllByText(NOT_REPORTED).length).toBe(WELLNESS_SCALES.length + 1);
    expect(within(panel()).getByText('No note written.')).not.toBeNull();
    // The wording the owner ruled against, in case it comes back by habit.
    expect(panel().textContent).not.toMatch(/Not answered/);
  });

  it('shows a whitespace-only note as stored, not relabelled as "No note written."', async () => {
    // The athlete route stores body.note untrimmed, so this can be stored.
    const spacesNote = '  \n ';
    await renderWorkspace(() => jsonResponse({ today: checkInRow('ath_1', { note: spacesNote }) }));
    await pickAthlete('Jordan P.');

    const noteLabel = within(panel()).getByText("Athlete's note");
    expect(noteLabel.nextElementSibling?.textContent).toBe(spacesNote);
    expect(within(panel()).queryByText('No note written.')).toBeNull();
  });

  it('shows a partly answered check-in with each answer in its own place', async () => {
    await renderWorkspace(() => jsonResponse({
      today: checkInRow('ath_1', { focus: null, sleep_hours: 9, stress: null }),
    }));
    await pickAthlete('Jordan P.');

    expect(measure('Focus')).toBe(NOT_REPORTED);
    expect(measure('Stress')).toBe(NOT_REPORTED);
    expect(measure('Energy')).toBe(`4 — ${wellnessAnchor('energy', 4)}`);
    expect(measure('Sleep')).toBe('9 hours');
  });

  it('derives nothing: no band, no average, no score, no clearance', async () => {
    await renderWorkspace(() => jsonResponse({ today: checkInRow('ath_1') }));
    await pickAthlete('Jordan P.');

    const text = panel().textContent ?? '';
    expect(text).not.toMatch(/\b(GREEN|YELLOW|RED)\b/);
    expect(text).not.toMatch(/readiness|average|score|clearance|cleared|ready to train/i);
    // Nothing on the panel is badged, and nothing is coloured by the value.
    expect(panel().querySelector('.badge')).toBeNull();
    expect(panel().innerHTML).not.toMatch(/--(cleared|monitor|restricted|locked)\b/);
  });
});

describe('an empty day, a failed read and a refusal are three different answers', () => {
  it('no row today is said plainly, and is not a failure or a refusal', async () => {
    await renderWorkspace(() => jsonResponse({ today: null }));
    await pickAthlete('Jordan P.');

    expect(within(panel()).getByText(NO_CHECK_IN_TODAY)).not.toBeNull();
    expect(within(panel()).queryByText(READ_FAILED)).toBeNull();
    expect(within(panel()).queryByText(NO_ACCESS)).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('a server failure is a failure, in plain words, with the status kept off the screen', async () => {
    await renderWorkspace(() => jsonResponse({ error: 'Internal server error' }, { ok: false, status: 500 }));
    await pickAthlete('Jordan P.');

    expect(within(panel()).getByText(READ_FAILED)).not.toBeNull();
    expect(within(panel()).queryByText(NO_CHECK_IN_TODAY)).toBeNull();
    expect(within(panel()).queryByText(NO_ACCESS)).toBeNull();
    expect(panel().textContent).not.toMatch(/500|Internal server error/);
    // The status is not lost -- it goes where a person diagnosing it looks.
    expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({
      event: 'coach-wellness-check-in-load-failed',
      error: expect.objectContaining({ cause: { status: 500 } }),
    }));
  });

  it('a request that never landed is a failure, not an empty day', async () => {
    await renderWorkspace(() => {
      throw new TypeError('Failed to fetch');
    });
    await pickAthlete('Jordan P.');

    expect(within(panel()).getByText(READ_FAILED)).not.toBeNull();
    expect(within(panel()).queryByText(NO_CHECK_IN_TODAY)).toBeNull();
    expect(panel().textContent).not.toMatch(/Failed to fetch/);
  });

  it.each([
    ['a body with no `today` at all', {}],
    ['a row with a measure missing', { today: (() => { const row = checkInRow('ath_1'); delete row.stress; return row; })() }],
    ['a row with sleep sent as text', { today: checkInRow('ath_1', { sleep_hours: '7.5' }) }],
    ['a row for a different athlete', { today: checkInRow('ath_2') }],
  ])('%s is an unreadable response, never "no check-in" or "Not reported"', async (_label, body) => {
    await renderWorkspace(() => jsonResponse(body));
    await pickAthlete('Jordan P.');

    expect(within(panel()).getByText(READ_FAILED)).not.toBeNull();
    expect(within(panel()).queryByText(NO_CHECK_IN_TODAY)).toBeNull();
    expect(within(panel()).queryByText(NOT_REPORTED)).toBeNull();
    expect(within(panel()).queryByText(/Left knee/)).toBeNull();
  });

  it('a refusal says only that this coach has no access, and shows no wellness data', async () => {
    // The message the route now refuses with: the athlete is not a live
    // athlete in this session's organization.
    await renderWorkspace(() => jsonResponse({ error: 'Forbidden: athlete does not belong to organization' }, { ok: false, status: 403 }));
    await pickAthlete('Jordan P.');

    expect(within(panel()).getByText(NO_ACCESS)).not.toBeNull();
    expect(within(panel()).queryByText(NO_CHECK_IN_TODAY)).toBeNull();
    expect(within(panel()).queryByText(READ_FAILED)).toBeNull();
    expect(within(panel()).queryAllByRole('term')).toHaveLength(0);
    expect(panel().textContent).not.toMatch(/Forbidden|403/);
  });

  it('the refusal does not restate the obsolete coach-of-record / coverage rule', async () => {
    /* A-FIN-03R1: wellness is no longer limited to the athlete's own coach or
       a coach covering for them, so a refusal that still explained the rule
       that way would send a coach off to ask for an assignment that would not
       have helped -- a true refusal behind a false explanation. The words are
       checked, not just the sentence, so the old wording cannot return in a
       paraphrase. */
    await renderWorkspace(() => jsonResponse({ error: 'Forbidden: athlete does not belong to organization' }, { ok: false, status: 403 }));
    await pickAthlete('Jordan P.');

    const text = panel().textContent ?? '';
    expect(text).toContain(NO_ACCESS);
    expect(text).not.toMatch(/coach of record|covering|coverage|assigned/i);
  });

  it('a failed read can be tried again, and the retry reads the same athlete', async () => {
    let attempts = 0;
    const fetchMock = await renderWorkspace(() => {
      attempts += 1;
      return attempts === 1
        ? jsonResponse({ error: 'Internal server error' }, { ok: false, status: 500 })
        : jsonResponse({ today: checkInRow('ath_1') });
    });
    await pickAthlete('Jordan P.');
    expect(within(panel()).getByText(READ_FAILED)).not.toBeNull();

    await act(async () => {
      fireEvent.click(within(panel()).getByRole('button', { name: 'Try loading the wellness check-in again' }));
    });

    expect(within(panel()).queryByText(READ_FAILED)).toBeNull();
    expect(measure('Sleep')).toBe('7.5 hours');
    const requests = checkInRequests(fetchMock).map(([url]) => String(url));
    expect(requests).toHaveLength(2);
    expect(requests.every((url) => url.includes('athlete_id=ath_1'))).toBe(true);
  });
});

describe('one athlete\'s answers never appear under another\'s name', () => {
  it('a slow response for the first athlete cannot overwrite the second', async () => {
    const slowJordan = deferred<Response>();
    const signals: Record<string, AbortSignal | undefined> = {};
    await renderWorkspace((athleteId, init) => {
      signals[athleteId] = init?.signal ?? undefined;
      return athleteId === 'ath_1'
        ? slowJordan.promise
        : jsonResponse({ today: checkInRow('ath_2', { note: 'Sam feels fine.', energy: 2 }) });
    });

    await pickAthlete('Jordan P.');
    await pickAthlete('Sam R.');

    // Picking Sam cancelled Jordan's request outright.
    expect(signals.ath_1?.aborted).toBe(true);
    expect(signals.ath_2?.aborted).toBe(false);
    expect(within(panel()).getByText(/Today's report for Sam R\./)).not.toBeNull();

    // Jordan's answer arrives anyway (a fetch that ignores the signal). It is
    // dropped: Sam's check-in stays on screen, and none of Jordan's does.
    await act(async () => {
      slowJordan.resolve(jsonResponse({ today: checkInRow('ath_1') }));
    });

    expect(within(panel()).getByText(/Today's report for Sam R\./)).not.toBeNull();
    expect(measure('Energy')).toBe(`2 — ${wellnessAnchor('energy', 2)}`);
    expect(within(panel()).getByText('Sam feels fine.')).not.toBeNull();
    expect(within(panel()).queryByText(/Left knee/)).toBeNull();
    expect(within(panel()).queryByText(/Jordan P\./)).toBeNull();
  });

  it('a first athlete\'s answer landing while the second is still loading is not shown', async () => {
    const slowJordan = deferred<Response>();
    const slowSam = deferred<Response>();
    await renderWorkspace((athleteId) => (athleteId === 'ath_1' ? slowJordan.promise : slowSam.promise));

    await pickAthlete('Jordan P.');
    await pickAthlete('Sam R.');

    await act(async () => {
      slowJordan.resolve(jsonResponse({ today: checkInRow('ath_1') }));
    });

    // Still Sam's loading line -- not Jordan's answers, and not a failure.
    expect(within(panel()).getByText(/Loading today's wellness check-in for Sam R\./)).not.toBeNull();
    expect(within(panel()).queryByText(/Left knee/)).toBeNull();
    expect(within(panel()).queryAllByRole('term')).toHaveLength(0);
    expect(within(panel()).queryByText(READ_FAILED)).toBeNull();

    await act(async () => {
      slowSam.resolve(jsonResponse({ today: null }));
    });
    expect(within(panel()).getByText(NO_CHECK_IN_TODAY)).not.toBeNull();
  });

  it('a stale failure for the first athlete does not paint the second as failed', async () => {
    const slowJordan = deferred<Response>();
    await renderWorkspace((athleteId) => (athleteId === 'ath_1'
      ? slowJordan.promise
      : jsonResponse({ today: null })));

    await pickAthlete('Jordan P.');
    await pickAthlete('Sam R.');

    await act(async () => {
      slowJordan.resolve(jsonResponse({ error: 'Internal server error' }, { ok: false, status: 500 }));
    });

    expect(within(panel()).getByText(NO_CHECK_IN_TODAY)).not.toBeNull();
    expect(within(panel()).queryByText(READ_FAILED)).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
   A-FIN-08: the session note reaches the coach.

   The athlete has been answering "Anything your coach should know before you
   start?" since A-FIN-01. The text went onto pilot.sessions and stopped there:
   no coach screen has ever shown it. These cases are about the subsection that
   closes that, and the specific ways a screen can turn a child's message into
   something false -- opening it for nobody, drawing it under the wrong name,
   printing the system's own filler as a sentence a child wrote, saying "no
   note" when nobody could look, or naming an author the row does not record.
   --------------------------------------------------------------------------- */

describe('the note read starts from a deliberate pick', () => {
  it('asks for no note at all until a coach clicks a roster row', async () => {
    /* The roster seeds `selectedAthleteId` with its first athlete
       (CoachWorkspace.loadAthletes), and a seeded id is not permission to open
       a message a child addressed to a coach. So: nothing asked for, no
       subsection on screen, and one sentence telling the coach how to start. */
    const fetchMock = await renderWorkspace(
      () => jsonResponse({ today: checkInRow('ath_1') }),
      () => jsonResponse({ today: { note: SHARED_NOTE } }),
    );

    expect(sessionNoteRequests(fetchMock)).toHaveLength(0);
    expect(within(panel()).getByText(NO_SELECTION)).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'Session note' })).toBeNull();
    expect(panel().textContent).not.toContain('Ankle rolled');
  });

  it('starts exactly one read, for the athlete clicked, by GET with the session cookie', async () => {
    const fetchMock = await renderWorkspace(
      () => jsonResponse({ today: checkInRow('ath_2') }),
      () => jsonResponse({ today: { note: SHARED_NOTE } }),
    );

    await pickAthlete('Sam R.');

    const requests = sessionNoteRequests(fetchMock);
    expect(requests).toHaveLength(1);
    const [url, init] = requests[0];
    expect(String(url)).toContain('/api/pilot/coach/athlete-session-note?athlete_id=ath_2');
    expect(String(url)).not.toContain('athlete_id=ath_1');
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('include');
  });

  it('shows the note to a coach this screen holds no assignment or coverage for', async () => {
    /* WHO MAY READ is the route's decision and is proved there
       (app/api/pilot/coach/athlete-session-note/route.test.ts): any coach or
       organization admin in the athlete's own organization, per Jason
       2026-09-25. What this case proves is the part the SCREEN owns -- that it
       reads the organization-scoped note route and consults nothing about a
       relationship first. The attendance read reports nobody covered, so the
       roster itself marks this athlete NotCovered, and the note still arrives;
       and /api/pilot/sessions/list, whose narrower gate this slice
       deliberately did not widen, is never asked. */
    const fetchMock = await renderWorkspace(
      () => jsonResponse({ today: checkInRow('ath_2') }),
      () => jsonResponse({ today: { note: SHARED_NOTE } }),
      { covered: [] },
    );

    await pickAthlete('Sam R.');

    expect(noteText()).toBe(SHARED_NOTE);
    expect(sessionNoteRequests(fetchMock)).toHaveLength(1);
    expect(sessionsListRequests(fetchMock)).toHaveLength(0);
  });
});

describe('a shared note is read back exactly as stored, and claims no author', () => {
  it('renders the text verbatim, line breaks and all, under the neutral attribution', async () => {
    await renderWorkspace(
      () => jsonResponse({ today: checkInRow('ath_1') }),
      () => jsonResponse({ today: { note: SHARED_NOTE } }),
    );
    await pickAthlete('Jordan P.');

    expect(noteText()).toBe(SHARED_NOTE);
    // The line break specifically: not asserted by the equality above alone,
    // because a reflowed note would differ in a way easy to miss in a diff.
    expect(noteText()).toContain('\n');
    expect(within(notePanel()).getByText(NOTE_ATTRIBUTION)).not.toBeNull();
    expect(within(notePanel()).queryByText(NO_NOTE_WRITTEN)).toBeNull();
    expect(within(notePanel()).queryByText(NO_SESSION_TODAY)).toBeNull();
  });

  it('heads the block "Session note" and names nobody as its writer', async () => {
    /* pilot.sessions.notes records no writer and no last editor, and a coach or
       an organization_admin can write that column through
       /api/pilot/sessions/update -- so every one of these wordings would be the
       screen asserting an authorship the row cannot establish. The wellness
       record above IS athlete-owned and keeps its own caption; this block may
       not borrow it, which is why the caption is also checked to be still
       where it belongs. */
    await renderWorkspace(
      () => jsonResponse({ today: checkInRow('ath_1') }),
      () => jsonResponse({ today: { note: SHARED_NOTE } }),
    );
    await pickAthlete('Jordan P.');

    expect(within(notePanel()).getByRole('heading', { name: 'Session note' })).not.toBeNull();

    const text = notePanel().textContent ?? '';
    expect(text).not.toMatch(/self-reported/i);
    expect(text).not.toMatch(/athlete['’]s note/i);
    expect(text).not.toMatch(/written by the athlete/i);
    expect(text).not.toMatch(/before you start/i);

    // Both halves of the attribution, asserted separately: dropping the first
    // stops saying where the text lives, dropping the second stops admitting
    // the row records no author.
    expect(text).toContain('Recorded on this session.');
    expect(text).toMatch(/does not record who wrote or last edited/);

    expect(within(panel()).getByText('Self-reported by the athlete.')).not.toBeNull();
  });

  it('a session with no human note gets its own sentence and no empty note block', async () => {
    await renderWorkspace(
      () => jsonResponse({ today: checkInRow('ath_1') }),
      () => jsonResponse({ today: { note: null } }),
    );
    await pickAthlete('Jordan P.');

    expect(within(notePanel()).getByText(NO_NOTE_WRITTEN)).not.toBeNull();
    expect(within(notePanel()).queryByText(NO_SESSION_TODAY)).toBeNull();
    expect(noteText()).toBeNull();
    // "this text" has no referent when there is none, so the attribution is not
    // printed over an empty block.
    expect(within(notePanel()).queryByText(NOTE_ATTRIBUTION)).toBeNull();
  });

  it.each([
    ['the A-FIN-01 placeholder', SYSTEM_PLACEHOLDER],
    ['the pre-A-FIN-01 readiness marker', HISTORICAL_AUTO_NOTE],
    ['a readiness marker for another band', 'Auto check-in readiness RED'],
    ['a note stored empty', ''],
    ['a note of whitespace only', '  \n\t '],
  ])('shows %s as no note written, never as somebody\'s words', async (_label, note) => {
    /* getTodaySessionNote already turns all five into note: null before the
       response leaves the server. These cases put them on the wire anyway,
       because this is the one failure the subsection cannot recover from: a
       coach reading "Auto check-in readiness GREEN" as a sentence a child wrote
       about themselves is not undone by fixing the server afterwards. The
       component recognises them from the same shared definition, so the two
       gates cannot drift apart. */
    await renderWorkspace(
      () => jsonResponse({ today: checkInRow('ath_1') }),
      () => jsonResponse({ today: { note } }),
    );
    await pickAthlete('Jordan P.');

    expect(within(notePanel()).getByText(NO_NOTE_WRITTEN)).not.toBeNull();
    expect(noteText()).toBeNull();
    expect(within(notePanel()).queryByText(NOTE_ATTRIBUTION)).toBeNull();
    expect(panel().textContent).not.toContain('No athlete note provided');
    expect(panel().textContent).not.toContain('Auto check-in readiness');
  });
});

describe('no session, no note and no read are three different answers', () => {
  it('no session today is said plainly, and is not a failed read', async () => {
    await renderWorkspace(
      () => jsonResponse({ today: checkInRow('ath_1') }),
      () => jsonResponse({ today: null }),
    );
    await pickAthlete('Jordan P.');

    expect(within(notePanel()).getByText(NO_SESSION_TODAY)).not.toBeNull();
    expect(within(notePanel()).queryByText(NO_NOTE_WRITTEN)).toBeNull();
    expect(within(notePanel()).queryByText(NOTE_READ_FAILED)).toBeNull();
    expect(within(notePanel()).queryByText(NOTE_ATTRIBUTION)).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('a server failure says the read did not land, with the status kept off the screen', async () => {
    await renderWorkspace(
      () => jsonResponse({ today: checkInRow('ath_1') }),
      () => jsonResponse({ error: 'Internal server error' }, { ok: false, status: 500 }),
    );
    await pickAthlete('Jordan P.');

    expect(within(notePanel()).getByText(NOTE_READ_FAILED)).not.toBeNull();
    expect(within(notePanel()).queryByText(NO_SESSION_TODAY)).toBeNull();
    expect(within(notePanel()).queryByText(NO_NOTE_WRITTEN)).toBeNull();
    expect(notePanel().textContent).not.toMatch(/500|Internal server error/);
    expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({
      event: 'coach-session-note-load-failed',
      error: expect.objectContaining({ cause: { status: 500 } }),
    }));
  });

  it('a request that never landed is a failed read, not an absent session', async () => {
    await renderWorkspace(
      () => jsonResponse({ today: checkInRow('ath_1') }),
      () => {
        throw new TypeError('Failed to fetch');
      },
    );
    await pickAthlete('Jordan P.');

    expect(within(notePanel()).getByText(NOTE_READ_FAILED)).not.toBeNull();
    expect(within(notePanel()).queryByText(NO_SESSION_TODAY)).toBeNull();
    expect(notePanel().textContent).not.toMatch(/Failed to fetch/);
  });

  it.each([
    ['a body with no `today` at all', {}],
    ['a `today` that is not an object', { today: 'nothing today' }],
    ['a `today` carrying no `note` key', { today: {} }],
    ['a note sent as a number', { today: { note: 7 } }],
  ])('%s is a failed read, never "no session" and never "no note written"', async (_label, body) => {
    /* `payload.today ?? null` would turn every one of these into "No session
       started today." -- a claim about a child's day that nothing made. */
    await renderWorkspace(
      () => jsonResponse({ today: checkInRow('ath_1') }),
      () => jsonResponse(body),
    );
    await pickAthlete('Jordan P.');

    expect(within(notePanel()).getByText(NOTE_READ_FAILED)).not.toBeNull();
    expect(within(notePanel()).queryByText(NO_SESSION_TODAY)).toBeNull();
    expect(within(notePanel()).queryByText(NO_NOTE_WRITTEN)).toBeNull();
  });

  it('a refusal is reported as a read that did not land, not as an absent note', async () => {
    /* Both routes gate on organization membership, so a refusal arrives on
       both. The wellness block carries the sentence that names the audience;
       the note block says only that it could not be read, and deliberately
       gets no second refusal sentence of its own. What it must never do is
       answer a refusal with "No session note written today." -- a claim about
       a child nobody is cleared to make a claim about. */
    const forbidden = () => jsonResponse(
      { error: 'Forbidden: athlete does not belong to organization' },
      { ok: false, status: 403 },
    );
    await renderWorkspace(forbidden, forbidden);
    await pickAthlete('Jordan P.');

    expect(within(panel()).getByText(NO_ACCESS)).not.toBeNull();
    expect(within(notePanel()).getByText(NOTE_READ_FAILED)).not.toBeNull();
    expect(within(notePanel()).queryByText(NO_NOTE_WRITTEN)).toBeNull();
    expect(within(notePanel()).queryByText(NO_SESSION_TODAY)).toBeNull();
    expect(notePanel().textContent).not.toMatch(/Forbidden|403/);
  });

  it('a failed note read can be tried again, and the retry reads the same athlete', async () => {
    let attempts = 0;
    const fetchMock = await renderWorkspace(
      () => jsonResponse({ today: checkInRow('ath_1') }),
      () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse({ error: 'Internal server error' }, { ok: false, status: 500 })
          : jsonResponse({ today: { note: SHARED_NOTE } });
      },
    );
    await pickAthlete('Jordan P.');
    expect(within(notePanel()).getByText(NOTE_READ_FAILED)).not.toBeNull();

    await act(async () => {
      fireEvent.click(within(notePanel()).getByRole('button', { name: 'Try loading the session note again' }));
    });

    expect(within(notePanel()).queryByText(NOTE_READ_FAILED)).toBeNull();
    expect(noteText()).toBe(SHARED_NOTE);
    const urls = sessionNoteRequests(fetchMock).map(([url]) => String(url));
    expect(urls).toHaveLength(2);
    expect(urls.every((url) => url.includes('athlete_id=ath_1'))).toBe(true);
  });
});

describe('one athlete\'s note never appears under another\'s name', () => {
  const JORDAN_SHARED = 'Jordan: knee is bad, no sparring tonight.';
  const SAM_SHARED = 'Sam: shoulder feels fine.';

  it('a late note for the first athlete cannot render under the second', async () => {
    const slowJordan = deferred<Response>();
    const signals: Record<string, AbortSignal | undefined> = {};
    await renderWorkspace(
      (athleteId) => jsonResponse({ today: checkInRow(athleteId) }),
      (athleteId, init) => {
        signals[athleteId] = init?.signal ?? undefined;
        return athleteId === 'ath_1' ? slowJordan.promise : jsonResponse({ today: { note: SAM_SHARED } });
      },
    );

    await pickAthlete('Jordan P.');
    await pickAthlete('Sam R.');

    // Picking Sam cancelled Jordan's note request outright.
    expect(signals.ath_1?.aborted).toBe(true);
    expect(signals.ath_2?.aborted).toBe(false);
    expect(noteText()).toBe(SAM_SHARED);

    // Jordan's note arrives anyway (a fetch that ignores the signal). It is
    // dropped: Sam's stays on screen and Jordan's never appears.
    await act(async () => {
      slowJordan.resolve(jsonResponse({ today: { note: JORDAN_SHARED } }));
    });

    expect(noteText()).toBe(SAM_SHARED);
    expect(panel().textContent).not.toContain('no sparring tonight');
  });

  it('a first athlete\'s note landing while the second is still loading is not shown', async () => {
    const slowJordan = deferred<Response>();
    const slowSam = deferred<Response>();
    await renderWorkspace(
      (athleteId) => jsonResponse({ today: checkInRow(athleteId) }),
      (athleteId) => (athleteId === 'ath_1' ? slowJordan.promise : slowSam.promise),
    );

    await pickAthlete('Jordan P.');
    await pickAthlete('Sam R.');

    await act(async () => {
      slowJordan.resolve(jsonResponse({ today: { note: JORDAN_SHARED } }));
    });

    // Still Sam's loading line -- not Jordan's note, and not a failure.
    expect(within(notePanel()).getByText(NOTE_LOADING)).not.toBeNull();
    expect(noteText()).toBeNull();
    expect(panel().textContent).not.toContain('no sparring tonight');
    expect(within(notePanel()).queryByText(NOTE_READ_FAILED)).toBeNull();

    await act(async () => {
      slowSam.resolve(jsonResponse({ today: { note: null } }));
    });
    expect(within(notePanel()).getByText(NO_NOTE_WRITTEN)).not.toBeNull();
  });

  it('a stale note failure for the first athlete does not paint the second as failed', async () => {
    const slowJordan = deferred<Response>();
    await renderWorkspace(
      (athleteId) => jsonResponse({ today: checkInRow(athleteId) }),
      (athleteId) => (athleteId === 'ath_1' ? slowJordan.promise : jsonResponse({ today: null })),
    );

    await pickAthlete('Jordan P.');
    await pickAthlete('Sam R.');

    await act(async () => {
      slowJordan.resolve(jsonResponse({ error: 'Internal server error' }, { ok: false, status: 500 }));
    });

    expect(within(notePanel()).getByText(NO_SESSION_TODAY)).not.toBeNull();
    expect(within(notePanel()).queryByText(NOTE_READ_FAILED)).toBeNull();
  });
});

describe('the check-in and the note fail separately', () => {
  /* Two routes, two states, two controllers. A wellness outage says nothing
     about whether a note was written, and a note outage says nothing about
     whether the athlete checked in -- so neither may be found wearing the
     other's outcome. */

  it('a failed wellness read leaves a good note read intact', async () => {
    await renderWorkspace(
      () => jsonResponse({ error: 'Internal server error' }, { ok: false, status: 500 }),
      () => jsonResponse({ today: { note: SHARED_NOTE } }),
    );
    await pickAthlete('Jordan P.');

    expect(within(panel()).getByText(READ_FAILED)).not.toBeNull();
    expect(noteText()).toBe(SHARED_NOTE);
    expect(within(notePanel()).queryByText(NOTE_READ_FAILED)).toBeNull();
  });

  it('a failed note read leaves a good wellness read intact', async () => {
    await renderWorkspace(
      () => jsonResponse({ today: checkInRow('ath_1') }),
      () => jsonResponse({ error: 'Internal server error' }, { ok: false, status: 500 }),
    );
    await pickAthlete('Jordan P.');

    expect(within(notePanel()).getByText(NOTE_READ_FAILED)).not.toBeNull();
    expect(measure('Sleep')).toBe('7.5 hours');
    expect(within(panel()).queryByText(READ_FAILED)).toBeNull();
    expect(within(panel()).queryByText(NO_CHECK_IN_TODAY)).toBeNull();
  });

  it('an absent check-in and an absent session are reported one each', async () => {
    await renderWorkspace(
      () => jsonResponse({ today: null }),
      () => jsonResponse({ today: null }),
    );
    await pickAthlete('Jordan P.');

    expect(within(panel()).getByText(NO_CHECK_IN_TODAY)).not.toBeNull();
    expect(within(notePanel()).getByText(NO_SESSION_TODAY)).not.toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });
});

/* RETRACTION REACHES A SCREEN THAT IS ALREADY OPEN.
   The note is read once, when the coach deliberately picks a roster row, and
   nothing revalidated it afterwards. So the sequence the owner decision of
   2026-09-25 exists to permit -- an athlete shares, thinks again, withdraws --
   left the withdrawn words rendered on any coach screen that happened to be
   sitting on that athlete, for as long as it stayed there. The server had
   retracted it; this panel had not, and the only path back to the server was
   to click away and click back.

   These pin the re-read, and the distinction that makes it safe: a refresh
   that FAILS says the read did not land. It must never be allowed to look
   like a withdrawal, because "the athlete took it back" and "we could not ask"
   are different facts about a child. */
describe('a withdrawn note can be cleared from an already-open coach screen', () => {
  it('refreshing after a withdrawal drops the text and shows the no-note state', async () => {
    let withdrawn = false;
    await renderWorkspace(
      (athleteId) => jsonResponse({ today: checkInRow(athleteId) }),
      () => jsonResponse({ today: { note: withdrawn ? null : SHARED_NOTE } }),
    );

    await pickAthlete('Jordan P.');
    expect(noteText()).toBe(SHARED_NOTE);

    // The athlete withdraws it in their own browser. Nothing tells this screen,
    // and nothing should: the point is that the coach can ask again.
    withdrawn = true;
    expect(noteText()).toBe(SHARED_NOTE);

    await act(async () => {
      fireEvent.click(within(notePanel()).getByRole('button', { name: 'Refresh session note' }));
    });

    expect(within(notePanel()).getByText(NO_NOTE_WRITTEN)).not.toBeNull();
    expect(notePanel().textContent).not.toContain('Ankle rolled');
  });

  it('a failed refresh reports the failure and never implies a withdrawal', async () => {
    let fail = false;
    await renderWorkspace(
      (athleteId) => jsonResponse({ today: checkInRow(athleteId) }),
      () => (fail
        ? jsonResponse({ error: 'Internal server error' }, { ok: false, status: 500 })
        : jsonResponse({ today: { note: SHARED_NOTE } })),
    );

    await pickAthlete('Jordan P.');
    expect(noteText()).toBe(SHARED_NOTE);

    fail = true;
    await act(async () => {
      fireEvent.click(within(notePanel()).getByRole('button', { name: 'Refresh session note' }));
    });

    expect(within(notePanel()).getByText(NOTE_READ_FAILED)).not.toBeNull();
    expect(within(notePanel()).queryByText(NO_NOTE_WRITTEN)).toBeNull();
    expect(within(notePanel()).queryByText(NO_SESSION_TODAY)).toBeNull();
  });

  it('offers the re-read in every successful state, not only where text is showing', async () => {
    await renderWorkspace(
      (athleteId) => jsonResponse({ today: checkInRow(athleteId) }),
      () => jsonResponse({ today: null }),
    );

    await pickAthlete('Jordan P.');

    expect(within(notePanel()).getByText(NO_SESSION_TODAY)).not.toBeNull();
    expect(within(notePanel()).getByRole('button', { name: 'Refresh session note' })).not.toBeNull();
  });

  it('is not offered before a coach has picked anybody', async () => {
    await renderWorkspace(
      (athleteId) => jsonResponse({ today: checkInRow(athleteId) }),
      () => jsonResponse({ today: { note: SHARED_NOTE } }),
    );

    expect(screen.queryByRole('button', { name: 'Refresh session note' })).toBeNull();
  });
});

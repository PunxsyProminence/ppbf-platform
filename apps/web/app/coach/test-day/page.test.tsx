/**
 * @jest-environment jsdom
 */

/*
 * The test-day screen (OD-2026-10-17-026). The route decides who may record for whom
 * (route.test.ts, testDay.pg.test.ts). Pinned here: only the athletes the route will record for
 * are offered; a blank box sends nothing and an all-blank athlete is left off; a non-number or an
 * out-of-bounds box is caught before anything is sent, naming the athlete; the save key is kept
 * from the first press until the server answers 2xx (even across edits), a 409 clears the form,
 * and a refusal drops the key only when no earlier press went unanswered; a confirmed save clears
 * the boxes; a refusal says nothing from this press was saved, an unknown outcome never does;
 * cells an earlier press saved are named.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import TestDayPage from './page';
import { gymDayIso } from '@/src/lib/gymTime';

jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <div>{children}</div>,
}));

const ROSTER = [
  { athlete_id: 'ath-1', full_name: 'Ana Boxer' },
  { athlete_id: 'ath-2', full_name: 'Ben Boxer' },
  { athlete_id: 'ath-3', full_name: 'Not Yours' },
];

function respond(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let saveAnswers: Array<Response | Error>;
let fetchMock: jest.Mock;
// What GET /api/pilot/scheduler answers ("Whose numbers", lane 6C7): a schedule with no class
// unless a test sets one.
const NO_CLASSES = { ok: true, classes: [], registrations: [], coaching_requests: [], attendance: [] };
let schedulerAnswer: () => Response | Promise<Response>;

beforeEach(() => {
  window.sessionStorage.clear();
  saveAnswers = [];
  schedulerAnswer = () => respond(200, NO_CLASSES);
  fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) return respond(200, { items: ROSTER });
    if (url.includes('/api/pilot/scheduler')) {
      if (init?.method && init.method !== 'GET') throw new Error('Test Day never writes to the scheduler');
      return schedulerAnswer();
    }
    if (url.includes('/api/pilot/coach/test-day')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.action === 'accessible_athletes') return respond(200, { ok: true, athlete_ids: ['ath-1', 'ath-2'] });
      const next = saveAnswers.shift();
      if (next instanceof Error) throw next;
      return next ?? respond(201, { ok: true, written: 1, already_saved: 0, earlier_not_on_form: [] });
    }
    return respond(404, {});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

async function renderPage() {
  await act(async () => {
    render(<TestDayPage />);
  });
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function pressSave() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save test day' }));
  });
}

function saves(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).includes('/api/pilot/coach/test-day')
      && JSON.parse(String((init as RequestInit).body)).action === undefined)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

test('offers only the athletes the route will record for', async () => {
  await renderPage();
  expect(screen.getByText('Ana Boxer')).toBeTruthy();
  expect(screen.getByText('Ben Boxer')).toBeTruthy();
  expect(screen.queryByText('Not Yours')).toBeNull();
});

test('a roster that cannot be read is never shown as "no athletes"', async () => {
  fetchMock.mockImplementationOnce(async () => respond(500, {}));
  await renderPage();
  expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded/);
  expect(screen.queryByText(/No athletes/)).toBeNull();
});

test('a blank box sends nothing and an all-blank athlete is left off', async () => {
  await renderPage();
  type('Ana Boxer: Height (cm)', '151.4');
  type('Ana Boxer: Shuttle level', '7');
  type('Ana Boxer: Shuttle number', '4');
  await pressSave();
  const [body] = saves();
  expect(body.rows).toEqual([{ athlete_id: 'ath-1', height_cm: 151.4, shuttle_level: 7, shuttle_number: 4 }]);
  expect(body.administered_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(typeof body.request_key).toBe('string');
});

test('a typed non-number is caught on the screen and nothing is sent', async () => {
  await renderPage();
  type('Ben Boxer: CMJ (cm)', '31,5');
  await pressSave();
  expect(screen.getByRole('alert').textContent).toBe('Ben Boxer: CMJ (cm) "31,5" is not a number. Nothing was sent.');
  expect(saves()).toHaveLength(0);
});

test('nothing filled in sends nothing', async () => {
  await renderPage();
  await pressSave();
  expect(screen.getByRole('alert').textContent).toBe('Fill in at least one box first.');
  expect(saves()).toHaveLength(0);
});

test('a retry after a lost reply reuses the key, never claims "not saved", and a confirmed save clears the boxes', async () => {
  saveAnswers = [new Error('network'), respond(201, { ok: true, written: 1, already_saved: 0, earlier_not_on_form: [] })];
  await renderPage();
  type('Ana Boxer: Height (cm)', '151.4');
  await pressSave();
  expect(screen.getByRole('alert').textContent).toMatch(/may or may not have saved/);
  expect(screen.getByRole('alert').textContent).not.toMatch(/Nothing was saved/);
  await pressSave();
  expect(screen.getByRole('status').textContent).toMatch(/saved: 1 result\./);
  expect((screen.getByLabelText('Ana Boxer: Height (cm)') as HTMLInputElement).value).toBe('');
  const [first, second] = saves();
  expect(second.request_key).toBe(first.request_key);
});

test('an edited form after a lost reply is still the same save, so nothing is saved twice', async () => {
  saveAnswers = [respond(502, {}), respond(201, { ok: true, written: 1, already_saved: 1, earlier_not_on_form: [] })];
  await renderPage();
  type('Ana Boxer: Height (cm)', '151.4');
  await pressSave();
  type('Ben Boxer: Broad jump (cm)', '160.2');
  await pressSave();
  const [first, second] = saves();
  expect(second.request_key).toBe(first.request_key);
  expect(second.rows).toHaveLength(2);
});

test('a refusal says nothing was saved, in the server\'s words, and the next press is a new save', async () => {
  saveAnswers = [respond(400, { error: 'The shuttle level must be a whole number from 1 to 21.' })];
  await renderPage();
  type('Ana Boxer: Shuttle level', '21');
  type('Ana Boxer: Shuttle number', '1');
  await pressSave();
  expect(screen.getByRole('alert').textContent).toBe('The shuttle level must be a whole number from 1 to 21.');
  type('Ana Boxer: Shuttle level', '20');
  await pressSave();
  const [first, second] = saves();
  expect(second.request_key).not.toBe(first.request_key);
});

test('cells an earlier press saved that this form no longer carries are named', async () => {
  saveAnswers = [respond(201, {
    ok: true,
    written: 0,
    already_saved: 2,
    earlier_not_on_form: [{ athlete_id: 'ath-1', measure: 'ppbf-jump-cmj-height' }],
  })];
  await renderPage();
  type('Ana Boxer: Height (cm)', '151.4');
  await pressSave();
  const status = screen.getByRole('status').textContent ?? '';
  expect(status).toMatch(/saved: 2 results \(2 of them from an earlier press\)\./);
  expect(status).toMatch(/Ana Boxer: CMJ/);
});

test('an out-of-bounds box is caught on the screen, naming the athlete and the box', async () => {
  await renderPage();
  for (const [label, typed, words] of [
    ['Ana Boxer: Height (cm)', '15', 'must be 50 to 250 cm'],
    ['Ana Boxer: CMJ (cm)', '0', 'must be more than 0 and under 500 cm'],
    ['Ana Boxer: Broad jump (cm)', '1720', 'must be more than 0 and under 500 cm'],
  ] as const) {
    type(label, typed);
    await pressSave();
    expect(screen.getByRole('alert').textContent).toBe(`${label} "${typed}" ${words}. Nothing was sent.`);
    type(label, '');
  }
  type('Ben Boxer: Shuttle level', '7.5');
  type('Ben Boxer: Shuttle number', '3');
  await pressSave();
  expect(screen.getByRole('alert').textContent).toBe('Ben Boxer: Shuttle level "7.5" must be a whole number from 1 to 21. Nothing was sent.');
  type('Ben Boxer: Shuttle level', '22');
  await pressSave();
  expect(screen.getByRole('alert').textContent).toMatch(/Shuttle level "22" must be a whole number from 1 to 21/);
  type('Ben Boxer: Shuttle level', '7');
  type('Ben Boxer: Shuttle number', '17');
  await pressSave();
  expect(screen.getByRole('alert').textContent).toMatch(/Shuttle number "17" must be a whole number from 1 to 16/);
  type('Ben Boxer: Shuttle number', '');
  await pressSave();
  expect(screen.getByRole('alert').textContent).toBe('Ben Boxer: enter both the shuttle level and the shuttle number, or neither. Nothing was sent.');
  expect(saves()).toHaveLength(0);
});

test('an empty test date is refused on the screen', async () => {
  await renderPage();
  fireEvent.change(screen.getByLabelText('Test date'), { target: { value: '' } });
  type('Ana Boxer: Height (cm)', '151.4');
  await pressSave();
  expect(screen.getByRole('alert').textContent).toBe('Choose the test date first. Nothing was sent.');
  expect(saves()).toHaveLength(0);
});

test('a refusal after an unanswered press keeps the key, so the retry stays one save', async () => {
  saveAnswers = [
    new Error('network'),
    respond(401, { error: 'Unauthorized' }),
    respond(201, { ok: true, written: 0, already_saved: 1, earlier_not_on_form: [] }),
  ];
  await renderPage();
  type('Ana Boxer: Height (cm)', '151.4');
  await pressSave();
  await pressSave();
  await pressSave();
  const keys = saves().map((body) => body.request_key);
  expect(new Set(keys).size).toBe(1);
});

test('"already recorded with different numbers" clears the boxes and the next press is a new save', async () => {
  saveAnswers = [
    new Error('network'),
    respond(409, { error: 'This save was already recorded with different numbers. The first numbers are kept, and nothing from this attempt was saved.' }),
  ];
  await renderPage();
  type('Ana Boxer: Height (cm)', '151.4');
  await pressSave();
  type('Ana Boxer: Height (cm)', '152.4');
  await pressSave();
  expect(screen.getByRole('alert').textContent).toMatch(/first numbers are kept/);
  expect((screen.getByLabelText('Ana Boxer: Height (cm)') as HTMLInputElement).value).toBe('');
  type('Ben Boxer: Height (cm)', '140.0');
  await pressSave();
  const keys = saves().map((body) => body.request_key);
  expect(keys[2]).not.toBe(keys[0]);
});

test('a roster whose access check fails is never shown as "no athletes"', async () => {
  fetchMock.mockImplementation(async (input: unknown) => (String(input).includes('/api/pilot/athletes/list')
    ? respond(200, { items: ROSTER })
    : respond(500, {})));
  await renderPage();
  expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded/);
  expect(screen.queryByText(/No athletes/)).toBeNull();
});

test('a second press while saving sends nothing more', async () => {
  let release: (response: Response) => void = () => {};
  saveAnswers = [];
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (String(input).includes('/api/pilot/coach/test-day') && body.action === undefined) {
      return new Promise<Response>((resolve) => { release = resolve; });
    }
    return original!(input, init);
  });
  await renderPage();
  type('Ana Boxer: Height (cm)', '151.4');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save test day' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Saving…' }));
  });
  expect(saves()).toHaveLength(1);
  await act(async () => {
    release(respond(201, { ok: true, written: 1, already_saved: 0, earlier_not_on_form: [] }));
  });
});

test('two athletes with the same name are told apart', async () => {
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/api/pilot/athletes/list')) {
      return respond(200, { items: [{ athlete_id: 'ath-1001', full_name: 'Sam Lee' }, { athlete_id: 'ath-2002', full_name: 'Sam Lee' }] });
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.action === 'accessible_athletes') return respond(200, { ok: true, athlete_ids: ['ath-1001', 'ath-2002'] });
    return respond(404, {});
  });
  await renderPage();
  expect(screen.getByLabelText('Sam Lee (1001): Height (cm)')).toBeTruthy();
  expect(screen.getByLabelText('Sam Lee (2002): Height (cm)')).toBeTruthy();
});

test('the saved line names the test date', async () => {
  await renderPage();
  fireEvent.change(screen.getByLabelText('Test date'), { target: { value: '2026-10-03' } });
  type('Ana Boxer: Height (cm)', '151.4');
  await pressSave();
  expect(screen.getByRole('status').textContent).toMatch(/^Test day for 10\/3\/2026 saved: 1 result\./);
  expect(saves()[0].administered_on).toBe('2026-10-03');
});

test('centimetres are rounded as the server rounds them before the bounds are checked', async () => {
  await renderPage();
  type('Ana Boxer: CMJ (cm)', '0.04');
  await pressSave();
  expect(screen.getByRole('alert').textContent).toMatch(/CMJ \(cm\) "0\.04" must be more than 0/);
  type('Ana Boxer: CMJ (cm)', '31.46');
  await pressSave();
  expect(saves()[0].rows).toEqual([{ athlete_id: 'ath-1', cmj_cm: 31.5 }]);
});

test('more than 100 athletes in one save is refused before sending', async () => {
  const many = Array.from({ length: 101 }, (_, i) => ({ athlete_id: `ath-m${i}`, full_name: `Athlete ${i}` }));
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    if (String(input).includes('/api/pilot/athletes/list')) return respond(200, { items: many });
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (body.action === 'accessible_athletes') return respond(200, { ok: true, athlete_ids: body.athlete_ids });
    return respond(201, { ok: true, written: 1, already_saved: 0, earlier_not_on_form: [] });
  });
  await renderPage();
  // One query, then every athlete's first box (Height): five boxes per card.
  const boxes = screen.getAllByRole('textbox');
  for (let i = 0; i < boxes.length; i += 5) fireEvent.change(boxes[i], { target: { value: '150' } });
  await pressSave();
  expect(screen.getByRole('alert').textContent).toBe('At most 100 athletes per save; save this group in two parts. Nothing was sent.');
  expect(saves()).toHaveLength(0);
}, 30_000);

test('the access check runs in chunks of 1000 ids', async () => {
  const many = Array.from({ length: 1500 }, (_, i) => ({ athlete_id: `ath-c${i}`, full_name: `C ${i}` }));
  const chunks: number[] = [];
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    if (String(input).includes('/api/pilot/athletes/list')) return respond(200, { items: many });
    const body = JSON.parse(String(init?.body ?? '{}'));
    chunks.push(body.athlete_ids.length);
    return respond(200, { ok: true, athlete_ids: body.athlete_ids.slice(0, 1) });
  });
  await renderPage();
  expect(chunks).toEqual([1000, 500]);
  expect(screen.getByText('C 0')).toBeTruthy();
  expect(screen.getByText('C 1000')).toBeTruthy();
});

test('an unanswered press is still the same save after the page is opened again in this tab', async () => {
  saveAnswers = [new Error('network'), respond(201, { ok: true, written: 0, already_saved: 1, earlier_not_on_form: [] })];
  let first: ReturnType<typeof render> | null = null;
  await act(async () => {
    first = render(<TestDayPage />);
  });
  type('Ana Boxer: Height (cm)', '151.4');
  await pressSave();
  first!.unmount();
  await renderPage();
  type('Ana Boxer: Height (cm)', '151.4');
  await pressSave();
  const [a, b] = saves();
  expect(b.request_key).toBe(a.request_key);
  // Settled: the stored key is gone.
  expect(window.sessionStorage.getItem('ppbf.testDay.pendingSave')).toBeNull();
});

/*
 * WHOSE NUMBERS (lane 6C7, U2-6c; app scrub CF-13: "Let the coach pick a class or program first";
 * Overwatch Q3 = A on #2043: a "Whose numbers" choice, "everyone" stays the default, no new route).
 * The classes come from GET /api/pilot/scheduler, the read /schedule makes for the same reader.
 */
describe('Whose numbers: one class, or everyone', () => {
  const TODAY = gymDayIso() as string;
  const OTHER_DAY = '2026-01-05';
  const at = (day: string, hourUtc: number) => `${day}T${String(hourUtc).padStart(2, '0')}:00:00.000Z`;
  const klass = (id: string, title: string, day = TODAY, over: Record<string, unknown> = {}) => ({
    class_id: id, title, start_at: at(day, 17), end_at: at(day, 18), location: 'Main Floor', capacity: 16, status: 'open', ...over,
  });
  const registered = (classId: string, athleteId: string, status = 'registered') => ({
    registration_id: `reg-${classId}-${athleteId}`, class_id: classId, athlete_id: athleteId, status, parent_reviewed: true,
  });
  const marked = (classId: string, athleteId: string, status = 'present') => ({
    attendance_id: `att-${classId}-${athleteId}`, class_id: classId, athlete_id: athleteId, status, method: 'self',
  });
  const schedule = (over: Record<string, unknown>) => () => respond(200, { ...NO_CLASSES, ...over });
  const listed = () => ROSTER.map((athlete) => athlete.full_name).filter((name) => screen.queryByText(name) !== null);
  const choose = (value: string) => fireEvent.change(screen.getByLabelText('Whose numbers'), { target: { value } });
  const optionNames = () => Array.from((screen.getByLabelText('Whose numbers') as HTMLSelectElement).options).map((option) => option.textContent);

  test('with no class to pick from, no choice is offered, everyone is listed and the page says why', async () => {
    await renderPage();
    expect(screen.queryByLabelText('Whose numbers')).toBeNull();
    expect(screen.getByText('No class on this date has a register you can pick from here, so everyone you can record for is listed.')).toBeTruthy();
    expect(listed()).toEqual(['Ana Boxer', 'Ben Boxer']);
  });

  test('everyone is the default; a class narrows the list to its registered and Present athletes the route will record for', async () => {
    schedulerAnswer = schedule({
      classes: [klass('c-1', 'Evening Fundamentals'), klass('c-2', 'Evening Sparring', TODAY, { start_at: at(TODAY, 19), end_at: at(TODAY, 20) })],
      // Not Yours is registered too, and the route will not record for them: never listed.
      registrations: [registered('c-1', 'ath-1'), registered('c-1', 'ath-3')],
      attendance: [marked('c-2', 'ath-2')],
    });
    await renderPage();

    expect((screen.getByLabelText('Whose numbers') as HTMLSelectElement).value).toBe('');
    expect(optionNames()).toEqual([
      'Everyone you can record for',
      expect.stringMatching(/^Evening Fundamentals, .+-.+$/),
      expect.stringMatching(/^Evening Sparring, .+-.+$/),
    ]);
    expect(listed()).toEqual(['Ana Boxer', 'Ben Boxer']);

    choose('c-1');
    expect(listed()).toEqual(['Ana Boxer']);
    const count = screen.getByText('Registered for, or marked Present on, Evening Fundamentals, whom you can record for: 1. An athlete with a number typed stays listed.');
    // Inside the page's always-present live region, so the narrowing is read out.
    expect(count.closest('[aria-live="polite"]')).toBe(screen.getByTestId('class-lines'));
    choose('c-2');
    expect(listed()).toEqual(['Ben Boxer']);
    choose('');
    expect(listed()).toEqual(['Ana Boxer', 'Ben Boxer']);
    expect(screen.queryByText(/^Registered for, or marked Present on/)).toBeNull();
  });

  test('a class on another date, a cancelled class, and a class with nobody the route will record for are not offered', async () => {
    schedulerAnswer = schedule({
      classes: [
        klass('c-other-day', 'Last Week', OTHER_DAY),
        klass('c-cancelled', 'Called Off', TODAY, { status: 'cancelled' }),
        klass('c-not-yours', 'Somebody Else Runs This'),
        klass('c-waitlist-only', 'Waitlist Only'),
        klass('c-absent-only', 'Absent Only'),
        klass('c-1', 'Evening Fundamentals'),
      ],
      registrations: [
        registered('c-other-day', 'ath-1'),
        registered('c-cancelled', 'ath-1'),
        registered('c-not-yours', 'ath-3'),
        registered('c-waitlist-only', 'ath-1', 'waitlisted'),
        registered('c-1', 'ath-2'),
      ],
      attendance: [marked('c-absent-only', 'ath-1', 'absent')],
    });
    await renderPage();
    expect(optionNames()).toEqual(['Everyone you can record for', expect.stringMatching(/^Evening Fundamentals, /)]);
  });

  test('changing the test date drops a class that is not on that date, and everyone is listed again', async () => {
    schedulerAnswer = schedule({ classes: [klass('c-1', 'Evening Fundamentals')], registrations: [registered('c-1', 'ath-1')] });
    await renderPage();
    choose('c-1');
    expect(listed()).toEqual(['Ana Boxer']);

    fireEvent.change(screen.getByLabelText('Test date'), { target: { value: OTHER_DAY } });
    expect(screen.queryByLabelText('Whose numbers')).toBeNull();
    expect(listed()).toEqual(['Ana Boxer', 'Ben Boxer']);
  });

  test('an athlete with a number typed stays listed when a class is chosen, so nothing typed is hidden or sent unseen', async () => {
    schedulerAnswer = schedule({ classes: [klass('c-1', 'Evening Fundamentals')], registrations: [registered('c-1', 'ath-1')] });
    await renderPage();
    type('Ben Boxer: Height (cm)', '148');
    choose('c-1');
    // Ben is not on the class, and stays because a number is typed for him.
    expect(listed()).toEqual(['Ana Boxer', 'Ben Boxer']);
    type('Ana Boxer: Height (cm)', '151.4');
    await pressSave();
    const [body] = saves();
    expect(body.rows).toEqual([{ athlete_id: 'ath-1', height_cm: 151.4 }, { athlete_id: 'ath-2', height_cm: 148 }]);
    // The save cleared the boxes: only the class is listed now.
    expect(listed()).toEqual(['Ana Boxer']);
  });

  test.each([
    ['the read fails', () => respond(500, {})],
    ['the answer is not a schedule', () => respond(200, { ok: true, classes: 'none' })],
    ['the connection drops', () => { throw new Error('network'); }],
    // One class row that cannot be read: "no class on this date" would be a claim the page cannot make.
    ['a class row cannot be read', () => respond(200, {
      ...NO_CLASSES,
      classes: [klass('c-1', 'Evening Fundamentals'), { class_id: 'c-2' }],
      registrations: [registered('c-1', 'ath-1')],
    })],
  ])('when %s, the page says the classes could not be loaded and lists everyone', async (_label, answer) => {
    schedulerAnswer = answer as () => Response;
    await renderPage();
    const warning = screen.getByText('The classes could not be loaded, so everyone you can record for is listed.').closest('.alert') as HTMLElement;
    // Set apart from an empty answer (a warning with a glyph and a title) and announced, not an alert.
    expect(warning.className).toContain('alert--warning');
    expect(warning.closest('[aria-live="polite"]')).toBe(screen.getByTestId('class-lines'));
    expect(warning.textContent).toContain('Classes not loaded');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/No class on this date/)).toBeNull();
    expect(screen.queryByLabelText('Whose numbers')).toBeNull();
    expect(listed()).toEqual(['Ana Boxer', 'Ben Boxer']);
    // The form still saves: the class choice is a convenience, not a gate.
    type('Ana Boxer: Height (cm)', '151.4');
    await pressSave();
    expect(saves()).toHaveLength(1);
  });

  test('"already recorded with different numbers" clears the boxes and lists everyone again, so no missing box is hidden', async () => {
    schedulerAnswer = schedule({ classes: [klass('c-1', 'Evening Fundamentals')], registrations: [registered('c-1', 'ath-1')] });
    saveAnswers = [
      new Error('network'),
      respond(409, { error: 'This save was already recorded with different numbers. The first numbers are kept, and nothing from this attempt was saved.' }),
    ];
    await renderPage();
    type('Ben Boxer: Height (cm)', '148');
    choose('c-1');
    type('Ana Boxer: Height (cm)', '151.4');
    await pressSave();
    type('Ana Boxer: Height (cm)', '152.4');
    await pressSave();
    expect(screen.getByRole('alert').textContent).toMatch(/enter only the missing boxes again/);
    expect((screen.getByLabelText('Whose numbers') as HTMLSelectElement).value).toBe('');
    expect(listed()).toEqual(['Ana Boxer', 'Ben Boxer']);
  });

  test('a roster that failed says only that: no class line stands in for it', async () => {
    fetchMock.mockImplementationOnce(async () => respond(500, {}));
    await renderPage();
    expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded/);
    expect(screen.queryByText(/so everyone you can record for is listed/)).toBeNull();
    expect(screen.queryByLabelText('Whose numbers')).toBeNull();
  });
});

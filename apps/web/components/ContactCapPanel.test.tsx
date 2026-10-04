/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ContactCapPanel, { CAP_STAGE_ORDER } from './ContactCapPanel';
// The shared ladder athleteContactCaps.ts's CONTACT_STAGES is read from
// (vocabularies.ts imports nothing server-side, so jsdom can load it).
import { VOCABULARIES } from '@/src/server/pilot/contentImport/vocabularies';

const CAP = {
  cap_id: 'cap-1',
  athlete_id: 'ath-1',
  highest_allowed_stage: 'controlled_sparring',
  max_hard_open_sessions_per_7_days: 1,
  note: 'Only with Coach Jason present',
  set_by_account_id: 'acct-coach',
  set_by_role: 'coach',
  set_by_name: 'Coach Jason',
  set_at: '2026-10-04T12:00:00.000Z',
};

const GET_URL = '/api/pilot/coach/athlete-contact-caps?athlete_id=ath-1';
const POST_URL = '/api/pilot/coach/athlete-contact-caps';

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface Call { url: string; init?: RequestInit }
let gets: Call[];
let posts: Call[];
let bodies: Array<Record<string, unknown>>;

/**
 * Records every request; asserting on them happens in the test body, never
 * inside the double, where a failed expect would be swallowed by the panel's
 * own catch and read as "unavailable".
 */
function serve(get: () => Response | Promise<Response>, post?: () => Response | Promise<Response>) {
  gets = [];
  posts = [];
  bodies = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    if (init?.method === 'POST') {
      posts.push(call);
      bodies.push(JSON.parse(String(init.body)));
      return post ? post() : respond({ ok: true, cap: CAP, written: CAP });
    }
    gets.push(call);
    return get();
  }) as unknown as typeof fetch;
}

function openPanel() {
  render(<ContactCapPanel athleteId="ath-1" athleteName="Sam" />);
  fireEvent.click(screen.getByRole('button', { name: 'Sparring cap' }));
}

const stageField = () => screen.getByLabelText('Highest contact stage allowed') as HTMLSelectElement;
const sessionsField = () => screen.getByLabelText(/Most hard or open sparring sessions/) as HTMLInputElement;
const noteField = () => screen.getByLabelText('Staff note (optional)') as HTMLInputElement;

afterEach(() => {
  jest.restoreAllMocks();
});

test("the ladder offered is the server's ladder, in the same order", () => {
  expect([...CAP_STAGE_ORDER]).toEqual([...VOCABULARIES.contact_level.values]);
});

test('reads nothing until a coach opens it, then reads this athlete', async () => {
  serve(() => respond({ ok: true, cap: null, history: [] }));
  render(<ContactCapPanel athleteId="ath-1" athleteName="Sam" />);
  expect(global.fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Sparring cap' }));
  await screen.findByText(/No cap set/);
  expect(gets).toHaveLength(1);
  expect(gets[0].url).toContain(GET_URL);
  expect(gets[0].init?.credentials).toBe('include');
});

test('no cap set is said as exactly that, and the form offers no number of its own', async () => {
  serve(() => respond({ ok: true, cap: null, history: [] }));
  openPanel();
  expect(await screen.findByText(/No cap set\. The app never picks one/)).toBeTruthy();
  expect(stageField().value).toBe('');
  expect(sessionsField().value).toBe('');
  expect((screen.getByRole('button', { name: 'Save cap' }) as HTMLButtonElement).disabled).toBe(true);
});

test("shows the cap in force, who set it, its history -- and starts the form from the coach's own cap", async () => {
  serve(() => respond({ ok: true, cap: CAP, history: [CAP] }));
  openPanel();
  expect(await screen.findByText('Highest stage: Controlled sparring')).toBeTruthy();
  expect(screen.getByText('Hard or open sessions in any 7 days: at most 1')).toBeTruthy();
  expect(screen.getByText(/Set by Coach Jason on/)).toBeTruthy();
  expect(screen.getByText('Cap history (1)')).toBeTruthy();
  expect(stageField().value).toBe('controlled_sparring');
  expect(sessionsField().value).toBe('1');
  expect(noteField().value).toBe('Only with Coach Jason present');
});

test('changing one limit keeps the other: saving sends the whole cap', async () => {
  serve(() => respond({ ok: true, cap: CAP, history: [CAP] }));
  openPanel();
  await screen.findByText('Highest stage: Controlled sparring');
  fireEvent.change(sessionsField(), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save cap' }));
  await waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies[0]).toEqual({
    athlete_id: 'ath-1',
    highest_allowed_stage: 'controlled_sparring',
    max_hard_open_sessions_per_7_days: 3,
    note: 'Only with Coach Jason present',
  });
});

test('the staff note is labelled to keep medical detail out (Jason: "Keep note, labelled")', async () => {
  serve(() => respond({ ok: true, cap: null, history: [] }));
  openPanel();
  await screen.findByText(/No cap set/);
  expect(screen.getByText(/No medical details here/)).toBeTruthy();
});

test('it says where going over a cap is warned about, and that it never blocks', async () => {
  serve(() => respond({ ok: true, cap: null, history: [] }));
  openPanel();
  await screen.findByText(/No cap set/);
  expect(screen.getByText(/shows a warning on the Sparring Record screen when a segment is saved/)).toBeTruthy();
  expect(screen.getByText(/It never blocks/)).toBeTruthy();
  expect(screen.queryByText(/does not check caps yet/)).toBeNull();
});

test.each([
  ['a 500', () => respond({ error: 'boom' }, 500)],
  ['a 200 without history', () => respond({ ok: true, cap: null })],
  ['a 200 without a cap key', () => respond({ ok: true, history: [] })],
  ['a 200 with ok:false', () => respond({ ok: false, cap: null, history: [] })],
  ['a cap missing its limits', () => respond({ ok: true, cap: { cap_id: 'x', set_at: CAP.set_at, set_by_name: 'A', note: '' }, history: [] })],
  ['a "set" cap that limits nothing', () => respond({
    ok: true,
    cap: { ...CAP, highest_allowed_stage: null, max_hard_open_sessions_per_7_days: null },
    history: [],
  })],
  ['an invented stage', () => respond({ ok: true, cap: { ...CAP, highest_allowed_stage: 'hard' }, history: [CAP] })],
])('%s is unreadable -- never "no cap"', async (_label, reply) => {
  serve(reply);
  openPanel();
  expect(await screen.findByText(/could not be read just now\. Unknown is not “no cap”/)).toBeTruthy();
  expect(screen.queryByText(/No cap set/)).toBeNull();
});

test('"Check again" reads again and can recover', async () => {
  let first = true;
  serve(() => {
    if (first) {
      first = false;
      return respond({ error: 'boom' }, 500);
    }
    return respond({ ok: true, cap: null, history: [] });
  });
  openPanel();
  fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
  expect(await screen.findByText(/No cap set/)).toBeTruthy();
  expect(gets).toHaveLength(2);
});

test('closing while a read is in flight stays closed when the reply lands', async () => {
  let release: (r: Response) => void = () => {};
  serve(() => new Promise<Response>((resolve) => { release = resolve; }));
  openPanel();
  expect(await screen.findByText('Reading…')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Hide sparring cap' }));
  await act(async () => {
    release(respond({ ok: true, cap: CAP, history: [CAP] }));
  });
  expect(screen.getByRole('button', { name: 'Sparring cap' }).getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText('Highest stage: Controlled sparring')).toBeNull();
});

test('closing while a save is in flight stays closed when the save lands', async () => {
  let release: (r: Response) => void = () => {};
  serve(
    () => respond({ ok: true, cap: null, history: [] }),
    () => new Promise<Response>((resolve) => { release = resolve; }),
  );
  openPanel();
  await screen.findByText(/No cap set/);
  fireEvent.change(stageField(), { target: { value: 'none' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save cap' }));
  await waitFor(() => expect(posts).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: 'Hide sparring cap' }));
  await act(async () => {
    release(respond({ ok: true, cap: CAP, written: CAP }));
  });
  expect(screen.getByRole('button', { name: 'Sparring cap' }).getAttribute('aria-expanded')).toBe('false');
  expect(gets).toHaveLength(1);
});

test('saving sends exactly what the coach chose to the cap route, then shows the cap read back', async () => {
  let saved = false;
  serve(
    () => respond(saved
      ? { ok: true, cap: { ...CAP, highest_allowed_stage: 'light_technical', max_hard_open_sessions_per_7_days: 0, note: 'Back from layoff' }, history: [CAP] }
      : { ok: true, cap: null, history: [] }),
    () => {
      saved = true;
      return respond({ ok: true, cap: CAP, written: CAP });
    },
  );
  openPanel();
  await screen.findByText(/No cap set/);
  fireEvent.change(stageField(), { target: { value: 'light_technical' } });
  fireEvent.change(sessionsField(), { target: { value: ' 0 ' } });
  fireEvent.change(noteField(), { target: { value: 'Back from layoff' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save cap' }));
  await waitFor(() => expect(bodies).toHaveLength(1));
  expect(posts[0].url).toContain(POST_URL);
  expect(posts[0].url).not.toContain('?');
  expect(posts[0].init?.credentials).toBe('include');
  expect(bodies[0]).toEqual({
    athlete_id: 'ath-1',
    highest_allowed_stage: 'light_technical',
    max_hard_open_sessions_per_7_days: 0,
    note: 'Back from layoff',
  });
  expect(await screen.findByText('Highest stage: Light technical contact')).toBeTruthy();
  expect(stageField().value).toBe('light_technical');
});

test('a stage alone, with the count left blank, sends the count as empty', async () => {
  serve(() => respond({ ok: true, cap: null, history: [] }));
  openPanel();
  await screen.findByText(/No cap set/);
  fireEvent.change(stageField(), { target: { value: 'none' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save cap' }));
  await waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies[0]).toMatchObject({ highest_allowed_stage: 'none', max_hard_open_sessions_per_7_days: null });
});

test("a high count is the coach's to choose: no ceiling of the app's own", async () => {
  serve(() => respond({ ok: true, cap: null, history: [] }));
  openPanel();
  await screen.findByText(/No cap set/);
  fireEvent.change(sessionsField(), { target: { value: '21' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save cap' }));
  await waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies[0]).toMatchObject({ highest_allowed_stage: null, max_hard_open_sessions_per_7_days: 21 });
});

test.each(['2.5', '-1', '1e2', '0x10', 'three'])('a count of %s is refused before anything is sent', async (typed) => {
  serve(() => respond({ ok: true, cap: null, history: [] }));
  openPanel();
  await screen.findByText(/No cap set/);
  fireEvent.change(sessionsField(), { target: { value: typed } });
  fireEvent.click(screen.getByRole('button', { name: 'Save cap' }));
  expect(await screen.findByText(/whole number, 0 or more/)).toBeTruthy();
  expect(posts).toHaveLength(0);
});

test('clear sends both limits empty, whatever is in the form', async () => {
  serve(() => respond({ ok: true, cap: CAP, history: [CAP] }));
  openPanel();
  const clear = await screen.findByRole('button', { name: 'Clear cap' });
  fireEvent.change(stageField(), { target: { value: 'open_sparring' } });
  fireEvent.change(sessionsField(), { target: { value: '3' } });
  fireEvent.change(noteField(), { target: { value: 'half typed' } });
  fireEvent.click(clear);
  await waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies[0]).toEqual({
    athlete_id: 'ath-1',
    highest_allowed_stage: null,
    max_hard_open_sessions_per_7_days: null,
    note: '',
  });
});

test('a refusal from the server is shown in its own words, and is gone after close and reopen', async () => {
  serve(
    () => respond({ ok: true, cap: null, history: [] }),
    () => respond({ error: 'This account may not read or set contact caps for this athlete.' }, 403),
  );
  openPanel();
  await screen.findByText(/No cap set/);
  fireEvent.change(stageField(), { target: { value: 'none' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save cap' }));
  expect(await screen.findByText('This account may not read or set contact caps for this athlete.')).toBeTruthy();
  expect(screen.getByText(/NOT SAVED/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Hide sparring cap' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sparring cap' }));
  await screen.findByText(/No cap set/);
  expect(screen.queryByText(/NOT SAVED/)).toBeNull();
});

test('a connection failure on save says nothing changed', async () => {
  serve(
    () => respond({ ok: true, cap: null, history: [] }),
    () => Promise.reject(new Error('offline')),
  );
  openPanel();
  await screen.findByText(/No cap set/);
  fireEvent.change(stageField(), { target: { value: 'none' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save cap' }));
  expect(await screen.findByText(/the connection failed\. Nothing changed\./)).toBeTruthy();
});

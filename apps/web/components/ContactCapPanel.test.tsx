/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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
  set_by_name: 'Coach Jason',
  set_at: '2026-10-04T12:00:00.000Z',
};

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let posts: Array<Record<string, unknown>>;

function serve(get: () => Response | Promise<Response>, post?: () => Response) {
  posts = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return post ? post() : respond({ ok: true, cap: CAP, written: CAP });
    }
    expect(String(input)).toContain('/api/pilot/coach/athlete-contact-caps?athlete_id=ath-1');
    return get();
  }) as unknown as typeof fetch;
}

function openPanel() {
  render(<ContactCapPanel athleteId="ath-1" athleteName="Sam" />);
  fireEvent.click(screen.getByRole('button', { name: 'Sparring cap' }));
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('the ladder offered is the server\'s ladder, in the same order', () => {
  expect([...CAP_STAGE_ORDER]).toEqual([...VOCABULARIES.contact_level.values]);
});

test('reads nothing until a coach opens it', () => {
  serve(() => respond({ ok: true, cap: null, history: [] }));
  render(<ContactCapPanel athleteId="ath-1" athleteName="Sam" />);
  expect(global.fetch).not.toHaveBeenCalled();
});

test('no cap set is said as exactly that, and the form offers no number of its own', async () => {
  serve(() => respond({ ok: true, cap: null, history: [] }));
  openPanel();
  expect(await screen.findByText(/No cap set\. The app never picks one/)).toBeTruthy();
  expect((screen.getByLabelText('Highest contact stage allowed') as HTMLSelectElement).value).toBe('');
  expect((screen.getByLabelText(/Most hard or open sparring sessions/) as HTMLInputElement).value).toBe('');
  // Nothing chosen, nothing to save.
  expect((screen.getByRole('button', { name: 'Save cap' }) as HTMLButtonElement).disabled).toBe(true);
});

test('shows the cap in force, who set it, and its history', async () => {
  serve(() => respond({ ok: true, cap: CAP, history: [CAP] }));
  openPanel();
  expect(await screen.findByText('Highest stage: Controlled sparring')).toBeTruthy();
  expect(screen.getByText('Hard or open sessions in any 7 days: at most 1')).toBeTruthy();
  expect(screen.getByText('Only with Coach Jason present')).toBeTruthy();
  expect(screen.getByText(/Set by Coach Jason on/)).toBeTruthy();
  expect(screen.getByText('Cap history (1)')).toBeTruthy();
});

test('a failed read is never shown as "no cap"', async () => {
  serve(() => respond({ error: 'boom' }, 500));
  openPanel();
  expect(await screen.findByText(/could not be read just now\. Unknown is not “no cap”/)).toBeTruthy();
  expect(screen.queryByText(/No cap set/)).toBeNull();
});

test('a 200 without the expected shape is treated as unreadable, not as no cap', async () => {
  serve(() => respond({ ok: true, cap: null }));
  openPanel();
  expect(await screen.findByText(/could not be read just now/)).toBeTruthy();
  expect(screen.queryByText(/No cap set/)).toBeNull();
});

test('saving sends exactly what the coach chose, then reads the cap back', async () => {
  serve(() => respond({ ok: true, cap: null, history: [] }));
  openPanel();
  await screen.findByText(/No cap set/);
  fireEvent.change(screen.getByLabelText('Highest contact stage allowed'), { target: { value: 'light_technical' } });
  fireEvent.change(screen.getByLabelText(/Most hard or open sparring sessions/), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText(/Note for staff/), { target: { value: 'Back from layoff' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save cap' }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toEqual({
    athlete_id: 'ath-1',
    highest_allowed_stage: 'light_technical',
    max_hard_open_sessions_per_7_days: 0,
    note: 'Back from layoff',
  });
  await waitFor(() => expect((global.fetch as jest.Mock).mock.calls.length).toBe(3));
});

test('a stage alone, with the count left blank, sends no count', async () => {
  serve(() => respond({ ok: true, cap: null, history: [] }));
  openPanel();
  await screen.findByText(/No cap set/);
  fireEvent.change(screen.getByLabelText('Highest contact stage allowed'), { target: { value: 'none' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save cap' }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toMatchObject({ highest_allowed_stage: 'none', max_hard_open_sessions_per_7_days: null });
});

test("a high count is the coach's to choose: no ceiling of the app's own", async () => {
  serve(() => respond({ ok: true, cap: null, history: [] }));
  openPanel();
  await screen.findByText(/No cap set/);
  fireEvent.change(screen.getByLabelText(/Most hard or open sparring sessions/), { target: { value: '21' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save cap' }));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toMatchObject({ highest_allowed_stage: null, max_hard_open_sessions_per_7_days: 21 });
});

test('an impossible count is refused before anything is sent', async () => {
  serve(() => respond({ ok: true, cap: null, history: [] }));
  openPanel();
  await screen.findByText(/No cap set/);
  fireEvent.change(screen.getByLabelText(/Most hard or open sparring sessions/), { target: { value: '2.5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save cap' }));
  expect(await screen.findByText(/whole number, 0 or more/)).toBeTruthy();
  expect(posts).toHaveLength(0);
});

test('clear sends both limits empty, whatever is half-typed in the form', async () => {
  serve(() => respond({ ok: true, cap: CAP, history: [CAP] }));
  openPanel();
  const clear = await screen.findByRole('button', { name: 'Clear cap' });
  // Half-typed values in the form must not ride along on a clear.
  fireEvent.change(screen.getByLabelText('Highest contact stage allowed'), { target: { value: 'open_sparring' } });
  fireEvent.change(screen.getByLabelText(/Most hard or open sparring sessions/), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText(/Note for staff/), { target: { value: 'half typed' } });
  fireEvent.click(clear);
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]).toEqual({
    athlete_id: 'ath-1',
    highest_allowed_stage: null,
    max_hard_open_sessions_per_7_days: null,
    note: '',
  });
});

test('a refusal from the server is shown in its own words and nothing is claimed saved', async () => {
  serve(
    () => respond({ ok: true, cap: null, history: [] }),
    () => respond({ error: 'This account may not read or set contact caps for this athlete.' }, 403),
  );
  openPanel();
  await screen.findByText(/No cap set/);
  fireEvent.change(screen.getByLabelText('Highest contact stage allowed'), { target: { value: 'none' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save cap' }));
  expect(await screen.findByText('This account may not read or set contact caps for this athlete.')).toBeTruthy();
  expect(screen.getByText(/NOT SAVED/)).toBeTruthy();
});

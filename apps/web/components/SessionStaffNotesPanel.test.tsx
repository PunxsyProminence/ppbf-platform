/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import SessionStaffNotesPanel from './SessionStaffNotesPanel';

const THEIRS = {
  note_id: 'note-2',
  note: 'Parent asked about Saturday.',
  author_name: 'Coach Gym Admin',
  created_at: '2026-10-07T12:00:00.000Z',
  own: false,
};
const MINE = {
  note_id: 'note-1',
  note: 'Before: tight shoulders,\nkeep it light.',
  author_name: 'Coach Jason',
  created_at: '2026-10-08T12:00:00.000Z',
  own: true,
};

const ROUTE = '/api/pilot/coach/session-staff-notes';
const GET_URL = `${ROUTE}?session_id=sess%201&athlete_id=ath-1`;

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface Call { url: string; method: string; body: Record<string, unknown> | null; credentials?: RequestCredentials }
let gets: Call[];
let writes: Call[];

/**
 * Records every request; asserting on them happens in the test body, never
 * inside the double, where a failed expect would be swallowed by the panel's
 * own catch and read as "unavailable".
 */
function serve(get: () => Response | Promise<Response>, write?: (call: Call) => Response | Promise<Response>) {
  gets = [];
  writes = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const call: Call = {
      url: String(input),
      method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      credentials: init?.credentials,
    };
    if (method === 'GET') {
      gets.push(call);
      return get();
    }
    writes.push(call);
    return write ? write(call) : respond({ ok: true, note_id: 'note-1' });
  }) as unknown as typeof fetch;
}

const loaded = (notes: unknown[]) => respond({ ok: true, note_max: 2000, notes });

function openPanel() {
  render(<SessionStaffNotesPanel sessionId="sess 1" athleteId="ath-1" />);
  fireEvent.click(screen.getByRole('button', { name: 'Staff notes on this session' }));
}

const draftField = () => screen.getByLabelText(/New note/) as HTMLTextAreaElement;
const addButton = () => screen.getByRole('button', { name: /Add note|Saving/ }) as HTMLButtonElement;
const noteList = () => screen.findByRole('list', { name: 'Staff notes, oldest first' });

afterEach(() => {
  jest.restoreAllMocks();
});

test('reads nothing until a coach opens it, then reads this session for this athlete', async () => {
  serve(() => loaded([]));
  render(<SessionStaffNotesPanel sessionId="sess 1" athleteId="ath-1" />);
  expect(global.fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Staff notes on this session' }));
  await screen.findByText('No staff notes on this session yet.');
  expect(gets).toHaveLength(1);
  expect(gets[0].url).toContain(GET_URL);
  expect(gets[0].credentials).toBe('include');
  expect(addButton().disabled).toBe(true);
  expect(screen.getByText(/athletes and families do not see these notes/)).toBeTruthy();
});

test('lists every staff note as stored, each under its author\'s name, with Change and Remove only on your own', async () => {
  serve(() => loaded([THEIRS, MINE]));
  openPanel();
  const items = (await noteList()).querySelectorAll('li');
  expect(items).toHaveLength(2);
  expect(items[0].textContent).toContain('Parent asked about Saturday.');
  expect(items[0].textContent).toContain('Coach Gym Admin');
  expect(items[0].textContent).not.toContain('(you)');
  expect(items[0].querySelector('button')).toBeNull();
  expect(items[1].textContent).toContain('Before: tight shoulders,\nkeep it light.');
  expect(items[1].textContent).toContain('Coach Jason (you)');
  expect(screen.getAllByRole('button', { name: /^Change your note/ })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: /^Remove your note/ })).toHaveLength(1);
});

test('a note is sent as typed for this session and athlete, the field clears, and the list is re-read', async () => {
  let notes: unknown[] = [THEIRS];
  serve(() => loaded(notes), () => {
    notes = [THEIRS, MINE];
    return respond({ ok: true, note_id: 'note-1' });
  });
  openPanel();
  await screen.findByText('Parent asked about Saturday.');
  fireEvent.change(draftField(), { target: { value: '  After: moved well.  ' } });
  fireEvent.click(addButton());
  await waitFor(() => expect(gets).toHaveLength(2));
  await waitFor(async () => expect((await noteList()).querySelectorAll('li')).toHaveLength(2));
  expect(writes).toHaveLength(1);
  expect(writes[0].method).toBe('POST');
  expect(writes[0].url).toMatch(/\/api\/pilot\/coach\/session-staff-notes$/);
  expect(writes[0].credentials).toBe('include');
  expect(writes[0].body).toEqual({ session_id: 'sess 1', athlete_id: 'ath-1', note: '  After: moved well.  ' });
  expect(draftField().value).toBe('');
});

test('changing your own note sends PATCH with the note id and the new text, then re-reads', async () => {
  let notes: unknown[] = [MINE];
  serve(() => loaded(notes), () => {
    notes = [{ ...MINE, note: 'After: moved well.' }];
    return respond({ ok: true, note_id: 'note-1' });
  });
  openPanel();
  fireEvent.click(await screen.findByRole('button', { name: /^Change your note/ }));
  const field = screen.getByLabelText('Change your note') as HTMLTextAreaElement;
  expect(field.value).toBe(MINE.note);
  fireEvent.change(field, { target: { value: 'After: moved well.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save change' }));
  await waitFor(() => expect(gets).toHaveLength(2));
  await waitFor(() => expect(screen.queryByLabelText('Change your note')).toBeNull());
  expect(writes).toHaveLength(1);
  expect(writes[0].method).toBe('PATCH');
  expect(writes[0].body).toEqual({ note_id: 'note-1', note: 'After: moved well.' });
  expect((await noteList()).textContent).toContain('After: moved well.');
});

test('Cancel leaves the note as it was and sends nothing; a blank change cannot be saved', async () => {
  serve(() => loaded([MINE]));
  openPanel();
  fireEvent.click(await screen.findByRole('button', { name: /^Change your note/ }));
  fireEvent.change(screen.getByLabelText('Change your note'), { target: { value: '   ' } });
  expect((screen.getByRole('button', { name: 'Save change' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByLabelText('Change your note')).toBeNull();
  expect((await noteList()).textContent).toContain('keep it light.');
  expect(writes).toHaveLength(0);
});

test('removing takes two taps: the first asks, "Keep it" sends nothing, the second sends DELETE for that note and re-reads', async () => {
  let notes: unknown[] = [THEIRS, MINE];
  serve(() => loaded(notes), () => {
    notes = [THEIRS];
    return respond({ ok: true, note_id: 'note-1' });
  });
  openPanel();
  fireEvent.click(await screen.findByRole('button', { name: /^Remove your note/ }));
  expect(writes).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
  expect(writes).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: /^Remove your note/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Yes, remove this note' }));
  await waitFor(() => expect(gets).toHaveLength(2));
  await waitFor(async () => expect((await noteList()).querySelectorAll('li')).toHaveLength(1));
  expect(writes).toHaveLength(1);
  expect(writes[0].method).toBe('DELETE');
  expect(writes[0].url).toContain(`${ROUTE}?note_id=note-1`);
  expect(writes[0].credentials).toBe('include');
});

test("a refused save is shown in the server's words and the draft is kept", async () => {
  serve(() => loaded([]), () => respond({ error: 'This account may not read or write staff notes for this athlete.' }, 403));
  openPanel();
  await screen.findByText('No staff notes on this session yet.');
  fireEvent.change(draftField(), { target: { value: 'kept' } });
  fireEvent.click(addButton());
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('NOT SAVED');
  expect(alert.textContent).toContain('This account may not read or write staff notes for this athlete.');
  expect(draftField().value).toBe('kept');
  expect(gets).toHaveLength(1);
});

test('a refused change says NOT CHANGED and keeps the edit open; a refused removal says NOT REMOVED and keeps the note', async () => {
  serve(() => loaded([MINE]), (call) => respond(
    { error: call.method === 'PATCH' ? 'Only the coach who wrote this note may change it.' : 'No such staff note.' },
    call.method === 'PATCH' ? 403 : 404,
  ));
  openPanel();
  fireEvent.click(await screen.findByRole('button', { name: /^Change your note/ }));
  fireEvent.change(screen.getByLabelText('Change your note'), { target: { value: 'new words' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save change' }));
  let alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('NOT CHANGED');
  expect(alert.textContent).toContain('Only the coach who wrote this note may change it.');
  expect((screen.getByLabelText('Change your note') as HTMLTextAreaElement).value).toBe('new words');

  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: /^Remove your note/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Yes, remove this note' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('NOT REMOVED'));
  alert = screen.getByRole('alert');
  expect(alert.textContent).not.toContain('NOT CHANGED');
  expect((await noteList()).textContent).toContain('keep it light.');
  expect(gets).toHaveLength(1);
});

test('a write whose connection fails says nothing changed', async () => {
  serve(() => loaded([]), () => { throw new Error('offline'); });
  openPanel();
  await screen.findByText('No staff notes on this session yet.');
  fireEvent.change(draftField(), { target: { value: 'kept' } });
  fireEvent.click(addButton());
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('the connection failed. Nothing changed.');
  expect(draftField().value).toBe('kept');
});

test('a read that fails is "could not be read", never "no notes", and offers a retry', async () => {
  let fail = true;
  serve(() => (fail ? respond({ error: 'Forbidden' }, 403) : loaded([THEIRS])));
  openPanel();
  await screen.findByText(/could not be read just now/);
  expect(screen.queryByText('No staff notes on this session yet.')).toBeNull();
  expect(screen.queryByLabelText(/New note/)).toBeNull();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  await screen.findByText('Parent asked about Saturday.');
});

test('a malformed row -- an account id where a name should be -- is unreadable, not shown', async () => {
  serve(() => loaded([{ ...MINE, author_name: undefined, author_account_id: 'acct-coach' }]));
  openPanel();
  await screen.findByText(/could not be read just now/);
  expect(document.body.textContent).not.toContain('acct-coach');
});

test('the fields are capped at the length the server names, and the draft shows the count', async () => {
  serve(() => respond({ ok: true, note_max: 120, notes: [MINE] }));
  openPanel();
  await noteList();
  expect(draftField().maxLength).toBe(120);
  fireEvent.change(draftField(), { target: { value: 'abcde' } });
  expect(screen.getByText(/5 of 120 characters/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /^Change your note/ }));
  expect((screen.getByLabelText('Change your note') as HTMLTextAreaElement).maxLength).toBe(120);
});

test('closing the panel drops a read that lands afterwards, and a save that finishes after closing does not reopen it', async () => {
  let release: (response: Response) => void = () => undefined;
  serve(() => new Promise<Response>((resolve) => { release = resolve; }));
  openPanel();
  fireEvent.click(screen.getByRole('button', { name: 'Hide staff notes' }));
  await act(async () => {
    release(loaded([THEIRS]));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.queryByText('Parent asked about Saturday.')).toBeNull();

  let finish: (response: Response) => void = () => undefined;
  serve(() => loaded([]), () => new Promise<Response>((resolve) => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Staff notes on this session' }));
  await screen.findByText('No staff notes on this session yet.');
  fireEvent.change(draftField(), { target: { value: 'sent' } });
  fireEvent.click(addButton());
  await waitFor(() => expect(writes).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: 'Hide staff notes' }));
  await act(async () => {
    finish(respond({ ok: true, note_id: 'note-1' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.getByRole('button', { name: 'Staff notes on this session' })).toBeTruthy();
  expect(gets).toHaveLength(1);
  expect(screen.queryByText('No staff notes on this session yet.')).toBeNull();
});

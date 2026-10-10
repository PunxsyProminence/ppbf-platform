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
  // The 403 left the list alone; "no such note" (404) re-read it, and the
  // refusal is still on screen beside what the server lists now.
  await waitFor(() => expect(gets).toHaveLength(2));
  expect((await noteList()).textContent).toContain('keep it light.');
  expect(screen.getByRole('alert').textContent).toContain('No such staff note.');
});

test('a note removed elsewhere leaves the list once the server says it is gone', async () => {
  let notes: unknown[] = [THEIRS, MINE];
  serve(() => loaded(notes), () => {
    notes = [THEIRS];
    return respond({ error: 'No such staff note.' }, 404);
  });
  openPanel();
  fireEvent.click(await screen.findByRole('button', { name: /^Remove your note/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Yes, remove this note' }));
  await waitFor(async () => expect((await noteList()).querySelectorAll('li')).toHaveLength(1));
  expect(screen.queryByRole('button', { name: 'Yes, remove this note' })).toBeNull();
  expect(screen.getByRole('alert').textContent).toContain('NOT REMOVED');
});

test('two notes of your own on one day get different button names, by time', async () => {
  serve(() => loaded([MINE, { ...MINE, note_id: 'note-3', note: 'After: moved well.', created_at: '2026-10-08T21:30:00.000Z' }]));
  openPanel();
  await noteList();
  const names = screen.getAllByRole('button', { name: /^Change your note/ }).map((button) => button.getAttribute('aria-label'));
  expect(names).toHaveLength(2);
  expect(new Set(names).size).toBe(2);
});

test('while one write is in flight every write button is off, and only that action says it is working', async () => {
  let finish: (response: Response) => void = () => undefined;
  serve(() => loaded([MINE]), () => new Promise<Response>((resolve) => { finish = resolve; }));
  openPanel();
  await noteList();
  fireEvent.change(draftField(), { target: { value: 'another' } });
  fireEvent.click(addButton());
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(addButton().textContent).toBe('Saving…');
  expect(addButton().disabled).toBe(true);
  const change = screen.getByRole('button', { name: /^Change your note/ }) as HTMLButtonElement;
  const remove = screen.getByRole('button', { name: /^Remove your note/ }) as HTMLButtonElement;
  expect(change.disabled).toBe(true);
  expect(remove.disabled).toBe(true);
  expect(remove.textContent).toBe('Remove');
  fireEvent.click(change);
  fireEvent.click(remove);
  expect(writes).toHaveLength(1);
  await act(async () => {
    finish(respond({ ok: true, note_id: 'note-9' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(writes).toHaveLength(1);
});

test('an unchanged note cannot be saved as a change', async () => {
  serve(() => loaded([MINE]));
  openPanel();
  fireEvent.click(await screen.findByRole('button', { name: /^Change your note/ }));
  const save = screen.getByRole('button', { name: 'Save change' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Change your note'), { target: { value: `${MINE.note} ` } });
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Change your note'), { target: { value: 'After: moved well.' } });
  expect(save.disabled).toBe(false);
});

test('hiding the panel drops an open change and a pending removal', async () => {
  serve(() => loaded([MINE]));
  openPanel();
  fireEvent.click(await screen.findByRole('button', { name: /^Change your note/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Hide staff notes' }));
  fireEvent.click(screen.getByRole('button', { name: 'Staff notes on this session' }));
  await noteList();
  expect(screen.queryByLabelText('Change your note')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /^Remove your note/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Hide staff notes' }));
  fireEvent.click(screen.getByRole('button', { name: 'Staff notes on this session' }));
  await noteList();
  expect(screen.queryByRole('button', { name: 'Yes, remove this note' })).toBeNull();
  expect(writes).toHaveLength(0);
});

test('an older read that lands after a newer one is dropped -- the newest read wins', async () => {
  const pending: Array<(response: Response) => void> = [];
  serve(() => new Promise<Response>((resolve) => { pending.push(resolve); }));
  openPanel();
  fireEvent.click(screen.getByRole('button', { name: 'Hide staff notes' }));
  fireEvent.click(screen.getByRole('button', { name: 'Staff notes on this session' }));
  await waitFor(() => expect(pending).toHaveLength(2));
  await act(async () => {
    pending[1](loaded([MINE]));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await screen.findByText(/keep it light\./);
  await act(async () => {
    pending[0](loaded([THEIRS]));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.queryByText('Parent asked about Saturday.')).toBeNull();
  expect(screen.getByText(/keep it light\./)).toBeTruthy();
});

test('a refusal that lands after the coach closed the panel is there when it is opened again', async () => {
  let finish: (response: Response) => void = () => undefined;
  serve(() => loaded([]), () => new Promise<Response>((resolve) => { finish = resolve; }));
  openPanel();
  await screen.findByText('No staff notes on this session yet.');
  fireEvent.change(draftField(), { target: { value: 'kept' } });
  fireEvent.click(addButton());
  await waitFor(() => expect(writes).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: 'Hide staff notes' }));
  await act(async () => {
    finish(respond({ error: 'This account may not read or write staff notes for this athlete.' }, 403));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  fireEvent.click(screen.getByRole('button', { name: 'Staff notes on this session' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('NOT SAVED');
  expect(draftField().value).toBe('kept');
});

test('a write whose connection fails does not claim nothing changed: it says the note may not have been saved and re-reads the list', async () => {
  serve(() => loaded([]), () => { throw new Error('offline'); });
  openPanel();
  await screen.findByText('No staff notes on this session yet.');
  fireEvent.change(draftField(), { target: { value: 'kept' } });
  fireEvent.click(addButton());
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('CONNECTION FAILED');
  expect(alert.textContent).toContain('The note may not have been saved. Check the list below before trying again.');
  expect(alert.textContent).not.toContain('Nothing changed');
  await waitFor(() => expect(gets).toHaveLength(2));
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

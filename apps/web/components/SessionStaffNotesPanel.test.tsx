/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import SessionStaffNotesPanel from './SessionStaffNotesPanel';
import SaveQueueNotice, { FAILED_WORDS, WAITING_WORDS } from './SaveQueueNotice';
import { clearRoleSession, createPersistentRoleSession } from '@/components/roleSession';
import { RESEND_MS, prepareSaveQueue, resetSaveQueueForTests } from '@/src/lib/saveQueue';

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

describe('a note on an athlete in a session run (F-067)', () => {
  test('reads and writes by run_id, never session_id, and carries the button words it was given', async () => {
    serve(() => loaded([]));
    render(<SessionStaffNotesPanel runId="ssrun 1" athleteId="ath-1" buttonLabel="Staff notes on Ada Reyes" />);
    expect(global.fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Staff notes on Ada Reyes' }));
    await screen.findByText('No staff notes for this athlete in this session yet.');

    expect(gets.map((call) => call.url)).toEqual([`${ROUTE}?run_id=ssrun%201&athlete_id=ath-1`]);
    fireEvent.change(draftField(), { target: { value: 'Hands dropped in round two.' } });
    await act(async () => {
      fireEvent.click(addButton());
    });
    expect(writes.map((call) => [call.method, call.body])).toEqual([
      ['POST', { run_id: 'ssrun 1', athlete_id: 'ath-1', note: 'Hands dropped in round two.' }],
    ]);
  });

  test('the open panel is headed with the words on its button, so the note is on the athlete, not "this session" (F-173)', async () => {
    serve(() => loaded([]));
    render(<SessionStaffNotesPanel runId="ssrun_1" athleteId="ath-1" buttonLabel="Staff notes on Ada Reyes" />);
    expect(screen.queryByText('Staff notes on this session')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Staff notes on Ada Reyes' }));
    await screen.findByText('No staff notes for this athlete in this session yet.');

    // Button and panel are the same panel: the heading carries the athlete's name too.
    const panel = document.getElementById('session-staff-notes-run-ssrun_1-ath-1')!;
    expect(panel.querySelector('.t-eyebrow')?.textContent).toBe('Staff notes on Ada Reyes');
    expect(screen.queryByText('Staff notes on this session')).toBeNull();
  });

  test('an athlete\'s own session, with no button words given, is headed "Staff notes on this session" as before', async () => {
    serve(() => loaded([]));
    openPanel();
    await screen.findByText('No staff notes on this session yet.');
    expect(document.querySelector('.t-eyebrow')?.textContent).toBe('Staff notes on this session');
  });

  test('two athletes of one run on one screen get their own fields', async () => {
    serve(() => loaded([]));
    render(
      <>
        <SessionStaffNotesPanel runId="ssrun_1" athleteId="ath-1" buttonLabel="Staff notes on Ada" />
        <SessionStaffNotesPanel runId="ssrun_1" athleteId="ath-2" buttonLabel="Staff notes on Ben" />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Staff notes on Ada' }));
    fireEvent.click(screen.getByRole('button', { name: 'Staff notes on Ben' }));
    await waitFor(() => expect(screen.getAllByLabelText(/New note/)).toHaveLength(2));
    const ids = screen.getAllByLabelText(/New note/).map((field) => field.id);
    expect(new Set(ids).size).toBe(2);
  });

  test("the server's refusal (409, not marked here) says NOT SAVED with its words; nothing is cleared", async () => {
    serve(
      () => loaded([]),
      () => respond({ error: 'This athlete is not marked present in this session, so a note cannot be added for them here.', code: 'SESSION_STAFF_NOTE_ATHLETE_NOT_PRESENT' }, 409),
    );
    render(<SessionStaffNotesPanel runId="ssrun_1" athleteId="ath-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Staff notes on this session' }));
    await screen.findByText('No staff notes for this athlete in this session yet.');
    fireEvent.change(draftField(), { target: { value: 'Late note.' } });
    await act(async () => {
      fireEvent.click(addButton());
    });
    expect(screen.getByRole('alert').textContent).toContain('NOT SAVED');
    expect(screen.getByRole('alert').textContent).toContain('not marked present in this session');
    expect(draftField().value).toBe('Late note.');
  });
});

describe('a write is reported as the server answered it', () => {
  test('an error that is not one of the route refusals (500) is NOT KNOWN, and the list is read again', async () => {
    serve(() => loaded([]), () => respond({ error: 'boom' }, 500));
    openPanel();
    await screen.findByText('No staff notes on this session yet.');
    fireEvent.change(draftField(), { target: { value: 'A note.' } });
    await act(async () => {
      fireEvent.click(addButton());
    });
    expect(screen.getByRole('alert').textContent).toContain('NOT KNOWN');
    expect(screen.getByRole('alert').textContent).toContain('It is not known whether the note was saved (500)');
    expect(screen.getByRole('alert').textContent).not.toContain('NOT SAVED');
    expect(gets).toHaveLength(2);
  });

  test('a yes whose body cannot be read is still a yes: the draft clears and the list is read again', async () => {
    serve(() => loaded([]), () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }) as unknown as Response);
    openPanel();
    await screen.findByText('No staff notes on this session yet.');
    fireEvent.change(draftField(), { target: { value: 'A note.' } });
    await act(async () => {
      fireEvent.click(addButton());
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(draftField().value).toBe('');
    expect(gets).toHaveLength(2);
  });
});


// W4 item 7, OQ-4 (OW27-35 A, condition 4): on the live floor only (the "Who is here" list mounts the
// panel with keptOnThisPage), a write whose answer is lost is kept on the open page and sent again
// until it goes through; a new note carries one request key and the account that made it.
describe('live-floor writes kept on a flaky connection (W4 item 7, OQ-4)', () => {
  interface Sent { method: string; url: string; body: Record<string, unknown> | null; signal: unknown }
  let sent: Sent[];
  let noteReads: unknown[];
  const answer = (body: unknown, status = 200) => {
    const response = { ok: status >= 200 && status < 300, status, json: async () => body, clone: () => response };
    return response as unknown as Response;
  };
  const NOTES_WAITING = 'One change to these notes is not saved yet. This page keeps sending it while it stays open.';

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    // Signed in first, then the queue reset: the sign-in's ask must not outlive the reset.
    createPersistentRoleSession('coach');
    resetSaveQueueForTests();
  });
  afterEach(() => {
    act(() => {
      resetSaveQueueForTests();
    });
    jest.useRealTimers();
  });

  function serveKept(handlers: {
    notes: () => unknown[] | 'fail';
    write: (send: number, call: Sent) => Response | 'lost' | Promise<Response>;
  }) {
    sent = [];
    noteReads = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/api/pilot/auth/session')) return answer({ authenticated: true, account_id: 'acct-a' });
      if (method === 'GET') {
        noteReads.push(init?.signal);
        const notes = handlers.notes();
        return notes === 'fail' ? answer({}, 500) : answer({ ok: true, note_max: 2000, notes });
      }
      const call: Sent = { method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null, signal: init?.signal };
      sent.push(call);
      const next = await handlers.write(sent.length, call);
      if (next === 'lost') throw new TypeError('Failed to fetch');
      return next;
    }) as unknown as typeof fetch;
  }

  async function openKept(props: { kept?: boolean; finishWaiting?: boolean } = {}) {
    prepareSaveQueue();
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(
        <>
          <SessionStaffNotesPanel
            runId="ssrun 1"
            athleteId="ath-1"
            buttonLabel="Staff notes on Ada Reyes"
            keptOnThisPage={props.kept ?? true}
            isFinishWaiting={() => props.finishWaiting === true}
          />
          <SaveQueueNotice />
        </>,
      );
      await jest.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Staff notes on Ada Reyes' }));
      await jest.advanceTimersByTimeAsync(0);
    });
    return view as ReturnType<typeof render>;
  }

  async function addNote(text: string) {
    fireEvent.change(draftField(), { target: { value: text } });
    await act(async () => {
      fireEvent.click(addButton());
      await jest.advanceTimersByTimeAsync(0);
    });
  }

  async function wait(ms: number) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }

  const waitingLine = () => (screen.queryByText(WAITING_WORDS)?.closest('[role="status"]') as HTMLElement | null | undefined) ?? null;
  const saved = (note: string) => ({ ...MINE, note_id: 'note-9', note });

  test('a new note whose send is lost is kept with one key and the account that made it, unnamed in the page\'s list, and lands once', async () => {
    jest.useFakeTimers();
    let notes: unknown[] = [];
    serveKept({
      notes: () => notes,
      write: (send) => {
        if (send === 1) return 'lost';
        notes = [saved('Wrist taped.')];
        return answer({ ok: true, note_id: 'note-9' });
      },
    });
    await openKept();
    await addNote('Wrist taped.');
    const line = waitingLine() as HTMLElement;
    expect(line.textContent).toContain('Staff note');
    expect(line.textContent).not.toContain('Wrist');
    expect(line.textContent).not.toContain('Ada');
    expect(screen.getByText(NOTES_WAITING)).toBeTruthy();
    // Kept: the draft clears, so a second tap is a new note, not this one twice.
    expect(draftField().value).toBe('');
    await wait(RESEND_MS);
    expect(sent).toHaveLength(2);
    expect(sent[0].body).toEqual({ run_id: 'ssrun 1', athlete_id: 'ath-1', note: 'Wrist taped.', request_key: expect.any(String), made_by_account_id: 'acct-a' });
    expect(sent[1].body).toEqual(sent[0].body);
    for (const call of sent) expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(await screen.findByText('Wrist taped.')).toBeTruthy();
    expect(waitingLine()).toBeNull();
    expect(screen.queryByText(NOTES_WAITING)).toBeNull();
  });

  test('off the live floor the panel keeps today\'s behaviour: no key, no account, nothing kept (condition 4)', async () => {
    jest.useFakeTimers();
    serveKept({ notes: () => [], write: () => answer({ ok: true, note_id: 'note-9' }) });
    await openKept({ kept: false });
    await addNote('Wrist taped.');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({ run_id: 'ssrun 1', athlete_id: 'ath-1', note: 'Wrist taped.' });
    expect(waitingLine()).toBeNull();
  });

  test('a change and a removal are kept as they are sent today, with no key; a refused resend the list shows as landed reads as done', async () => {
    jest.useFakeTimers();
    let notes: unknown[] = [MINE];
    serveKept({
      notes: () => notes,
      write: (send, call) => {
        if (call.method === 'PATCH') {
          if (send === 1) {
            notes = [{ ...MINE, note: 'Shoulders fine now.' }];
            return 'lost';
          }
          return answer({ error: 'Something else.' }, 409);
        }
        // The removal: its first send lands, its answer is lost; the resend finds no such note.
        if (call.method === 'DELETE' && notes.length > 0) {
          notes = [];
          return 'lost';
        }
        return answer({ error: 'No such note.' }, 404);
      },
    });
    await openKept();
    fireEvent.click(await screen.findByRole('button', { name: /^Change your note/ }));
    fireEvent.change(screen.getByLabelText('Change your note'), { target: { value: 'Shoulders fine now.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save change' }));
      await jest.advanceTimersByTimeAsync(0);
    });
    await wait(RESEND_MS);
    expect(sent.map((call) => call.body)).toEqual([
      { note_id: 'note-1', note: 'Shoulders fine now.' },
      { note_id: 'note-1', note: 'Shoulders fine now.' },
    ]);
    expect(screen.queryByText('NOT CHANGED')).toBeNull();
    expect(screen.queryByText('NOT KNOWN')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /^Remove your note/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes, remove this note' }));
      await jest.advanceTimersByTimeAsync(0);
    });
    await wait(RESEND_MS);
    expect(sent.filter((call) => call.method === 'DELETE')).toHaveLength(2);
    expect(screen.queryByText('NOT REMOVED')).toBeNull();
    // The landed checks read the list with the queue's signal.
    expect(noteReads.filter((signal) => signal instanceof AbortSignal).length).toBeGreaterThanOrEqual(2);
  });

  test('a refused new note gives its words back to the draft and says NOT SAVED in the server\'s words', async () => {
    jest.useFakeTimers();
    serveKept({ notes: () => [], write: () => answer({ error: 'That athlete is not marked here.' }, 409) });
    await openKept();
    await addNote('Wrist taped.');
    expect(await screen.findByText('NOT SAVED')).toBeTruthy();
    expect(screen.getByText('That athlete is not marked here.')).toBeTruthy();
    expect(draftField().value).toBe('Wrist taped.');
    expect(screen.queryByText(FAILED_WORDS)).toBeNull();
    await wait(RESEND_MS * 2);
    expect(sent).toHaveLength(1);
  });

  test('a refused RESEND the list could not be checked for says NOT KNOWN, never not saved', async () => {
    jest.useFakeTimers();
    let reads = 0;
    serveKept({
      notes: () => {
        reads += 1;
        return reads === 1 ? [] : 'fail';
      },
      write: (send) => (send === 1 ? 'lost' : answer({ error: 'Something else.' }, 409)),
    });
    await openKept();
    await addNote('Wrist taped.');
    await wait(RESEND_MS);
    expect(screen.getByText('NOT KNOWN')).toBeTruthy();
    expect(screen.getByText(/^Staff note: the server refused it when it was sent again and could not be checked/)).toBeTruthy();
    expect(screen.queryByText('NOT SAVED')).toBeNull();
  });

  test('signing out drops a kept note: its words leave the screen and it is not resent', async () => {
    jest.useFakeTimers();
    serveKept({ notes: () => [], write: () => 'lost' });
    await openKept();
    await addNote('Wrist taped.');
    expect(screen.getByText(NOTES_WAITING)).toBeTruthy();
    await act(async () => {
      clearRoleSession();
    });
    expect(waitingLine()).toBeNull();
    expect(screen.queryByText(NOTES_WAITING)).toBeNull();
    await wait(RESEND_MS * 3);
    expect(sent).toHaveLength(1);
  });

  test('a refusal after the panel has gone, or while a kept finish waits, is said in the page\'s list without the note', async () => {
    jest.useFakeTimers();
    serveKept({ notes: () => [], write: (send) => (send === 1 ? 'lost' : answer({ error: 'That athlete is not marked here.' }, 409)) });
    await openKept({ finishWaiting: true });
    await addNote('Wrist taped.');
    await wait(RESEND_MS);
    expect(screen.getByText('Staff note: That athlete is not marked here.')).toBeTruthy();
    expect(screen.queryByText('NOT SAVED')).toBeNull();
    expect(screen.getByRole('alert').textContent).not.toContain('Wrist');
  });
});

/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import CapacityNotesPanel from './CapacityNotesPanel';

const MINE = {
  note_id: 'note-1',
  note: 'Held pace through all six rounds',
  author_name: 'Coach Jason',
  created_at: '2026-10-08T12:00:00.000Z',
  own: true,
};
const THEIRS = {
  note_id: 'note-2',
  note: 'Gassed after round three',
  author_name: 'Coach Gym Admin',
  created_at: '2026-10-07T12:00:00.000Z',
  own: false,
};

const GET_URL = '/api/pilot/coach/athlete-capacity-notes?athlete_id=ath-1';
const POST_URL = '/api/pilot/coach/athlete-capacity-notes';

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface Call { url: string; init?: RequestInit }
let gets: Call[];
let posts: Call[];
let deletes: Call[];
let bodies: Array<Record<string, unknown>>;

/**
 * Records every request; asserting on them happens in the test body, never
 * inside the double, where a failed expect would be swallowed by the panel's
 * own catch and read as "unavailable".
 */
function serve(
  get: () => Response | Promise<Response>,
  post?: () => Response | Promise<Response>,
  del?: () => Response | Promise<Response>,
) {
  gets = [];
  posts = [];
  deletes = [];
  bodies = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    if (init?.method === 'POST') {
      posts.push(call);
      bodies.push(JSON.parse(String(init.body)));
      return post ? post() : respond({ ok: true, note: MINE });
    }
    if (init?.method === 'DELETE') {
      deletes.push(call);
      return del ? del() : respond({ ok: true, note_id: 'note-1' });
    }
    gets.push(call);
    return get();
  }) as unknown as typeof fetch;
}

function openPanel() {
  render(<CapacityNotesPanel athleteId="ath-1" athleteName="Sam" />);
  fireEvent.click(screen.getByRole('button', { name: 'Capacity notes' }));
}

const draftField = () => screen.getByLabelText(/New note/) as HTMLTextAreaElement;
const addButton = () => screen.getByRole('button', { name: /Add note|Saving/ }) as HTMLButtonElement;

afterEach(() => {
  jest.restoreAllMocks();
});

test('reads nothing until a coach opens it, then reads this athlete', async () => {
  serve(() => respond({ ok: true, note_max: 2000, notes: [] }));
  render(<CapacityNotesPanel athleteId="ath-1" athleteName="Sam" />);
  expect(global.fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Capacity notes' }));
  await screen.findByText('No capacity notes yet for this athlete.');
  expect(gets).toHaveLength(1);
  expect(gets[0].url).toContain(GET_URL);
  expect(gets[0].init?.credentials).toBe('include');
  expect(addButton().disabled).toBe(true);
});

test('shows the notes newest first as stored, with the author by name and the date, and a Withdraw only on your own', async () => {
  serve(() => respond({ ok: true, note_max: 2000, notes: [MINE, THEIRS] }));
  openPanel();
  const list = await screen.findByRole('list', { name: 'Capacity notes, newest first' });
  const items = list.querySelectorAll('li');
  expect(items).toHaveLength(2);
  expect(items[0].textContent).toContain('Held pace through all six rounds');
  expect(items[0].textContent).toContain('Coach Jason');
  // LC-18: the same date-and-time style as a staff note, not "10/8/2026".
  expect(items[0].textContent).toContain('Oct 8, 2026, 8:00 AM');
  expect(items[0].textContent).not.toMatch(/\d+\/\d+\/\d{4}/);
  expect(items[1].textContent).toContain('Gassed after round three');
  expect(items[1].textContent).toContain('Coach Gym Admin');
  expect(screen.getAllByRole('button', { name: /^Withdraw your note/ })).toHaveLength(1);
  expect(items[0].querySelector('button')).not.toBeNull();
  expect(items[1].querySelector('button')).toBeNull();
});

test('a note is sent as typed, the field clears, and the list is re-read', async () => {
  let notes = [THEIRS];
  serve(
    () => respond({ ok: true, note_max: 2000, notes }),
    () => {
      notes = [MINE, THEIRS];
      return respond({ ok: true, note: MINE });
    },
  );
  openPanel();
  await screen.findByText('Gassed after round three');
  fireEvent.change(draftField(), { target: { value: '  Held pace through all six rounds  ' } });
  expect(addButton().disabled).toBe(false);
  fireEvent.click(addButton());
  // The list, not the textarea (whose text content React mirrors from its value).
  await waitFor(() => expect(gets).toHaveLength(2));
  const list = await screen.findByRole('list', { name: 'Capacity notes, newest first' });
  await waitFor(() => expect(list.querySelectorAll('li')).toHaveLength(2));
  expect(list.querySelectorAll('li')[0].textContent).toContain('Held pace through all six rounds');
  expect(posts).toHaveLength(1);
  expect(posts[0].url).toContain(POST_URL);
  expect(posts[0].init?.credentials).toBe('include');
  expect(bodies[0]).toEqual({ athlete_id: 'ath-1', note: '  Held pace through all six rounds  ' });
  expect(draftField().value).toBe('');
});

test('the field is capped at the length the server names, and shows the count', async () => {
  serve(() => respond({ ok: true, note_max: 50, notes: [] }));
  openPanel();
  await screen.findByText('No capacity notes yet for this athlete.');
  expect(draftField().maxLength).toBe(50);
  fireEvent.change(draftField(), { target: { value: 'abc' } });
  expect(screen.getByText(/3 of 50 characters/)).toBeTruthy();
});

test("a refusal is shown in the server's words and the draft is kept", async () => {
  serve(
    () => respond({ ok: true, note_max: 2000, notes: [] }),
    () => respond({ ok: false, error: 'The note must be 2000 characters or fewer.' }, 400),
  );
  openPanel();
  await screen.findByText('No capacity notes yet for this athlete.');
  fireEvent.change(draftField(), { target: { value: 'too long' } });
  fireEvent.click(addButton());
  expect(await screen.findByText('The note must be 2000 characters or fewer.')).toBeTruthy();
  expect(screen.getByText('NOT SAVED')).toBeTruthy();
  expect(draftField().value).toBe('too long');
  expect(gets).toHaveLength(1);
});

test('withdrawing your own note sends DELETE for that note and re-reads', async () => {
  let notes = [MINE, THEIRS];
  serve(
    () => respond({ ok: true, note_max: 2000, notes }),
    undefined,
    () => {
      notes = [THEIRS];
      return respond({ ok: true, note_id: 'note-1' });
    },
  );
  openPanel();
  await screen.findByText('Held pace through all six rounds');
  fireEvent.click(screen.getByRole('button', { name: /^Withdraw your note/ }));
  await waitFor(() => expect(screen.queryByText('Held pace through all six rounds')).toBeNull());
  expect(deletes).toHaveLength(1);
  expect(deletes[0].url).toContain('/api/pilot/coach/athlete-capacity-notes?athlete_id=ath-1&note_id=note-1');
  expect(deletes[0].init?.credentials).toBe('include');
  expect(screen.getByText('Gassed after round three')).toBeTruthy();
});

test('a read that fails is "could not be read", never "no notes", and offers a retry', async () => {
  serve(() => respond({ error: 'nope' }, 500));
  openPanel();
  expect(await screen.findByText(/could not be read just now/)).toBeTruthy();
  expect(screen.queryByText(/No capacity notes yet/)).toBeNull();
  serve(() => respond({ ok: true, note_max: 2000, notes: [] }));
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  await screen.findByText('No capacity notes yet for this athlete.');
});

test('a malformed row -- an author id where a name should be -- is unreadable, not shown', async () => {
  serve(() => respond({ ok: true, note_max: 2000, notes: [{ ...MINE, author_name: undefined, author_account_id: 'acct-1' }] }));
  openPanel();
  expect(await screen.findByText(/could not be read just now/)).toBeTruthy();
});

test('closing the panel drops a read that lands afterwards', async () => {
  let release: (() => void) | null = null;
  serve(
    () => new Promise<Response>((resolve) => {
      release = () => resolve(respond({ ok: true, note_max: 2000, notes: [MINE] }));
    }),
  );
  openPanel();
  fireEvent.click(screen.getByRole('button', { name: 'Hide capacity notes' }));
  release!();
  await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('Held pace through all six rounds')).toBeNull();
  expect(screen.getByRole('button', { name: 'Capacity notes' })).toBeTruthy();
});

test('a refused withdrawal says NOT WITHDRAWN, never NOT SAVED, and keeps the note listed', async () => {
  serve(
    () => respond({ ok: true, note_max: 2000, notes: [MINE] }),
    undefined,
    () => respond({ ok: false, error: 'Only the coach who wrote a note may withdraw it.' }, 403),
  );
  openPanel();
  await screen.findByText('Held pace through all six rounds');
  fireEvent.click(screen.getByRole('button', { name: /^Withdraw your note/ }));
  expect(await screen.findByText('Only the coach who wrote a note may withdraw it.')).toBeTruthy();
  expect(screen.getByText('NOT WITHDRAWN')).toBeTruthy();
  expect(screen.queryByText('NOT SAVED')).toBeNull();
  expect(screen.getByText('Held pace through all six rounds')).toBeTruthy();
});

test('an older read that lands after a newer one is dropped -- the newest read wins', async () => {
  const releases: Array<() => void> = [];
  const replies = [[MINE], [THEIRS]];
  let n = 0;
  serve(() => {
    const notes = replies[n++];
    return new Promise<Response>((resolve) => {
      releases.push(() => resolve(respond({ ok: true, note_max: 2000, notes })));
    });
  });
  openPanel();
  fireEvent.click(screen.getByRole('button', { name: 'Hide capacity notes' }));
  fireEvent.click(screen.getByRole('button', { name: 'Capacity notes' }));
  await waitFor(() => expect(releases).toHaveLength(2));
  releases[1]();
  await screen.findByText('Gassed after round three');
  releases[0]();
  await waitFor(() => expect(gets).toHaveLength(2));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText('Held pace through all six rounds')).toBeNull();
  expect(screen.getByText('Gassed after round three')).toBeTruthy();
});

test('a save that finishes after the coach closed the panel does not reopen it', async () => {
  let release: (() => void) | null = null;
  serve(
    () => respond({ ok: true, note_max: 2000, notes: [] }),
    () => new Promise<Response>((resolve) => {
      release = () => resolve(respond({ ok: true, note: MINE }));
    }),
  );
  openPanel();
  await screen.findByText('No capacity notes yet for this athlete.');
  fireEvent.change(draftField(), { target: { value: 'Held pace' } });
  fireEvent.click(addButton());
  await waitFor(() => expect(release).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Hide capacity notes' }));
  release!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(gets).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Capacity notes' })).toBeTruthy();
});

test('a withdrawal that finishes after the coach closed the panel does not reopen it', async () => {
  let release: (() => void) | null = null;
  serve(
    () => respond({ ok: true, note_max: 2000, notes: [MINE] }),
    undefined,
    () => new Promise<Response>((resolve) => {
      release = () => resolve(respond({ ok: true, note_id: 'note-1' }));
    }),
  );
  openPanel();
  await screen.findByText('Held pace through all six rounds');
  fireEvent.click(screen.getByRole('button', { name: /^Withdraw your note/ }));
  await waitFor(() => expect(release).not.toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Hide capacity notes' }));
  release!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await waitFor(() => expect(deletes).toHaveLength(1));
  expect(gets).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Capacity notes' })).toBeTruthy();
});

test('when older notes exist beyond the listed ones, the panel says so instead of implying this is all', async () => {
  serve(() => respond({ ok: true, note_max: 2000, notes: [MINE], older_notes: true }));
  openPanel();
  await screen.findByText('Held pace through all six rounds');
  expect(screen.getByText(/Older notes are kept but not listed here/)).toBeTruthy();
});

test('no older-notes line when the list is complete', async () => {
  serve(() => respond({ ok: true, note_max: 2000, notes: [MINE], older_notes: false }));
  openPanel();
  await screen.findByText('Held pace through all six rounds');
  expect(screen.queryByText(/Older notes are kept/)).toBeNull();
});

// OD-2026-10-10-003 ruling 4: the organization admin is offered Withdraw on a
// note whose author has left the gym -- and on no other note that is not
// theirs. The server says which (can_withdraw); the panel never works it out.
test('an organization admin sees Withdraw only on a departed coach\'s note, named by the author\'s display name', async () => {
  const DEPARTED = { ...THEIRS, note_id: 'note-3', note: 'Faded late', author_name: 'Coach Dana Reyes', own: false, can_withdraw: true };
  const ACTIVE = { ...THEIRS, own: false, can_withdraw: false };
  let notes = [DEPARTED, ACTIVE];
  serve(
    () => respond({ ok: true, note_max: 2000, notes }),
    undefined,
    () => {
      notes = [ACTIVE];
      return respond({ ok: true, note_id: 'note-3' });
    },
  );
  openPanel();
  const list = await screen.findByRole('list', { name: 'Capacity notes, newest first' });
  const items = list.querySelectorAll('li');
  expect(items[0].textContent).toContain('Coach Dana Reyes');
  expect(items[0].querySelector('button')).not.toBeNull();
  // The active coach's note carries no control at all.
  expect(items[1].querySelector('button')).toBeNull();
  expect(screen.queryByRole('button', { name: /^Withdraw your note/ })).toBeNull();

  const withdrawButtons = screen.getAllByRole('button', { name: /^Withdraw/ });
  expect(withdrawButtons).toHaveLength(1);
  expect(withdrawButtons[0].getAttribute('aria-label')).toMatch(/^Withdraw the note Coach Dana Reyes wrote on /);
  fireEvent.click(withdrawButtons[0]);
  await waitFor(() => expect(screen.queryByText('Faded late')).toBeNull());
  expect(deletes).toHaveLength(1);
  expect(deletes[0].url).toContain('/api/pilot/coach/athlete-capacity-notes?athlete_id=ath-1&note_id=note-3');
  expect(screen.getByText('Gassed after round three')).toBeTruthy();
});

test('can_withdraw that is not a boolean is an unreadable answer, never a Withdraw button', async () => {
  serve(() => respond({ ok: true, note_max: 2000, notes: [{ ...THEIRS, can_withdraw: 'yes' }] }));
  openPanel();
  expect(await screen.findByText(/could not be read just now/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Withdraw/ })).toBeNull();
});

test('a withdrawal the server refuses as not permitted re-reads the list, so a Withdraw it no longer allows does not stay', async () => {
  // The list was read while the author was away; the author came back before the tap.
  const STALE = { ...THEIRS, own: false, can_withdraw: true };
  let notes = [STALE];
  serve(
    () => respond({ ok: true, note_max: 2000, notes }),
    undefined,
    () => {
      notes = [{ ...STALE, can_withdraw: false }];
      return respond({ ok: false, error: 'The coach who wrote this note is still at the gym; only they may withdraw it.' }, 403);
    },
  );
  openPanel();
  fireEvent.click(await screen.findByRole('button', { name: /^Withdraw the note/ }));
  expect(await screen.findByText('The coach who wrote this note is still at the gym; only they may withdraw it.')).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole('button', { name: /^Withdraw/ })).toBeNull());
  expect(gets).toHaveLength(2);
  // The note is still listed, and the refusal still says what happened.
  expect(screen.getByText('Gassed after round three')).toBeTruthy();
  expect(screen.getByText('NOT WITHDRAWN')).toBeTruthy();
});

test('a withdrawal that fails for another reason does not re-read', async () => {
  serve(
    () => respond({ ok: true, note_max: 2000, notes: [MINE] }),
    undefined,
    () => respond({ ok: false }, 500),
  );
  openPanel();
  fireEvent.click(await screen.findByRole('button', { name: /^Withdraw your note/ }));
  expect(await screen.findByText('The note was not withdrawn (500).')).toBeTruthy();
  expect(gets).toHaveLength(1);
});

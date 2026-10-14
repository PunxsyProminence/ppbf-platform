/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import SessionRunPresence from './SessionRunPresence';

// "Who is here" on the live session screen (audit finding F-067). The server decides who may be
// marked and by whom (sessionRunAthletes.pg.test.ts); this suite asserts what the screen does with
// its answers: which route it calls with what, what it shows, and that it never says more than it
// knows.

const ADA = { athlete_id: 'ath-1', full_name: 'Ada Reyes' };
const BEN = { athlete_id: 'ath-2', full_name: 'Ben Ortiz' };
const CY = { athlete_id: 'ath-3', full_name: 'Cy Marsh' };
const URL_FOR = '/api/pilot/session-scripts/runs/ssrun%201/athletes';

function respond(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

interface Call { url: string; method: string; body: Record<string, unknown> | null }
let gets: Call[];
let posts: Call[];

function serve(get: () => Response | Promise<Response>, post?: (call: Call) => Response | Promise<Response>) {
  gets = [];
  posts = [];
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    };
    if (call.url.startsWith('/api/pilot/coach/session-staff-notes')) {
      throw new Error(`the note panel must not read until opened: ${call.url}`);
    }
    if (call.method === 'GET') {
      gets.push(call);
      return get();
    }
    posts.push(call);
    return post ? post(call) : respond({ outcome: 'marked' });
  }) as unknown as typeof fetch;
}

const read = (present: Array<typeof ADA>, gym = [ADA, BEN, CY]) =>
  respond({ present: present.map((athlete) => ({ ...athlete, marked_at: '2026-10-14T22:05:00.000Z' })), gym });

async function show(onPresentCount = jest.fn()) {
  await act(async () => {
    render(<SessionRunPresence runId="ssrun 1" onPresentCount={onPresentCount} />);
  });
  return onPresentCount;
}

const rows = () => within(screen.getByRole('list', { name: 'Athletes of this gym' })).getAllByRole('listitem');
const rowNames = () => rows().map((row) => row.querySelector('.font-semibold')?.textContent);

async function tap(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('reading who is here', () => {
  test('reads this run once, by GET, and lists the gym with the marked athletes first and a count', async () => {
    serve(() => read([BEN]));
    const onPresentCount = await show();

    expect(gets.map((call) => call.url)).toEqual([URL_FOR]);
    expect(rowNames()).toEqual(['Ben Ortiz', 'Ada Reyes', 'Cy Marsh']);
    expect(screen.getByText('1 marked here.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ben Ortiz is marked here. Tap to take the mark back.' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Mark Ada Reyes here' }).getAttribute('aria-pressed')).toBe('false');
    // Only a marked athlete has a note box, and it reads nothing until opened.
    expect(screen.getByRole('button', { name: 'Staff notes on Ben Ortiz' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Staff notes on Ada Reyes' })).toBeNull();
    expect(onPresentCount).toHaveBeenLastCalledWith(1);
  });

  test('nobody marked yet is said in words', async () => {
    serve(() => read([]));
    await show();
    expect(screen.getByText('Nobody marked here yet. Tap each athlete in the room.')).toBeTruthy();
  });

  test('a failed read is "could not be read", never "nobody", and the count is unknown; Check again reads again', async () => {
    serve(() => respond({ error: 'boom' }, 500));
    const onPresentCount = await show();

    expect(screen.getByRole('alert').textContent).toContain('could not be read just now. That is not the same as nobody.');
    expect(screen.queryByText(/Nobody marked here yet/)).toBeNull();
    expect(onPresentCount).not.toHaveBeenCalledWith(0);
    expect(onPresentCount).toHaveBeenLastCalledWith(null);

    serve(() => read([ADA]));
    await tap('Check again');
    expect(gets).toHaveLength(1);
    expect(screen.getByText('1 marked here.')).toBeTruthy();
  });

  test('an answer missing the gym list is treated as unreadable, not as an empty gym', async () => {
    serve(() => respond({ present: [] }));
    await show();
    expect(screen.getByRole('alert').textContent).toContain('could not be read');
  });

  test('the name filter narrows the list and says when nothing matches', async () => {
    serve(() => read([]));
    await show();
    fireEvent.change(screen.getByLabelText('Find an athlete'), { target: { value: 'or' } });
    expect(rowNames()).toEqual(['Ben Ortiz']);
    fireEvent.change(screen.getByLabelText('Find an athlete'), { target: { value: 'zz' } });
    expect(screen.getByText('No athlete’s name matches “zz”.')).toBeTruthy();
  });
});

describe('marking', () => {
  test('Mark here sends this athlete and present: true to this run, and the server yes shows them here', async () => {
    serve(() => read([]));
    const onPresentCount = await show();

    await tap('Mark Ada Reyes here');

    expect(posts).toEqual([{ url: URL_FOR, method: 'POST', body: { athlete_id: 'ath-1', present: true } }]);
    expect(rowNames()[0]).toBe('Ada Reyes');
    expect(screen.getByText('1 marked here.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Staff notes on Ada Reyes' })).toBeTruthy();
    expect(onPresentCount).toHaveBeenLastCalledWith(1);
  });

  test('tapping a marked athlete takes the mark back with present: false', async () => {
    serve(() => read([ADA]), () => respond({ outcome: 'unmarked' }));
    await show();

    await tap('Ada Reyes is marked here. Tap to take the mark back.');

    expect(posts.map((call) => call.body)).toEqual([{ athlete_id: 'ath-1', present: false }]);
    expect(screen.getByText('Nobody marked here yet. Tap each athlete in the room.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Staff notes on Ada Reyes' })).toBeNull();
  });

  test('a yes whose body cannot be read is still a yes', async () => {
    serve(() => read([]), () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }) as unknown as Response);
    await show();
    await tap('Mark Ada Reyes here');
    expect(screen.getByText('1 marked here.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test.each([
    [409, { error: 'SESSION_RUN_NOT_LIVE' }, 'This session has already ended, so nothing was saved.'],
    [404, { error: 'SESSION_RUN_NOT_FOUND' }, 'Only the coach delivering this session can mark who is here. Nothing was saved.'],
    [403, { error: 'This account may not record this athlete as present.', code: 'SESSION_RUN_ATHLETE_NOT_PERMITTED' }, 'This account cannot mark that athlete here. Nothing was saved.'],
    [400, { error: 'UNEXPECTED_FIELD:x' }, 'The server refused, so nothing was saved.'],
  ])('a refusal (%i) says nothing was saved and leaves the list as it was', async (status, body, words) => {
    serve(() => read([]), () => respond(body, status));
    await show();
    await tap('Mark Ada Reyes here');

    expect(screen.getByRole('alert').textContent).toBe(words);
    expect(screen.getByText('Nobody marked here yet. Tap each athlete in the room.')).toBeTruthy();
    expect(gets).toHaveLength(1);
  });

  test('any other error is NOT KNOWN, not "not saved", and the list is read again', async () => {
    serve(() => read([]), () => respond({ error: 'boom' }, 500));
    await show();
    serve(() => read([ADA]), () => respond({ error: 'boom' }, 500));
    await tap('Mark Ada Reyes here');

    expect(screen.getByRole('alert').textContent).toBe('It is not known whether Ada Reyes was marked (500); the list has been read again.');
    expect(gets).toHaveLength(1);
    // What the server says now is what is shown.
    expect(screen.getByText('1 marked here.')).toBeTruthy();
  });

  test('a dropped connection is NOT KNOWN too, and the list is read again', async () => {
    serve(() => read([]));
    await show();
    gets = [];
    global.fetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') throw new TypeError('Failed to fetch');
      gets.push({ url: String(_input), method: 'GET', body: null });
      return read([]);
    }) as unknown as typeof fetch;

    await tap('Mark Ada Reyes here');

    expect(screen.getByRole('alert').textContent).toBe('The connection dropped. It is not known whether Ada Reyes was marked; the list has been read again.');
    expect(gets).toHaveLength(1);
  });

  test('messages use the ordinary brass alert, never the medical stop colour', async () => {
    serve(() => read([]), () => respond({ error: 'SESSION_RUN_NOT_LIVE' }, 409));
    await show();
    await tap('Mark Ada Reyes here');
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('--brass-300');
    expect(alert.className).not.toContain('locked');
  });
});

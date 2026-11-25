/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import SessionRunPresence from './SessionRunPresence';
import SaveQueueNotice, { FAILED_WORDS, SAVED_CHECK_WORDS, UNKNOWN_WORDS, WAITING_WORDS } from './SaveQueueNotice';
import { clearRoleSession, createPersistentRoleSession } from '@/components/roleSession';
import { RESEND_MS, prepareSaveQueue, resetSaveQueueForTests } from '@/src/lib/saveQueue';
import { unknownOffPage } from './SessionRunClass';

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
    // Who is signed in, for the kept-save queue (W4 item 7): unanswered here, so a tap goes today's way.
    if (call.url.endsWith('/api/pilot/auth/session')) {
      throw new Error('No session check in this test: the queue does not keep saves');
    }
    if (call.url.startsWith('/api/pilot/coach/session-staff-notes')) {
      throw new Error(`the note panel must not read until opened: ${call.url}`);
    }
    if (call.url.startsWith('/api/pilot/coach/behaviour-')) {
      throw new Error(`the behaviour window must not read until opened: ${call.url}`);
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

async function show(onPresentCount = jest.fn(), onRunNotLive = jest.fn()) {
  await act(async () => {
    render(<SessionRunPresence runId="ssrun 1" onPresentCount={onPresentCount} onRunNotLive={onRunNotLive} />);
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
    expect(screen.getByRole('button', { name: 'Here Ben Ortiz' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Mark here Ada Reyes' }).getAttribute('aria-pressed')).toBe('false');
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

    await tap('Mark here Ada Reyes');

    expect(posts).toEqual([{ url: URL_FOR, method: 'POST', body: { athlete_id: 'ath-1', present: true } }]);
    expect(rowNames()[0]).toBe('Ada Reyes');
    expect(screen.getByText('1 marked here.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Staff notes on Ada Reyes' })).toBeTruthy();
    expect(onPresentCount).toHaveBeenLastCalledWith(1);
  });

  test('tapping a marked athlete takes the mark back with present: false', async () => {
    serve(() => read([ADA]), () => respond({ outcome: 'unmarked' }));
    await show();

    await tap('Here Ada Reyes');

    expect(posts.map((call) => call.body)).toEqual([{ athlete_id: 'ath-1', present: false }]);
    expect(screen.getByText('Nobody marked here yet. Tap each athlete in the room.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Staff notes on Ada Reyes' })).toBeNull();
  });

  test('a yes whose body cannot be read is still a yes', async () => {
    serve(() => read([]), () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }) as unknown as Response);
    await show();
    await tap('Mark here Ada Reyes');
    expect(screen.getByText('1 marked here.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test.each([
    [409, { error: 'SESSION_RUN_NOT_LIVE' }, 'This session has already ended, so nothing was saved.'],
    [404, { error: 'SESSION_RUN_NOT_FOUND' }, 'This session could not be found for this account, so nothing was saved.'],
    [403, { error: 'This account may not record this athlete as present.', code: 'SESSION_RUN_ATHLETE_NOT_PERMITTED' }, 'This account cannot mark that athlete here. Nothing was saved.'],
    [400, { error: 'UNEXPECTED_FIELD:x' }, 'The server refused, so nothing was saved.'],
  ])('a refusal (%i) says nothing was saved and leaves the list as it was', async (status, body, words) => {
    serve(() => read([]), () => respond(body, status));
    await show();
    await tap('Mark here Ada Reyes');

    expect(screen.getByRole('alert').textContent).toBe(words);
    expect(screen.getByText('Nobody marked here yet. Tap each athlete in the room.')).toBeTruthy();
    expect(gets).toHaveLength(1);
  });

  test('any other error is NOT KNOWN, not "not saved", and the list is read again', async () => {
    serve(() => read([]), () => respond({ error: 'boom' }, 500));
    await show();
    serve(() => read([ADA]), () => respond({ error: 'boom' }, 500));
    await tap('Mark here Ada Reyes');

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

    await tap('Mark here Ada Reyes');

    expect(screen.getByRole('alert').textContent).toBe('The connection dropped. It is not known whether Ada Reyes was marked; the list has been read again.');
    expect(gets).toHaveLength(1);
  });

  test('messages use the ordinary brass alert, never the medical stop colour', async () => {
    serve(() => read([]), () => respond({ error: 'SESSION_RUN_NOT_LIVE' }, 409));
    await show();
    await tap('Mark here Ada Reyes');
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('--brass-300');
    expect(alert.className).not.toContain('locked');
  });
});

describe('what is shown always belongs to this run', () => {
  test('a different run shows nothing of the old one, and a late answer for the old run is dropped', async () => {
    let releaseOld: (response: Response) => void = () => {};
    let releaseNew: (response: Response) => void = () => {};
    let call = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      call += 1;
      if (call === 1) return read([ADA]);
      if (String(input).includes('ssrun_2')) return new Promise<Response>((resolve) => { releaseNew = resolve; });
      return new Promise<Response>((resolve) => { releaseOld = resolve; });
    }) as unknown as typeof fetch;

    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(<SessionRunPresence runId="ssrun 1" />);
    });
    expect(screen.getByText('1 marked here.')).toBeTruthy();
    expect(rowNames()[0]).toBe('Ada Reyes');

    await act(async () => {
      view!.rerender(<SessionRunPresence runId="ssrun_2" />);
    });
    // Until the new run's answer lands, nothing of the old run is shown: no list to tap into.
    expect(screen.getByText('Reading who is marked here…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Here Ada Reyes' })).toBeNull();
    expect(screen.queryByText('1 marked here.')).toBeNull();
    await act(async () => {
      releaseNew(read([CY]));
    });
    // Cy is the new run's; Ada was the old run's and is not shown as here.
    expect(rowNames()[0]).toBe('Cy Marsh');
    expect(screen.getByRole('button', { name: 'Mark here Ada Reyes' })).toBeTruthy();
    // An old-run answer that arrives late changes nothing.
    await act(async () => {
      releaseOld(read([ADA, BEN]));
    });
    expect(screen.getByText('1 marked here.')).toBeTruthy();
  });

  test('one tap at a time: a second tap while the first is saving sends nothing', async () => {
    let release: (response: Response) => void = () => {};
    serve(() => read([]), () => new Promise<Response>((resolve) => { release = resolve; }));
    await show();

    fireEvent.click(screen.getByRole('button', { name: 'Mark here Ada Reyes' }));
    fireEvent.click(screen.getByRole('button', { name: /Ben Ortiz/ }));
    // The send now follows the queue's account check (W4 item 7), so it is counted once that settles.
    await act(async () => {});
    expect(posts).toHaveLength(1);
    await act(async () => {
      release(respond({ outcome: 'marked' }));
    });
    expect(screen.getByText('1 marked here.')).toBeTruthy();
  });

  test('a session that has ended tells the live screen to check what is live now', async () => {
    serve(() => read([]), () => respond({ error: 'SESSION_RUN_NOT_LIVE' }, 409));
    const onRunNotLive = jest.fn();
    await show(jest.fn(), onRunNotLive);
    await tap('Mark here Ada Reyes');
    expect(onRunNotLive).toHaveBeenCalledTimes(1);
  });

  test('a refusal that is not about the run does not', async () => {
    serve(() => read([]), () => respond({ error: 'x', code: 'SESSION_RUN_ATHLETE_NOT_PERMITTED' }, 403));
    const onRunNotLive = jest.fn();
    await show(jest.fn(), onRunNotLive);
    await tap('Mark here Ada Reyes');
    expect(onRunNotLive).not.toHaveBeenCalled();
  });
});

describe('a gym of hundreds', () => {
  const big = Array.from({ length: 31 }, (_, index) => ({
    athlete_id: `ath-${String(index).padStart(2, '0')}`,
    full_name: `Athlete ${String(index).padStart(2, '0')}`,
  }));

  test('past thirty athletes only those marked are listed until asked; the filter and Show all reach the rest', async () => {
    serve(() => read([big[5]], big));
    await show();

    expect(rowNames()).toEqual(['Athlete 05']);
    fireEvent.change(screen.getByLabelText('Find an athlete'), { target: { value: 'Athlete 1' } });
    expect(rowNames()).toHaveLength(10);
    fireEvent.change(screen.getByLabelText('Find an athlete'), { target: { value: '' } });

    fireEvent.click(screen.getByRole('button', { name: 'Show all 31 athletes' }));
    expect(rowNames()).toHaveLength(31);
    expect(rowNames()[0]).toBe('Athlete 05');
    fireEvent.click(screen.getByRole('button', { name: 'Show only those marked here' }));
    expect(rowNames()).toEqual(['Athlete 05']);
  });

  test('with nobody marked yet, it says how to reach the gym instead of an empty list', async () => {
    serve(() => read([], big));
    await show();
    expect(screen.getByText('Find an athlete by name, or show the whole gym, to mark who is here.')).toBeTruthy();
  });

  test('thirty or fewer are all listed', async () => {
    serve(() => read([], big.slice(0, 30)));
    await show();
    expect(rowNames()).toHaveLength(30);
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
  });
});

// D4 (OD-2026-10-21-002; OD-2026-10-21-004 rulings 1-2): on a tied session the tap's answer says
// what it did to the class register, and the footer says marks go on it.
describe('a session tied to a class', () => {
  test('the footer says a mark here also goes on the class register', async () => {
    serve(() => read([]));
    await act(async () => {
      render(<SessionRunPresence runId="ssrun 1" tied />);
    });
    expect(screen.getByText(/This session is tied to a class: a mark here also goes on that class.s register\./)).toBeTruthy();
    expect(screen.queryByText(/it does not change anyone.s own check-in or attendance/)).toBeNull();
  });

  test.each([
    [{ effect: 'created' }, 'Ada Reyes is Present on the class register.'],
    [{ effect: 'already_present' }, 'Ada Reyes was already Present on the class register.'],
    [{ effect: 'flipped', previous_status: 'absent' }, 'Ada Reyes was marked Absent on the class register; now Present.'],
    [{ effect: 'flipped', previous_status: 'excused' }, 'Ada Reyes was marked Excused on the class register; now Present.'],
    [{ effect: 'skipped', reason: 'class_cancelled' }, 'Ada Reyes is marked here but not on the class register: the class was cancelled.'],
    [{ effect: 'skipped', reason: 'not_your_class' }, 'Ada Reyes is marked here but not on the class register: you no longer run this class.'],
    [{ effect: 'register_newer', status: 'absent' }, 'Ada Reyes was marked here, but the class register had been changed after your tap, so it kept Absent there. Change it on the register if Ada Reyes is here.'],
    [{ effect: 'register_newer', status: 'excused' }, 'Ada Reyes was marked here, but the class register had been changed after your tap, so it kept Excused there. Change it on the register if Ada Reyes is here.'],
    [{ effect: 'register_newer' }, 'Ada Reyes was marked here, but the class register had been changed after your tap, so it kept its mark there. Change it on the register if Ada Reyes is here.'],
  ])('a tap answered %j says so', async (register, words) => {
    serve(() => read([]), () => respond({ outcome: 'marked', register }));
    await show();
    await tap('Mark here Ada Reyes');
    // Read out by the live region, and shown under the athlete's own row.
    expect(screen.getAllByText(words)).toHaveLength(2);
  });

  test.each([
    [{ effect: 'removed' }, 'Ada Reyes is off the class register too.'],
    [{ effect: 'kept' }, "The class register was changed after your tap, so Ada Reyes's mark there was left as it is."],
    [{ effect: 'unchanged' }, 'Only the mark here was taken back; the class register was not changed.'],
  ])('an untap answered %j says so', async (register, words) => {
    serve(() => read([ADA]), () => respond({ outcome: 'unmarked', register }));
    await show();
    await tap('Here Ada Reyes');
    // Read out by the live region, and shown under the athlete's own row.
    expect(screen.getAllByText(words)).toHaveLength(2);
  });

  test('a hold on the athlete is said, and the mark stands', async () => {
    serve(() => read([]), () => respond({ outcome: 'marked', register: { effect: 'created' }, hold_warning: { hold_id: 'h1' } }));
    await show();
    await tap('Mark here Ada Reyes');
    expect(screen.getAllByText('Ada Reyes is Present on the class register. Ada Reyes has an active Training Hold; the mark was NOT blocked.')).toHaveLength(2);
    expect(screen.getByText('1 marked here.')).toBeTruthy();
  });

  test('a hold that could not be read is said as not known, never as a hold', async () => {
    serve(() => read([]), () => respond({ outcome: 'marked', register: { effect: 'created' }, hold_warning: 'unreadable' }));
    await show();
    await tap('Mark here Ada Reyes');
    expect(screen.getAllByText('Ada Reyes is Present on the class register. Whether Ada Reyes is on a Training Hold could not be read.')).toHaveLength(2);
    expect(screen.queryByText(/has an active Training Hold/)).toBeNull();
  });

  test('an untied tap leaves no register line', async () => {
    serve(() => read([]), () => respond({ outcome: 'marked' }));
    await show();
    await tap('Mark here Ada Reyes');
    expect(screen.queryByText(/class register/)).toBeNull();
  });
});

// THE CLASS REGISTER ON A TIED SESSION (lane 6C7, U2-6c; staging dry run 2026-11-19: "Who is here"
// was empty for a class whose athletes had already pressed "I'm here"). The screen half: which read
// it makes and when, what it lists and in what order, and that a read it could not make is never
// "nobody". What the scheduler route sends a coach is the route's own suite (scheduler/route.test.ts).
describe('a tied session also shows the class register', () => {
  const SCHEDULER = '/api/pilot/scheduler';
  const onRegister = (athlete_id: string, method: string, over: Record<string, unknown> = {}) => ({
    attendance_id: `att-${athlete_id}`,
    class_id: 'class-1',
    athlete_id,
    status: 'present',
    method,
    note: 'a coach note that this screen never shows',
    checked_in_at: '2026-10-14T21:55:00.000Z',
    ...over,
  });
  const register = (attendance: unknown[], classes: unknown[] = [{ class_id: 'class-1' }, { class_id: 'class-2' }]) =>
    respond({ ok: true, role: 'coach', classes, registrations: [], coaching_requests: [], attendance });

  let registerReads: number;
  function serveTied(
    present: Array<typeof ADA>,
    registerAnswer: () => Response | Promise<Response>,
    gym = [ADA, BEN, CY],
  ) {
    registerReads = 0;
    gets = [];
    posts = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      };
      if (call.url.endsWith('/api/pilot/auth/session')) {
        throw new Error('No session check in this test: the queue does not keep saves');
      }
      if (call.url === SCHEDULER) {
        if (call.method !== 'GET') throw new Error('this screen never writes the register through the scheduler route');
        registerReads += 1;
        return registerAnswer();
      }
      if (call.method === 'GET') {
        gets.push(call);
        return read(present, gym);
      }
      posts.push(call);
      return respond({ outcome: 'marked', register: { effect: 'already_present' } });
    }) as unknown as typeof fetch;
  }

  async function showTied(props: { tied?: boolean; classId?: string | null } = {}) {
    await act(async () => {
      render(<SessionRunPresence runId="ssrun 1" tied={props.tied ?? true} classId={props.classId === undefined ? 'class-1' : props.classId} />);
    });
  }

  // The register line: the counts (a live region) and the read time, as one paragraph.
  const registerText = () =>
    screen.getByText((_content, el) => el?.tagName === 'P' && /Class register read at/.test(el.textContent ?? '')).textContent ?? '';
  const rowOf = (name: string) => rows().find((row) => row.querySelector('.font-semibold')?.textContent === name)!;

  test('those the register has Present and not marked here are listed after those marked, each with how it was marked', async () => {
    serveTied([BEN], () => register([
      onRegister('ath-3', 'self'),
      // Marked here already: on the register through the coach's own tap, so no second line.
      onRegister('ath-2', 'coach_override'),
      // Not Present, and another class's mark: neither is this list's.
      onRegister('ath-1', 'coach_override', { status: 'absent' }),
      onRegister('ath-1', 'self', { class_id: 'class-2' }),
    ]));
    await showTied();

    expect(registerReads).toBe(1);
    expect(rowNames()).toEqual(['Ben Ortiz', 'Cy Marsh', 'Ada Reyes']);
    expect(rowOf('Cy Marsh').textContent).toContain('Present on the class register, via self check-in. Not marked here yet.');
    expect(rowOf('Ben Ortiz').textContent).not.toContain('Present on the class register');
    expect(rowOf('Ada Reyes').textContent).not.toContain('Present on the class register');
    expect(registerText()).toMatch(/^1 marked Present on the class register is not marked here yet\. Class register read at /);
    // The count is still this session's own marks, and the register's note is never drawn.
    expect(screen.getByText('1 marked here.')).toBeTruthy();
    expect(screen.queryByText(/a coach note that this screen never shows/)).toBeNull();
    // Still a tap away, as anyone else: the register is not copied into the session.
    expect(screen.getByRole('button', { name: 'Mark here Cy Marsh' }).getAttribute('aria-pressed')).toBe('false');
  });

  test.each([
    ['parent', 'Present on the class register, via parent. Not marked here yet.'],
    ['admin_override', 'Present on the class register, via admin. Not marked here yet.'],
    ['walk_in', 'Present on the class register, via walk-in. Not marked here yet.'],
    // A way of marking this build does not know is never printed as it is stored.
    ['kiosk_v2', 'Present on the class register. Not marked here yet.'],
  ])('a mark made by %s reads "%s"', async (method, words) => {
    serveTied([], () => register([onRegister('ath-1', method)]));
    await showTied();
    expect(rowOf('Ada Reyes').textContent).toContain(words);
    expect(rowOf('Ada Reyes').textContent).not.toContain('kiosk_v2');
  });

  test('an untied session, a cancelled class and a tie with no class id never read the scheduler', async () => {
    serveTied([], () => register([onRegister('ath-1', 'self')]));
    await showTied({ tied: false, classId: 'class-1' });
    await showTied({ tied: true, classId: null });
    expect(registerReads).toBe(0);
    expect(screen.queryByText(/Present on the class register/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Read the class register again' })).toBeNull();
  });

  test('a failed register read is "could not be read", never "nobody"; the marks still work; reading again recovers', async () => {
    let fail = true;
    serveTied([], () => (fail ? respond({ error: 'boom' }, 500) : register([onRegister('ath-1', 'self')])));
    await showTied();

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The class register could not be read just now. That is not the same as nobody on it.');
    expect(alert.className).toContain('--brass-300');
    expect(alert.className).not.toContain('locked');
    expect(screen.queryByText(/Nobody is marked Present on the class register/)).toBeNull();
    expect(screen.queryByText(/Everyone marked Present on the class register/)).toBeNull();
    // The session's own list is untouched by the register's failure.
    expect(rowNames()).toEqual(['Ada Reyes', 'Ben Ortiz', 'Cy Marsh']);

    fail = false;
    await tap('Read the class register again');
    expect(registerReads).toBe(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(rowOf('Ada Reyes').textContent).toContain('Present on the class register, via self check-in.');
  });

  test.each([
    ['no attendance list', { ok: true, classes: [] }],
    ['an attendance value that is not a list', { ok: true, attendance: 'none' }],
    ['a body that is not an object', null],
  ])('an answer with %s is unreadable, not an empty register', async (_label, body) => {
    serveTied([], () => respond(body));
    await showTied();
    expect(screen.getByRole('alert').textContent).toContain('The class register could not be read just now.');
    expect(screen.queryByText(/Nobody is marked Present on the class register/)).toBeNull();
  });

  test('no Present mark is never read as nobody here (a coach whose cover was taken gets no rows); one fully marked here says so', async () => {
    serveTied([], () => register([]));
    await showTied();
    expect(screen.getByText(
      'The class register sent no Present mark for this class. If another coach now covers it, its register is not sent to you, so this does not mean nobody is here.',
    )).toBeTruthy();
    expect(screen.queryByText(/Nobody is marked/)).toBeNull();
    document.body.innerHTML = '';
    document.body.innerHTML = '';

    serveTied([ADA], () => register([onRegister('ath-1', 'coach_override')]));
    await showTied();
    expect(registerText()).toMatch(/^Everyone marked Present on the class register is marked here\. Class register read at /);
  });

  test('an answer that does not carry the class is unreadable, not an empty register', async () => {
    serveTied([], () => register([onRegister('ath-1', 'self')], [{ class_id: 'class-2' }]));
    await showTied();
    expect(screen.getByRole('alert').textContent).toContain('The class register could not be read just now.');
    expect(screen.queryByText(/sent no Present mark/)).toBeNull();
    expect(screen.queryByText(/Present on the class register, via/)).toBeNull();
  });

  test('a refused read is unreadable even when its body carries register rows', async () => {
    serveTied([], () => respond({ ok: true, classes: [{ class_id: 'class-1' }], attendance: [onRegister('ath-1', 'self')] }, 403));
    await showTied();
    expect(screen.getByRole('alert').textContent).toContain('The class register could not be read just now.');
    expect(screen.queryByText(/Present on the class register, via/)).toBeNull();
  });

  test('only the counts are a live region; the read time and the retry button stay out of it, and the button keeps focus through a read', async () => {
    serveTied([], () => register([onRegister('ath-1', 'self')]));
    await showTied();
    const status = screen.getByText('1 marked Present on the class register is not marked here yet.');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).not.toContain('read at');
    const button = screen.getByRole('button', { name: 'Read the class register again' });
    expect(button.hasAttribute('disabled')).toBe(false);

    // The next read hangs, so the button is seen while it is busy.
    let finish: (answer: Response) => void = () => {};
    serveTied([], () => new Promise<Response>((resolve) => { finish = resolve; }));
    button.focus();
    await act(async () => { fireEvent.click(button); });
    expect(button.textContent).toBe('Reading the class register…');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(button);
    // A press while busy starts no second read.
    await act(async () => { fireEvent.click(button); });
    expect(registerReads).toBe(1);

    await act(async () => { finish(register([onRegister('ath-1', 'self')]) as Response); });
    expect(button.textContent).toBe('Read the class register again');
    expect(document.activeElement).toBe(button);
  });

  test('a register mark for an athlete who is not on the gym list is counted, not named', async () => {
    serveTied([], () => register([onRegister('ath-1', 'self'), onRegister('ath-gone', 'parent')]));
    await showTied();
    expect(registerText()).toMatch(
      /^1 marked Present on the class register is not marked here yet\. 1 more marked Present on the class register is not on this gym’s list of athletes, so no name is shown\. /);
    expect(rowNames()).toEqual(['Ada Reyes', 'Ben Ortiz', 'Cy Marsh']);
    expect(screen.queryByText(/ath-gone/)).toBeNull();
  });

  test('past thirty athletes, those on the register are listed with those marked while the gym is collapsed', async () => {
    const big = Array.from({ length: 31 }, (_, index) => ({
      athlete_id: `ath-${String(index).padStart(2, '0')}`,
      full_name: `Athlete ${String(index).padStart(2, '0')}`,
    }));
    serveTied([big[5]], () => register([onRegister('ath-20', 'self'), onRegister('ath-07', 'parent')]), big);
    await showTied();

    expect(rowNames()).toEqual(['Athlete 05', 'Athlete 07', 'Athlete 20']);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 31 athletes' }));
    expect(rowNames().slice(0, 3)).toEqual(['Athlete 05', 'Athlete 07', 'Athlete 20']);
    expect(rowNames()).toHaveLength(31);
    fireEvent.click(screen.getByRole('button', { name: 'Show only those marked here or on the class register' }));
    expect(rowNames()).toEqual(['Athlete 05', 'Athlete 07', 'Athlete 20']);
  });

  test('with the register unread, the collapse button promises only those marked here', async () => {
    const big = Array.from({ length: 31 }, (_, index) => ({
      athlete_id: `ath-${String(index).padStart(2, '0')}`,
      full_name: `Athlete ${String(index).padStart(2, '0')}`,
    }));
    serveTied([big[5]], () => respond({ error: 'boom' }, 500), big);
    await showTied();

    fireEvent.click(screen.getByRole('button', { name: 'Show all 31 athletes' }));
    expect(screen.getByRole('button', { name: 'Show only those marked here' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /or on the class register/ })).toBeNull();
  });

  test('a tap marks a register athlete here through the run route, and the register is read again', async () => {
    serveTied([], () => register([onRegister('ath-1', 'self')]));
    await showTied();
    expect(registerReads).toBe(1);

    await tap('Mark here Ada Reyes');
    expect(posts).toEqual([{ url: URL_FOR, method: 'POST', body: { athlete_id: 'ath-1', present: true } }]);
    expect(registerReads).toBe(2);
    // Here now, so the "not marked here yet" line is gone and the tap's own answer is what is shown.
    expect(screen.getByRole('button', { name: 'Here Ada Reyes' }).getAttribute('aria-pressed')).toBe('true');
    expect(rowOf('Ada Reyes').textContent).not.toContain('Not marked here yet');
    expect(screen.getAllByText('Ada Reyes was already Present on the class register.')).toHaveLength(2);
  });

  test("a session moved to another class shows nothing of the first class's register while the second is read", async () => {
    let releaseSecond: (response: Response) => void = () => {};
    registerReads = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== SCHEDULER) return read([]);
      registerReads += 1;
      if (registerReads === 1) return register([onRegister('ath-1', 'self')]);
      return new Promise<Response>((resolve) => { releaseSecond = resolve; });
    }) as unknown as typeof fetch;

    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(<SessionRunPresence runId="ssrun 1" tied classId="class-1" />);
    });
    expect(rowOf('Ada Reyes').textContent).toContain('Present on the class register, via self check-in.');

    await act(async () => {
      view!.rerender(<SessionRunPresence runId="ssrun 1" tied classId="class-2" />);
    });
    // Ada is on the first class's register, which says nothing about the second's.
    expect(screen.getByText('Reading the class register…')).toBeTruthy();
    expect(rowOf('Ada Reyes').textContent).not.toContain('Present on the class register');
    expect(screen.queryByText(/marked Present on the class register/)).toBeNull();

    await act(async () => {
      releaseSecond(register([onRegister('ath-2', 'parent', { class_id: 'class-2' })]));
    });
    expect(rowOf('Ben Ortiz').textContent).toContain('Present on the class register, via parent.');
    expect(rowOf('Ada Reyes').textContent).not.toContain('Present on the class register');
  });

  test('a late answer for another class is dropped', async () => {
    let releaseOld: (response: Response) => void = () => {};
    registerReads = 0;
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== SCHEDULER) return read([]);
      registerReads += 1;
      if (registerReads === 1) return new Promise<Response>((resolve) => { releaseOld = resolve; });
      return register([onRegister('ath-2', 'self', { class_id: 'class-2' })]);
    }) as unknown as typeof fetch;

    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(<SessionRunPresence runId="ssrun 1" tied classId="class-1" />);
    });
    expect(screen.getByText('Reading the class register…')).toBeTruthy();
    await act(async () => {
      view!.rerender(<SessionRunPresence runId="ssrun 1" tied classId="class-2" />);
    });
    expect(rowOf('Ben Ortiz').textContent).toContain('Present on the class register, via self check-in.');
    // The first class's answer arrives after the session moved to the second: it paints nothing.
    await act(async () => {
      releaseOld(register([onRegister('ath-1', 'self')]));
    });
    expect(rowOf('Ada Reyes').textContent).not.toContain('Present on the class register');
    expect(rowOf('Ben Ortiz').textContent).toContain('Present on the class register, via self check-in.');
  });
});

test('each athlete marked here, and only those, gets a behaviour window to open (PATTERN-1f, Q5 A); it reads nothing until opened', async () => {
  serve(() => read([ADA]));
  await show();
  const ada = rows().find((row) => row.textContent?.includes('Ada Reyes'));
  const ben = rows().find((row) => row.textContent?.includes('Ben Ortiz'));
  expect(within(ada as HTMLElement).getByRole('button', { name: 'Watch a behaviour for Ada Reyes' })).toBeTruthy();
  expect(within(ben as HTMLElement).queryByRole('button', { name: /Watch a behaviour/ })).toBeNull();
  expect(gets.every((call) => !call.url.includes('/api/pilot/coach/behaviour-'))).toBe(true);
});


// W4 item 7, OQ-4: a here tap whose answer is lost is kept on the open page and sent again until it
// goes through (OW27-34 A, OW27-35 A), with the milliseconds since the tap (Overwatch condition 1).
describe('here taps kept on a flaky connection (W4 item 7, OQ-4)', () => {
  interface SentCall { body: Record<string, unknown>; signal: unknown }
  let sent: SentCall[];
  let presentReads: unknown[];
  let noteWrites: Array<Record<string, unknown>>;
  const answer = (body: unknown, status = 200) => {
    const response = { ok: status >= 200 && status < 300, status, json: async () => body, clone: () => response };
    return response as unknown as Response;
  };

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
    tap: (send: number) => Response | 'lost' | Promise<Response>;
    present: () => Array<typeof ADA> | 'fail';
    session?: () => Response | Promise<Response>;
    gym?: Array<typeof ADA>;
  }) {
    sent = [];
    presentReads = [];
    noteWrites = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/pilot/auth/session')) {
        return handlers.session ? handlers.session() : answer({ authenticated: true, account_id: 'acct-a' });
      }
      // The staff notes of an athlete marked here: none yet, and a new one's send is lost.
      if (url.startsWith('/api/pilot/coach/session-staff-notes')) {
        if ((init?.method ?? 'GET') === 'GET') return answer({ ok: true, note_max: 2000, notes: [] });
        noteWrites.push(JSON.parse(String(init?.body)));
        throw new TypeError('Failed to fetch');
      }
      if (url === URL_FOR && init?.method === 'POST') {
        sent.push({ body: JSON.parse(String(init.body)), signal: init.signal });
        const next = await handlers.tap(sent.length);
        if (next === 'lost') throw new TypeError('Failed to fetch');
        return next;
      }
      if (url === URL_FOR) {
        presentReads.push(init?.signal);
        const present = handlers.present();
        if (present === 'fail') return answer({}, 500);
        return answer({ present: present.map((athlete) => ({ ...athlete, marked_at: 'x' })), gym: handlers.gym ?? [ADA, BEN, CY] });
      }
      return answer({});
    }) as unknown as typeof fetch;
  }

  async function showKept(props: { onRunNotLive?: jest.Mock; finishWaiting?: boolean; tied?: boolean } = {}) {
    const isFinishWaiting = () => props.finishWaiting === true;
    prepareSaveQueue();
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(
        <>
          <SessionRunPresence
            runId="ssrun 1"
            tied={props.tied === true}
            classId={props.tied === true ? 'class-youth' : null}
            onRunNotLive={props.onRunNotLive ?? jest.fn()}
            isFinishWaiting={isFinishWaiting}
          />
          <SaveQueueNotice />
        </>,
      );
      await jest.advanceTimersByTimeAsync(0);
    });
    return view as ReturnType<typeof render>;
  }

  async function tapKept(name: string) {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name }));
      await jest.advanceTimersByTimeAsync(0);
    });
  }

  async function wait(ms: number) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }

  const waitingLine = () => (screen.queryByText(WAITING_WORDS)?.closest('[role="status"]') as HTMLElement | null | undefined) ?? null;
  const WAITING_ROW = 'Marked here: not saved yet. This page keeps sending it while it stays open.';

  test('a tap whose send is lost is kept, unnamed in the page\'s list, said on its row, resent with its signal and the time since the tap, and lands once', async () => {
    jest.useFakeTimers();
    let present: Array<typeof ADA> = [];
    serveKept({
      tap: (send) => {
        if (send === 1) return 'lost';
        present = [ADA];
        return answer({ outcome: 'marked' });
      },
      present: () => present,
    });
    await showKept();
    await tapKept('Mark here Ada Reyes');
    const line = waitingLine() as HTMLElement;
    expect(within(line).getByText('Mark an athlete here')).toBeTruthy();
    expect(line.textContent).not.toContain('Ada');
    expect(screen.getByRole('button', { name: 'Here Ada Reyes' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(WAITING_ROW)).toBeTruthy();
    // The count is the server's.
    expect(screen.getByText('Nobody marked here yet. Tap each athlete in the room.')).toBeTruthy();
    // A mark not saved yet opens no notes for the athlete: the server takes a note only for one marked here.
    expect(screen.queryByRole('button', { name: 'Staff notes on Ada Reyes' })).toBeNull();
    await wait(RESEND_MS);
    expect(sent).toHaveLength(2);
    for (const call of sent) {
      expect(call.body).toEqual({ athlete_id: 'ath-1', present: true, tapped_ms_ago: expect.any(Number), page_id: expect.any(String) });
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
    expect(sent[1].body.tapped_ms_ago as number).toBeGreaterThanOrEqual(RESEND_MS);
    expect(screen.getByText('1 marked here.')).toBeTruthy();
    expect(waitingLine()).toBeNull();
    expect(screen.queryByText(WAITING_ROW)).toBeNull();
  });

  test('a refused first send is not resent; its words name the athlete on this list, not in the page\'s, and outlast the next tap', async () => {
    jest.useFakeTimers();
    serveKept({
      tap: (send) => (send === 1 ? answer({ error: 'x', code: 'SESSION_RUN_ATHLETE_NOT_PERMITTED' }, 403) : answer({ outcome: 'marked' })),
      present: () => [],
    });
    await showKept();
    await tapKept('Mark here Ada Reyes');
    const words = 'Ada Reyes: This account cannot mark that athlete here. Nothing was saved.';
    expect(screen.getByText(words)).toBeTruthy();
    expect(screen.queryByText(FAILED_WORDS)).toBeNull();
    // A tap of someone else does not take the words away.
    await tapKept('Mark here Ben Ortiz');
    expect(screen.getByText(words)).toBeTruthy();
    await wait(RESEND_MS * 2);
    expect(sent).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Mark here Ada Reyes' })).toBeTruthy();
  });

  test('refusals that come back together are all said, each named, until OK; an athlete\'s next saved tap takes theirs away', async () => {
    jest.useFakeTimers();
    let present: Array<typeof ADA> = [];
    serveKept({
      tap: (send) => {
        // Both first sends are lost; on the way back both are refused; Ada's next tap goes through.
        if (send <= 2) return 'lost';
        if (send <= 4) return answer({ error: 'x', code: 'SESSION_RUN_ATHLETE_NOT_PERMITTED' }, 403);
        present = [ADA];
        return answer({ outcome: 'marked' });
      },
      present: () => present,
    });
    await showKept();
    await tapKept('Mark here Ada Reyes');
    await tapKept('Mark here Ben Ortiz');
    await wait(RESEND_MS);
    await wait(RESEND_MS);
    expect(screen.getByText('Ada Reyes: This account cannot mark that athlete here. Nothing was saved.')).toBeTruthy();
    expect(screen.getByText('Ben Ortiz: This account cannot mark that athlete here. Nothing was saved.')).toBeTruthy();
    await tapKept('Mark here Ada Reyes');
    expect(screen.queryByText(/^Ada Reyes: This account cannot/)).toBeNull();
    expect(screen.getByText('Ben Ortiz: This account cannot mark that athlete here. Nothing was saved.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    });
    expect(screen.queryByText(/This account cannot mark/)).toBeNull();
  });

  test('a refused tap gives back only its own row while another athlete\'s tap still waits', async () => {
    jest.useFakeTimers();
    let refuseAda: ((response: Response) => void) | undefined;
    serveKept({
      tap: (send) => {
        if (send === 1) {
          return new Promise<Response>((resolve) => {
            refuseAda = resolve;
          });
        }
        return 'lost';
      },
      present: () => [],
    });
    await showKept();
    await tapKept('Mark here Ada Reyes');
    await tapKept('Mark here Ben Ortiz');
    expect(screen.getByRole('button', { name: 'Here Ada Reyes' })).toBeTruthy();
    await act(async () => {
      refuseAda?.(answer({ error: 'x', code: 'SESSION_RUN_ATHLETE_NOT_PERMITTED' }, 403));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('button', { name: 'Mark here Ada Reyes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Here Ben Ortiz' })).toBeTruthy();
  });

  test('a sign-out takes the named refusals off the screen', async () => {
    jest.useFakeTimers();
    serveKept({ tap: () => answer({ error: 'x', code: 'SESSION_RUN_ATHLETE_NOT_PERMITTED' }, 403), present: () => [] });
    await showKept();
    await tapKept('Mark here Ada Reyes');
    expect(screen.getByText(/^Ada Reyes: This account cannot/)).toBeTruthy();
    await act(async () => {
      clearRoleSession();
    });
    expect(screen.queryByText(/^Ada Reyes: This account cannot/)).toBeNull();
  });

  test('a waiting tap stays in view in a large gym\'s list, said on its row and described to the button, and counted for screen readers', async () => {
    jest.useFakeTimers();
    const gym = Array.from({ length: 31 }, (_, index) => ({ athlete_id: `ath-${index + 10}`, full_name: `Athlete ${String(index + 10)}` }));
    serveKept({ tap: () => 'lost', present: () => [], gym });
    await showKept();
    fireEvent.change(screen.getByLabelText('Find an athlete'), { target: { value: 'Athlete 17' } });
    await tapKept('Mark here Athlete 17');
    fireEvent.change(screen.getByLabelText('Find an athlete'), { target: { value: '' } });
    const button = screen.getByRole('button', { name: 'Here Athlete 17' });
    const line = screen.getByText(WAITING_ROW);
    expect(line.id).not.toBe('');
    expect(button.getAttribute('aria-describedby')).toBe(line.id);
    expect(screen.getByText('One here tap is not saved yet.')).toBeTruthy();
  });

  test('an unmark whose send is lost is kept and said; a refused resend the server shows as unmarked reads as done', async () => {
    jest.useFakeTimers();
    let present: Array<typeof ADA> = [ADA];
    serveKept({
      tap: (send) => {
        if (send === 1) {
          present = [];
          return 'lost';
        }
        return answer({ error: 'SOMETHING_ELSE' }, 409);
      },
      present: () => present,
    });
    await showKept();
    await tapKept('Here Ada Reyes');
    expect(screen.getByText('Unmarked here: not saved yet. This page keeps sending it while it stays open.')).toBeTruthy();
    expect(sent[0].body).toEqual({ athlete_id: 'ath-1', present: false, tapped_ms_ago: expect.any(Number), page_id: expect.any(String) });
    await wait(RESEND_MS);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Nobody marked here yet. Tap each athlete in the room.')).toBeTruthy();
  });

  test('a tap refused because the run cannot be found tells the live screen, as today', async () => {
    jest.useFakeTimers();
    serveKept({ tap: () => answer({ error: 'SESSION_RUN_NOT_FOUND' }, 404), present: () => [] });
    const onRunNotLive = jest.fn();
    await showKept({ onRunNotLive });
    await tapKept('Mark here Ada Reyes');
    expect(onRunNotLive).toHaveBeenCalledTimes(1);
  });

  test('a resend refused as no longer live whose check finds the mark reads as done and still tells the live screen', async () => {
    jest.useFakeTimers();
    let present: Array<typeof ADA> = [];
    serveKept({
      tap: (send) => {
        if (send === 1) {
          present = [ADA];
          return 'lost';
        }
        return answer({ error: 'SESSION_RUN_NOT_LIVE' }, 409);
      },
      present: () => present,
    });
    const onRunNotLive = jest.fn();
    await showKept({ onRunNotLive });
    await tapKept('Mark here Ada Reyes');
    await wait(RESEND_MS);
    expect(onRunNotLive).toHaveBeenCalledTimes(1);
    expect(screen.getByText('1 marked here.')).toBeTruthy();
  });

  test('a kept tap that lands says what it did to the class register, and a Training Hold, as today', async () => {
    jest.useFakeTimers();
    let present: Array<typeof ADA> = [];
    serveKept({
      tap: (send) => {
        if (send === 1) return 'lost';
        present = [ADA];
        return answer({ outcome: 'marked', register: { effect: 'created' }, hold_warning: { hold_id: 'h' } });
      },
      present: () => present,
    });
    await showKept();
    await tapKept('Mark here Ada Reyes');
    await wait(RESEND_MS);
    // The register's answer on the row; the hold, which a burst would overwrite there, named in the
    // list's alert (round 12, reviewers A and B).
    expect(screen.getAllByText('Ada Reyes is Present on the class register.').length).toBeGreaterThan(0);
    expect(screen.getByRole('alert').textContent).toContain('Ada Reyes has an active Training Hold; the mark was NOT blocked.');
  });

  // Both merge-check reviewers of round 11: a kept tap carries its tap time, so the register can keep
  // an Absent or Excused set there after the tap (register_newer); the coach is told, never left
  // believing the register shows Present.
  test('a kept tap that lands after the register was changed says the register stays as it was set', async () => {
    jest.useFakeTimers();
    let present: Array<typeof ADA> = [];
    serveKept({
      tap: (send) => {
        if (send === 1) return 'lost';
        present = [ADA];
        return answer({ outcome: 'marked', register: { effect: 'register_newer', status: 'excused' } });
      },
      present: () => present,
    });
    await showKept();
    await tapKept('Mark here Ada Reyes');
    await wait(RESEND_MS);
    expect(sent[1].body).toMatchObject({ tapped_ms_ago: expect.any(Number) });
    expect(screen.getAllByText(ADA_STAYS).length).toBeGreaterThan(0);
  });

  // Reviewer B, round 11 (R11-S1): kept taps land in a burst when the connection returns. The row's
  // one note is overwritten by the next tap's, so a register_newer answer is also kept in the list's
  // named alert, until OK, that athlete's next saved tap, or a drop of the queue.
  const ADA_STAYS = 'Ada Reyes was marked here, but the class register had been changed after your tap, so it kept Excused there. Change it on the register if Ada Reyes is here.';
  function serveBurst() {
    let present: Array<typeof ADA> = [];
    let lost = true;
    serveKept({
      tap: () => {
        // The first send is lost; then everything kept lands, Ada's answered register_newer.
        if (lost) {
          lost = false;
          return 'lost';
        }
        const body = sent[sent.length - 1].body;
        const athlete = [ADA, BEN, CY].find((one) => one.athlete_id === body.athlete_id) as typeof ADA;
        present = body.present ? [...present.filter((one) => one !== athlete), athlete] : present.filter((one) => one !== athlete);
        if (!body.present) return answer({ outcome: 'unmarked', register: { effect: 'unchanged' } });
        return athlete === ADA && sent.length <= 3
          ? answer({ outcome: 'marked', register: { effect: 'register_newer', status: 'excused' } })
          : answer({ outcome: 'marked', register: { effect: 'created' } });
      },
      present: () => present,
    });
  }

  test('two kept taps landing together: the register_newer words stay named in the list\'s alert after the next tap\'s note, until OK', async () => {
    jest.useFakeTimers();
    serveBurst();
    await showKept();
    await tapKept('Mark here Ada Reyes');
    await tapKept('Mark here Ben Ortiz');
    await wait(RESEND_MS);
    expect(sent.map((call) => call.body.athlete_id)).toEqual(['ath-1', 'ath-1', 'ath-2']);
    // Ben's note took the row's one slot; Ada's register line is in the alert.
    expect(screen.getAllByText('Ben Ortiz is Present on the class register.').length).toBeGreaterThan(0);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(ADA_STAYS);
    // Said once: not also left in Ada's row.
    expect(screen.getAllByText(ADA_STAYS)).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    });
    expect(screen.queryByText(ADA_STAYS)).toBeNull();
  });

  test('a register_newer line goes with that athlete\'s next saved tap, not with another athlete\'s', async () => {
    jest.useFakeTimers();
    serveBurst();
    await showKept();
    await tapKept('Mark here Ada Reyes');
    await tapKept('Mark here Ben Ortiz');
    await wait(RESEND_MS);
    expect(screen.getByRole('alert').textContent).toContain(ADA_STAYS);
    // Cy's saved tap leaves Ada's line; Ada's own next saved tap takes it away.
    await tapKept('Mark here Cy Marsh');
    expect(screen.getByRole('alert').textContent).toContain(ADA_STAYS);
    await tapKept('Here Ada Reyes');
    expect(screen.queryByText(ADA_STAYS)).toBeNull();
  });

  test('a refused next tap of the same athlete is said beside their register line, not over it', async () => {
    jest.useFakeTimers();
    let present: Array<typeof ADA> = [];
    serveKept({
      tap: (send) => {
        if (send === 1) return 'lost';
        if (send === 2) {
          present = [ADA];
          return answer({ outcome: 'marked', register: { effect: 'register_newer', status: 'excused' } });
        }
        return answer({ error: 'x', code: 'SESSION_RUN_ATHLETE_NOT_PERMITTED' }, 403);
      },
      present: () => present,
    });
    await showKept();
    await tapKept('Mark here Ada Reyes');
    await wait(RESEND_MS);
    await tapKept('Here Ada Reyes');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(ADA_STAYS);
    expect(alert.textContent).toContain('Ada Reyes: This account cannot mark that athlete here. Nothing was saved.');
  });

  test('a sign-out takes a register_newer line off the screen', async () => {
    jest.useFakeTimers();
    serveBurst();
    await showKept();
    await tapKept('Mark here Ada Reyes');
    await wait(RESEND_MS);
    expect(screen.getByRole('alert').textContent).toContain(ADA_STAYS);
    await act(async () => {
      clearRoleSession();
    });
    expect(screen.queryByText(ADA_STAYS)).toBeNull();
    // Gone, not only hidden behind the count: the same coach signing in again does not bring it back.
    expect(screen.queryByText(/messages? about (a )?saves? on this list/)).toBeNull();
    await act(async () => {
      createPersistentRoleSession('coach');
      await jest.advanceTimersByTimeAsync(0);
    });
    await tapKept('Here Ada Reyes');
    expect(screen.queryByText(ADA_STAYS)).toBeNull();
  });

  // Round 12, reviewers A and B: a Training Hold warning is a line of its own in the alert, so a burst
  // of landing taps never overwrites it; it goes with that athlete's next saved tap, OK or a drop.
  test('two kept taps landing together: the first athlete\'s Training Hold stays named in the alert after the next tap\'s note', async () => {
    jest.useFakeTimers();
    let present: Array<typeof ADA> = [];
    let lost = true;
    serveKept({
      tap: () => {
        if (lost) {
          lost = false;
          return 'lost';
        }
        const body = sent[sent.length - 1].body;
        const athlete = [ADA, BEN].find((one) => one.athlete_id === body.athlete_id) as typeof ADA;
        present = present.filter((one) => one !== athlete);
        if (!body.present) return answer({ outcome: 'unmarked', register: { effect: 'unchanged' } });
        present = [...present, athlete];
        return athlete === ADA
          ? answer({ outcome: 'marked', register: { effect: 'created' }, hold_warning: { hold_id: 'h' } })
          : answer({ outcome: 'marked', register: { effect: 'created' } });
      },
      present: () => present,
    });
    await showKept();
    await tapKept('Mark here Ada Reyes');
    await tapKept('Mark here Ben Ortiz');
    await wait(RESEND_MS);
    expect(screen.getAllByText('Ben Ortiz is Present on the class register.').length).toBeGreaterThan(0);
    expect(screen.getByRole('alert').textContent).toContain('Ada Reyes has an active Training Hold; the mark was NOT blocked.');
    // Ben's later saved tap leaves Ada's line; Ada's own takes it away.
    await tapKept('Here Ben Ortiz');
    expect(screen.getByRole('alert').textContent).toContain('Ada Reyes has an active Training Hold');
    await tapKept('Here Ada Reyes');
    expect(screen.queryByText(/Ada Reyes has an active Training Hold/)).toBeNull();
  });

  // Round 12, reviewers A and B: while a kept finish waits, this list goes when the finish lands, so
  // what the coach must still check after a saved tap is said in the page's list, unnamed, as saved.
  test('a kept tap saved while a finish waits, with the register kept as set after it, is listed as saved with something to check', async () => {
    jest.useFakeTimers();
    let present: Array<typeof ADA> = [];
    serveKept({
      tap: (send) => {
        if (send === 1) return 'lost';
        present = [ADA];
        return answer({ outcome: 'marked', register: { effect: 'register_newer', status: 'excused' }, hold_warning: { hold_id: 'h' } });
      },
      present: () => present,
    });
    await showKept({ finishWaiting: true });
    await tapKept('Mark here Ada Reyes');
    await wait(RESEND_MS);
    expect(screen.getByText(SAVED_CHECK_WORDS)).toBeTruthy();
    expect(screen.getByText(
      'Mark an athlete here: saved, but the class register kept a mark set there after the tap; change it on the register if the athlete is here. And the athlete has an active Training Hold; the mark was NOT blocked.',
    )).toBeTruthy();
    expect(screen.queryByText(FAILED_WORDS)).toBeNull();
    // Unnamed: the page's list outlives this list on a shared floor screen.
    expect(screen.queryByText(/Ada Reyes was marked here/)).toBeNull();
  });

  test('a kept tap saved after this list has gone, with nothing to check, says nothing more', async () => {
    jest.useFakeTimers();
    serveKept({ tap: (send) => (send === 1 ? 'lost' : answer({ outcome: 'marked', register: { effect: 'created' } })), present: () => [] });
    const view = await showKept();
    await tapKept('Mark here Ada Reyes');
    view.unmount();
    await act(async () => {
      render(<SaveQueueNotice />);
    });
    await wait(RESEND_MS);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // Round 12, reviewer B: a tap whose first answer (register_newer) was lost is answered "unchanged" with
  // no register on its resend; on a tied list the register's state is then not known, and said so.
  test('on a tied list, a kept tap that lands with no register answer says what the register holds is not known', async () => {
    jest.useFakeTimers();
    let present: Array<typeof ADA> = [];
    serveKept({
      tap: (send) => {
        present = [ADA];
        return send === 1 ? 'lost' : answer({ outcome: 'unchanged' });
      },
      present: () => present,
    });
    await showKept({ tied: true });
    await tapKept('Mark here Ada Reyes');
    await wait(RESEND_MS);
    expect(screen.getByText(
      'Ada Reyes was marked here. Whether the class register has Ada Reyes Present is not known: check the class register.',
    ).closest('[role="alert"]')).not.toBeNull();
  });

  test('on an untied list, a kept tap that lands with no register answer adds no register line', async () => {
    jest.useFakeTimers();
    let present: Array<typeof ADA> = [];
    serveKept({
      tap: (send) => {
        present = [ADA];
        return send === 1 ? 'lost' : answer({ outcome: 'unchanged' });
      },
      present: () => present,
    });
    await showKept();
    await tapKept('Mark here Ada Reyes');
    await wait(RESEND_MS);
    expect(screen.queryByText(/is not known: check the class register/)).toBeNull();
  });

  // Round 12, reviewers A and B: the row's note is one person's answer on a shared tablet.
  test('a sign-out takes a kept tap\'s row note off the screen', async () => {
    jest.useFakeTimers();
    let present: Array<typeof ADA> = [];
    serveKept({
      tap: (send) => {
        if (send === 1) return 'lost';
        present = [ADA];
        return answer({ outcome: 'marked', register: { effect: 'created' } });
      },
      present: () => present,
    });
    await showKept();
    await tapKept('Mark here Ada Reyes');
    await wait(RESEND_MS);
    expect(screen.getAllByText('Ada Reyes is Present on the class register.').length).toBeGreaterThan(0);
    await act(async () => {
      clearRoleSession();
    });
    expect(screen.queryByText('Ada Reyes is Present on the class register.')).toBeNull();
  });

  test('while the page checks again who is signed in, a kept tap\'s row note is hidden; the same coach confirmed, it returns', async () => {
    jest.useFakeTimers();
    let present: Array<typeof ADA> = [];
    let session: () => Response | Promise<Response> = () => answer({ authenticated: true, account_id: 'acct-a' });
    let answerCheck: () => void = () => undefined;
    serveKept({
      tap: (send) => {
        if (send === 1) return 'lost';
        present = [ADA];
        return answer({ outcome: 'marked', register: { effect: 'created' } });
      },
      present: () => present,
      session: () => session(),
    });
    await showKept();
    await tapKept('Mark here Ada Reyes');
    await wait(RESEND_MS);
    expect(screen.getAllByText('Ada Reyes is Present on the class register.')).toHaveLength(2);
    session = () => new Promise<Response>((resolve) => {
      answerCheck = () => resolve(answer({ authenticated: true, account_id: 'acct-a' }));
    });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText('Ada Reyes is Present on the class register.')).toBeNull();
    await act(async () => {
      answerCheck();
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.getAllByText('Ada Reyes is Present on the class register.')).toHaveLength(2);
  });

  // Round 12, reviewers A and B (OBSERVED with a held body): a drop while a saved tap's answer is read
  // leaves nothing of it for the next person.
  test('a sign-out while a saved tap\'s answer is being read leaves no line or note of it', async () => {
    jest.useFakeTimers();
    let release: (() => void) | undefined;
    let present: Array<typeof ADA> = [];
    serveKept({
      tap: (send) => {
        if (send === 1) return 'lost';
        present = [ADA];
        const body = { outcome: 'marked', register: { effect: 'register_newer', status: 'excused' } };
        const held = new Promise<unknown>((resolve) => {
          release = () => resolve(body);
        });
        const readable = { ok: true, status: 200, json: async () => body } as Record<string, unknown>;
        readable.clone = () => readable;
        const response = { ok: true, status: 200, json: () => held, clone: () => readable };
        return response as unknown as Response;
      },
      present: () => present,
    });
    await showKept();
    await tapKept('Mark here Ada Reyes');
    await wait(RESEND_MS);
    await act(async () => {
      clearRoleSession();
    });
    await act(async () => {
      release?.();
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText(ADA_STAYS)).toBeNull();
    expect(screen.queryByText(/messages? about (a )?saves? on this list/)).toBeNull();
  });

  test('every kept tap of this page carries the same page id', async () => {
    jest.useFakeTimers();
    serveKept({ tap: (send) => (send === 1 ? 'lost' : answer({ outcome: 'marked' })), present: () => [] });
    await showKept();
    await tapKept('Mark here Ada Reyes');
    await tapKept('Mark here Ben Ortiz');
    await wait(RESEND_MS);
    const ids = new Set(sent.map((call) => call.body.page_id));
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(ids.size).toBe(1);
    expect(String([...ids][0]).length).toBeGreaterThan(0);
  });

  test('a not-known outcome after this list has gone is listed apart in the page\'s list, with where to check', async () => {
    jest.useFakeTimers();
    let reads = 0;
    serveKept({
      tap: (send) => (send === 1 ? 'lost' : answer({ error: 'SOMETHING_ELSE' }, 409)),
      present: () => {
        reads += 1;
        return reads === 1 ? [] : 'fail';
      },
    });
    const view = await showKept();
    await tapKept('Mark here Ada Reyes');
    await act(async () => {
      view.rerender(<SaveQueueNotice />);
    });
    await wait(RESEND_MS);
    expect(screen.getByText(UNKNOWN_WORDS)).toBeTruthy();
    expect(screen.getByText(`Mark an athlete here: ${unknownOffPage('Check who is marked here on the class screen.')}`)).toBeTruthy();
  });

  test('a refused RESEND that the server shows had landed reads as marked (condition 2), read with the queue\'s signal', async () => {
    jest.useFakeTimers();
    let present: Array<typeof ADA> = [];
    serveKept({
      tap: (send) => {
        if (send === 1) {
          // It reached the server; the answer was lost.
          present = [ADA];
          return 'lost';
        }
        return answer({ error: 'SOMETHING_ELSE' }, 409);
      },
      present: () => present,
    });
    await showKept();
    await tapKept('Mark here Ada Reyes');
    await wait(RESEND_MS);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('1 marked here.')).toBeTruthy();
    expect(presentReads[presentReads.length - 1]).toBeInstanceOf(AbortSignal);
  });

  test('a refused RESEND that could not be checked says the outcome is not known, on this list', async () => {
    jest.useFakeTimers();
    let reads = 0;
    serveKept({
      tap: (send) => (send === 1 ? 'lost' : answer({ error: 'SOMETHING_ELSE' }, 409)),
      present: () => {
        reads += 1;
        return reads === 1 ? [] : 'fail';
      },
    });
    await showKept();
    await tapKept('Mark here Ada Reyes');
    await wait(RESEND_MS);
    expect(screen.getByText(/^Mark Ada Reyes here: the server refused it when it was sent again and could not be checked/)).toBeTruthy();
    expect(screen.queryByText(FAILED_WORDS)).toBeNull();
    expect(screen.queryByText(UNKNOWN_WORDS)).toBeNull();
  });

  test('a tap refused because the session is no longer live tells the live screen, as today', async () => {
    jest.useFakeTimers();
    serveKept({ tap: () => answer({ error: 'SESSION_RUN_NOT_LIVE' }, 409), present: () => [] });
    const onRunNotLive = jest.fn();
    await showKept({ onRunNotLive });
    await tapKept('Mark here Ada Reyes');
    expect(onRunNotLive).toHaveBeenCalledTimes(1);
  });

  test('signing out drops a kept tap: its words and what it asked leave the screen, and it is not resent', async () => {
    jest.useFakeTimers();
    serveKept({ tap: () => 'lost', present: () => [] });
    await showKept();
    await tapKept('Mark here Ada Reyes');
    expect(screen.getByText(WAITING_ROW)).toBeTruthy();
    await act(async () => {
      clearRoleSession();
    });
    expect(waitingLine()).toBeNull();
    expect(screen.queryByText(WAITING_ROW)).toBeNull();
    expect(screen.getByRole('button', { name: 'Mark here Ada Reyes' })).toBeTruthy();
    await wait(RESEND_MS * 3);
    expect(sent).toHaveLength(1);
  });

  test('what each tap asked goes with its own answer: mark, unmark, mark, and the last mark still waits after the first two land', async () => {
    jest.useFakeTimers();
    let present: Array<typeof ADA> = [];
    serveKept({
      tap: (send) => {
        if (send === 1) return 'lost';
        // The last mark is held back.
        if (send === 4) return new Promise<Response>(() => {});
        const body = sent[send - 1].body;
        present = body.present ? [ADA] : [];
        return answer({ outcome: body.present ? 'marked' : 'unmarked' });
      },
      present: () => present,
    });
    await showKept();
    await tapKept('Mark here Ada Reyes');
    await tapKept('Here Ada Reyes');
    await tapKept('Mark here Ada Reyes');
    await wait(RESEND_MS);
    expect(sent).toHaveLength(4);
    // The server holds the unmark; the mark after it is asked and not saved.
    expect(screen.getByText('Nobody marked here yet. Tap each athlete in the room.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Here Ada Reyes' })).toBeTruthy();
    expect(screen.getByText(WAITING_ROW)).toBeTruthy();
  });

  test('a tap made before the page has confirmed who is signed in is still said on its row once kept', async () => {
    jest.useFakeTimers();
    const asked: Array<() => void> = [];
    serveKept({
      tap: () => 'lost',
      present: () => [],
      session: () => new Promise<Response>((resolve) => {
        asked.push(() => resolve(answer({ authenticated: true, account_id: 'acct-a' })));
      }),
    });
    await showKept();
    await tapKept('Mark here Ada Reyes');
    expect(asked.length).toBeGreaterThan(0);
    await act(async () => {
      for (const resolveNow of asked.splice(0)) resolveNow();
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(sent).toHaveLength(1);
    expect(screen.getByText(WAITING_ROW)).toBeTruthy();
  });

  test('a refusal after this list has gone is said in the page\'s list, its reason after the save\'s name', async () => {
    jest.useFakeTimers();
    serveKept({
      tap: (send) => (send === 1 ? 'lost' : answer({ error: 'x', code: 'SESSION_RUN_ATHLETE_NOT_PERMITTED' }, 403)),
      present: () => [],
    });
    const view = await showKept();
    await tapKept('Mark here Ada Reyes');
    await act(async () => {
      view.rerender(<SaveQueueNotice />);
    });
    await wait(RESEND_MS);
    expect(screen.getByText('Mark an athlete here: This account cannot mark that athlete here. Nothing was saved.')).toBeTruthy();
  });

  test('a refusal while a kept finish waits is said in the page\'s list: the console goes once the finish lands', async () => {
    jest.useFakeTimers();
    serveKept({
      tap: (send) => (send === 1 ? 'lost' : answer({ error: 'x', code: 'SESSION_RUN_ATHLETE_NOT_PERMITTED' }, 403)),
      present: () => [],
    });
    await showKept({ finishWaiting: true });
    await tapKept('Mark here Ada Reyes');
    await wait(RESEND_MS);
    expect(screen.getByText('Mark an athlete here: This account cannot mark that athlete here. Nothing was saved.')).toBeTruthy();
    expect(screen.queryByText('Ada Reyes: This account cannot mark that athlete here. Nothing was saved.')).toBeNull();
  });
});


test('on the live floor, notes refused with the panel closed are each said, named, without their words, through a filter; the words come back into the box', async () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  createPersistentRoleSession('coach');
  resetSaveQueueForTests();
  jest.useFakeTimers();
  try {
    let posts = 0;
    const answer = (body: unknown, status = 200) => {
      const response = { ok: status >= 200 && status < 300, status, json: async () => body, clone: () => response };
      return response as unknown as Response;
    };
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/pilot/auth/session')) return answer({ authenticated: true, account_id: 'acct-a' });
      if (url.startsWith('/api/pilot/coach/session-staff-notes')) {
        if ((init?.method ?? 'GET') === 'GET') return answer({ ok: true, note_max: 2000, notes: [] });
        posts += 1;
        // The first note's first send is lost; every send after is refused.
        if (posts === 1) throw new TypeError('Failed to fetch');
        return answer({ error: 'That athlete is not marked here.' }, 409);
      }
      // A tap of Ada is refused: its words sit beside her notes' refusals, never in their place.
      if (url === URL_FOR && init?.method === 'POST') return answer({ error: 'x', code: 'SESSION_RUN_ATHLETE_NOT_PERMITTED' }, 403);
      if (url === URL_FOR) return answer({ present: [{ ...ADA, marked_at: 'x' }], gym: [ADA, BEN, CY] });
      return answer({});
    }) as unknown as typeof fetch;
    prepareSaveQueue();
    await act(async () => {
      render(
        <>
          <SessionRunPresence runId="ssrun 1" />
          <SaveQueueNotice />
        </>,
      );
      await jest.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Staff notes on Ada Reyes' }));
      await jest.advanceTimersByTimeAsync(0);
    });
    for (const words of ['First note.', 'Second note.']) {
      fireEvent.change(screen.getByLabelText(/New note/), { target: { value: words } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
        await jest.advanceTimersByTimeAsync(0);
      });
    }
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hide staff notes' }));
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS * 2);
    });
    const said = 'Ada Reyes: a new note was not saved: That athlete is not marked here. Its words are back in the box when this athlete\'s notes are next opened.';
    expect(screen.getAllByText(said)).toHaveLength(2);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Here Ada Reyes' }));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('Ada Reyes: This account cannot mark that athlete here. Nothing was saved.')).toBeTruthy();
    expect(screen.getAllByText(said)).toHaveLength(2);
    // The words are not shown on the floor.
    expect(screen.queryByText(/First note\.|Second note\./)).toBeNull();
    // Filtered away and back: the row remounts; the words are still kept, and come back when the notes open.
    fireEvent.change(screen.getByLabelText('Find an athlete'), { target: { value: 'Ben' } });
    fireEvent.change(screen.getByLabelText('Find an athlete'), { target: { value: '' } });
    expect(screen.getAllByText(said)).toHaveLength(2);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Staff notes on Ada Reyes' }));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect((screen.getByLabelText(/New note/) as HTMLTextAreaElement).value).toBe('First note.\n\nSecond note.');
    expect(screen.queryByText(FAILED_WORDS)).toBeNull();
  } finally {
    act(() => {
      resetSaveQueueForTests();
    });
    jest.useRealTimers();
  }
});

// The live list with one notes route: the session answers `account()` (when its promise settles, for a
// check held out), the list has Ada and Ben marked here, and each note POST gets `notePost(n)`.
async function showLiveNotes(handlers: { account: () => string | Promise<string>; notePost: (n: number) => 'lost' | 'refused' }) {
  const answer = (body: unknown, status = 200) => {
    const response = { ok: status >= 200 && status < 300, status, json: async () => body, clone: () => response };
    return response as unknown as Response;
  };
  let posts = 0;
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/pilot/auth/session')) return answer({ authenticated: true, account_id: await handlers.account() });
    if (url.startsWith('/api/pilot/coach/session-staff-notes')) {
      if ((init?.method ?? 'GET') === 'GET') return answer({ ok: true, note_max: 2000, notes: [] });
      posts += 1;
      if (handlers.notePost(posts) === 'lost') throw new TypeError('Failed to fetch');
      return answer({ error: 'That athlete is not marked here.' }, 409);
    }
    if (url === URL_FOR) return answer({ present: [ADA, BEN].map((athlete) => ({ ...athlete, marked_at: 'x' })), gym: [ADA, BEN, CY] });
    return answer({});
  }) as unknown as typeof fetch;
  prepareSaveQueue();
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(
      <>
        <SessionRunPresence runId="ssrun 1" />
        <SaveQueueNotice />
      </>,
    );
    await jest.advanceTimersByTimeAsync(0);
  });
  return view as ReturnType<typeof render>;
}

async function writeNote(athleteName: string, words: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: `Staff notes on ${athleteName}` }));
    await jest.advanceTimersByTimeAsync(0);
  });
  fireEvent.change(screen.getByLabelText(/New note/), { target: { value: words } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
    await jest.advanceTimersByTimeAsync(0);
  });
}

describe('refused live-floor notes kept by the list (W4 item 7, OQ-4)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    createPersistentRoleSession('coach');
    resetSaveQueueForTests();
    jest.useFakeTimers();
  });
  afterEach(() => {
    act(() => {
      resetSaveQueueForTests();
    });
    jest.useRealTimers();
  });
  const ADA_SAID = /^Ada Reyes: a new note was not saved/;

  test('a note refused while its row is filtered away is still named in the list, and its words come back to that athlete only', async () => {
    await showLiveNotes({ account: () => 'acct-a', notePost: (n) => (n === 1 ? 'lost' : 'refused') });
    await writeNote('Ada Reyes', 'Wrist taped.');
    // Ada's row goes out of view while her note waits.
    fireEvent.change(screen.getByLabelText('Find an athlete'), { target: { value: 'Ben' } });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(screen.getByText(ADA_SAID)).toBeTruthy();
    expect(screen.queryByText(FAILED_WORDS)).toBeNull();
    // Ben's box is not Ada's.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Staff notes on Ben Ortiz' }));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect((screen.getByLabelText(/New note/) as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Find an athlete'), { target: { value: '' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Staff notes on Ada Reyes' }));
      await jest.advanceTimersByTimeAsync(0);
    });
    const boxes = screen.getAllByLabelText(/New note/) as HTMLTextAreaElement[];
    expect(boxes.map((box) => box.value)).toContain('Wrist taped.');
  });

  test('another account confirmed on this page clears the named lines and the kept words: nothing reaches the next person\'s box', async () => {
    let account = 'acct-a';
    await showLiveNotes({ account: () => account, notePost: (n) => (n === 1 ? 'lost' : 'refused') });
    await writeNote('Ada Reyes', 'Wrist taped.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hide staff notes' }));
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(screen.getByText(ADA_SAID)).toBeTruthy();
    // Someone else signs in by a path that writes no device mark; the page checks again on focus.
    account = 'acct-b';
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText(ADA_SAID)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Staff notes on Ada Reyes' }));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect((screen.getByLabelText(/New note/) as HTMLTextAreaElement).value).toBe('');
  });

  test('another account confirmed on this page clears an open panel\'s box of the last person\'s refused words', async () => {
    let account = 'acct-a';
    await showLiveNotes({ account: () => account, notePost: (n) => (n === 1 ? 'lost' : 'refused') });
    await writeNote('Ada Reyes', 'Wrist taped.');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    // Open: said in the panel, words back in the box.
    expect((screen.getByLabelText(/New note/) as HTMLTextAreaElement).value).toBe('Wrist taped.');
    account = 'acct-b';
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect((screen.getByLabelText(/New note/) as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByText(/Its words: “Wrist taped\.”/)).toBeNull();
  });
  test('while the page checks again who is signed in, the list only counts its lines and gives no words back; once the same coach is confirmed, both return', async () => {
    let account: () => string | Promise<string> = () => 'acct-a';
    let answerCheck: (id: string) => void = () => undefined;
    await showLiveNotes({ account: () => account(), notePost: (n) => (n === 1 ? 'lost' : 'refused') });
    await writeNote('Ada Reyes', 'Wrist taped.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hide staff notes' }));
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(screen.getByText(ADA_SAID)).toBeTruthy();
    const ok = screen.getByRole('button', { name: 'OK' });
    act(() => {
      ok.focus();
    });
    // A sign-in elsewhere writes no device mark: back on this tab, the check is out and not answered yet.
    account = () => new Promise<string>((resolve) => {
      answerCheck = resolve;
    });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText(ADA_SAID)).toBeNull();
    expect(screen.getByText('1 message about a save on this list shows again once the page has checked who is signed in.')).toBeTruthy();
    // The count is not announced (the lines are, once they return), and OK keeps its place and the focus
    // but dismisses nothing unread.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'OK' })).toBe(ok);
    expect(document.activeElement).toBe(ok);
    expect(ok.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(ok);
    expect(screen.getByText('1 message about a save on this list shows again once the page has checked who is signed in.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Staff notes on Ada Reyes' }));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect((screen.getByLabelText(/New note/) as HTMLTextAreaElement).value).toBe('');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hide staff notes' }));
    });
    // The same coach after all: named again, said once, and the words come back when the notes are next
    // opened.
    await act(async () => {
      answerCheck('acct-a');
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('alert').textContent).toMatch(ADA_SAID);
    expect(screen.getByRole('button', { name: 'OK' }).getAttribute('aria-disabled')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Staff notes on Ada Reyes' }));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect((screen.getByLabelText(/New note/) as HTMLTextAreaElement).value).toBe('Wrist taped.');
  });

  test('a note refused after the whole list has gone is said in the page\'s list, without its words, not handed to the gone list', async () => {
    const view = await showLiveNotes({ account: () => 'acct-a', notePost: (n) => (n === 1 ? 'lost' : 'refused') });
    await writeNote('Ada Reyes', 'Wrist taped.');
    // The console moves on (another run, or the live screen left): the list goes, the page's list stays.
    await act(async () => {
      view.rerender(<SaveQueueNotice />);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(screen.getByText(FAILED_WORDS)).toBeTruthy();
    expect(screen.getByText(/Staff note/)).toBeTruthy();
    expect(screen.queryByText(/Wrist taped/)).toBeNull();
    expect(screen.queryByText(/Ada Reyes/)).toBeNull();
  });

  test('after one drop, a later refusal for the new coach stays on the list through later changes of the queue', async () => {
    let account = 'acct-a';
    await showLiveNotes({ account: () => account, notePost: (n) => (n === 1 ? 'lost' : 'refused') });
    account = 'acct-b';
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await jest.advanceTimersByTimeAsync(0);
    });
    await writeNote('Ada Reyes', 'Wrist taped.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hide staff notes' }));
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(screen.getByText(ADA_SAID)).toBeTruthy();
    // Another kept save goes through the queue: the line stays.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark here Cy Marsh' }));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText(ADA_SAID)).toBeTruthy();
  });
});

test('a sign-out clears the kept words of refused notes as well as the lines: nothing of them reaches the next person', async () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  createPersistentRoleSession('coach');
  resetSaveQueueForTests();
  jest.useFakeTimers();
  try {
    let posts = 0;
    const answer = (body: unknown, status = 200) => {
      const response = { ok: status >= 200 && status < 300, status, json: async () => body, clone: () => response };
      return response as unknown as Response;
    };
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/pilot/auth/session')) return answer({ authenticated: true, account_id: 'acct-a' });
      if (url.startsWith('/api/pilot/coach/session-staff-notes')) {
        if ((init?.method ?? 'GET') === 'GET') return answer({ ok: true, note_max: 2000, notes: [] });
        posts += 1;
        if (posts === 1) throw new TypeError('Failed to fetch');
        return answer({ error: 'That athlete is not marked here.' }, 409);
      }
      if (url === URL_FOR) return answer({ present: [{ ...ADA, marked_at: 'x' }], gym: [ADA, BEN, CY] });
      return answer({});
    }) as unknown as typeof fetch;
    prepareSaveQueue();
    await act(async () => {
      render(<SessionRunPresence runId="ssrun 1" />);
      await jest.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Staff notes on Ada Reyes' }));
      await jest.advanceTimersByTimeAsync(0);
    });
    fireEvent.change(screen.getByLabelText(/New note/), { target: { value: 'Wrist taped.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
      await jest.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Hide staff notes' }));
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(RESEND_MS);
    });
    expect(screen.getByText(/^Ada Reyes: a new note was not saved/)).toBeTruthy();
    await act(async () => {
      clearRoleSession();
    });
    await act(async () => {
      createPersistentRoleSession('coach');
    });
    expect(screen.queryByText(/^Ada Reyes: a new note was not saved/)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Staff notes on Ada Reyes' }));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect((screen.getByLabelText(/New note/) as HTMLTextAreaElement).value).toBe('');
  } finally {
    act(() => {
      resetSaveQueueForTests();
    });
    jest.useRealTimers();
  }
});

test('on the live floor, a staff note on an athlete marked here is kept too, with its key and the account that made it', async () => {
  // Kept-save harness of the describe above, reused through its route answers.
  window.localStorage.clear();
  window.sessionStorage.clear();
  createPersistentRoleSession('coach');
  resetSaveQueueForTests();
  jest.useFakeTimers();
  try {
    const writes: Array<Record<string, unknown>> = [];
    const answer = (body: unknown, status = 200) => {
      const response = { ok: status >= 200 && status < 300, status, json: async () => body, clone: () => response };
      return response as unknown as Response;
    };
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/pilot/auth/session')) return answer({ authenticated: true, account_id: 'acct-a' });
      if (url.startsWith('/api/pilot/coach/session-staff-notes')) {
        if ((init?.method ?? 'GET') === 'GET') return answer({ ok: true, note_max: 2000, notes: [] });
        writes.push(JSON.parse(String(init?.body)));
        throw new TypeError('Failed to fetch');
      }
      if (url === URL_FOR) return answer({ present: [{ ...ADA, marked_at: 'x' }], gym: [ADA, BEN, CY] });
      return answer({});
    }) as unknown as typeof fetch;
    prepareSaveQueue();
    await act(async () => {
      render(
        <>
          <SessionRunPresence runId="ssrun 1" />
          <SaveQueueNotice />
        </>,
      );
      await jest.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Staff notes on Ada Reyes' }));
      await jest.advanceTimersByTimeAsync(0);
    });
    fireEvent.change(screen.getByLabelText(/New note/), { target: { value: 'Wrist taped.' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(writes[0]).toEqual({ run_id: 'ssrun 1', athlete_id: 'ath-1', note: 'Wrist taped.', request_key: expect.any(String), made_by_account_id: 'acct-a' });
    const waiting = screen.getByText(WAITING_WORDS).closest('[role="status"]') as HTMLElement;
    expect(within(waiting).getByText('Staff note')).toBeTruthy();
  } finally {
    act(() => {
      resetSaveQueueForTests();
    });
    jest.useRealTimers();
  }
});

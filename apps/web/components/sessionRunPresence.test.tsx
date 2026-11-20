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
  const register = (attendance: unknown[]) => respond({ ok: true, role: 'coach', classes: [], registrations: [], coaching_requests: [], attendance });

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
    expect(screen.getByText(/^1 marked Present on the class register is not marked here yet\. Class register read at /)).toBeTruthy();
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

  test('an empty register says nobody is on it, and one fully marked here says so', async () => {
    serveTied([], () => register([]));
    await showTied();
    expect(screen.getByText(/^Nobody is marked Present on the class register yet\. Class register read at /)).toBeTruthy();
    document.body.innerHTML = '';

    serveTied([ADA], () => register([onRegister('ath-1', 'coach_override')]));
    await showTied();
    expect(screen.getByText(/^Everyone marked Present on the class register is marked here\. Class register read at /)).toBeTruthy();
  });

  test('a register mark for an athlete who is not on the gym list is counted, not named', async () => {
    serveTied([], () => register([onRegister('ath-1', 'self'), onRegister('ath-gone', 'parent')]));
    await showTied();
    expect(screen.getByText(
      /^1 marked Present on the class register is not marked here yet\. 1 more marked Present on the class register is not on this gym’s list of athletes, so no name is shown\. /,
    )).toBeTruthy();
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

/**
 * @jest-environment jsdom
 */

/*
 * Email alerts on Customize the Gym (lane W4-1, EM-6; OW27-10 A, OW27-39 A).
 * The route's own gate and body rules are
 * app/api/pilot/email-alerts/gym/route.test.ts; this pins what the drawer
 * shows from the route's answers, the exact PUT it sends, and that an unknown
 * or refused choice is never shown as a tick box.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';

import EmailAlertSettings from './EmailAlertSettings';

const BASE = 'https://backend.test';
const URL = `${BASE}/api/pilot/email-alerts/gym`;

const SIGNED_OUT = 'You are signed out. Sign in again to see or change these choices.';
const ADMIN_ONLY = 'Only the gym admin can see or change these choices.';
const COULD_NOT_READ = 'The email alert choices could not be read. Reload to try again.';

interface Event {
  readonly user_type: string;
  readonly event_kind: string;
  readonly ticked: unknown;
  readonly is_default: unknown;
}

const ev = (user_type: string, event_kind: string, ticked: boolean, is_default = ticked): Event =>
  ({ user_type, event_kind, ticked, is_default });

// The route's order (emailAlertGymEvents.ts: user types, then each list in order).
const EVENTS: readonly Event[] = [
  ev('staff', 'safety_escalation', true),
  ev('staff', 'parent_reply', false),
  ev('staff', 'guardian_message', true),
  ev('staff', 'gym_notice', true),
  ev('parent', 'family_note', true),
  ev('parent', 'gym_notice', false),
  ev('adult_athlete', 'coach_message', true),
  ev('adult_athlete', 'gym_notice', true),
];

/** The same list with one event changed. */
const withEvent = (changed: Event): Event[] =>
  EVENTS.map((event) => (event.user_type === changed.user_type && event.event_kind === changed.event_kind ? changed : event));

interface Reply {
  readonly status: number;
  /** Omitted: the body is not JSON (json() rejects). */
  readonly body?: unknown;
}

const loaded = (events: readonly Event[] = EVENTS): Reply => ({ status: 200, body: { ok: true, events } });

function reply(answer: Reply): Response {
  return {
    ok: answer.status >= 200 && answer.status < 300,
    status: answer.status,
    json: async () => {
      if (!('body' in answer)) throw new SyntaxError('Unexpected end of JSON input');
      return answer.body;
    },
  } as unknown as Response;
}

const originalFetch = global.fetch;
const originalBase = process.env.NEXT_PUBLIC_API_BASE;

type Answer = Reply | 'throw' | 'hold';
let release: (answer: Reply) => void = () => {};

function answerWith(answer: Answer): Promise<Response> {
  if (answer === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
  if (answer === 'hold') {
    return new Promise<Response>((resolve) => {
      release = (held) => resolve(reply(held));
    });
  }
  return Promise.resolve(reply(answer));
}

/** GETs are answered in order, the last one again after that. */
function respond(get: Answer | readonly Answer[], put: Answer = { status: 500 }) {
  const gets = Array.isArray(get) ? get : [get];
  let read = 0;
  global.fetch = jest.fn((_url: unknown, init?: RequestInit) => (
    init?.method === 'PUT' ? answerWith(put) : answerWith(gets[Math.min(read++, gets.length - 1)])
  )) as unknown as typeof fetch;
}

async function mount() {
  await act(async () => {
    render(<EmailAlertSettings />);
  });
}

const calls = () => (global.fetch as jest.Mock).mock.calls as [unknown, RequestInit | undefined][];
const putCalls = () => calls().filter(([, init]) => init?.method === 'PUT');
const getCalls = () => calls().filter(([, init]) => init?.method !== 'PUT');

const group = (name: string) => screen.getByRole('group', { name });
const box = (groupName: string, label: string) =>
  within(group(groupName)).getByRole('checkbox', { name: label }) as HTMLInputElement;
const escalation = () => box('Coaches and admins', 'A new safety escalation');
const statusLine = () => screen.getByRole('status');

async function press(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_BASE = BASE;
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.NEXT_PUBLIC_API_BASE;
  else process.env.NEXT_PUBLIC_API_BASE = originalBase;
});

describe('the read', () => {
  test('shows every event under its user type, each ticked as the gym chose, with its words', async () => {
    respond(loaded());
    await mount();

    expect(getCalls()).toEqual([[URL, { credentials: 'include', cache: 'no-store' }]]);
    const shown = ['Coaches and admins', 'Parents', 'Athletes 18 or over'].map((name) => [
      name,
      within(group(name)).getAllByRole('checkbox').map((input) => [
        (input.closest('label') as HTMLElement).textContent,
        (input as HTMLInputElement).checked,
        document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent,
      ]),
    ]);
    expect(shown).toEqual([
      ['Coaches and admins', [
        ['A new safety escalation', true, 'SHADOW safety alerts and pain-note alerts included.'],
        ['A guardian’s reply to a family note', false, 'A reply under a note a coach or admin posted to the family.'],
        ['A guardian’s new message to the coach', true,
          'Only to the child’s coach, a coach covering the child now and the gym’s admins, and not once they have seen it.'],
        ['A notice going live', true, 'On the Coach Workspace, Athlete Workspace, Parent Hub or Everywhere.'],
      ]],
      ['Parents', [
        ['A coach’s or admin’s note to the family', true, 'To each guardian linked to the child, while the child is under 18.'],
        ['A notice going live', false, 'On the Parent Hub or Everywhere.'],
      ]],
      ['Athletes 18 or over', [
        ['A coach’s or admin’s message to the athlete', true, 'Only to the athlete it is written to.'],
        ['A notice going live', true, 'On the Athlete Workspace or Everywhere.'],
      ]],
    ]);
    expect(within(group('Athletes 18 or over')).getByText(
      'Sent only to the address the athlete has confirmed. An athlete with no date of birth on record counts as under 18 and is sent nothing.',
    )).toBeTruthy();
    expect(screen.getAllByRole('checkbox')).toHaveLength(8);
    expect(statusLine().textContent).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('while the read is out, no box is shown', async () => {
    respond('hold');
    await mount();
    expect(screen.getByText('Reading the email alert choices…')).toBeTruthy();
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    await act(async () => {
      release(loaded());
    });
    expect(screen.getAllByRole('checkbox')).toHaveLength(8);
  });

  test.each([
    ['signed out (401)', { status: 401, body: { error: 'Unauthorized' } }, SIGNED_OUT],
    ['refused (403)', { status: 403, body: { error: 'Forbidden' } }, ADMIN_ONLY],
    ['a server error (500)', { status: 500, body: { error: 'boom' } }, COULD_NOT_READ],
    ['a 200 that is not JSON', { status: 200 }, COULD_NOT_READ],
    ['no ok: true', { status: 200, body: { events: EVENTS } }, COULD_NOT_READ],
    ['no events', { status: 200, body: { ok: true, events: [] } }, COULD_NOT_READ],
    ['an event off its user type’s list', loaded([...EVENTS, ev('staff', 'family_note', true)]), COULD_NOT_READ],
    ['an unknown user type', loaded([...EVENTS, ev('volunteer', 'gym_notice', true)]), COULD_NOT_READ],
    ['ticked not true or false', loaded(withEvent({ ...ev('parent', 'family_note', true), ticked: 'true' })), COULD_NOT_READ],
    ['ticked missing', loaded(withEvent({ ...ev('parent', 'family_note', true), ticked: undefined })), COULD_NOT_READ],
    ['is_default missing', loaded(withEvent({ ...ev('parent', 'family_note', true), is_default: undefined })), COULD_NOT_READ],
    ['one event twice', loaded([...EVENTS, ev('parent', 'family_note', false)]), COULD_NOT_READ],
  ] as const)('%s: one line with the ▲ glyph and no box', async (_name, answer, words) => {
    respond(answer);
    await mount();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(`▲ ${words}`);
    expect(alert.querySelector('[aria-hidden="true"]')?.textContent).toBe('▲ ');
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(putCalls()).toEqual([]);
  });

  test('no answer at all: one line and no box', async () => {
    respond('throw');
    await mount();
    expect(screen.getByRole('alert').textContent).toBe(`▲ ${COULD_NOT_READ}`);
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
  });
});

describe('a save', () => {
  test('a press sends exactly { user_type, event_kind, ticked } with the session, and shows the server’s answer', async () => {
    respond(loaded(), { status: 200, body: { ok: true, event: ev('staff', 'safety_escalation', false, false) } });
    await mount();

    await press(escalation());

    expect(putCalls()).toHaveLength(1);
    const [url, init] = putCalls()[0];
    expect(url).toBe(URL);
    expect(init).toEqual({
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_type: 'staff', event_kind: 'safety_escalation', ticked: false }),
    });
    expect(JSON.parse(String(init?.body))).toEqual({ user_type: 'staff', event_kind: 'safety_escalation', ticked: false });
    expect(escalation().checked).toBe(false);
    expect(statusLine().textContent).toBe('Saved: “A new safety escalation” is now unticked for coaches and admins.');
    // Confirmed by the answer: nothing is read again, and no other box moved.
    expect(getCalls()).toHaveLength(1);
    expect(box('Parents', 'A notice going live').checked).toBe(false);
    expect(box('Athletes 18 or over', 'A notice going live').checked).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('ticking an unticked box sends ticked: true for that user type’s event only', async () => {
    respond(loaded(), { status: 200, body: { ok: true, event: ev('parent', 'gym_notice', true, false) } });
    await mount();

    await press(box('Parents', 'A notice going live'));

    expect(JSON.parse(String(putCalls()[0][1]?.body))).toEqual({ user_type: 'parent', event_kind: 'gym_notice', ticked: true });
    expect(box('Parents', 'A notice going live').checked).toBe(true);
    expect(box('Coaches and admins', 'A notice going live').checked).toBe(true);
    expect(statusLine().textContent).toBe('Saved: “A notice going live” is now ticked for parents.');
  });

  test('the box does not move on the press; while saving every box is aria-disabled and a second press sends nothing', async () => {
    respond(loaded(), 'hold');
    await mount();

    await press(escalation());
    expect(escalation().checked).toBe(true);
    expect(statusLine().textContent).toBe('Saving…');
    expect(statusLine().closest('[aria-busy]')?.getAttribute('aria-busy')).toBe('true');
    for (const input of screen.getAllByRole('checkbox')) expect(input.getAttribute('aria-disabled')).toBe('true');

    await press(box('Parents', 'A notice going live'));
    expect(putCalls()).toHaveLength(1);
    expect(box('Parents', 'A notice going live').checked).toBe(false);

    await act(async () => {
      release({ status: 200, body: { ok: true, event: ev('staff', 'safety_escalation', false, false) } });
    });
    expect(escalation().checked).toBe(false);
    expect(statusLine().closest('[aria-busy]')?.getAttribute('aria-busy')).toBe('false');
    for (const input of screen.getAllByRole('checkbox')) expect(input.getAttribute('aria-disabled')).toBe('false');
  });

  test.each([
    ['signed out (401)', { status: 401, body: { error: 'Unauthorized' } }, `Not saved. ${SIGNED_OUT}`],
    ['refused (403)', { status: 403, body: { error: 'Forbidden' } }, `Not saved. ${ADMIN_ONLY}`],
  ] as const)('%s: every box goes, one line says so, and nothing is read again', async (_name, answer, words) => {
    respond(loaded(), answer);
    await mount();

    await press(escalation());

    expect(screen.getByRole('alert').textContent).toBe(`▲ ${words}`);
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(getCalls()).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole('alert'));
  });

  test.each([
    ['a server error (500)', { status: 500, body: { error: 'boom' } } as Answer],
    ['no answer', 'throw' as Answer],
    ['another refusal (400)', { status: 400, body: { error: 'Unsupported fields' } } as Answer],
    ['a 200 that is not JSON', { status: 200 } as Answer],
    ['a 200 for another event', { status: 200, body: { ok: true, event: ev('staff', 'gym_notice', false, false) } } as Answer],
    ['a 200 that does not say what was asked', { status: 200, body: { ok: true, event: ev('staff', 'safety_escalation', true, false) } } as Answer],
  ])('%s, and the box is not as asked when read again: "not saved", and the box shows the server', async (_name, answer) => {
    respond([loaded(), loaded()], answer);
    await mount();

    await press(escalation());

    expect(getCalls()).toHaveLength(2);
    expect(getCalls()[1]).toEqual([URL, { credentials: 'include', cache: 'no-store' }]);
    expect(escalation().checked).toBe(true);
    expect(screen.getByRole('alert').textContent)
      .toBe('▲ That change was not saved: “A new safety escalation” is still ticked for coaches and admins.');
    expect(statusLine().textContent).toBe('');
  });

  test('a 500, and the box is as asked when read again: no "not saved", the box and the other choices as read', async () => {
    respond(
      [loaded(), loaded(withEvent(ev('staff', 'safety_escalation', false, false)).map((event) => (
        event.user_type === 'parent' && event.event_kind === 'gym_notice' ? ev('parent', 'gym_notice', true) : event)))],
      { status: 500 },
    );
    await mount();

    await press(escalation());

    expect(escalation().checked).toBe(false);
    // Another admin's change, read again, is shown too.
    expect(box('Parents', 'A notice going live').checked).toBe(true);
    expect(statusLine().textContent)
      .toBe('“A new safety escalation” is now unticked for coaches and admins. The choices shown have been read again.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test.each([
    ['fails (500)', { status: 500 } as Answer, 'the choices could not be read again. Reload to see them.'],
    ['gets no answer', 'throw' as Answer, 'the choices could not be read again. Reload to see them.'],
    ['is not the route’s shape', { status: 200, body: { ok: true } } as Answer, 'the choices could not be read again. Reload to see them.'],
    ['is signed out (401)', { status: 401 } as Answer, 'you are signed out. Sign in again to see these choices.'],
    ['is refused (403)', { status: 403 } as Answer, 'only the gym admin can see these choices.'],
  ])('a failed save whose read again %s: the outcome is unknown, so no box at all, and focus goes to the line', async (_name, again, why) => {
    respond([loaded(), again], { status: 502 });
    await mount();

    await press(escalation());

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(`▲ It is not known whether that change was saved, and ${why}`);
    // Unknown is never drawn as an unticked (or ticked) box.
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(document.activeElement).toBe(alert);
  });

  test('a new press clears the last outcome before it is sent', async () => {
    respond([loaded(), loaded()], { status: 500 });
    await mount();
    await press(escalation());
    expect(screen.getByRole('alert')).toBeTruthy();

    global.fetch = jest.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    await press(escalation());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(statusLine().textContent).toBe('Saving…');
  });
});

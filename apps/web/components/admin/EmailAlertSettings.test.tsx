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
import { ANNOUNCEMENT_PLACEMENTS, PLACEMENT_LABELS } from '@/components/AnnouncementBanner';
import { NOTICE_PLACEMENTS_EMAILED } from '@/src/server/pilot/emailAlertEvents';

// emailAlertEvents.ts is read here only for its placement table; nothing reaches the database.
jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

const BASE = 'https://backend.test';
const URL = `${BASE}/api/pilot/email-alerts/gym`;

const SIGNED_OUT = 'You are signed out. Sign in again to see or change these choices.';
const ADMIN_ONLY = 'Only the gym admin can see or change these choices.';
const COULD_NOT_READ = 'The email alert choices could not be read. Reload to try again.';
const NOT_SHOWN_AS_SAVED =
  'That change does not show as saved: read again just now, “A new safety escalation” is still ticked for coaches and admins.';

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

const without = (userType: string, eventKind?: string): Event[] =>
  EVENTS.filter((event) => event.user_type !== userType || (eventKind !== undefined && event.event_kind !== eventKind));

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
const hintOf = (input: HTMLElement) => document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent ?? '';
/** The wrapper that goes aria-busy while saving: around the boxes only. */
const busyWrapper = () => group('Coaches and admins').closest('[aria-busy]') as HTMLElement;
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
        ['A new safety escalation', true,
          'SHADOW safety alerts and pain-note alerts included. To the gym’s admins; to a coach only about athletes they coach or cover now.'],
        ['A guardian’s reply to a family note', false,
          'A reply under a note a coach or admin posted to the family. To every coach and admin at the gym, not only the one who posted it.'],
        ['A guardian’s new message to the coach', true,
          'Only to the child’s coach, a coach covering the child now and the gym’s admins, and not once they have seen it.'],
        ['A notice going live', true, 'On the Coach Workspace, Athlete Workspace, Parent Hub or Everywhere.'],
      ]],
      ['Parents', [
        ['A coach’s or admin’s note to the family', true, 'To each guardian linked to the child, while the child is under 18.'],
        ['A notice going live', false, 'On the Parent Hub or Everywhere.'],
      ]],
      ['Athletes 18 or over', [
        ['A coach’s or admin’s message to the athlete', true,
          'Only to the athlete it is written to. A message to an athlete under 18 emails nobody, not even their guardians.'],
        ['A notice going live', true, 'On the Athlete Workspace or Everywhere.'],
      ]],
    ]);
    // The groups in the list's order, and the athletes' note is their group's description.
    expect(Array.from(document.querySelectorAll('fieldset > legend')).map((legend) => legend.textContent))
      .toEqual(['Coaches and admins', 'Parents', 'Athletes 18 or over']);
    const athletes = group('Athletes 18 or over');
    expect(document.getElementById(athletes.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Sent only to the address the athlete has confirmed. An athlete with no date of birth on record counts as under 18 and is sent nothing.',
    );
    expect(within(athletes).getByText(/^Sent only to the address/)).toBeTruthy();
    expect(group('Coaches and admins').hasAttribute('aria-describedby')).toBe(false);
    expect(group('Parents').hasAttribute('aria-describedby')).toBe(false);
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
    ['one event twice and another missing', loaded([...without('parent', 'gym_notice'), ev('parent', 'family_note', false)]), COULD_NOT_READ],
    ['one event missing', loaded(without('parent', 'gym_notice')), COULD_NOT_READ],
    ['a whole user type missing', loaded(without('adult_athlete')), COULD_NOT_READ],
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

  // The notice hints are tied to the sender's own table, not copied from it by hand.
  test('each "A notice going live" hint names exactly the placements the sender emails that user type', async () => {
    respond(loaded());
    await mount();
    const groups = { staff: 'Coaches and admins', parent: 'Parents', adult_athlete: 'Athletes 18 or over' } as const;
    for (const [userType, name] of Object.entries(groups) as [keyof typeof groups, string][]) {
      const hint = hintOf(box(name, 'A notice going live'));
      const named = ANNOUNCEMENT_PLACEMENTS.filter((placement) => hint.includes(PLACEMENT_LABELS[placement]));
      expect([userType, [...named].sort()]).toEqual([userType, [...NOTICE_PLACEMENTS_EMAILED[userType]].sort()]);
    }
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
    expect(busyWrapper().getAttribute('aria-busy')).toBe('true');
    // The live line is outside the busy subtree, so it is announced while saving.
    expect(statusLine().closest('[aria-busy]')).toBeNull();
    expect(busyWrapper().contains(statusLine())).toBe(false);
    for (const input of screen.getAllByRole('checkbox')) {
      expect(input.getAttribute('aria-disabled')).toBe('true');
      // Seen, not only announced: the box dimmed and the pointer says no.
      expect(input.classList.contains('opacity-60')).toBe(true);
      expect((input.closest('label') as HTMLElement).classList.contains('cursor-not-allowed')).toBe(true);
      expect((input.closest('label') as HTMLElement).classList.contains('cursor-pointer')).toBe(false);
    }

    await press(box('Parents', 'A notice going live'));
    expect(putCalls()).toHaveLength(1);
    expect(box('Parents', 'A notice going live').checked).toBe(false);

    await act(async () => {
      release({ status: 200, body: { ok: true, event: ev('staff', 'safety_escalation', false, false) } });
    });
    expect(escalation().checked).toBe(false);
    expect(busyWrapper().getAttribute('aria-busy')).toBe('false');
    for (const input of screen.getAllByRole('checkbox')) {
      expect(input.getAttribute('aria-disabled')).toBe('false');
      expect(input.classList.contains('opacity-60')).toBe(false);
      expect((input.closest('label') as HTMLElement).classList.contains('cursor-pointer')).toBe(true);
      expect((input.closest('label') as HTMLElement).classList.contains('cursor-not-allowed')).toBe(false);
    }
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
    ['a 500 whose body reads like a confirmation', { status: 500, body: { ok: true, event: ev('staff', 'safety_escalation', false, false) } } as Answer],
    ['a 200 without ok: true', { status: 200, body: { event: ev('staff', 'safety_escalation', false, false) } } as Answer],
  ])('%s, and the box is not as asked when read again: it does not show as saved, and the box shows the server', async (_name, answer) => {
    respond([loaded(), loaded()], answer);
    await mount();

    await press(escalation());

    expect(getCalls()).toHaveLength(2);
    expect(getCalls()[1]).toEqual([URL, { credentials: 'include', cache: 'no-store' }]);
    expect(escalation().checked).toBe(true);
    expect(screen.getByRole('alert').textContent).toBe(`▲ ${NOT_SHOWN_AS_SAVED}`);
    expect(statusLine().textContent).toBe('');
  });

  // K3: the read again is what is shown, other admins' changes included, beside the line.
  test('a 502 whose read again carries another change: that change is shown beside the line', async () => {
    respond([loaded(), loaded(withEvent(ev('parent', 'gym_notice', true)))], { status: 502 });
    await mount();
    expect(box('Parents', 'A notice going live').checked).toBe(false);

    await press(escalation());

    expect(escalation().checked).toBe(true);
    expect(box('Parents', 'A notice going live').checked).toBe(true);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(`▲ ${NOT_SHOWN_AS_SAVED}`);
    expect(alert.closest('[aria-busy]')).toBeNull();
  });

  // K2: a confirmed answer moves its own box only, not the same event under another user type.
  test('unticking the coaches’ notice moves that box only', async () => {
    respond(loaded(), { status: 200, body: { ok: true, event: ev('staff', 'gym_notice', false, false) } });
    await mount();

    await press(box('Coaches and admins', 'A notice going live'));

    expect(box('Coaches and admins', 'A notice going live').checked).toBe(false);
    expect(box('Parents', 'A notice going live').checked).toBe(false);
    expect(box('Athletes 18 or over', 'A notice going live').checked).toBe(true);
    expect(statusLine().textContent).toBe('Saved: “A notice going live” is now unticked for coaches and admins.');
  });

  // K4: focus is moved to the alert only when nothing else has it.
  test('focus that moved elsewhere during the save stays there when the alert replaces the boxes', async () => {
    respond([loaded(), { status: 500 }], 'hold');
    await act(async () => {
      render(<><button type="button">elsewhere</button><EmailAlertSettings /></>);
    });
    await press(escalation());
    const elsewhere = screen.getByRole('button', { name: 'elsewhere' });
    elsewhere.focus();

    await act(async () => {
      release({ status: 502 });
    });

    expect(screen.getByRole('alert').textContent)
      .toBe('▲ It is not known whether that change was saved, and the choices could not be read again. Reload to see them.');
    expect(screen.queryAllByRole('checkbox')).toEqual([]);
    expect(document.activeElement).toBe(elsewhere);
  });

  test('a 500, and the box is as asked when read again: no "does not show as saved" line, the box and the other choices as read', async () => {
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

describe('an unconfirmed save on a box other than the coaches’ escalation', () => {
  const parentsNotice = () => box('Parents', 'A notice going live');

  test('ticking the parents’ notice, a 500, and the read again still unticked (the coaches’ notice ticked): says still unticked for parents', async () => {
    respond([loaded(), loaded()], { status: 500 });
    await mount();
    await press(parentsNotice());
    expect(parentsNotice().checked).toBe(false);
    expect(screen.getByRole('alert').textContent).toBe(
      '▲ That change does not show as saved: read again just now, “A notice going live” is still unticked for parents.');
  });

  test('ticking the parents’ notice, a 500, and the read again ticked: says now ticked, with no alert', async () => {
    respond([loaded(), loaded(withEvent(ev('parent', 'gym_notice', true, false)))], { status: 500 });
    await mount();
    await press(parentsNotice());
    expect(parentsNotice().checked).toBe(true);
    expect(statusLine().textContent).toBe('“A notice going live” is now ticked for parents. The choices shown have been read again.');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

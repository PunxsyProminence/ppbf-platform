/**
 * @jest-environment jsdom
 */

// Lane U2 (audit UX-A A-4; Jason 2026-10-17, "A: Rename + I'm here on Today
// (Recommended)"): attendance is "I'm here" on the athlete's Today tab, and it
// sends exactly what /schedule's family check-in sends. The write path is
// unchanged.

import fs from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import AthleteImHere, { todaysClassesFor, todaysOpenClassesFor, useTodaySchedulerRead } from './AthleteImHere';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const NOW = Date.now();
const today = new Date(NOW).toISOString();
const klass = (overrides: Record<string, unknown> = {}) => ({
  class_id: 'cls_today', title: 'Youth Boxing', start_at: today, status: 'open', ...overrides,
});

interface Call { url: string; method: string; body: unknown }
function serve(
  read: Record<string, unknown> | 'fail',
  post: { status: number; body: Record<string, unknown> } = { status: 200, body: { ok: true, recorded: true } },
) {
  const calls: Call[] = [];
  let attendance: unknown[] = read === 'fail' ? [] : (read.attendance as unknown[]);
  let registrations: unknown[] = read === 'fail' ? [] : (read.registrations as unknown[]);
  let classes: Array<Record<string, unknown>> = read === 'fail' ? [] : (read.classes as Array<Record<string, unknown>>);
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(input), method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === 'POST') {
      const sent = JSON.parse(String(init?.body ?? '{}')) as { action: string; class_id: string };
      if (sent.action === 'register_class') {
        // As the route does: a registration row, and a waitlisted one means the class is full.
        if (post.status < 400) {
          const status = post.body.status === 'waitlisted' ? 'waitlisted' : 'registered';
          registrations = [...registrations, { class_id: sent.class_id, athlete_id: 'ath_1', status }];
          if (status === 'waitlisted') {
            classes = classes.map((row) => (row.class_id === sent.class_id ? { ...row, status: 'full' } : row));
          }
        }
      } else if (post.status < 400 && post.body.recorded !== false) {
        attendance = [...attendance, { class_id: sent.class_id, athlete_id: 'ath_1', status: 'present' }];
      }
      return { ok: post.status < 400, status: post.status, json: async () => post.body } as Response;
    }
    if (read === 'fail') return { ok: false, status: 500, json: async () => ({ error: 'down' }) } as Response;
    return { ok: true, status: 200, json: async () => ({ ...read, classes, registrations, attendance }) } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const REGISTERED = {
  ok: true,
  classes: [klass()],
  registrations: [{ class_id: 'cls_today', athlete_id: 'ath_1', status: 'registered' }],
  attendance: [],
};

/** The card as the workspace draws it: from the one read Today shares (F-127). */
function OnToday({ athleteId }: { readonly athleteId: string | null }) {
  const { read, reload } = useTodaySchedulerRead(athleteId !== null);
  return <AthleteImHere athleteId={athleteId} schedule={read} onReload={reload} />;
}

async function mount() {
  await act(async () => {
    render(<OnToday athleteId="ath_1" />);
  });
}

test("a class today the athlete is registered for offers I'm here, and pressing it sends what /schedule sends", async () => {
  const calls = serve(REGISTERED);
  await mount();
  expect(screen.getByText(/Youth Boxing/)).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: "I'm here" }));
  });
  const posts = calls.filter((call) => call.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0].url).toMatch(/\/api\/pilot\/scheduler$/);
  expect(posts[0].body).toEqual({ action: 'attendance_checkin', class_id: 'cls_today', athlete_id: 'ath_1', status: 'present' });
  expect(await screen.findByText('You are marked here. Your coach can see it.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: "I'm here" })).toBeNull();
});

test('two presses in one tick send one check-in', async () => {
  const calls = serve(REGISTERED);
  await mount();
  const button = screen.getByRole('button', { name: "I'm here" });
  await act(async () => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
});

test('already marked present: no button, says so', async () => {
  serve({ ...REGISTERED, attendance: [{ class_id: 'cls_today', athlete_id: 'ath_1', status: 'present' }] });
  await mount();
  expect(screen.getByText('You are marked here. Your coach can see it.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: "I'm here" })).toBeNull();
});

test("a refusal is shown in the server's words", async () => {
  serve(REGISTERED, { status: 400, body: { error: 'Check-in is open on the day of the class only.' } });
  await mount();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: "I'm here" }));
  });
  expect(screen.getByRole('alert').textContent).toBe('Check-in is open on the day of the class only.');
});

test("when the coach's register stood (recorded: false), it says so, as /schedule does", async () => {
  serve(
    { ...REGISTERED, attendance: [] },
    { status: 200, body: { ok: true, recorded: false } },
  );
  await mount();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: "I'm here" }));
  });
  expect(screen.getByRole('alert').textContent).toBe('Your coach has already taken the register for this class.');
});

test('a coach mark shows instead of the button', async () => {
  serve({ ...REGISTERED, attendance: [{ class_id: 'cls_today', athlete_id: 'ath_1', status: 'excused' }] });
  await mount();
  expect(screen.getByText('Your coach marked you excused for this class.')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});

test('a cancelled class today says so, rather than "no class"', async () => {
  serve({ ...REGISTERED, classes: [klass({ status: 'cancelled' })] });
  await mount();
  expect(screen.getByText('This class is cancelled.')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});

test('two classes today: each has its own button, and marking one leaves the other', async () => {
  const calls = serve({
    ...REGISTERED,
    classes: [klass(), klass({ class_id: 'cls_late', title: 'Evening Sparring', start_at: new Date(NOW + 1000).toISOString() })],
    registrations: [
      { class_id: 'cls_today', athlete_id: 'ath_1', status: 'registered' },
      { class_id: 'cls_late', athlete_id: 'ath_1', status: 'registered' },
    ],
  });
  await mount();
  expect(screen.getAllByRole('button', { name: "I'm here" })).toHaveLength(2);
  await act(async () => {
    fireEvent.click(screen.getAllByRole('button', { name: "I'm here" })[1]);
  });
  expect(calls.filter((call) => call.method === 'POST').map((call) => (call.body as { class_id: string }).class_id)).toEqual(['cls_late']);
  expect(screen.getAllByRole('button', { name: "I'm here" })).toHaveLength(1);
});

test('no open class today and none booked: no button, and the way to the schedule', async () => {
  serve({ ...REGISTERED, classes: [], registrations: [] });
  await mount();
  expect(screen.getByText(/No class for you today/)).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByRole('link', { name: 'Open the schedule' }).getAttribute('href')).toBe('/schedule');
});

/* Lane AS-8, scrub ATH-07 (Overwatch Q9 A on #2020): a walk-in registers from
   the card, with the POST an athlete already sends from /schedule. */
describe('a walk-in registers for an open class today', () => {
  // Seen, the button reads Register; its name also carries its class (review of #2077).
  const REGISTER = /^Register: /;
  const WALK_IN = { ...REGISTERED, registrations: [] };
  const registered = { status: 200, body: { ok: true, class_id: 'cls_today', athlete_id: 'ath_1', status: 'registered', membership_flags: [] } };
  const posts = (calls: Call[]) => calls.filter((call) => call.method === 'POST');
  const pressRegister = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: REGISTER }));
    });
  };

  test('the open class is listed with Register, no I\'m here yet, and the schedule link stays', async () => {
    serve(WALK_IN, registered);
    await mount();
    expect(screen.getByText(/No class for you today/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the schedule' }).getAttribute('href')).toBe('/schedule');
    expect(screen.getByText(/Youth Boxing/)).toBeTruthy();
    const button = screen.getByRole('button', { name: REGISTER });
    // The class's own line describes the button, so two Registers are told apart.
    expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(/^Youth Boxing/);
    expect(screen.queryByRole('button', { name: "I'm here" })).toBeNull();
  });

  test('Register sends exactly what /schedule sends, once, and the class then offers I\'m here', async () => {
    const calls = serve(WALK_IN, registered);
    await mount();
    await act(async () => {
      const button = screen.getByRole('button', { name: REGISTER });
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0].url).toMatch(/\/api\/pilot\/scheduler$/);
    expect(posts(calls)[0].body).toEqual({ action: 'register_class', class_id: 'cls_today', athlete_id: 'ath_1' });
    expect(await screen.findByRole('button', { name: "I'm here" })).toBeTruthy();
    expect(screen.queryByRole('button', { name: REGISTER })).toBeNull();
    expect(screen.queryByText(/No class for you today/)).toBeNull();
    // Registering is not attendance: nothing marked the athlete here.
    expect(screen.queryByText('You are marked here. Your coach can see it.')).toBeNull();
  });

  test('a training-hold refusal is said in the schedule page\'s words, and nothing is registered', async () => {
    const calls = serve(WALK_IN, {
      status: 403,
      body: {
        error: 'Training hold: registration is paused for this athlete',
        athlete_explanation: 'Rest the shoulder this week.',
        lift_condition: 'When your coach has watched you shadowbox.',
      },
    });
    await mount();
    const readsBefore = calls.filter((call) => call.method === 'GET').length;
    await pressRegister();
    // A refusal does not reload the card, as on /schedule: the answer stands
    // over the read it was given against.
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(readsBefore);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(
      'Training hold: registration is paused for this athlete'
      + 'Why: Rest the shoulder this week.'
      + 'To lift it: When your coach has watched you shadowbox.',
    );
    // Not the medical-stop mark, and no new warning dress: plain lines on the card.
    expect(alert.querySelector('.alert--critical, .escalation--locked, [class*="locked"]')).toBeNull();
    expect(posts(calls)).toHaveLength(1);
    expect(screen.getByRole('button', { name: REGISTER })).toBeTruthy();
    expect(screen.queryByRole('button', { name: "I'm here" })).toBeNull();
  });

  test('a hold with no lift condition written says so, as /schedule does', async () => {
    serve(WALK_IN, {
      status: 403,
      body: { error: 'Training hold: registration is paused for this athlete', athlete_explanation: 'Rest.', lift_condition: '' },
    });
    await mount();
    await pressRegister();
    expect(screen.getByRole('alert').textContent).toContain('To lift it: not written down — ask whoever placed the hold.');
  });

  test('another refusal is shown in the server\'s words, with no hold lines', async () => {
    serve(WALK_IN, { status: 409, body: { error: 'This class was cancelled.' } });
    await mount();
    await pressRegister();
    expect(screen.getByRole('alert').textContent).toBe('This class was cancelled.');
  });

  test('a request that does not answer says it did not go through, and claims nothing', async () => {
    serve(WALK_IN, { status: 502, body: {} });
    await mount();
    await pressRegister();
    expect(screen.getByRole('alert').textContent).toBe('That did not go through. Check the schedule before trying again.');
    expect(screen.queryByRole('button', { name: "I'm here" })).toBeNull();
  });

  test('a class that filled since the read: the waitlist is said, and no I\'m here is offered', async () => {
    serve(WALK_IN, { status: 200, body: { ok: true, status: 'waitlisted', membership_flags: [] } });
    await mount();
    await pressRegister();
    expect((await screen.findByRole('status')).textContent).toBe('The class is full, so this athlete was added to the waitlist.');
    expect(screen.queryByRole('button', { name: "I'm here" })).toBeNull();
    expect(screen.queryByRole('button', { name: REGISTER })).toBeNull();
  });

  test('the membership note is not shown on the card (no new warning on the opening screen)', async () => {
    serve(WALK_IN, {
      status: 200,
      body: { ok: true, status: 'registered', membership_flags: [{ membership_id: 'm1', program_name: 'Youth Program', status: 'lapsed' }] },
    });
    const { container } = render(<OnToday athleteId="ath_1" />);
    await act(async () => { await Promise.resolve(); });
    await pressRegister();
    expect(await screen.findByRole('button', { name: "I'm here" })).toBeTruthy();
    expect(container.textContent).not.toMatch(/membership|Youth Program|lapsed|NOT blocked/i);
  });

  test('two Registers are named for their classes, and still read Register', async () => {
    serve({ ...WALK_IN, classes: [klass(), klass({ class_id: 'cls_late', title: 'Evening Sparring', start_at: new Date(NOW + 1000).toISOString() })] }, registered);
    await mount();
    const buttons = screen.getAllByRole('button', { name: REGISTER });
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['Register: Youth Boxing', 'Register: Evening Sparring']);
    expect(buttons.map((button) => button.textContent)).toEqual(['Register', 'Register']);
  });

  test('a class that ended after the card read is not sent: the card reads again and drops it', async () => {
    const calls = serve({ ...WALK_IN, classes: [klass({ end_at: new Date(NOW + 60_000).toISOString() })] }, registered);
    await mount();
    expect(screen.getByRole('button', { name: REGISTER })).toBeTruthy();
    const readsBefore = calls.filter((call) => call.method === 'GET').length;
    // The tab stayed open past the class's end.
    const clock = jest.spyOn(Date, 'now').mockReturnValue(NOW + 120_000);
    try {
      await pressRegister();
      expect(posts(calls)).toHaveLength(0);
      expect(calls.filter((call) => call.method === 'GET').length).toBe(readsBefore + 1);
      expect(screen.queryByRole('button', { name: REGISTER })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  test('a 200 that says ok: false is a refusal, never a registration', async () => {
    const calls = serve(WALK_IN, { status: 200, body: { ok: false, error: 'Not this time.' } });
    await mount();
    const readsBefore = calls.filter((call) => call.method === 'GET').length;
    await pressRegister();
    expect(screen.getByRole('alert').textContent).toBe('Not this time.');
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(readsBefore);
    expect(screen.queryByRole('button', { name: "I'm here" })).toBeNull();
  });

  test('while one press is in flight, every Register on the card is held', async () => {
    serve({ ...WALK_IN, classes: [klass(), klass({ class_id: 'cls_late', title: 'Evening Sparring', start_at: new Date(NOW + 1000).toISOString() })] }, registered);
    const answered = global.fetch as jest.Mock;
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) =>
      (init?.method === 'POST' ? new Promise<Response>(() => {}) : answered(input, init))) as unknown as typeof fetch;
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Register: Youth Boxing' }));
    });
    expect((screen.getByRole('button', { name: /^Sending…: Youth Boxing/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Register: Evening Sparring' }) as HTMLButtonElement).disabled).toBe(true);
  });

  test('booked for one class and not another: I\'m here for the first, Register for the second', async () => {
    serve({
      ...REGISTERED,
      classes: [klass(), klass({ class_id: 'cls_late', title: 'Evening Sparring', start_at: new Date(NOW + 1000).toISOString() })],
    }, registered);
    await mount();
    expect(screen.getAllByRole('button', { name: "I'm here" })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: REGISTER })).toHaveLength(1);
    expect(screen.queryByText(/No class for you today/)).toBeNull();
  });
});

describe('todaysOpenClassesFor', () => {
  const none: never[] = [];
  const ids = (rows: Array<{ class_id: string }>) => rows.map((row) => row.class_id);
  test('today, open, not ended, and not one the athlete is already on', () => {
    expect(ids(todaysOpenClassesFor('ath_1', [klass({ class_id: 'a' }) as never], none, NOW))).toEqual(['a']);
    expect(todaysOpenClassesFor('ath_1', [klass({ class_id: 'a', status: 'full' }) as never], none, NOW)).toEqual([]);
    expect(todaysOpenClassesFor('ath_1', [klass({ class_id: 'a', status: 'cancelled' }) as never], none, NOW)).toEqual([]);
    expect(todaysOpenClassesFor('ath_1', [klass({ class_id: 'a', start_at: '2099-01-03T15:00:00.000Z' }) as never], none, NOW)).toEqual([]);
    expect(todaysOpenClassesFor('ath_1', [klass({ class_id: 'a', end_at: new Date(NOW - 1000).toISOString() }) as never], none, NOW)).toEqual([]);
    expect(ids(todaysOpenClassesFor('ath_1', [klass({ class_id: 'a', end_at: new Date(NOW + 1000).toISOString() }) as never], none, NOW))).toEqual(['a']);
  });
  test('registered or waitlisted is on the class; a cancelled registration, or another athlete\'s, is not', () => {
    const reg = (status: string, athlete = 'ath_1') => [{ registration_id: 'r', class_id: 'a', athlete_id: athlete, status }] as never;
    const classes = [klass({ class_id: 'a' }) as never];
    expect(todaysOpenClassesFor('ath_1', classes, reg('registered'), NOW)).toEqual([]);
    expect(todaysOpenClassesFor('ath_1', classes, reg('waitlisted'), NOW)).toEqual([]);
    expect(ids(todaysOpenClassesFor('ath_1', classes, reg('cancelled'), NOW))).toEqual(['a']);
    expect(ids(todaysOpenClassesFor('ath_1', classes, reg('registered', 'ath_2'), NOW))).toEqual(['a']);
  });
  test('an unreadable clock is not today', () => {
    expect(todaysOpenClassesFor('ath_1', [klass({ class_id: 'a' }) as never], none, Number.NaN)).toEqual([]);
  });
});

test('a reply without attendance cannot say whether the athlete is marked: it says it could not read', async () => {
  serve({ ...REGISTERED, attendance: undefined });
  await mount();
  expect(screen.getByText(/could not be read/)).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});

test('a failed read says so, never "no class"', async () => {
  serve('fail');
  await mount();
  expect(screen.getByText(/could not be read/)).toBeTruthy();
  expect(screen.queryByText(/No class for you today/)).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

test('nothing renders without an athlete identity', async () => {
  const calls = serve(REGISTERED);
  let container: HTMLElement | undefined;
  await act(async () => {
    ({ container } = render(<OnToday athleteId={null} />));
  });
  expect(container!.innerHTML).toBe('');
  expect(calls).toHaveLength(0);
});

describe('todaysClassesFor', () => {
  const reg = [{ registration_id: 'reg_a', class_id: 'a', athlete_id: 'ath_1', status: 'registered' as const }];
  test('today only, registered only; a cancelled class is kept so the card can say so', () => {
    expect(todaysClassesFor('ath_1', [klass({ class_id: 'a', start_at: '2099-01-03T15:00:00.000Z' }) as never], reg, NOW)).toEqual([]);
    expect(todaysClassesFor('ath_1', [klass({ class_id: 'a' }) as never], [{ ...reg[0], status: 'waitlisted' as never }], NOW)).toEqual([]);
    expect(todaysClassesFor('ath_1', [klass({ class_id: 'a', status: 'cancelled' }) as never], reg, NOW).map((c) => c.class_id)).toEqual(['a']);
    expect(todaysClassesFor('ath_2', [klass({ class_id: 'a' }) as never], reg, NOW)).toEqual([]);
  });
  test('an unreadable clock is not today', () => {
    expect(todaysClassesFor('ath_1', [klass({ class_id: 'a', start_at: 'not a date' }) as never], reg, Number.NaN)).toEqual([]);
  });
});

describe('where it sits and what it is called', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
  test('on every Today tab of the athlete workspace', () => {
    expect(read('components/AthleteWorkspace.tsx')).toContain(
      '<AthleteImHere athleteId={backendAthleteId} schedule={todaySchedule.read} onReload={reloadTodaySchedule} />',
    );
    expect(read('components/AthleteWorkspace.tsx')).toMatch(/\{activeGroup === 'today' && \(\s*<AthleteImHere /);
  });
  test('the same write /schedule makes for a family', () => {
    expect(read('app/schedule/page.tsx')).toContain(
      "{ action: 'attendance_checkin', class_id: selectedClassId, athlete_id: targetAthlete, status: 'present' }",
    );
  });
  test('Register is the write, the label and the answers /schedule has (lane AS-8, Q9 A)', () => {
    const page = read('app/schedule/page.tsx');
    const card = read('components/AthleteImHere.tsx');
    expect(page).toContain("{ action: 'register_class', class_id: item.class_id, athlete_id: targetAthlete }");
    expect(card).toContain("{ action: 'register_class', class_id: classId, athlete_id: athleteId }");
    for (const words of [
      "'Register'",
      'That did not go through. Check the schedule before trying again.',
      'The class is full, so this athlete was added to the waitlist.',
      'not written down — ask whoever placed the hold.',
      'Why: {',
      'To lift it: {',
    ]) {
      expect(page).toContain(words);
      expect(card).toContain(words);
    }
  });
  test('the three things are named three ways (ruled words)', () => {
    expect(read('components/AthleteCheckInPanel.tsx')).toContain('How I feel today');
    expect(read('components/AthleteCorner.tsx')).toContain("'Start training'");
    expect(read('components/AthleteImHere.tsx')).toContain('"I\'m here"');
    const athleteScreens = ['components/AthleteCheckInPanel.tsx', 'components/AthleteCorner.tsx'].map(read).join('\n');
    expect(athleteScreens).not.toMatch(/>\s*Check in\s*</);
    expect(athleteScreens).not.toMatch(/'Start check-in'/);
  });
});

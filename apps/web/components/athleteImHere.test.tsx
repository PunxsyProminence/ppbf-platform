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

import AthleteImHere, { todaysClassesFor, useTodaySchedulerRead } from './AthleteImHere';

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
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(input), method, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === 'POST') {
      const sent = JSON.parse(String(init?.body ?? '{}')) as { class_id: string };
      if (post.status < 400 && post.body.recorded !== false) {
        attendance = [...attendance, { class_id: sent.class_id, athlete_id: 'ath_1', status: 'present' }];
      }
      return { ok: post.status < 400, status: post.status, json: async () => post.body } as Response;
    }
    if (read === 'fail') return { ok: false, status: 500, json: async () => ({ error: 'down' }) } as Response;
    return { ok: true, status: 200, json: async () => ({ ...read, attendance }) } as Response;
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

test('not registered for a class today: no button, and the way to the schedule', async () => {
  serve({ ...REGISTERED, registrations: [] });
  await mount();
  expect(screen.getByText(/No class for you today/)).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByRole('link', { name: 'Open the schedule' }).getAttribute('href')).toBe('/schedule');
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
  test('the three things are named three ways (ruled words)', () => {
    expect(read('components/AthleteCheckInPanel.tsx')).toContain('How I feel today');
    expect(read('components/AthleteCorner.tsx')).toContain("'Start training'");
    expect(read('components/AthleteImHere.tsx')).toContain('"I\'m here"');
    const athleteScreens = ['components/AthleteCheckInPanel.tsx', 'components/AthleteCorner.tsx'].map(read).join('\n');
    expect(athleteScreens).not.toMatch(/>\s*Check in\s*</);
    expect(athleteScreens).not.toMatch(/'Start check-in'/);
  });
});

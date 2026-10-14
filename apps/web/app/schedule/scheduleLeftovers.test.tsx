/**
 * @jest-environment jsdom
 */

// Schedule leftovers from the live coach audit (#1596): the attendance picker
// offers no cancelled class; a class row names its coach, never the login
// (OD-2026-10-06-025 "Show coach name, hide ID"); Register names the athlete
// it registers; a family with no class today reads one sentence instead of
// pickers with no button.
//
// Pinned on the rendered DOM (jsdom). How it reads on a tablet or a phone has
// not been checked (NOT VERIFIED).

import '@testing-library/jest-dom';

import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { readonly href: string; readonly children: ReactNode }) => <a href={href}>{children}</a>,
}));

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import SchedulerPage from './page';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// Noon in the gym, so "an hour from now" is always today's gym day.
const GYM_NOON = Date.parse('2026-10-14T16:00:00.000Z');
const at = (offsetMs: number) => new Date(GYM_NOON + offsetMs).toISOString();

function classRow(id: string, title: string, startOffsetMs: number, over: Record<string, unknown> = {}) {
  return {
    class_id: id,
    title,
    start_at: at(startOffsetMs),
    end_at: at(startOffsetMs + HOUR),
    location: 'Main Floor',
    capacity: 16,
    coach_account_id: 'jason.neale@gym.example',
    status: 'open',
    registered_count: 0,
    ...over,
  };
}

type Role = 'athlete' | 'parent' | 'coach';

function install(role: Role, classes: ReturnType<typeof classRow>[]): jest.Mock {
  const fetchMock = jest.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const json = (payload: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
    if (url.endsWith('/api/pilot/auth/session')) {
      return json({ authenticated: true, role, athlete_id: role === 'athlete' ? 'athlete-1' : null });
    }
    if (url.endsWith('/api/pilot/athletes/list')) {
      return json({ items: [{ athlete_id: 'athlete-1', full_name: 'Jordan Price' }, { athlete_id: 'athlete-2', full_name: 'Casey Ruiz' }] });
    }
    if (url.endsWith('/api/pilot/scheduler')) {
      return json({ ok: true, role, classes, registrations: [], coaching_requests: [], attendance: [] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderPage() {
  await act(async () => {
    render(<SchedulerPage />);
  });
  await screen.findByText('Class Schedule');
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(GYM_NOON);
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('the attendance picker offers no cancelled class, for staff or a family', async () => {
  for (const role of ['coach', 'athlete'] as const) {
    install(role, [
      classRow('gone', 'Called Off', HOUR, { status: 'cancelled' }),
      classRow('on', 'Still On', HOUR),
    ]);
    const view = await (async () => {
      let rendered!: ReturnType<typeof render>;
      await act(async () => {
        rendered = render(<SchedulerPage />);
      });
      await screen.findByText('Class Schedule');
      return rendered;
    })();
    const picker = screen.getByLabelText('Class') as HTMLSelectElement;
    const labels = Array.from(picker.options).map((option) => option.textContent ?? '');
    expect(labels.some((label) => label.includes('Called Off'))).toBe(false);
    expect(labels.some((label) => label.includes('(cancelled)'))).toBe(false);
    expect(labels.some((label) => label.includes('Still On'))).toBe(true);
    view.unmount();
  }
});

test('a picker whose only class is cancelled shows nothing chosen, not a class it is not', async () => {
  install('coach', [classRow('gone', 'Called Off', HOUR, { status: 'cancelled' })]);
  await renderPage();
  const picker = screen.getByLabelText('Class') as HTMLSelectElement;
  expect(picker.value).toBe('');
  expect(Array.from(picker.options).map((option) => option.textContent)).toEqual(['Choose a class']);
});

test("a coach reads the class's coach by name, never the login", async () => {
  install('coach', [classRow('on', 'Still On', DAY, { covering_coach_account_id: 'sam_ruiz2@gym.example' })]);
  await renderPage();
  expect(screen.getByText(/Coach: Coach Jason Neale \| Cover: Coach Sam Ruiz$/)).toBeInTheDocument();
  expect(screen.queryByText(/@gym\.example/)).toBeNull();
});

test('Register names the athlete a coach is registering', async () => {
  install('coach', [classRow('on', 'Still On', DAY)]);
  await renderPage();
  expect(screen.getByRole('button', { name: 'Register Jordan Price' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Register' })).toBeNull();
});

test('an athlete registering themselves still reads plain Register', async () => {
  install('athlete', [classRow('on', 'Still On', DAY)]);
  await renderPage();
  expect(screen.getByRole('button', { name: 'Register' })).toBeInTheDocument();
});

test('a family with no class today reads one sentence instead of pickers with no button', async () => {
  for (const role of ['athlete', 'parent'] as const) {
    install(role, [classRow('next', 'Next Week', 7 * DAY), classRow('gone', 'Today Off', HOUR, { status: 'cancelled' })]);
    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(<SchedulerPage />);
    });
    await screen.findByText('Class Schedule');
    expect(screen.getByText('There is no class today to check in to.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Class')).toBeNull();
    expect(screen.queryByLabelText('Athlete to mark')).toBeNull();
    expect(screen.queryByRole('button', { name: "I'm here" })).toBeNull();
    view.unmount();
  }
});

test('a family with a class today keeps the picker, and staff never see the no-class sentence', async () => {
  install('athlete', [classRow('today', 'Tonight', HOUR)]);
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<SchedulerPage />);
  });
  await screen.findByText('Class Schedule');
  expect(screen.getByLabelText('Class')).toBeInTheDocument();
  expect(screen.queryByText('There is no class today to check in to.')).toBeNull();
  view.unmount();

  install('coach', [classRow('next', 'Next Week', 7 * DAY)]);
  await renderPage();
  expect(screen.queryByText('There is no class today to check in to.')).toBeNull();
  expect(screen.getByLabelText('Class')).toBeInTheDocument();
});

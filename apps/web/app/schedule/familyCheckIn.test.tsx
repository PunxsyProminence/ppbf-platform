/**
 * @jest-environment jsdom
 */

// Family check-in on /schedule (Jason 2026-10-12, issue #1524: "Self check-in,
// same day only"). An athlete or parent sees one control, "I'm here", only on
// the selected class's gym day and only for an athlete registered to it; there
// is no Absent or Excused for them. When a coach has already taken the
// register, the page says so rather than claiming a check-in. Register is not
// offered for a class that has ended or one the athlete is already on.
//
// Pinned on the rendered DOM (jsdom). How it looks on a phone has not been
// checked; that needs a signed-in view on staging.

import '@testing-library/jest-dom';

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

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
const nowIso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function classRow(id: string, title: string, startOffsetMs: number) {
  return {
    class_id: id,
    title,
    start_at: nowIso(startOffsetMs),
    end_at: nowIso(startOffsetMs + HOUR),
    location: 'Main Floor',
    capacity: 16,
    coach_account_id: 'account-coach',
    status: 'open',
    registered_count: 1,
  };
}

function registration(classId: string, athleteId: string, status = 'registered') {
  return {
    registration_id: `reg-${classId}-${athleteId}`,
    class_id: classId,
    athlete_id: athleteId,
    requested_by_role: 'parent',
    parent_reviewed: true,
    status,
    created_at: '2026-08-01T00:00:00.000Z',
  };
}

type Setup = {
  role: 'athlete' | 'parent' | 'coach';
  classes: ReturnType<typeof classRow>[];
  registrations: ReturnType<typeof registration>[];
  recorded?: boolean;
};

function installFetchMock(setup: Setup): jest.Mock {
  const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (payload: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);

    if (url.endsWith('/api/pilot/auth/session')) {
      return json({ authenticated: true, role: setup.role, athlete_id: setup.role === 'athlete' ? 'athlete-1' : null });
    }
    if (url.endsWith('/api/pilot/athletes/list')) {
      return json({ items: [{ athlete_id: 'athlete-1', full_name: 'My Athlete' }] });
    }
    if (url.endsWith('/api/pilot/scheduler') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { athlete_id?: string };
      return json({
        ok: true,
        class_id: 'class-today',
        athlete_id: body.athlete_id,
        method: setup.role === 'athlete' ? 'self' : 'parent',
        recorded: setup.recorded ?? true,
      });
    }
    if (url.endsWith('/api/pilot/scheduler')) {
      return json({
        ok: true,
        role: setup.role,
        classes: setup.classes,
        registrations: setup.registrations,
        coaching_requests: [],
        attendance: [],
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function posts(fetchMock: jest.Mock): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith('/api/pilot/scheduler') && (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

async function renderPage() {
  render(<SchedulerPage />);
  await screen.findByText('Class Schedule');
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('family check-in on /schedule (#1524)', () => {
  test.each(['athlete', 'parent'] as const)(
    'a %s on the class day sees only "I\'m here", and it sends Present',
    async (role) => {
      const fetchMock = installFetchMock({
        role,
        classes: [classRow('class-today', 'Tonight', 0)],
        registrations: [registration('class-today', 'athlete-1')],
      });
      await renderPage();

      const button = await screen.findByRole('button', { name: "I'm here" });
      expect(screen.queryByRole('option', { name: 'Absent' })).toBeNull();
      expect(screen.queryByRole('option', { name: 'Excused' })).toBeNull();
      expect(screen.queryByPlaceholderText('Attendance notes')).toBeNull();

      await act(async () => {
        fireEvent.click(button);
      });

      expect(posts(fetchMock)).toEqual([
        { action: 'attendance_checkin', class_id: 'class-today', athlete_id: 'athlete-1', status: 'present' },
      ]);
      expect(await screen.findByText('Checked in. Your coach can see you are here.')).toBeInTheDocument();
    },
  );

  test("a family's picker opens on today's class, not the first one listed", async () => {
    installFetchMock({
      role: 'athlete',
      classes: [classRow('class-next', 'Next week', 7 * 24 * HOUR), classRow('class-today', 'Tonight', 0)],
      registrations: [registration('class-today', 'athlete-1')],
    });
    await renderPage();

    expect(await screen.findByRole('button', { name: "I'm here" })).toBeInTheDocument();
  });

  test("with two classes today, an athlete's picker opens on the one they are registered for, never a cancelled one", async () => {
    installFetchMock({
      role: 'athlete',
      classes: [
        { ...classRow('class-cancelled', 'Cancelled', -HOUR), status: 'cancelled' },
        classRow('class-other', 'Not mine', 0),
        classRow('class-mine', 'Mine', HOUR),
      ],
      registrations: [registration('class-mine', 'athlete-1')],
    });
    await renderPage();

    expect(await screen.findByRole('button', { name: "I'm here" })).toBeInTheDocument();
  });

  test('a class on another day offers nothing to press', async () => {
    installFetchMock({
      role: 'athlete',
      classes: [classRow('class-old', 'Last week', -7 * 24 * HOUR)],
      registrations: [registration('class-old', 'athlete-1')],
    });
    await renderPage();

    expect(screen.queryByRole('button', { name: "I'm here" })).toBeNull();
    expect(screen.queryByRole('button', { name: /check in/i })).toBeNull();
  });

  test('a class the athlete is not registered for offers nothing to press', async () => {
    installFetchMock({ role: 'athlete', classes: [classRow('class-today', 'Tonight', 0)], registrations: [] });
    await renderPage();

    expect(screen.queryByRole('button', { name: "I'm here" })).toBeNull();
  });

  test('when the coach has already taken the register, the page says so instead of claiming a check-in', async () => {
    installFetchMock({
      role: 'athlete',
      classes: [classRow('class-today', 'Tonight', 0)],
      registrations: [registration('class-today', 'athlete-1')],
      recorded: false,
    });
    await renderPage();

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: "I'm here" }));
    });

    expect(await screen.findByText('Your coach has already taken the register for this class.')).toBeInTheDocument();
    expect(screen.queryByText('Checked in. Your coach can see you are here.')).toBeNull();
  });

  test('a coach still has Present, Absent, Excused and a note', async () => {
    installFetchMock({
      role: 'coach',
      classes: [classRow('class-old', 'Last week', -7 * 24 * HOUR)],
      registrations: [registration('class-old', 'athlete-1')],
    });
    await renderPage();

    expect(await screen.findByRole('option', { name: 'Absent' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Excused' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Attendance notes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update Attendance' })).toBeInTheDocument();
  });
});

describe('Register on /schedule (#1524)', () => {
  test('is not offered for a class that has ended, or one the athlete is already on', async () => {
    installFetchMock({
      role: 'athlete',
      classes: [
        classRow('class-ended', 'Ended', -3 * HOUR),
        classRow('class-on', 'Already on it', 24 * HOUR),
        classRow('class-waitlisted', 'Waitlisted', 48 * HOUR),
        classRow('class-open', 'Open next week', 7 * 24 * HOUR),
      ],
      registrations: [registration('class-on', 'athlete-1'), registration('class-waitlisted', 'athlete-1', 'waitlisted')],
    });
    await renderPage();

    await screen.findByText('Open next week');
    expect(screen.getAllByRole('button', { name: 'Register' })).toHaveLength(1);
  });
});

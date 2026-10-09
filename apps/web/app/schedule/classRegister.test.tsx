/**
 * @jest-environment jsdom
 */

// OD-2026-10-07-008 ruling 4, "Whole class plus walk-ins": the coach running a
// class takes its register. The screen half: the athlete picker says who is
// registered to the selected class and who would be a walk-in (present only),
// a walk-in mark is confirmed as one from the route's `method`, and the
// attendance list says "walk-in" instead of printing the raw method value.
//
// Pinned on the rendered DOM (jsdom). How it looks on a gym tablet has not been
// checked; that needs a signed-in view on staging.

import '@testing-library/jest-dom';

import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { readonly href: string; readonly children: ReactNode }) => <a href={href}>{children}</a>,
}));

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import SchedulerPage from './page';

const classes = [
  {
    class_id: 'class-1',
    title: 'Morning Fundamentals',
    start_at: '2026-08-03T13:00:00.000Z',
    end_at: '2026-08-03T14:00:00.000Z',
    location: 'Main Floor',
    capacity: 16,
    coach_account_id: 'account-coach',
    status: 'open',
    registered_count: 1,
  },
];

const athletes = [
  { athlete_id: 'athlete-1', full_name: 'Registered Athlete' },
  { athlete_id: 'athlete-2', full_name: 'Walk In Athlete' },
];

const registrations = [
  {
    registration_id: 'reg-1',
    class_id: 'class-1',
    athlete_id: 'athlete-1',
    requested_by_role: 'parent',
    parent_reviewed: true,
    status: 'registered',
    created_at: '2026-08-01T00:00:00.000Z',
  },
];

function jsonResponse(payload: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response);
}

function installFetchMock(options: { attendance?: unknown[]; checkInMethod?: string } = {}): jest.Mock {
  const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.endsWith('/api/pilot/auth/session')) {
      return jsonResponse({ authenticated: true, role: 'coach', athlete_id: null });
    }
    if (url.endsWith('/api/pilot/athletes/list')) {
      return jsonResponse({ items: athletes });
    }
    if (url.endsWith('/api/pilot/scheduler') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { action?: string; athlete_id?: string };
      if (body.action === 'attendance_checkin') {
        return jsonResponse({ ok: true, class_id: 'class-1', athlete_id: body.athlete_id, method: options.checkInMethod });
      }
      throw new Error(`Unexpected POST action: ${body.action}`);
    }
    if (url.endsWith('/api/pilot/scheduler')) {
      return jsonResponse({
        ok: true,
        role: 'coach',
        classes,
        registrations,
        coaching_requests: [],
        attendance: options.attendance ?? [],
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderPage(): Promise<HTMLSelectElement> {
  render(<SchedulerPage />);
  await screen.findByText('Class Schedule');
  return (await screen.findByRole('combobox', { name: 'Athlete to mark' })) as HTMLSelectElement;
}

describe('the class register on /schedule', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('the picker separates athletes registered to the class from walk-ins', async () => {
    installFetchMock();
    const picker = await renderPage();

    const registeredGroup = picker.querySelector('optgroup[label="Registered for this class"]') as HTMLElement;
    const walkInGroup = picker.querySelector('optgroup[label="Walk-in (marks present only)"]') as HTMLElement;
    expect(registeredGroup).not.toBeNull();
    expect(walkInGroup).not.toBeNull();
    expect(within(registeredGroup).getByRole('option', { name: 'Registered Athlete' })).toBeInTheDocument();
    expect(within(walkInGroup).getByRole('option', { name: 'Walk In Athlete' })).toBeInTheDocument();
  });

  test('a walk-in mark is confirmed as a walk-in', async () => {
    installFetchMock({ checkInMethod: 'walk_in' });
    const picker = await renderPage();

    fireEvent.change(picker, { target: { value: 'athlete-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update Attendance' }));

    expect(await screen.findByText('Marked present as a walk-in (not registered for this class).')).toBeInTheDocument();
  });

  test('the attendance list says walk-in instead of the raw method value', async () => {
    installFetchMock({
      attendance: [
        {
          attendance_id: 'att-1',
          class_id: 'class-1',
          athlete_id: 'athlete-2',
          status: 'present',
          method: 'walk_in',
          note: '',
          checked_in_at: '2026-08-03T13:05:00.000Z',
        },
      ],
    });
    await renderPage();

    expect(await screen.findByText('PRESENT via walk-in')).toBeInTheDocument();
    expect(screen.queryByText(/walk_in/)).toBeNull();
  });
});

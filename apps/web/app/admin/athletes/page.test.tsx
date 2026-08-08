/**
 * @jest-environment jsdom
 */

// Forty hand-typed records make a mistyped date of birth a certainty, and this
// console is the only thing standing between that and direct SQL. What is
// covered here is what makes it safe to hand an admin: a correction sends the
// whole record with the stored created_at, an offboarding is a status change
// rather than a delete, a coach is never reassigned as a side effect, and a
// roster that could not be read never renders as a gym with no athletes.

import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import AthleteRecordsPage from './page';
import { usePilotSession, type PilotSessionState } from '@/components/usePilotSession';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('@/components/usePilotSession', () => ({
  ...jest.requireActual('@/components/usePilotSession'),
  usePilotSession: jest.fn(),
}));

const mockUsePilotSession = usePilotSession as jest.Mock;
const originalFetch = global.fetch;

function session(role: PilotSessionState['role'] = 'organization_admin'): PilotSessionState {
  return {
    role,
    organizationId: 'org-ppbf',
    authProvider: 'microsoft',
    accountId: 'admin@punxsyprominence.org',
    mustChangePin: false,
    loading: false,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

// dob and created_at arrive as timestamps: they are `date` and `timestamptz`
// columns, and node-postgres hands both to JSON as full ISO strings.
const rosterBody = {
  items: [
    {
      athlete_id: 'ath-001',
      full_name: 'Dawn Kellerman',
      dob: '2012-04-07T00:00:00.000Z',
      weight_class: '106',
      gym_status: 'training',
      emergency_contact: 'Ruth Kellerman 814-555-0143',
      active_flag: true,
      coach_id: 'coach-1',
      created_at: '2026-07-01T12:00:00.000Z',
      updated_at: '2026-07-01T12:00:00.000Z',
    },
  ],
};

const staffBody = {
  ok: true,
  members: [
    { account_id: 'coach-1', login_email: 'jason@example.org', role: 'coach', active_flag: true, membership_active: true },
    { account_id: 'coach-2', login_email: 'rosa@example.org', role: 'coach', active_flag: true, membership_active: true },
  ],
};

function consoleFetch(handler?: (url: string, init?: RequestInit) => Response | undefined) {
  return jest.fn(async (url: string, init?: RequestInit) => {
    const handled = handler?.(String(url), init);
    if (handled) {
      return handled;
    }

    if (String(url).includes('/api/pilot/athletes/list')) {
      return jsonResponse(rosterBody);
    }
    if (String(url).includes('/api/pilot/admin/staff')) {
      return jsonResponse(staffBody);
    }
    if (String(url).includes('/api/pilot/athletes/update')) {
      return jsonResponse({ ok: true, athlete_id: 'ath-001' });
    }
    if (String(url).includes('/api/pilot/scheduler/attendance-summary')) {
      return jsonResponse({ ok: true, athletes: [] });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function bodyOf(call: [string, RequestInit]): Record<string, unknown> {
  return JSON.parse(String(call[1].body)) as Record<string, unknown>;
}

beforeEach(() => {
  mockUsePilotSession.mockReturnValue(session());
});

afterEach(() => {
  jest.clearAllMocks();
  global.fetch = originalFetch;
});

describe('/admin/athletes', () => {
  test('a corrected date of birth is sent with the rest of the record and the stored created_at', async () => {
    const fetchMock = consoleFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    // The date of birth reaches the date input at all: an unparsed timestamp
    // is discarded by <input type="date"> and would read as a blank one.
    const openButton = await screen.findByRole('button', { name: /correct record/i });
    fireEvent.click(openButton);

    const dobField = screen.getByLabelText(/date of birth/i) as HTMLInputElement;
    expect(dobField.value).toBe('2012-04-07');

    fireEvent.change(dobField, { target: { value: '2012-04-17' } });
    fireEvent.click(screen.getByRole('button', { name: /save correction/i }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/athletes/update'))).toBe(true);
    });

    const updateCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/athletes/update'));
    expect(bodyOf(updateCall as [string, RequestInit])).toEqual({
      athlete_id: 'ath-001',
      full_name: 'Dawn Kellerman',
      dob: '2012-04-17',
      weight_class: '106',
      gym_status: 'training',
      emergency_contact: 'Ruth Kellerman 814-555-0143',
      active_flag: true,
      coach_id: 'coach-1',
      created_at: '2026-07-01T12:00:00.000Z',
      updated_at: expect.any(String),
    });
  });

  test('offboarding writes active_flag false and leaves the rest of the record standing', async () => {
    const fetchMock = consoleFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /correct record/i }));
    fireEvent.click(screen.getByRole('button', { name: /deactivate athlete/i }));

    // The confirm step exists so a mis-tap on a gym tablet does not offboard a
    // child; nothing is sent until it is answered.
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/athletes/update'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /yes, save it/i }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/athletes/update'))).toBe(true);
    });

    const updateCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/athletes/update'));
    const body = bodyOf(updateCall as [string, RequestInit]);
    expect(body.active_flag).toBe(false);
    expect(body.full_name).toBe('Dawn Kellerman');
    expect(body.athlete_id).toBe('ath-001');
  });

  test('a roster that could not be read says so instead of showing an empty gym', async () => {
    const fetchMock = consoleFetch((url) =>
      url.includes('/api/pilot/athletes/list') ? jsonResponse({ error: 'Internal server error' }, false, 500) : undefined);
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    expect(await screen.findByText(/could not be read/i)).toBeDefined();
    expect(screen.queryByText(/no athlete records in your gym yet/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /correct record/i })).toBeNull();
  });

  test('an athlete with attendance data shows the rate alongside the roster row', async () => {
    const fetchMock = consoleFetch((url) =>
      url.includes('/api/pilot/scheduler/attendance-summary')
        ? jsonResponse({ ok: true, athletes: [{ athlete_id: 'ath-001', attendance_rate: 0.857 }] })
        : undefined);
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    await screen.findByText(/attendance 86%/i);
  });

  test('an athlete with no attendance data yet shows the roster row with no rate, not a fabricated one', async () => {
    const fetchMock = consoleFetch((url) =>
      url.includes('/api/pilot/scheduler/attendance-summary')
        ? jsonResponse({ ok: true, athletes: [{ athlete_id: 'ath-001', attendance_rate: null }] })
        : undefined);
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    await screen.findByText('Dawn Kellerman');
    expect(screen.queryByText(/attendance \d/i)).toBeNull();
  });

  // The roster is the reason this page exists; a reporting-layer failure
  // (a coach without a class, or attendance-summary being unreachable) must
  // never blank or break it.
  test('a failed attendance fetch leaves the roster itself fully intact', async () => {
    const fetchMock = consoleFetch((url) =>
      url.includes('/api/pilot/scheduler/attendance-summary')
        ? jsonResponse({ error: 'Forbidden' }, false, 403)
        : undefined);
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    expect(await screen.findByRole('button', { name: /correct record/i })).toBeDefined();
    expect(screen.getByText('Dawn Kellerman')).toBeDefined();
    expect(screen.queryByText(/attendance \d/i)).toBeNull();
  });

  test('links to the attendance dashboard', async () => {
    const fetchMock = consoleFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    await screen.findByRole('button', { name: /correct record/i });
    expect((screen.getByRole('link', { name: 'Attendance' }) as HTMLAnchorElement).getAttribute('href')).toBe('/admin/attendance');
  });

  test('a coach directory that could not be read never reassigns the athlete', async () => {
    const fetchMock = consoleFetch((url) =>
      url.includes('/api/pilot/admin/staff') ? jsonResponse({ error: 'Forbidden' }, false, 403) : undefined);
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /correct record/i }));

    const coachField = screen.getByLabelText(/^coach$/i) as HTMLSelectElement;
    expect(coachField.value).toBe('coach-1');
    expect(coachField.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/weight class/i), { target: { value: '112' } });
    fireEvent.click(screen.getByRole('button', { name: /save correction/i }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/athletes/update'))).toBe(true);
    });

    const updateCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/athletes/update'));
    expect(bodyOf(updateCall as [string, RequestInit]).coach_id).toBe('coach-1');
  });

  test('a failed save says so and does not claim the correction landed', async () => {
    const fetchMock = consoleFetch((url) =>
      url.includes('/api/pilot/athletes/update') ? jsonResponse({ error: 'Internal server error' }, false, 500) : undefined);
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /correct record/i }));
    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Dawn Kellermann' } });
    fireEvent.click(screen.getByRole('button', { name: /save correction/i }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.queryByText(/is saved\./i)).toBeNull();
    // The edit is still on screen, so the admin can retry rather than retype.
    expect((screen.getByLabelText(/full name/i) as HTMLInputElement).value).toBe('Dawn Kellermann');
  });

  test('a platform owner is sent to the console that does their job', async () => {
    mockUsePilotSession.mockReturnValue(session('platform_owner'));
    const fetchMock = consoleFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    expect(await screen.findByText(/athlete records are managed per gym/i)).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

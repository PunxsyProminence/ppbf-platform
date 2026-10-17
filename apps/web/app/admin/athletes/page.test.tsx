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
    // CT-15's default: no structured emergency contact on file, unless a test
    // overrides this branch via `handler` to exercise the populated case.
    if (String(url).includes('/api/pilot/intake/domain-get')) {
      return jsonResponse({ ok: true, athlete_id: 'ath-001', emergency_contacts: [] });
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
    // Not "Deactivate": on People that word switches a sign-in off (UXB-26).
    fireEvent.click(screen.getByRole('button', { name: /mark as left the gym/i }));

    // The confirm step exists so a mis-tap on a gym tablet does not offboard a
    // child; nothing is sent until it is answered.
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/athletes/update'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /yes, mark as left/i }));

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

  // F-058. The row printed "coach coach-1": the account id behind the coach.
  test('the roster row names the coach, not the account id', async () => {
    const fetchMock = consoleFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    await screen.findByText(/Coach Jason/);
    expect(screen.queryByText(/coach-1/)).toBeNull();
  });

  test('a coach who is not on the staff list is said plainly, never printed as an id', async () => {
    const fetchMock = consoleFetch((url) => (url.includes('/api/pilot/admin/staff')
      ? jsonResponse({ ok: true, members: [] })
      : undefined));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    await screen.findByText(/coach not on the staff list/);
    expect(screen.queryByText(/coach-1/)).toBeNull();
  });

  test('a coach who left the active list is still named, and a staff list that could not be read is not read as "not on it"', async () => {
    global.fetch = consoleFetch((url) => (url.includes('/api/pilot/admin/staff')
      ? jsonResponse({
        ok: true,
        members: [{ account_id: 'coach-1', login_email: 'jason@example.org', role: 'coach', active_flag: false, membership_active: true }],
      })
      : undefined)) as unknown as typeof fetch;
    const { unmount } = render(<AthleteRecordsPage />);

    await screen.findByText(/Coach Jason/);
    expect(screen.queryByText(/not on the staff list/)).toBeNull();
    unmount();

    global.fetch = consoleFetch((url) => (url.includes('/api/pilot/admin/staff')
      ? jsonResponse({ error: 'Forbidden' }, false, 403)
      : undefined)) as unknown as typeof fetch;
    render(<AthleteRecordsPage />);

    await screen.findByText(/coach name not available/);
    expect(screen.queryByText(/not on the staff list/)).toBeNull();
  });

  test('a coach who is listed without a login address is not said to be missing from the list', async () => {
    global.fetch = consoleFetch((url) => (url.includes('/api/pilot/admin/staff')
      ? jsonResponse({
        ok: true,
        members: [{ account_id: 'coach-1', login_email: null, role: 'coach', active_flag: true, membership_active: true }],
      })
      : undefined)) as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    await screen.findByText(/coach name not available/);
    expect(screen.queryByText(/not on the staff list/)).toBeNull();
  });

  // The row printed the stored date text and the picker listed coaches by email.
  test('the row writes the date of birth as a date, and the coach picker names coaches', async () => {
    global.fetch = consoleFetch() as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    expect(await screen.findByText(/born Apr 7, 2012/)).toBeTruthy();
    expect(screen.queryByText(/2012-04-07/)).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: /correct record/i }));
    const picker = await screen.findByLabelText(/coach/i, { selector: '#correct-coach' });
    const options = [...picker.querySelectorAll('option')].map((option) => option.textContent);
    expect(options).toEqual(['Coach Jason', 'Coach Rosa']);
    expect(options.join(' ')).not.toMatch(/@/);
  });

  test('two coaches who would read the same are told apart by their address', async () => {
    global.fetch = consoleFetch((url) => (url.includes('/api/pilot/admin/staff')
      ? jsonResponse({
        ok: true,
        members: [
          { account_id: 'coach-1', login_email: 'sam@a.org', role: 'coach', active_flag: true, membership_active: true },
          { account_id: 'coach-2', login_email: 'sam@b.org', role: 'coach', active_flag: true, membership_active: true },
        ],
      })
      : undefined)) as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /correct record/i }));
    const picker = await screen.findByLabelText(/coach/i, { selector: '#correct-coach' });
    expect([...picker.querySelectorAll('option')].map((option) => option.textContent))
      .toEqual(['Coach Sam (sam@a.org)', 'Coach Sam (sam@b.org)']);
  });

  test('coaches with no login address on file are still told apart in the picker', async () => {
    global.fetch = consoleFetch((url) => (url.includes('/api/pilot/admin/staff')
      ? jsonResponse({
        ok: true,
        members: [
          { account_id: 'coach-1', login_email: null, role: 'coach', active_flag: true, membership_active: true },
          { account_id: 'coach-2', login_email: null, role: 'coach', active_flag: true, membership_active: true },
        ],
      })
      : undefined)) as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /correct record/i }));
    const picker = await screen.findByLabelText(/coach/i, { selector: '#correct-coach' });
    const labels = [...picker.querySelectorAll('option')].map((option) => option.textContent);
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
    expect(labels.join(' ')).not.toMatch(/coach-1|coach-2/);
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
    // /admin shows the platform owner a notice too; the way back is its own desk.
    expect(screen.getByRole('link', { name: 'Platform Desk' }).getAttribute('href')).toBe('/admin/platform');
    expect(screen.queryAllByRole('link').some((link) => link.getAttribute('href') === '/admin')).toBe(false);
  });
});

// CT-15: pilot.athletes.emergency_contact is a free-text note; pilot.emergency_contacts
// (structured: name, relationship, phone, email, is_primary) is the authoritative
// record. This console used to show and edit only the note, with nothing on
// screen distinguishing it from the verified record -- an admin correcting a
// phone number here was editing a note nothing treats as authoritative. These
// pin the fix: the structured record is shown as authoritative when it exists,
// its absence is stated rather than left silent, and the note field says
// plainly what it is.
describe('CT-15: the structured emergency contact record is shown as authoritative, not the note', () => {
  test('a structured contact renders with its verified details, marked primary', async () => {
    const fetchMock = consoleFetch((url) =>
      url.includes('/api/pilot/intake/domain-get')
        ? jsonResponse({
          ok: true,
          athlete_id: 'ath-001',
          emergency_contacts: [
            {
              contact_id: 'contact-1',
              organization_id: 'org-ppbf',
              athlete_id: 'ath-001',
              full_name: 'Rosa Quinteros',
              relationship_to_athlete: 'aunt',
              phone: '814-555-0142',
              email: 'rosa@example.org',
              is_primary: true,
              notes: '',
              created_at: '2026-06-01T00:00:00.000Z',
              updated_at: '2026-06-01T00:00:00.000Z',
            },
          ],
        })
        : undefined);
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /correct record/i }));

    expect(await screen.findByText('Rosa Quinteros')).toBeDefined();
    expect(screen.getByText(/814-555-0142/)).toBeDefined();
    expect(screen.getByText(/Primary/)).toBeDefined();
    expect(screen.queryByText(/No structured emergency contact on file/i)).toBeNull();
  });

  test('no structured contact on file is stated as a warning, not left blank', async () => {
    // consoleFetch's default already returns an empty emergency_contacts list;
    // the point under test is that the empty case is a stated warning rather
    // than a silently absent section.
    const fetchMock = consoleFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /correct record/i }));

    const warning = await screen.findByText(/No structured emergency contact on file/i);
    expect(warning).toBeDefined();
    // Names the athlete, and says the note is the only thing on file --
    // exactly the state a reader must not mistake for "verified and fine".
    expect(screen.getByText(/is the only emergency contact information recorded for/i)).toBeDefined();
  });

  test('a domain-get failure is reported rather than read as "no contact on file"', async () => {
    const fetchMock = consoleFetch((url) =>
      url.includes('/api/pilot/intake/domain-get') ? jsonResponse({ error: 'Forbidden' }, false, 403) : undefined);
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /correct record/i }));

    expect(await screen.findByText(/could not be read right now/i)).toBeDefined();
    // The distinct "none on file" copy must not also appear -- a reader must
    // not confuse "we could not check" with "we checked and there is none".
    expect(screen.queryByText(/No structured emergency contact on file/i)).toBeNull();
  });

  test('the free-text field is labeled and captioned as a note, not the contact record', async () => {
    const fetchMock = consoleFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /correct record/i }));

    expect(screen.getByLabelText(/emergency contact note/i)).toBeDefined();
    expect(screen.getByText(/not the emergency contact record/i)).toBeDefined();
  });

  test('closing a record and opening a different one does not carry over the first athlete\'s contacts', async () => {
    const secondAthlete = {
      ...rosterBody.items[0],
      athlete_id: 'ath-002',
      full_name: 'Second Athlete',
    };
    const fetchMock = consoleFetch((url, init) => {
      if (url.includes('/api/pilot/athletes/list')) {
        return jsonResponse({ items: [rosterBody.items[0], secondAthlete] });
      }
      if (url.includes('/api/pilot/intake/domain-get')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { athlete_id?: string };
        return body.athlete_id === 'ath-001'
          ? jsonResponse({
            ok: true,
            emergency_contacts: [
              {
                contact_id: 'contact-1',
                full_name: 'Rosa Quinteros',
                relationship_to_athlete: 'aunt',
                phone: '814-555-0142',
                is_primary: true,
              },
            ],
          })
          : jsonResponse({ ok: true, emergency_contacts: [] });
      }
      return undefined;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    const openButtons = await screen.findAllByRole('button', { name: /correct record/i });
    fireEvent.click(openButtons[0]);
    await screen.findByText('Rosa Quinteros');

    fireEvent.click(openButtons[1]);
    await screen.findByText(/No structured emergency contact on file/i);
    expect(screen.queryByText('Rosa Quinteros')).toBeNull();
  });
});

// Lane FU2 (OD-2026-10-10-004 ruling 4): the organization admin reads what the
// gym's coaches wrote about an athlete from a block on this page. The block's
// own behaviour is covered in AdminAthleteCoachNotes.test.tsx; these pin where
// it is mounted, for whom, and for which athlete.
describe('the coach-notes block', () => {
  const notesUrl = '/api/pilot/coach/athlete-capacity-notes';

  test('is under the selected athlete, reads nothing until opened, and then reads THAT athlete', async () => {
    const fetchMock = consoleFetch((url) => (
      url.includes(notesUrl) ? jsonResponse({ ok: true, note_max: 2000, notes: [], older_notes: false }) : undefined
    ));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    // No athlete chosen: no block.
    await screen.findByRole('button', { name: /correct record/i });
    expect(screen.queryByRole('heading', { name: 'Coach notes' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /correct record/i }));
    expect(screen.getByRole('heading', { name: 'Coach notes' })).toBeDefined();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes(notesUrl))).toBe(false);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/pilot/sessions/list'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Capacity notes' }));
    await screen.findByText('No capacity notes yet for this athlete.');
    const reads = fetchMock.mock.calls.filter((call) => String(call[0]).includes(notesUrl));
    expect(reads).toHaveLength(1);
    expect(String(reads[0][0])).toContain('athlete_id=ath-001');
  });

  test('opening another athlete takes the first athlete\'s notes off the screen', async () => {
    const second = { ...rosterBody.items[0], athlete_id: 'ath-002', full_name: 'Second Athlete' };
    const noteFor = (athleteId: string) => ({
      note_id: `note-${athleteId}`,
      note: `A note about ${athleteId}`,
      author_name: 'Coach Jason',
      created_at: '2026-10-08T12:00:00.000Z',
      own: false,
      can_withdraw: false,
    });
    const fetchMock = consoleFetch((url) => {
      if (url.includes('/api/pilot/athletes/list')) {
        return jsonResponse({ items: [rosterBody.items[0], second] });
      }
      if (url.includes(notesUrl)) {
        const athleteId = url.includes('athlete_id=ath-002') ? 'ath-002' : 'ath-001';
        return jsonResponse({ ok: true, note_max: 2000, notes: [noteFor(athleteId)], older_notes: false });
      }
      return undefined;
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    const openButtons = await screen.findAllByRole('button', { name: /correct record/i });
    fireEvent.click(openButtons[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Capacity notes' }));
    await screen.findByText('A note about ath-001');

    // The second athlete's block starts closed: nothing of the first remains,
    // and nothing is read for the second until it is opened.
    fireEvent.click(openButtons[1]);
    expect(screen.queryByText('A note about ath-001')).toBeNull();
    expect(screen.getByRole('button', { name: 'Capacity notes' })).toBeDefined();
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes(notesUrl))).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Capacity notes' }));
    await screen.findByText('A note about ath-002');
    expect(screen.queryByText('A note about ath-001')).toBeNull();
    expect(screen.getByText(/Capacity notes — Second Athlete/)).toBeDefined();
  });

  test('a platform owner gets no block and no note is read', async () => {
    mockUsePilotSession.mockReturnValue(session('platform_owner'));
    const fetchMock = consoleFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);

    await screen.findByText(/athlete records are managed per gym/i);
    expect(screen.queryByRole('heading', { name: 'Coach notes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Capacity notes' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Issue #1527 (OD-2026-10-12-011, "A: Coach and parent (Recommended)"): an
// athlete's goals show to the coach and the parent, and the "why it matters"
// line to the coach only. The organization admin is neither, so this page
// shows no goals block and reads no goal.
describe('no goals block for the organization admin', () => {
  test('a selected athlete\'s record shows no goals and reads none', async () => {
    const fetchMock = consoleFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<AthleteRecordsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /correct record/i }));
    await screen.findByRole('heading', { name: 'Coach notes' });

    expect(screen.queryByTestId('athlete-goals')).toBeNull();
    expect(screen.queryByText(/Goals they have set/)).toBeNull();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/api/pilot/goals/'))).toBe(false);
  });
});

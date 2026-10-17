/**
 * @jest-environment jsdom
 */

// UXB-L8 (lane U3): the office screens name people, never print a database
// table as a status line, and do not lose an admin's corrections. Each case
// fails on main.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import EscalationsPage from './escalations/page';
import AdminFloorHoursPage from './floor-hours/page';
import AthleteRecordsPage from './athletes/page';

jest.mock('@/components/RoleSessionGate', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));
jest.mock('@/components/RoleStandaloneView', () => ({
  __esModule: true,
  default: ({ children }: { readonly children: ReactNode }) => children,
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => <a href={href}>{children}</a>,
}));
jest.mock('@/components/usePilotSession', () => ({
  ...jest.requireActual('@/components/usePilotSession'),
  usePilotSession: () => ({
    role: 'organization_admin', organizationId: 'org-ppbf', authProvider: 'microsoft',
    accountId: 'office-admin', mustChangePin: false, loading: false,
  }),
}));

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

describe('escalations name the athlete (UXB-12)', () => {
  test('the Athlete column shows the name from the roster, not the id', async () => {
    global.fetch = jest.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/api/pilot/auth/session')) return jsonResponse({ authenticated: true, role: 'organization_admin' });
      if (target.includes('/api/pilot/athletes/list')) return jsonResponse({ items: [{ athlete_id: 'ath-77', full_name: 'Jordan Pace' }] });
      if (target.includes('/api/pilot/escalations')) {
        return jsonResponse({
          escalations: [{
            escalation_id: 'esc-1', source_type: 'pain_report', athlete_id: 'ath-77', severity: 'high',
            reason: 'Sore wrist again.', status: 'open', escalated_to_role: 'organization_admin', created_at: '2026-10-10T12:00:00.000Z',
          }],
        });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;

    render(<EscalationsPage />);

    expect(await screen.findByText('Jordan Pace')).toBeTruthy();
    expect(screen.queryByText('ath-77')).toBeNull();
  });
});

describe('a failed name read on escalations is said once, with a way back', () => {
  test('rows read "name not loaded", an alert says why, and Check again reads the names again', async () => {
    let namesFail = true;
    global.fetch = jest.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/api/pilot/auth/session')) return jsonResponse({ authenticated: true, role: 'organization_admin' });
      if (target.includes('/api/pilot/athletes/list')) {
        return namesFail ? jsonResponse({ error: 'x' }, false) : jsonResponse({ items: [{ athlete_id: 'ath-77', full_name: 'Jordan Pace' }] });
      }
      if (target.includes('/api/pilot/escalations')) {
        return jsonResponse({
          escalations: [{
            escalation_id: 'esc-1', source_type: 'pain_report', athlete_id: 'ath-77', severity: 'high',
            reason: 'Sore wrist again.', status: 'open', escalated_to_role: 'organization_admin', created_at: '2026-10-10T12:00:00.000Z',
          }],
        });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;

    render(<EscalationsPage />);

    expect(await screen.findByText(/Athlete names could not be loaded/)).toBeTruthy();
    expect(screen.getByText('Athlete (name not loaded)')).toBeTruthy();
    expect(screen.queryByText('ath-77')).toBeNull();
    namesFail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Jordan Pace')).toBeTruthy();
  });
});

describe('floor hours name the person (UXB-12)', () => {
  test('the Person column shows a name, never the account id', async () => {
    global.fetch = jest.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/api/pilot/admin/staff')) return jsonResponse({ members: [{ account_id: 'acct-coach-9', login_email: 'coach.nine@example.com' }] });
      if (target.includes('/api/pilot/admin/athlete-pin-directory')) return jsonResponse({ ok: true, items: [{ account_id: 'acct-ath-3', full_name: 'Riley Stone' }] });
      if (target.includes('/api/pilot/admin/floor-hours')) {
        return jsonResponse({
          floor_hours: ['acct-coach-9', 'acct-ath-3', 'acct-unknown'].map((person) => ({
            person_account_id: person, athlete_id: null, activity_domain: 'boxing', period_year: 2026, period_quarter: 3,
            hours: '1.0', recorded_minutes: '60', adjustment_minutes: '0', sessions_recorded: '1', first_recorded: '2026-07-01', last_recorded: '2026-07-01',
          })),
        });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;

    render(<AdminFloorHoursPage />);

    expect(await screen.findByText('coach.nine@example.com')).toBeTruthy();
    expect(await screen.findByText('Riley Stone')).toBeTruthy();
    expect(screen.getByText('Person (name not loaded)')).toBeTruthy();
    for (const id of ['acct-coach-9', 'acct-ath-3', 'acct-unknown']) {
      expect(screen.queryByText(id)).toBeNull();
    }
  });
});

describe('correcting athlete records keeps the admin\'s work (UXB-27)', () => {
  const athlete = (id: string, name: string) => ({
    athlete_id: id, full_name: name, dob: '2012-03-04T00:00:00.000Z', weight_class: '106', gym_status: 'training',
    emergency_contact: 'Ruth 814-555-0143', coach_id: 'coach-1', active_flag: true,
    created_at: '2026-07-01T12:00:00.000Z', updated_at: '2026-07-01T12:00:00.000Z',
  });

  function installRoster(): void {
    global.fetch = jest.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/api/pilot/athletes/list')) return jsonResponse({ items: [athlete('ath-1', 'First Athlete'), athlete('ath-2', 'Second Athlete')] });
      if (target.includes('/api/pilot/admin/staff')) {
        return jsonResponse({ ok: true, members: [{ account_id: 'coach-1', login_email: 'coach@example.org', role: 'coach', active_flag: true, membership_active: true }] });
      }
      if (target.includes('/api/pilot/scheduler/attendance-summary')) return jsonResponse({ ok: true, athletes: [] });
      if (target.includes('/api/pilot/intake/domain-get')) return jsonResponse({ ok: true, emergency_contacts: [] });
      return jsonResponse({ ok: true, items: [] });
    }) as unknown as typeof fetch;
  }

  test('opening another record with unsaved corrections asks first, and Keep editing keeps them', async () => {
    installRoster();
    render(<AthleteRecordsPage />);

    const open = await screen.findAllByRole('button', { name: /correct record/i });
    fireEvent.click(open[0]);
    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'First Athlete Corrected' } });
    fireEvent.click(screen.getAllByRole('button', { name: /correct record/i })[0]);

    expect(screen.getByText('Discard changes to First Athlete?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect((screen.getByLabelText(/full name/i) as HTMLInputElement).value).toBe('First Athlete Corrected');
  });

  test('Discard changes puts the stored record back in the form', async () => {
    installRoster();
    render(<AthleteRecordsPage />);

    fireEvent.click((await screen.findAllByRole('button', { name: /correct record/i }))[0]);
    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Typo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));

    await waitFor(() => expect((screen.getByLabelText(/full name/i) as HTMLInputElement).value).toBe('First Athlete'));
  });
});

describe('no database table is printed as a status line (UXB-28)', () => {
  test.each([
    'admin/athlete-consent/page.tsx',
    'admin/coach-coverage/page.tsx',
    'admin/escalations/page.tsx',
    'admin/portrait-review/page.tsx',
    'admin/video-compliance/page.tsx',
    'admin/waiver-status/page.tsx',
    'admin/attendance/page.tsx',
    'audit/page.tsx',
  ])('%s', (file) => {
    const source = readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    expect(source).not.toMatch(/>LIVE \| /);
    expect(source).not.toMatch(/value: 'pilot\./);
  });
});

describe('the admin people page names an athlete and uses the shared warning (UXB-07, UXB-12)', () => {
  const source = readFileSync(path.resolve(__dirname, 'people/page.tsx'), 'utf8');

  test('no "Athlete ID" beside the role, and no near-white warning boxes', () => {
    expect(source).not.toMatch(/Athlete ID \{member\.athlete_id\}/);
    expect(source).not.toMatch(/_10%,white\)|_8%,white\)/);
  });
});

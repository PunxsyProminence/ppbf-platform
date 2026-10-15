import { NextRequest } from 'next/server';

import { POST } from './route';
import { queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

// The db layer is the mock boundary: the real access check runs. queryOne
// answers the session read and the athlete's live-row check.
jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

const STORED = {
  organization_id: 'org-1', session_id: 'sess-1', athlete_id: 'ATH-1', date: '2026-10-01', rpe: null,
  rpe_method: 'UNKNOWN', duration_minutes: null, notes: '', completed_flag: false,
  created_at: '2026-10-01T17:00:00.000Z', updated_at: '2026-10-01T17:00:00.000Z',
  checked_out_at: null, close_method: null, last_activity_at: null, inactivity_minutes: null,
  a_column_added_later: 'must not reach the athlete',
};

function answer(sql: string) {
  return String(sql).includes('from pilot.sessions') ? STORED : { athlete_id: 'ATH-1' };
}

const post = () => POST(new NextRequest('http://localhost/api/pilot/sessions/get', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ session_id: 'sess-1' }),
}));

/*
 * #1558 item three: the athlete reads named fields (familyRecordView.ts
 * toFamilySession), never the storage row. Staff keep the row.
 */
describe('POST /api/pilot/sessions/get', () => {
  test('the athlete gets exactly the named fields of their own session', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete', accountId: 'acct-ath-1', athleteId: 'ATH-1' }));
    mockQueryOne.mockImplementation(async (sql: string) => answer(sql));

    const response = await post();
    const raw = await response.text();

    expect(response.status).toBe(200);
    const family = Object.fromEntries(
      Object.entries(STORED).filter(([key]) => key !== 'organization_id' && key !== 'a_column_added_later'),
    );
    expect(JSON.parse(raw)).toEqual({ found: true, session: family });
    expect(raw).not.toContain('org-1');
  });

  test('a coach gets the row as the database returned it', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
    mockQueryOne.mockImplementation(async (sql: string) => answer(sql));

    const body = await (await post()).json();

    expect(body).toEqual({ found: true, session: STORED });
  });
});

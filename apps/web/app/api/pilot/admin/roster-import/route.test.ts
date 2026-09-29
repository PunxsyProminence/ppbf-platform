import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { applyRosterImport, planRosterImport } from '@/src/server/pilot/rosterImport';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/rosterImport', () => {
  const actual = jest.requireActual('@/src/server/pilot/rosterImport');
  return { ...actual, planRosterImport: jest.fn(), applyRosterImport: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockPlan = planRosterImport as jest.Mock;
const mockApply = applyRosterImport as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

const CSV = 'Athlete ID,Full name,Date of birth\nath-1,A Name,2012-03-14\n';

function principal(over: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'admin-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...over,
  } as PilotPrincipal;
}

function post(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/pilot/admin/roster-import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

const EMPTY_PLAN = { rows: [], counts: { create: 0, skip_exists: 0, reject: 0 } };

beforeEach(() => {
  jest.resetAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockPlan.mockResolvedValue(EMPTY_PLAN);
  mockApply.mockResolvedValue(EMPTY_PLAN);
  mockAudit.mockResolvedValue(undefined);
});

// The platform owner never opens a gym's athlete records (OD-2026-09-28-005),
// and loading them is the gym's own act.
test('refuses the platform owner', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({
    accountId: 'platform-owner',
    role: 'platform_owner',
    organizationId: 'platform',
  }));

  const response = await post({ csv: CSV });

  expect(response.status).toBe(403);
  expect(mockPlan).not.toHaveBeenCalled();
});

test('refuses a request with no session, before anything is planned', async () => {
  // The real gate, not the mock: no cookie means resolvePrincipal returns
  // before any database query, and the route must answer 401.
  const actual = jest.requireActual('@/src/server/pilot/http');
  mockRequirePrincipal.mockImplementation(actual.requirePrincipal);

  const response = await post({ csv: CSV });

  expect(response.status).toBe(401);
  expect(mockPlan).not.toHaveBeenCalled();
  expect(mockApply).not.toHaveBeenCalled();
});

test.each(['athlete', 'parent', 'staff', 'volunteer', 'board'] as const)(
  'refuses a %s',
  async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: `${role}-1`, role }));

    const response = await post({ csv: CSV });

    expect(response.status).toBe(403);
    expect(mockPlan).not.toHaveBeenCalled();
  },
);

// Jason, 2026-09-29, "9d. B": coaches load rosters too, into their own gym.
describe('a coach loading a roster', () => {
  const coach = () => principal({ accountId: 'coach-1', role: 'coach' });

  test('is allowed for their own gym, and a blank Coach cell becomes the coach loading it', async () => {
    mockRequirePrincipal.mockResolvedValue(coach());

    const response = await post({ csv: CSV });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.committed).toBe(false);
    expect(mockPlan).toHaveBeenCalledTimes(1);
    expect(mockPlan.mock.calls[0][0]).toBe('org-1');
    expect(mockPlan.mock.calls[0][1][0].coach_account_id).toBe('coach-1');
    expect(mockApply).not.toHaveBeenCalled();
  });

  // "3B": a coach may name any active coach in the gym. The route passes the
  // named coach through unchanged; planRosterImport checks it against the gym.
  test('passes a named coach through to planning unchanged', async () => {
    mockRequirePrincipal.mockResolvedValue(coach());

    await post({ csv: 'Athlete ID,Full name,Date of birth,Coach\nath-1,A Name,2012-03-14,coach-2\n' });

    expect(mockPlan.mock.calls[0][1][0].coach_account_id).toBe('coach-2');
  });

  test('commits the same rows it planned, and the audit says coach', async () => {
    mockRequirePrincipal.mockResolvedValue(coach());
    mockApply.mockResolvedValue({
      rows: [{ line: 1, athlete_id: 'ath-1', full_name: 'A Name', outcome: 'create', reason: '' }],
      counts: { create: 1, skip_exists: 0, reject: 0 },
    });

    const response = await post({ csv: CSV, commit: true });

    expect(response.status).toBe(200);
    expect(mockApply).toHaveBeenCalledTimes(1);
    expect(mockApply.mock.calls[0][0]).toBe('org-1');
    expect(mockApply.mock.calls[0][1]).toBe(mockPlan.mock.calls[0][1]);
    expect(mockApply.mock.calls[0][3]).toBe('coach-1');
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      actor_account_id: 'coach-1',
      actor_role: 'coach',
      organization_id: 'org-1',
    });
  });

  test('is refused when the body names another gym', async () => {
    mockRequirePrincipal.mockResolvedValue(coach());

    const response = await post({ csv: CSV, organization_id: 'org-2', commit: true });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toMatch(/another organization/);
    expect(mockPlan).not.toHaveBeenCalled();
    expect(mockApply).not.toHaveBeenCalled();
  });

  test('is refused when the session carries no gym', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'coach-1', role: 'coach', organizationId: '' }));

    const response = await post({ csv: CSV });

    expect(response.status).toBe(403);
    expect(mockPlan).not.toHaveBeenCalled();
  });
});

test('still admits a legacy admin session', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'admin' }));

  const response = await post({ csv: CSV });

  expect(response.status).toBe(200);
  expect(mockPlan).toHaveBeenCalledTimes(1);
});

// An admin's blank Coach cell is left blank for planning to refuse ("needs a
// coach"); only a coach's own import fills it in.
test('does not fill in a blank Coach cell for an admin', async () => {
  await post({ csv: CSV });
  expect(mockPlan.mock.calls[0][1][0].coach_account_id).toBe('');
});

// The default matters more than the flag: loading forty real children is not an
// action anyone should discover the shape of afterwards.
test('writes nothing unless commit is explicitly true', async () => {
  const response = await post({ csv: CSV });
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.committed).toBe(false);
  expect(mockPlan).toHaveBeenCalled();
  expect(mockApply).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});

test('a truthy-but-not-true commit value does not write', async () => {
  const response = await post({ csv: CSV, commit: 'yes' });
  const body = await response.json();

  expect(body.committed).toBe(false);
  expect(mockApply).not.toHaveBeenCalled();
});

test('commit true applies the plan and audits once', async () => {
  mockApply.mockResolvedValue({
    rows: [{ line: 1, athlete_id: 'ath-1', full_name: 'A Name', outcome: 'create', reason: '' }],
    counts: { create: 1, skip_exists: 0, reject: 0 },
  });

  const response = await post({ csv: CSV, commit: true });
  const body = await response.json();

  expect(body.committed).toBe(true);
  expect(body.counts.create).toBe(1);
  expect(mockApply).toHaveBeenCalledTimes(1);

  // One event for the import, not one per athlete: forty rows would bury every
  // other event of that evening.
  expect(mockAudit).toHaveBeenCalledTimes(1);
  expect(mockAudit.mock.calls[0][0].details).toMatchObject({
    action: 'roster_import',
    created: 1,
    created_athlete_ids: ['ath-1'],
  });
});

// The gym is the caller's own, always. A body naming another one is refused
// rather than silently redirected; naming the caller's own, or none, plans for
// the session's gym.
test('refuses an admin whose body names another gym', async () => {
  const response = await post({ csv: CSV, organization_id: 'org-2' });

  expect(response.status).toBe(403);
  expect(mockPlan).not.toHaveBeenCalled();
});

test('scopes the import to the caller gym', async () => {
  await post({ csv: CSV });
  await post({ csv: CSV, organization_id: 'org-1' });

  expect(mockPlan).toHaveBeenCalledTimes(2);
  expect(mockPlan.mock.calls.map((call) => call[0])).toEqual(['org-1', 'org-1']);
});

test('refuses a file with no usable header', async () => {
  const response = await post({ csv: 'Weight class\nlightweight\n' });

  expect(response.status).toBe(400);
  expect(mockPlan).not.toHaveBeenCalled();
});

test('refuses an empty request', async () => {
  const response = await post({ csv: '   ' });
  expect(response.status).toBe(400);
});

// A silent truncation of a roster is children missing from the gym with nothing
// to say they were ever in the file.
test('refuses an oversized file by name rather than truncating it', async () => {
  const rows = Array.from({ length: 501 }, (_, i) => `ath-${i},Name ${i},2012-03-14`).join('\n');
  const response = await post({ csv: `Athlete ID,Full name,Date of birth\n${rows}\n` });
  const body = await response.json();

  expect(response.status).toBe(400);
  expect(body.error).toMatch(/501 rows/);
  expect(mockPlan).not.toHaveBeenCalled();
});

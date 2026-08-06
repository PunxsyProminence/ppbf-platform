import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { assertAthleteBelongsToOrganization } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { query, queryOne } from '@/src/server/pilot/db';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/access', () => ({
  assertAthleteBelongsToOrganization: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requireMicrosoftAuthenticatedPrincipal: jest.fn() };
});

const mockPrincipal = jest.mocked(requireMicrosoftAuthenticatedPrincipal);
const mockAssertAthlete = jest.mocked(assertAthleteBelongsToOrganization);
const mockAudit = jest.mocked(writePilotAuditEvent);
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

function principal(role: string) {
  return {
    accountId: 'acct-admin-1',
    role,
    organizationId: 'org-a',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as never;
}

function jsonRequest(method: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://ppbf.example/api/pilot/admin/coach-coverage', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function inOneHour(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAssertAthlete.mockResolvedValue(undefined);
  mockAudit.mockResolvedValue(undefined);
  mockQuery.mockResolvedValue([]);
  // Default: the grantee IS an active coach and no overlapping grant exists,
  // so a 400/409 in any test below can only come from the guard that test
  // targets -- the review found three tests passing vacuously through the
  // coach-lookup 400 because queryOne had no default.
  mockQueryOne.mockImplementation(async (sql: string) => {
    if (String(sql).includes('pilot.accounts')) return { account_id: 'acct-coach-sub' };
    return null;
  });
});

describe('POST /api/pilot/admin/coach-coverage (grant)', () => {
  test('grants time-bounded coverage and audits it', async () => {
    mockPrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockQueryOne.mockResolvedValueOnce({ account_id: 'acct-coach-sub' }); // active coach lookup

    const response = await POST(jsonRequest('POST', {
      athlete_id: 'ATH-1',
      covering_coach_account_id: 'acct-coach-sub',
      expires_at: inOneHour(),
      reason: 'Coach B out sick, Coach S covering Tuesday',
    }));

    expect(response.status).toBe(200);
    const [insertSql, insertParams] = mockQuery.mock.calls[0];
    expect(String(insertSql)).toContain('insert into pilot.coach_coverage');
    expect(insertParams[0]).toBe('org-a');
    expect(insertParams[2]).toBe('ATH-1');
    expect(insertParams[3]).toBe('acct-coach-sub');
    expect(insertParams[5]).toBe('organization_admin');
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ entity_type: 'coach_coverage' }));
  });

  test.each(['coach', 'parent', 'athlete', 'board'])('%s cannot grant coverage', async (role) => {
    mockPrincipal.mockResolvedValueOnce(principal(role));

    const response = await POST(jsonRequest('POST', {
      athlete_id: 'ATH-1',
      covering_coach_account_id: 'acct-coach-sub',
      expires_at: inOneHour(),
    }));

    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('refuses a grantee who is not an active coach in this organization', async () => {
    mockPrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockQueryOne.mockResolvedValueOnce(null);

    const response = await POST(jsonRequest('POST', {
      athlete_id: 'ATH-1',
      covering_coach_account_id: 'acct-typo',
      expires_at: inOneHour(),
    }));

    expect(response.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('refuses an athlete from another organization (the org check throws)', async () => {
    mockPrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockAssertAthlete.mockRejectedValueOnce(new Error('Forbidden: athlete does not belong to organization'));

    const response = await POST(jsonRequest('POST', {
      athlete_id: 'ATH-OTHER-ORG',
      covering_coach_account_id: 'acct-coach-sub',
      expires_at: inOneHour(),
    }));

    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('refuses an expiry in the past', async () => {
    mockPrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest('POST', {
      athlete_id: 'ATH-1',
      covering_coach_account_id: 'acct-coach-sub',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }));

    expect(response.status).toBe(400);
    // Pin the SPECIFIC guard: without this, the test passed vacuously
    // through the unrelated coach-lookup 400.
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('must be in the future') });
  });

  // Coverage is temporary by definition. An open-ended grant is a permanent
  // reassignment wearing coverage's clothes; reassignment has a real path
  // (coach_id) that this table must not quietly replace.
  test('refuses an expiry beyond the 14-day cap', async () => {
    mockPrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest('POST', {
      athlete_id: 'ATH-1',
      covering_coach_account_id: 'acct-coach-sub',
      expires_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('capped') });
  });

  test('refuses an expiry at or before the start', async () => {
    mockPrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const later = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const response = await POST(jsonRequest('POST', {
      athlete_id: 'ATH-1',
      covering_coach_account_id: 'acct-coach-sub',
      starts_at: later,
      expires_at: inOneHour(),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('must be after starts_at') });
  });

  test('refuses missing fields with a 400, naming the field', async () => {
    mockPrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest('POST', { athlete_id: 'ATH-1' }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('covering_coach_account_id') });
  });

  // Date.parse coerces to string (Date.parse(2030) = the year 2030) while
  // new Date(2030) means epoch milliseconds -- a numeric starts_at that
  // validated as "the year 2030" would activate the grant in January 1970,
  // i.e. immediately. The typeof guard closes that divergence.
  test('refuses a numeric starts_at instead of silently activating the grant now', async () => {
    mockPrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest('POST', {
      athlete_id: 'ATH-1',
      covering_coach_account_id: 'acct-coach-sub',
      starts_at: 2030 as unknown as string,
      expires_at: inOneHour(),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('starts_at') });
  });

  test('refuses a reason longer than 2000 characters', async () => {
    mockPrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest('POST', {
      athlete_id: 'ATH-1',
      covering_coach_account_id: 'acct-coach-sub',
      expires_at: inOneHour(),
      reason: 'x'.repeat(2001),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('2000') });
  });

  test('malformed JSON is a 400, not a masked 500', async () => {
    mockPrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(new NextRequest('https://ppbf.example/api/pilot/admin/coach-coverage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json {',
    }));

    expect(response.status).toBe(400);
  });

  // A retried or double-clicked grant must read as "already done" (409),
  // not silently mint a second identical active grant that survives
  // revocation of the first.
  test('an overlapping active grant for the same coach and athlete is a 409', async () => {
    mockPrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockQueryOne
      .mockResolvedValueOnce({ account_id: 'acct-coach-sub' }) // coach lookup
      .mockResolvedValueOnce({ coverage_id: 'cov-existing' }); // overlap found

    const response = await POST(jsonRequest('POST', {
      athlete_id: 'ATH-1',
      covering_coach_account_id: 'acct-coach-sub',
      expires_at: inOneHour(),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('cov-existing') });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/pilot/admin/coach-coverage (revoke)', () => {
  test('revokes an active grant and audits it', async () => {
    mockPrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockQueryOne.mockResolvedValueOnce({ coverage_id: 'cov-1' });

    const response = await PATCH(jsonRequest('PATCH', { coverage_id: 'cov-1' }));

    expect(response.status).toBe(200);
    const [updateSql, updateParams] = mockQueryOne.mock.calls[0];
    expect(String(updateSql)).toContain('revoked_at is null');
    expect(updateParams).toEqual(['org-a', 'cov-1', 'acct-admin-1']);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ details: { action: 'revoked' } }));
  });

  // Guarded in the UPDATE itself: a second revoke must not overwrite who
  // revoked it first, and must read as a caller error, not success.
  test('re-revoking is a 400 Unsupported transition, not a silent overwrite', async () => {
    mockPrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockQueryOne
      .mockResolvedValueOnce(null) // guarded update matched nothing
      .mockResolvedValueOnce({ coverage_id: 'cov-1' }); // the row exists, already revoked

    const response = await PATCH(jsonRequest('PATCH', { coverage_id: 'cov-1' }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('already revoked') });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('revoking a nonexistent grant is a 400 Missing', async () => {
    mockPrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const response = await PATCH(jsonRequest('PATCH', { coverage_id: 'cov-nope' }));

    expect(response.status).toBe(400);
  });

  test('coach cannot revoke', async () => {
    mockPrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await PATCH(jsonRequest('PATCH', { coverage_id: 'cov-1' }));

    expect(response.status).toBe(403);
  });
});

describe('GET /api/pilot/admin/coach-coverage', () => {
  test('lists grants for the caller organization only', async () => {
    mockPrincipal.mockResolvedValueOnce(principal('admin'));
    mockQuery.mockResolvedValueOnce([]);

    const response = await GET(new NextRequest('https://ppbf.example/api/pilot/admin/coach-coverage'));

    expect(response.status).toBe(200);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('where organization_id = $1');
    expect(params).toEqual(['org-a']);
  });

  test.each(['coach', 'parent', 'board'])('%s cannot list grants', async (role) => {
    mockPrincipal.mockResolvedValueOnce(principal(role));

    const response = await GET(new NextRequest('https://ppbf.example/api/pilot/admin/coach-coverage'));

    expect(response.status).toBe(403);
  });
});

import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';

/*
  Route-level status assertions for the safety-flag validations.

  These exist because the service-layer tests could not have caught the defect
  they cover. safetyFlags.pg.test.ts asserted `.rejects.toThrow('CODE')` --
  a substring match BELOW jsonError, which passes no matter what status the
  message would eventually map to. Every one of these validations was in fact
  returning 500 "Internal server error" to the caller, with the reason
  discarded, and the suite stayed green.

  Deliberately mocks ONLY authentication. raiseSafetyFlag runs for real: its
  subject-required check fires before any query, so the whole chain --
  route -> service -> typed error -> jsonError -> NextResponse -- is exercised
  without a database. Mocking the service would have tested the mock.
*/

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockRequirePrincipal = jest.mocked(requirePrincipal);

function principal() {
  return {
    accountId: 'coach-1',
    role: 'coach' as const,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft' as const,
    mustChangePin: false,
  };
}

function post(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/pilot/safety-flags', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal() as never);
});

describe('POST /api/pilot/safety-flags validation status codes', () => {
  test('a flag with neither subject returns 400 with the reason, not 500', async () => {
    const res = await post({ flag_class: 'system_guidance', flag_code: 'load_spike' });

    // The regression. This was 500 "Internal server error".
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('athlete_id or a person_account_id');
    expect(body.error).not.toBe('Internal server error');
    expect(body.code).toBe('SAFETY_FLAG_SUBJECT_REQUIRED');
  });

  test('a medical flag code raised by SHADOW is refused as 400, naming the code', async () => {
    // triggered_by is not client-supplied on this route -- it is forced to
    // 'human_entry' -- so this branch is unreachable through the API today.
    // Asserted anyway: the check exists to mirror a database constraint, and a
    // future route that does pass triggered_by must not discover that its
    // refusal reads as a server fault.
    const { raiseSafetyFlag } = jest.requireActual('@/src/server/pilot/safetyFlags');
    await expect(
      raiseSafetyFlag({
        organizationId: 'org-1',
        athleteId: 'ATH-1',
        flagClass: 'external_rule',
        flagCode: 'concussion_rest_period',
        triggeredBy: 'shadow_inference',
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'SAFETY_FLAG_MEDICAL_CODE_REQUIRES_HUMAN_ENTRY',
    });
  });

  test('a missing flag_class still returns 400 through the untouched prefix branch', async () => {
    // The string-prefix branches remain in jsonError for un-migrated throws.
    // This asserts the migration did not disturb them.
    const res = await post({ flag_code: 'load_spike' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Missing flag_class');
  });

  test('an unauthenticated caller is still refused before any validation', async () => {
    mockRequirePrincipal.mockRejectedValue(new Error('Unauthorized'));
    const res = await post({ flag_class: 'system_guidance', flag_code: 'load_spike' });
    expect(res.status).toBe(401);
  });
});

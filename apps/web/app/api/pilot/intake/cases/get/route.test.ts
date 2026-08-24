/**
 * The ordering guard for the intake case aggregate.
 *
 * `getIntakeCaseAggregate` is the only thing mocked out of the intake module:
 * the gate itself runs for real, over a mocked `db`, so these tests prove the
 * decision rather than a stand-in for it. The assertion that matters most is
 * negative -- for a refused caller the aggregate must never be FETCHED, not
 * merely never returned. The defect this replaces read the whole case first
 * and consulted `primary_athlete_id` afterwards, a column nothing writes.
 */
import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { getIntakeCaseAggregate } from '@/src/server/pilot/intake';
import { query, queryOne } from '@/src/server/pilot/db';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('@/src/server/pilot/intake', () => {
  const actual = jest.requireActual('@/src/server/pilot/intake');
  return { ...actual, getIntakeCaseAggregate: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockAggregate = getIntakeCaseAggregate as jest.MockedFunction<typeof getIntakeCaseAggregate>;
const mockQuery = jest.mocked(query);
const mockQueryOne = jest.mocked(queryOne);

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-admin',
    role: 'organization_admin',
    organizationId: 'org-real',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

interface Fixture {
  intakeCase?: { primary_athlete_id: string | null; submitted_by_account_id: string } | null;
  documentOwners?: string[];
  coachAssigned?: string[];
  inOrganization?: string[];
}

function withDatabase(fixture: Fixture): void {
  mockQueryOne.mockImplementation(((sql: string, params: unknown[]) => {
    const text = String(sql);
    if (text.includes('from pilot.intake_cases')) {
      return Promise.resolve(fixture.intakeCase ?? null);
    }
    if (text.includes('from pilot.athletes') && text.includes('coach_id = $2')) {
      const [athleteId] = params as string[];
      return Promise.resolve(
        (fixture.coachAssigned ?? []).includes(athleteId) ? { athlete_id: athleteId } : null,
      );
    }
    if (text.includes('from pilot.athletes')) {
      const [athleteId] = params as string[];
      return Promise.resolve(
        (fixture.inOrganization ?? []).includes(athleteId) ? { athlete_id: athleteId } : null,
      );
    }
    if (text.includes('from pilot.coach_coverage')) {
      return Promise.resolve(null);
    }
    throw new Error(`unexpected queryOne in test: ${text}`);
  }) as never);

  mockQuery.mockImplementation(((sql: string) => {
    const text = String(sql);
    if (text.includes('from pilot.intake_documents')) {
      return Promise.resolve((fixture.documentOwners ?? []).map((id) => ({ owner_entity_id: id })));
    }
    throw new Error(`unexpected query in test: ${text}`);
  }) as never);
}

function caseRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/intake/cases/get', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A pending case: the state every row in this schema is actually in. */
const PENDING_CASE: Fixture = {
  intakeCase: { primary_athlete_id: null, submitted_by_account_id: 'acct-uploader' },
  documentOwners: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockAggregate.mockResolvedValue({ intake_case: {}, documents: [] });
});

describe('POST /api/pilot/intake/cases/get', () => {
  test('a role outside the gate is refused', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'volunteer' }));
    withDatabase(PENDING_CASE);

    const response = await POST(caseRequest({ intake_case_id: 'case-1' }));

    expect(response.status).toBe(403);
    expect(mockAggregate).not.toHaveBeenCalled();
  });

  test('a missing intake_case_id is a 400 and reads nothing', async () => {
    const response = await POST(caseRequest({}));

    expect(response.status).toBe(400);
    expect(mockAggregate).not.toHaveBeenCalled();
  });

  test('the organization admin reads a pending case', async () => {
    withDatabase(PENDING_CASE);

    const response = await POST(caseRequest({ intake_case_id: 'case-1' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.found).toBe(true);
    expect(mockAggregate).toHaveBeenCalledWith('org-real', 'case-1', expect.objectContaining({
      actorAccountId: 'acct-admin',
      actorRole: 'organization_admin',
    }));
  });

  test('THE DEFECT: an unrelated coach is refused, and the aggregate is never fetched', async () => {
    // The chain this closes: intake/review-queue admits a coach and returns
    // every case id in the organization, and this route then handed over the
    // summary, review notes, payload and every intake_documents row --
    // file_name, blob_path, classification -- for any of them.
    mockRequirePrincipal.mockResolvedValue(
      principal({ accountId: 'acct-other-coach', role: 'coach' }),
    );
    withDatabase(PENDING_CASE);

    const response = await POST(caseRequest({ intake_case_id: 'case-1' }));

    expect(response.status).toBe(403);
    expect(mockAggregate).not.toHaveBeenCalled();
  });

  test('the coach who filed the case still reads it', async () => {
    mockRequirePrincipal.mockResolvedValue(
      principal({ accountId: 'acct-uploader', role: 'coach' }),
    );
    withDatabase(PENDING_CASE);

    const response = await POST(caseRequest({ intake_case_id: 'case-1' }));

    expect(response.status).toBe(200);
    expect(mockAggregate).toHaveBeenCalledTimes(1);
  });

  test('a promoted case is gated on the athlete its documents name', async () => {
    const promoted: Fixture = {
      intakeCase: { primary_athlete_id: null, submitted_by_account_id: 'acct-uploader' },
      documentOwners: ['ath-1'],
    };

    mockRequirePrincipal.mockResolvedValue(
      principal({ accountId: 'acct-coach-of-record', role: 'coach' }),
    );
    withDatabase({ ...promoted, coachAssigned: ['ath-1'] });
    expect((await POST(caseRequest({ intake_case_id: 'case-1' }))).status).toBe(200);

    jest.clearAllMocks();
    mockAggregate.mockResolvedValue({ intake_case: {}, documents: [] });
    mockRequirePrincipal.mockResolvedValue(
      principal({ accountId: 'acct-other-coach', role: 'coach' }),
    );
    withDatabase({ ...promoted, coachAssigned: ['ath-other'] });
    expect((await POST(caseRequest({ intake_case_id: 'case-1' }))).status).toBe(403);
    expect(mockAggregate).not.toHaveBeenCalled();
  });

  test('an unknown case is found:false and still never reaches the aggregate', async () => {
    withDatabase({ intakeCase: null });

    const response = await POST(caseRequest({ intake_case_id: 'case-x' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ found: false });
    expect(mockAggregate).not.toHaveBeenCalled();
  });
});

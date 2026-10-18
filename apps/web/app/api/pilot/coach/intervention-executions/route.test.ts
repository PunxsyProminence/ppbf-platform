import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { accessibleAthleteIds, assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  closeExecution,
  correctExecution,
  getExecution,
  listExecutions,
  recordExecutionFacts,
  startExecution,
} from '@/src/server/pilot/interventionExecutions';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return {
    ...actual,
    assertActorCanAccessAthlete: jest.fn(),
    accessibleAthleteIds: jest.fn().mockResolvedValue(new Set()),
  };
});

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

jest.mock('@/src/server/pilot/interventionExecutions', () => {
  const actual = jest.requireActual('@/src/server/pilot/interventionExecutions');
  return {
    ...actual,
    startExecution: jest.fn(),
    listExecutions: jest.fn().mockResolvedValue([]),
    getExecution: jest.fn(),
    recordExecutionFacts: jest.fn(),
    closeExecution: jest.fn(),
    correctExecution: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockAccessible = accessibleAthleteIds as jest.Mock;
const mockList = listExecutions as jest.Mock;
const mockStart = startExecution as jest.Mock;
const mockRecord = recordExecutionFacts as jest.Mock;
const mockClose = closeExecution as jest.Mock;
const mockCorrect = correctExecution as jest.Mock;
const mockGetExecution = getExecution as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

// The athlete gate is permissive by default so each test states its own
// access decision rather than inheriting the previous test's --
// clearAllMocks clears calls, not implementations.
beforeEach(() => {
  mockAccess.mockResolvedValue(undefined);
  mockAccessible.mockResolvedValue(new Set());
  // PATCH resolves the execution's athlete before acting; default to an
  // existing, accessible one so the action tests below exercise the action,
  // not the gate. The gate has its own test.
  mockGetExecution.mockResolvedValue({ execution_id: 'ex-1', athlete_id: 'ath-1' });
});

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const bodyRequest = (method: 'POST' | 'PATCH', body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/coach/intervention-executions', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const getRequest = () => new NextRequest('http://localhost/api/pilot/coach/intervention-executions');

test('athletes and parents cannot touch the execution ledger -- staff surface only', async () => {
  for (const role of ['athlete', 'parent', 'platform_owner'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
    expect((await POST(bodyRequest('POST', { athlete_id: 'ath-1', protocol_id: 'p-1' }))).status).toBeGreaterThanOrEqual(400);
  }
  expect(mockStart).not.toHaveBeenCalled();
});

test('starting an execution carries the links and audits; a hidden module refusal is a 404 with no audit', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  // The athlete gate is granted here so the rest of the flow is what is under
  // test. Its refusal path has its own test below.
  mockAccess.mockResolvedValue(undefined);
  mockStart.mockResolvedValue({
    execution_id: 'ex-1', protocol_id: 'p-1', protocol_version: 1,
    athlete_id: 'ath-1', decision_id: 'dec-1',
  });

  const response = await POST(bodyRequest('POST', {
    athlete_id: 'ath-1', protocol_id: 'p-1', decision_id: 'dec-1',
  }));
  expect(response.status).toBe(200);
  expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({
    organizationId: 'org-1', athleteId: 'ath-1', protocolId: 'p-1', decisionId: 'dec-1',
  }));
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    event_type: 'create',
    entity_type: 'intervention_execution',
    details: expect.objectContaining({ protocol_id: 'p-1', decision_id: 'dec-1' }),
  }));

  mockAudit.mockClear();
  mockStart.mockResolvedValue(null);
  // This 404 is the MODULE's hidden not-found (mockStart resolves null), not
  // an access decision -- the gate is granted above. The gate's own refusal
  // is the next test.
  expect((await POST(bodyRequest('POST', { athlete_id: 'ath-other', protocol_id: 'p-1' }))).status).toBe(404);
  expect(mockAudit).not.toHaveBeenCalled();
});

test('a coach with no relationship to the athlete is refused before the ledger is read or written', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

  const read = await GET(new NextRequest('http://localhost/api/pilot/coach/intervention-executions?athlete_id=ath-not-mine'));
  expect(read.status).toBe(403);

  const write = await POST(bodyRequest('POST', { athlete_id: 'ath-not-mine', protocol_id: 'p-1' }));
  expect(write.status).toBe(403);

  expect(mockList).not.toHaveBeenCalled();
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});

test('an unfiltered read returns only executions whose athlete the caller may reach', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockList.mockResolvedValueOnce([
    { execution_id: 'ex-mine', athlete_id: 'ath-mine' },
    { execution_id: 'ex-theirs', athlete_id: 'ath-theirs' },
  ]);
  mockAccessible.mockResolvedValueOnce(new Set(['ath-mine']));

  const response = await GET(getRequest());

  expect(response.status).toBe(200);
  expect(mockAccessible).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: 'acct-1', role: 'coach' }),
    ['ath-mine', 'ath-theirs'],
  );
  const payload = (await response.json()) as { items: Array<{ execution_id: string }> };
  expect(payload.items.map((item) => item.execution_id)).toEqual(['ex-mine']);
});

test('an organization admin keeps organization-wide reach -- the route defers to the central contract', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
  // What an org admin may reach is assertActorCanAccessAthlete's decision
  // (access.test.ts: 'allows organization_admin when athlete belongs to their
  // organization'), and the route must not add a narrower rule of its own.
  mockAccess.mockResolvedValue(undefined);
  mockStart.mockResolvedValue({ execution_id: 'ex-1', protocol_id: 'p-1', athlete_id: 'ath-nobody-coaches' });

  const response = await POST(bodyRequest('POST', { athlete_id: 'ath-nobody-coaches', protocol_id: 'p-1' }));

  expect(response.status).toBe(200);
  expect(mockAccess).toHaveBeenCalledWith(
    expect.objectContaining({ role: 'organization_admin', organizationId: 'org-1' }),
    'ath-nobody-coaches',
  );
});

test('an invented exposure dimension, a fake adherence percentage, or a difficulty context is a 400', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  expect((await PATCH(bodyRequest('PATCH', {
    action: 'record', execution_id: 'ex-1', actual_exposure: { difficulty: 8.2 },
  }))).status).toBe(400);
  expect((await PATCH(bodyRequest('PATCH', {
    action: 'record', execution_id: 'ex-1', adherence: '82%',
  }))).status).toBe(400);
  expect((await PATCH(bodyRequest('PATCH', {
    action: 'record', execution_id: 'ex-1', trained_context: 'brutal',
  }))).status).toBe(400);
  expect(mockRecord).not.toHaveBeenCalled();
});

test('claimed deviations must be named, and a stop must say why -- refused at the route with the reason', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  expect((await PATCH(bodyRequest('PATCH', {
    action: 'record', execution_id: 'ex-1', adherence: 'delivered_with_deviations',
  }))).status).toBe(400);
  expect((await PATCH(bodyRequest('PATCH', {
    action: 'close', execution_id: 'ex-1', outcome: 'stopped',
  }))).status).toBe(400);
  expect(mockRecord).not.toHaveBeenCalled();
  expect(mockClose).not.toHaveBeenCalled();

  mockClose.mockResolvedValue({ execution_id: 'ex-1', adherence: 'under_delivered', lineage_id: 'ex-1', version: 1 });
  const response = await PATCH(bodyRequest('PATCH', {
    action: 'close', execution_id: 'ex-1', outcome: 'stopped',
    stop_change_reason: 'shoulder pain -- stopped early',
  }));
  expect(response.status).toBe(200);
  expect(mockClose).toHaveBeenCalledWith(expect.objectContaining({
    outcome: 'stopped', stopChangeReason: 'shoulder pain -- stopped early',
  }));
});

test('a correction without a reason is refused; with one it audits the supersession', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockCorrect.mockResolvedValue({ execution_id: 'ex-2', lineage_id: 'ex-1', version: 2 });

  expect((await PATCH(bodyRequest('PATCH', { action: 'correct', execution_id: 'ex-1' }))).status).toBe(400);
  expect(mockCorrect).not.toHaveBeenCalled();

  const response = await PATCH(bodyRequest('PATCH', {
    action: 'correct', execution_id: 'ex-1', correction_reason: 'miscounted rounds',
  }));
  expect(response.status).toBe(200);
  expect(mockCorrect).toHaveBeenCalledWith(expect.objectContaining({
    correctionReason: 'miscounted rounds', correctedByAccountId: 'acct-1',
  }));
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    details: expect.objectContaining({ action: 'correct', supersedes: 'ex-1', correction_reason: 'miscounted rounds' }),
  }));
});

test('a coach with no relationship to the execution\'s athlete cannot record, close, or correct it', async () => {
  // GET and POST gate on the athlete; PATCH did not, so a coach could mutate
  // any execution in the org by naming its id. The gate resolves the stored
  // execution's athlete and refuses before any action or audit.
  mockRequirePrincipal.mockResolvedValue({ accountId: 'acct-coach', role: 'coach', organizationId: 'org-a', athleteId: null } as PilotPrincipal);
  mockGetExecution.mockResolvedValue({ execution_id: 'ex-victim', athlete_id: 'ath-victim' });
  mockAccess.mockImplementation(async (_p: unknown, athleteId: string) => {
    if (athleteId === 'ath-victim') throw new Error('Forbidden: not your athlete');
  });

  for (const body of [
    { action: 'record', execution_id: 'ex-victim' },
    { action: 'close', execution_id: 'ex-victim', outcome: 'completed' },
    { action: 'correct', execution_id: 'ex-victim', correction_reason: 'x' },
  ]) {
    const response = await PATCH(bodyRequest('PATCH', body));
    expect(response.status).toBeGreaterThanOrEqual(400);
  }
  expect(mockAccess).toHaveBeenCalledWith(expect.anything(), 'ath-victim');
  expect(mockRecord).not.toHaveBeenCalled();
  expect(mockClose).not.toHaveBeenCalled();
  expect(mockCorrect).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});

test('a PATCH naming an execution id that does not exist in the org is a hidden 404', async () => {
  mockGetExecution.mockResolvedValue(null);
  const response = await PATCH(bodyRequest('PATCH', { action: 'record', execution_id: 'ex-nope' }));
  expect(response.status).toBe(404);
  expect(mockRecord).not.toHaveBeenCalled();
});

test('an unknown action is a 400', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  expect((await PATCH(bodyRequest('PATCH', { action: 'delete', execution_id: 'ex-1' }))).status).toBe(400);
});

// Lane L2, item two: the version the screen was showing reaches the module on
// all three writes; a caller that sends none passes none.
test('the version the screen loaded is handed to record, close and correct; without one, none is passed', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  const item = { execution_id: 'ex-1', lineage_id: 'ex-1', version: 1, adherence: 'unknown' };
  mockRecord.mockResolvedValue(item);
  mockClose.mockResolvedValue(item);
  mockCorrect.mockResolvedValue(item);

  const bodies = {
    record: { action: 'record', execution_id: 'ex-1', notes: 'n' },
    close: { action: 'close', execution_id: 'ex-1', outcome: 'completed' },
    correct: { action: 'correct', execution_id: 'ex-1', correction_reason: 'miscounted rounds' },
  };
  const mocks = { record: mockRecord, close: mockClose, correct: mockCorrect };

  for (const action of ['record', 'close', 'correct'] as const) {
    expect((await PATCH(bodyRequest('PATCH', { ...bodies[action], expected_row_version: ' 7001 ' }))).status).toBe(200);
    expect(mocks[action]).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRowVersion: '7001' }));

    expect((await PATCH(bodyRequest('PATCH', bodies[action]))).status).toBe(200);
    expect(mocks[action].mock.calls.at(-1)?.[0].expectedRowVersion).toBeUndefined();

    // null is "none named", the same as leaving it out.
    expect((await PATCH(bodyRequest('PATCH', { ...bodies[action], expected_row_version: null }))).status).toBe(200);
    expect(mocks[action].mock.calls.at(-1)?.[0].expectedRowVersion).toBeUndefined();

    // Sent, but not a version: refused, and the write is not attempted. Letting
    // it through as "none named" would save over the record unguarded.
    const callsBefore = mocks[action].mock.calls.length;
    for (const notAVersion of [7001, '  ', '', {}, true]) {
      const refused = await PATCH(bodyRequest('PATCH', { ...bodies[action], expected_row_version: notAVersion }));
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toMatch(/expected_row_version/);
    }
    expect(mocks[action].mock.calls.length).toBe(callsBefore);
  }
});

// F-135: a request key makes a repeated tap answer with the first execution.
describe('POST request_key (F-135)', () => {
  test('the key is passed to the module as sent; a start without one passes null', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockStart.mockResolvedValue({ execution_id: 'ex-1', protocol_id: 'p-1', protocol_version: 1, athlete_id: 'ath-1', decision_id: null });

    const key = ' tap-1 ';
    expect((await POST(bodyRequest('POST', { athlete_id: 'ath-1', protocol_id: 'p-1', request_key: key }))).status).toBe(200);
    expect(mockStart).toHaveBeenLastCalledWith(expect.objectContaining({ requestKey: key }));

    expect((await POST(bodyRequest('POST', { athlete_id: 'ath-1', protocol_id: 'p-1' }))).status).toBe(200);
    expect(mockStart).toHaveBeenLastCalledWith(expect.objectContaining({ requestKey: null }));
    expect(mockAudit).toHaveBeenCalledTimes(2);
  });

  test('a replay is answered with the first execution and replayed: true, and records no second audit event', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockStart.mockResolvedValue({
      execution_id: 'ex-first', protocol_id: 'p-1', protocol_version: 1, athlete_id: 'ath-1', decision_id: null, replayed: true,
    });

    const response = await POST(bodyRequest('POST', { athlete_id: 'ath-1', protocol_id: 'p-1', request_key: 'tap-1' }));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { item: Record<string, unknown>; replayed?: boolean };
    expect(payload.replayed).toBe(true);
    expect(payload.item.execution_id).toBe('ex-first');
    expect(payload.item).not.toHaveProperty('replayed');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a first start says nothing about replay', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockStart.mockResolvedValue({ execution_id: 'ex-new', protocol_id: 'p-1', protocol_version: 1, athlete_id: 'ath-1', decision_id: null });

    const payload = (await (await POST(bodyRequest('POST', { athlete_id: 'ath-1', protocol_id: 'p-1', request_key: 'tap-2' }))).json()) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('replayed');
    expect(mockAudit).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['blank', ''],
    ['all spaces', '   '],
    ['over 200 characters', 'k'.repeat(201)],
    ['holding a NUL', `tap${String.fromCharCode(0)}1`],
    ['not text', 12],
  ])('a key that is %s is refused before anything is written', async (_label, key) => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    const response = await POST(bodyRequest('POST', { athlete_id: 'ath-1', protocol_id: 'p-1', request_key: key }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/request_key/);
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a key of exactly 200 characters is accepted', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockStart.mockResolvedValue({ execution_id: 'ex-1', protocol_id: 'p-1', protocol_version: 1, athlete_id: 'ath-1', decision_id: null });
    const key = 'k'.repeat(200);
    expect((await POST(bodyRequest('POST', { athlete_id: 'ath-1', protocol_id: 'p-1', request_key: key }))).status).toBe(200);
    expect(mockStart).toHaveBeenLastCalledWith(expect.objectContaining({ requestKey: key }));
  });
});

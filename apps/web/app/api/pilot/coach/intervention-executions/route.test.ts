import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  closeExecution,
  correctExecution,
  recordExecutionFacts,
  startExecution,
} from '@/src/server/pilot/interventionExecutions';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

jest.mock('@/src/server/pilot/interventionExecutions', () => {
  const actual = jest.requireActual('@/src/server/pilot/interventionExecutions');
  return {
    ...actual,
    startExecution: jest.fn(),
    listExecutions: jest.fn().mockResolvedValue([]),
    recordExecutionFacts: jest.fn(),
    closeExecution: jest.fn(),
    correctExecution: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockStart = startExecution as jest.Mock;
const mockRecord = recordExecutionFacts as jest.Mock;
const mockClose = closeExecution as jest.Mock;
const mockCorrect = correctExecution as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

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
  expect((await POST(bodyRequest('POST', { athlete_id: 'ath-other', protocol_id: 'p-1' }))).status).toBe(404);
  expect(mockAudit).not.toHaveBeenCalled();
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

test('an unknown action is a 400', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  expect((await PATCH(bodyRequest('PATCH', { action: 'delete', execution_id: 'ex-1' }))).status).toBe(400);
});

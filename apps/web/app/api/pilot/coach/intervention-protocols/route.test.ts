import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  createProtocol,
  reviseProtocol,
  retireProtocol,
} from '@/src/server/pilot/interventionProtocols';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

jest.mock('@/src/server/pilot/interventionProtocols', () => {
  const actual = jest.requireActual('@/src/server/pilot/interventionProtocols');
  return {
    ...actual,
    createProtocol: jest.fn(),
    listProtocols: jest.fn(),
    reviseProtocol: jest.fn(),
    retireProtocol: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockCreate = createProtocol as jest.Mock;
const mockRevise = reviseProtocol as jest.Mock;
const mockRetire = retireProtocol as jest.Mock;
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

const CONTENT = {
  title: 'Round-3 endurance block',
  target_problem: 'fades in round 3',
  hypothesis: 'aerobic capacity limits round-3 output',
  intervention_description: 'constrained 3-round intervals, twice weekly',
  expected_outcome: 'round-3 work rate holds within 10% of round 1',
};

const bodyRequest = (method: 'POST' | 'PATCH', body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/coach/intervention-protocols', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const getRequest = () => new NextRequest('http://localhost/api/pilot/coach/intervention-protocols');

test('athletes and parents cannot author or read protocols -- staff intent only', async () => {
  for (const role of ['athlete', 'parent', 'platform_owner'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
    expect((await POST(bodyRequest('POST', CONTENT))).status).toBeGreaterThanOrEqual(400);
  }
  expect(mockCreate).not.toHaveBeenCalled();
});

test('a protocol is filed under the caller with the hypothesis fields carried and audited', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockCreate.mockResolvedValue({ protocol_id: 'p-1', lineage_id: 'p-1', version: 1, athlete_id: null });

  const response = await POST(bodyRequest('POST', {
    ...CONTENT,
    contradicting_evidence: 'round-3 output collapses identically at low RPE',
    intended_exposure: { rounds: 6, sessions: 2 },
  }));

  expect(response.status).toBe(200);
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
    organizationId: 'org-1',
    createdByAccountId: 'acct-1',
    hypothesis: 'aerobic capacity limits round-3 output',
    contradictingEvidence: 'round-3 output collapses identically at low RPE',
    intendedExposure: { rounds: 6, sessions: 2 },
  }));
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    event_type: 'create',
    entity_type: 'intervention_protocol',
    organization_id: 'org-1',
  }));
});

test('an invented exposure dimension or a dose scalar is a 400, not a stored metric', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  expect((await POST(bodyRequest('POST', { ...CONTENT, intended_exposure: { difficulty: 8.2 } }))).status).toBe(400);
  expect((await POST(bodyRequest('POST', { ...CONTENT, intended_exposure: { rounds: -2 } }))).status).toBe(400);
  expect(mockCreate).not.toHaveBeenCalled();
});

test('an athlete outside the organization is a hidden not-found, not a protocol', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockCreate.mockResolvedValue(null);

  expect((await POST(bodyRequest('POST', { ...CONTENT, athlete_id: 'ath-other-org' }))).status).toBe(404);
  expect(mockAudit).not.toHaveBeenCalled();
});

test('revise re-states full content and audits the supersession', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockRevise.mockResolvedValue({ protocol_id: 'p-2', lineage_id: 'p-1', version: 2 });

  const response = await PATCH(bodyRequest('PATCH', { action: 'revise', protocol_id: 'p-1', ...CONTENT }));

  expect(response.status).toBe(200);
  expect(mockRevise).toHaveBeenCalledWith(expect.objectContaining({ protocolId: 'p-1', revisedByAccountId: 'acct-1' }));
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    details: expect.objectContaining({ action: 'revise', supersedes: 'p-1' }),
  }));
});

test('an unknown action is a 400; retire routes and audits', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockRetire.mockResolvedValue({ protocol_id: 'p-1', lineage_id: 'p-1', version: 1 });

  expect((await PATCH(bodyRequest('PATCH', { action: 'delete', protocol_id: 'p-1' }))).status).toBe(400);

  const response = await PATCH(bodyRequest('PATCH', { action: 'retire', protocol_id: 'p-1' }));
  expect(response.status).toBe(200);
  expect(mockRetire).toHaveBeenCalledWith('org-1', 'p-1');
});

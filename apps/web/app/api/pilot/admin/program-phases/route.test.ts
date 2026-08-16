import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import { endPhase, startPhase } from '@/src/server/pilot/programPhases';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

jest.mock('@/src/server/pilot/programPhases', () => ({
  listPhases: jest.fn().mockResolvedValue([]),
  startPhase: jest.fn(),
  endPhase: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockStart = startPhase as jest.Mock;
const mockEnd = endPhase as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'admin',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const bodyRequest = (method: 'POST' | 'PATCH', body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/admin/program-phases', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const PHASE = { program_name: 'Youth Boxing', phase_name: 'Competition prep', started_on: '2026-03-01' };

test('coaches read phases but only admins declare them; athletes and parents have no path', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  expect((await GET(new NextRequest('http://localhost/api/pilot/admin/program-phases'))).status).toBe(200);
  expect((await POST(bodyRequest('POST', PHASE))).status).toBeGreaterThanOrEqual(400);

  for (const role of ['athlete', 'parent'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(new NextRequest('http://localhost/api/pilot/admin/program-phases'))).status).toBeGreaterThanOrEqual(400);
  }
  expect(mockStart).not.toHaveBeenCalled();
});

test('a phase needs a real date and name; starting one audits the declaration', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  expect((await POST(bodyRequest('POST', { ...PHASE, started_on: 'soon' }))).status).toBe(400);
  expect((await POST(bodyRequest('POST', { ...PHASE, phase_name: '  ' }))).status).toBe(400);
  expect(mockStart).not.toHaveBeenCalled();

  mockStart.mockResolvedValue({ phase_id: 'ph-1', ...PHASE });
  const response = await POST(bodyRequest('POST', PHASE));
  expect(response.status).toBe(200);
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    entity_type: 'program_phase',
    details: expect.objectContaining({ action: 'start_phase', phase_name: 'Competition prep' }),
  }));
});

test('a phase cannot begin before the phase it replaces -- the timeline never runs backwards', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockStart.mockResolvedValue(null);

  const response = await POST(bodyRequest('POST', { ...PHASE, started_on: '2025-01-01' }));
  expect(response.status).toBe(400);
  const payload = await response.json();
  expect(payload.error).toMatch(/must start after the current phase began/);
  expect(mockAudit).not.toHaveBeenCalled();
});

test('ending an already-closed or unknown phase is a hidden not-found', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockEnd.mockResolvedValue(null);

  expect((await PATCH(bodyRequest('PATCH', { phase_id: 'ph-gone', ended_on: '2026-05-31' }))).status).toBe(404);
  expect(mockAudit).not.toHaveBeenCalled();

  mockEnd.mockResolvedValue({ phase_id: 'ph-1', program_name: 'Youth Boxing', ended_on: '2026-05-31' });
  expect((await PATCH(bodyRequest('PATCH', { phase_id: 'ph-1', ended_on: '2026-05-31' }))).status).toBe(200);
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    details: expect.objectContaining({ action: 'end_phase' }),
  }));
});

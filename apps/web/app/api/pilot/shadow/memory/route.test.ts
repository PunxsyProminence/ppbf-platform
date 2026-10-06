// CL-C10 (2026-10-05 audit). The route answered 202 "pending_review" to every
// forget or replace request, and nothing ever reviewed or applied one. It now
// reports what was actually done: the correction is applied, and whether a
// remembered fact was removed. The removal itself is proven against real
// Postgres in shadowMemoryCorrection.pg.test.ts.

import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { submitMemoryCorrection } from '@/src/server/pilot/shadowConversations';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/shadowConversations', () => ({
  submitMemoryCorrection: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockSubmit = jest.mocked(submitMemoryCorrection);

const athlete: PilotPrincipal = {
  accountId: 'account-1',
  role: 'athlete',
  organizationId: 'org-1',
  athleteId: 'athlete-1',
  sessionToken: 'token',
  authProvider: 'ppbf_local',
};

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/pilot/shadow/memory', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(athlete);
});

describe('POST /api/pilot/shadow/memory', () => {
  test('forget is applied and the answer says the fact was removed', async () => {
    mockSubmit.mockResolvedValueOnce({ correctionId: 'c-1', status: 'applied', factRemoved: true });

    const response = await POST(postRequest({ factKey: 'stance', action: 'forget' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      correctionId: 'c-1',
      status: 'applied',
      action: 'forget',
      factRemoved: true,
      message: 'SHADOW no longer remembers this.',
    });
    expect(body.status).not.toBe('pending_review');
    expect(mockSubmit).toHaveBeenCalledWith({
      actor: athlete, factKey: 'stance', correctedValue: undefined, action: 'forget',
    });
  });

  test('replace says the old fact is gone and the new value is kept but not used', async () => {
    mockSubmit.mockResolvedValueOnce({ correctionId: 'c-2', status: 'applied', factRemoved: true });

    const response = await POST(postRequest({ factKey: 'stance', action: 'replace', correctedValue: 'southpaw' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({ status: 'applied', action: 'replace', factRemoved: true }));
    expect(body.message).toBe(
      'SHADOW no longer remembers the old value. Your correction is saved with your request; SHADOW does not use it in answers.',
    );
  });

  test('a fact that was not remembered is reported as such, not as removed', async () => {
    mockSubmit.mockResolvedValueOnce({ correctionId: 'c-3', status: 'applied', factRemoved: false });

    const response = await POST(postRequest({ factKey: 'weight_class', action: 'forget' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(expect.objectContaining({ status: 'applied', factRemoved: false }));
    expect(body.message).toBe('SHADOW had nothing remembered under that name, so nothing was removed.');
  });

  test('an unsupported action is still refused before anything is written', async () => {
    const response = await POST(postRequest({ factKey: 'stance', action: 'rewrite' }));

    expect(response.status).toBe(400);
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});

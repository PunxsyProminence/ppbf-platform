import { NextRequest } from 'next/server';

import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import {
  listActiveFormulaResults,
  saveFormulaObservation,
} from '@/src/server/pilot/formulas/repository';
import {
  recalculateForSupersededObservation,
  runStoredMvpFormula,
} from '@/src/server/pilot/formulas/runner';
import { requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { POST as postObservation } from './observations/route';
import { GET as getResults, POST as postResults } from './results/route';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});
jest.mock('@/src/server/pilot/shadowReadiness', () => ({
  assertShadowRuntimeReadiness: jest.fn(),
}));
jest.mock('@/src/server/pilot/formulas/repository', () => {
  const actual = jest.requireActual('@/src/server/pilot/formulas/repository');
  return {
    ...actual,
    saveFormulaObservation: jest.fn(),
    listActiveFormulaResults: jest.fn(),
  };
});
jest.mock('@/src/server/pilot/formulas/runner', () => {
  const actual = jest.requireActual('@/src/server/pilot/formulas/runner');
  return {
    ...actual,
    runStoredMvpFormula: jest.fn(),
    recalculateForSupersededObservation: jest.fn(),
  };
});

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockAssertAccess = jest.mocked(assertActorCanAccessAthlete);
const mockReadiness = jest.mocked(assertShadowRuntimeReadiness);
const mockSaveObservation = jest.mocked(saveFormulaObservation);
const mockListResults = jest.mocked(listActiveFormulaResults);
const mockRunFormula = jest.mocked(runStoredMvpFormula);
const mockRecalculate = jest.mocked(recalculateForSupersededObservation);

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'account-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'session-token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function jsonRequest(path: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validObservationBody = {
  athleteId: 'athlete-1',
  contextId: 'session-1',
  kind: 'session_rpe',
  value: 5,
  unit: 'rpe_0_10',
  dimensions: {},
  observedAt: '2026-07-28T10:00:00.000Z',
  idempotencyKey: 'client-request-1',
};

describe('formula API access and trust boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAssertAccess.mockResolvedValue(undefined);
    mockReadiness.mockResolvedValue(undefined);
    mockSaveObservation.mockImplementation(async (input) => ({
      observationId: 'observation-1',
      ...input,
      supersedesObservationId: input.supersedesObservationId ?? null,
    }));
    mockRecalculate.mockResolvedValue([]);
    mockRunFormula.mockResolvedValue({ results: [] });
    mockListResults.mockResolvedValue([]);
  });

  test('derives observation tenant and provenance from the authenticated principal', async () => {
    const response = await postObservation(jsonRequest(
      '/api/pilot/shadow/formulas/observations',
      {
        ...validObservationBody,
        organizationId: 'org-spoofed',
        source: {
          type: 'computer_vision',
          quality: 'verified',
          referenceId: 'spoofed-source',
        },
      },
    ));

    expect(response.status).toBe(200);
    expect(mockAssertAccess).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
      'athlete-1',
    );
    expect(mockSaveObservation).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      createdByAccountId: 'account-1',
      source: expect.objectContaining({
        type: 'imported',
        quality: 'moderate',
      }),
    }));
    const persistedSource = mockSaveObservation.mock.calls[0][0].source;
    expect(persistedSource.referenceId).not.toBe('spoofed-source');
  });

  test('does not write an observation when athlete access fails', async () => {
    mockAssertAccess.mockRejectedValueOnce(new Error('Forbidden: athlete outside scope'));
    const response = await postObservation(jsonRequest(
      '/api/pilot/shadow/formulas/observations',
      validObservationBody,
    ));
    expect(response.status).toBe(403);
    expect(mockSaveObservation).not.toHaveBeenCalled();
  });

  test('runs formulas only from stored observation ids in authenticated scope', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
    const response = await postResults(jsonRequest(
      '/api/pilot/shadow/formulas/results',
      {
        athleteId: 'athlete-1',
        formulaId: 'MVP-02',
        observationIds: ['punches', 'rounds', 'active'],
      },
    ));
    expect(response.status).toBe(200);
    expect(mockRunFormula).toHaveBeenCalledWith({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      formulaId: 'MVP-02',
      observationIds: ['punches', 'rounds', 'active'],
    });
  });

  test('allows scoped result reads but denies athlete-triggered calculations', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({
      role: 'parent',
      accountId: 'parent-1',
    }));
    const readResponse = await getResults(new NextRequest(
      'http://localhost/api/pilot/shadow/formulas/results?athleteId=athlete-1&formulaId=MVP-01',
    ));
    expect(readResponse.status).toBe(200);
    expect(mockListResults).toHaveBeenCalledWith({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      formulaId: 'MVP-01',
      limit: 50,
    });

    mockRequirePrincipal.mockResolvedValue(principal({
      role: 'athlete',
      athleteId: 'athlete-1',
    }));
    const writeResponse = await postResults(jsonRequest(
      '/api/pilot/shadow/formulas/results',
      {
        athleteId: 'athlete-1',
        formulaId: 'MVP-01',
        observationIds: ['rpe', 'duration'],
      },
    ));
    expect(writeResponse.status).toBe(403);
    expect(mockRunFormula).not.toHaveBeenCalled();
  });
});

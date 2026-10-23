// SHADOW F2 route: who reaches it, and what each answer means on the wire.
// The service is mocked here (shadowCoachRecommendation.test.ts covers it);
// requirePrincipal and the athlete-access check are mocked as the gates they
// are. StaleCoachDraftError stays real so the 409 mapping is the real class.

import { NextRequest } from 'next/server';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});
jest.mock('@/src/server/pilot/shadowReadiness', () => ({ assertShadowRuntimeReadiness: jest.fn() }));
jest.mock('@/src/server/pilot/shadowRateLimit', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowRateLimit');
  return { ...actual, enforceShadowRateLimit: jest.fn() };
});
jest.mock('@/src/server/pilot/shadowCoachRecommendation', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowCoachRecommendation');
  return {
    ...actual,
    getCoachDraftOrigins: jest.fn(),
    listCoachDraftChoices: jest.fn(),
    previewCoachDraft: jest.fn(),
    saveCoachDraft: jest.fn(),
  };
});

import { GET, POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotRole } from '@/src/server/pilot/contracts';
import { requirePrincipal } from '@/src/server/pilot/http';
import { enforceShadowRateLimit, ShadowRateLimitExceeded } from '@/src/server/pilot/shadowRateLimit';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import {
  CoachDraftUnavailableError,
  getCoachDraftOrigins,
  listCoachDraftChoices,
  previewCoachDraft,
  saveCoachDraft,
  StaleCoachDraftError,
} from '@/src/server/pilot/shadowCoachRecommendation';

const mockPrincipal = jest.mocked(requirePrincipal);
const mockAccess = jest.mocked(assertActorCanAccessAthlete);
const mockReadiness = jest.mocked(assertShadowRuntimeReadiness);
const mockChoices = jest.mocked(listCoachDraftChoices);
const mockOrigins = jest.mocked(getCoachDraftOrigins);
const mockPreview = jest.mocked(previewCoachDraft);
const mockSave = jest.mocked(saveCoachDraft);
const mockRateLimit = jest.mocked(enforceShadowRateLimit);

const URL_BASE = 'http://localhost/api/pilot/shadow/recommendations/draft';

function principal(role: PilotRole = 'coach'): PilotPrincipal {
  return {
    accountId: 'acct-coach', role, organizationId: 'gym-a', athleteId: null,
    sessionToken: 'session-token-a', authProvider: 'microsoft',
  } as PilotPrincipal;
}

function get(athleteId = 'ath-1') {
  return GET(new NextRequest(`${URL_BASE}?athleteId=${athleteId}`));
}

function post(body: Record<string, unknown>) {
  return POST(new NextRequest(URL_BASE, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }));
}

const draftBody = { action: 'draft', athleteId: 'ath-1', formulaResultId: 'res-1', coachQuestion: 'What next?' };
const saveBody = { action: 'save', athleteId: 'ath-1', previewToken: 'data.mac' };

beforeEach(() => {
  jest.clearAllMocks();
  mockPrincipal.mockResolvedValue(principal());
  mockAccess.mockResolvedValue(undefined);
  mockReadiness.mockResolvedValue(undefined as never);
  mockChoices.mockResolvedValue([]);
  mockOrigins.mockResolvedValue({});
  mockPreview.mockResolvedValue({ kind: 'abstain', reason: 'no_eligible_evidence' });
  mockRateLimit.mockResolvedValue(undefined);
});

describe('who reaches the F2 draft route', () => {
  it.each(['organization_admin', 'admin', 'athlete', 'parent', 'platform_owner', 'board', 'staff', 'volunteer'] as const)(
    '%s gets a plain 404 and no read, model call or write',
    async (role) => {
      mockPrincipal.mockResolvedValue(principal(role));
      for (const response of [await get(), await post(draftBody), await post(saveBody)]) {
        expect(response.status).toBe(404);
      }
      expect(mockAccess).not.toHaveBeenCalled();
      expect(mockChoices).not.toHaveBeenCalled();
      expect(mockPreview).not.toHaveBeenCalled();
      expect(mockSave).not.toHaveBeenCalled();
    },
  );

  it('a coach refused the athlete gets the same 404', async () => {
    mockAccess.mockRejectedValue(new Error('Forbidden: athlete does not belong to organization'));
    expect((await get()).status).toBe(404);
    expect((await post(draftBody)).status).toBe(404);
    expect(mockChoices).not.toHaveBeenCalled();
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it('an access check that FAILED (no database) is a server error, not "not found"', async () => {
    mockAccess.mockRejectedValue(new Error('connect ECONNREFUSED'));
    expect((await get()).status).toBe(500);
    expect((await post(draftBody)).status).toBe(500);
  });

  it('checks access for the athlete named in the request, as the signed-in principal', async () => {
    await post(draftBody);
    expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-coach', role: 'coach' }), 'ath-1');
  });
});

describe('what each answer means', () => {
  it('GET reads choices and saved origins, and checks the tables the origins read', async () => {
    mockOrigins.mockResolvedValue({
      'rec-1': {
        generatedBy: 'SHADOW', modelUsed: 'm', sourceFormulaResultId: 'res-1',
        citations: [], semanticSupportVerified: false,
      },
    });
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({ ok: true, choices: [], origins: expect.any(Object) }));
    expect(mockReadiness).toHaveBeenCalledWith({
      requiredTables: expect.arrayContaining(['shadow_recommendations', 'shadow_audit_entries']),
    });
  });

  it('a draft is signed with the session the principal was resolved from', async () => {
    mockPreview.mockResolvedValue({ kind: 'abstain', reason: 'no_eligible_evidence' });
    await post(draftBody);
    expect(mockPreview).toHaveBeenCalledWith(expect.objectContaining({
      sessionToken: 'session-token-a', athleteId: 'ath-1', resultId: 'res-1', question: 'What next?',
    }));
  });

  it.each([
    ['no_eligible_evidence', 422],
    ['no_supported_answer', 422],
    ['source_unavailable', 422],
    ['invalid_generated_candidate', 422],
    ['evidence_unavailable', 503],
    ['generation_unavailable', 503],
  ] as const)('abstention %s is %i with no preview in the body', async (reason, status) => {
    mockPreview.mockResolvedValue({ kind: 'abstain', reason });
    const response = await post(draftBody);
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toEqual({ ok: false, state: 'no_draft', reason });
  });

  it('a stale save is 409; a Library outage at save is 503; a save the service refuses is 404', async () => {
    mockSave.mockRejectedValueOnce(new StaleCoachDraftError());
    expect((await post(saveBody)).status).toBe(409);
    mockSave.mockRejectedValueOnce(new CoachDraftUnavailableError());
    expect((await post(saveBody)).status).toBe(503);
    mockSave.mockResolvedValueOnce(null);
    expect((await post(saveBody)).status).toBe(404);
  });

  it("a draft spends the coach's SHADOW chat buckets; over the limit it is 429 and no model call", async () => {
    await post(draftBody);
    expect(mockRateLimit.mock.calls.map(([input]) => input.endpointKey)).toEqual(['chat', 'chat_daily']);
    expect(mockRateLimit).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'gym-a', accountId: 'acct-coach' }));

    mockPreview.mockClear();
    mockRateLimit.mockRejectedValueOnce(new ShadowRateLimitExceeded(42, 'chat'));
    const limited = await post(draftBody);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('42');
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it('saving and reading do not spend the chat buckets', async () => {
    mockSave.mockResolvedValueOnce(null);
    await post(saveBody);
    await get();
    expect(mockRateLimit).not.toHaveBeenCalled();
  });

  it('refuses a malformed request before any service call', async () => {
    expect((await post({ ...draftBody, coachQuestion: '' })).status).toBe(400);
    expect((await post({ ...saveBody, previewToken: undefined })).status).toBe(400);
    expect((await post({ ...draftBody, action: 'publish' })).status).toBe(400);
    expect(mockPreview).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
  });
});

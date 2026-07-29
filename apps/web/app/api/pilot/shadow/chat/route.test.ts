import { NextRequest } from 'next/server';

import { POST, resolveShadowMaxCompletionTokens } from './route';
import { query } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { retrieveShadowContext, SHADOW_SAFE_FILTERED_RESPONSE } from '@/src/server/pilot/shadowChat';
import { getOrCreateShadowUserProfile, updateShadowUserProfile } from '@/src/server/pilot/shadowUserProfile';
import { getAzureAiRuntimeConfig, buildAzureAiChatCompletionsUrl } from '@/src/server/pilot/azureAiRuntime';
import { evaluateShadowUnlockState } from '@/src/server/pilot/shadowUnlocks';
import {
  appendConversationExchange,
  loadConversationMessages,
  queueHumanReview,
  resolveConversation,
} from '@/src/server/pilot/shadowConversations';
import { enforceShadowRateLimit } from '@/src/server/pilot/shadowRateLimit';
import { classifyRequest } from '@/src/server/pilot/shadowClassifier';
import { executeHeavyBagSync } from '@/src/server/pilot/shadowHeavyBag';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { retrieveShadowEvidenceBundle } from '@/src/server/pilot/shadowEvidence';
import { getBoardSummary } from '@/src/server/pilot/boardSummary';
import { getGrowthMetrics } from '@/src/server/pilot/shadowMetrics';
import {
  PLATFORM_SCOPE_UNAVAILABLE_CONTEXT,
  clearPlatformRollupCache,
  platformGymEvidenceId,
} from '@/src/server/pilot/omegaPlatformContext';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { ShadowRuntimeUnavailableError } from '@/src/server/pilot/shadowRuntimeError';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => ({
  requireRole: jest.fn(),
  assertActorCanAccessAthlete: jest.fn(),
}));

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
}));

jest.mock('@/src/server/pilot/shadowReadiness', () => ({
  assertShadowRuntimeReadiness: jest.fn(),
}));

jest.mock('@/src/server/pilot/shadowChat', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowChat');
  return { ...actual, retrieveShadowContext: jest.fn() };
});

jest.mock('@/src/server/pilot/shadowUserProfile', () => ({
  getOrCreateShadowUserProfile: jest.fn(),
  updateShadowUserProfile: jest.fn(),
}));

jest.mock('@/src/server/pilot/shadowClassifier', () => ({
  classifyRequest: jest.fn(() => ({
    tier: 'quick_round',
    complexity: 0.2,
    topic: 'general',
  })),
}));

jest.mock('@/src/server/pilot/shadowContextBuilder', () => ({
  buildShadowContext: jest.fn(() => ({
    context: 'Tier context for this authenticated user.',
    metadata: {
      tier: 'quick_round',
      topicType: 'general',
      contextItemCount: 1,
      totalWeight: 1,
      includesAthleteData: false,
      includesResearchRequirements: false,
    },
  })),
}));

jest.mock('@/src/server/pilot/shadowRouter', () => ({
  routeRequest: jest.fn(() => ({ model: { displayName: 'Test Model' } })),
  tierToSessionType: jest.fn(() => 'quick_round'),
  isAsyncSession: jest.fn(() => false),
}));

jest.mock('@/src/server/pilot/shadowProfiling', () => ({
  classifyProfileTier: jest.fn(() => ({
    tier: 'bronze',
    config: { label: 'Bronze' },
  })),
  buildPersonalizationPrompt: jest.fn(() => ''),
}));

jest.mock('@/src/server/pilot/shadowHeavyBag', () => ({
  executeHeavyBagSync: jest.fn(),
  executeHeavyBagAsync: jest.fn(),
  shouldRunAsync: jest.fn(() => false),
}));

jest.mock('@/src/server/pilot/shadowUnlocks', () => ({
  evaluateShadowUnlockState: jest.fn(),
  isFeatureEnabled: jest.fn(() => false),
  buildShadowUnlockHints: jest.fn(() => undefined),
}));

jest.mock('@/src/server/pilot/azureAiRuntime', () => ({
  getAzureAiRuntimeConfig: jest.fn(),
  buildAzureAiChatCompletionsUrl: jest.fn(),
}));

jest.mock('@/src/server/pilot/shadowConversations', () => ({
  resolveConversation: jest.fn(),
  appendConversationExchange: jest.fn(),
  assertConversationAccess: jest.fn(),
  loadConversationMessages: jest.fn(),
  queueHumanReview: jest.fn(),
}));

jest.mock('@/src/server/pilot/shadowRateLimit', () => ({
  enforceShadowRateLimit: jest.fn(),
  ShadowRateLimitExceeded: class ShadowRateLimitExceeded extends Error {},
}));

// The rollup's two leaf data sources. omegaPlatformContext itself is left REAL
// so these tests exercise the actual wiring -- trigger, render, evidence
// authorization -- rather than asserting that a mock was called.
jest.mock('@/src/server/pilot/boardSummary', () => ({ getBoardSummary: jest.fn() }));
jest.mock('@/src/server/pilot/shadowMetrics', () => ({ getGrowthMetrics: jest.fn() }));

jest.mock('@/src/server/pilot/shadowEvidence', () => ({
  retrieveShadowEvidenceBundle: jest.fn(),
  unavailableShadowEvidenceBundle: jest.fn(() => ({
    bundleId: null,
    availability: 'unavailable',
    items: [],
    allowedEvidenceIds: [],
    context: 'EVIDENCE UNAVAILABLE',
  })),
  publicEvidenceCitations: jest.fn((
    bundle: { items: Array<{
      evidenceId: string;
      token: string;
      sourceTitle: string;
      documentName: string;
    }> },
    citationIds: string[],
  ) => bundle.items
    .filter((item: { evidenceId: string }) => citationIds.includes(item.evidenceId))
    .map((item: {
      evidenceId: string;
      token: string;
      sourceTitle: string;
      documentName: string;
    }) => ({
      evidenceId: item.evidenceId,
      token: item.token,
      sourceTitle: item.sourceTitle,
      documentName: item.documentName,
    }))),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockQuery = jest.mocked(query);
const mockRetrieveShadowContext = jest.mocked(retrieveShadowContext);
const mockGetProfile = jest.mocked(getOrCreateShadowUserProfile);
const mockUpdateProfile = jest.mocked(updateShadowUserProfile);
const mockGetRuntime = jest.mocked(getAzureAiRuntimeConfig);
const mockBuildUrl = jest.mocked(buildAzureAiChatCompletionsUrl);
const mockEvaluateUnlocks = jest.mocked(evaluateShadowUnlockState);
const mockResolveConversation = jest.mocked(resolveConversation);
const mockAppendConversationExchange = jest.mocked(appendConversationExchange);
const mockLoadConversationMessages = jest.mocked(loadConversationMessages);
const mockQueueHumanReview = jest.mocked(queueHumanReview);
const mockEnforceRateLimit = jest.mocked(enforceShadowRateLimit);
const mockClassifyRequest = jest.mocked(classifyRequest);
const mockExecuteHeavyBagSync = jest.mocked(executeHeavyBagSync);
const mockRetrieveEvidence = jest.mocked(retrieveShadowEvidenceBundle);
const mockBoardSummary = jest.mocked(getBoardSummary);
const mockGrowthMetrics = jest.mocked(getGrowthMetrics);
const originalFetch = global.fetch;

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'account-1',
    role: 'coach',
    organizationId: 'org-session',
    athleteId: null,
    sessionToken: 'session-token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function postRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pilot/shadow/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockQuery.mockResolvedValue([]);
  mockRetrieveShadowContext.mockResolvedValue({
    authorized: true,
    context: 'Authorized role: coach. Authorized organization scope: org-session.',
  });
  mockGetProfile.mockResolvedValue({} as never);
  mockUpdateProfile.mockResolvedValue(undefined);
  mockEvaluateUnlocks.mockResolvedValue(null as never);
  mockResolveConversation.mockResolvedValue('conversation-1');
  mockAppendConversationExchange.mockResolvedValue('assistant-message-1');
  mockLoadConversationMessages.mockResolvedValue([]);
  mockQueueHumanReview.mockResolvedValue('review-1');
  mockEnforceRateLimit.mockResolvedValue(undefined);
  mockRetrieveEvidence.mockResolvedValue({
    bundleId: '00000000-0000-4000-8000-000000000200',
    availability: 'unavailable',
    items: [],
    allowedEvidenceIds: [],
    context: 'EVIDENCE UNAVAILABLE — no approved, verified, fully indexed evidence.',
  });
  mockGetRuntime.mockReturnValue({
    ok: true,
    missing: [],
    config: {
      endpoint: 'https://example.invalid',
      apiKey: 'test-key',
      deploymentName: 'test-deployment',
      apiVersion: '2024-12-01-preview',
    },
  });
  mockBuildUrl.mockReturnValue('https://example.invalid/chat/completions');
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('POST /api/pilot/shadow/chat trust boundary', () => {
  test('passes authenticated role and authorized context into the model prompt', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'RESEARCH NEEDED — no verified evidence was supplied.' } }] }),
    }) as unknown as typeof fetch;

    const response = await POST(postRequest({
      message: 'What does the evidence show?',
      organizationId: 'org-attacker',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.state).toBe('ok');
    expect(payload.messageId).toBe('assistant-message-1');
    expect(payload.conversationId).toBe('conversation-1');
    expect(mockRetrieveShadowContext).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'account-1',
      userRole: 'coach',
      organizationId: 'org-session',
      actorAthleteId: null,
    }));

    const requestInit = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    const providerBody = JSON.parse(String(requestInit.body));
    const systemPrompt = providerBody.messages[0].content as string;
    expect(systemPrompt).toContain('Authorized role: coach');
    expect(systemPrompt).toContain('Tier context for this authenticated user.');
    expect(systemPrompt).toContain('EVIDENCE UNAVAILABLE');
    expect(systemPrompt).toContain('Never invent citations, case counts, confidence values, or outcomes');
    expect(systemPrompt).not.toContain('org-attacker');
    expect(providerBody.max_completion_tokens).toBe(4096);
    expect(requestInit.signal).toBeDefined();
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(1, {
      organizationId: 'org-session',
      accountId: 'account-1',
      endpointKey: 'chat',
      limit: 20,
      windowSeconds: 60,
    });
    expect(mockEnforceRateLimit).toHaveBeenNthCalledWith(2, {
      organizationId: 'org-session',
      accountId: 'account-1',
      endpointKey: 'chat_daily',
      limit: 100,
      windowSeconds: 86_400,
    });
    expect(mockAppendConversationExchange).toHaveBeenCalledWith(expect.objectContaining({
      actor: expect.objectContaining({
        organizationId: 'org-session',
        accountId: 'account-1',
      }),
      conversationId: 'conversation-1',
      responseState: 'ok',
      evidence: {
        bundleId: '00000000-0000-4000-8000-000000000200',
        availability: 'unavailable',
        citationIds: [],
      },
    }));
    expect(JSON.stringify(mockQuery.mock.calls)).not.toContain('What does the evidence show?');
  });

  test('returns and persists only an exact citation from the retrieved bundle', async () => {
    const evidenceId = '00000000-0000-4000-8000-000000000201';
    mockRetrieveEvidence.mockResolvedValueOnce({
      bundleId: '00000000-0000-4000-8000-000000000200',
      availability: 'available',
      allowedEvidenceIds: [evidenceId],
      context: `Use [E:${evidenceId}] for the approved excerpt.`,
      items: [{
        evidenceId,
        token: `[E:${evidenceId}]`,
        sourceId: 'source-a',
        documentId: 'doc-a',
        chunkId: 'chunk-a',
        subjectId: null,
        sourceTitle: 'Approved source',
        documentName: 'Approved document',
        excerpt: 'Approved bounded excerpt.',
      }],
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: `Research suggests the approved drill may help. [E:${evidenceId}]`,
          },
        }],
      }),
    }) as unknown as typeof fetch;

    const response = await POST(postRequest({ message: 'What does approved research suggest?' }));
    const payload = await response.json();

    expect(payload.state).toBe('ok');
    expect(payload.citations).toEqual([{
      evidenceId,
      token: `[E:${evidenceId}]`,
      sourceTitle: 'Approved source',
      documentName: 'Approved document',
    }]);
    expect(mockAppendConversationExchange).toHaveBeenCalledWith(expect.objectContaining({
      evidence: {
        bundleId: '00000000-0000-4000-8000-000000000200',
        availability: 'available',
        citationIds: [evidenceId],
      },
    }));
  });

  test('filters a generated citation that was not in the exact retrieved bundle', async () => {
    const evidenceId = '00000000-0000-4000-8000-000000000201';
    const forgedId = '00000000-0000-4000-8000-000000000999';
    mockRetrieveEvidence.mockResolvedValueOnce({
      bundleId: '00000000-0000-4000-8000-000000000200',
      availability: 'available',
      allowedEvidenceIds: [evidenceId],
      context: `Use [E:${evidenceId}] for the approved excerpt.`,
      items: [{
        evidenceId,
        token: `[E:${evidenceId}]`,
        sourceId: 'source-a',
        documentId: 'doc-a',
        chunkId: 'chunk-a',
        subjectId: null,
        sourceTitle: 'Approved source',
        documentName: 'Approved document',
        excerpt: 'Approved bounded excerpt.',
      }],
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: `Research suggests this works. [E:${forgedId}]` },
        }],
      }),
    }) as unknown as typeof fetch;

    const response = await POST(postRequest({ message: 'What does approved research suggest?' }));
    const payload = await response.json();

    expect(payload.state).toBe('filtered');
    expect(payload.response).toBe(SHADOW_SAFE_FILTERED_RESPONSE);
    expect(payload.citations).toEqual([]);
    expect(mockAppendConversationExchange).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({ citationIds: [] }),
    }));
  });

  test('replaces unsafe provider output before returning it to the browser', async () => {
    const unsafeOutput = 'You have a concussion and should rest for 3 weeks.';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: unsafeOutput } }] }),
    }) as unknown as typeof fetch;

    const response = await POST(postRequest({ message: 'Explain this training concern.' }));
    const payload = await response.json();

    expect(payload.success).toBe(false);
    expect(payload.state).toBe('filtered');
    expect(payload.response).toBe(SHADOW_SAFE_FILTERED_RESPONSE);
    expect(payload.response).not.toContain(unsafeOutput);
    expect(mockUpdateProfile).not.toHaveBeenCalled();
    expect(mockAppendConversationExchange).toHaveBeenCalledWith(expect.objectContaining({
      assistantMessage: SHADOW_SAFE_FILTERED_RESPONSE,
      responseState: 'filtered',
    }));
  });

  test('passes only the authorized conversation history before the new user message', async () => {
    mockLoadConversationMessages.mockResolvedValueOnce([
      {
        messageId: '00000000-0000-4000-8000-000000000010',
        role: 'user',
        content: 'Explain the first drill.',
        responseState: null,
        createdAt: new Date().toISOString(),
      },
      {
        messageId: '00000000-0000-4000-8000-000000000011',
        role: 'assistant',
        content: 'The first answer was safely stored.',
        responseState: 'ok',
        createdAt: new Date().toISOString(),
      },
    ]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'RESEARCH NEEDED — context-aware response.' } }],
      }),
    }) as unknown as typeof fetch;

    const conversationId = '00000000-0000-4000-8000-000000000001';
    const response = await POST(postRequest({
      message: 'What did you mean by that?',
      conversationId,
    }));
    expect(response.status).toBe(200);
    expect(mockLoadConversationMessages).toHaveBeenCalledWith(expect.objectContaining({
      actor: expect.objectContaining({ accountId: 'account-1', organizationId: 'org-session' }),
      conversationId,
      limit: 10,
    }));
    const requestInit = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    const providerBody = JSON.parse(String(requestInit.body));
    expect(providerBody.messages.map((message: { role: string; content: string }) => message.role))
      .toEqual(['system', 'user', 'assistant', 'user']);
    expect(providerBody.messages[1].content).toBe('Explain the first drill.');
    expect(providerBody.messages[3].content).toBe('What did you mean by that?');
  });

  test('routes an authorized manual Heavy Bag request through the Heavy Bag provider', async () => {
    mockClassifyRequest.mockReturnValueOnce({
      tier: 'heavy_bag',
      complexity: 0.9,
      topic: 'strategy',
      confidence: 1,
      reasoning: 'User explicitly requested Heavy Bag session',
      requiresManualOverride: false,
      suggestedContextDepth: 'full',
    });
    mockExecuteHeavyBagSync.mockResolvedValueOnce({
      mode: 'sync',
      response: 'RESEARCH NEEDED — no verified evidence was supplied.',
      routing: { model: { displayName: 'Test Heavy Model' } } as never,
      sessionType: 'heavy_bag',
    });

    const response = await POST(postRequest({
      message: 'Analyze this planning trade-off.',
      tier: 'heavy_bag',
      sessionType: 'heavy_bag',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.state).toBe('ok');
    expect(payload.sessionType).toBe('heavy_bag');
    expect(mockExecuteHeavyBagSync).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionType: 'heavy_bag',
        role: 'coach',
      }),
      'https://example.invalid',
      'test-key',
    );
    expect(global.fetch).toBe(originalFetch);
  });

  test('returns a degraded state and never reads or logs a provider response body', async () => {
    const providerText = jest.fn(async () => 'SECRET_PROVIDER_BODY');
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: providerText,
    }) as unknown as typeof fetch;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(postRequest({ message: 'What should we review today?' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(false);
    expect(payload.state).toBe('degraded');
    expect(payload.response).toContain('temporarily unavailable');
    expect(providerText).not.toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('SECRET_PROVIDER_BODY');
    expect(mockUpdateProfile).not.toHaveBeenCalled();
    expect(mockResolveConversation).not.toHaveBeenCalled();
    expect(mockAppendConversationExchange).not.toHaveBeenCalled();
  });

  test('returns an explicit filtered state when athlete context is unauthorized', async () => {
    mockRetrieveShadowContext.mockResolvedValueOnce({
      authorized: false,
      context: '',
      reason: 'Not authorized to access this athlete context.',
    });

    const response = await POST(postRequest({
      message: 'Show me this athlete.',
      athleteId: 'athlete-other',
    }));
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.success).toBe(false);
    expect(payload.state).toBe('filtered');
    expect(global.fetch).toBe(originalFetch);
  });
});

describe('SHADOW chat readiness guard', () => {
  // Production was missing shadow_rate_limit_buckets, shadow_chat_sessions and
  // shadow_chat_messages. Because chat had no readiness guard, the very first
  // write -- the rate-limit bucket insert -- raised Postgres 42P01, which
  // jsonError rendered as a generic 500. Every SHADOW chat request failed, and
  // the cause was invisible in the response. These assertions keep chat from
  // regressing back to an opaque failure.
  const mockReadiness = jest.mocked(assertShadowRuntimeReadiness);

  test('returns 503, not 500, when the SHADOW schema is not migrated', async () => {
    mockReadiness.mockRejectedValueOnce(new ShadowRuntimeUnavailableError({
      missingTables: ['shadow_rate_limit_buckets', 'shadow_chat_sessions'],
    }));

    const response = await POST(postRequest({ message: 'How do I improve footwork?' }));

    expect(response.status).toBe(503);
  });

  test('does not disclose missing table names to the caller', async () => {
    mockReadiness.mockRejectedValueOnce(new ShadowRuntimeUnavailableError({
      missingTables: ['shadow_rate_limit_buckets'],
    }));

    const response = await POST(postRequest({ message: 'How do I improve footwork?' }));

    expect(JSON.stringify(await response.json())).not.toContain('shadow_rate_limit_buckets');
  });

  test('fails before touching the rate limiter', async () => {
    // The guard has to run before the first write, otherwise it cannot prevent
    // the 42P01 it exists to convert into an honest status. enforceShadowRateLimit
    // is that first write, so this ordering assertion is the whole point.
    mockReadiness.mockRejectedValueOnce(new ShadowRuntimeUnavailableError({
      missingTables: ['shadow_rate_limit_buckets'],
    }));

    await POST(postRequest({ message: 'How do I improve footwork?' }));

    expect(mockEnforceRateLimit).not.toHaveBeenCalled();
  });

  test('requires the tables whose writes are not catch-wrapped', async () => {
    await POST(postRequest({ message: 'How do I improve footwork?' }));

    expect(mockReadiness).toHaveBeenCalledWith({
      requiredTables: expect.arrayContaining([
        'shadow_rate_limit_buckets',
        'shadow_user_profiles',
        'shadow_chat_sessions',
        'shadow_chat_messages',
      ]),
    });
  });
});

describe('SHADOW completion-token budget', () => {
  test.each([
    [undefined, 4096],
    ['', 4096],
    ['not-a-number', 4096],
    ['64', 256],
    ['1025.9', 1025],
    ['99999', 8192],
  ])('bounds %p to %p tokens', (raw, expected) => {
    expect(resolveShadowMaxCompletionTokens(raw)).toBe(expected);
  });

  // Measured, not guessed. The configured gpt-5-mini deployment spent all 1024
  // tokens of the old default on reasoning and returned no content at all, so
  // every SHADOW turn came back degraded; at 2048 it truncated mid-sentence. The
  // observed peak was 2054 completion tokens, so the default must clear it with
  // room to spare or long answers get cut off.
  test('the default clears the measured peak completion spend', () => {
    expect(resolveShadowMaxCompletionTokens(undefined)).toBeGreaterThan(2054);
  });

  test('the ceiling can be raised past the default without a code change', () => {
    expect(resolveShadowMaxCompletionTokens('6000')).toBe(6000);
  });
});

// The Omega cross-organization path had unit coverage on both ends -- the
// renderer and the validator -- but nothing asserting the route actually joins
// them. These cover the four outcomes that matter: no other role can reach the
// block, an in-scope question gets it, an out-of-scope one does not, and a
// failed rollup is disclosed rather than silently dropped.
describe('Omega cross-organization breadth', () => {
  const CROSS_GYM_QUESTION = 'How are all the gyms doing this month?';

  function boardSummaryFixture() {
    return {
      scope: 'organization_aggregate',
      minimumCohortSize: 5,
      generatedAt: '2026-07-28T00:00:00.000Z',
      activeAthletes: { status: 'available', count: 12 },
      trainingSessions30Days: { status: 'available', count: 40, completedCount: 30, completionRate: 0.75 },
      goalStatusBuckets: {
        active: { status: 'available', count: 6 },
        completed: { status: 'available', count: 2 },
        other: { status: 'available', count: 1 },
      },
      coachReviews30Days: { status: 'available', count: 9, approvedCount: 8, approvalRate: 0.888 },
    };
  }

  function growthFixture() {
    return {
      period: '30d',
      totalInteractions: 17,
      avgSatisfaction: null,
      avgEffectiveness: null,
      recommendationsMade: 0,
      researchRequirementsCreated: 0,
      researchRequirementsClosed: 0,
      newLibraryPatterns: 0,
      filterRate: null,
      positiveOutcomeRate: null,
      unavailableReasons: {},
    };
  }

  /** Only the organization listing is answered; every other query stays empty. */
  function organizationsResolve(rows: unknown[]) {
    mockQuery.mockImplementation(async (sql: string) => (
      sql.includes('pilot.organizations') ? rows : []
    ) as never);
  }

  function organizationsReject(error: Error) {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pilot.organizations')) throw error;
      return [] as never;
    });
  }

  function respondWith(content: string) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    }) as unknown as typeof fetch;
  }

  function systemPrompt(): string {
    const requestInit = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    return JSON.parse(String(requestInit.body)).messages[0].content as string;
  }

  beforeEach(() => {
    // The rollup memo is module-level and would otherwise survive between tests.
    clearPlatformRollupCache();
    mockRequirePrincipal.mockResolvedValue(principal({
      role: 'platform_owner',
      organizationId: 'org-platform',
    }));
    mockRetrieveShadowContext.mockResolvedValue({
      authorized: true,
      context: 'Authorized role: platform_owner.',
    });
    mockBoardSummary.mockResolvedValue(boardSummaryFixture() as never);
    mockGrowthMetrics.mockResolvedValue(growthFixture() as never);
    organizationsResolve([
      { organization_id: 'gym-a', organization_name: 'Alpha Boxing', status: 'active', total_count: '1' },
    ]);
    respondWith('Nothing further to report.');
  });

  test('renders the rollup and authorizes its evidence token for the platform owner', async () => {
    const response = await POST(postRequest({ message: CROSS_GYM_QUESTION }));

    expect(response.status).toBe(200);
    const prompt = systemPrompt();
    expect(prompt).toContain('PLATFORM-WIDE CONTEXT (OMEGA SCOPE)');
    expect(prompt).toContain('Alpha Boxing');
    expect(prompt).toContain('active athletes: 12');
    expect(prompt).toContain(`[E:${platformGymEvidenceId('gym-a')}]`);
    expect(prompt).not.toContain('OMEGA SCOPE): UNAVAILABLE');
  });

  // The reason the citable-id design exists: without an authorized token the
  // validator discards every cross-gym answer as an uncited quantity.
  test('a cited cross-gym figure survives response validation', async () => {
    respondWith(`Alpha Boxing has 12 athletes [E:${platformGymEvidenceId('gym-a')}].`);

    const payload = await (await POST(postRequest({ message: CROSS_GYM_QUESTION }))).json();

    expect(payload.state).toBe('ok');
    expect(payload.response).toContain('12 athletes');
    expect(payload.response).not.toBe(SHADOW_SAFE_FILTERED_RESPONSE);
  });

  // Platform ids are authorized for validation only. They are not rows in the
  // evidence bundle, so persisting them would record a citation to an item the
  // evidence tables have never heard of.
  test('does not persist a platform token as an evidence-bundle citation', async () => {
    respondWith(`Alpha Boxing has 12 athletes [E:${platformGymEvidenceId('gym-a')}].`);

    await POST(postRequest({ message: CROSS_GYM_QUESTION }));

    expect(mockAppendConversationExchange).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({ citationIds: [] }),
    }));
  });

  test('no other role reaches the block, even asking the same question', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
    mockRetrieveShadowContext.mockResolvedValue({
      authorized: true,
      context: 'Authorized role: organization_admin.',
    });

    await POST(postRequest({ message: CROSS_GYM_QUESTION }));

    expect(systemPrompt()).not.toContain('PLATFORM-WIDE CONTEXT');
    expect(mockBoardSummary).not.toHaveBeenCalled();
  });

  test('a single-gym question from the platform owner costs no fan-out', async () => {
    await POST(postRequest({ message: 'How is my gym doing this month?' }));

    expect(systemPrompt()).not.toContain('PLATFORM-WIDE CONTEXT');
    expect(mockBoardSummary).not.toHaveBeenCalled();
  });

  // Dropping the block on failure left the model answering a cross-gym question
  // from its single-gym persona with no sign anything was missing.
  test('discloses a failed rollup instead of answering as though nothing is missing', async () => {
    organizationsReject(new Error('db unreachable'));
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(postRequest({ message: CROSS_GYM_QUESTION }));

    expect(response.status).toBe(200);
    const prompt = systemPrompt();
    expect(prompt).toContain(PLATFORM_SCOPE_UNAVAILABLE_CONTEXT);
    expect(prompt).toContain('Do NOT substitute this gym\'s own figures');
    expect(prompt).not.toContain('Alpha Boxing');
  });

  test('discloses an empty rollup the same way, rather than rendering nothing', async () => {
    organizationsResolve([]);

    await POST(postRequest({ message: CROSS_GYM_QUESTION }));

    expect(systemPrompt()).toContain('OMEGA SCOPE): UNAVAILABLE');
  });
});

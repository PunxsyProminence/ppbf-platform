// Async/sync safety parity for background Heavy Bag completions
// (SHADOW_JOBS_ROUTING_EVIDENCE_AUDIT_2026-07-31 findings A2, A3, A5).
// The response validator runs REAL here -- these tests pin what the deployed
// worker persists, not what a mocked validator was told to say.

import { processNextShadowJob } from './shadowJobProcessor';
import { claimNextJob, completeJob, failJob, type ShadowJob } from './shadowJobQueue';
import { queryOne } from './db';
import { appendAssistantMessage, queueHumanReview } from './shadowConversations';

jest.mock('./shadowJobQueue', () => ({
  claimNextJob: jest.fn(),
  completeJob: jest.fn(),
  failJob: jest.fn(),
}));
jest.mock('./db', () => ({
  queryOne: jest.fn(),
}));
jest.mock('./shadowConversations', () => ({
  appendAssistantMessage: jest.fn(),
  queueHumanReview: jest.fn(),
}));
jest.mock('./azureAiRuntime', () => ({
  getAzureAiRuntimeConfig: jest.fn(() => ({
    ok: true,
    config: { endpoint: 'https://ai.test', apiKey: 'k', deploymentName: 'd', apiVersion: 'v' },
  })),
  buildAzureAiChatCompletionsUrl: jest.fn(() => 'https://ai.test/chat'),
}));

const mockClaimNextJob = jest.mocked(claimNextJob);
const mockCompleteJob = jest.mocked(completeJob);
const mockFailJob = jest.mocked(failJob);
const mockQueryOne = jest.mocked(queryOne);
const mockAppendAssistantMessage = jest.mocked(appendAssistantMessage);
const mockQueueHumanReview = jest.mocked(queueHumanReview);

const LIBRARY_ID = '11111111-1111-4111-8111-111111111111';
const NEAR_MISS_ID = '22222222-2222-4222-8222-222222222222';
const BUNDLE_ID = '33333333-3333-4333-8333-333333333333';

function heavyBagJob(): ShadowJob {
  return {
    jobId: '7339777f-97cc-4c64-aa87-56ea042d06ac',
    jobType: 'heavy_bag_session',
    organizationId: 'org-1',
    accountId: 'account-1',
    subjectId: null,
    role: 'coach',
    status: 'running',
    inputPayload: {
      message: 'How can our footwork rotation improve?',
      authorizedContext: 'Recorded gym context for this coach.',
      conversationId: 'c0ffee00-1111-4222-8333-444444444444',
      evidenceSnapshot: {
        bundleId: BUNDLE_ID,
        availability: 'available',
        // Near-miss ids are authorized for validation (the prompt carries
        // that context) but are NOT library evidence -- only the catalog id
        // may be persisted against the bundle.
        allowedEvidenceIds: [LIBRARY_ID, NEAR_MISS_ID],
        citationCatalog: [{
          evidenceId: LIBRARY_ID,
          token: 'E1',
          sourceTitle: 'Punxsy Manual',
          documentName: 'Footwork',
          authorityTier: 3,
          evidenceClass: 'VERIFIED EVIDENCE',
          boxingSpecificity: 'boxing_specific',
        }],
      },
    },
    outputPayload: null,
    errorCode: null,
    safetyStatus: 'pending',
    priority: 3,
    retryCount: 0,
    maxRetries: 3,
    leaseToken: '4cbf3128-e04f-40ac-884f-401410b9c4cb',
    leaseExpiresAt: '2026-07-31T12:05:00.000Z',
    createdAt: '2026-07-31T12:00:00.000Z',
    startedAt: '2026-07-31T12:00:01.000Z',
    completedAt: null,
    expiresAt: '2026-08-01T12:00:00.000Z',
  };
}

function llmReply(content: string): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  }) as unknown as typeof fetch;
}

describe('background Heavy Bag completion parity with the synchronous path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryOne.mockResolvedValue({
      role: 'coach',
      athlete_id: null,
      is_platform_owner: false,
      organization_status: 'active',
    });
    mockCompleteJob.mockResolvedValue(undefined);
    mockFailJob.mockResolvedValue(undefined);
    mockAppendAssistantMessage.mockResolvedValue('assistant-msg-1');
    mockQueueHumanReview.mockResolvedValue('review-1');
  });

  test('persists only library citation ids against the bundle; near-miss ids stay prose', async () => {
    mockClaimNextJob.mockResolvedValue(heavyBagJob());
    llmReply(`The rotation the gym already logged supports a tighter pivot drill. [E:${LIBRARY_ID}] [E:${NEAR_MISS_ID}] RESEARCH NEEDED.`);

    const result = await processNextShadowJob();

    expect(result.processed).toBe(true);
    expect(result.error).toBeUndefined();
    // Persisting the near-miss id against the library bundle made the
    // citation insert throw SHADOW_EVIDENCE_CITATION_NOT_FOUND and lose the
    // user's answer entirely.
    expect(mockAppendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
      responseState: 'ok',
      evidence: expect.objectContaining({ citationIds: [LIBRARY_ID] }),
    }));
    const completedOutput = mockCompleteJob.mock.calls[0][1] as Record<string, unknown>;
    expect(completedOutput.citations).toEqual([
      expect.objectContaining({ evidenceId: LIBRARY_ID }),
    ]);
    // Exactly one LIBRARY citation backs this answer -- the near-miss id is
    // authorized for validation but is not evidence, so it must not count
    // toward the tier (the same audit-F3 class of bug the synchronous path
    // was already fixed for: counting an authorized-but-non-library id
    // toward the grade). The fixture's one real citation is VERIFIED
    // EVIDENCE at authority tier 3, which grades EMERGING.
    expect(completedOutput.evidenceTier).toBe('EMERGING');
    expect(completedOutput.resultStatus).toBe('ok');
    // Benign answer: no banner, no review ticket.
    expect(mockAppendAssistantMessage).toHaveBeenCalledWith(
      expect.objectContaining({ handoff: undefined }),
    );
    expect(mockQueueHumanReview).not.toHaveBeenCalled();
  });

  test('a volunteered weight-cut directive persists with the weight-cut handoff banner and queues review', async () => {
    mockClaimNextJob.mockResolvedValue(heavyBagJob());
    llmReply('Cut water weight by sitting in a sauna the night before weigh-in.');

    const result = await processNextShadowJob();

    expect(result.processed).toBe(true);
    // The sync path stores this banner; background answers stored none.
    expect(mockAppendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
      responseState: 'filtered',
      handoff: expect.stringContaining('medical team and sports nutritionist'),
    }));
    expect(mockQueueHumanReview).toHaveBeenCalled();
  });

  test('an unfiltered answer that requires human review still queues a review ticket', async () => {
    mockClaimNextJob.mockResolvedValue(heavyBagJob());
    llmReply('A licensed physician should evaluate readiness before the next bout. RESEARCH NEEDED.');

    const result = await processNextShadowJob();

    expect(result.processed).toBe(true);
    // Sync queues on requiresHumanReview even when not filtered; async
    // queued only on filtered, so this answer displayed with no reviewer
    // ever seeing it.
    expect(mockQueueHumanReview).toHaveBeenCalled();
    expect(mockAppendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
      handoff: expect.any(String),
    }));
  });

  test('a review-queue write failure is retried, not thrown into failJob', async () => {
    mockClaimNextJob.mockResolvedValue(heavyBagJob());
    llmReply('Cut water weight by sitting in a sauna the night before weigh-in.');
    mockQueueHumanReview
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('review-1');

    const result = await processNextShadowJob();

    expect(result.processed).toBe(true);
    expect(result.error).toBeUndefined();
    expect(mockQueueHumanReview).toHaveBeenCalledTimes(2);
    // The job completed before the review write; a throw here would have
    // routed a completed job into failJob.
    expect(mockFailJob).not.toHaveBeenCalled();
  });
});

/* THE BUDGET THE JOB ASKS FOR, AND WHAT IT DOES WHEN THE BUDGET RUNS OUT.
   ------------------------------------------------------------------------

   Staging gate run 33019214969 failed with SHADOW_AI_EMPTY_RESPONSE on the
   background Heavy Bag job while the SYNCHRONOUS Heavy Bag passed on the same
   run. That asymmetry was the clue: the synchronous path takes its ceiling
   from the per-model registry (16384 for the heavy tier), and this file
   hardcoded 4096.

   shadowRouter.ts measured these deployments on 2026-07-29 and every one of
   them produced MORE completion tokens than 4096 -- the smallest, luna, came
   in at 4110. Reasoning tokens are spent from the same budget, so gpt-5's
   2560 reasoning alone exceeded the 2048 the two JSON jobs asked for.

   So the failure was never a flake. The jobs were provisioned below the
   platform's own measured floor and succeeded only when a model happened to
   finish short. Nothing asserted the budget, so nothing failed until a real
   answer ran long against a real deployment. */
describe('background jobs ask for a budget a real answer fits in', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryOne.mockResolvedValue({
      role: 'coach',
      athlete_id: null,
      is_platform_owner: false,
      organization_status: 'active',
    } as never);
  });

  /** The worst completion length shadowRouter measured, across all four
      deployments (gpt-5: 6352 tokens). A ceiling at or below this is a job
      that fails whenever the model answers at its measured typical length. */
  const WORST_MEASURED_COMPLETION_TOKENS = 6352;

  function requestedMaxCompletionTokens(): number {
    const mockFetch = jest.mocked(global.fetch);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const init = mockFetch.mock.calls[0][1];
    const body = JSON.parse(String(init?.body)) as { max_completion_tokens?: number };
    expect(typeof body.max_completion_tokens).toBe('number');
    return body.max_completion_tokens as number;
  }

  test('Heavy Bag asks for more than the longest answer any deployment measured', async () => {
    mockClaimNextJob.mockResolvedValue(heavyBagJob());
    llmReply('Rotate the lead foot before the hand lands.');

    await processNextShadowJob();

    // Strictly greater, not >=: a ceiling exactly at the measured length
    // leaves zero headroom for a prompt that reasons longer than the sample.
    expect(requestedMaxCompletionTokens()).toBeGreaterThan(WORST_MEASURED_COMPLETION_TOKENS);
  });

  test('an empty answer that ran out of budget is not reported as an empty answer', async () => {
    mockClaimNextJob.mockResolvedValue(heavyBagJob());
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      // What a reasoning deployment returns when reasoning consumed the whole
      // ceiling: HTTP 200, a choice, no content, finish_reason 'length'.
      json: async () => ({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
    }) as unknown as typeof fetch;

    const result = await processNextShadowJob();

    // The distinction is the point. Both used to be SHADOW_AI_EMPTY_RESPONSE,
    // so the job row recorded the symptom and lost the cause -- and an
    // operator could not tell "the provider returned nothing" from "we
    // refused to pay for the answer we asked for". Those want opposite fixes.
    expect(result.error).toBe('SHADOW_AI_BUDGET_EXHAUSTED');
    expect(mockFailJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: heavyBagJob().jobId }),
      'SHADOW_AI_BUDGET_EXHAUSTED',
    );
  });

  test('an empty answer that did NOT run out of budget still reports empty', async () => {
    mockClaimNextJob.mockResolvedValue(heavyBagJob());
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '   ' }, finish_reason: 'stop' }] }),
    }) as unknown as typeof fetch;

    const result = await processNextShadowJob();

    // Without this case the new branch could swallow every empty response and
    // the two tests above would both still pass.
    expect(result.error).toBe('SHADOW_AI_EMPTY_RESPONSE');
  });
});

// ---------------------------------------------------------------------------
// Board summary: the authority gate, and what a refusal costs.
//
// executeBoardSummaryJob has always refused anyone outside BOARD_SUMMARY_ROLES.
// What it could not do was refuse them EARLY: MANUAL_OVERRIDE_ROLES includes
// coach, so a coach's board_summary request was honored at the chat boundary
// and the refusal arrived here, in a background worker, against a job row that
// had already been written. The request boundary now refuses first -- these
// tests cover the rows that were queued before it did, and are the reason a
// scope refusal must not be retried.
// ---------------------------------------------------------------------------

function boardSummaryJob(role: ShadowJob['role']): ShadowJob {
  return {
    ...heavyBagJob(),
    jobId: '9f1d5a21-0c44-4c7e-9a2b-8f3e6d705c11',
    jobType: 'board_summary',
    role,
    inputPayload: {
      requestMode: 'chat',
      authenticatedRole: role,
      authorizedContext: 'Authorized organization context for this board summary.',
      message: 'Summarize governance items for the board.',
      conversationId: 'c0ffee00-1111-4222-8333-444444444444',
    },
  };
}

describe('board summary scope refusal', () => {
  // processNextShadowJob revalidates the actor's CURRENT role against the role
  // stored on the job and throws SHADOW_JOB_AUTHORIZATION_CHANGED when they
  // differ. A fixed 'coach' revalidation here made the admin /
  // organization_admin / platform_owner cases die at that earlier gate, so they
  // passed "not refused by the scope gate" without ever reaching the scope gate
  // -- green for the wrong reason, proving nothing. The revalidated role now
  // matches the job's role, and each test asserts it got past that gate.
  function revalidateAs(role: ShadowJob['role']): void {
    mockQueryOne.mockResolvedValue({
      role,
      athlete_id: null,
      is_platform_owner: role === 'platform_owner',
      organization_status: 'active',
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    revalidateAs('coach');
    mockCompleteJob.mockResolvedValue(undefined);
    mockFailJob.mockResolvedValue(undefined);
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  test('a queued coach board summary fails TERMINALLY, not into the retry budget', async () => {
    mockClaimNextJob.mockResolvedValue(boardSummaryJob('coach'));

    const result = await processNextShadowJob();

    expect(result.error).toBe('SHADOW_JOB_SCOPE_FORBIDDEN');
    // The third argument is the whole point. Without it the row goes back to
    // 'pending' and the same verdict is recomputed on every retry, each one
    // re-claiming a lease the worker could spend on real work.
    expect(mockFailJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: '9f1d5a21-0c44-4c7e-9a2b-8f3e6d705c11' }),
      'SHADOW_JOB_SCOPE_FORBIDDEN',
      { retryable: false },
    );
    expect(mockCompleteJob).not.toHaveBeenCalled();
  });

  test('a refused board summary never reaches the model', async () => {
    mockClaimNextJob.mockResolvedValue(boardSummaryJob('coach'));

    await processNextShadowJob();

    // A scope refusal that still paid for a completion would be a refusal in
    // name only -- the governance content would have been generated and then
    // thrown away, and the organization billed for it.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each(['admin', 'organization_admin', 'platform_owner'] as const)(
    '%s reaches board summary execution rather than the scope gate',
    async (role) => {
      mockClaimNextJob.mockResolvedValue(boardSummaryJob(role));
      revalidateAs(role);
      llmReply('Board summary: nothing requires board attention.');

      const result = await processNextShadowJob();

      expect(result.error).not.toBe('SHADOW_JOB_SCOPE_FORBIDDEN');
      // The gate that used to swallow these. Asserting its absence is what
      // makes the assertion above mean "passed the scope gate" rather than
      // "died before it".
      expect(result.error).not.toBe('SHADOW_JOB_AUTHORIZATION_CHANGED');
      // Positive proof of reach: an authorized board summary actually calls
      // the provider and completes.
      expect(global.fetch).toHaveBeenCalled();
      expect(mockCompleteJob).toHaveBeenCalled();
      expect(mockFailJob).not.toHaveBeenCalled();
    },
  );

  // The other half of the classification, and the one a careless fix breaks:
  // marking every failure terminal would turn one flaky provider call into a
  // permanently dead job. Only the scope verdict is terminal.
  test('a transient provider failure on an AUTHORIZED board summary stays retryable', async () => {
    mockClaimNextJob.mockResolvedValue(boardSummaryJob('admin'));
    revalidateAs('admin');
    const fetchSpy = jest.fn().mockRejectedValue(new Error('socket hang up'));
    global.fetch = fetchSpy as unknown as typeof fetch;

    await processNextShadowJob();

    // The failure must be the PROVIDER's, not an earlier gate's -- otherwise
    // this proves retryability of the wrong error.
    expect(fetchSpy).toHaveBeenCalled();
    expect(mockFailJob).toHaveBeenCalledTimes(1);
    const [, errorCode, options] = mockFailJob.mock.calls[0];
    expect(errorCode).not.toBe('SHADOW_JOB_SCOPE_FORBIDDEN');
    expect(errorCode).not.toBe('SHADOW_JOB_AUTHORIZATION_CHANGED');
    // Either no options at all, or retryable left true. What must NOT happen
    // is retryable:false arriving on an ordinary execution failure.
    expect(options?.retryable).not.toBe(false);
  });
});

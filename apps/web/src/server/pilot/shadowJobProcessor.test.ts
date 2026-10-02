// Async/sync safety parity for background Heavy Bag completions
// (SHADOW_JOBS_ROUTING_EVIDENCE_AUDIT_2026-07-31 findings A2, A3, A5).
// The response validator runs REAL here -- these tests pin what the deployed
// worker persists, not what a mocked validator was told to say.

import { processNextShadowJob } from './shadowJobProcessor';
import { claimNextJob, completeJob, failJob, type ShadowJob, SHADOW_CONTEXT_CONTRACT_VERSION } from './shadowJobQueue';
import { queryOne } from './db';
import { appendAssistantMessage, queueHumanReview } from './shadowConversations';
import {
  consumeShadowRateLimit,
  refundShadowRateLimit,
  ShadowRateLimitExceeded,
  type ShadowRateLimitReceipt,
} from './shadowRateLimit';

jest.mock('./shadowJobQueue', () => ({
  claimNextJob: jest.fn(),
  completeJob: jest.fn(),
  failJob: jest.fn(),
  // The real value, not a copy. The worker refuses a payload whose
  // contract stamp does not match this, and fails closed when the
  // constant itself is missing, so a mock that omitted it would refuse
  // every job in this suite for a reason unrelated to what is under test.
  SHADOW_CONTEXT_CONTRACT_VERSION:
    jest.requireActual('./shadowJobQueue').SHADOW_CONTEXT_CONTRACT_VERSION,
}));
jest.mock('./db', () => ({
  queryOne: jest.fn(),
}));
jest.mock('./shadowConversations', () => ({
  appendAssistantMessage: jest.fn(),
  queueHumanReview: jest.fn(),
}));
// Only the two calls that touch the bucket are mocked; the policy
// (safety_review, three an hour) and the error class are the real ones.
jest.mock('./shadowRateLimit', () => ({
  ...jest.requireActual('./shadowRateLimit'),
  consumeShadowRateLimit: jest.fn(),
  refundShadowRateLimit: jest.fn(),
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
const mockConsumeRateLimit = jest.mocked(consumeShadowRateLimit);
const mockRefundRateLimit = jest.mocked(refundShadowRateLimit);
const WORKER_REVIEW_RECEIPT: ShadowRateLimitReceipt = {
  organizationId: 'org-1',
  accountId: 'account-1',
  endpointKey: 'safety_review',
  windowSeconds: 3_600,
  windowStartedAtEpochSeconds: 1_790_000_400,
};

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
      contextContractVersion: SHADOW_CONTEXT_CONTRACT_VERSION,
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

// THE WORKER'S REVIEW ROW IS A RESPONSE-SAFETY EVENT, BOUNDED AND REFUNDED.
//
// The route writes a request-risk row when it queues a high-risk question.
// What the worker writes is about the ANSWER it generated, and it is written
// whether or not the question was high-risk: the worker does not know, and
// does not ask. So a high-risk question with a clean background answer ends
// with one row (the route's), with a replaced answer two, and a benign
// question with a replaced answer one (this one).
//
// The write takes a slot from the same safety_review bucket the route uses,
// under the same rules. Nothing here changes what the job does: it completes
// first, and no failure below reaches failJob.
describe('the worker\'s response-safety review row is bounded by safety_review and refunded', () => {
  const REPLACED = 'Cut water weight by sitting in a sauna the night before weigh-in.';
  const CLEAN = `The rotation the gym already logged supports a tighter pivot drill. [E:${LIBRARY_ID}] RESEARCH NEEDED.`;

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
    mockConsumeRateLimit.mockResolvedValue(WORKER_REVIEW_RECEIPT);
    mockRefundRateLimit.mockResolvedValue(true);
    mockClaimNextJob.mockResolvedValue(heavyBagJob());
  });

  test('a replaced answer: one slot for this account, one row, category async_response_safety', async () => {
    llmReply(REPLACED);

    const result = await processNextShadowJob();

    expect(result.processed).toBe(true);
    expect(mockConsumeRateLimit).toHaveBeenCalledTimes(1);
    expect(mockConsumeRateLimit).toHaveBeenCalledWith({
      organizationId: 'org-1',
      accountId: 'account-1',
      endpointKey: 'safety_review',
      limit: 3,
      windowSeconds: 3_600,
    });
    expect(mockQueueHumanReview).toHaveBeenCalledTimes(1);
    expect(mockQueueHumanReview.mock.calls[0][0]).toEqual(expect.objectContaining({
      category: 'async_response_safety',
      summary: 'A generated SHADOW background result was replaced by the post-generation safety boundary.',
    }));
    expect(mockRefundRateLimit).not.toHaveBeenCalled();
  });

  test('a clean answer writes no row and takes no slot', async () => {
    llmReply(CLEAN);

    const result = await processNextShadowJob();

    expect(result.processed).toBe(true);
    expect(mockQueueHumanReview).not.toHaveBeenCalled();
    expect(mockConsumeRateLimit).not.toHaveBeenCalled();
  });

  test('the hour is spent: the row is not written, nothing is refunded, and the job is still completed, not failed', async () => {
    llmReply(REPLACED);
    mockConsumeRateLimit.mockRejectedValueOnce(new ShadowRateLimitExceeded(1800, 'safety_review'));
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await processNextShadowJob();

      expect(result.processed).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockQueueHumanReview).not.toHaveBeenCalled();
      expect(mockRefundRateLimit).not.toHaveBeenCalled();
      expect(mockCompleteJob).toHaveBeenCalledTimes(1);
      expect(mockFailJob).not.toHaveBeenCalled();
      // The answer was still persisted as replaced: suppressing the row changes nothing else.
      expect(mockAppendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({ responseState: 'filtered' }));
    } finally {
      quiet.mockRestore();
    }
  });

  test('a limiter that FAILS is not a limiter that is spent: the row is written without a slot', async () => {
    llmReply(REPLACED);
    mockConsumeRateLimit.mockRejectedValueOnce(new Error('SHADOW_RATE_LIMIT_UNAVAILABLE'));
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await processNextShadowJob();

      expect(result.processed).toBe(true);
      expect(mockQueueHumanReview).toHaveBeenCalledTimes(1);
      expect(mockRefundRateLimit).not.toHaveBeenCalled();
      expect(mockFailJob).not.toHaveBeenCalled();
    } finally {
      quiet.mockRestore();
    }
  });

  test('both attempts fail: the exact receipt is given back, once, and the job is still not failed', async () => {
    llmReply(REPLACED);
    const receipt: ShadowRateLimitReceipt = { ...WORKER_REVIEW_RECEIPT, windowStartedAtEpochSeconds: 1_790_003_600 };
    mockConsumeRateLimit.mockResolvedValueOnce(receipt);
    mockQueueHumanReview.mockRejectedValue(new Error('insert failed'));
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await processNextShadowJob();

      expect(result.processed).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockQueueHumanReview).toHaveBeenCalledTimes(2);
      expect(mockRefundRateLimit).toHaveBeenCalledTimes(1);
      expect(mockRefundRateLimit.mock.calls[0][0]).toBe(receipt);
      // One slot for the row, not one per attempt.
      expect(mockConsumeRateLimit).toHaveBeenCalledTimes(1);
      expect(mockFailJob).not.toHaveBeenCalled();
    } finally {
      quiet.mockRestore();
    }
  });

  test('a retry that succeeds keeps its slot', async () => {
    llmReply(REPLACED);
    mockQueueHumanReview.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce('review-1');

    const result = await processNextShadowJob();

    expect(result.processed).toBe(true);
    expect(mockQueueHumanReview).toHaveBeenCalledTimes(2);
    expect(mockRefundRateLimit).not.toHaveBeenCalled();
  });

  test('a refund that reports failure does not change the job\'s outcome', async () => {
    llmReply(REPLACED);
    mockQueueHumanReview.mockRejectedValue(new Error('insert failed'));
    mockRefundRateLimit.mockResolvedValueOnce(false);
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const result = await processNextShadowJob();

      expect(result.processed).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockCompleteJob).toHaveBeenCalledTimes(1);
      expect(mockFailJob).not.toHaveBeenCalled();
    } finally {
      quiet.mockRestore();
    }
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

// ---------------------------------------------------------------------------
// STALE CONTEXT CONTRACT
//
// A background job does not re-derive its context. The enqueuing request
// assembles it, stores it on the row, and this worker answers from the stored
// copy at execution time -- under whatever code is deployed by then.
//
// So a change to WHAT GOES INTO that context does not reach a job that was
// already queued. The near-miss audience gate (OD-2026-09-26-002, "Near-miss records are
// coach and organization-admin chat context only") is the case
// that produced this: it removed athlete and parent access to recorded
// near-miss events, and the worker's allowed-role set includes athlete and
// parent, so a Heavy Bag job enqueued before it and run after would still have
// carried those records into an answer appended to that conversation.
//
// A deploy-time queue check cannot close that: it looks once and cannot see a
// job enqueued a second later. The stamp makes the guarantee a property of the
// payload instead of a property of timing.
//
// The owner's instruction, 2026-09-26: "Nothing is real if anything is
// waiting."
// ---------------------------------------------------------------------------
describe('a job whose context predates the current contract', () => {
  // The SAME setup the parity suite above uses. Without it the actor
  // revalidation fires first and every case here returns
  // SHADOW_JOB_AUTHORIZATION_REVOKED -- the refusals would have looked right
  // while proving nothing about the contract stamp, and the positive control
  // is what exposed it.
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
    llmReply('Footwork drill progression for the athlete.');
  });

  function staleJob(overrides: Record<string, unknown>): ShadowJob {
    const job = heavyBagJob();
    return {
      ...job,
      inputPayload: { ...(job.inputPayload as Record<string, unknown>), ...overrides },
    } as ShadowJob;
  }

  // The population this exists for. A job enqueued before the stamp existed
  // has no stamp at all, so absence is refused rather than treated as "fine,
  // this one predates the rule".
  test('an UNSTAMPED payload is refused and never reaches the model', async () => {
    const job = staleJob({});
    delete (job.inputPayload as Record<string, unknown>).contextContractVersion;
    mockClaimNextJob.mockResolvedValue(job);

    const result = await processNextShadowJob();

    expect(result.error).toBe('SHADOW_JOB_CONTEXT_CONTRACT_STALE');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockAppendAssistantMessage).not.toHaveBeenCalled();
  });

  test('a payload stamped with an older contract is refused', async () => {
    mockClaimNextJob.mockResolvedValue(staleJob({ contextContractVersion: SHADOW_CONTEXT_CONTRACT_VERSION - 1 }));

    const result = await processNextShadowJob();

    expect(result.error).toBe('SHADOW_JOB_CONTEXT_CONTRACT_STALE');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // Terminal, not retried. Re-running a job whose stored context is stale
  // produces the same stale answer three times and burns the retry budget
  // proving it -- the same reasoning the scope-forbidden case already uses.
  test('the refusal is TERMINAL, not retried', async () => {
    const job = staleJob({});
    delete (job.inputPayload as Record<string, unknown>).contextContractVersion;
    mockClaimNextJob.mockResolvedValue(job);

    await processNextShadowJob();

    expect(mockFailJob).toHaveBeenCalledWith(
      expect.anything(),
      'SHADOW_JOB_CONTEXT_CONTRACT_STALE',
      { retryable: false },
    );
  });

  // THE OTHER DIRECTION, which the first version of this guard got wrong.
  // A payload stamped NEWER than this worker is not stale -- the worker is
  // behind. That is the ordinary state of a rollout: the new revision enqueues
  // at the new version while the old revision is still serving, and
  // claimNextJob has no version predicate, so the old worker claims it.
  //
  // Treating it as stale was TERMINAL, and failJob's non-retryable branch sets
  // input_payload to '{}', so the job could never be re-run once a current
  // worker existed -- the question sat in the conversation with no answer and
  // no way to produce one.
  describe('a payload stamped AHEAD of this worker', () => {
    test('is refused with its own code, not as stale', async () => {
      mockClaimNextJob.mockResolvedValue(
        staleJob({ contextContractVersion: SHADOW_CONTEXT_CONTRACT_VERSION + 1 }),
      );

      const result = await processNextShadowJob();

      expect(result.error).toBe('SHADOW_JOB_CONTEXT_CONTRACT_AHEAD');
    });

    // The assertion that matters. Retryable keeps input_payload, so a current
    // worker can still take it; non-retryable would erase the context and end
    // the job permanently.
    test('stays RETRYABLE so a current worker can still take it', async () => {
      mockClaimNextJob.mockResolvedValue(
        staleJob({ contextContractVersion: SHADOW_CONTEXT_CONTRACT_VERSION + 1 }),
      );

      await processNextShadowJob();

      expect(mockFailJob).toHaveBeenCalledWith(
        expect.anything(),
        'SHADOW_JOB_CONTEXT_CONTRACT_AHEAD',
      );
      expect(mockFailJob).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { retryable: false },
      );
    });
  });

  // POSITIVE CONTROL. Without it, a guard that refused every job would satisfy
  // all three assertions above and look correct.
  test('POSITIVE CONTROL: a currently-stamped payload is answered normally', async () => {
    mockClaimNextJob.mockResolvedValue(heavyBagJob());

    const result = await processNextShadowJob();

    expect(result.error).toBeUndefined();
    expect(global.fetch).toHaveBeenCalled();
  });
});

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
      contextContractVersion: SHADOW_CONTEXT_CONTRACT_VERSION,
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

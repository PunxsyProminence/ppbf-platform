// The context-contract guard must fail CLOSED when its own constant is missing.
//
// WHY THIS IS ITS OWN FILE. The property under test is a broken import, and a
// module mock is per-file -- there is no way to express "this module exported
// nothing" inside a suite that needs the real export everywhere else.
//
// WHY IT EXISTS AT ALL. The first version of the guard read:
//
//   if (payload.contextContractVersion !== SHADOW_CONTEXT_CONTRACT_VERSION)
//
// which is correct only while the constant is defined. It was written that
// way, and filmStudyExecutor.test.ts then mocked the whole queue module
// without the constant -- so inside that suite the comparison became
// `undefined !== undefined`, which is false, and every unstamped payload
// sailed through. Twenty-six tests went green with the guard silently
// disabled, and the run looked like evidence that it worked.
//
// A guard that switches itself off when its wiring breaks is worse than no
// guard, because it reports success. The shipped form checks the type of its
// own constant first, and this file is what keeps that true.

import { processNextShadowJob } from './shadowJobProcessor';
import { claimNextJob, completeJob, failJob, type ShadowJob } from './shadowJobQueue';
import { queryOne } from './db';
import { appendAssistantMessage, queueHumanReview } from './shadowConversations';

// DELIBERATELY OMITS SHADOW_CONTEXT_CONTRACT_VERSION. That omission is the
// test: it reproduces a broken import, a circular dependency, or a bad merge
// that leaves the worker holding `undefined` for its own contract version.
jest.mock('./shadowJobQueue', () => ({
  claimNextJob: jest.fn(),
  completeJob: jest.fn(),
  failJob: jest.fn(),
}));
jest.mock('./db', () => ({ queryOne: jest.fn() }));
jest.mock('./shadowConversations', () => ({
  appendAssistantMessage: jest.fn(),
  queueHumanReview: jest.fn(),
}));

// The real value, reached past this file's own deliberately-incomplete mock.
const REAL_CONTRACT_VERSION: number =
  jest.requireActual<typeof import('./shadowJobQueue')>('./shadowJobQueue')
    .SHADOW_CONTEXT_CONTRACT_VERSION;

const mockClaimNextJob = jest.mocked(claimNextJob);
const mockCompleteJob = jest.mocked(completeJob);
const mockFailJob = jest.mocked(failJob);
const mockQueryOne = jest.mocked(queryOne);
const mockAppendAssistantMessage = jest.mocked(appendAssistantMessage);
const mockQueueHumanReview = jest.mocked(queueHumanReview);

function heavyBagJob(payloadOverrides: Record<string, unknown> = {}): ShadowJob {
  return {
    jobId: 'job-wiring-1',
    jobType: 'heavy_bag_session',
    status: 'running',
    accountId: 'account-1',
    organizationId: 'org-1',
    role: 'coach',
    athleteId: null,
    inputPayload: {
      requestMode: 'chat',
      message: 'Plan the next six weeks.',
      sessionType: 'heavy_bag',
      authenticatedRole: 'coach',
      authorizedContext: 'Authorized role: coach. Authorized organization: org-1.',
      // Correctly stamped for the CURRENT contract, read from the real module
      // rather than written as a literal -- this suite's mock omits the
      // constant on purpose, so it cannot import it the ordinary way. The
      // payload is not what is wrong here; the worker's own constant is. A
      // guard that only inspected the payload would answer this job.
      contextContractVersion: REAL_CONTRACT_VERSION,
      ...payloadOverrides,
    },
    outputPayload: null,
    errorCode: null,
    safetyStatus: 'pending',
    priority: 3,
    retryCount: 0,
    createdAt: new Date().toISOString(),
  } as unknown as ShadowJob;
}

describe('the contract guard when its own constant is missing', () => {
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
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  test('refuses the job rather than answering it', async () => {
    mockClaimNextJob.mockResolvedValue(heavyBagJob());

    const result = await processNextShadowJob();

    expect(result.error).toBe('SHADOW_JOB_CONTEXT_CONTRACT_STALE');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockAppendAssistantMessage).not.toHaveBeenCalled();
  });

  // The direction that matters. With a payload-only comparison, an UNSTAMPED
  // job plus an undefined constant is `undefined !== undefined` -- false --
  // so the job is answered from whatever context it carries. That is the exact
  // state the near-miss gate was supposed to have ended.
  test('an unstamped payload is refused too, not silently admitted', async () => {
    const job = heavyBagJob();
    delete (job.inputPayload as Record<string, unknown>).contextContractVersion;
    mockClaimNextJob.mockResolvedValue(job);

    const result = await processNextShadowJob();

    expect(result.error).toBe('SHADOW_JOB_CONTEXT_CONTRACT_STALE');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

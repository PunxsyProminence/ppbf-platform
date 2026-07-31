import { NextRequest } from 'next/server';

import { POST } from './route';
import {
  claimNextJob,
  completeJob,
  failJob,
  type JobType,
  type ShadowJob,
} from '@/src/server/pilot/shadowJobQueue';
import { queryOne } from '@/src/server/pilot/db';
import { appendAssistantMessage, queueHumanReview } from '@/src/server/pilot/shadowConversations';

jest.mock('@/src/server/pilot/shadowJobQueue', () => ({
  claimNextJob: jest.fn(),
  completeJob: jest.fn(),
  failJob: jest.fn(),
}));
jest.mock('@/src/server/pilot/db', () => ({
  queryOne: jest.fn(),
}));
jest.mock('@/src/server/pilot/shadowConversations', () => ({
  appendAssistantMessage: jest.fn(),
  queueHumanReview: jest.fn(),
}));

const mockClaimNextJob = jest.mocked(claimNextJob);
const mockCompleteJob = jest.mocked(completeJob);
const mockFailJob = jest.mocked(failJob);
const mockQueryOne = jest.mocked(queryOne);
const mockAppendAssistantMessage = jest.mocked(appendAssistantMessage);
const mockQueueHumanReview = jest.mocked(queueHumanReview);
const originalBootstrapKey = process.env.PPBF_PILOT_BOOTSTRAP_KEY;

function claimedJob(jobType: JobType): ShadowJob {
  return {
    jobId: '7339777f-97cc-4c64-aa87-56ea042d06ac',
    jobType,
    organizationId: 'org-1',
    accountId: 'account-1',
    subjectId: null,
    role: 'coach',
    status: 'running',
    inputPayload: {},
    outputPayload: null,
    errorCode: null,
    safetyStatus: 'pending',
    priority: 3,
    retryCount: 0,
    maxRetries: 3,
    leaseToken: '4cbf3128-e04f-40ac-884f-401410b9c4cb',
    leaseExpiresAt: '2026-07-24T12:02:00.000Z',
    createdAt: '2026-07-24T12:00:00.000Z',
    startedAt: '2026-07-24T12:00:01.000Z',
    completedAt: null,
    expiresAt: '2026-07-25T12:00:00.000Z',
  };
}

function processorRequest(type: JobType): NextRequest {
  return new NextRequest(`http://localhost/api/pilot/shadow/jobs/process?type=${type}`, {
    method: 'POST',
    headers: { 'x-bootstrap-key': 'test-bootstrap-key' },
  });
}

describe('SHADOW job processor fail-closed modes', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    process.env.PPBF_PILOT_BOOTSTRAP_KEY = 'test-bootstrap-key';
    mockFailJob.mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (originalBootstrapKey === undefined) {
      delete process.env.PPBF_PILOT_BOOTSTRAP_KEY;
    } else {
      process.env.PPBF_PILOT_BOOTSTRAP_KEY = originalBootstrapKey;
    }
  });

  // UNAVAILABLE_JOB_TYPES is empty now: film_study was the last entry and
  // left it when the vision pipeline became real (#103). A job type the
  // product can enqueue but not execute strands the request, so the set
  // staying empty is the invariant -- if something is added back here, its
  // producer must be removed in the same change.
  test('no job type is enqueueable-but-unexecutable', async () => {
    for (const jobType of ['heavy_bag_session', 'scout_report', 'board_summary', 'film_study'] as JobType[]) {
      jest.clearAllMocks();
      mockFailJob.mockResolvedValue(undefined);
      mockClaimNextJob.mockResolvedValueOnce(claimedJob(jobType));
      mockQueryOne.mockResolvedValueOnce({
        role: 'coach',
        athlete_id: null,
        is_platform_owner: false,
        organization_status: 'active',
      });

      const response = await POST(processorRequest(jobType));
      const payload = await response.json();

      expect(payload.error).not.toBe('SHADOW_JOB_TYPE_UNAVAILABLE');
    }
  });

  test('film study fails closed when the vision deployment is unset', async () => {
    // The honest refusal that replaced the blanket unavailability: an
    // "observation" produced without the vision model would be invention
    // about a real child, so the executor refuses rather than degrading.
    const previousDeployment = process.env.AZURE_AI_VISION_DEPLOYMENT_NAME;
    delete process.env.AZURE_AI_VISION_DEPLOYMENT_NAME;
    try {
      // A fully valid film_study job, so the refusal under test is the
      // vision gate and not a payload complaint.
      const job = {
        ...claimedJob('film_study'),
        inputPayload: {
          videoSessionId: 'vs-1',
          athleteId: 'ATH-1',
          blobPath: 'org-1/vs-1.mp4',
          organizationId: 'org-1',
          authenticatedRole: 'coach',
          authorizedContext: 'Film study requested for video session vs-1.',
        },
      };
      mockClaimNextJob.mockResolvedValueOnce(job);
      mockQueryOne.mockResolvedValueOnce({
        role: 'coach',
        athlete_id: null,
        is_platform_owner: false,
        organization_status: 'active',
      });

      const response = await POST(processorRequest('film_study'));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        processed: true,
        error: 'SHADOW_FILM_VISION_UNCONFIGURED',
      });
      expect(mockCompleteJob).not.toHaveBeenCalled();
    } finally {
      if (previousDeployment === undefined) {
        delete process.env.AZURE_AI_VISION_DEPLOYMENT_NAME;
      } else {
        process.env.AZURE_AI_VISION_DEPLOYMENT_NAME = previousDeployment;
      }
    }
  });

  test('scout reports now execute -- and fail closed when the AI runtime is unconfigured', async () => {
    // The job passes authorization and reaches its executor; with no
    // AZURE_AI_* configuration in the test environment, the provider call is
    // refused before any network attempt. Retryable by default, because the
    // runtime being unconfigured is an environment condition, not a bad job.
    const previousEnv = {
      endpoint: process.env.AZURE_AI_ENDPOINT,
      key: process.env.AZURE_AI_KEY,
      deployment: process.env.AZURE_AI_DEPLOYMENT_NAME,
    };
    delete process.env.AZURE_AI_ENDPOINT;
    delete process.env.AZURE_AI_KEY;
    delete process.env.AZURE_AI_DEPLOYMENT_NAME;
    try {
      const job = claimedJob('scout_report');
      job.inputPayload = {
        requestMode: 'chat',
        message: 'Summarize this athlete cycle.',
        authorizedContext: 'Server-authorized context.',
      };
      mockClaimNextJob.mockResolvedValueOnce(job);
      mockQueryOne.mockResolvedValueOnce({
        role: 'coach',
        athlete_id: null,
        is_platform_owner: false,
        organization_status: 'active',
      });

      const response = await POST(processorRequest('scout_report'));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        processed: true,
        jobId: job.jobId,
        jobType: 'scout_report',
        error: 'SHADOW_AI_UNAVAILABLE',
      });
      expect(mockFailJob).toHaveBeenCalledWith(job, 'SHADOW_AI_UNAVAILABLE');
      expect(mockCompleteJob).not.toHaveBeenCalled();
    } finally {
      if (previousEnv.endpoint !== undefined) process.env.AZURE_AI_ENDPOINT = previousEnv.endpoint;
      if (previousEnv.key !== undefined) process.env.AZURE_AI_KEY = previousEnv.key;
      if (previousEnv.deployment !== undefined) process.env.AZURE_AI_DEPLOYMENT_NAME = previousEnv.deployment;
    }
  });

  test('a board summary enqueued by a coach is refused by the executor scope gate', async () => {
    // Board summaries carry their own role requirement at EXECUTION time --
    // enablement did not loosen it. A coach-owned job dies with a terminal
    // scope error before any provider call could happen.
    const job = claimedJob('board_summary');
    job.inputPayload = {
      requestMode: 'chat',
      message: 'Summarize governance items.',
      authorizedContext: 'Server-authorized context.',
    };
    mockClaimNextJob.mockResolvedValueOnce(job);
    mockQueryOne.mockResolvedValueOnce({
      role: 'coach',
      athlete_id: null,
      is_platform_owner: false,
      organization_status: 'active',
    });

    const response = await POST(processorRequest('board_summary'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      processed: true,
      error: 'SHADOW_JOB_SCOPE_FORBIDDEN',
    });
    expect(mockFailJob).toHaveBeenCalledWith(job, 'SHADOW_JOB_SCOPE_FORBIDDEN');
    expect(mockCompleteJob).not.toHaveBeenCalled();
  });

  describe('conversation-bound Heavy Bag completion', () => {
    const AZURE_ENV = ['AZURE_AI_ENDPOINT', 'AZURE_AI_KEY', 'AZURE_AI_DEPLOYMENT_NAME'] as const;
    const savedEnv: Record<string, string | undefined> = {};
    const originalFetch = global.fetch;

    beforeEach(() => {
      for (const key of AZURE_ENV) savedEnv[key] = process.env[key];
      process.env.AZURE_AI_ENDPOINT = 'https://example.invalid';
      process.env.AZURE_AI_KEY = 'test-key';
      process.env.AZURE_AI_DEPLOYMENT_NAME = 'test-deployment';
      mockAppendAssistantMessage.mockResolvedValue('assistant-msg-9');
      mockQueueHumanReview.mockResolvedValue('review-9');
      mockQueryOne.mockResolvedValue({
        role: 'coach',
        athlete_id: null,
        is_platform_owner: false,
        organization_status: 'active',
      });
    });

    afterEach(() => {
      global.fetch = originalFetch;
      for (const key of AZURE_ENV) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    });

    function boundHeavyJob(): ShadowJob {
      const job = claimedJob('heavy_bag_session');
      job.inputPayload = {
        requestMode: 'chat',
        message: 'Plan the next training block.',
        topic: 'training',
        authorizedContext: 'Use [E:e5a7c9d2-4b3f-4a21-8c6d-1f2e3a4b5c6d] for the approved excerpt.',
        conversationId: 'c0a80121-0000-4000-8000-000000000001',
        evidenceSnapshot: {
          bundleId: 'bundle-1',
          availability: 'available',
          allowedEvidenceIds: ['e5a7c9d2-4b3f-4a21-8c6d-1f2e3a4b5c6d'],
          citationCatalog: [{
            evidenceId: 'e5a7c9d2-4b3f-4a21-8c6d-1f2e3a4b5c6d',
            token: '[E:e5a7c9d2-4b3f-4a21-8c6d-1f2e3a4b5c6d]',
            sourceTitle: 'Approved source',
            documentName: 'Approved document',
          }],
        },
      };
      return job;
    }

    test('persists the validated answer with its snapshot-checked citation', async () => {
      const job = boundHeavyJob();
      mockClaimNextJob.mockResolvedValueOnce(job);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Base the block on the approved drill [E:e5a7c9d2-4b3f-4a21-8c6d-1f2e3a4b5c6d].' } }],
        }),
      }) as unknown as typeof fetch;

      const response = await POST(processorRequest('heavy_bag_session'));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ processed: true, jobId: job.jobId });

      // The answer landed in the conversation under the re-validated actor,
      // graded from the snapshot: one authorized citation -> EMERGING.
      expect(mockAppendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
        actor: expect.objectContaining({ accountId: 'account-1', organizationId: 'org-1', role: 'coach' }),
        conversationId: 'c0a80121-0000-4000-8000-000000000001',
        content: 'Base the block on the approved drill [E:e5a7c9d2-4b3f-4a21-8c6d-1f2e3a4b5c6d].',
        responseState: 'ok',
        evidenceTier: 'EMERGING',
        evidence: {
          bundleId: 'bundle-1',
          availability: 'available',
          citationIds: ['e5a7c9d2-4b3f-4a21-8c6d-1f2e3a4b5c6d'],
        },
      }));

      // Job output mirrors what was persisted, receipts included, so the
      // polling client shows exactly what restore will replay.
      expect(mockCompleteJob).toHaveBeenCalledWith(
        job,
        expect.objectContaining({
          response: 'Base the block on the approved drill [E:e5a7c9d2-4b3f-4a21-8c6d-1f2e3a4b5c6d].',
          conversationId: 'c0a80121-0000-4000-8000-000000000001',
          assistantMessageId: 'assistant-msg-9',
          citations: [expect.objectContaining({ evidenceId: 'e5a7c9d2-4b3f-4a21-8c6d-1f2e3a4b5c6d', sourceTitle: 'Approved source' })],
        }),
        'passed',
      );
      expect(mockQueueHumanReview).not.toHaveBeenCalled();
    });

    test('a fabricated citation is filtered: safe message persisted, no receipts, human review queued', async () => {
      const job = boundHeavyJob();
      mockClaimNextJob.mockResolvedValueOnce(job);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Proven results [E:ev-FAKE] guarantee improvement.' } }],
        }),
      }) as unknown as typeof fetch;

      const response = await POST(processorRequest('heavy_bag_session'));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ processed: true, jobId: job.jobId });

      expect(mockAppendAssistantMessage).toHaveBeenCalledWith(expect.objectContaining({
        responseState: 'filtered',
        evidenceTier: 'RESEARCH_NEEDED',
        evidence: expect.objectContaining({ citationIds: [] }),
      }));
      const persistedContent = mockAppendAssistantMessage.mock.calls[0][0].content;
      expect(persistedContent).not.toContain('ev-FAKE');

      expect(mockCompleteJob).toHaveBeenCalledWith(
        job,
        expect.objectContaining({ citations: [] }),
        'filtered',
      );
      expect(mockQueueHumanReview).toHaveBeenCalledWith(expect.objectContaining({
        category: 'async_response_safety',
      }));
    });

    test('a malformed conversation binding fails the job closed instead of dropping persistence', async () => {
      const job = boundHeavyJob();
      job.inputPayload = { ...job.inputPayload, evidenceSnapshot: { availability: 'sometimes' } };
      mockClaimNextJob.mockResolvedValueOnce(job);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'An answer.' } }] }),
      }) as unknown as typeof fetch;

      const response = await POST(processorRequest('heavy_bag_session'));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        processed: true,
        error: 'SHADOW_JOB_CONTEXT_INVALID',
      });
      expect(mockAppendAssistantMessage).not.toHaveBeenCalled();
      expect(mockCompleteJob).not.toHaveBeenCalled();
    });
  });

  test('allows an active platform owner without a membership while keeping the job organization scoped', async () => {
    // Retargeted from 'library_update' when that producer-less arm was
    // removed: board_summary is a real, enqueueable type whose executor
    // admits platform_owner. With no AZURE_AI_* configured in the test
    // environment the run stops at the provider guard -- which proves the
    // authorization path (the subject of this test) was fully traversed.
    const previousEnv = {
      endpoint: process.env.AZURE_AI_ENDPOINT,
      key: process.env.AZURE_AI_KEY,
      deployment: process.env.AZURE_AI_DEPLOYMENT_NAME,
    };
    delete process.env.AZURE_AI_ENDPOINT;
    delete process.env.AZURE_AI_KEY;
    delete process.env.AZURE_AI_DEPLOYMENT_NAME;
    const job = claimedJob('board_summary');
    job.role = 'platform_owner';
    job.inputPayload = {
      requestMode: 'chat',
      message: 'Summarize governance items.',
      authorizedContext: 'Server-authorized context.',
    };
    mockClaimNextJob.mockResolvedValueOnce(job);
    mockQueryOne.mockResolvedValueOnce({
      role: 'platform_owner',
      athlete_id: null,
      is_platform_owner: true,
      organization_status: 'active',
    });

    try {
      const response = await POST(processorRequest('board_summary'));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        processed: true,
        jobId: job.jobId,
        jobType: 'board_summary',
        error: 'SHADOW_AI_UNAVAILABLE',
      });
      expect(mockFailJob).toHaveBeenCalledWith(job, 'SHADOW_AI_UNAVAILABLE');
      expect(mockCompleteJob).not.toHaveBeenCalled();
    } finally {
      if (previousEnv.endpoint !== undefined) process.env.AZURE_AI_ENDPOINT = previousEnv.endpoint;
      if (previousEnv.key !== undefined) process.env.AZURE_AI_KEY = previousEnv.key;
      if (previousEnv.deployment !== undefined) process.env.AZURE_AI_DEPLOYMENT_NAME = previousEnv.deployment;
    }

    const [authorizationSql, authorizationParameters] = mockQueryOne.mock.calls[0];
    expect(authorizationSql).toMatch(/left join pilot\.organization_memberships om/i);
    expect(authorizationSql).toMatch(/om\.organization_id = \$2/i);
    expect(authorizationSql).toMatch(
      /a\.is_platform_owner = true\s+or om\.account_id is not null/i,
    );
    expect(authorizationParameters).toEqual([job.accountId, job.organizationId]);
  });

  test('fails closed when a queued job owner has changed to the Board role', async () => {
    const job = claimedJob('board_summary');
    job.role = 'board';
    mockClaimNextJob.mockResolvedValueOnce(job);
    mockQueryOne.mockResolvedValueOnce({
      role: 'board',
      athlete_id: null,
      is_platform_owner: false,
      organization_status: 'active',
    });

    const response = await POST(processorRequest('board_summary'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      processed: true,
      jobId: job.jobId,
      error: 'SHADOW_JOB_AUTHORIZATION_REVOKED',
    });
    expect(mockFailJob).toHaveBeenCalledWith(
      job,
      'SHADOW_JOB_AUTHORIZATION_REVOKED',
    );
    expect(mockCompleteJob).not.toHaveBeenCalled();
  });
});

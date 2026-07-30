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

jest.mock('@/src/server/pilot/shadowJobQueue', () => ({
  claimNextJob: jest.fn(),
  completeJob: jest.fn(),
  failJob: jest.fn(),
}));
jest.mock('@/src/server/pilot/db', () => ({
  queryOne: jest.fn(),
}));

const mockClaimNextJob = jest.mocked(claimNextJob);
const mockCompleteJob = jest.mocked(completeJob);
const mockFailJob = jest.mocked(failJob);
const mockQueryOne = jest.mocked(queryOne);
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

  // Only Film Study remains gated -- it hard-requires the vision pipeline
  // that does not exist. Scout reports and board summaries left this set the
  // day the worker became real; their execution paths are covered below.
  test.each<JobType>(['film_study'])(
    'terminally fails unavailable %s jobs without executing or completing them',
    async (jobType) => {
      const job = claimedJob(jobType);
      mockClaimNextJob.mockResolvedValueOnce(job);

      const response = await POST(processorRequest(jobType));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        processed: true,
        jobId: job.jobId,
        jobType,
        error: 'SHADOW_JOB_TYPE_UNAVAILABLE',
      });
      expect(mockFailJob).toHaveBeenCalledWith(
        job,
        'SHADOW_JOB_TYPE_UNAVAILABLE',
        { retryable: false },
      );
      expect(mockCompleteJob).not.toHaveBeenCalled();
    },
  );

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

  test('allows an active platform owner without a membership while keeping the job organization scoped', async () => {
    const job = claimedJob('library_update');
    job.role = 'platform_owner';
    mockClaimNextJob.mockResolvedValueOnce(job);
    mockQueryOne.mockResolvedValueOnce({
      role: 'platform_owner',
      athlete_id: null,
      is_platform_owner: true,
      organization_status: 'active',
    });

    const response = await POST(processorRequest('library_update'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      processed: true,
      jobId: job.jobId,
      jobType: 'library_update',
    });
    expect(mockFailJob).not.toHaveBeenCalled();
    expect(mockCompleteJob).toHaveBeenCalledWith(
      job,
      expect.objectContaining({ resultStatus: 'unavailable' }),
      'not_applicable',
    );

    const [authorizationSql, authorizationParameters] = mockQueryOne.mock.calls[0];
    expect(authorizationSql).toMatch(/left join pilot\.organization_memberships om/i);
    expect(authorizationSql).toMatch(/om\.organization_id = \$2/i);
    expect(authorizationSql).toMatch(
      /a\.is_platform_owner = true\s+or om\.account_id is not null/i,
    );
    expect(authorizationParameters).toEqual([job.accountId, job.organizationId]);
  });

  test('fails closed when a queued job owner has changed to the Board role', async () => {
    const job = claimedJob('library_update');
    job.role = 'board';
    mockClaimNextJob.mockResolvedValueOnce(job);
    mockQueryOne.mockResolvedValueOnce({
      role: 'board',
      athlete_id: null,
      is_platform_owner: false,
      organization_status: 'active',
    });

    const response = await POST(processorRequest('library_update'));

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

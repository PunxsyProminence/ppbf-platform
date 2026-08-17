import { accessibleAthleteIds, assertActorCanAccessAthlete } from './access';
import { query, queryOne } from './db';
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  getJobsForActor,
  getJobStatusForActor,
  normalizeJobPriority,
  normalizeJobTtlHours,
  purgeTerminalShadowJobs,
  TERMINAL_JOB_RETENTION_DAYS,
} from './shadowJobQueue';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

jest.mock('./access', () => ({
  assertActorCanAccessAthlete: jest.fn(),
  accessibleAthleteIds: jest.fn(async () => new Set()),
  isOrganizationAdminRole: (role: string) => role === 'admin' || role === 'organization_admin',
}));

const mockQuery = jest.mocked(query);
const mockQueryOne = jest.mocked(queryOne);
const mockAssertSubjectAccess = jest.mocked(assertActorCanAccessAthlete);
const mockAccessibleAthleteIds = jest.mocked(accessibleAthleteIds);

const coach = {
  accountId: 'coach-1',
  organizationId: 'org-1',
  role: 'coach' as const,
  athleteId: null,
};

const jobRow = {
  job_id: 'job-1',
  job_type: 'heavy_bag_session' as const,
  organization_id: 'org-1',
  account_id: 'coach-1',
  subject_id: 'athlete-1',
  role: 'coach' as const,
  status: 'running' as const,
  input_payload: { message: 'test' },
  output_payload: null,
  error_message: null,
  safety_status: 'pending' as const,
  priority: 2,
  retry_count: 0,
  max_retries: 3,
  lease_token: '4cbf3128-e04f-40ac-884f-401410b9c4cb',
  lease_expires_at: '2026-07-23T00:02:01.000Z',
  created_at: '2026-07-23T00:00:00.000Z',
  started_at: '2026-07-23T00:00:01.000Z',
  completed_at: null,
  expires_at: '2026-07-24T00:00:00.000Z',
};

describe('SHADOW job queue safeguards', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockQuery.mockResolvedValue([]);
    mockAssertSubjectAccess.mockResolvedValue(undefined);
    mockAccessibleAthleteIds.mockResolvedValue(new Set());
  });

  test('bounds priority and TTL before using parameterized SQL', async () => {
    mockQueryOne.mockResolvedValueOnce({ job_id: 'job-1' });
    await enqueueJob({
      jobType: 'heavy_bag_session',
      organizationId: 'org-1',
      accountId: 'coach-1',
      subjectId: 'athlete-1',
      role: 'coach',
      inputPayload: { message: 'work the jab' },
      priority: 99,
      ttlHours: 999,
    });

    expect(normalizeJobPriority(99)).toBe(5);
    expect(normalizeJobTtlHours(999)).toBe(168);
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain("$8 * INTERVAL '1 hour'");
    expect(sql).not.toContain('999');
    expect(params).toEqual([
      'heavy_bag_session',
      'org-1',
      'coach-1',
      'athlete-1',
      'coach',
      '{"message":"work the jab"}',
      5,
      168,
    ]);
  });

  test('maps claimed snake-case rows into the processor contract', async () => {
    mockQueryOne.mockResolvedValueOnce(jobRow);
    const job = await claimNextJob('heavy_bag_session');
    expect(job).toMatchObject({
      jobId: 'job-1',
      jobType: 'heavy_bag_session',
      organizationId: 'org-1',
      accountId: 'coach-1',
      subjectId: 'athlete-1',
      inputPayload: { message: 'test' },
      leaseToken: '4cbf3128-e04f-40ac-884f-401410b9c4cb',
    });
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain("input_payload = '{}'::jsonb");
    expect(sql).toContain("error_message = 'SHADOW_JOB_EXPIRED'");
    expect(sql).toContain("error_message = 'SHADOW_JOB_LEASE_EXPIRED'");
    expect(sql).toContain('lease_expires_at IS NULL OR lease_expires_at <= NOW()');
    expect(sql).toContain('lease_token = gen_random_uuid()');
    // 300, not 120: the lease must exceed the 120s provider ceiling plus
    // persistence overhead, or completion throws on its own expired lease and
    // the re-claim duplicates an already-appended answer.
    expect(params).toEqual(['heavy_bag_session', 300]);
  });

  test('does not reveal another account job within the same tenant', async () => {
    mockQueryOne.mockResolvedValueOnce({
      job_id: 'job-2',
      job_type: 'heavy_bag_session',
      account_id: 'coach-2',
      subject_id: null,
    });
    await expect(getJobStatusForActor('job-2', coach)).resolves.toBeNull();
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  test('rechecks subject authorization before returning output', async () => {
    mockQueryOne.mockResolvedValueOnce({
      job_id: 'job-1',
      job_type: 'heavy_bag_session',
      account_id: 'coach-1',
      subject_id: 'athlete-1',
    });
    mockAssertSubjectAccess.mockRejectedValueOnce(new Error('assignment removed'));
    await expect(getJobStatusForActor('job-1', coach)).resolves.toBeNull();
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  test('completion is scoped to the claimed tenant and owner and clears input', async () => {
    mockQueryOne.mockResolvedValueOnce({ job_id: 'job-1' });
    await completeJob(
      {
        jobId: 'job-1',
        organizationId: 'org-1',
        accountId: 'coach-1',
        leaseToken: '4cbf3128-e04f-40ac-884f-401410b9c4cb',
      },
      { response: 'Evidence is limited; coach review is required.' },
      'passed',
    );
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain("input_payload = '{}'::jsonb");
    expect(sql).toContain('organization_id = $2');
    expect(sql).toContain('account_id = $3');
    expect(sql).toContain('lease_token = $4::uuid');
    expect(sql).toContain('lease_expires_at > NOW()');
    expect(sql).toContain('lease_token = NULL');
    expect(params?.slice(0, 3)).toEqual(['job-1', 'org-1', 'coach-1']);
    expect(params?.[3]).toBe('4cbf3128-e04f-40ac-884f-401410b9c4cb');
  });

  test('rejects completion when the active lease no longer matches', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    await expect(completeJob(
      {
        jobId: 'job-1',
        organizationId: 'org-1',
        accountId: 'coach-1',
        leaseToken: '4cbf3128-e04f-40ac-884f-401410b9c4cb',
      },
      { response: 'late output' },
      'passed',
    )).rejects.toThrow('claimed job no longer matches');
  });

  test('failure is lease-scoped and terminally clears sensitive input after retry exhaustion', async () => {
    mockQueryOne.mockResolvedValueOnce({ job_id: 'job-1' });
    await failJob(
      {
        jobId: 'job-1',
        organizationId: 'org-1',
        accountId: 'coach-1',
        leaseToken: '4cbf3128-e04f-40ac-884f-401410b9c4cb',
      },
      'SHADOW_AI_PROVIDER_ERROR',
    );

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain('retry_count + 1 >= max_retries');
    expect(sql).toContain("THEN '{}'::jsonb");
    expect(sql).toContain('lease_token = $4::uuid');
    expect(sql).toContain('lease_expires_at > NOW()');
    expect(sql).toContain('lease_token = NULL');
    expect(params).toEqual([
      'job-1',
      'org-1',
      'coach-1',
      '4cbf3128-e04f-40ac-884f-401410b9c4cb',
      'SHADOW_AI_PROVIDER_ERROR',
      true,
    ]);
  });

  test('rejects failure from a worker whose lease is no longer active', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    await expect(failJob(
      {
        jobId: 'job-1',
        organizationId: 'org-1',
        accountId: 'coach-1',
        leaseToken: '4cbf3128-e04f-40ac-884f-401410b9c4cb',
      },
      'SHADOW_AI_PROVIDER_ERROR',
    )).rejects.toThrow('claimed lease is no longer active');
  });

  test('does not expose an owner-only Scout job to an organization administrator', async () => {
    mockQueryOne.mockResolvedValueOnce({
      job_id: 'job-2',
      job_type: 'scout_report',
      account_id: 'coach-2',
      subject_id: null,
    });
    await expect(getJobStatusForActor('job-2', {
      accountId: 'admin-1',
      organizationId: 'org-1',
      role: 'organization_admin',
      athleteId: null,
    })).resolves.toBeNull();
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  test('filters owner-only jobs out of organization-wide job listings', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await getJobsForActor({
      accountId: 'admin-1',
      organizationId: 'org-1',
      role: 'organization_admin',
      athleteId: null,
    });

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain("job_type NOT IN ('heavy_bag_session', 'scout_report')");
  });

  test('authorizes a page of subject-bearing jobs with one batched call, not one per row', async () => {
    mockQuery.mockResolvedValueOnce([
      { ...jobRow, job_id: 'job-1', subject_id: 'athlete-1' },
      { ...jobRow, job_id: 'job-2', subject_id: 'athlete-2' },
      { ...jobRow, job_id: 'job-3', subject_id: 'athlete-1' },
      { ...jobRow, job_id: 'job-4', subject_id: null },
    ]);
    mockAccessibleAthleteIds.mockResolvedValueOnce(new Set(['athlete-1']));

    const results = await getJobsForActor(coach);

    // One batched call, covering the distinct subject ids on the page --
    // not four (one per row), and not a duplicate call for athlete-1's
    // second row.
    expect(mockAccessibleAthleteIds).toHaveBeenCalledTimes(1);
    const [, calledWithIds] = mockAccessibleAthleteIds.mock.calls[0];
    expect(new Set(calledWithIds)).toEqual(new Set(['athlete-1', 'athlete-2']));

    // The per-row path this replaces must not run at all.
    expect(mockAssertSubjectAccess).not.toHaveBeenCalled();

    // athlete-2's job is dropped (not in the accessible set); the
    // subject-less job passes through with no lookup needed.
    expect(results.map((job) => job.jobId)).toEqual(['job-1', 'job-3', 'job-4']);
  });

  test('skips the batched lookup entirely when no row on the page has a subject', async () => {
    mockQuery.mockResolvedValueOnce([{ ...jobRow, subject_id: null }]);

    const results = await getJobsForActor(coach);

    expect(mockAccessibleAthleteIds).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
  });

  test('the retention sweep deletes only terminal rows past the window', async () => {
    mockQuery.mockResolvedValueOnce([{ job_id: 'a' }, { job_id: 'b' }]);

    const purged = await purgeTerminalShadowJobs();

    expect(purged).toBe(2);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("status IN ('completed', 'failed', 'cancelled')");
    expect(sql).toContain("COALESCE(completed_at, updated_at, created_at)");
    expect(params).toEqual([TERMINAL_JOB_RETENTION_DAYS]);
    // Pending and running rows are never retention targets.
    expect(sql).not.toContain("'pending'");
    expect(sql).not.toContain("'running'");
  });
});

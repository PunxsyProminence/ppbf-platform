import { assertActorCanAccessAthlete } from './access';
import { query, queryOne } from './db';
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  getJobStatusForActor,
  normalizeJobPriority,
  normalizeJobTtlHours,
} from './shadowJobQueue';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

jest.mock('./access', () => ({
  assertActorCanAccessAthlete: jest.fn(),
  isOrganizationAdminRole: (role: string) => role === 'admin' || role === 'organization_admin',
}));

const mockQuery = jest.mocked(query);
const mockQueryOne = jest.mocked(queryOne);
const mockAssertSubjectAccess = jest.mocked(assertActorCanAccessAthlete);

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
    });
  });

  test('does not reveal another account job within the same tenant', async () => {
    mockQueryOne.mockResolvedValueOnce({
      job_id: 'job-2',
      account_id: 'coach-2',
      subject_id: null,
    });
    await expect(getJobStatusForActor('job-2', coach)).resolves.toBeNull();
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  test('rechecks subject authorization before returning output', async () => {
    mockQueryOne.mockResolvedValueOnce({
      job_id: 'job-1',
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
      },
      { response: 'Evidence is limited; coach review is required.' },
      'passed',
    );
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain("input_payload = '{}'::jsonb");
    expect(sql).toContain('organization_id = $2');
    expect(sql).toContain('account_id = $3');
    expect(params?.slice(0, 3)).toEqual(['job-1', 'org-1', 'coach-1']);
  });
});

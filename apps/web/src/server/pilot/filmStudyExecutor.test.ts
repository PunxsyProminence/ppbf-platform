// Film Study executor: frames -> vision -> a PROPOSED observation (#103,
// prerequisite 4). The response validator runs REAL here, so these pin what
// the deployed worker would actually persist.
//
// The retention rule is the one that matters most and the easiest to break
// silently: #103 requires extracted frames of a minor to live only in a
// per-job temp directory, deleted after inference. It is asserted on the
// success path AND on every failure path, because a cleanup that only runs
// when nothing goes wrong is not a retention guarantee.

import fs from 'node:fs/promises';

import { processNextShadowJob } from './shadowJobProcessor';
import { claimNextJob, completeJob, failJob, SHADOW_CONTEXT_CONTRACT_VERSION, type ShadowJob } from './shadowJobQueue';
import { queryOne, withTransaction } from './db';
import { downloadPilotVideoFile } from './blob';
import { analyzeFramesWithVision, extractFrames } from './shadowFilmStudy';
import { createFilmStudyProposal } from './shadowFilmStudyProposals';
import { assertGuardianMediaConsent, checkGuardianMediaConsent, GuardianConsentMissingError } from './guardianConsent';
import { listLiveTagSubjects } from './videoClipTags';

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
// withTransaction hands its callback a stand-in client: the consent reads
// and the proposal insert it is passed to are mocked below, so the client is
// only carried, never queried. The real lock is proven against Postgres in
// filmStudyConsentRace.pg.test.ts.
const TX_CLIENT = { query: jest.fn() };
jest.mock('./db', () => ({
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));
jest.mock('./shadowConversations', () => ({
  appendAssistantMessage: jest.fn(),
  queueHumanReview: jest.fn(),
}));
jest.mock('./blob', () => ({ downloadPilotVideoFile: jest.fn() }));
jest.mock('./shadowFilmStudy', () => ({
  ...jest.requireActual('./shadowFilmStudy'),
  extractFrames: jest.fn(),
  analyzeFramesWithVision: jest.fn(),
}));
jest.mock('./shadowFilmStudyProposals', () => ({
  createFilmStudyProposal: jest.fn(),
}));
// Consent is re-read when the job runs (filmStudyConsent.ts). Only the two
// reads are mocked; the playback scope gate that interprets them runs real.
jest.mock('./guardianConsent', () => ({
  ...jest.requireActual('./guardianConsent'),
  assertGuardianMediaConsent: jest.fn(),
  checkGuardianMediaConsent: jest.fn(),
}));
jest.mock('./videoClipTags', () => ({ listLiveTagSubjects: jest.fn() }));

const mockClaim = jest.mocked(claimNextJob);
const mockComplete = jest.mocked(completeJob);
const mockFail = jest.mocked(failJob);
const mockQueryOne = jest.mocked(queryOne);
const mockWithTransaction = jest.mocked(withTransaction);
const mockDownload = jest.mocked(downloadPilotVideoFile);
const mockExtract = jest.mocked(extractFrames);
const mockAnalyze = jest.mocked(analyzeFramesWithVision);
const mockCreateProposal = jest.mocked(createFilmStudyProposal);
const mockAssertConsent = jest.mocked(assertGuardianMediaConsent);
const mockCheckConsent = jest.mocked(checkGuardianMediaConsent);
const mockTagSubjects = jest.mocked(listLiveTagSubjects);

function consent(coversVideo: boolean, status = 'signed') {
  return {
    ok: status === 'signed',
    guardianIds: ['parent-1'],
    missingParentIds: status === 'signed' ? [] : ['parent-1'],
    perGuardian: [{ parentId: 'parent-1', status, coversVideo, publicUseAllowed: false, signedAt: null }],
  };
}

const PROPOSAL_ID = '55555555-5555-4555-8555-555555555555';
const OBSERVATION = 'The lead hand returns below the chin after the jab in the later frames.';

function filmStudyJob(): ShadowJob {
  return {
    jobId: '7339777f-97cc-4c64-aa87-56ea042d06ac',
    jobType: 'film_study',
    organizationId: 'org-1',
    accountId: 'account-1',
    subjectId: 'ATH-1',
    role: 'coach',
    status: 'running',
    inputPayload: {
      videoSessionId: 'vs-1',
      athleteId: 'ATH-1',
      blobPath: 'org-1/vs-1.mp4',
      organizationId: 'org-1',
      authenticatedRole: 'coach',
      authorizedContext: 'Film study requested for video session vs-1.',
      contextContractVersion: SHADOW_CONTEXT_CONTRACT_VERSION,
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
    expiresAt: '2026-08-07T12:00:00.000Z',
  } satisfies ShadowJob;
}

/** Temp directories the executor created during a test. */
async function tempDirsCreated(): Promise<string[]> {
  const os = await import('node:os');
  const entries = await fs.readdir(os.tmpdir());
  return entries.filter((name) => name.startsWith('ppbf-film-job-'));
}

const originalEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.AZURE_AI_ENDPOINT = 'https://ai.test';
  process.env.AZURE_AI_KEY = 'key';
  process.env.AZURE_AI_VISION_DEPLOYMENT_NAME = 'gpt-5-vision-shadow';

  mockWithTransaction.mockImplementation(async (fn) => fn(TX_CLIENT as never));
  mockClaim.mockResolvedValue(filmStudyJob());
  mockAssertConsent.mockResolvedValue(undefined);
  mockCheckConsent.mockImplementation(async () => consent(true));
  mockTagSubjects.mockResolvedValue([]);
  mockQueryOne.mockResolvedValue({
    role: 'coach',
    athlete_id: null,
    is_platform_owner: false,
    organization_status: 'active',
  } as never);
  mockDownload.mockResolvedValue(Buffer.from('fake-mp4-bytes') as never);
  mockExtract.mockImplementation(async ({ directory }) => {
    // Write real frame files, so cleanup has something real to remove.
    const paths = ['frame-001.jpg', 'frame-002.jpg', 'frame-003.jpg'].map((n) => `${directory}/${n}`);
    await Promise.all(paths.map((p) => fs.writeFile(p, 'jpeg')));
    return { framePaths: paths, extractMs: 210 };
  });
  mockAnalyze.mockResolvedValue({
    content: OBSERVATION,
    latencyMs: 12_014,
    promptTokens: 1091,
    completionTokens: 739,
    reasoningTokens: 704,
  } as never);
  mockCreateProposal.mockResolvedValue({
    proposal_id: PROPOSAL_ID,
    organization_id: 'org-1',
    athlete_id: 'ATH-1',
    video_session_id: 'vs-1',
    job_id: null,
    observation_text: OBSERVATION,
    evidence_id: 'film:vs-1',
    model_deployment: 'gpt-5-vision-shadow',
    frames_analyzed: 3,
    review_state: 'pending_review',
    reviewed_by_account_id: null,
    reviewed_by_role: null,
    reviewed_at: null,
    review_notes: null,
    created_at: '2026-07-31T12:00:02.000Z',
    updated_at: '2026-07-31T12:00:02.000Z',
  } as never);
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('film study executor', () => {
  test('produces a PENDING proposal and never touches an athlete record', async () => {
    const result = await processNextShadowJob();

    expect(result).toMatchObject({ processed: true, jobType: 'film_study' });
    expect(result.error).toBeUndefined();

    expect(mockCreateProposal).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      athleteId: 'ATH-1',
      videoSessionId: 'vs-1',
      observationText: OBSERVATION,
      modelDeployment: 'gpt-5-vision-shadow',
      framesAnalyzed: 3,
    }), TX_CLIENT);
    // The last consent read and the insert share that one transaction.
    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(mockCheckConsent).toHaveBeenLastCalledWith('org-1', 'ATH-1', TX_CLIENT);
    expect(mockTagSubjects).toHaveBeenLastCalledWith('org-1', 'vs-1', TX_CLIENT);

    const [, output, safety] = mockComplete.mock.calls[0];
    expect(safety).toBe('passed');
    expect(output).toMatchObject({
      proposalId: PROPOSAL_ID,
      reviewState: 'pending_review',
      evidenceId: 'film:vs-1',
      framesAnalyzed: 3,
    });
  });

  test('an unsafe observation never reaches the proposals table', async () => {
    // The job-level safety sweep runs AFTER the executor returns, which is too
    // late for this job type: the proposals route reads the row directly, so a
    // filtered observation would sit in front of a coach while the job output
    // beside it said 'filtered'. Validation has to gate the write itself.
    mockAnalyze.mockResolvedValue({
      content: 'The guard looks solid. The athlete is safe to return to training and can spar today.',
      latencyMs: 11_800, promptTokens: 900, completionTokens: 300, reasoningTokens: 280,
    } as never);

    const result = await processNextShadowJob();

    expect(result.error).toBe('SHADOW_FILM_OBSERVATION_FILTERED');
    expect(mockCreateProposal).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  test('an invented citation token is refused rather than proposed', async () => {
    // A frame observation cites nothing -- there is no authorized citation
    // catalog for this task, and the allowlist filters non-UUID ids anyway, so
    // any [E:...] the model emits is fabricated by construction.
    mockAnalyze.mockResolvedValue({
      content: 'Guard drops after the jab [E:film:vs-1].',
      latencyMs: 11_800, promptTokens: 900, completionTokens: 300, reasoningTokens: 280,
    } as never);

    const result = await processNextShadowJob();

    expect(result.error).toBe('SHADOW_FILM_OBSERVATION_FILTERED');
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  test('RETENTION: the temp directory is gone after a successful run', async () => {
    await processNextShadowJob();
    expect(await tempDirsCreated()).toEqual([]);
  });

  test('RETENTION: the temp directory is gone when the vision call fails', async () => {
    // The path that matters most -- a cleanup that only runs on success is
    // not a retention guarantee, and frames of a minor must not outlive the
    // inference that needed them.
    mockAnalyze.mockRejectedValue(new Error('SHADOW_AI_PROVIDER_ERROR'));

    const result = await processNextShadowJob();

    expect(result.error).toBe('SHADOW_AI_PROVIDER_ERROR');
    expect(await tempDirsCreated()).toEqual([]);
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  test('RETENTION: the temp directory is gone when frame extraction fails', async () => {
    mockExtract.mockRejectedValue(new Error('SHADOW_FILM_FFMPEG_FAILED'));

    const result = await processNextShadowJob();

    expect(result.error).toBe('SHADOW_FILM_FFMPEG_FAILED');
    expect(await tempDirsCreated()).toEqual([]);
  });

  test('fails closed when the vision deployment is unset, without downloading anything', async () => {
    delete process.env.AZURE_AI_VISION_DEPLOYMENT_NAME;

    const result = await processNextShadowJob();

    expect(result.error).toBe('SHADOW_FILM_VISION_UNCONFIGURED');
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockCreateProposal).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  test('a role without coaching authority is refused', async () => {
    mockQueryOne.mockResolvedValue({
      role: 'athlete', athlete_id: 'ATH-1', is_platform_owner: false, organization_status: 'active',
    } as never);
    mockClaim.mockResolvedValue({ ...filmStudyJob(), role: 'athlete' } as ShadowJob);

    const result = await processNextShadowJob();

    expect(result.error).toBe('SHADOW_JOB_SCOPE_FORBIDDEN');
    expect(mockDownload).not.toHaveBeenCalled();
  });

  test('a malformed payload is refused before any download', async () => {
    mockClaim.mockResolvedValue({
      ...filmStudyJob(),
      inputPayload: { authenticatedRole: 'coach', authorizedContext: 'ctx' },
    } as ShadowJob);

    const result = await processNextShadowJob();

    expect(result.error).toBe('SHADOW_JOB_CONTEXT_INVALID');
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockFail).toHaveBeenCalled();
  });
});

/*
 * CONSENT AT RUN TIME. A queued job carries only the fact that a request was
 * allowed when it was made; a guardian can withdraw or narrow to photo-only
 * while it waits. The worker asks again before reading the blob, and again
 * before persisting a proposal.
 */
describe('film study executor re-checks consent when the job runs', () => {
  test.each([
    ['withdrawn', consent(false, 'withdrawn'), 'SHADOW_FILM_CONSENT_WITHDRAWN'],
    ['photo-only', consent(false), 'SHADOW_FILM_CONSENT_EXCLUDES_VIDEO'],
  ])("the video's own athlete: %s consent refuses before any download", async (_label, result, code) => {
    mockCheckConsent.mockImplementation(async (_org, id) => (id === 'ATH-1' ? result : consent(true)));

    const run = await processNextShadowJob();

    expect(run.error).toBe(code);
    expect(mockCheckConsent).toHaveBeenCalledWith('org-1', 'ATH-1');
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockAnalyze).not.toHaveBeenCalled();
    expect(mockCreateProposal).not.toHaveBeenCalled();
    expect(mockComplete).not.toHaveBeenCalled();
    // A guardian's decision, not a blip: not retried.
    expect(mockFail).toHaveBeenCalledWith(expect.anything(), code, { retryable: false });
  });

  test.each([
    ['withdrawn', consent(false, 'withdrawn'), 'SHADOW_FILM_CONSENT_WITHDRAWN'],
    ['photo-only', consent(false), 'SHADOW_FILM_CONSENT_EXCLUDES_VIDEO'],
  ])('a tagged athlete: %s consent refuses before any download', async (_label, result, code) => {
    mockTagSubjects.mockResolvedValue([{ athlete_id: 'ATH-2', athlete_deleted: false }]);
    mockCheckConsent.mockImplementation(async (_org, id) => (id === 'ATH-2' ? result : consent(true)));

    const run = await processNextShadowJob();

    expect(run.error).toBe(code);
    expect(mockTagSubjects).toHaveBeenCalledWith('org-1', 'vs-1');
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockCreateProposal).not.toHaveBeenCalled();
  });

  test('missing consent (no signature on file) refuses', async () => {
    mockAssertConsent.mockRejectedValue(new GuardianConsentMissingError('ATH-1', ['parent-1']));

    const run = await processNextShadowJob();

    expect(run.error).toBe('SHADOW_FILM_CONSENT_BLOCKED');
    expect(mockDownload).not.toHaveBeenCalled();
  });

  test('a tag naming a deleted athlete refuses', async () => {
    mockTagSubjects.mockResolvedValue([{ athlete_id: 'ATH-2', athlete_deleted: true }]);

    const run = await processNextShadowJob();

    expect(run.error).toBe('SHADOW_FILM_CONSENT_BLOCKED');
    expect(mockDownload).not.toHaveBeenCalled();
  });

  test('a withdrawal landing during inference stops the proposal being written', async () => {
    let reads = 0;
    mockCheckConsent.mockImplementation(async () => (++reads === 1 ? consent(true) : consent(false, 'withdrawn')));

    const run = await processNextShadowJob();

    expect(run.error).toBe('SHADOW_FILM_CONSENT_WITHDRAWN');
    expect(mockFail).toHaveBeenCalledWith(expect.anything(), 'SHADOW_FILM_CONSENT_WITHDRAWN', { retryable: false });
    expect(mockAnalyze).toHaveBeenCalled();
    expect(mockCreateProposal).not.toHaveBeenCalled();
    expect(await tempDirsCreated()).toEqual([]);
  });

  test('a conflict from the proposal insert is not filed as a consent refusal', async () => {
    // The insert runs inside the consent-held step, so the classifier must
    // name consent errors rather than treat any 409 as one.
    const { ConflictError } = jest.requireActual<typeof import('./errors')>('./errors');
    mockCreateProposal.mockRejectedValue(new ConflictError('some unrelated conflict', 'SOMETHING_ELSE'));

    const run = await processNextShadowJob();

    expect(run.error).not.toMatch(/^SHADOW_FILM_CONSENT_/);
    expect(mockFail).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), { retryable: false });
  });

  test('a database fault while reading consent is retryable, never read as consent', async () => {
    mockCheckConsent.mockRejectedValue(new Error('connection reset'));

    const run = await processNextShadowJob();

    expect(run.error).toBe('SHADOW_JOB_EXECUTION_FAILED');
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockFail).toHaveBeenCalledWith(expect.anything(), 'SHADOW_JOB_EXECUTION_FAILED');
  });
});

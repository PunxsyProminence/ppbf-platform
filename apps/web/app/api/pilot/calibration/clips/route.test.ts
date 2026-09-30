import type { NextRequest } from 'next/server';

import {
  VideoNotClippableError,
  assertVideoClippable,
  createCalibrationClip,
  listCalibrationClips,
} from '@/src/server/pilot/calibration/projects';
import { requirePrincipal } from '@/src/server/pilot/http';

import { writeCalibrationAuditEvent } from '../annotatorGate';
import { GET, POST } from './route';

/**
 * The clip picker's list.
 *
 * `playable` is a HINT and the suite says so: a false must hide nothing that
 * matters and a true must authorize nothing. What it must never do is leak the
 * reason -- whether a particular video is quarantined is a safeguarding fact
 * about a scan, not a line in a work list.
 */

jest.mock('@/src/server/pilot/calibration/projects', () => {
  const actual = jest.requireActual('@/src/server/pilot/calibration/projects');
  return {
    ...actual,
    listCalibrationClips: jest.fn(),
    assertVideoClippable: jest.fn(),
    createCalibrationClip: jest.fn(),
  };
});

// Doubled so this suite exercises the ROUTE. The audit helper forces
// shadow_mirror: false on every write, which annotatorGate.ts owns and tests.
jest.mock('../annotatorGate', () => {
  const actual = jest.requireActual('../annotatorGate');
  return { ...actual, writeCalibrationAuditEvent: jest.fn() };
});

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockListClips = listCalibrationClips as jest.Mock;
const mockClippable = assertVideoClippable as jest.Mock;
const mockCreateClip = createCalibrationClip as jest.Mock;
const mockAudit = writeCalibrationAuditEvent as jest.Mock;

const COACH = { accountId: 'coach-1', role: 'coach', organizationId: 'org-1' };

const clip = (id: string, videoId: string) => ({
  organization_id: 'org-1',
  calibration_clip_id: id,
  calibration_project_id: 'proj-1',
  video_session_id: videoId,
  athlete_id: 'ath-1',
  clip_code: id.toUpperCase(),
  start_ms: 1_000,
  end_ms: 7_000,
  primary_sampling_reason: 'counter',
});

function get(query = 'calibration_project_id=proj-1'): NextRequest {
  return new Request(`http://localhost/api/pilot/calibration/clips?${query}`) as NextRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('marks each clip with whether the study\'s own gate is satisfied right now', async () => {
  mockPrincipal.mockResolvedValue(COACH);
  mockListClips.mockResolvedValue([clip('clip-1', 'vid-ready'), clip('clip-2', 'vid-held')]);
  mockClippable.mockImplementation(async (_org: string, videoId: string) => {
    if (videoId === 'vid-held') throw new VideoNotClippableError('quarantined');
    return { videoSessionId: videoId, athleteId: 'ath-1' };
  });

  const response = await GET(get());
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.clips).toHaveLength(2);
  expect(body.clips[0].playable).toBe(true);
  expect(body.clips[1].playable).toBe(false);
});

test('the reason a clip is unavailable is never disclosed', async () => {
  mockPrincipal.mockResolvedValue(COACH);
  mockListClips.mockResolvedValue([clip('clip-2', 'vid-held')]);
  mockClippable.mockRejectedValue(new VideoNotClippableError('quarantined'));

  const response = await GET(get());
  const raw = JSON.stringify(await response.json());

  expect(raw).not.toContain('quarantined');
  expect(raw).not.toContain('status');
});

test('the organization is the session\'s, never one named in the query', async () => {
  mockPrincipal.mockResolvedValue(COACH);
  mockListClips.mockResolvedValue([]);

  await GET(get('calibration_project_id=proj-1&organization_id=org-9'));

  expect(mockListClips).toHaveBeenCalledWith('org-1', 'proj-1');
});

test('a missing project id is a 400 naming it', async () => {
  mockPrincipal.mockResolvedValue(COACH);

  const response = await GET(get(''));
  const body = await response.json();

  expect(response.status).toBe(400);
  expect(body.error).toContain('calibration_project_id');
  expect(mockListClips).not.toHaveBeenCalled();
});

test.each(['athlete', 'parent', 'board', 'platform_owner', 'volunteer', 'staff'])(
  'a %s cannot list study clips',
  async (role) => {
    mockPrincipal.mockResolvedValue({ ...COACH, role });

    const response = await GET(get());

    expect(response.status).toBe(403);
    expect(mockListClips).not.toHaveBeenCalled();
  },
);

/*
 * CUTTING A CLIP.
 *
 * The act this build had no door for: clip creation was an operator script run
 * by hand against a production connection string, so the teaching loop could
 * not be walked by a coach.
 *
 * ALMOST NOTHING IS DECIDED IN THE ROUTE, so almost nothing is asserted about
 * rules here. createCalibrationClip owns the width check, the vocabulary and
 * the source gate, and has its own database-backed suite. What this pins is
 * the route's own three jobs: who may ask, that the refusals arrive as
 * sentences a coach can act on, and that nothing is reported as written that
 * was not.
 */

const PROJECT_ID = 'proj-1';

function post(body: unknown): NextRequest {
  return new Request('http://localhost/api/pilot/calibration/clips', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as NextRequest;
}

const validBody = (overrides: Record<string, unknown> = {}) => ({
  calibration_project_id: PROJECT_ID,
  video_session_id: 'vid-teaching',
  clip_code: 'C-01',
  start_ms: 1_000,
  end_ms: 7_000,
  primary_sampling_reason: 'counter',
  ...overrides,
});

const createdClip = {
  organization_id: 'org-1',
  calibration_clip_id: 'clip-new',
  calibration_project_id: PROJECT_ID,
  video_session_id: 'vid-teaching',
  athlete_id: null,
  clip_code: 'C-01',
  start_ms: 1_000,
  end_ms: 7_000,
  primary_sampling_reason: 'counter',
};

describe('POST /api/pilot/calibration/clips', () => {
  test('401 when unauthenticated, and nothing is written', async () => {
    mockPrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    expect((await POST(post(validBody()))).status).toBe(401);
    expect(mockCreateClip).not.toHaveBeenCalled();
  });

  test.each(['athlete', 'parent', 'volunteer', 'staff', 'board', 'platform_owner'])(
    'a %s cannot cut a clip',
    async (role) => {
      mockPrincipal.mockResolvedValueOnce({ ...COACH, role });

      expect((await POST(post(validBody()))).status).toBe(403);
      expect(mockCreateClip).not.toHaveBeenCalled();
    },
  );

  test('a coach cuts a clip, and it is audited without mirroring into SHADOW', async () => {
    mockPrincipal.mockResolvedValueOnce(COACH);
    mockCreateClip.mockResolvedValueOnce(createdClip);

    const response = await POST(post(validBody()));

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true, clip: { clip_code: 'C-01' } });
    expect(mockCreateClip).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      calibrationProjectId: PROJECT_ID,
      videoSessionId: 'vid-teaching',
      startMs: 1_000,
      endMs: 7_000,
      createdByAccountId: 'coach-1',
    }));
    /*
     * writeCalibrationAuditEvent forces shadow_mirror: false. Calibration is a
     * measurement of where trained humans disagree, and a disagreement corpus
     * silently becoming model input would make the measurement unrepeatable --
     * the study would be observing a system it had already changed.
     */
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      entityType: 'calibration_clip',
      entityId: 'clip-new',
    }));
  });

  test.each([
    ['calibration_project_id', { calibration_project_id: '' }],
    ['video_session_id', { video_session_id: '  ' }],
    ['clip_code', { clip_code: '' }],
  ])('a missing %s is a 400 before anything is written', async (_field, overrides) => {
    mockPrincipal.mockResolvedValueOnce(COACH);

    expect((await POST(post(validBody(overrides)))).status).toBe(400);
    expect(mockCreateClip).not.toHaveBeenCalled();
  });

  test('an empty offset becomes NaN, never a silent zero', async () => {
    /*
     * Number('') is 0. Left alone, an empty start box would cut a clip from
     * the beginning of the take and report success -- a real, wrong, silently
     * accepted boundary, which is the exact failure requireWholeMs was written
     * for on the operator script.
     */
    mockPrincipal.mockResolvedValueOnce(COACH);
    mockCreateClip.mockRejectedValueOnce(new Error('Missing start_ms: whole milliseconds only'));

    const response = await POST(post(validBody({ start_ms: '' })));

    expect(response.status).toBe(400);
    expect(Number.isNaN(mockCreateClip.mock.calls[0]![0].startMs)).toBe(true);
  });

  test('the module\'s own refusals reach the caller rather than being reworded', async () => {
    // The width rule, the vocabulary and the source gate all live in
    // createCalibrationClip. A route that restated them would be a second
    // definition, and the two would drift.
    mockPrincipal.mockResolvedValueOnce(COACH);
    mockCreateClip.mockRejectedValueOnce(new Error('Missing end_ms: a clip must end after it starts'));

    const response = await POST(post(validBody({ end_ms: 500 })));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('must end after it starts');
  });

  test('a duplicate clip code is a 409 naming the code, not a raw constraint violation', async () => {
    mockPrincipal.mockResolvedValueOnce(COACH);
    mockCreateClip.mockRejectedValueOnce(Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint: 'pilot_calibration_clips_code_uq',
    }));

    const response = await POST(post(validBody()));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.reason).toBe('CALIBRATION_CLIP_CODE_TAKEN');
    expect(body.error).toContain('C-01');
  });

  test('a DIFFERENT unique violation is not reported as a code collision', async () => {
    /*
     * A colliding UUID on the primary key is a different fault entirely.
     * Telling a coach to "pick another code" over it would send them renaming
     * something that was never the problem -- the reason boardSeats.ts checks
     * the named constraint rather than the bare 23505.
     */
    mockPrincipal.mockResolvedValueOnce(COACH);
    mockCreateClip.mockRejectedValueOnce(Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint: 'pilot_calibration_clips_pkey',
    }));

    const response = await POST(post(validBody()));

    expect(response.status).not.toBe(409);
  });

  test('a failed audit write is reported, and names the clip that survived it', async () => {
    /*
     * The clip exists and cannot be rolled back from here. A caller told only
     * "failed" would cut it again and end up with two, so the refusal says the
     * clip is in the study and must not be re-cut.
     */
    mockPrincipal.mockResolvedValueOnce(COACH);
    mockCreateClip.mockResolvedValueOnce(createdClip);
    mockAudit.mockRejectedValueOnce(new Error('audit table unavailable'));

    const response = await POST(post(validBody()));
    const body = await response.json();

    expect(response.status).not.toBe(201);
    expect(JSON.stringify(body)).toContain('C-01');
  });
});

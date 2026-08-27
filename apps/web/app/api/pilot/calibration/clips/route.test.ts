import type { NextRequest } from 'next/server';

import {
  VideoNotClippableError,
  assertVideoClippable,
  listCalibrationClips,
} from '@/src/server/pilot/calibration/projects';
import { requirePrincipal } from '@/src/server/pilot/http';

import { GET } from './route';

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
  };
});

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockListClips = listCalibrationClips as jest.Mock;
const mockClippable = assertVideoClippable as jest.Mock;

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

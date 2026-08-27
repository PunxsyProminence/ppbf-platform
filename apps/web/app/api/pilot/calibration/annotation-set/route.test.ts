import type { NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  listAnnotationEvents,
  listAnnotationSetsForClip,
  openAnnotationSet,
} from '@/src/server/pilot/calibration/annotations';
import {
  VideoNotClippableError,
  assertVideoClippable,
  getCalibrationClip,
  getCalibrationProject,
} from '@/src/server/pilot/calibration/projects';
import { requirePrincipal } from '@/src/server/pilot/http';

import { GET, POST } from './route';

/**
 * One annotator's workspace on one clip.
 *
 * THE TEST THAT MATTERS MOST IS THE BLINDING-ADJACENT ONE. The module this
 * route reads from (listAnnotationSetsForClip) returns EVERY annotator's set
 * for the clip and says in its own docblock that wiring it to an annotator
 * screen without a gate would defeat the study. So the suite asserts not just
 * that the right set comes back, but that no trace of the other one appears
 * anywhere in the response body.
 */

jest.mock('@/src/server/pilot/calibration/annotations', () => ({
  getAnnotationSet: jest.fn(),
  listAnnotationSetsForClip: jest.fn(),
  listAnnotationEvents: jest.fn(),
  openAnnotationSet: jest.fn(),
}));

jest.mock('@/src/server/pilot/calibration/projects', () => {
  const actual = jest.requireActual('@/src/server/pilot/calibration/projects');
  return {
    ...actual,
    getCalibrationClip: jest.fn(),
    getCalibrationProject: jest.fn(),
    assertVideoClippable: jest.fn(),
  };
});

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockListSets = listAnnotationSetsForClip as jest.Mock;
const mockListEvents = listAnnotationEvents as jest.Mock;
const mockOpen = openAnnotationSet as jest.Mock;
const mockGetClip = getCalibrationClip as jest.Mock;
const mockGetProject = getCalibrationProject as jest.Mock;
const mockClippable = assertVideoClippable as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

const COACH = { accountId: 'coach-1', role: 'coach', organizationId: 'org-1' };

const CLIP = {
  organization_id: 'org-1',
  calibration_clip_id: 'clip-1',
  calibration_project_id: 'proj-1',
  video_session_id: 'vid-1',
  athlete_id: 'ath-1',
  clip_code: 'C-01',
  start_ms: 12_000,
  end_ms: 18_000,
  primary_sampling_reason: 'occlusion',
};

const PROJECT = {
  calibration_project_id: 'proj-1',
  name: 'Pilot study',
  ontology_version: 'boxing-ontology-0.1',
  status: 'annotating',
};

const MY_SET = {
  annotation_set_id: 'set-mine',
  calibration_clip_id: 'clip-1',
  annotator_account_id: 'coach-1',
  ontology_version: 'boxing-ontology-0.1',
  status: 'in_progress',
  submitted_at: null,
};

const THEIR_SET = {
  annotation_set_id: 'set-theirs',
  calibration_clip_id: 'clip-1',
  annotator_account_id: 'coach-2',
  ontology_version: 'boxing-ontology-0.1',
  status: 'in_progress',
  submitted_at: null,
};

function get(query = 'calibration_clip_id=clip-1'): NextRequest {
  return new Request(`http://localhost/api/pilot/calibration/annotation-set?${query}`) as NextRequest;
}

function post(body: unknown): NextRequest {
  return new Request('http://localhost/api/pilot/calibration/annotation-set', {
    method: 'POST',
    body: JSON.stringify(body),
  }) as NextRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAudit.mockResolvedValue(undefined);
});

describe('GET the workspace', () => {
  test('returns the clip, the caller\'s own set, and that set\'s events', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetClip.mockResolvedValue(CLIP);
    mockClippable.mockResolvedValue({ videoSessionId: 'vid-1', athleteId: 'ath-1' });
    mockGetProject.mockResolvedValue(PROJECT);
    mockListSets.mockResolvedValue([MY_SET]);
    mockListEvents.mockResolvedValue([{ event_id: 'evt-1' }]);

    const response = await GET(get());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.clip.calibration_clip_id).toBe('clip-1');
    expect(body.set.annotation_set_id).toBe('set-mine');
    expect(body.events).toEqual([{ event_id: 'evt-1' }]);
    expect(mockListEvents).toHaveBeenCalledWith('org-1', 'set-mine');
  });

  test('the other annotator leaves no trace anywhere in the response', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetClip.mockResolvedValue(CLIP);
    mockClippable.mockResolvedValue({ videoSessionId: 'vid-1', athleteId: 'ath-1' });
    mockGetProject.mockResolvedValue(PROJECT);
    mockListSets.mockResolvedValue([THEIR_SET, MY_SET]);
    mockListEvents.mockResolvedValue([]);

    const response = await GET(get());
    const raw = JSON.stringify(await response.json());

    expect(raw).toContain('set-mine');
    // Not their set id, not their account, not a count of how many sets exist.
    expect(raw).not.toContain('set-theirs');
    expect(raw).not.toContain('coach-2');
    // And their events are never read at all.
    expect(mockListEvents).not.toHaveBeenCalledWith('org-1', 'set-theirs');
  });

  test('no set of the caller\'s own reads as null, not as an empty set someone opened', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetClip.mockResolvedValue(CLIP);
    mockClippable.mockResolvedValue({ videoSessionId: 'vid-1', athleteId: 'ath-1' });
    mockGetProject.mockResolvedValue(PROJECT);
    mockListSets.mockResolvedValue([THEIR_SET]);

    const response = await GET(get());
    const body = await response.json();

    expect(body.set).toBeNull();
    expect(body.events).toEqual([]);
    expect(mockListEvents).not.toHaveBeenCalled();
  });

  test('footage that is no longer clippable is refused on every read, not only at selection', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetClip.mockResolvedValue(CLIP);
    mockClippable.mockRejectedValue(new VideoNotClippableError('quarantined'));

    const response = await GET(get());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toContain('not available for calibration');
    expect(mockListSets).not.toHaveBeenCalled();
  });

  test('a clip in another organization is not found', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetClip.mockResolvedValue(null);

    const response = await GET(get());

    expect(response.status).toBe(404);
    expect(mockGetClip).toHaveBeenCalledWith('org-1', 'clip-1');
    expect(mockClippable).not.toHaveBeenCalled();
  });

  test('the clip id is required, and named when it is missing', async () => {
    mockPrincipal.mockResolvedValue(COACH);

    const response = await GET(get(''));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('calibration_clip_id');
  });

  test('the response is not storable by a shared cache', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetClip.mockResolvedValue(CLIP);
    mockClippable.mockResolvedValue({ videoSessionId: 'vid-1', athleteId: 'ath-1' });
    mockGetProject.mockResolvedValue(PROJECT);
    mockListSets.mockResolvedValue([]);

    const response = await GET(get());

    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });

  test.each(['athlete', 'parent', 'board', 'platform_owner', 'volunteer', 'staff'])(
    'a %s cannot open an annotation workspace',
    async (role) => {
      mockPrincipal.mockResolvedValue({ ...COACH, role });

      const response = await GET(get());

      expect(response.status).toBe(403);
      expect(mockGetClip).not.toHaveBeenCalled();
    },
  );
});

describe('POST to open a set', () => {
  function ready(existing: unknown[] = []) {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetClip.mockResolvedValue(CLIP);
    mockClippable.mockResolvedValue({ videoSessionId: 'vid-1', athleteId: 'ath-1' });
    mockGetProject.mockResolvedValue(PROJECT);
    mockListSets.mockResolvedValue(existing);
  }

  test('opens the caller\'s pass and audits it without mirroring to SHADOW', async () => {
    ready();
    mockOpen.mockResolvedValueOnce(MY_SET);

    const response = await POST(post({ calibration_clip_id: 'clip-1' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.created).toBe(true);
    expect(mockOpen).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      calibrationClipId: 'clip-1',
      annotatorAccountId: 'coach-1',
      ontologyVersion: 'boxing-ontology-0.1',
    }));
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      event_type: 'create',
      entity_type: 'calibration_annotation_set',
      entity_id: 'set-mine',
      shadow_mirror: false,
    });
  });

  test('pressing it twice returns the same set rather than failing on the unique index', async () => {
    ready([MY_SET]);

    const response = await POST(post({ calibration_clip_id: 'clip-1' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.created).toBe(false);
    expect(body.set.annotation_set_id).toBe('set-mine');
    expect(mockOpen).not.toHaveBeenCalled();
    // Nothing changed, so nothing is audited -- otherwise the audit stream
    // cannot be read for when a set was actually created.
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a submitted set comes back as the finished pass it is, not as an error', async () => {
    ready([{ ...MY_SET, status: 'submitted', submitted_at: '2026-08-01T00:00:00.000Z' }]);

    const response = await POST(post({ calibration_clip_id: 'clip-1' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.set.status).toBe('submitted');
    expect(mockOpen).not.toHaveBeenCalled();
  });

  test('never opens another annotator\'s set as though it were the caller\'s', async () => {
    ready([THEIR_SET]);
    mockOpen.mockResolvedValueOnce(MY_SET);

    const response = await POST(post({ calibration_clip_id: 'clip-1' }));
    const body = await response.json();

    expect(body.created).toBe(true);
    expect(body.set.annotation_set_id).toBe('set-mine');
    expect(JSON.stringify(body)).not.toContain('set-theirs');
  });

  test('a project stamped with a vocabulary this build cannot validate is refused', async () => {
    ready();
    mockGetProject.mockResolvedValue({ ...PROJECT, ontology_version: 'boxing-ontology-0.2' });

    const response = await POST(post({ calibration_clip_id: 'clip-1' }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toContain('boxing-ontology-0.2');
    expect(mockOpen).not.toHaveBeenCalled();
  });

  test('quarantined footage cannot have a set opened against it', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetClip.mockResolvedValue(CLIP);
    mockClippable.mockRejectedValue(new VideoNotClippableError('quarantined'));

    const response = await POST(post({ calibration_clip_id: 'clip-1' }));

    expect(response.status).toBe(403);
    expect(mockOpen).not.toHaveBeenCalled();
  });

  test('a missing clip id is a 400 naming it', async () => {
    mockPrincipal.mockResolvedValue(COACH);

    const response = await POST(post({}));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('calibration_clip_id');
  });
});

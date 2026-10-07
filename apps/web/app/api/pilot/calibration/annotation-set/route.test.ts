import type { NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  listAnnotationEvents,
  listAnnotationSetsForClip,
  openAnnotationSet,
  openNextAnnotationPass,
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
  openNextAnnotationPass: jest.fn(),
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
const mockOpenNext = openNextAnnotationPass as jest.Mock;
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
  pass_number: 1,
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

  test('says which vocabulary new studies use and which ones this build can label', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetClip.mockResolvedValue(CLIP);
    mockClippable.mockResolvedValue({ videoSessionId: 'vid-1', athleteId: 'ath-1' });
    mockGetProject.mockResolvedValue(PROJECT);
    mockListSets.mockResolvedValue([MY_SET]);
    mockListEvents.mockResolvedValue([]);

    const body = await (await GET(get())).json();

    expect(body.supported_ontology_version).toBe('boxing-ontology-0.1');
    expect(body.annotatable_ontology_versions).toEqual(['boxing-ontology-0.1']);
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
      details: { calibration_clip_id: 'clip-1', pass_number: 1 },
    });
    expect(mockOpenNext).not.toHaveBeenCalled();
  });

  test('a first pass whose audit record cannot be written fails as it always did', async () => {
    ready();
    mockOpen.mockResolvedValueOnce(MY_SET);
    mockAudit.mockRejectedValueOnce(new Error('audit store unavailable'));

    const response = await POST(post({ calibration_clip_id: 'clip-1' }));

    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty('reason');
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

describe('POST { remark: true } to open the next pass', () => {
  const SUBMITTED = { ...MY_SET, status: 'submitted', submitted_at: '2026-08-01T00:00:00.000Z' };
  const OPEN_REMARK = { ...MY_SET, annotation_set_id: 'set-mine-2', pass_number: 2 };
  const REFUSAL = /^Forbidden: a clip can be re-marked once your first pass on it has been submitted/;

  function ready(existing: unknown[] = []) {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetClip.mockResolvedValue(CLIP);
    mockClippable.mockResolvedValue({ videoSessionId: 'vid-1', athleteId: 'ath-1' });
    mockGetProject.mockResolvedValue(PROJECT);
    mockListSets.mockResolvedValue(existing);
  }

  async function remark(body: Record<string, unknown> = {}) {
    const response = await POST(post({ calibration_clip_id: 'clip-1', remark: true, ...body }));
    return { status: response.status, body: await response.json() };
  }

  function nothingOpened() {
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockOpenNext).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  }

  test('a submitted pass opens the next one, under the project\'s vocabulary, and audits its number', async () => {
    ready([SUBMITTED]);
    mockOpenNext.mockResolvedValueOnce(OPEN_REMARK);

    const { status, body } = await remark();

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, created: true, set: { annotation_set_id: 'set-mine-2', pass_number: 2 } });
    expect(mockOpenNext).toHaveBeenCalledWith({
      organizationId: 'org-1',
      annotationSetId: expect.any(String),
      calibrationClipId: 'clip-1',
      annotatorAccountId: 'coach-1',
      ontologyVersion: 'boxing-ontology-0.1',
      afterPassNumber: 1,
    });
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      event_type: 'create',
      entity_type: 'calibration_annotation_set',
      entity_id: 'set-mine-2',
      shadow_mirror: false,
      details: { calibration_clip_id: 'clip-1', pass_number: 2 },
    });
  });

  test('it is the LATEST pass that counts: a submitted second pass opens a third', async () => {
    ready([SUBMITTED, { ...SUBMITTED, annotation_set_id: 'set-mine-2', pass_number: 2 }]);
    mockOpenNext.mockResolvedValueOnce({ ...OPEN_REMARK, annotation_set_id: 'set-mine-3', pass_number: 3 });

    const { status, body } = await remark();

    expect([status, body.created, body.set.pass_number]).toEqual([200, true, 3]);
    // The pass the route decided on is the one the insert is held to.
    expect(mockOpenNext).toHaveBeenCalledWith(expect.objectContaining({ afterPassNumber: 2 }));
  });

  test('pressing it twice returns the open re-mark rather than opening a third pass', async () => {
    ready([SUBMITTED, OPEN_REMARK]);

    const { status, body } = await remark();

    expect(status).toBe(200);
    expect(body).toMatchObject({ created: false, set: { annotation_set_id: 'set-mine-2' } });
    nothingOpened();
  });

  test.each([
    ['the caller has never labelled the clip', []],
    ['the first pass is still in progress', [MY_SET]],
    ['only another annotator has submitted', [{ ...THEIR_SET, status: 'submitted', pass_number: 1 }]],
  ])('refused when %s', async (_label, existing) => {
    ready(existing);

    const { status, body } = await remark();

    expect(status).toBe(403);
    expect(body.error).toMatch(REFUSAL);
    nothingOpened();
  });

  test.each(['true', 1, 'yes', null, {}])('remark %p is a 400 naming the field, and nothing is read', async (value) => {
    ready([SUBMITTED]);

    const { status, body } = await remark({ remark: value });

    expect(status).toBe(400);
    expect(body.error).toContain('remark');
    expect(mockGetClip).not.toHaveBeenCalled();
    expect(mockListSets).not.toHaveBeenCalled();
    nothingOpened();
  });

  test('remark false is an ordinary open: the finished pass comes back and nothing is created', async () => {
    ready([SUBMITTED]);

    const { status, body } = await remark({ remark: false });

    expect(status).toBe(200);
    expect(body).toMatchObject({ created: false, set: { annotation_set_id: 'set-mine', status: 'submitted' } });
    nothingOpened();
  });

  test('losing the insert to a second tab hands back that tab\'s open re-mark, unaudited', async () => {
    ready([SUBMITTED]);
    mockListSets.mockResolvedValueOnce([SUBMITTED]).mockResolvedValueOnce([SUBMITTED, OPEN_REMARK]);
    mockOpenNext.mockResolvedValueOnce(null);

    const { status, body } = await remark();

    expect(status).toBe(200);
    expect(body).toMatchObject({ created: false, set: { annotation_set_id: 'set-mine-2' } });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test.each([
    ['nothing changed on the re-read', [SUBMITTED]],
    ['another window opened AND submitted the next pass', [SUBMITTED, { ...SUBMITTED, annotation_set_id: 'set-mine-2', pass_number: 2 }]],
  ])('an insert that opened nothing, when %s, is told to reload and nothing is audited', async (_label, reread) => {
    ready([SUBMITTED]);
    mockListSets.mockResolvedValueOnce([SUBMITTED]).mockResolvedValueOnce(reread);
    mockOpenNext.mockResolvedValueOnce(null);

    const { status, body } = await remark();

    expect(status).toBe(403);
    expect(body.error).toMatch(/^Forbidden: this clip was re-marked from another window/);
    expect(body).not.toHaveProperty('set');
    expect(mockOpenNext).toHaveBeenCalledTimes(1);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a pass whose audit record cannot be written is reported as opened, not as a bare failure', async () => {
    ready([SUBMITTED]);
    mockOpenNext.mockResolvedValueOnce(OPEN_REMARK);
    mockAudit.mockRejectedValueOnce(new Error('audit store unavailable'));

    const { status, body } = await remark();

    expect(status).toBe(500);
    expect(body).toMatchObject({ reason: 'CALIBRATION_REMARK_AUDIT_FAILED', annotation_set_id: 'set-mine-2' });
    expect(body.error).toContain('audit store unavailable');
    expect(body.error).toContain('pass 2');
    expect(body.error).toContain('Do not re-mark again');
  });

  test('the answers to a re-mark carry nothing of the earlier pass', async () => {
    ready([SUBMITTED]);
    mockOpenNext.mockResolvedValueOnce(OPEN_REMARK);
    const opened = await POST(post({ calibration_clip_id: 'clip-1', remark: true }));
    expect(await opened.text()).not.toContain('set-mine"');

    ready([SUBMITTED, OPEN_REMARK]);
    const again = await POST(post({ calibration_clip_id: 'clip-1', remark: true }));
    expect(await again.text()).not.toContain('set-mine"');
  });

  test('a clip whose project is gone is not found, and nothing is opened', async () => {
    ready([SUBMITTED]);
    mockGetProject.mockResolvedValue(null);

    expect((await remark()).status).toBe(404);
    nothingOpened();
  });

  test('a project now stamped with another vocabulary than the first pass is refused', async () => {
    ready([{ ...SUBMITTED, ontology_version: 'boxing-ontology-0.4' }]);

    const { status, body } = await remark();

    expect(status).toBe(403);
    expect(body.error).toContain('boxing-ontology-0.4');
    nothingOpened();
  });

  test('a project this build cannot label is refused before anything is opened', async () => {
    ready([SUBMITTED]);
    mockGetProject.mockResolvedValue({ ...PROJECT, ontology_version: 'boxing-ontology-9.9' });

    expect((await remark()).status).toBe(403);
    nothingOpened();
  });

  test('footage that is no longer clippable cannot be re-marked', async () => {
    ready([SUBMITTED]);
    mockClippable.mockRejectedValue(new VideoNotClippableError('quarantined'));

    expect((await remark()).status).toBe(403);
    nothingOpened();
  });

  test.each(['athlete', 'parent', 'board', 'platform_owner', 'volunteer', 'staff'])(
    '%s may not ask, and nothing is read',
    async (role) => {
      ready([SUBMITTED]);
      mockPrincipal.mockResolvedValue({ ...COACH, role });

      expect((await remark()).status).toBe(403);
      expect(mockListSets).not.toHaveBeenCalled();
      nothingOpened();
    },
  );

  test.each(['coach', 'organization_admin', 'admin'])('%s may ask', async (role) => {
    ready([SUBMITTED]);
    mockPrincipal.mockResolvedValue({ ...COACH, role });
    mockOpenNext.mockResolvedValueOnce(OPEN_REMARK);

    expect((await remark()).status).toBe(200);
  });
});

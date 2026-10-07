import type { NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { AnnotationSetSubmittedError, getAnnotationSet } from '@/src/server/pilot/calibration/annotations';
import {
  BodyPointsNotInThisVersionError,
  deleteBodyMoment,
  openBodyMoment,
  updateBodyMoment,
} from '@/src/server/pilot/calibration/bodyPoints';
import {
  VideoNotClippableError,
  assertVideoClippable,
  getCalibrationClip,
} from '@/src/server/pilot/calibration/projects';
import { PilotError } from '@/src/server/pilot/errors';
import { requirePrincipal } from '@/src/server/pilot/http';

import { DELETE, POST, PUT } from './route';

/**
 * The write path for one annotator's moments.
 *
 * As events/route.test.ts: the module is mocked (its rules are proven against
 * a real database in calibrationBodyPointsModule.pg.test.ts); what is under
 * test is what the route does BEFORE and AFTER calling it -- the gate order,
 * that no timing or label is decided here, that a wire blank becomes null and
 * never a value, that each refusal has its status, and that the audit row
 * carries no label.
 */

jest.mock('@/src/server/pilot/calibration/annotations', () => {
  const actual = jest.requireActual('@/src/server/pilot/calibration/annotations');
  return {
    AnnotationSetSubmittedError: actual.AnnotationSetSubmittedError,
    getAnnotationSet: jest.fn(),
    listAnnotationSetsForClip: jest.fn(),
  };
});

jest.mock('@/src/server/pilot/calibration/bodyPoints', () => {
  const actual = jest.requireActual('@/src/server/pilot/calibration/bodyPoints');
  return {
    BodyPointsNotInThisVersionError: actual.BodyPointsNotInThisVersionError,
    openBodyMoment: jest.fn(),
    updateBodyMoment: jest.fn(),
    deleteBodyMoment: jest.fn(),
  };
});

jest.mock('@/src/server/pilot/calibration/projects', () => {
  const actual = jest.requireActual('@/src/server/pilot/calibration/projects');
  return { ...actual, getCalibrationClip: jest.fn(), assertVideoClippable: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockGetSet = getAnnotationSet as jest.Mock;
const mockOpen = openBodyMoment as jest.Mock;
const mockUpdate = updateBodyMoment as jest.Mock;
const mockDelete = deleteBodyMoment as jest.Mock;
const mockGetClip = getCalibrationClip as jest.Mock;
const mockClippable = assertVideoClippable as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

const COACH = { accountId: 'coach-1', role: 'coach', organizationId: 'org-1' };

const OPEN_SET = {
  organization_id: 'org-1',
  annotation_set_id: 'set-1',
  calibration_clip_id: 'clip-1',
  annotator_account_id: 'coach-1',
  ontology_version: 'boxing-ontology-0.4',
  status: 'in_progress',
  submitted_at: null,
};
const SUBMITTED = { ...OPEN_SET, status: 'submitted', submitted_at: '2026-10-01T00:00:00.000Z' };

const CLIP = {
  organization_id: 'org-1',
  calibration_clip_id: 'clip-1',
  calibration_project_id: 'proj-1',
  video_session_id: 'vid-1',
  athlete_id: null,
  clip_code: 'C-01',
  start_ms: 12_000,
  end_ms: 18_000,
  primary_sampling_reason: 'isolated_punch',
};

const STORED = {
  body_moment_id: 'm-1',
  annotation_set_id: 'set-1',
  event_id: 'evt-1',
  moment_slot: 'middle',
  moment_kind: 'contact',
  observation_ms: 12_600,
  lead_side: 'orthodox',
  guard_type: 'usa_boxing__high_double_guard',
};

const OPEN_BODY = {
  annotation_set_id: 'set-1',
  event_id: 'evt-1',
  moment_slot: 'middle',
  lead_side: 'orthodox',
  guard_type: '',
  source_frame_width_px: '1920',
  source_frame_height_px: '1080',
};

function request(method: string, body: unknown): NextRequest {
  return new Request('http://localhost/api/pilot/calibration/body-points/moments', {
    method,
    body: JSON.stringify(body),
  }) as NextRequest;
}

function openSetReady(set = OPEN_SET) {
  mockPrincipal.mockResolvedValue(COACH);
  mockGetSet.mockResolvedValue(set);
  mockGetClip.mockResolvedValue(CLIP);
  mockClippable.mockResolvedValue({ videoSessionId: 'vid-1', athleteId: null });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAudit.mockResolvedValue(undefined);
});

describe('opening a moment', () => {
  test('the module gets the event and slot, blanks as null, pixels as numbers, and no id of the client\'s; no time unless the coach picked one', async () => {
    openSetReady();
    mockOpen.mockResolvedValueOnce(STORED);

    const response = await POST(request('POST', OPEN_BODY));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.moment).toEqual(STORED);
    const input = mockOpen.mock.calls[0][0];
    expect(input).toMatchObject({
      organizationId: 'org-1',
      annotationSetId: 'set-1',
      eventId: 'evt-1',
      momentSlot: 'middle',
      observationMs: null,
      leadSide: 'orthodox',
      guardType: null,
      sourceFrameWidthPx: 1920,
      sourceFrameHeightPx: 1080,
    });
    expect('bodyMomentId' in input).toBe(false);
  });

  test('a body_moment_id sent on open is ignored: the id is the module\'s to mint', async () => {
    openSetReady();
    mockOpen.mockResolvedValueOnce(STORED);

    await POST(request('POST', { ...OPEN_BODY, body_moment_id: 'm-chosen' }));

    expect('bodyMomentId' in mockOpen.mock.calls[0][0]).toBe(false);
  });

  test('a coach-picked middle time reaches the module as a number; the module, not the route, decides whether it may', async () => {
    openSetReady();
    mockOpen.mockResolvedValueOnce({ ...STORED, moment_kind: 'full_extension', observation_ms: 12_500 });

    await POST(request('POST', { ...OPEN_BODY, observation_ms: '12500' }));

    expect(mockOpen.mock.calls[0][0].observationMs).toBe(12_500);
  });

  test('the module\'s refusal of a field is a 400 naming it, and nothing is audited', async () => {
    openSetReady();
    mockOpen.mockRejectedValueOnce(new Error('Missing guard_type: not a value in the body-point vocabulary'));

    const response = await POST(request('POST', { ...OPEN_BODY, guard_type: 'high' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('guard_type');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a 0.1 set has no body points: the module\'s refusal is a 403 that names the version', async () => {
    openSetReady({ ...OPEN_SET, ontology_version: 'boxing-ontology-0.1' });
    mockOpen.mockRejectedValueOnce(new BodyPointsNotInThisVersionError('boxing-ontology-0.1'));

    const response = await POST(request('POST', OPEN_BODY));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toContain('boxing-ontology-0.1');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('an occupied slot is the module\'s 409', async () => {
    openSetReady();
    mockOpen.mockRejectedValueOnce(new PilotError(409, 'Conflict: this event already has a moment in that slot'));

    const response = await POST(request('POST', OPEN_BODY));

    expect(response.status).toBe(409);
  });

  test('an event not in this set is a 404', async () => {
    openSetReady();
    mockOpen.mockRejectedValueOnce(new Error('Not found: no such event in this annotation set'));

    const response = await POST(request('POST', OPEN_BODY));

    expect(response.status).toBe(404);
  });

  test('the audit row names the event and slot, never the lead side or guard, with the SHADOW mirror off', async () => {
    openSetReady();
    mockOpen.mockResolvedValueOnce(STORED);

    await POST(request('POST', OPEN_BODY));

    const audit = mockAudit.mock.calls[0][0];
    expect(audit).toMatchObject({ event_type: 'create', entity_type: 'calibration_body_moment', entity_id: 'm-1', shadow_mirror: false });
    expect(audit.details).toEqual({ annotation_set_id: 'set-1', event_id: 'evt-1', moment_slot: 'middle' });
    expect(JSON.stringify(audit.details)).not.toMatch(/orthodox|guard/);
  });

  test('footage that has left ready refuses the write before the module is called', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(OPEN_SET);
    mockGetClip.mockResolvedValue(CLIP);
    mockClippable.mockRejectedValue(new VideoNotClippableError('Forbidden: video is not ready for clipping'));

    const response = await POST(request('POST', OPEN_BODY));

    expect(response.status).toBe(403);
    expect(mockOpen).not.toHaveBeenCalled();
  });
});

describe('relabelling a moment', () => {
  test('only the keys the client sent reach the module; a blank clears, an absent key leaves alone', async () => {
    openSetReady();
    mockUpdate.mockResolvedValueOnce({ ...STORED, guard_type: null });

    const response = await PUT(request('PUT', { annotation_set_id: 'set-1', body_moment_id: 'm-1', guard_type: '', observation_ms: '12550' }));

    expect(response.status).toBe(200);
    const input = mockUpdate.mock.calls[0][0];
    expect(input).toEqual({
      organizationId: 'org-1',
      annotationSetId: 'set-1',
      bodyMomentId: 'm-1',
      guardType: null,
      observationMs: 12_550,
    });
    expect('leadSide' in input).toBe(false);
    expect(mockAudit.mock.calls[0][0].details).toEqual({
      annotation_set_id: 'set-1', event_id: 'evt-1', moment_slot: 'middle', fields: ['observationMs', 'guardType'],
    });
  });

  test('a time sent for a derived moment is the module\'s 400', async () => {
    openSetReady();
    mockUpdate.mockRejectedValueOnce(new Error('Missing observation_ms: the start moment sits on the event\'s start; do not send a time'));

    const response = await PUT(request('PUT', { annotation_set_id: 'set-1', body_moment_id: 'm-1', observation_ms: 12_400 }));

    expect(response.status).toBe(400);
  });

  test('a missing moment id is a 400', async () => {
    mockPrincipal.mockResolvedValue(COACH);

    const response = await PUT(request('PUT', { annotation_set_id: 'set-1', lead_side: 'southpaw' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('body_moment_id');
    expect(mockGetSet).not.toHaveBeenCalled();
  });
});

describe('removing a moment', () => {
  test('removes without a clippability check, and audits the action only', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(OPEN_SET);
    mockDelete.mockResolvedValueOnce(true);

    const response = await DELETE(request('DELETE', { annotation_set_id: 'set-1', body_moment_id: 'm-1' }));

    expect(response.status).toBe(200);
    expect(mockClippable).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalledWith('org-1', 'set-1', 'm-1');
    expect(mockAudit.mock.calls[0][0].details).toEqual({ action: 'delete', annotation_set_id: 'set-1' });
  });

  test('a moment that is not in this set is a 404', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(OPEN_SET);
    mockDelete.mockResolvedValueOnce(false);

    const response = await DELETE(request('DELETE', { annotation_set_id: 'set-1', body_moment_id: 'm-9' }));

    expect(response.status).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('the gates, on every method', () => {
  const calls: Array<[string, (r: NextRequest) => Promise<Response>, unknown]> = [
    ['POST', POST, OPEN_BODY],
    ['PUT', PUT, { annotation_set_id: 'set-1', body_moment_id: 'm-1', lead_side: 'southpaw' }],
    ['DELETE', DELETE, { annotation_set_id: 'set-1', body_moment_id: 'm-1' }],
  ];

  test.each(calls)('%s on a submitted set is a 403 before the module is called', async (method, handler, body) => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(SUBMITTED);

    const response = await handler(request(method, body));

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain('submitted');
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test.each(calls)('%s: a race the module loses to a submission is the same 403', async (method, handler, body) => {
    openSetReady();
    mockOpen.mockRejectedValue(new AnnotationSetSubmittedError());
    mockUpdate.mockRejectedValue(new AnnotationSetSubmittedError());
    mockDelete.mockRejectedValue(new AnnotationSetSubmittedError());

    const response = await handler(request(method, body));

    expect(response.status).toBe(403);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test.each(calls)('%s on another annotator\'s set is absent, not forbidden', async (method, handler, body) => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue({ ...OPEN_SET, annotator_account_id: 'coach-2' });

    const response = await handler(request(method, body));

    expect(response.status).toBe(404);
    expect((await response.json()).error).not.toContain('Forbidden');
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test.each(calls)('%s on a set in another organization is absent', async (method, handler, body) => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(null);

    const response = await handler(request(method, body));

    expect(response.status).toBe(404);
    expect(mockGetSet).toHaveBeenCalledWith('org-1', 'set-1');
  });

  test.each(['athlete', 'parent', 'board', 'platform_owner', 'volunteer', 'staff'])('a %s is refused on every method before any lookup', async (role) => {
    mockPrincipal.mockResolvedValue({ ...COACH, role });
    for (const [method, handler, body] of calls) {
      const response = await handler(request(method, body));
      expect(response.status).toBe(403);
    }
    expect(mockGetSet).not.toHaveBeenCalled();
  });

  test('an organization admin may open a moment on their own set', async () => {
    openSetReady();
    mockPrincipal.mockResolvedValue({ ...COACH, role: 'organization_admin' });
    mockOpen.mockResolvedValueOnce(STORED);

    const response = await POST(request('POST', OPEN_BODY));

    expect(response.status).toBe(200);
  });

  test.each(calls)('%s without a session is a 401', async (method, handler, body) => {
    mockPrincipal.mockRejectedValue(new Error('Unauthorized'));

    const response = await handler(request(method, body));

    expect(response.status).toBe(401);
  });

  test.each(calls)('%s without a set id is a 400 naming it', async (method, handler) => {
    mockPrincipal.mockResolvedValue(COACH);

    const response = await handler(request(method, {}));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('annotation_set_id');
  });
});

import type { NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { AnnotationSetSubmittedError, getAnnotationSet } from '@/src/server/pilot/calibration/annotations';
import { BodyPointsNotInThisVersionError, deleteBodyPoint, markBodyPoints } from '@/src/server/pilot/calibration/bodyPoints';
import { VideoNotClippableError, assertVideoClippable, getCalibrationClip } from '@/src/server/pilot/calibration/projects';
import { requirePrincipal } from '@/src/server/pilot/http';

import { DELETE, PUT } from './route';

/**
 * The write path for one annotator's points at a moment. The module's rules
 * (the version's point list, placed-or-not-visible, [0, 1]) are proven against
 * a real database; here: the gate order, that a wire value is handed over
 * untouched so a string never becomes a position, and that no coordinate
 * reaches the audit table.
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
    markBodyPoints: jest.fn(),
    deleteBodyPoint: jest.fn(),
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
const mockMark = markBodyPoints as jest.Mock;
const mockDelete = deleteBodyPoint as jest.Mock;
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
const CLIP = { organization_id: 'org-1', calibration_clip_id: 'clip-1', video_session_id: 'vid-1', athlete_id: null, start_ms: 12_000, end_ms: 18_000 };

const MARK_BODY = {
  annotation_set_id: 'set-1',
  body_moment_id: 'm-1',
  points: [
    { point_code: 'nose', state: 'placed', x_norm: 0.41, y_norm: 0.22 },
    { point_code: 'chin', state: 'not_visible' },
  ],
};
const STORED = [
  { body_point_id: 'p-1', body_moment_id: 'm-1', point_code: 'nose', state: 'placed', x_norm: 0.41, y_norm: 0.22 },
  { body_point_id: 'p-2', body_moment_id: 'm-1', point_code: 'chin', state: 'not_visible', x_norm: null, y_norm: null },
];

function request(method: string, body: unknown): NextRequest {
  return new Request('http://localhost/api/pilot/calibration/body-points/points', {
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

describe('marking points', () => {
  test('every point reaches the module as sent, and the marks come back', async () => {
    openSetReady();
    mockMark.mockResolvedValueOnce(STORED);

    const response = await PUT(request('PUT', MARK_BODY));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.points).toEqual(STORED);
    expect(mockMark.mock.calls[0][0]).toEqual({
      organizationId: 'org-1',
      annotationSetId: 'set-1',
      bodyMomentId: 'm-1',
      points: [
        { pointCode: 'nose', state: 'placed', xNorm: 0.41, yNorm: 0.22 },
        { pointCode: 'chin', state: 'not_visible', xNorm: undefined, yNorm: undefined },
      ],
    });
  });

  test('a string coordinate is handed over as a string, for the module to refuse by name -- never parsed into a position', async () => {
    openSetReady();
    mockMark.mockRejectedValueOnce(new Error('Missing x_norm: expected a number from 0 to 1, a fraction of the picture'));

    const response = await PUT(request('PUT', { ...MARK_BODY, points: [{ point_code: 'nose', state: 'placed', x_norm: '0.5', y_norm: 0.5 }] }));
    const json = await response.json();

    expect(mockMark.mock.calls[0][0].points[0].xNorm).toBe('0.5');
    expect(response.status).toBe(400);
    expect(json.error).toContain('x_norm');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a point outside the set\'s version is the module\'s 400 naming point_code', async () => {
    openSetReady();
    mockMark.mockRejectedValueOnce(new Error('Missing point_code: not a point in boxing-ontology-0.4'));

    const response = await PUT(request('PUT', { ...MARK_BODY, points: [{ point_code: 'left_ankle', state: 'placed', x_norm: 0.5, y_norm: 0.5 }] }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('point_code');
  });

  test('a 0.1 set has no body points: the module\'s refusal is a 403', async () => {
    openSetReady({ ...OPEN_SET, ontology_version: 'boxing-ontology-0.1' });
    mockMark.mockRejectedValueOnce(new BodyPointsNotInThisVersionError('boxing-ontology-0.1'));

    const response = await PUT(request('PUT', MARK_BODY));

    expect(response.status).toBe(403);
    expect((await response.json()).error).toContain('boxing-ontology-0.1');
  });

  test('an entry that is not an object reaches the module as it is, for its own refusal', async () => {
    openSetReady();
    mockMark.mockRejectedValueOnce(new Error('Missing points: each point is an object with point_code and state'));

    const response = await PUT(request('PUT', { ...MARK_BODY, points: [null, 'nose'] }));

    expect(mockMark.mock.calls[0][0].points).toEqual([null, 'nose']);
    expect(response.status).toBe(400);
  });

  test('points that are not a list is a 400 before any lookup', async () => {
    mockPrincipal.mockResolvedValue(COACH);

    const response = await PUT(request('PUT', { ...MARK_BODY, points: { point_code: 'nose' } }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('points');
    expect(mockGetSet).not.toHaveBeenCalled();
  });

  test('the audit row carries counts only: no coordinate, no state, no code', async () => {
    openSetReady();
    mockMark.mockResolvedValueOnce(STORED);

    await PUT(request('PUT', MARK_BODY));

    const audit = mockAudit.mock.calls[0][0];
    expect(audit).toMatchObject({ event_type: 'update', entity_type: 'calibration_body_point', entity_id: 'm-1', shadow_mirror: false });
    expect(audit.details).toEqual({ action: 'mark', annotation_set_id: 'set-1', marked: 2, on_moment: 2 });
    expect(JSON.stringify(audit.details)).not.toMatch(/0\.41|0\.22|placed|not_visible|nose|chin/);
  });

  test('footage that has left ready refuses the mark before the module is called', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(OPEN_SET);
    mockGetClip.mockResolvedValue(CLIP);
    mockClippable.mockRejectedValue(new VideoNotClippableError('Forbidden: video is not ready for clipping'));

    const response = await PUT(request('PUT', MARK_BODY));

    expect(response.status).toBe(403);
    expect(mockMark).not.toHaveBeenCalled();
  });
});

describe('unmarking a point', () => {
  test('removes one point without a clippability check', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(OPEN_SET);
    mockDelete.mockResolvedValueOnce(true);

    const response = await DELETE(request('DELETE', { annotation_set_id: 'set-1', body_moment_id: 'm-1', point_code: 'nose' }));

    expect(response.status).toBe(200);
    expect(mockClippable).not.toHaveBeenCalled();
    expect(mockDelete).toHaveBeenCalledWith('org-1', 'set-1', 'm-1', 'nose');
    expect(mockAudit.mock.calls[0][0].details).toEqual({ action: 'unmark', annotation_set_id: 'set-1' });
  });

  test('a point that is not there is a 404; a missing code is a 400', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(OPEN_SET);
    mockDelete.mockResolvedValueOnce(false);

    expect((await DELETE(request('DELETE', { annotation_set_id: 'set-1', body_moment_id: 'm-1', point_code: 'nose' }))).status).toBe(404);
    expect((await DELETE(request('DELETE', { annotation_set_id: 'set-1', body_moment_id: 'm-1' }))).status).toBe(400);
  });
});

describe('the gates, on both methods', () => {
  const calls: Array<[string, (r: NextRequest) => Promise<Response>, unknown]> = [
    ['PUT', PUT, MARK_BODY],
    ['DELETE', DELETE, { annotation_set_id: 'set-1', body_moment_id: 'm-1', point_code: 'nose' }],
  ];

  test.each(calls)('%s on a submitted set is a 403 before the module is called', async (method, handler, body) => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(SUBMITTED);

    const response = await handler(request(method, body));

    expect(response.status).toBe(403);
    expect(mockMark).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test.each(calls)('%s: a race the module loses to a submission is the same 403', async (method, handler, body) => {
    openSetReady();
    mockMark.mockRejectedValue(new AnnotationSetSubmittedError());
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
    expect(mockMark).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test.each(calls)('%s on a set in another organization is absent', async (method, handler, body) => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(null);

    const response = await handler(request(method, body));

    expect(response.status).toBe(404);
    expect(mockGetSet).toHaveBeenCalledWith('org-1', 'set-1');
  });

  test.each(['athlete', 'parent', 'board', 'platform_owner', 'volunteer', 'staff'])('a %s is refused on both methods before any lookup', async (role) => {
    mockPrincipal.mockResolvedValue({ ...COACH, role });
    for (const [method, handler, body] of calls) {
      expect((await handler(request(method, body))).status).toBe(403);
    }
    expect(mockGetSet).not.toHaveBeenCalled();
  });

  test.each(calls)('%s without a session is a 401', async (method, handler, body) => {
    mockPrincipal.mockRejectedValue(new Error('Unauthorized'));

    expect((await handler(request(method, body))).status).toBe(401);
  });

  test.each(calls)('%s without a moment id is a 400 naming it', async (method, handler) => {
    mockPrincipal.mockResolvedValue(COACH);

    const response = await handler(request(method, { annotation_set_id: 'set-1' }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('body_moment_id');
  });
});

import type { NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { AnnotationSetSubmittedError, getAnnotationSet } from '@/src/server/pilot/calibration/annotations';
import { BodyPointsNotInThisVersionError, clearEventStanceType, setEventStanceType } from '@/src/server/pilot/calibration/bodyPoints';
import { VideoNotClippableError, assertVideoClippable, getCalibrationClip } from '@/src/server/pilot/calibration/projects';
import { requirePrincipal } from '@/src/server/pilot/http';

import { DELETE, PUT } from './route';

/** The stance type of one event: gate order, the value handed over as sent,
 * and an audit row that names the event and not the stance. */

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
    setEventStanceType: jest.fn(),
    clearEventStanceType: jest.fn(),
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
const mockSet = setEventStanceType as jest.Mock;
const mockClear = clearEventStanceType as jest.Mock;
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
const SET_BODY = { annotation_set_id: 'set-1', event_id: 'evt-1', stance_type: 'aiba__crouching_stance' };
const STORED = { annotation_set_id: 'set-1', event_id: 'evt-1', stance_type: 'aiba__crouching_stance' };

function request(method: string, body: unknown): NextRequest {
  return new Request('http://localhost/api/pilot/calibration/body-points/stance', {
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

describe('setting the stance type', () => {
  test('the value reaches the module as sent, and the audit row names the event, not the stance', async () => {
    openSetReady();
    mockSet.mockResolvedValueOnce(STORED);

    const response = await PUT(request('PUT', SET_BODY));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.stance_label).toEqual(STORED);
    expect(mockSet).toHaveBeenCalledWith({ organizationId: 'org-1', annotationSetId: 'set-1', eventId: 'evt-1', stanceType: 'aiba__crouching_stance' });
    const audit = mockAudit.mock.calls[0][0];
    expect(audit).toMatchObject({ event_type: 'update', entity_type: 'calibration_event_stance_label', entity_id: 'evt-1', shadow_mirror: false });
    expect(audit.details).toEqual({ action: 'set', annotation_set_id: 'set-1' });
  });

  test('a stance outside the list is the module\'s 400 naming stance_type', async () => {
    openSetReady();
    mockSet.mockRejectedValueOnce(new Error('Missing stance_type: not a value in the body-point vocabulary'));

    const response = await PUT(request('PUT', { ...SET_BODY, stance_type: 'orthodox' }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('stance_type');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a 0.1 set has no stance types: the module\'s refusal is a 403', async () => {
    openSetReady({ ...OPEN_SET, ontology_version: 'boxing-ontology-0.1' });
    mockSet.mockRejectedValueOnce(new BodyPointsNotInThisVersionError('boxing-ontology-0.1'));

    expect((await PUT(request('PUT', SET_BODY))).status).toBe(403);
  });

  test('an event not in this set is a 404', async () => {
    openSetReady();
    mockSet.mockRejectedValueOnce(new Error('Not found: no such event in this annotation set'));

    expect((await PUT(request('PUT', SET_BODY))).status).toBe(404);
  });

  test('footage that has left ready refuses the write before the module is called', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(OPEN_SET);
    mockGetClip.mockResolvedValue(CLIP);
    mockClippable.mockRejectedValue(new VideoNotClippableError('Forbidden: video is not ready for clipping'));

    expect((await PUT(request('PUT', SET_BODY))).status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
  });
});

describe('clearing the stance type', () => {
  test('clears without a clippability check; nothing to clear is a 404', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(OPEN_SET);
    mockClear.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    expect((await DELETE(request('DELETE', { annotation_set_id: 'set-1', event_id: 'evt-1' }))).status).toBe(200);
    expect(mockClippable).not.toHaveBeenCalled();
    expect(mockClear).toHaveBeenCalledWith('org-1', 'set-1', 'evt-1');
    expect(mockAudit.mock.calls[0][0].details).toEqual({ action: 'clear', annotation_set_id: 'set-1' });

    expect((await DELETE(request('DELETE', { annotation_set_id: 'set-1', event_id: 'evt-1' }))).status).toBe(404);
    expect(mockAudit).toHaveBeenCalledTimes(1);
  });
});

describe('the gates, on both methods', () => {
  const calls: Array<[string, (r: NextRequest) => Promise<Response>, unknown]> = [
    ['PUT', PUT, SET_BODY],
    ['DELETE', DELETE, { annotation_set_id: 'set-1', event_id: 'evt-1' }],
  ];

  test.each(calls)('%s on a submitted set is a 403 before the module is called', async (method, handler, body) => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(SUBMITTED);

    expect((await handler(request(method, body))).status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockClear).not.toHaveBeenCalled();
  });

  test.each(calls)('%s: a race the module loses to a submission is the same 403', async (method, handler, body) => {
    openSetReady();
    mockSet.mockRejectedValue(new AnnotationSetSubmittedError());
    mockClear.mockRejectedValue(new AnnotationSetSubmittedError());

    expect((await handler(request(method, body))).status).toBe(403);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test.each(calls)('%s on another annotator\'s set is absent, not forbidden', async (method, handler, body) => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue({ ...OPEN_SET, annotator_account_id: 'coach-2' });

    const response = await handler(request(method, body));

    expect(response.status).toBe(404);
    expect((await response.json()).error).not.toContain('Forbidden');
    expect(mockSet).not.toHaveBeenCalled();
    expect(mockClear).not.toHaveBeenCalled();
  });

  test.each(calls)('%s on a set in another organization is absent', async (method, handler, body) => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(null);

    expect((await handler(request(method, body))).status).toBe(404);
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

  test.each(calls)('%s without an event id is a 400 naming it', async (method, handler) => {
    mockPrincipal.mockResolvedValue(COACH);

    const response = await handler(request(method, { annotation_set_id: 'set-1' }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('event_id');
  });
});

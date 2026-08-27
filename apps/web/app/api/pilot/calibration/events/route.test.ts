import type { NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  deleteAnnotationEvent,
  getAnnotationSet,
  listAnnotationEvents,
  recordAnnotationEvent,
} from '@/src/server/pilot/calibration/annotations';
import {
  VideoNotClippableError,
  assertVideoClippable,
  getCalibrationClip,
} from '@/src/server/pilot/calibration/projects';
import { requirePrincipal } from '@/src/server/pilot/http';

import { DELETE, POST, PUT } from './route';

/**
 * The write path for one annotator's events.
 *
 * WHAT THIS SUITE IS FOR. Every refusal below is one an annotator could
 * otherwise route around, and three of them are the reason the study means
 * anything at all: a submitted set is frozen, another annotator's set is not
 * reachable, and footage that has left 'ready' cannot be annotated. The rest
 * pin the shape of what reaches the calibration modules -- particularly that a
 * blank optional control becomes null ("not recorded") and never a vocabulary
 * value nobody chose.
 *
 * The calibration modules themselves are mocked. Their validation is theirs
 * and is tested against a real database in calibrationAnnotations.pg.test.ts;
 * what is under test here is what the route does BEFORE and AFTER calling
 * them, and that it does not duplicate, weaken or bypass any of it.
 */

jest.mock('@/src/server/pilot/calibration/annotations', () => ({
  getAnnotationSet: jest.fn(),
  listAnnotationSetsForClip: jest.fn(),
  listAnnotationEvents: jest.fn(),
  recordAnnotationEvent: jest.fn(),
  deleteAnnotationEvent: jest.fn(),
}));

jest.mock('@/src/server/pilot/calibration/projects', () => {
  const actual = jest.requireActual('@/src/server/pilot/calibration/projects');
  return {
    ...actual,
    getCalibrationClip: jest.fn(),
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
const mockGetSet = getAnnotationSet as jest.Mock;
const mockListEvents = listAnnotationEvents as jest.Mock;
const mockRecord = recordAnnotationEvent as jest.Mock;
const mockDelete = deleteAnnotationEvent as jest.Mock;
const mockGetClip = getCalibrationClip as jest.Mock;
const mockClippable = assertVideoClippable as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

const COACH = { accountId: 'coach-1', role: 'coach', organizationId: 'org-1' };

const OPEN_SET = {
  organization_id: 'org-1',
  annotation_set_id: 'set-1',
  calibration_clip_id: 'clip-1',
  annotator_account_id: 'coach-1',
  ontology_version: 'boxing-ontology-0.1',
  status: 'in_progress',
  submitted_at: null,
};

const CLIP = {
  organization_id: 'org-1',
  calibration_clip_id: 'clip-1',
  calibration_project_id: 'proj-1',
  video_session_id: 'vid-1',
  athlete_id: 'ath-1',
  clip_code: 'C-01',
  start_ms: 12_000,
  end_ms: 18_000,
  primary_sampling_reason: 'combination',
};

const PUNCH_BODY = {
  annotation_set_id: 'set-1',
  event_class: 'punch',
  actor_track: 'red corner',
  opponent_track: 'blue corner',
  start_ms: 12_400,
  end_ms: 12_760,
  contact_ms: '12600',
  peak_ms: '',
  physical_hand: 'left',
  hand_role: 'lead',
  stance: 'orthodox',
  punch_type: 'lead_straight',
  target_zone: 'head',
  contact_result: 'glancing_target_contact',
  contact_zone: '',
  visibility: 'partially_occluded',
  certainty: 'probable',
  combination_group: '',
  sequence_order: '',
  counter_against_event_id: '',
};

const DEFENSE_BODY = {
  annotation_set_id: 'set-1',
  event_class: 'defense',
  actor_track: 'blue corner',
  start_ms: 12_500,
  end_ms: 12_900,
  physical_hand: 'right',
  hand_role: 'rear',
  stance: '',
  defense_type: 'parry',
  visibility: 'clear',
  certainty: 'clear',
  defends_against_event_id: '',
};

function post(body: unknown): NextRequest {
  return new Request('http://localhost/api/pilot/calibration/events', {
    method: 'POST',
    body: JSON.stringify(body),
  }) as NextRequest;
}

function put(body: unknown): NextRequest {
  return new Request('http://localhost/api/pilot/calibration/events', {
    method: 'PUT',
    body: JSON.stringify(body),
  }) as NextRequest;
}

function del(body: unknown): NextRequest {
  return new Request('http://localhost/api/pilot/calibration/events', {
    method: 'DELETE',
    body: JSON.stringify(body),
  }) as NextRequest;
}

function storedEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'evt-new',
    annotation_set_id: 'set-1',
    event_class: 'punch',
    start_ms: 12_400,
    end_ms: 12_760,
    ...overrides,
  };
}

function openSetReady() {
  mockPrincipal.mockResolvedValue(COACH);
  mockGetSet.mockResolvedValue(OPEN_SET);
  mockGetClip.mockResolvedValue(CLIP);
  mockClippable.mockResolvedValue({ videoSessionId: 'vid-1', athleteId: 'ath-1' });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAudit.mockResolvedValue(undefined);
});

describe('recording an event', () => {
  test('a punch reaches the module with every required field the annotator chose', async () => {
    openSetReady();
    mockRecord.mockResolvedValueOnce(storedEvent());

    const response = await POST(post(PUNCH_BODY));

    expect(response.status).toBe(200);
    const input = mockRecord.mock.calls[0][0];
    expect(input).toMatchObject({
      organizationId: 'org-1',
      annotationSetId: 'set-1',
      eventClass: 'punch',
      actorTrack: 'red corner',
      opponentTrack: 'blue corner',
      startMs: 12_400,
      endMs: 12_760,
      contactMs: 12_600,
      physicalHand: 'left',
      handRole: 'lead',
      stance: 'orthodox',
      punchType: 'lead_straight',
      targetZone: 'head',
      contactResult: 'glancing_target_contact',
      visibility: 'partially_occluded',
      certainty: 'probable',
    });
  });

  test('a defense carries no punch fields, and its blanks are null rather than a value', async () => {
    openSetReady();
    mockRecord.mockResolvedValueOnce(storedEvent({ event_id: 'evt-d', event_class: 'defense' }));

    const response = await POST(post(DEFENSE_BODY));

    expect(response.status).toBe(200);
    const input = mockRecord.mock.calls[0][0];
    expect(input.defenseType).toBe('parry');
    expect(input.punchType).toBeNull();
    expect(input.targetZone).toBeNull();
    expect(input.contactResult).toBeNull();
    expect(input.contactZone).toBeNull();
    expect(input.combinationGroup).toBeNull();
    expect(input.sequenceOrder).toBeNull();
    expect(input.counterAgainstEventId).toBeNull();
    // A blank stance is "not recorded" -- never 'unknown', which is the
    // recorded observation "I looked and could not tell".
    expect(input.stance).toBeNull();
  });

  test('an unselected optional control never becomes an ontology value', async () => {
    openSetReady();
    mockRecord.mockResolvedValueOnce(storedEvent());

    await POST(post(PUNCH_BODY));

    const input = mockRecord.mock.calls[0][0];
    expect(input.contactZone).toBeNull();
    expect(input.peakMs).toBeNull();
    expect(input.combinationGroup).toBeNull();
    expect(input.sequenceOrder).toBeNull();
  });

  test('an empty timestamp is passed on as absent, never as zero', async () => {
    openSetReady();
    mockRecord.mockRejectedValueOnce(
      new Error('Missing start_ms: expected a whole number of milliseconds, zero or greater'),
    );

    const response = await POST(post({ ...PUNCH_BODY, start_ms: '' }));
    const body = await response.json();

    expect(mockRecord.mock.calls[0][0].startMs).toBeNull();
    expect(response.status).toBe(400);
    expect(body.error).toContain('start_ms');
  });

  test('a timestamp the module refuses is reported as a 400 naming the field', async () => {
    openSetReady();
    mockRecord.mockRejectedValueOnce(new Error('Missing end_ms: an event must end after it starts'));

    const response = await POST(post({ ...PUNCH_BODY, end_ms: 12_000 }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Missing end_ms: an event must end after it starts');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('an event outside the clip is the module\'s refusal, not a rewritten one', async () => {
    openSetReady();
    mockRecord.mockRejectedValueOnce(
      new Error('Missing start_ms: the event falls outside the clip it belongs to'),
    );

    const response = await POST(post({ ...PUNCH_BODY, start_ms: 9_000, end_ms: 9_500 }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('outside the clip');
  });

  test('the audit row is written with the SHADOW mirror switched off', async () => {
    openSetReady();
    mockRecord.mockResolvedValueOnce(storedEvent());

    await POST(post(PUNCH_BODY));

    expect(mockAudit).toHaveBeenCalledTimes(1);
    const event = mockAudit.mock.calls[0][0];
    expect(event.shadow_mirror).toBe(false);
    expect(event.event_type).toBe('create');
    expect(event.entity_type).toBe('calibration_annotation_event');
    expect(event.organization_id).toBe('org-1');
  });
});

describe('the submitted set is read-only', () => {
  const SUBMITTED = { ...OPEN_SET, status: 'submitted', submitted_at: '2026-08-01T00:00:00.000Z' };

  test('a new event is refused before the module is called', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(SUBMITTED);

    const response = await POST(post(PUNCH_BODY));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toContain('submitted');
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('an edit is refused, and nothing is written on the way to refusing', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(SUBMITTED);

    const response = await PUT(put({ ...PUNCH_BODY, event_id: 'evt-1' }));

    expect(response.status).toBe(403);
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test('a delete is refused', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(SUBMITTED);

    const response = await DELETE(del({ annotation_set_id: 'set-1', event_id: 'evt-1' }));

    expect(response.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test('a status this build has never heard of is treated as closed, not open', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue({ ...OPEN_SET, status: 'adjudicated' });

    const response = await POST(post(PUNCH_BODY));

    expect(response.status).toBe(403);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('whose set it is', () => {
  test('another annotator\'s set reads as absent, never as forbidden', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue({ ...OPEN_SET, annotator_account_id: 'coach-2' });

    const response = await POST(post(PUNCH_BODY));
    const body = await response.json();

    // 404, and the wording must not confirm that a set exists -- otherwise
    // this route tells annotator A that annotator B has started, which is
    // already a fact about B's work.
    expect(response.status).toBe(404);
    expect(body.error).not.toContain('Forbidden');
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('a set in another organization is simply not there', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    // The module is organization-scoped in its WHERE, so a foreign id returns
    // null. The route must not turn that into anything more informative.
    mockGetSet.mockResolvedValue(null);

    const response = await POST(post(PUNCH_BODY));

    expect(response.status).toBe(404);
    expect(mockGetSet).toHaveBeenCalledWith('org-1', 'set-1');
  });

  test('an organization named in the body is ignored entirely', async () => {
    openSetReady();
    mockRecord.mockResolvedValueOnce(storedEvent());

    await POST(post({ ...PUNCH_BODY, organization_id: 'org-9' }));

    expect(mockGetSet).toHaveBeenCalledWith('org-1', 'set-1');
    expect(mockRecord.mock.calls[0][0].organizationId).toBe('org-1');
  });

  test.each(['athlete', 'parent', 'volunteer', 'staff', 'board', 'platform_owner'])(
    'a %s cannot write an annotation at all',
    async (role) => {
      mockPrincipal.mockResolvedValue({ ...COACH, role });

      const response = await POST(post(PUNCH_BODY));

      expect(response.status).toBe(403);
      expect(mockGetSet).not.toHaveBeenCalled();
      expect(mockRecord).not.toHaveBeenCalled();
    },
  );
});

describe('footage that may not be annotated', () => {
  test('a video that has left ready stops the write, with the module\'s own refusal', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(OPEN_SET);
    mockGetClip.mockResolvedValue(CLIP);
    mockClippable.mockRejectedValue(new VideoNotClippableError('quarantined'));

    const response = await POST(post(PUNCH_BODY));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toContain('not available for calibration');
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a video that is not in this organization reads as not found', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(OPEN_SET);
    mockGetClip.mockResolvedValue(CLIP);
    mockClippable.mockRejectedValue(new VideoNotClippableError(null));

    const response = await POST(post(PUNCH_BODY));

    expect(response.status).toBe(404);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('the clippability gate is the calibration module\'s, called with the clip\'s own video', async () => {
    openSetReady();
    mockRecord.mockResolvedValueOnce(storedEvent());

    await POST(post(PUNCH_BODY));

    expect(mockClippable).toHaveBeenCalledWith('org-1', 'vid-1');
  });

  test('withdrawing an event does NOT require the footage to still be available', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(OPEN_SET);
    mockDelete.mockResolvedValue(true);

    const response = await DELETE(del({ annotation_set_id: 'set-1', event_id: 'evt-1' }));

    // A clip quarantined mid-study must not trap an annotator's own
    // unsubmitted work with no way to withdraw it.
    expect(response.status).toBe(200);
    expect(mockClippable).not.toHaveBeenCalled();
  });
});

describe('editing an event', () => {
  test('the replacement is written before the original is removed', async () => {
    openSetReady();
    mockListEvents.mockResolvedValueOnce([{ event_id: 'evt-1' }]);
    const order: string[] = [];
    mockRecord.mockImplementationOnce(async () => {
      order.push('record');
      return storedEvent();
    });
    mockDelete.mockImplementationOnce(async () => {
      order.push('delete');
      return true;
    });

    const response = await PUT(put({ ...PUNCH_BODY, event_id: 'evt-1' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    // Order is the whole safety property: a rejected correction must leave the
    // original in place, so the new row is written first.
    expect(order).toEqual(['record', 'delete']);
    expect(body.replaced_event_id).toBe('evt-1');
    expect(mockDelete).toHaveBeenCalledWith('org-1', 'set-1', 'evt-1');
  });

  test('a rejected correction leaves the original untouched', async () => {
    openSetReady();
    mockListEvents.mockResolvedValueOnce([{ event_id: 'evt-1' }]);
    mockRecord.mockRejectedValueOnce(new Error('Missing punch_type: not a value in boxing-ontology-0.1'));

    const response = await PUT(put({ ...PUNCH_BODY, event_id: 'evt-1', punch_type: 'haymaker' }));

    expect(response.status).toBe(400);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test('an event id that is not in this set writes nothing at all', async () => {
    openSetReady();
    mockListEvents.mockResolvedValueOnce([{ event_id: 'evt-1' }]);

    const response = await PUT(put({ ...PUNCH_BODY, event_id: 'evt-elsewhere' }));

    expect(response.status).toBe(404);
    // No duplicate left behind for a row the annotator never had.
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  test('the replacement is a new row, not the old id written over', async () => {
    openSetReady();
    mockListEvents.mockResolvedValueOnce([{ event_id: 'evt-1' }]);
    mockRecord.mockResolvedValueOnce(storedEvent());
    mockDelete.mockResolvedValueOnce(true);

    await PUT(put({ ...PUNCH_BODY, event_id: 'evt-1' }));

    expect(mockRecord.mock.calls[0][0].eventId).not.toBe('evt-1');
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      event_type: 'update',
      entity_type: 'calibration_annotation_event',
      shadow_mirror: false,
    });
    expect(mockAudit.mock.calls[0][0].details).toMatchObject({
      action: 'replace',
      replaced_event_id: 'evt-1',
    });
  });
});

describe('deleting an event', () => {
  test('removes it and records the withdrawal without mirroring to SHADOW', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(OPEN_SET);
    mockDelete.mockResolvedValueOnce(true);

    const response = await DELETE(del({ annotation_set_id: 'set-1', event_id: 'evt-1' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.event_id).toBe('evt-1');
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      event_type: 'update',
      entity_type: 'calibration_annotation_event',
      entity_id: 'evt-1',
      shadow_mirror: false,
    });
  });

  test('an event that was not there is a 404 and no audit row', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockGetSet.mockResolvedValue(OPEN_SET);
    mockDelete.mockResolvedValueOnce(false);

    const response = await DELETE(del({ annotation_set_id: 'set-1', event_id: 'evt-nope' }));

    expect(response.status).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a missing field is a 400 naming it', async () => {
    mockPrincipal.mockResolvedValue(COACH);

    const response = await DELETE(del({ annotation_set_id: 'set-1' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('event_id');
  });
});

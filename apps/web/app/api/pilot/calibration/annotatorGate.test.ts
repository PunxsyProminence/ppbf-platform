import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import {
  getAnnotationSet,
  listAnnotationSetsForClip,
  type AnnotationSetRow,
} from '@/src/server/pilot/calibration/annotations';
import {
  VideoNotClippableError,
  assertVideoClippable,
  getCalibrationClip,
} from '@/src/server/pilot/calibration/projects';

import {
  ANNOTATOR_ROLES,
  assertSetInProgress,
  blankToNull,
  findOwnAnnotationSetForClip,
  loadOwnAnnotationSet,
  loadPlayableClip,
  optionalMs,
  requireAnnotator,
  writeCalibrationAuditEvent,
} from './annotatorGate';

/**
 * The gate the five calibration routes share.
 *
 * Tested directly as well as through the routes, because each of these is a
 * one-line change away from being wrong in a way that no route test would
 * necessarily notice: the mirror flag flipping to true would still write an
 * audit row, the ownership check inverting would still return a set, and the
 * in-progress check loosening would still refuse SOME sets.
 */

jest.mock('@/src/server/pilot/calibration/annotations', () => ({
  getAnnotationSet: jest.fn(),
  listAnnotationSetsForClip: jest.fn(),
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

const mockGetSet = getAnnotationSet as jest.Mock;
const mockListSets = listAnnotationSetsForClip as jest.Mock;
const mockGetClip = getCalibrationClip as jest.Mock;
const mockClippable = assertVideoClippable as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

const COACH = {
  accountId: 'coach-1',
  role: 'coach',
  organizationId: 'org-1',
  athleteId: null,
  sessionToken: 't',
  authProvider: 'microsoft',
} as unknown as PilotPrincipal;

const SET = {
  organization_id: 'org-1',
  annotation_set_id: 'set-1',
  calibration_clip_id: 'clip-1',
  annotator_account_id: 'coach-1',
  ontology_version: 'boxing-ontology-0.1',
  status: 'in_progress',
  created_at: '2026-08-27T00:00:00.000Z',
  submitted_at: null,
} as unknown as AnnotationSetRow;

beforeEach(() => {
  jest.clearAllMocks();
  mockAudit.mockResolvedValue(undefined);
});

describe('who may annotate', () => {
  test('the two annotator roles are coach and organization_admin, and nothing else', () => {
    expect([...ANNOTATOR_ROLES]).toEqual(['coach', 'organization_admin']);
  });

  test.each(['coach', 'organization_admin', 'admin'])('%s passes', (role) => {
    expect(() => requireAnnotator({ ...COACH, role } as PilotPrincipal)).not.toThrow();
  });

  test.each(['athlete', 'parent', 'board', 'platform_owner', 'volunteer', 'staff'])(
    '%s is refused with a message that maps to a 403',
    (role) => {
      expect(() => requireAnnotator({ ...COACH, role } as PilotPrincipal))
        .toThrow(/^Forbidden/);
    },
  );
});

describe('the SHADOW mirror stays off', () => {
  test('every calibration audit write passes shadow_mirror false', async () => {
    await writeCalibrationAuditEvent({
      eventType: 'create',
      principal: COACH,
      entityType: 'calibration_annotation_set',
      entityId: 'set-1',
      details: { calibration_clip_id: 'clip-1' },
    });

    expect(mockAudit).toHaveBeenCalledTimes(1);
    const written = mockAudit.mock.calls[0][0];
    // Exactly false, not falsy: writePilotAuditEvent tests `=== false`, so
    // undefined would fan out to emitShadowEvent and shadow telemetry.
    expect(written.shadow_mirror).toBe(false);
    expect(written).toMatchObject({
      event_type: 'create',
      actor_account_id: 'coach-1',
      actor_role: 'coach',
      organization_id: 'org-1',
      entity_type: 'calibration_annotation_set',
      entity_id: 'set-1',
    });
  });

  test('a caller cannot turn the mirror back on through the details payload', async () => {
    await writeCalibrationAuditEvent({
      eventType: 'update',
      principal: COACH,
      entityType: 'calibration_annotation_event',
      entityId: 'evt-1',
      details: { shadow_mirror: true, action: 'delete' },
    });

    expect(mockAudit.mock.calls[0][0].shadow_mirror).toBe(false);
  });

  test('the event type stays inside the closed audit vocabulary', async () => {
    await writeCalibrationAuditEvent({
      eventType: 'update',
      principal: COACH,
      entityType: 'calibration_annotation_set',
      entityId: 'set-1',
      details: {},
    });

    // 'create' and 'update' are the only two this subsystem uses; a
    // calibration-specific value would need a migration widening a database
    // CHECK, and every write would fail on SQLSTATE 23514 until it landed.
    expect(['create', 'update']).toContain(mockAudit.mock.calls[0][0].event_type);
  });
});

describe('the clip gate', () => {
  test('calls the calibration module\'s own check with the clip\'s video', async () => {
    mockGetClip.mockResolvedValue({ calibration_clip_id: 'clip-1', video_session_id: 'vid-1' });
    mockClippable.mockResolvedValue({ videoSessionId: 'vid-1', athleteId: 'ath-1' });

    const clip = await loadPlayableClip('org-1', 'clip-1');

    expect(clip.calibration_clip_id).toBe('clip-1');
    expect(mockClippable).toHaveBeenCalledWith('org-1', 'vid-1');
  });

  test('a clip that is not in this organization is not found, and no video is looked up', async () => {
    mockGetClip.mockResolvedValue(null);

    await expect(loadPlayableClip('org-1', 'clip-9')).rejects.toThrow(/^Not found/);
    expect(mockClippable).not.toHaveBeenCalled();
  });

  test('the module\'s refusal is passed through rather than reworded', async () => {
    mockGetClip.mockResolvedValue({ calibration_clip_id: 'clip-1', video_session_id: 'vid-1' });
    mockClippable.mockRejectedValue(new VideoNotClippableError('quarantined'));

    await expect(loadPlayableClip('org-1', 'clip-1')).rejects.toBeInstanceOf(VideoNotClippableError);
  });
});

describe('whose set it is', () => {
  test('the caller\'s own set comes back', async () => {
    mockGetSet.mockResolvedValue(SET);

    await expect(loadOwnAnnotationSet(COACH, 'set-1')).resolves.toBe(SET);
  });

  test('another annotator\'s set is reported exactly as a missing one is', async () => {
    mockGetSet.mockResolvedValue({ ...SET, annotator_account_id: 'coach-2' });
    const foreign = await loadOwnAnnotationSet(COACH, 'set-1').catch((error: Error) => error.message);

    mockGetSet.mockResolvedValue(null);
    const missing = await loadOwnAnnotationSet(COACH, 'set-1').catch((error: Error) => error.message);

    expect(foreign).toBe(missing);
    expect(String(foreign)).toMatch(/^Not found/);
  });

  test('finding a set for a clip never returns another annotator\'s', async () => {
    mockListSets.mockResolvedValue([
      { ...SET, annotation_set_id: 'set-theirs', annotator_account_id: 'coach-2' },
      SET,
    ]);

    const found = await findOwnAnnotationSetForClip(COACH, 'clip-1');

    expect(found?.annotation_set_id).toBe('set-1');
  });

  test('a clip only the other annotator has started reads as no set at all', async () => {
    mockListSets.mockResolvedValue([
      { ...SET, annotation_set_id: 'set-theirs', annotator_account_id: 'coach-2' },
    ]);

    await expect(findOwnAnnotationSetForClip(COACH, 'clip-1')).resolves.toBeNull();
  });
});

describe('the submitted set is read-only', () => {
  test('an in-progress set is writable', () => {
    expect(() => assertSetInProgress(SET)).not.toThrow();
  });

  test('a submitted set is refused with a message that maps to a 403', () => {
    expect(() => assertSetInProgress({ ...SET, status: 'submitted' } as AnnotationSetRow))
      .toThrow(/^Forbidden/);
  });

  test.each(['submitted', 'adjudicated', 'archived', '', 'IN_PROGRESS'])(
    'status %p is not in_progress and is therefore closed',
    (status) => {
      // Fails CLOSED for anything unrecognised, including a casing variant --
      // the alternative (refuse only known-closed statuses) would treat a
      // value this build has never heard of as an open set.
      expect(() => assertSetInProgress({ ...SET, status } as AnnotationSetRow)).toThrow();
    },
  );
});

describe('blank form controls', () => {
  test('an unselected optional control means "not recorded", never "unknown"', () => {
    expect(blankToNull('')).toBeNull();
    expect(blankToNull(undefined)).toBeNull();
    expect(blankToNull(null)).toBeNull();
    // 'unknown' is a recorded observation and must survive untouched.
    expect(blankToNull('unknown')).toBe('unknown');
    expect(blankToNull('lead_hook')).toBe('lead_hook');
  });

  test('an empty millisecond field never becomes zero', () => {
    expect(optionalMs('')).toBeNull();
    expect(optionalMs(null)).toBeNull();
    expect(optionalMs(undefined)).toBeNull();
    expect(optionalMs('12600')).toBe(12_600);
    expect(optionalMs(12_600)).toBe(12_600);
  });

  test('a malformed millisecond field is handed on for the module to refuse, not coerced', () => {
    // Number(' 12 ') is 12 and Number(true) is 1. Neither may become a
    // confident timestamp here; both go to requireOffsetMs, which names the
    // field in a 400.
    expect(optionalMs(' 12 ')).toBe(' 12 ');
    expect(optionalMs(true)).toBe(true);
    expect(optionalMs('12.5')).toBe('12.5');
    expect(optionalMs('-4')).toBe('-4');
  });
});

import type { NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { listAdjudicationsForClip } from '@/src/server/pilot/calibration/adjudication';
import {
  listAnnotationEvents,
  listAnnotationSetsForClip,
} from '@/src/server/pilot/calibration/annotations';
import {
  getCalibrationProject,
  listCalibrationClips,
} from '@/src/server/pilot/calibration/projects';
import { requirePrincipal } from '@/src/server/pilot/http';

import { GET } from './route';

/**
 * THE AGREEMENT REPORT, AT THE WIRE.
 *
 * Only the data layer and the session are mocked. The loader, comparison.ts,
 * qaReadModel.ts and access.ts's role check run for real, so "a parent is
 * refused" exercises requireAnnotator and "nothing identifying is in the body"
 * is asserted on what the real loader produced from rows that carry ids.
 */

jest.mock('@/src/server/pilot/calibration/annotations', () => ({
  getAnnotationSet: jest.fn(),
  listAnnotationSetsForClip: jest.fn(),
  listAnnotationEvents: jest.fn(),
}));
jest.mock('@/src/server/pilot/calibration/adjudication', () => ({
  listAdjudicationsForClip: jest.fn(),
}));
jest.mock('@/src/server/pilot/calibration/projects', () => {
  const actual = jest.requireActual('@/src/server/pilot/calibration/projects');
  return {
    ...actual,
    getCalibrationProject: jest.fn(),
    listCalibrationClips: jest.fn(),
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
const mockProject = getCalibrationProject as jest.Mock;
const mockClips = listCalibrationClips as jest.Mock;
const mockSets = listAnnotationSetsForClip as jest.Mock;
const mockEvents = listAnnotationEvents as jest.Mock;
const mockAdjudications = listAdjudicationsForClip as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

const ORG = 'org-1';
const PROJECT = 'proj-1';
const ONTOLOGY = 'boxing-ontology-0.1';

const ADMIN = { accountId: 'acct-admin', role: 'organization_admin', organizationId: ORG };
const LEGACY_ADMIN = { accountId: 'acct-admin-old', role: 'admin', organizationId: ORG };
const COACH = { accountId: 'acct-coach-a', role: 'coach', organizationId: ORG };

function set(clip: string, who: 'a' | 'b', status = 'submitted') {
  return {
    organization_id: ORG,
    annotation_set_id: `${clip}-set-${who}`,
    calibration_clip_id: clip,
    annotator_account_id: `acct-coach-${who}`,
    ontology_version: ONTOLOGY,
    status,
    created_at: '2026-08-27T00:00:00.000Z',
    submitted_at: status === 'submitted' ? '2026-08-27T01:00:00.000Z' : null,
  };
}

function event(setId: string, punchType: string) {
  const clip = setId.split('-set-')[0];
  return {
    organization_id: ORG,
    event_id: `${setId}-evt`,
    annotation_set_id: setId,
    calibration_clip_id: clip,
    clip_start_ms: 0,
    clip_end_ms: 20_000,
    event_class: 'punch',
    actor_track: 'red',
    opponent_track: 'blue',
    start_ms: 1_000,
    end_ms: 1_400,
    contact_ms: null,
    peak_ms: null,
    physical_hand: 'left',
    hand_role: 'lead',
    stance: 'orthodox',
    punch_type: punchType,
    target_zone: 'head',
    contact_result: 'clean_target_contact',
    contact_zone: 'head',
    defense_type: null,
    visibility: 'clear',
    certainty: 'clear',
    combination_group: null,
    sequence_order: null,
    counter_against_event_id: null,
    defends_against_event_id: null,
    created_at: '2026-08-27T00:30:00.000Z',
  };
}

/** `compared` clips with two submitted readings that differ on punch type,
 * plus one clip still waiting on its second labeller. */
function stageStudy(compared: number) {
  const clips = Array.from({ length: compared }, (_, index) => `clip-${index + 1}`);
  mockProject.mockResolvedValue({
    organization_id: ORG,
    calibration_project_id: PROJECT,
    name: 'Jab study',
    ontology_version: ONTOLOGY,
  });
  mockClips.mockResolvedValue(
    [...clips, 'clip-waiting'].map((clip) => ({
      calibration_clip_id: clip,
      athlete_id: 'ath-under-study',
      video_session_id: 'vid-under-study',
      primary_sampling_reason: 'routine',
    })),
  );
  mockSets.mockImplementation(async (_org: string, clip: string) =>
    clip === 'clip-waiting' ? [set(clip, 'a')] : [set(clip, 'a'), set(clip, 'b')]);
  mockEvents.mockImplementation(async (_org: string, setId: string) => [
    event(setId, setId.endsWith('-a') ? 'lead_straight' : 'lead_hook'),
  ]);
  mockAdjudications.mockResolvedValue([]);
}

function request(query = `calibration_project_id=${PROJECT}`): NextRequest {
  return new Request(`http://localhost/api/pilot/calibration/qa-report?${query}`) as NextRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/calibration/qa-report', () => {
  test.each([
    ['parent'], ['athlete'], ['board'], ['volunteer'], ['staff'], ['platform_owner'],
  ])('refuses a %s before anything is read', async (role) => {
    mockPrincipal.mockResolvedValue({ accountId: 'acct-x', role, organizationId: ORG });
    stageStudy(5);

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mockProject).not.toHaveBeenCalled();
    expect(mockSets).not.toHaveBeenCalled();
  });

  test('refuses a request with no session', async () => {
    mockPrincipal.mockRejectedValue(new Error('Unauthorized'));

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mockProject).not.toHaveBeenCalled();
  });

  test('asks for the study in the caller\'s own organization, whatever the query says', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    stageStudy(1);

    await GET(request(`calibration_project_id=${PROJECT}&organization_id=org-other`));

    expect(mockProject.mock.calls).toEqual([[ORG, PROJECT]]);
  });

  test('answers 404 for a study this organization does not have', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    mockProject.mockResolvedValue(null);

    const response = await GET(request('calibration_project_id=proj-elsewhere'));

    expect(response.status).toBe(404);
    expect(mockClips).not.toHaveBeenCalled();
  });

  test('answers 400 when no study is named', async () => {
    mockPrincipal.mockResolvedValue(COACH);

    const response = await GET(request(''));

    expect(response.status).toBe(400);
    expect(mockProject).not.toHaveBeenCalled();
  });

  test.each([[ADMIN], [LEGACY_ADMIN]])('gives an administrator (%o) the figures and the progress', async (admin) => {
    mockPrincipal.mockResolvedValue(admin);
    stageStudy(5);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('available');
    expect(body.comparison_count).toBe(5);
    expect(body.minimum_comparisons).toBe(5);
    expect(body.project_name).toBe('Jab study');
    expect(body.report.disagreementCounts.PUNCH_TYPE).toBe(5);
    expect(body.report.disagreementRates.PUNCH_TYPE.rate).toBe(1);
    expect(body.clip_progress).toMatchObject({ totalClips: 6, clipsAwaitingSecondAnnotator: 1 });
    expect(body.excluded_clips).toEqual({
      readingInProgress: 0, noRecordedPair: 0, pairNotEstablished: 0, notComparable: 0,
    });
  });

  test('gives a coach the figures and withholds the clip progress', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    stageStudy(5);

    const body = await (await GET(request())).json();

    expect(body.report.disagreementRates.PUNCH_TYPE.rate).toBe(1);
    expect(body.clip_progress).toBeNull();
    expect(body.excluded_clips).toBeNull();
    // Not smuggled out inside the figures either.
    expect(JSON.stringify(body)).not.toContain('clipsAwaiting');
  });

  test('below the minimum, a coach sees counts and no rate', async () => {
    mockPrincipal.mockResolvedValue(COACH);
    stageStudy(4);

    const body = await (await GET(request())).json();

    expect(body.status).toBe('insufficient_data');
    expect(body.comparison_count).toBe(4);
    expect(body.report.disagreementCounts.PUNCH_TYPE).toBe(4);
    for (const rate of Object.values(body.report.disagreementRates) as Array<{ rate: unknown }>) {
      expect(rate.rate).toBeNull();
    }
  });

  test('puts no labeller, reading, clip or athlete in the body, and keeps it out of caches', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    stageStudy(5);

    const response = await GET(request());
    const serialized = JSON.stringify(await response.json());

    for (const forbidden of ['acct-', '-set-', '-evt', 'clip-', 'ath-', 'vid-', 'account', 'athlete']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
  });

  test('writes no audit row for a read', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    stageStudy(2);

    await GET(request());

    expect(mockAudit).not.toHaveBeenCalled();
  });
});

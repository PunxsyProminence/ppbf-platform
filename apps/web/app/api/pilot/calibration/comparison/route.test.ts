import type { NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import {
  listAnnotationEvents,
  listAnnotationSetsForClip,
} from '@/src/server/pilot/calibration/annotations';
import {
  VideoNotClippableError,
  assertVideoClippable,
  getCalibrationClip,
} from '@/src/server/pilot/calibration/projects';
import { requirePrincipal, requireRole as httpRequireRole } from '@/src/server/pilot/http';

import { GET } from './route';

/**
 * THE COMPARISON READ, AT THE WIRE.
 *
 * WHAT IS MOCKED AND WHAT IS NOT, because it decides what these cases can
 * prove. Only the DATA LAYER is mocked -- annotations.ts (the rows), projects.ts
 * (the clip and the video's clippable status) and requirePrincipal (who is
 * asking). blinding.ts and comparison.ts run FOR REAL underneath, so a case
 * that says "the admin is refused while a set is in progress" is exercising
 * resolveAdjudicationEligibility itself rather than a jest.fn() somebody
 * configured to reject.
 *
 * A suite that mocked listAnnotationSetsForAdjudication would assert only that
 * the route forwards whatever that mock decided, which is the shape of test
 * that stays green when the route is rewired onto the unblinded loader.
 */

jest.mock('@/src/server/pilot/calibration/annotations', () => ({
  getAnnotationSet: jest.fn(),
  listAnnotationSetsForClip: jest.fn(),
  listAnnotationEvents: jest.fn(),
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
const mockAudit = writePilotAuditEvent as jest.Mock;
const mockListSets = listAnnotationSetsForClip as jest.Mock;
const mockListEvents = listAnnotationEvents as jest.Mock;
const mockGetClip = getCalibrationClip as jest.Mock;
const mockClippable = assertVideoClippable as jest.Mock;

const ORG = 'org-1';

const ADMIN = { accountId: 'admin-1', role: 'organization_admin', organizationId: ORG };
const LEGACY_ADMIN = { accountId: 'admin-2', role: 'admin', organizationId: ORG };
/** One of the two people whose work is being compared. */
const ANNOTATOR_COACH = { accountId: 'coach-a', role: 'coach', organizationId: ORG };

const CLIP = {
  organization_id: ORG,
  calibration_clip_id: 'clip-1',
  calibration_project_id: 'proj-1',
  video_session_id: 'vid-1',
  athlete_id: 'ath-1',
  clip_code: 'C-01',
  start_ms: 12_000,
  end_ms: 18_000,
  primary_sampling_reason: 'occlusion',
};

function setOf(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: ORG,
    annotation_set_id: 'set-a',
    calibration_clip_id: 'clip-1',
    annotator_account_id: 'coach-a',
    ontology_version: 'boxing-ontology-0.1',
    status: 'submitted',
    created_at: '2026-08-01T00:00:00.000Z',
    submitted_at: '2026-08-02T00:00:00.000Z',
    ...overrides,
  };
}

const SET_A = setOf();
const SET_B = setOf({ annotation_set_id: 'set-b', annotator_account_id: 'coach-b' });

function eventOf(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: ORG,
    event_id: 'evt-a1',
    annotation_set_id: 'set-a',
    calibration_clip_id: 'clip-1',
    clip_start_ms: 12_000,
    clip_end_ms: 18_000,
    event_class: 'punch',
    actor_track: 'red',
    opponent_track: 'blue',
    start_ms: 1_000,
    end_ms: 1_400,
    contact_ms: 1_200,
    peak_ms: null,
    physical_hand: 'left',
    hand_role: 'lead',
    stance: 'orthodox',
    punch_type: 'lead_straight',
    target_zone: 'head',
    contact_result: 'landed_clean',
    contact_zone: 'head',
    defense_type: null,
    visibility: 'clear',
    certainty: 'clear',
    combination_group: null,
    sequence_order: null,
    counter_against_event_id: null,
    defends_against_event_id: null,
    created_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Coach A saw two punches. */
const EVENTS_A = [
  eventOf(),
  eventOf({ event_id: 'evt-a2', start_ms: 3_000, end_ms: 3_200, contact_ms: 3_100 }),
];

/** Coach B saw the first one, called it a different punch, and missed the second. */
const EVENTS_B = [
  eventOf({
    event_id: 'evt-b1',
    annotation_set_id: 'set-b',
    start_ms: 1_050,
    end_ms: 1_450,
    contact_ms: 1_250,
    punch_type: 'rear_hook',
  }),
];

function get(query = 'calibration_clip_id=clip-1'): NextRequest {
  return new Request(
    `http://localhost/api/pilot/calibration/comparison?${query}`,
  ) as NextRequest;
}

/** A clip whose footage is fine and whose two sets are both finished. */
function bothSubmitted(sets = [SET_A, SET_B]) {
  mockGetClip.mockResolvedValue(CLIP);
  mockClippable.mockResolvedValue({ videoSessionId: 'vid-1', athleteId: 'ath-1' });
  mockListSets.mockResolvedValue(sets);
  mockListEvents.mockImplementation(async (_org: string, setId: string) =>
    (setId === 'set-a' ? EVENTS_A : EVENTS_B));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('who may read the diff', () => {
  test('a coach is refused, including one of the two people being compared', async () => {
    // The point of the case: this coach's own work is half of what the screen
    // shows, and they are still refused. Blinding is not "you may not see
    // strangers' work", it is "you may not see the study through this door".
    mockPrincipal.mockResolvedValue(ANNOTATOR_COACH);

    const response = await GET(get());
    const body = await response.json();

    expect(response.status).toBe(403);
    // The refusal is about ROLE and says nothing about how far the clip has
    // got. resolveAdjudicationEligibility checks role before state for exactly
    // this reason, and the route's own gate must not undo it by refusing on
    // progress first.
    expect(body.error).toMatch(/role/i);
    expect(body.error).not.toMatch(/submit|progress|ready|annotat/i);

    // And nothing was read at all -- not the clip, not the sets. A refusal
    // that loads first leaks through timing and through the audit of whatever
    // it touched.
    expect(mockGetClip).not.toHaveBeenCalled();
    expect(mockListSets).not.toHaveBeenCalled();
    expect(mockListEvents).not.toHaveBeenCalled();
  });

  test.each(['athlete', 'parent', 'board', 'volunteer', 'staff'])(
    'a %s is refused the same way',
    async (role) => {
      mockPrincipal.mockResolvedValue({ ...ANNOTATOR_COACH, role });

      const response = await GET(get());

      expect(response.status).toBe(403);
      expect(mockListSets).not.toHaveBeenCalled();
    },
  );

  test('the platform owner is refused', async () => {
    // Not an oversight, and not a gap to be closed by a later "while we are
    // here". This surface exists so an ORGANIZATION can settle a disagreement
    // between its own two annotators; blinding.ts refuses a platform-wide role
    // by name and this route agrees with it.
    mockPrincipal.mockResolvedValue({ ...ADMIN, role: 'platform_owner' });

    const response = await GET(get());

    expect(response.status).toBe(403);
    expect(mockGetClip).not.toHaveBeenCalled();
    expect(mockListSets).not.toHaveBeenCalled();
  });

  test('a legacy admin row is admitted, which is why the gate comes from access.ts', async () => {
    mockPrincipal.mockResolvedValue(LEGACY_ADMIN);
    bothSubmitted();

    const response = await GET(get());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.comparison.annotationSetIdA).toBe('set-a');
  });

  test("http.ts's requireRole would have refused that same row", () => {
    // The reason the import is from access.ts, made executable rather than
    // left as a claim in a comment. http.ts's variant does a bare `includes`
    // on the role string; access.ts's knows the two spellings are one role.
    // A route on the http.ts one would 403 every un-migrated admin while
    // resolveAdjudicationEligibility, which resolves the alias through
    // isOrganizationAdminRole, would have admitted them.
    const legacyPrincipal: PilotPrincipal = {
      accountId: 'admin-2',
      role: 'admin',
      organizationId: ORG,
      athleteId: null,
      sessionToken: 'session-token',
      authProvider: 'microsoft',
    };

    expect(() => httpRequireRole(legacyPrincipal, ['organization_admin'])).toThrow(/Forbidden/);
    // And the module this route depends on admits them, so the two would have
    // disagreed about the same person on the same request.
    expect(isOrganizationAdminRole('admin')).toBe(true);
  });
});

describe('nothing crosses the wire before both readings are finished', () => {
  test('an admin gets the not-ready refusal and NO events, while either set is in progress', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    mockGetClip.mockResolvedValue(CLIP);
    mockClippable.mockResolvedValue({ videoSessionId: 'vid-1', athleteId: 'ath-1' });
    mockListSets.mockResolvedValue([SET_A, setOf({
      annotation_set_id: 'set-b',
      annotator_account_id: 'coach-b',
      status: 'in_progress',
      submitted_at: null,
    })]);
    mockListEvents.mockResolvedValue(EVENTS_A);

    const response = await GET(get());
    const body = await response.json();
    const raw = JSON.stringify(body);

    expect(response.status).toBe(403);
    expect(body.error).toMatch(/not ready for adjudication/);

    /* ASSERTED ON THE BODY, NOT ONLY THE STATUS.
     *
     * A handler that attached the sets or the events alongside a 403 would
     * pass a status-only case while serving the finished annotator's complete
     * work to a screen that had merely been told "no". So: no set id, no
     * annotator, no event id, and no comparison anywhere in the payload. */
    expect(raw).not.toContain('set-a');
    expect(raw).not.toContain('set-b');
    expect(raw).not.toContain('coach-a');
    expect(raw).not.toContain('coach-b');
    expect(raw).not.toContain('evt-a1');
    expect(body.comparison).toBeUndefined();
    expect(body.disagreement_counts).toBeUndefined();

    /* AND THE EVENTS WERE NEVER READ AT ALL.
     *
     * This is the assertion that pins the LOADER choice rather than the
     * response shape. Rewiring the route onto annotations.ts's unblinded
     * listAnnotationSetsForClip / listAnnotationEvents still produces a 403 --
     * compareAnnotationSets refuses NOT_BOTH_SUBMITTED on its own -- so a body
     * assertion alone cannot tell the two implementations apart. Reading the
     * submitted annotator's events at all is the observable difference, and it
     * is the thing that must not happen. */
    expect(mockListEvents).not.toHaveBeenCalled();
  });

  test('a clip nobody has annotated is not found, rather than an empty comparison', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    mockGetClip.mockResolvedValue(CLIP);
    mockClippable.mockResolvedValue({ videoSessionId: 'vid-1', athleteId: 'ath-1' });
    mockListSets.mockResolvedValue([]);

    const response = await GET(get());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toMatch(/no annotation sets/);
    expect(mockListEvents).not.toHaveBeenCalled();
  });
});

describe('a clip with anything other than two submitted sets', () => {
  test('ONE submitted set refuses cleanly rather than comparing a set with undefined', async () => {
    /* THE DEFECT THIS CASE EXISTS FOR.
     *
     * blinding.ts::resolveAdjudicationEligibility answers 'eligible' here:
     * `sets.every(isSubmitted)` is vacuously true of a one-element array, so
     * the only length it rejects is zero -- while its docblock promises the
     * caller "two raw readings". Its eight unit cases and six pg cases all
     * stage two sets or none, so this path is untested at both layers.
     *
     * Left where it is on purpose: that function is a mutation-tested
     * authorization primitive and widening its reason set is a separate
     * decision. Without the route's own length refusal, compareAnnotationSets
     * would be handed `sets[1] === undefined` and the administrator would get
     * an opaque 500 out of a property read on undefined. */
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted([SET_A]);

    const response = await GET(get());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(response.status).not.toBe(500);
    // The refusal names the COUNT and the CONSTRAINT. A bare "not eligible"
    // leaves an administrator unable to tell a bug from a permission wall from
    // a real structural limit, and those want three different next actions.
    expect(body.error).toMatch(/1 submitted annotation set\b/);
    expect(body.error).toMatch(/pairwise/);
    expect(body.error).toMatch(/exactly two/);
    // Nothing was compared, and nothing undefined was passed onward.
    expect(mockListEvents).not.toHaveBeenCalled();
    expect(body.comparison).toBeUndefined();
  });

  test('THREE submitted sets are asked about, not refused', async () => {
    // OD-2026-08-29-003 replaced the refusal that used to be here. The surface
    // is handed what it may choose from and asks; it is NOT handed the
    // readings, because until a pair exists there is no comparison to make and
    // shipping all three would disclose more than the question needs.
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted([
      SET_A,
      SET_B,
      setOf({ annotation_set_id: 'set-c', annotator_account_id: 'coach-c' }),
    ]);

    const response = await GET(get());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.pair_selection_required).toBe(true);
    expect(body.candidate_sets.map((s: { annotation_set_id: string }) => s.annotation_set_id))
      .toEqual(['set-a', 'set-b', 'set-c']);
    expect(body.comparison).toBeUndefined();
    expect(mockListEvents).not.toHaveBeenCalled();
  });

  test('and once a pair is named, that pair is what gets compared', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted([
      SET_A,
      SET_B,
      setOf({ annotation_set_id: 'set-c', annotator_account_id: 'coach-c' }),
    ]);

    const response = await GET(get('calibration_clip_id=clip-1&set_a=set-a&set_b=set-c'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.pair_selection_required).toBeUndefined();
    expect(mockListEvents).toHaveBeenCalled();
  });

  test('a named set that is not on the clip is refused, not fetched', async () => {
    // The selection says WHICH, never WHAT. Without this a caller could name a
    // reading from another clip or organization and have it loaded for them.
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted([
      SET_A,
      SET_B,
      setOf({ annotation_set_id: 'set-c', annotator_account_id: 'coach-c' }),
    ]);

    const response = await GET(get('calibration_clip_id=clip-1&set_a=set-a&set_b=set-from-another-clip'));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toMatch(/not among this clip's submitted readings/);
    expect(mockListEvents).not.toHaveBeenCalled();
  });
});

describe('the clip itself', () => {
  test("a clip in another organization is the same 404 as one that does not exist", async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    // getCalibrationClip is organization-scoped, so a foreign clip and a
    // fictional one both come back null and must be indistinguishable from
    // here on. Byte-identical, not merely both 404.
    mockGetClip.mockResolvedValue(null);

    const foreign = await GET(get('calibration_clip_id=clip-in-another-gym'));
    const foreignBody = await foreign.json();

    mockGetClip.mockResolvedValue(null);
    const fictional = await GET(get('calibration_clip_id=clip-that-never-existed'));
    const fictionalBody = await fictional.json();

    expect(foreign.status).toBe(404);
    expect(fictional.status).toBe(404);
    expect(JSON.stringify(foreignBody)).toBe(JSON.stringify(fictionalBody));
    expect(mockListSets).not.toHaveBeenCalled();
  });

  test('footage that is no longer clippable is refused on this read too', async () => {
    // Re-checked on every read, never cached from clip selection: the property
    // annotatorGate.ts documents, and a review screen left open is exactly the
    // tab it was written about.
    mockPrincipal.mockResolvedValue(ADMIN);
    mockGetClip.mockResolvedValue(CLIP);
    mockClippable.mockRejectedValue(new VideoNotClippableError('quarantined'));

    const response = await GET(get());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toContain('not available for calibration');
    expect(mockListSets).not.toHaveBeenCalled();
  });

  test('the clip id is required and named when it is missing', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);

    const response = await GET(get(''));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('calibration_clip_id');
    expect(mockGetClip).not.toHaveBeenCalled();
  });
});

describe('what an eligible read actually answers with', () => {
  test('both readings, paired, with the disagreements named', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted();

    const response = await GET(get());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.comparison.annotationSetIdA).toBe('set-a');
    expect(body.comparison.annotationSetIdB).toBe('set-b');
    expect(body.comparison.annotatorAccountIdA).toBe('coach-a');
    expect(body.comparison.annotatorAccountIdB).toBe('coach-b');

    const outcomes = body.comparison.pairings.map((p: { outcome: string }) => p.outcome);
    expect(outcomes).toEqual(['MATCHED', 'ONLY_IN_A']);

    const matched = body.comparison.pairings[0];
    const categories = matched.disagreements.map((d: { category: string }) => d.category);
    expect(categories).toContain('PUNCH_TYPE');
    expect(categories).toContain('BOUNDARY');

    expect(body.disagreement_counts.EVENT_MISSED).toBe(1);
    expect(body.disagreement_counts.PUNCH_TYPE).toBe(1);
    // Every category present as a key, so a zero is a measured zero.
    expect(body.disagreement_counts.STANCE).toBe(0);
  });

  test('the rule that produced the pairing travels with it, marked uncalibrated', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted();

    const body = await (await GET(get())).json();

    expect(body.comparison.matchingPolicy.calibrationState).toBe('UNCALIBRATED');
    expect(body.comparison.matchingPolicy.overlapToleranceMs).toBe(0);
    expect(body.comparison.ontologyVersion).toBe('boxing-ontology-0.1');
  });

  test('the response carries NO scalar agreement figure of any kind', async () => {
    /* comparison.test.ts already keeps this guard over the module's return
     * value. It is re-asserted here at the WIRE, because the module refusing
     * to compute a number does not stop a serializer one layer out from
     * helpfully adding one -- and a rate on this screen would immediately be
     * read as a verdict on two coaches. */
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted();

    const body = await (await GET(get())).json();

    /* Word starts, not substrings, and camelCase split first. A plain
     * `not.toContain` is wrong in both directions here: 'disAGREEMENT' and
     * 'unCALIBRATEd' / 'calibRATIOn' contain three of the forbidden words and
     * are all legitimate, while a key spelled `agreementRate` would slip past
     * a lowercased substring search for `_rate`. */
    const normalized = JSON.stringify(body)
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toLowerCase();

    for (const forbidden of [
      'score', 'confidence', 'accuracy', 'kappa', 'rate', 'percent', 'ratio',
      'denominator', 'agreement',
    ]) {
      expect(normalized).not.toMatch(new RegExp(`(^|[^a-z])${forbidden}`));
    }

    /* AND STRUCTURALLY, not only by name. Every number in this payload is a
     * millisecond offset, a sequence position or a count -- all integers. A
     * rate, a proportion or a kappa is fractional whatever it gets called, so
     * this catches one added under a name nobody thought to forbid. */
    const fractional: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'number' && !Number.isInteger(value)) {
        fractional.push(`${path}=${value}`);
      } else if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, `${path}[${index}]`));
      } else if (value !== null && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`);
      }
    };
    walk(body, 'body');
    expect(fractional).toEqual([]);
  });

  test('the response is not storable by a shared cache', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted();

    const response = await GET(get());

    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
  });

  test('a successful read writes no audit row', async () => {
    /* An owner decision reported rather than made. AUDIT_EVENT_TYPES is a
     * closed vocabulary with no read or view member and
     * writeCalibrationAuditEvent accepts only 'create' | 'update', so recording
     * this read would mean either a false statement in the stream or a
     * migration -- and this slice carries none. projects/route.ts writes no
     * audit row on a list read for the same reason. If read disclosure on two
     * coaches' raw work should be audited, that is a vocabulary change with its
     * own migration and its own decision. */
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted();

    const response = await GET(get());

    expect(response.status).toBe(200);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { NextRequest } from 'next/server';

import { BUILDING } from '@/components/buildingMap';
import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import {
  listAdjudicatedFields,
  listAdjudicationsForClip,
  recordAdjudication,
} from '@/src/server/pilot/calibration/adjudication';
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

import { ADJUDICATION_ROLES, GET, POST } from './route';

/**
 * SETTLING A DISAGREEMENT, AT THE WIRE.
 *
 * WHAT IS MOCKED AND WHAT IS NOT, because it decides what these cases can
 * prove.
 *
 * Mocked: the DATA LAYER only -- annotations.ts (the rows), projects.ts (the
 * clip and the video's clippable status), adjudication.ts's three
 * database-touching functions, and requirePrincipal (who is asking).
 *
 * NOT mocked, and running for real underneath every case below: blinding.ts.
 * So "the administrator is refused while a coach is still working" exercises
 * `resolveAdjudicationEligibility` and `listAnnotationSetsForAdjudication`
 * themselves, not a jest.fn() somebody configured to reject. A suite that
 * mocked `listAnnotationSetsForAdjudication` would assert only that the route
 * forwards whatever that mock decided -- the shape of test that stays green
 * when the route is rewired onto the unblinded loader, which is precisely the
 * defect this route exists to prevent.
 *
 * `recordAdjudication` IS mocked, and that is the point of several cases: with
 * it mocked, `expect(mockRecord).not.toHaveBeenCalled()` is a direct
 * observation that NOTHING WAS WRITTEN, rather than an inference from a status
 * code that four different refusals all produce. Its own validation --
 * vocabularies, the new_adjudicated_value rule, the missed-event rule, the one
 * transaction -- is covered against real PostgreSQL in
 * src/server/pilot/calibrationAdjudication.pg.test.ts, and the case
 * 'a refusal from the module reaches the caller as a 400' below proves the
 * refusal is not swallowed on the way out.
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

/* The vocabularies stay REAL -- the GET serves them, and a mocked copy would
   let the route ship a list the module does not define. Only the three
   functions that reach Postgres are replaced. */
jest.mock('@/src/server/pilot/calibration/adjudication', () => {
  const actual = jest.requireActual('@/src/server/pilot/calibration/adjudication');
  return {
    ...actual,
    recordAdjudication: jest.fn(),
    listAdjudicationsForClip: jest.fn(),
    listAdjudicatedFields: jest.fn(),
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
const mockRecord = recordAdjudication as jest.Mock;
const mockListAdjudications = listAdjudicationsForClip as jest.Mock;
const mockListFields = listAdjudicatedFields as jest.Mock;

const ORG = 'org-1';

const ADMIN = { accountId: 'admin-1', role: 'organization_admin', organizationId: ORG };
const LEGACY_ADMIN = { accountId: 'admin-2', role: 'admin', organizationId: ORG };
/** One of the two people whose readings are being settled between. */
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

/** Coach B saw the first one and called it a different punch. */
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

/** The row recordAdjudication answers with, in the shape the table returns. */
const WRITTEN = {
  organization_id: ORG,
  adjudication_id: 'adj-written',
  calibration_clip_id: 'clip-1',
  annotation_set_id_a: 'set-a',
  annotation_set_id_b: 'set-b',
  source_event_id_a: 'evt-a1',
  source_event_id_b: 'evt-b1',
  resolution_type: 'accept_a',
  missed_event_verdict: null,
  adjudicator_account_id: 'admin-1',
  adjudicated_at: '2026-08-29T00:00:00.000Z',
  ontology_version: 'boxing-ontology-0.1',
  notes: null,
  created_at: '2026-08-29T00:00:00.000Z',
};

function post(body: unknown): NextRequest {
  return new Request('http://localhost/api/pilot/calibration/adjudication', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }) as NextRequest;
}

function get(query = 'calibration_clip_id=clip-1'): NextRequest {
  return new Request(
    `http://localhost/api/pilot/calibration/adjudication?${query}`,
  ) as NextRequest;
}

/** The whole disagreement a decision is filed about. */
const DECISION = {
  calibration_clip_id: 'clip-1',
  source_event_id_a: 'evt-a1',
  source_event_id_b: 'evt-b1',
  resolution_type: 'accept_a',
};

/** A clip whose footage is fine and whose two readings are both finished. */
function bothSubmitted(sets = [SET_A, SET_B]) {
  mockGetClip.mockResolvedValue(CLIP);
  mockClippable.mockResolvedValue({ videoSessionId: 'vid-1', athleteId: 'ath-1' });
  mockListSets.mockResolvedValue(sets);
  mockListEvents.mockImplementation(async (_org: string, setId: string) =>
    (setId === 'set-a' ? EVENTS_A : EVENTS_B));
  mockRecord.mockResolvedValue({ adjudication: WRITTEN, fields: [] });
  mockListAdjudications.mockResolvedValue([]);
  mockListFields.mockResolvedValue([]);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('who may settle a disagreement', () => {
  test('a coach is refused, including one of the two people being adjudicated', async () => {
    // The point of the case: this coach's own reading is half of what is being
    // settled, and they are still refused. Adjudication is not "you may not
    // touch strangers' work", it is "settling the study is not yours to do".
    mockPrincipal.mockResolvedValue(ANNOTATOR_COACH);
    bothSubmitted();

    const response = await POST(post(DECISION));
    const body = await response.json();

    expect(response.status).toBe(403);
    // Nothing was read and, above all, nothing was WRITTEN. A refusal that
    // loads first leaks through timing; a refusal that writes first is not a
    // refusal.
    expect(mockGetClip).not.toHaveBeenCalled();
    expect(mockListSets).not.toHaveBeenCalled();
    expect(mockListEvents).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    expect(body.adjudication).toBeUndefined();
  });

  test.each(['athlete', 'parent', 'board', 'volunteer', 'staff'])(
    'a %s is refused the same way, and writes nothing',
    async (role) => {
      mockPrincipal.mockResolvedValue({ ...ANNOTATOR_COACH, role });
      bothSubmitted();

      const response = await POST(post(DECISION));

      expect(response.status).toBe(403);
      expect(mockListSets).not.toHaveBeenCalled();
      expect(mockRecord).not.toHaveBeenCalled();
    },
  );

  test('the platform owner is refused, and nothing about the clip is even read', async () => {
    /* Not an oversight and not a gap to be closed by a later "while we are
     * here". This surface exists so an ORGANIZATION can settle a disagreement
     * between its own two annotators; blinding.ts refuses a platform-wide role
     * by name in resolveAdjudicationEligibility's docblock, and this route
     * agrees with it.
     *
     * TWO INDEPENDENT GATES REFUSE THIS CALLER -- access.ts's requireRole here
     * and isOrganizationAdminRole inside blinding.ts -- so the status code
     * alone cannot tell which one ran, and removing either leaves 403. The
     * assertions are therefore on the OBSERVABLE difference: with the route's
     * own gate removed the clip and the sets would still be loaded before
     * blinding refused, and mockGetClip would have been called. */
    mockPrincipal.mockResolvedValue({ ...ADMIN, role: 'platform_owner' });
    bothSubmitted();

    const response = await POST(post(DECISION));

    expect(response.status).toBe(403);
    expect(mockGetClip).not.toHaveBeenCalled();
    expect(mockListSets).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('a legacy admin row is admitted, which is why the gate comes from access.ts', async () => {
    mockPrincipal.mockResolvedValue(LEGACY_ADMIN);
    bothSubmitted();

    const response = await POST(post(DECISION));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.adjudication.adjudication_id).toBe('adj-written');
    expect(mockRecord).toHaveBeenCalledTimes(1);
    // And the decision is filed under the person who actually made it.
    expect(mockRecord.mock.calls[0][0].adjudicatorAccountId).toBe('admin-2');
  });

  test("http.ts's requireRole would have refused that same row", () => {
    // The reason the import is from access.ts, made executable rather than
    // left as a claim in a comment. http.ts's variant does a bare `includes`
    // on the role string; access.ts's knows the two spellings are one role. A
    // route on the http.ts one would 403 every un-migrated admin while
    // resolveAdjudicationEligibility, which resolves the alias through
    // isOrganizationAdminRole, would have admitted them -- so the write door
    // and the module behind it would disagree about the same person.
    const legacyPrincipal: PilotPrincipal = {
      accountId: 'admin-2',
      role: 'admin',
      organizationId: ORG,
      athleteId: null,
      sessionToken: 'session-token',
      authProvider: 'microsoft',
    };

    expect(() => httpRequireRole(legacyPrincipal, ['organization_admin'])).toThrow(/Forbidden/);
    expect(isOrganizationAdminRole('admin')).toBe(true);
  });
});

describe('nothing is settled before both readings are finished', () => {
  test('a decision is REFUSED AND NOT WRITTEN while either reading is in progress', async () => {
    /* THE CASE THIS WHOLE ROUTE EXISTS FOR.
     *
     * adjudication.ts does not import blinding.ts, so recordAdjudication has
     * no idea this clip is not ready and the composite foreign keys are
     * satisfied by an in_progress set. Without the gate on the write path,
     * this request stores a durable row asserting that a human weighed two
     * readings while one of them was still being written. */
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
    mockRecord.mockResolvedValue({ adjudication: WRITTEN, fields: [] });

    const response = await POST(post(DECISION));
    const body = await response.json();
    const raw = JSON.stringify(body);

    expect(response.status).toBe(403);
    expect(body.error).toMatch(/not ready for adjudication/);

    /* THE OBSERVABLE DIFFERENCE, not the status code.
     *
     * Rewiring this route onto annotations.ts's unblinded
     * listAnnotationSetsForClip returns the same two rows, passes the
     * exactly-two check, and reaches the insert. There is no refusal
     * downstream to catch it: recordAdjudication validates vocabularies and
     * row shape only. So the assertion that pins the LOADER is that
     * recordAdjudication was never reached at all. */
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    // And the finished annotator's work did not cross the wire on the way out.
    expect(mockListEvents).not.toHaveBeenCalled();
    expect(raw).not.toContain('evt-a1');
    expect(raw).not.toContain('coach-a');
    expect(body.adjudication).toBeUndefined();
  });

  test('a clip nobody has annotated is not found, and nothing is written', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted([]);

    const response = await POST(post(DECISION));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toMatch(/no annotation sets/);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('ONE submitted reading is refused by the gate itself, not by this route', async () => {
    /* The refusal comes from resolveAdjudicationEligibility's
     * 'insufficient_sets_for_comparison', which is why the message is the
     * module's wording rather than this route's. Asserted on the module's
     * words on purpose: if that refusal is ever removed, this case goes red
     * here even though the route's own length check would still produce a
     * 403 -- so the two are not silently interchangeable. */
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted([SET_A]);

    const response = await POST(post(DECISION));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toMatch(/1 submitted annotation set\b/);
    expect(body.error).toMatch(/pairwise/);
    expect(body.error).toMatch(/exactly two independent readings/);
    expect(mockListEvents).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('THREE submitted readings are refused, which states the open question rather than answering it', async () => {
    /* Nothing caps annotators per clip and compareAnnotationSets takes exactly
     * two. Which pair of three -- or every pair -- a study means is unanswered
     * anywhere in this codebase, so the route refuses rather than settling a
     * disagreement between whichever two rows a query happened to return
     * first. OWNER DECISION, flagged in the pull request body. */
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted([
      SET_A,
      SET_B,
      setOf({ annotation_set_id: 'set-c', annotator_account_id: 'coach-c' }),
    ]);

    const response = await POST(post(DECISION));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toMatch(/3 submitted annotation sets/);
    expect(body.error).toMatch(/pairwise/);
    expect(body.error).toMatch(/not a question this build answers/);
    expect(mockListEvents).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('two readings under different vocabularies are two measurements, not one disagreement', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted([SET_A, setOf({
      annotation_set_id: 'set-b',
      annotator_account_id: 'coach-b',
      ontology_version: 'boxing-ontology-0.2',
    })]);

    const response = await POST(post(DECISION));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toMatch(/different vocabularies/);
    expect(body.error).toContain('boxing-ontology-0.1');
    expect(body.error).toContain('boxing-ontology-0.2');
    // Refused BEFORE the readings are loaded: there is nothing to decide
    // between, so there is nothing to show.
    expect(mockListEvents).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('the clip itself', () => {
  test('a clip in another organization is the same 404 as one that does not exist', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    // getCalibrationClip is organization-scoped, so a foreign clip and a
    // fictional one both come back null and must be indistinguishable from
    // here on. Byte-identical, not merely both 404.
    mockGetClip.mockResolvedValue(null);

    const foreign = await POST(post({ ...DECISION, calibration_clip_id: 'clip-in-another-gym' }));
    const foreignBody = await foreign.json();

    mockGetClip.mockResolvedValue(null);
    const fictional = await POST(post({ ...DECISION, calibration_clip_id: 'never-existed' }));
    const fictionalBody = await fictional.json();

    expect(foreign.status).toBe(404);
    expect(fictional.status).toBe(404);
    expect(JSON.stringify(foreignBody)).toBe(JSON.stringify(fictionalBody));
    expect(mockListSets).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('footage that is no longer clippable is refused on the write too', async () => {
    // Re-checked on every request, never cached from clip selection: the
    // property projects.ts documents. A review tab left open across a
    // quarantine decision is exactly what it was written about, and settling a
    // disagreement is an act performed while watching the footage.
    mockPrincipal.mockResolvedValue(ADMIN);
    mockGetClip.mockResolvedValue(CLIP);
    mockClippable.mockRejectedValue(new VideoNotClippableError('quarantined'));

    const response = await POST(post(DECISION));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toContain('not available for calibration');
    expect(mockListSets).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('the clip id is required and named when it is missing', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);

    const response = await POST(post({ resolution_type: 'accept_a' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('calibration_clip_id');
    expect(mockGetClip).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

describe('what the caller may and may not supply', () => {
  test('the two readings come from the gate, and a body claiming otherwise is ignored', async () => {
    /* A body-supplied pair is a body-supplied claim about which two readings
     * were weighed. The gate is the only thing on this path that knows which
     * pair is eligible, so the ids the insert uses are the ones it returned --
     * and A and B mean the same thing here as on the comparison screen,
     * because both take the ordering from listAnnotationSetsForClip. */
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted();

    const response = await POST(post({
      ...DECISION,
      annotation_set_id_a: 'set-somebody-elses',
      annotation_set_id_b: 'set-also-not-real',
      adjudicator_account_id: 'someone-else',
      ontology_version: 'a-vocabulary-nobody-used',
      adjudication_id: 'a-key-the-client-chose',
    }));

    expect(response.status).toBe(200);
    const input = mockRecord.mock.calls[0][0];
    expect(input.annotationSetIdA).toBe('set-a');
    expect(input.annotationSetIdB).toBe('set-b');
    expect(input.adjudicatorAccountId).toBe('admin-1');
    expect(input.ontologyVersion).toBe('boxing-ontology-0.1');
    expect(input.organizationId).toBe(ORG);
    // A client-chosen primary key is a client-chosen collision, and on this
    // table a collision is one decision overwriting another.
    expect(input.adjudicationId).not.toBe('a-key-the-client-chose');
    expect(input.adjudicationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("an event from B's reading cannot be filed as A's source", async () => {
    // The composite foreign key refuses this in the database and the pg suite
    // proves it. What this adds is that the refusal happens BEFORE anything is
    // written and names the field, instead of arriving as a 500 out of a
    // constraint name.
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted();

    const response = await POST(post({ ...DECISION, source_event_id_a: 'evt-b1' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('source_event_id_a');
    expect(body.error).toMatch(/annotator A/);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('an event id belonging to no reading on this clip is refused', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted();

    const response = await POST(post({ ...DECISION, source_event_id_b: 'evt-from-another-clip' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('source_event_id_b');
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('a side nobody selected becomes "no event here", never an empty-string id', async () => {
    /* An unselected <select> posts ''. Passed through, recordAdjudication
     * treats it as a present id and the composite foreign key refuses it as
     * 23503 -- an opaque 500 for an administrator who simply did not pick
     * anything on that side. The direction is what makes the normalisation
     * safe: '' becomes null, which the schema defines as "this annotator
     * recorded nothing here". Nothing ever becomes an id. */
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted();

    const response = await POST(post({
      calibration_clip_id: 'clip-1',
      source_event_id_a: 'evt-a2',
      source_event_id_b: '',
      resolution_type: 'accept_a',
      missed_event_verdict: '',
    }));

    expect(response.status).toBe(200);
    const input = mockRecord.mock.calls[0][0];
    expect(input.sourceEventIdA).toBe('evt-a2');
    expect(input.sourceEventIdB).toBeNull();
    expect(input.missedEventVerdict).toBeNull();
  });

  test('field decisions keep their category and provenance, and get server-minted ids', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted();

    const response = await POST(post({
      ...DECISION,
      resolution_type: 'new_adjudicated_value',
      fields: [
        {
          adjudicated_field_id: 'a-key-the-client-chose',
          field_name: 'punch_type',
          disagreement_category: 'PUNCH_TYPE',
          resolved_from: 'adjudicator',
          resolved_value: 'lead_hook',
        },
        {
          field_name: 'target_zone',
          disagreement_category: 'TARGET',
          resolved_from: 'adjudicator',
          resolved_value: '',
          unresolved: true,
        },
      ],
    }));

    expect(response.status).toBe(200);
    const input = mockRecord.mock.calls[0][0];
    expect(input.fields).toHaveLength(2);
    expect(input.fields[0].fieldName).toBe('punch_type');
    expect(input.fields[0].disagreementCategory).toBe('PUNCH_TYPE');
    expect(input.fields[0].resolvedFrom).toBe('adjudicator');
    expect(input.fields[0].resolvedValue).toBe('lead_hook');
    expect(input.fields[0].adjudicatedFieldId).not.toBe('a-key-the-client-chose');
    // An unresolved field carries no value, and '' is not a value. The module
    // refuses an unresolved field that carries one, so a blank control that
    // arrived as '' would otherwise be a 400 the reviewer cannot act on.
    expect(input.fields[1].unresolved).toBe(true);
    expect(input.fields[1].resolvedValue).toBeNull();
  });

  test('a field list that is not a list is refused rather than silently dropped', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted();

    const response = await POST(post({ ...DECISION, fields: { field_name: 'punch_type' } }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('fields');
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test("a refusal from the module reaches the caller as its own 400, not a 500", async () => {
    /* recordAdjudication refuses a new_adjudicated_value carrying no
     * adjudicator-supplied value, among others. Those rules live there and are
     * proved against real PostgreSQL in calibrationAdjudication.pg.test.ts;
     * what is proved HERE is only that the route does not swallow one on the
     * way out and hand the reviewer an opaque 500. */
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted();
    mockRecord.mockRejectedValue(new Error(
      'Missing fields: a new_adjudicated_value resolution must record the value the adjudicator supplied',
    ));

    const response = await POST(post({ ...DECISION, resolution_type: 'new_adjudicated_value' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/new_adjudicated_value/);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('what a recorded decision leaves behind', () => {
  test('an audit row says a named administrator settled a named disagreement', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted();
    mockRecord.mockResolvedValue({
      adjudication: WRITTEN,
      fields: [{ adjudicated_field_id: 'f-1', field_name: 'punch_type' }],
    });

    const response = await POST(post(DECISION));

    expect(response.status).toBe(200);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const event = mockAudit.mock.calls[0][0];

    // 'create' is already in the closed vocabulary, so no value was invented
    // and no migration is owed. The meaning rides on entity_type, which the
    // schema leaves as free text.
    expect(event.event_type).toBe('create');
    expect(event.entity_type).toBe('calibration_adjudication');
    expect(event.entity_id).toBe('adj-written');
    expect(event.actor_account_id).toBe('admin-1');
    expect(event.organization_id).toBe(ORG);
    // A disagreement corpus silently becoming model input would make the study
    // unrepeatable. writeCalibrationAuditEvent forces this and no caller can
    // turn it back on.
    expect(event.shadow_mirror).toBe(false);

    expect(event.details.resolution_type).toBe('accept_a');
    expect(event.details.annotation_set_id_a).toBe('set-a');
    expect(event.details.annotation_set_id_b).toBe('set-b');
    expect(event.details.field_decision_count).toBe(1);
  });

  test('the audit row is not a second copy of the adjudicated field values', async () => {
    // The field decisions have their own table, their own provenance columns
    // and their own uniqueness rule. A duplicate in the audit stream is a
    // second answer to the same question with nothing ordering the two.
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted();

    await POST(post({
      ...DECISION,
      resolution_type: 'new_adjudicated_value',
      fields: [{
        field_name: 'punch_type',
        disagreement_category: 'PUNCH_TYPE',
        resolved_from: 'adjudicator',
        resolved_value: 'a-value-that-must-not-be-copied',
      }],
    }));

    expect(JSON.stringify(mockAudit.mock.calls[0][0]))
      .not.toContain('a-value-that-must-not-be-copied');
  });

  test('the response is not storable by a shared cache', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted();

    const response = await POST(post(DECISION));

    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
  });

  test('an administrator who is one of the two annotators is refused, and nothing is written', async () => {
    /* OD-2026-08-29-002, ratified 2026-08-29.
     *
     * ANNOTATOR_ROLES admits 'organization_admin', so the same person can
     * annotate a clip and then settle their own reading against the other
     * coach's. The ruling: a person who produced one of the two readings
     * cannot settle the disagreement between them -- the whole point of two
     * blind readings is that a third party resolves them.
     *
     * This case replaces one that pinned the opposite while the question was
     * open, which is what let the answer arrive here rather than silently.
     *
     * The assertion is on the WRITE, not only the status. `blinding.ts` and
     * the route's own role gate both admit an organization_admin, so a status
     * check alone would not distinguish this refusal from a role refusal --
     * what makes it this one is that recordAdjudication is never reached. */
    mockPrincipal.mockResolvedValue({ ...ADMIN, accountId: 'coach-a', role: 'organization_admin' });
    bothSubmitted();

    const response = await POST(post(DECISION));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toMatch(/you annotated this clip/i);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('and is refused the working set too, so the read half agrees with the write', async () => {
    /* The refusal lives in resolveAdjudicationEligibility, which both surfaces
     * reach through listAnnotationSetsForAdjudication. Implementing it only in
     * the write route would have left an annotator able to READ the diff of
     * their own clip while being refused the settlement -- narrower than the
     * ruling, and the asymmetry would have been invisible without this case. */
    mockPrincipal.mockResolvedValue({ ...ADMIN, accountId: 'coach-b', role: 'organization_admin' });
    bothSubmitted();

    const response = await GET(get());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toMatch(/you annotated this clip/i);
    expect(body.sets).toBeUndefined();
    expect(body.events).toBeUndefined();
  });
});

describe('the working set a decision is made from', () => {
  test('GET serves both raw readings and what is already settled', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted();
    mockListAdjudications.mockResolvedValue([WRITTEN]);
    mockListFields.mockResolvedValue([{
      organization_id: ORG,
      adjudicated_field_id: 'f-1',
      adjudication_id: 'adj-written',
      field_name: 'punch_type',
      disagreement_category: 'PUNCH_TYPE',
      resolved_from: 'annotator_a',
      resolved_value: 'lead_straight',
      unresolved: false,
      created_at: '2026-08-29T00:00:00.000Z',
    }]);

    const response = await GET(get());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.sets.a.annotation_set_id).toBe('set-a');
    expect(body.sets.b.annotation_set_id).toBe('set-b');
    expect(body.events.a.map((e: { event_id: string }) => e.event_id))
      .toEqual(['evt-a1', 'evt-a2']);
    expect(body.events.b.map((e: { event_id: string }) => e.event_id)).toEqual(['evt-b1']);
    expect(body.adjudications).toHaveLength(1);
    expect(body.adjudications[0].fields[0].field_name).toBe('punch_type');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
  });

  test('the vocabularies are served from the module that defines them', async () => {
    /* The page cannot import them: adjudication.ts imports ./db, and pulling
     * that into a 'use client' bundle drags the Postgres driver into the
     * browser. The remaining choices were to retype five controlled
     * vocabularies into <option> tags -- which ontology.ts's own header says
     * is how a vocabulary drifts -- or to serve them. This asserts they are
     * the module's arrays and not a copy: a member added to
     * ADJUDICATION_RESOLUTION_TYPES appears here without this file changing. */
    const actual = jest.requireActual('@/src/server/pilot/calibration/adjudication');
    const categories = jest.requireActual(
      '@/src/server/pilot/calibration/comparison',
    ).DISAGREEMENT_CATEGORIES;

    mockPrincipal.mockResolvedValue(ADMIN);
    bothSubmitted();

    const body = await (await GET(get())).json();

    expect(body.vocabularies.resolution_types)
      .toEqual([...actual.ADJUDICATION_RESOLUTION_TYPES]);
    expect(body.vocabularies.missed_event_verdicts).toEqual([...actual.MISSED_EVENT_VERDICTS]);
    expect(body.vocabularies.resolved_from_sources).toEqual([...actual.RESOLVED_FROM_SOURCES]);
    expect(body.vocabularies.disagreement_categories).toEqual([...categories]);
  });

  test('GET refuses while a reading is in progress, and carries no events', async () => {
    // The same gate on the read side of this route, so a screen cannot be
    // populated with a half-finished study and then post against it.
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
    expect(mockListEvents).not.toHaveBeenCalled();
    expect(raw).not.toContain('evt-a1');
    expect(body.events).toBeUndefined();
    expect(body.sets).toBeUndefined();
  });

  test('a coach is refused the working set too', async () => {
    mockPrincipal.mockResolvedValue(ANNOTATOR_COACH);
    bothSubmitted();

    const response = await GET(get());

    expect(response.status).toBe(403);
    expect(mockGetClip).not.toHaveBeenCalled();
    expect(mockListSets).not.toHaveBeenCalled();
  });

  test('GET names the clip id when it is missing', async () => {
    mockPrincipal.mockResolvedValue(ADMIN);

    const response = await GET(get(''));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('calibration_clip_id');
    expect(mockGetClip).not.toHaveBeenCalled();
  });
});

describe('the door in front of this route', () => {
  test('advertises no role the API refuses', () => {
    /* buildingMap.ts's header says `roles` is a visibility hint and never an
     * authorization decision -- and then says, twice, that advertising a door
     * the API will bounce you from is the failure the list exists to avoid.
     * Nothing in this repository enforced that half. This case does, for this
     * door, by running the PRODUCTION gate rather than by comparing two
     * literals: access.ts's requireRole, against the route's own exported role
     * list, for every role the door names. Adding platform_owner to the door
     * -- the natural mistake, since every neighbouring admin door carries
     * ADMIN_GATE, which includes it -- turns this red.
     *
     * The cast is real and its failure direction is correct: a ClubRole with
     * no PilotRole spelling (the board sub-roles) is not a role the API has a
     * name for, so requireRole refuses it and this case reports it. */
    const door = BUILDING.find((entry) => entry.href === '/admin/calibration/adjudicate');
    expect(door).toBeDefined();
    expect(door?.roles).not.toBe('open');

    const advertised = door?.roles as readonly string[];
    expect(advertised.length).toBeGreaterThan(0);

    for (const role of advertised) {
      expect(() => requireRole(
        {
          accountId: 'someone',
          role: role as PilotPrincipal['role'],
          organizationId: ORG,
          athleteId: null,
        },
        [...ADJUDICATION_ROLES],
      )).not.toThrow();
    }
  });

  test('and the page behind it gates on exactly the roles the door advertises', () => {
    /* RoleSessionGate is the authority the door defers to -- buildingMap.ts's
     * header says the guard wins and the fix belongs in the map. Both sides
     * are read from their own source here, so neither is compared against a
     * third literal in this file: the door's list comes from BUILDING, the
     * page's from the allowedRoles it actually renders.
     *
     * Read from source rather than rendered, because mounting a 'use client'
     * screen inside this node-environment suite would pull a browser tree
     * into it. */
    const source = readFileSync(
      path.resolve(__dirname, '../../../../admin/calibration/adjudicate/page.tsx'),
      'utf8',
    );
    const gate = /<RoleSessionGate allowedRoles=\{\[([^\]]*)\]\}>/.exec(source);
    expect(gate).not.toBeNull();

    const guarded = (gate?.[1] ?? '')
      .split(',')
      .map((entry) => entry.trim().replace(/^'|'$/g, ''))
      .filter((entry) => entry.length > 0);

    const door = BUILDING.find((entry) => entry.href === '/admin/calibration/adjudicate');
    expect([...guarded].sort()).toEqual([...(door?.roles as readonly string[])].sort());
  });
});

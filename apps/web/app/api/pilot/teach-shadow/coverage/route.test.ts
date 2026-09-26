import { NextRequest } from 'next/server';

import { query } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { DEFENSE_TYPES, PUNCH_TYPES } from '@/src/server/pilot/calibration/ontology';

import { GET } from './route';

/*
 * HOW MUCH SHADOW HAS BEEN SHOWN. Four things are worth pinning here, and
 * three of them are properties nothing else in the stack can enforce.
 *
 * WHAT IS MOCKED AND WHY. Only the session (requirePrincipal) and the database
 * (query) are stood in for. readTeachShadowCoverage -- the module whose
 * behaviour these tests are about -- runs for real, because the two claims
 * that matter (the organization id reaching every statement, and the
 * vocabulary being complete when nothing is labelled) are decisions IT makes.
 * Mocking it would leave both untested while the file reported green.
 *
 * jsonError and requireAnnotator are likewise NOT mocked. The mapping from
 * message prefix to status ('Unauthorized' -> 401, 'Forbidden' -> 403) and the
 * role list are the contract this route reports refusals through; a
 * hand-written stand-in would test the stand-in.
 *
 * THE QUERY MOCK ANSWERS FOUR KNOWN STATEMENTS AND NOTHING ELSE. An
 * unrecognised statement is recorded and thrown on rather than answered with
 * [], because a permissive mock is how a fifth query -- or a rewritten fourth
 * one -- gets added and silently exercised by no test at all.
 */

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;

interface PunchRow {
  punch_type: string;
  stance: string | null;
  events: number;
  clips: number;
}

interface DefenseRow {
  defense_type: string;
  events: number;
  clips: number;
}

const CAPTURE_ROW = {
  recording_sessions: 3,
  capture_takes: 7,
  captured_files: 11,
  takes_with_multiple_files: 2,
  athletes_captured: 4,
};

const LABELLING_ROW = {
  clips_cut: 24,
  submitted_sets: 9,
  clips_with_two_submitted_sets: 4,
  adjudications: 2,
  gold_records: 1,
  gold_candidates: 3,
};

/** Statements the mock did not recognise. Asserted empty, so an unmatched
 *  query names itself instead of arriving as an opaque 500. */
let unmatchedSql: string[] = [];

function installQueryMock(options: { punchRows?: PunchRow[]; defenseRows?: DefenseRow[] } = {}) {
  const { punchRows = [], defenseRows = [] } = options;

  mockQuery.mockImplementation(async (text: string) => {
    if (text.includes('as recording_sessions')) return [CAPTURE_ROW];
    if (text.includes('as clips_cut')) return [LABELLING_ROW];
    if (text.includes("e.event_class = 'punch'")) return punchRows;
    if (text.includes("e.event_class = 'defense'")) return defenseRows;

    unmatchedSql.push(text);
    throw new Error('Unrecognised SQL reached the query mock');
  });
}

function principal(role: string, organizationId = 'org-principal') {
  return {
    accountId: 'acct-caller',
    role,
    organizationId,
    athleteId: null,
  };
}

/** The caller names a different gym in the query string on every request, so
 *  any test that finds that value in a SQL parameter has found a real leak
 *  rather than a coincidence. */
const CALLER_SUPPLIED_ORG = 'org-somebody-elses-gym';

function request(): NextRequest {
  return new NextRequest(
    `https://ppbf.example/api/pilot/teach-shadow/coverage?organization_id=${CALLER_SUPPLIED_ORG}`,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  unmatchedSql = [];
  installQueryMock();
});

afterEach(() => {
  // Belt and braces with the throw inside the mock: this reports the offending
  // statement by name, where the throw alone would surface as a 500.
  expect(unmatchedSql).toEqual([]);
});

test('an unauthenticated caller is refused before anything is counted', async () => {
  mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

  const response = await GET(request());

  expect(response.status).toBe(401);
  expect(mockQuery).not.toHaveBeenCalled();
});

/*
 * requireAnnotator admits coach and organization_admin only. access.ts's
 * requireRole throws 'Forbidden: role not allowed', which jsonError maps to
 * 403 on the prefix -- see src/server/pilot/access.ts:31 and
 * src/server/pilot/http.ts:176.
 *
 * The db assertion is the half that matters: a gate that refuses AFTER reading
 * still read, and these counts describe the gym's teaching work.
 */
test.each(['athlete', 'parent', 'volunteer', 'staff', 'board', 'platform_owner'])(
  'a %s is refused, and no count is read on the way to the refusal',
  async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal(role));

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.coverage).toBeUndefined();
    expect(mockQuery).not.toHaveBeenCalled();
  },
);

test('a coach gets the coverage summary', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

  const response = await GET(request());
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.coverage.capture).toEqual(CAPTURE_ROW);
  expect(body.coverage.labelling).toEqual(LABELLING_ROW);
  expect(body.coverage.ontology_version).toBe('boxing-ontology-0.1');
});

// The legacy 'admin' spelling is the same person as organization_admin, and
// annotatorGate.ts:49 deliberately lists only the new name because requireRole
// aliases them. If that aliasing is ever dropped, a real gym admin loses this
// surface silently.
test('the legacy admin spelling reaches the same surface as organization_admin', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));

  const response = await GET(request());

  expect(response.status).toBe(200);
});

/*
 * THE ORG SCOPING. Every one of the four statements is parameterised with the
 * SESSION's organization, and the id the caller put in the query string
 * reaches no statement at all.
 *
 * Asserted over every call rather than the first, because the leak this
 * guards against is one statement out of four losing its filter -- which
 * mixes another gym's counts into this gym's totals and looks like nothing
 * but a bigger number.
 */
test('every statement is scoped to the session organization, never to the caller', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal('coach', 'org-principal'));

  const response = await GET(request());

  expect(response.status).toBe(200);
  expect(mockQuery).toHaveBeenCalledTimes(4);
  for (const [, params] of mockQuery.mock.calls) {
    // $1 is the organization on every statement. Three of the four also take
    // the ontology version as $2, so the shape varies and only the first
    // position is pinned here -- the version has its own test below.
    expect(params[0]).toBe('org-principal');
  }
  expect(JSON.stringify(mockQuery.mock.calls)).not.toContain(CALLER_SUPPLIED_ORG);
});

test('no count treats footage that was not recorded to teach Shadow as corpus evidence', async () => {
  /*
   * REFUSING TO REOPEN A LEGACY CLIP IS NOT THE SAME AS NOT COUNTING IT.
   *
   * assertVideoClippable stops a clip being cut from anything but teaching
   * footage, and stops an existing one being opened again. Neither of those
   * touches this surface: the labels, adjudications and gold records already
   * produced from pre-takes footage are still rows, and counting them here
   * would report them as evidence the recognizer may be taught from -- which
   * is the promotion the whole boundary exists to prevent, arriving through
   * the reporting side instead of the write side.
   *
   * Every corpus count therefore walks back to the source video. The capture
   * statement is exempt and asserted separately: it counts video rows, which
   * carry the column themselves.
   */
  mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

  await GET(request());

  const statements = mockQuery.mock.calls.map(([text]) => String(text));
  const capture = statements.filter((text) => text.includes('as recording_sessions'));
  const corpus = statements.filter((text) => !text.includes('as recording_sessions'));

  expect(capture).toHaveLength(1);
  expect(corpus).toHaveLength(3);
  for (const text of corpus) {
    expect(text).toContain('capture_take_id is not null');
  }
  // The capture side needs no join: capture_take_id is on the video row it
  // already counts.
  expect(capture[0]).toContain('capture_take_id is not null');
});

test('a gold record is one that was promoted, not one that was nominated or excluded', async () => {
  /*
   * governance_state runs candidate -> gold -> excluded and DEFAULTS to
   * candidate, so an unfiltered count reports rows somebody deliberately kept
   * out of the reference dataset as part of it. The two states are read by
   * separate statements here, and the route must not merge them.
   */
  mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

  const response = await GET(request());
  const body = await response.json();

  const [labelling] = mockQuery.mock.calls.filter(([text]) => String(text).includes('as clips_cut'));
  expect(String(labelling[0])).toContain("governance_state = 'gold'");
  expect(String(labelling[0])).toContain("governance_state = 'candidate'");
  expect(body.coverage.labelling).toHaveProperty('gold_records');
  expect(body.coverage.labelling).toHaveProperty('gold_candidates');
});

/*
 * TWO VOCABULARY VERSIONS ARE TWO MEASUREMENTS, NEVER ONE TOTAL.
 *
 * ontology.ts:36-44 says every calibration row carries the vocabulary it was
 * created under so that a study run under 0.1 and one run under 0.2 cannot be
 * pooled by accident, and that nothing in the subsystem may aggregate across
 * versions without a recorded decision. Only one version exists today, so an
 * unfiltered count happens to be right -- which is exactly why nothing would
 * fail if the filter were dropped, and why it is asserted here rather than
 * left to be noticed on the day a second version ships.
 */
test('every labelled count is confined to the ontology version it reports', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

  const response = await GET(request());
  const body = await response.json();

  const versioned = mockQuery.mock.calls.filter(([, params]) => params.length > 1);
  // The capture-side statement counts video rows and is stamped with no
  // vocabulary, so three of the four carry the version, not all four.
  expect(versioned).toHaveLength(3);
  for (const [text, params] of versioned) {
    expect(params[1]).toBe(body.coverage.ontology_version);
    expect(String(text)).toContain('ontology_version = $2');
  }
});

/*
 * THE VOCABULARY IS THE LIST; THE QUERY ONLY FILLS IT IN.
 *
 * Both group-by statements return no rows here, which is the true state of a
 * gym on day one. A term nobody has labelled is exactly the gap this surface
 * exists to show, and a group-by returns only what exists -- so if the
 * fill-in loop in coverage.ts is ever dropped in favour of the rows, the
 * punches nobody has filmed simply stop being listed and the surface reports
 * a complete corpus.
 */
test('every punch and defense term is listed at zero when nothing has been labelled', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
  installQueryMock({ punchRows: [], defenseRows: [] });

  const response = await GET(request());
  const body = await response.json();

  expect(response.status).toBe(200);

  const punchTypesListed = new Set<string>(
    body.coverage.punch_evidence.map((cell: PunchEvidenceShape) => cell.punch_type),
  );
  expect([...punchTypesListed].sort()).toEqual([...PUNCH_TYPES].sort());
  // Exactly the two stances an unlabelled grid is allowed to pre-fill
  // (coverage.ts:198): every punch type against orthodox and southpaw, and no
  // speculative 'transition' or 'unknown' rows nobody was ever going to film.
  expect(body.coverage.punch_evidence).toHaveLength(PUNCH_TYPES.length * 2);
  for (const cell of body.coverage.punch_evidence) {
    expect(['orthodox', 'southpaw']).toContain(cell.stance);
    expect(cell).toEqual({ punch_type: cell.punch_type, stance: cell.stance, events: 0, clips: 0 });
  }

  expect(body.coverage.defense_evidence).toEqual(
    DEFENSE_TYPES.map((defense_type) => ({ defense_type, events: 0, clips: 0 })),
  );

  // Named outright as well as covered by the set comparison above: these two
  // are the terms a pilot gym is least likely to have filmed, so they are the
  // first to vanish from a rows-only listing and the last anyone would notice.
  expect(punchTypesListed.has('unclassifiable_punch')).toBe(true);
  expect(body.coverage.defense_evidence).toContainEqual({
    defense_type: 'clinch_defense',
    events: 0,
    clips: 0,
  });

  // The vocabulary block is what the surface renders its axes from, so a
  // truncated one would hide the same gaps a truncated grid does.
  expect(body.coverage.vocabulary.punch_types).toEqual([...PUNCH_TYPES]);
  expect(body.coverage.vocabulary.defense_types).toEqual([...DEFENSE_TYPES]);
});

/*
 * Labelled rows actually reach the response. Without this, the zero-state test
 * above would pass just as happily against a module that discarded the query
 * results entirely and returned a grid of zeros forever.
 *
 * The 'transition' cell is included on purpose: coverage.ts only emits a
 * non-orthodox/southpaw stance when a row exists for it (coverage.ts:198), so
 * this is the one shape the empty case cannot exercise.
 */
test('labelled evidence reaches the grid, including a stance the empty grid omits', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
  installQueryMock({
    punchRows: [
      { punch_type: 'lead_straight', stance: 'orthodox', events: 40, clips: 1 },
      { punch_type: 'rear_hook', stance: 'transition', events: 3, clips: 2 },
    ],
    defenseRows: [{ defense_type: 'slip', events: 12, clips: 5 }],
  });

  const response = await GET(request());
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.coverage.punch_evidence).toContainEqual({
    punch_type: 'lead_straight',
    stance: 'orthodox',
    events: 40,
    clips: 1,
  });
  expect(body.coverage.punch_evidence).toContainEqual({
    punch_type: 'rear_hook',
    stance: 'transition',
    events: 3,
    clips: 2,
  });
  expect(body.coverage.defense_evidence).toContainEqual({
    defense_type: 'slip',
    events: 12,
    clips: 5,
  });
  // A term with evidence must not displace the terms without any.
  expect(body.coverage.defense_evidence).toContainEqual({
    defense_type: 'pivot',
    events: 0,
    clips: 0,
  });
});

/*
 * NO MODEL CLAIM. No recognition model has been trained or evaluated, so any
 * accuracy, confidence, score or percentage in this payload would be a figure
 * nothing produced -- and a coach would make decisions on it.
 *
 * Written over the STRUCTURE of the serialized response rather than as a
 * search of its text, because a text search passes on almost anything and
 * would keep passing after someone added the field. Two structural rules:
 *
 *  1. No key anywhere in the tree is named like a model metric.
 *  2. Every number in the tree is a non-negative integer. A count is a whole
 *     number of things; 0.62 is not a count of anything, and a rate or a
 *     percentage cannot be smuggled in under a count-shaped name.
 *
 * If a legitimate future field trips rule 1, the answer is to rename it. The
 * surface this feeds says "No evaluated recognition model yet" in those words,
 * and it must be given nothing it could use to say otherwise.
 */
const MODEL_CLAIM_KEY = /accur|confiden|score|percent|pct|ratio|rate|precision|recall|readiness|probab|certain|gauge|grade|\bf1\b/i;

interface PunchEvidenceShape {
  punch_type: string;
  stance: string | null;
}

function collectKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      into.push(key);
      collectKeys(child, into);
    }
  }
  return into;
}

function collectNumbers(value: unknown, into: number[] = []): number[] {
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectNumbers(child, into);
    }
  } else if (typeof value === 'number') {
    into.push(value);
  }
  return into;
}

test('the response makes no model-performance claim of any shape', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
  installQueryMock({
    punchRows: [{ punch_type: 'lead_hook', stance: 'southpaw', events: 5, clips: 3 }],
    defenseRows: [{ defense_type: 'block', events: 8, clips: 4 }],
  });

  const response = await GET(request());
  const body = await response.json();

  expect(response.status).toBe(200);

  const keys = collectKeys(body);
  // Guards the guard: a walk that found nothing would pass rule 1 vacuously.
  expect(keys).toContain('punch_evidence');
  expect(keys.filter((key) => MODEL_CLAIM_KEY.test(key))).toEqual([]);

  const numbers = collectNumbers(body);
  expect(numbers.length).toBeGreaterThan(0);
  for (const value of numbers) {
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
});

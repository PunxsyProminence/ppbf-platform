import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { ValidationError } from '@/src/server/pilot/errors';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import {
  issueCoachCard,
  issueCoachCardToProgram,
  listCoachCards,
} from '@/src/server/pilot/coachCards';
import { getDrill } from '@/src/server/pilot/drills';
import { listIssuedWorkoutsForAssignments } from '@/src/server/pilot/workoutIssues';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/coachCards', () => ({
  issueCoachCard: jest.fn(),
  issueCoachCardToProgram: jest.fn(),
  listCoachCards: jest.fn(),
}));

// The workout-shape read is faked: the real one runs SQL through the pool.
jest.mock('@/src/server/pilot/workoutIssues', () => ({
  listIssuedWorkoutsForAssignments: jest.fn(),
}));

jest.mock('@/src/server/pilot/drills', () => {
  const actual = jest.requireActual('@/src/server/pilot/drills');
  return { ...actual, getDrill: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAssertAccess = assertActorCanAccessAthlete as jest.Mock;
const mockIssueCard = issueCoachCard as jest.Mock;
const mockIssueToProgram = issueCoachCardToProgram as jest.Mock;
const mockListCards = listCoachCards as jest.Mock;
const mockGetDrill = getDrill as jest.Mock;
const mockWorkouts = listIssuedWorkoutsForAssignments as jest.Mock;

beforeEach(() => {
  // By default no card is a step of a workout.
  mockWorkouts.mockResolvedValue([]);
});

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const getRequest = () => new NextRequest('http://localhost/api/pilot/coach/cards');

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/coach/cards', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// W-D3, OD-2026-09-18-001. A card is anchored to an active operational drill
// in the caller's gym; its wording is snapshotted from that drill by the
// writer, so the body carries a drill_id and nothing that names the drill.
const CARD_BODY = { drill_id: 'drill-1' };

const ACTIVE_DRILL = {
  drill_id: 'drill-1',
  name: 'Pivot',
  focus: 'Line work',
  difficulty: 'intermediate',
  active: true,
};

// Every refusal below is asserted for BOTH targets. The two issue paths share
// the route's gate, but they reach different writers, and a check that held for
// one and quietly not the other is exactly the gap this is here to catch.
const TARGETS = [
  ['an individual card', { athlete_id: 'ath-1' }],
  ['a program card', { program_id: 'prog-1' }],
] as const;

beforeEach(() => {
  mockGetDrill.mockResolvedValue(ACTIVE_DRILL);
});

test('athletes and parents are refused in both directions before any module call', async () => {
  for (const role of ['athlete', 'parent'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await POST(postRequest({ athlete_id: 'ath-1', ...CARD_BODY }))).status).toBeGreaterThanOrEqual(400);
    expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
  }
  expect(mockIssueCard).not.toHaveBeenCalled();
  expect(mockIssueToProgram).not.toHaveBeenCalled();
  expect(mockListCards).not.toHaveBeenCalled();
});

test('an individual card for an accessible athlete is issued under the principal organization and account', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAssertAccess.mockResolvedValue(undefined);
  mockIssueCard.mockResolvedValue({ assignment_id: 'asg-1', gap_id: null });

  const response = await POST(postRequest({
    athlete_id: 'ath-1',
    ...CARD_BODY,
    frequency_per_week: 3,
    due_date: '2026-08-28',
  }));

  expect(response.status).toBe(201);
  const call = mockIssueCard.mock.calls[0][0];
  expect(call).toEqual(expect.objectContaining({
    organizationId: 'org-1',
    athleteId: 'ath-1',
    assignedByAccountId: 'acct-coach-1',
    drillId: 'drill-1',
    frequencyPerWeek: 3,
    dueDate: '2026-08-28',
  }));
  // The writer takes its wording from the drill, so the route hands it none.
  expect(call).not.toHaveProperty('drillName');
  expect(call).not.toHaveProperty('drillDescription');
  // No explicit difficulty was sent, so none is passed and the drill decides.
  expect(call.drillDifficulty).toBeUndefined();
  expect((await response.json()).assignment_id).toBe('asg-1');
});

test('an explicit valid difficulty is passed through to override the drill\'s', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAssertAccess.mockResolvedValue(undefined);
  mockIssueCard.mockResolvedValue({ assignment_id: 'asg-1' });

  await POST(postRequest({ athlete_id: 'ath-1', ...CARD_BODY, drill_difficulty: 'elite' }));

  expect(mockIssueCard.mock.calls[0][0].drillDifficulty).toBe('elite');
});

test('an athlete off the coach roster reads as not-found, indistinguishable from one that does not exist', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAssertAccess.mockRejectedValue(new Error('Forbidden: coach is not assigned to this athlete'));

  const response = await POST(postRequest({ athlete_id: 'ath-elsewhere', ...CARD_BODY }));

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'Not found' });
  expect(mockIssueCard).not.toHaveBeenCalled();
});

test('exactly one target: both athlete_id and program_id is refused, so is neither', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  expect((await POST(postRequest({ athlete_id: 'ath-1', program_id: 'prog-1', ...CARD_BODY }))).status).toBe(400);
  expect((await POST(postRequest({ ...CARD_BODY }))).status).toBe(400);
  expect(mockIssueCard).not.toHaveBeenCalled();
  expect(mockIssueToProgram).not.toHaveBeenCalled();
});

describe.each(TARGETS)('drill_id is required for %s', (_label, target) => {
  test.each([
    ['absent', {}],
    ['null', { drill_id: null }],
    ['an empty string', { drill_id: '' }],
    ['whitespace', { drill_id: '   ' }],
    // Used to reach `.trim()` on a number and 500 with a TypeError.
    ['a number', { drill_id: 42 }],
  ])('%s -> 400 before any read or write', async (_what, drill) => {
    mockRequirePrincipal.mockResolvedValue(principal({}));

    const response = await POST(postRequest({ ...target, ...drill }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'DRILL_ID_REQUIRED' });
    expect(mockGetDrill).not.toHaveBeenCalled();
    expect(mockIssueCard).not.toHaveBeenCalled();
    expect(mockIssueToProgram).not.toHaveBeenCalled();
  });

  // INVERTED. This used to be 'a card with no drill anchor needs both title and
  // description' -- i.e. a typed-out card was valid. The owner ruling ends that.
  test('the old free-text-only card is refused', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));

    const response = await POST(postRequest({ ...target, title: 'Shadowbox', description: 'Three rounds' }));

    expect(response.status).toBe(400);
    expect(mockIssueCard).not.toHaveBeenCalled();
    expect(mockIssueToProgram).not.toHaveBeenCalled();
  });
});

describe.each(TARGETS)('THE STALE-CLIENT RULE for %s: typed card wording is refused, not discarded', (_label, target) => {
  test.each([
    ['title', { title: 'Shadowbox' }],
    ['description', { description: 'Three rounds before Friday' }],
    ['both', { title: 'Shadowbox', description: 'Three rounds' }],
    ['a non-string title', { title: 7 }],
  ])('non-empty %s alongside a valid drill_id -> 400, nothing issued', async (_what, text) => {
    mockRequirePrincipal.mockResolvedValue(principal({}));

    const response = await POST(postRequest({ ...target, ...CARD_BODY, ...text }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'DRILL_TEXT_NOT_ACCEPTED' });
    // Refused before the drill is looked up: accepting the drill while dropping
    // the coach's words is exactly what the rule prevents.
    expect(mockGetDrill).not.toHaveBeenCalled();
    expect(mockIssueCard).not.toHaveBeenCalled();
    expect(mockIssueToProgram).not.toHaveBeenCalled();
  });

  test('absent, null or empty title/description say nothing and are tolerated', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockAssertAccess.mockResolvedValue(undefined);
    mockIssueCard.mockResolvedValue({ assignment_id: 'asg-1' });
    mockIssueToProgram.mockResolvedValue({ program_id: 'prog-1', issued: [], skipped: [] });

    const blank = await POST(postRequest({ ...target, ...CARD_BODY, title: '', description: '   ' }));
    expect(blank.status).toBe(201);
    const nulls = await POST(postRequest({ ...target, ...CARD_BODY, title: null, description: null }));
    expect(nulls.status).toBe(201);
  });
});

describe.each(TARGETS)('only an active operational drill in this gym can anchor %s', (_label, target) => {
  test("another gym's drill_id reads as absent", async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockGetDrill.mockResolvedValue(null); // getDrill is org-scoped

    const response = await POST(postRequest({ ...target, drill_id: 'drill-elsewhere' }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(mockIssueCard).not.toHaveBeenCalled();
    expect(mockIssueToProgram).not.toHaveBeenCalled();
  });

  test('a reference-library id is not assignable, and reads exactly like an unknown id', async () => {
    // getDrill reads pilot.drills only, so a pilot.drill_library id finds nothing.
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockGetDrill.mockResolvedValue(null);

    const response = await POST(postRequest({ ...target, drill_id: 'drl_3c2aad1eb8baa9' }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(mockIssueCard).not.toHaveBeenCalled();
    expect(mockIssueToProgram).not.toHaveBeenCalled();
  });

  test('a retired drill is refused by name', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockGetDrill.mockResolvedValue({ ...ACTIVE_DRILL, active: false });

    const response = await POST(postRequest({ ...target, ...CARD_BODY }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('retired');
    expect(mockIssueCard).not.toHaveBeenCalled();
    expect(mockIssueToProgram).not.toHaveBeenCalled();
  });
});

test('an unknown difficulty is a 400 naming the vocabulary, not a database error', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  const response = await POST(postRequest({ athlete_id: 'ath-1', ...CARD_BODY, drill_difficulty: 'impossible' }));

  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain('beginner');
});

test('a group card answers with the issued/skipped report exactly as the module produced it', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  const result = {
    program_id: 'prog-1',
    program_name: 'Junior Boxing',
    issuance_id: 'issuance-1',
    issued: [{ athlete_id: 'ath-1', athlete_name: 'Anna', assignment_id: 'asg-1' }],
    skipped: [{ athlete_id: 'ath-2', athlete_name: 'Bela' }],
  };
  mockIssueToProgram.mockResolvedValue(result);

  const response = await POST(postRequest({ program_id: 'prog-1', ...CARD_BODY }));

  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(result);
  const call = mockIssueToProgram.mock.calls[0][0];
  expect(call).toEqual(expect.objectContaining({
    programId: 'prog-1',
    drillId: 'drill-1',
    actor: expect.objectContaining({ organizationId: 'org-1', accountId: 'acct-coach-1' }),
  }));
  expect(call).not.toHaveProperty('drillName');
  expect(call).not.toHaveProperty('drillDescription');
  // The individual path never runs for a program card.
  expect(mockAssertAccess).not.toHaveBeenCalled();
});

test('a program_id the module cannot resolve inside this organization is cloaked as not-found', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockIssueToProgram.mockResolvedValue(null);

  const response = await POST(postRequest({ program_id: 'prog-of-another-gym', ...CARD_BODY }));

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'Not found' });
});

test('GET groups rows by issuance: a coach reads their own cards', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockListCards.mockResolvedValue([
    { assignment_id: 'asg-3', issuance_id: 'issuance-9', assigned_at: '2026-08-20T10:00:00Z', athlete_name: 'Anna' },
    { assignment_id: 'asg-4', issuance_id: 'issuance-9', assigned_at: '2026-08-20T10:00:00Z', athlete_name: 'Cora' },
    { assignment_id: 'asg-1', issuance_id: null, assigned_at: '2026-08-19T10:00:00Z', athlete_name: 'Bela' },
  ]);

  const response = await GET(getRequest());

  expect(response.status).toBe(200);
  expect(mockListCards).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-coach-1', organizationId: 'org-1' }));
  const payload = await response.json();
  expect(payload.items).toHaveLength(2);
  expect(payload.items[0].issuance_id).toBe('issuance-9');
  expect(payload.items[0].cards.map((card: { assignment_id: string }) => card.assignment_id)).toEqual(['asg-3', 'asg-4']);
  expect(payload.items[1].issuance_id).toBeNull();
  expect(payload.items[1].cards.map((card: { assignment_id: string }) => card.assignment_id)).toEqual(['asg-1']);
});

test('GET for an admin reads every card in the organization, not one issuer\'s', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin', accountId: 'acct-admin-1' }));
  mockListCards.mockResolvedValue([]);

  const response = await GET(getRequest());

  expect(response.status).toBe(200);
  expect(mockListCards).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-admin-1', role: 'organization_admin' }));
});

// P2 at the route boundary. The two refusals are deliberately different
// shapes: another gym's program_id is cloaked as a 404 (the module returns
// null), while an archived program in the caller's OWN gym is named --
// the coach can see that program in their catalog, so a 404 would only
// leave them staring at a refusal for something plainly there.
test('an archived program in the caller own organization is refused by name, not cloaked', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockIssueToProgram.mockRejectedValue(
    new ValidationError(
      'That program is archived, so it cannot be issued new work. Reactivate "Old Guard" first.',
      'PROGRAM_ARCHIVED',
    ),
  );

  const response = await POST(postRequest({ program_id: 'prog-archived', ...CARD_BODY }));

  expect(response.status).toBe(400);
  const payload = await response.json();
  expect(payload.error).toMatch(/archived/i);
  expect(payload.code).toBe('PROGRAM_ARCHIVED');
});

// P1 at the route boundary: the route hands the whole principal to the
// module, which is what lets listCoachCards re-derive the access bound on
// every read. A route that passed only an account id would put the
// boundary back in the caller's hands.
test('GET passes the principal itself, so the module can bound the read by CURRENT access', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockListCards.mockResolvedValue([]);

  await GET(getRequest());

  expect(mockListCards).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: 'acct-coach-1', organizationId: 'org-1', role: 'coach' }),
  );
});

// THE SHAPE OF AN ISSUED WORKOUT (lane P7c, OD-2026-10-10-004 ruling 5). The
// answer gains `workouts` beside `items`: which cards are steps of an issued
// workout template, with what the template says beside each. `items` is
// exactly what it was, so a screen that does not know `workouts` draws what it
// always drew. The shape read is faked here (its SQL is proven against real
// Postgres in workoutIssues.pg.test.ts); these cases are the route's: what it
// asks, and what it sends.
describe('GET: the workouts the cards are steps of, beside the unchanged card groups', () => {
  const card = (id: string, assignedAt: string, extra: Record<string, unknown> = {}) => ({
    assignment_id: id,
    issuance_id: null,
    assigned_at: assignedAt,
    athlete_id: 'ath-1',
    athlete_name: 'Dana Reyes',
    ...extra,
  });
  const step = (ordinal: number, assignmentId: string, extra: Record<string, unknown> = {}) => ({
    ordinal,
    block: 'technical',
    scale_level: null,
    contact_level: 'none',
    coach_note: null,
    assignment_id: assignmentId,
    ...extra,
  });
  // What the shape read returns: the staff shape, athlete and issuer included.
  const WORKOUT = {
    issue_id: 'issue-1',
    athlete_id: 'ath-1',
    template_name: 'Technical Tuesday',
    template_version: 2,
    issued_at: '2026-10-11T15:00:00.000Z',
    issued_by_account_id: 'acct-coach-1',
    steps: [
      step(1, 'asg-w1', { block: 'warmup', scale_level: 'A', coach_note: 'Easy pace.' }),
      step(2, 'asg-w2', { contact_level: 'light_technical' }),
      step(3, 'asg-w3', { scale_level: 'C', contact_level: 'controlled_sparring', coach_note: 'Two rounds.' }),
    ],
  };
  const ROWS = [
    card('asg-newer', '2026-10-12T09:00:00Z'),
    card('asg-w3', '2026-10-11T15:00:00Z'),
    card('asg-w1', '2026-10-11T15:00:00Z'),
    card('asg-g1', '2026-10-11T12:00:00Z', { issuance_id: 'issuance-9', athlete_name: 'Anna' }),
    card('asg-w2', '2026-10-11T15:00:00Z'),
    card('asg-g2', '2026-10-11T12:00:00Z', { issuance_id: 'issuance-9', athlete_name: 'Cora' }),
    card('asg-older', '2026-10-01T09:00:00Z'),
  ];
  // The grouping the route has always sent for those rows.
  const GROUPS_AS_BEFORE = [['asg-newer'], ['asg-w3'], ['asg-w1'], ['asg-g1', 'asg-g2'], ['asg-w2'], ['asg-older']];

  beforeEach(() => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockListCards.mockResolvedValue(ROWS);
    mockWorkouts.mockResolvedValue([WORKOUT]);
  });

  const ids = (group: { cards: Array<{ assignment_id: string }> }) => group.cards.map((entry) => entry.assignment_id);

  test('items are grouped exactly as before, with or without a workout among them', async () => {
    const withWorkout = await (await GET(getRequest())).json();
    mockWorkouts.mockResolvedValue([]);
    const without = await (await GET(getRequest())).json();

    expect(withWorkout.items.map(ids)).toEqual(GROUPS_AS_BEFORE);
    expect(withWorkout.items).toEqual(without.items);
    // No group is altered to carry the shape: it travels beside them.
    expect(JSON.stringify(withWorkout.items)).not.toContain('workout');
    // No workouts: an empty list, never a missing key.
    expect(without.workouts).toEqual([]);
  });

  test("the workout is sent with its template, when it was issued, and each step's block, levels and note as the template has them", async () => {
    const payload = await (await GET(getRequest())).json();

    expect(payload.workouts).toEqual([
      {
        issue_id: 'issue-1',
        template_name: 'Technical Tuesday',
        template_version: 2,
        issued_at: '2026-10-11T15:00:00.000Z',
        steps: [
          { ordinal: 1, block: 'warmup', scale_level: 'A', contact_level: 'none', coach_note: 'Easy pace.', assignment_id: 'asg-w1' },
          // A level the coach left open stays null; nothing is added beside a contact level.
          { ordinal: 2, block: 'technical', scale_level: null, contact_level: 'light_technical', coach_note: null, assignment_id: 'asg-w2' },
          { ordinal: 3, block: 'technical', scale_level: 'C', contact_level: 'controlled_sparring', coach_note: 'Two rounds.', assignment_id: 'asg-w3' },
        ],
      },
    ]);
    // Key by key: the athlete and the issuing account are not repeated here.
    expect(Object.keys(payload.workouts[0]).sort()).toEqual(['issue_id', 'issued_at', 'steps', 'template_name', 'template_version']);
  });

  test("the shape is asked only about the cards listCoachCards returned, in the session's organization, once", async () => {
    await GET(getRequest());

    expect(mockWorkouts).toHaveBeenCalledTimes(1);
    expect(mockWorkouts).toHaveBeenCalledWith('org-1', ROWS.map((row) => row.assignment_id));
    // The access boundary ran first: the ids are its answer, not the request's.
    expect(mockListCards.mock.invocationCallOrder[0]).toBeLessThan(mockWorkouts.mock.invocationCallOrder[0]);
  });

  test('nothing in the request can name an assignment: a query string and a body are ignored', async () => {
    const request = new NextRequest('http://localhost/api/pilot/coach/cards?assignment_id=asg-not-mine&athlete_id=ath-9', {
      headers: { 'x-assignment-id': 'asg-not-mine' },
    });

    await GET(request);

    expect(mockWorkouts).toHaveBeenCalledWith('org-1', ROWS.map((row) => row.assignment_id));
    expect(JSON.stringify(mockWorkouts.mock.calls)).not.toContain('asg-not-mine');
  });

  test('two workouts are both sent, in the order the read gave them', async () => {
    const second = { ...WORKOUT, issue_id: 'issue-2', template_name: 'Friday Pads', steps: [step(1, 'asg-older'), step(2, 'asg-newer')] };
    mockWorkouts.mockResolvedValue([second, WORKOUT]);

    const payload = await (await GET(getRequest())).json();

    expect(payload.workouts.map((workout: { template_name: string; steps: Array<{ assignment_id: string }> }) => [workout.template_name, workout.steps.map((entry) => entry.assignment_id)])).toEqual([
      ['Friday Pads', ['asg-older', 'asg-newer']],
      ['Technical Tuesday', ['asg-w1', 'asg-w2', 'asg-w3']],
    ]);
    expect(payload.items.map(ids)).toEqual(GROUPS_AS_BEFORE);
  });

  test('a shape read that fails fails the read: the cards are never answered with the shape silently missing', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockWorkouts.mockRejectedValue(new Error('relation does not exist'));
    try {
      const response = await GET(getRequest());

      expect(response.status).toBe(500);
      expect(await response.json()).not.toHaveProperty('items');
    } finally {
      consoleError.mockRestore();
    }
  });

  test('an athlete or a parent is refused before any card or shape is read', async () => {
    for (const role of ['athlete', 'parent'] as const) {
      mockRequirePrincipal.mockResolvedValue(principal({ role }));
      const response = await GET(getRequest());
      expect(response.status).toBe(403);
    }
    expect(mockListCards).not.toHaveBeenCalled();
    expect(mockWorkouts).not.toHaveBeenCalled();
  });
});

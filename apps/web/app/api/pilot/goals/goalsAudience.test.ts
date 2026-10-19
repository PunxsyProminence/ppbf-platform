// Lane N8-05 (F-047). Owner ruling 2026-10-12: an athlete's goals, reported
// progress and "I did it" show read-only to their coach and their guardian;
// the "why it matters" line reaches the coach only, never the parent; another
// family's guardian is refused; nobody but the athlete writes.
//
// The real requireRole and the real assertActorCanAccessAthlete run here. What
// is stood in for is the database underneath them: the guardian link (one
// family per child), the gym's athlete row, and the goal reads and writes.

import { NextRequest } from 'next/server';

import { GET as getPersonal, POST as postPersonal, PATCH as patchPersonal } from './personal/route';
import { GET as getList } from './list/route';
import { POST as postGoal } from './route';
import { POST as postUpdate } from './update/route';
import { createPersonalGoal, listPersonalGoals, markPersonalGoalReached } from '@/src/server/pilot/achievements';
import { getGoalById, getGoalsByAthlete, upsertGoal } from '@/src/server/pilot/entities';
import { isGuardianLinkedToAthlete } from '@/src/server/pilot/guardianAccess';
import { queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { readsFullGoals } from '@/src/server/pilot/goalProjection';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('@/src/server/pilot/guardianAccess', () => ({
  ...jest.requireActual('@/src/server/pilot/guardianAccess'),
  isGuardianLinkedToAthlete: jest.fn(),
}));
jest.mock('@/src/server/pilot/achievements', () => ({
  ...jest.requireActual('@/src/server/pilot/achievements'),
  listPersonalGoals: jest.fn(),
  createPersonalGoal: jest.fn(),
  markPersonalGoalReached: jest.fn(),
}));
jest.mock('@/src/server/pilot/entities', () => ({
  ...jest.requireActual('@/src/server/pilot/entities'),
  getGoalsByAthlete: jest.fn(),
  getGoalById: jest.fn(),
  upsertGoal: jest.fn(),
}));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn().mockResolvedValue(undefined) }));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockLinked = isGuardianLinkedToAthlete as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockListPersonal = listPersonalGoals as jest.Mock;
const mockGoalsByAthlete = getGoalsByAthlete as jest.Mock;

const WHY = 'Because my dad never got to finish his.';
const OWN_WORDS = 'Run a mile without stopping';

const personalRow = {
  goal_id: 'g-own-1',
  athlete_id: 'ath-a',
  title: OWN_WORDS,
  why_it_matters: WHY,
  target_date: null,
  set_by_role: 'athlete',
  reached_at: '2026-10-10T15:00:00.000Z',
  created_at: '2026-10-01T15:00:00.000Z',
  updated_at: '2026-10-10T15:00:00.000Z',
};

// What select * returns: a SMART row, and the own-words row with every column.
const smartRow = {
  organization_id: 'org-1',
  goal_id: 'g-smart-1',
  athlete_id: 'ath-a',
  title: 'Jump rope 3 rounds',
  target_date: '2026-11-01',
  metric: 'rounds',
  status: 'active',
  category: 'conditioning',
  progress_percent: 40,
  goal_kind: 'smart',
  own_words: '',
  why_it_matters: '',
  set_by_role: 'athlete',
  reached_at: null,
  created_at: '2026-10-02T15:00:00.000Z',
  updated_at: '2026-10-05T15:00:00.000Z',
};
const ownWordsRowFromSelectStar = {
  ...smartRow,
  goal_id: 'g-own-1',
  title: OWN_WORDS,
  goal_kind: 'own_words',
  own_words: OWN_WORDS,
  why_it_matters: WHY,
  metric: '',
  progress_percent: null,
};

function as(role: string, extra: Record<string, unknown> = {}) {
  return {
    accountId: `acct-${role}`,
    role,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...extra,
  };
}

const guardianOfA = as('parent', { accountId: 'acct-guardian-a' });
const guardianOfB = as('parent', { accountId: 'acct-guardian-b' });

function get(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`);
}

function send(path: string, method: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // One family per child: guardian A is linked to ath-a, guardian B to ath-b.
  mockLinked.mockImplementation(async (_org: string, accountId: string, athleteId: string) =>
    (accountId === 'acct-guardian-a' && athleteId === 'ath-a') || (accountId === 'acct-guardian-b' && athleteId === 'ath-b'));
  // Every athlete named here is a live athlete of org-1 (the coach and admin arms).
  mockQueryOne.mockResolvedValue({ athlete_id: 'ath-a', organization_id: 'org-1' });
  mockListPersonal.mockResolvedValue([personalRow]);
  mockGoalsByAthlete.mockResolvedValue([smartRow, ownWordsRowFromSelectStar]);
});

describe('GET /api/pilot/goals/personal: the "why it matters" line is the coach\'s, never the family\'s', () => {
  test('a guardian reads their child\'s own-words goal and "I did it", and the server answer has no reason line', async () => {
    mockPrincipal.mockResolvedValue(guardianOfA);
    const response = await getPersonal(get('/api/pilot/goals/personal?athlete_id=ath-a'));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      items: [{
        goal_id: 'g-own-1',
        title: OWN_WORDS,
        target_date: null,
        reached_at: '2026-10-10T15:00:00.000Z',
        created_at: '2026-10-01T15:00:00.000Z',
      }],
    });
    // Absent from the bytes, not merely blank.
    expect(text).not.toContain('why_it_matters');
    expect(text).not.toContain(WHY);
    expect(text).not.toContain('set_by_role');
  });

  test('the coach reads the same goal WITH the reason line', async () => {
    mockPrincipal.mockResolvedValue(as('coach'));
    const response = await getPersonal(get('/api/pilot/goals/personal?athlete_id=ath-a'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items[0].why_it_matters).toBe(WHY);
  });

  test('another family\'s guardian is refused and nothing is read', async () => {
    mockPrincipal.mockResolvedValue(guardianOfB);
    const response = await getPersonal(get('/api/pilot/goals/personal?athlete_id=ath-a'));
    expect(response.status).toBe(403);
    expect(mockListPersonal).not.toHaveBeenCalled();
  });
});

describe('GET /api/pilot/goals/personal: the gym admin is not sent the reason line (F-100)', () => {
  for (const role of ['organization_admin', 'admin']) {
    test(`${role} reads the own-words goal and "I did it", with no reason line`, async () => {
      mockPrincipal.mockResolvedValue(as(role));
      const response = await getPersonal(get('/api/pilot/goals/personal?athlete_id=ath-a'));
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text).items).toEqual([expect.objectContaining({ goal_id: 'g-own-1', reached_at: '2026-10-10T15:00:00.000Z' })]);
      expect(text).not.toContain('why_it_matters');
      expect(text).not.toContain(WHY);
      expect(text).not.toContain('set_by_role');
    });
  }
});

describe('GET /api/pilot/goals/list: a guardian gets SMART goals and reported progress, from named fields', () => {
  test('a guardian reads their child\'s SMART goal with its reported progress; the own-words row and its columns do not ride along', async () => {
    mockPrincipal.mockResolvedValue(guardianOfA);
    const response = await getList(get('/api/pilot/goals/list?athlete_id=ath-a'));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      items: [{
        goal_id: 'g-smart-1',
        title: 'Jump rope 3 rounds',
        category: 'conditioning',
        target_date: '2026-11-01',
        metric: 'rounds',
        progress_percent: 40,
        status: 'active',
        created_at: '2026-10-02T15:00:00.000Z',
      }],
    });
    expect(text).not.toContain('why_it_matters');
    expect(text).not.toContain(WHY);
    expect(text).not.toContain('own_words');
    expect(text).not.toContain('organization_id');
    // The own-words rows are left out in SQL too, so the page limit counts
    // only the rows a family is sent.
    expect(mockGoalsByAthlete).toHaveBeenCalledWith('org-1', 'ath-a', { limit: 200, smartOnly: true });
  });

  test('the coach still gets the full rows, reason line included', async () => {
    mockPrincipal.mockResolvedValue(as('coach'));
    const response = await getList(get('/api/pilot/goals/list?athlete_id=ath-a'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[1].why_it_matters).toBe(WHY);
    expect(mockGoalsByAthlete).toHaveBeenCalledWith('org-1', 'ath-a', { limit: 200 });
  });

  // F-100: the ruling gives the reason line to the coach only, so the gym
  // admin (either name for the role) is sent what a guardian is sent.
  for (const role of ['organization_admin', 'admin']) {
    test(`${role} reads SMART goals and progress from named fields, with no reason line`, async () => {
      mockPrincipal.mockResolvedValue(as(role));
      const response = await getList(get('/api/pilot/goals/list?athlete_id=ath-a'));
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text).items).toEqual([expect.objectContaining({ goal_id: 'g-smart-1', progress_percent: 40 })]);
      expect(text).not.toContain('why_it_matters');
      expect(text).not.toContain(WHY);
      expect(text).not.toContain('own_words');
      expect(text).not.toContain('set_by_role');
      expect(mockGoalsByAthlete).toHaveBeenCalledWith('org-1', 'ath-a', { limit: 200, smartOnly: true });
    });
  }

  test('another family\'s guardian is refused and nothing is read', async () => {
    mockPrincipal.mockResolvedValue(guardianOfB);
    const response = await getList(get('/api/pilot/goals/list?athlete_id=ath-a'));
    expect(response.status).toBe(403);
    expect(mockGoalsByAthlete).not.toHaveBeenCalled();
  });
});

describe('nobody but the athlete writes a goal', () => {
  const smartPayload = {
    goal_id: 'g-smart-1',
    athlete_id: 'ath-a',
    title: 'Jump rope 3 rounds',
    target_date: '2026-11-01',
    metric: 'rounds',
    status: 'active',
    created_at: '2026-10-02T15:00:00.000Z',
    updated_at: '2026-10-05T15:00:00.000Z',
  };
  const writes: Array<[string, () => Promise<Response>]> = [
    ['POST /goals/personal', () => postPersonal(send('/api/pilot/goals/personal', 'POST', { athlete_id: 'ath-a', own_words: 'x' }))],
    ['PATCH /goals/personal', () => patchPersonal(send('/api/pilot/goals/personal', 'PATCH', { athlete_id: 'ath-a', goal_id: 'g-own-1' }))],
    ['POST /goals', () => postGoal(send('/api/pilot/goals', 'POST', smartPayload))],
    ['POST /goals/update', () => postUpdate(send('/api/pilot/goals/update', 'POST', smartPayload))],
  ];

  for (const role of ['coach', 'organization_admin', 'admin', 'parent']) {
    for (const [name, call] of writes) {
      test(`${role}: ${name} is refused and nothing is written`, async () => {
        mockPrincipal.mockResolvedValue(role === 'parent' ? guardianOfA : as(role));
        const response = await call();
        expect(response.status).toBe(403);
        expect(createPersonalGoal).not.toHaveBeenCalled();
        expect(markPersonalGoalReached).not.toHaveBeenCalled();
        expect(upsertGoal).not.toHaveBeenCalled();
        expect(writePilotAuditEvent).not.toHaveBeenCalled();
      });
    }
  }

  test('CONTROL: the athlete still updates their own goal (the progress report path)', async () => {
    mockPrincipal.mockResolvedValue(as('athlete', { athleteId: 'ath-a' }));
    (getGoalById as jest.Mock).mockResolvedValue({ ...smartRow });
    (upsertGoal as jest.Mock).mockResolvedValue(undefined);
    const response = await postUpdate(send('/api/pilot/goals/update', 'POST', { ...smartPayload, progress_percent: 60 }));
    expect(response.status).toBe(200);
    expect(upsertGoal).toHaveBeenCalledWith('org-1', expect.objectContaining({ goal_id: 'g-smart-1', progress_percent: 60 }), { mode: 'update', expectedAthleteId: 'ath-a' });
  });

  test('CONTROL: the athlete still creates and marks reached their own own-words goal', async () => {
    mockPrincipal.mockResolvedValue(as('athlete', { athleteId: 'ath-a' }));
    (createPersonalGoal as jest.Mock).mockResolvedValue({ ...personalRow, reached_at: null });
    (markPersonalGoalReached as jest.Mock).mockResolvedValue(personalRow);
    expect((await postPersonal(send('/api/pilot/goals/personal', 'POST', { athlete_id: 'ath-a', own_words: OWN_WORDS }))).status).toBe(201);
    expect((await patchPersonal(send('/api/pilot/goals/personal', 'PATCH', { athlete_id: 'ath-a', goal_id: 'g-own-1' }))).status).toBe(200);
    expect(markPersonalGoalReached).toHaveBeenCalledWith('org-1', 'g-own-1', 'ath-a');
  });

  test('CONTROL: the athlete still writes their own SMART goal', async () => {
    mockPrincipal.mockResolvedValue(as('athlete', { athleteId: 'ath-a' }));
    (getGoalById as jest.Mock).mockResolvedValue(null);
    (upsertGoal as jest.Mock).mockResolvedValue(undefined);
    const response = await postGoal(send('/api/pilot/goals', 'POST', smartPayload));
    expect(response.status).toBe(200);
    expect(upsertGoal).toHaveBeenCalledTimes(1);
  });
});

describe('who is sent the whole row is a named list', () => {
  test('the athlete and the coach read full rows; the gym admin, a guardian, and any role not named, get the family projection', () => {
    expect(readsFullGoals('athlete')).toBe(true);
    expect(readsFullGoals('coach')).toBe(true);
    for (const role of ['organization_admin', 'admin', 'parent', 'guardian', 'volunteer', 'board', 'platform_owner', '']) {
      expect(readsFullGoals(role)).toBe(false);
    }
  });
});

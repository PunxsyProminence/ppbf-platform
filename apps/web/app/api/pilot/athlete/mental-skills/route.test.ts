import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import {
  logImagerySession,
  readMentalSkills,
  removeMentalSkillsEntry,
  setSelfTalkCue,
} from '@/src/server/pilot/athleteMentalSkills';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/athleteMentalSkills', () => ({
  readMentalSkills: jest.fn().mockResolvedValue({ current_cue: null, imagery_sessions: [] }),
  setSelfTalkCue: jest.fn(),
  logImagerySession: jest.fn(),
  removeMentalSkillsEntry: jest.fn(),
}));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockRead = readMentalSkills as jest.Mock;
const mockCue = setSelfTalkCue as jest.Mock;
const mockImagery = logImagerySession as jest.Mock;
const mockRemove = removeMentalSkillsEntry as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

afterEach(() => jest.clearAllMocks());

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const url = 'http://localhost/api/pilot/athlete/mental-skills';
const get = (query = '') => new NextRequest(`${url}${query}`);
const post = (body: Record<string, unknown>) =>
  new NextRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('an athlete reads their own record; a query athlete_id is never read for them', async () => {
  mockPrincipal.mockResolvedValue(principal());
  expect((await GET(get('?athlete_id=ath-sibling'))).status).toBe(200);
  expect(mockRead).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-1' }), 'ath-1');
});

test('a parent must name a child, and the module gate receives that id', async () => {
  mockPrincipal.mockResolvedValue(principal({ role: 'parent', athleteId: null }));
  expect((await GET(get())).status).toBe(400);
  expect(mockRead).not.toHaveBeenCalled();

  expect((await GET(get('?athlete_id=ath-child'))).status).toBe(200);
  expect(mockRead).toHaveBeenCalledWith(expect.objectContaining({ role: 'parent' }), 'ath-child');
});

test('staff and other roles have no path here', async () => {
  for (const role of ['coach', 'organization_admin', 'admin', 'platform_owner', 'board'] as const) {
    mockPrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(get('?athlete_id=ath-1'))).status).toBeGreaterThanOrEqual(400);
    expect((await POST(post({ kind: 'imagery_session', minutes: 5 }))).status).toBeGreaterThanOrEqual(400);
  }
  expect(mockRead).not.toHaveBeenCalled();
  expect(mockImagery).not.toHaveBeenCalled();
});

test('a parent cannot write', async () => {
  mockPrincipal.mockResolvedValue(principal({ role: 'parent', athleteId: null }));
  expect((await POST(post({ kind: 'self_talk_cue', cue_text: 'x', cue_kind: 'motivational' }))).status).toBe(403);
  expect(mockCue).not.toHaveBeenCalled();
});

test('POST self_talk_cue passes the body through; the route writes no audit of its own (the module does, in its transaction)', async () => {
  mockPrincipal.mockResolvedValue(principal());
  mockCue.mockResolvedValue({ entry_id: 'e-1', cue_text: 'hands home', cue_kind: 'instructional', logged_on: '2026-10-04' });
  const response = await POST(post({ kind: 'self_talk_cue', cue_text: 'hands home', cue_kind: 'instructional', athlete_id: 'ath-x' }));
  expect(response.status).toBe(201);
  expect(mockCue).toHaveBeenCalledWith(expect.objectContaining({ athleteId: 'ath-1' }), {
    cueText: 'hands home',
    cueKind: 'instructional',
  });
  expect(mockAudit).not.toHaveBeenCalled();
});

test('POST imagery_session passes minutes and content_key through', async () => {
  mockPrincipal.mockResolvedValue(principal());
  mockImagery.mockResolvedValue({ entry_id: 'e-2', minutes: 6, content_key: null, logged_on: '2026-10-04' });
  expect((await POST(post({ kind: 'imagery_session', minutes: 6 }))).status).toBe(201);
  expect(mockImagery).toHaveBeenCalledWith(expect.anything(), { minutes: 6, contentKey: undefined });
  expect(mockAudit).not.toHaveBeenCalled();
});

test('an unknown kind is refused and nothing is written', async () => {
  mockPrincipal.mockResolvedValue(principal());
  expect((await POST(post({ kind: 'journal' }))).status).toBe(400);
  expect(mockCue).not.toHaveBeenCalled();
  expect(mockImagery).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});

const ENTRY = '0b9b7c1e-3f5d-4a8e-9c2b-6d1e2f3a4b5c';

test('POST action remove hands the entry id to the module for the session athlete; no audit in the route', async () => {
  mockPrincipal.mockResolvedValue(principal());
  mockRemove.mockResolvedValue({ entry_id: ENTRY });
  const response = await POST(post({ action: 'remove', entry_id: ENTRY, athlete_id: 'ath-x' }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ entry_id: ENTRY });
  expect(mockRemove).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-1', athleteId: 'ath-1' }), ENTRY);
  expect(mockCue).not.toHaveBeenCalled();
  expect(mockImagery).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});

test('a parent, staff and other roles cannot reach remove', async () => {
  for (const role of ['parent', 'coach', 'organization_admin', 'admin', 'platform_owner', 'board'] as const) {
    mockPrincipal.mockResolvedValue(principal({ role, athleteId: null }));
    expect((await POST(post({ action: 'remove', entry_id: ENTRY }))).status).toBe(403);
  }
  expect(mockRemove).not.toHaveBeenCalled();
});

test("the module's not-found refusal reaches the caller as 404", async () => {
  const { NotFoundError } = jest.requireActual('@/src/server/pilot/errors');
  mockPrincipal.mockResolvedValue(principal());
  mockRemove.mockRejectedValue(new NotFoundError('That entry was not found.', 'MENTAL_SKILLS_ENTRY_NOT_FOUND'));
  expect((await POST(post({ action: 'remove', entry_id: ENTRY }))).status).toBe(404);
});

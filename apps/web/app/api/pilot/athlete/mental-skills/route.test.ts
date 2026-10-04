import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { logImagerySession, readMentalSkills, setSelfTalkCue } from '@/src/server/pilot/athleteMentalSkills';
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
}));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockRead = readMentalSkills as jest.Mock;
const mockCue = setSelfTalkCue as jest.Mock;
const mockImagery = logImagerySession as jest.Mock;
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

test('POST self_talk_cue passes the body through and audits without the cue text', async () => {
  mockPrincipal.mockResolvedValue(principal());
  mockCue.mockResolvedValue({ entry_id: 'e-1', cue_text: 'hands home', cue_kind: 'instructional', logged_on: '2026-10-04' });
  const response = await POST(post({ kind: 'self_talk_cue', cue_text: 'hands home', cue_kind: 'instructional', athlete_id: 'ath-x' }));
  expect(response.status).toBe(201);
  expect(mockCue).toHaveBeenCalledWith(expect.objectContaining({ athleteId: 'ath-1' }), {
    cueText: 'hands home',
    cueKind: 'instructional',
  });
  expect(mockAudit).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(mockAudit.mock.calls[0][0])).not.toContain('hands home');
});

test('POST imagery_session passes minutes and content_key through', async () => {
  mockPrincipal.mockResolvedValue(principal());
  mockImagery.mockResolvedValue({ entry_id: 'e-2', minutes: 6, content_key: null, logged_on: '2026-10-04' });
  expect((await POST(post({ kind: 'imagery_session', minutes: 6 }))).status).toBe(201);
  expect(mockImagery).toHaveBeenCalledWith(expect.anything(), { minutes: 6, contentKey: undefined });
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ entity_id: 'e-2' }));
});

test('an unknown kind is refused and nothing is written', async () => {
  mockPrincipal.mockResolvedValue(principal());
  expect((await POST(post({ kind: 'journal' }))).status).toBe(400);
  expect(mockCue).not.toHaveBeenCalled();
  expect(mockImagery).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});

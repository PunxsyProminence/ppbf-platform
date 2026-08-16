import { NextRequest } from 'next/server';

import { POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import { createCoachObservation } from '@/src/server/pilot/intake';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

// The register reconciliation (Wave 9) found this route's coach_note write
// path -- module 002 Raw Observation Intake -- carrying a role gate, athlete
// access check, and org-scoped write with NO test pinning any of it. These
// close that gap: the observation files under the calling coach in their own
// organization, a forbidden role never reaches the write, and the athlete
// access check runs before anything is stored.

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/shadowEvents', () => ({ emitShadowEvent: jest.fn() }));
jest.mock('@/src/server/pilot/shadowTelemetry', () => ({ writeShadowTelemetryEvent: jest.fn() }));
jest.mock('@/src/server/pilot/shadowAuthority', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowAuthority');
  return { ...actual, assertShadowAuthority: jest.fn() };
});

jest.mock('@/src/server/pilot/intake', () => {
  const actual = jest.requireActual('@/src/server/pilot/intake');
  return { ...actual, createCoachObservation: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockCreate = createCoachObservation as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

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

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/intake/domain-upsert', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const COACH_NOTE_BODY = {
  entity_type: 'coach_note',
  athlete_id: 'ath-1',
  payload: { note_type: 'floor_observation', note_text: 'Working left hook off the jab.' },
};

test('a coach observation files under the calling coach in their own organization', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockCreate.mockResolvedValue('note-1');

  const response = await POST(postRequest(COACH_NOTE_BODY));
  const payload = await response.json();

  expect(response.status).toBe(200);
  expect(payload).toMatchObject({ ok: true, entity_type: 'coach_note', entity_id: 'note-1' });
  expect(mockCreate).toHaveBeenCalledWith({
    organizationId: 'org-1',
    athleteId: 'ath-1',
    coachAccountId: 'acct-coach-1',
    noteType: 'floor_observation',
    noteText: 'Working left hook off the jab.',
  });
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    entity_type: 'intake_coach_note',
    organization_id: 'org-1',
    actor_account_id: 'acct-coach-1',
  }));
});

test('a parent cannot write an observation about a child -- the role gate runs before anything', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent' }));

  const response = await POST(postRequest(COACH_NOTE_BODY));

  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});

test('an athlete the actor cannot access is refused before the write', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));

  const response = await POST(postRequest({ ...COACH_NOTE_BODY, athlete_id: 'ath-other-org' }));

  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(mockCreate).not.toHaveBeenCalled();
});

test('a missing payload is a 400-class refusal, not a write of empty strings', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  const response = await POST(postRequest({ entity_type: 'coach_note', athlete_id: 'ath-1' }));

  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(mockCreate).not.toHaveBeenCalled();
});

import { NextRequest } from 'next/server';

import { POST } from './route';
import { assertActiveParentAccount, assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import { createCoachObservation, createReadiness, linkGuardianAthlete, upsertGuardian } from '@/src/server/pilot/intake';
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
  return { ...actual, assertActorCanAccessAthlete: jest.fn(), assertActiveParentAccount: jest.fn() };
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
  return {
    ...actual,
    createCoachObservation: jest.fn(),
    upsertGuardian: jest.fn(),
    linkGuardianAthlete: jest.fn(),
    createReadiness: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockCreate = createCoachObservation as jest.Mock;
const mockCreateReadiness = createReadiness as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;
const mockAssertActiveParent = assertActiveParentAccount as jest.Mock;
const mockUpsertGuardian = upsertGuardian as jest.Mock;
const mockLinkGuardianAthlete = linkGuardianAthlete as jest.Mock;

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
    // The author's role is recorded at write time rather than re-derived from
    // the account on every read, so this note keeps reading as a coach's even
    // if that account's role changes later.
    authorRole: 'coach',
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

// A guardian_link write attaches an account to an athlete's guardian_links,
// which grants that account ongoing read access to the athlete's training
// holds, safety-gate outcomes, and staff messages (via guardianAthleteIds).
// A prior version of this branch admitted any caller allowed by the route's
// top-level role gate (organization_admin OR coach) and never validated the
// account_id at all -- a coach with legitimate standing on one athlete could
// attach any account in the organization as that athlete's guardian. These
// pin the fix: the branch now requires organization_admin, and validates
// account_id (when supplied) names a real, active, same-organization parent.

const GUARDIAN_LINK_BODY = {
  entity_type: 'guardian_link',
  athlete_id: 'ath-1',
  payload: { parent_id: 'parent-1', account_id: 'acct-parent-1' },
};

test('a coach cannot attach a guardian -- no shipped coach workflow needs this, and it would grant read access to the child’s safety data', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));

  const response = await POST(postRequest(GUARDIAN_LINK_BODY));

  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(mockAssertActiveParent).not.toHaveBeenCalled();
  expect(mockUpsertGuardian).not.toHaveBeenCalled();
  expect(mockLinkGuardianAthlete).not.toHaveBeenCalled();
});

test('an organization_admin attaching a guardian must name a real parent account in this organization', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin', accountId: 'acct-admin-1' }));
  mockAccess.mockResolvedValue(undefined);
  mockAssertActiveParent.mockResolvedValue(undefined);
  mockUpsertGuardian.mockResolvedValue(undefined);
  mockLinkGuardianAthlete.mockResolvedValue(undefined);

  const response = await POST(postRequest(GUARDIAN_LINK_BODY));
  const payload = await response.json();

  expect(response.status).toBe(200);
  expect(payload).toMatchObject({ ok: true, entity_type: 'guardian_link' });
  expect(mockAssertActiveParent).toHaveBeenCalledWith('org-1', 'acct-parent-1', 'account_id');
  expect(mockUpsertGuardian).toHaveBeenCalledWith(expect.objectContaining({
    organizationId: 'org-1',
    parentId: 'parent-1',
    accountId: 'acct-parent-1',
  }));
  expect(mockLinkGuardianAthlete).toHaveBeenCalledWith(expect.objectContaining({
    organizationId: 'org-1',
    parentId: 'parent-1',
    athleteId: 'ath-1',
  }));
});

test('an organization_admin cannot attach an account that is not an active parent in this organization', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin', accountId: 'acct-admin-1' }));
  mockAccess.mockResolvedValue(undefined);
  mockAssertActiveParent.mockRejectedValue(new Error('Missing account_id: must be an active parent account in this organization'));

  const response = await POST(postRequest(GUARDIAN_LINK_BODY));

  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(mockUpsertGuardian).not.toHaveBeenCalled();
  expect(mockLinkGuardianAthlete).not.toHaveBeenCalled();
});

test('a guardian_link write with no account_id skips account validation but still requires organization_admin', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin', accountId: 'acct-admin-1' }));
  mockAccess.mockResolvedValue(undefined);
  mockUpsertGuardian.mockResolvedValue(undefined);
  mockLinkGuardianAthlete.mockResolvedValue(undefined);

  const response = await POST(postRequest({
    entity_type: 'guardian_link',
    athlete_id: 'ath-1',
    payload: { parent_id: 'parent-1' },
  }));

  expect(response.status).toBe(200);
  expect(mockAssertActiveParent).not.toHaveBeenCalled();
  expect(mockUpsertGuardian).toHaveBeenCalledWith(expect.objectContaining({ accountId: undefined }));
});

// pilot.readiness.score is a NOT NULL column a coach-facing triage board
// (readinessBoard.ts) reads as ground truth. A missing or non-numeric score
// used to be silently coerced to a stored 0 via Number(value || 0) -- a
// fabricated "adjust the plan" reading for an athlete nobody measured. These
// pin the refusal instead.
const READINESS_BODY = {
  entity_type: 'readiness',
  athlete_id: 'ath-1',
  payload: { score: 6.5, category: 'general', measured_at: '2026-08-17T12:00:00Z' },
};

test('a readiness score is stored as the number given, not coerced or defaulted', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  // afterEach only clears call history, not implementations (jest.clearAllMocks,
  // not resetAllMocks) -- an earlier test's mockAccess.mockRejectedValue would
  // otherwise leak forward and turn this into a false 404. Each test below
  // arranges its own precondition rather than trusting file order.
  mockAccess.mockResolvedValue(undefined);
  mockCreateReadiness.mockResolvedValue('readiness-1');

  const response = await POST(postRequest(READINESS_BODY));
  const payload = await response.json();

  expect(response.status).toBe(200);
  expect(payload).toMatchObject({ ok: true, entity_type: 'readiness', entity_id: 'readiness-1' });
  expect(mockCreateReadiness).toHaveBeenCalledWith({
    organizationId: 'org-1',
    athleteId: 'ath-1',
    score: 6.5,
    category: 'general',
    measuredAt: '2026-08-17T12:00:00Z',
    method: 'staff_entered_intake',
    recordedByAccountId: 'acct-coach-1',
  });
});

test('a missing readiness score is refused, never fabricated as 0', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockResolvedValue(undefined);

  const response = await POST(
    postRequest({ ...READINESS_BODY, payload: { category: 'general', measured_at: '2026-08-17T12:00:00Z' } }),
  );
  const payload = await response.json();

  expect(response.status).toBe(400);
  expect(String(payload.error)).toMatch(/Unsupported payload\.score/);
  expect(mockCreateReadiness).not.toHaveBeenCalled();
});

test('a non-numeric readiness score is refused, never coerced by Number()', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockResolvedValue(undefined);

  const response = await POST(
    postRequest({ ...READINESS_BODY, payload: { ...READINESS_BODY.payload, score: 'not-a-number' } }),
  );
  const payload = await response.json();

  expect(response.status).toBe(400);
  expect(String(payload.error)).toMatch(/Unsupported payload\.score/);
  expect(mockCreateReadiness).not.toHaveBeenCalled();
});

test('a zero readiness score is a real, legitimate reading -- accepted, not mistaken for absence', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockResolvedValue(undefined);
  mockCreateReadiness.mockResolvedValue('readiness-2');

  const response = await POST(postRequest({ ...READINESS_BODY, payload: { ...READINESS_BODY.payload, score: 0 } }));

  expect(response.status).toBe(200);
  expect(mockCreateReadiness).toHaveBeenCalledWith(expect.objectContaining({ score: 0 }));
});

// ---------------------------------------------------------------------------
// automation_mode is the second of the two unchecked assertShadowAuthority
// call sites named in shadow/medical-status/route.ts's header.
//
// The value was taken straight off the body, typed ShadowAutomationMode by an
// `as` cast that proves nothing at runtime, and handed to the authority
// decider -- whose automatic-actor refusals all compare `=== 'automatic'` --
// before being persisted verbatim into pilot.shadow_authority_checks,
// pilot.shadow_events and pilot.shadow_telemetry_events, none of which carry a
// CHECK on the column. So an unrecognised value was both a gate that never
// fired and an audit vocabulary a caller could write anything into.

const INVALID_AUTOMATION_MODES: Array<[string, unknown]> = [
  ['a cased near-miss', 'Automatic'],
  ['an upper-cased near-miss', 'AUTOMATIC'],
  ['a padded near-miss', ' automatic '],
  ['an unknown word', 'supervised'],
  ['an empty string', ''],
  ['an object', { mode: 'manual' }],
  ['an array', ['manual']],
  ['a number', 1],
  ['a boolean', false],
];

describe('automation_mode is held to the closed vocabulary', () => {
  // A table-driven guard over an empty list passes without running.
  test('the invalid-mode table is not empty', () => {
    expect(INVALID_AUTOMATION_MODES.length).toBeGreaterThan(0);
  });

  test.each(INVALID_AUTOMATION_MODES)('%s automation_mode is refused before the write', async (_label, mode) => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockAccess.mockResolvedValue(undefined);
    mockCreate.mockResolvedValue('note-1');

    const response = await POST(postRequest({ ...COACH_NOTE_BODY, automation_mode: mode }));

    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test.each(['automatic', 'assisted', 'manual'])('the vocabulary value %p is accepted', async (mode) => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockAccess.mockResolvedValue(undefined);
    mockCreate.mockResolvedValue('note-1');

    const response = await POST(postRequest({ ...COACH_NOTE_BODY, automation_mode: mode }));

    expect(response.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('an omitted automation_mode still defaults to assisted', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockAccess.mockResolvedValue(undefined);
    mockCreate.mockResolvedValue('note-1');

    const response = await POST(postRequest(COACH_NOTE_BODY));

    expect(response.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

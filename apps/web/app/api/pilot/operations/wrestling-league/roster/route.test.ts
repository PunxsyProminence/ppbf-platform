import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { assertAthleteMayBeEnteredInCompetition } from '@/src/server/pilot/competitionSafetyGates';
import { ConflictError, ForbiddenError } from '@/src/server/pilot/errors';
import { addLeagueRosterEntry, listLeagueRoster, withdrawLeagueRosterEntry } from '@/src/server/pilot/wrestlingLeague';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

// The three safety gates are unit-tested against their own conditions in
// src/server/pilot/competitionSafetyGates.test.ts. What this file has to pin is
// the wiring: that the roster POST calls the gate BEFORE the write, with this
// season and this athlete, and that each refusal reaches the caller with its
// own status instead of being flattened into a 500.
jest.mock('@/src/server/pilot/competitionSafetyGates', () => ({
  assertAthleteMayBeEnteredInCompetition: jest.fn(),
}));

jest.mock('@/src/server/pilot/wrestlingLeague', () => {
  const actual = jest.requireActual('@/src/server/pilot/wrestlingLeague');
  return {
    ...actual,
    addLeagueRosterEntry: jest.fn(),
    listLeagueRoster: jest.fn(),
    withdrawLeagueRosterEntry: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAdd = addLeagueRosterEntry as jest.Mock;
const mockList = listLeagueRoster as jest.Mock;
const mockWithdraw = withdrawLeagueRosterEntry as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;
const mockGates = assertAthleteMayBeEnteredInCompetition as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const getRequest = (query: string) =>
  new NextRequest(`http://localhost/api/pilot/operations/wrestling-league/roster?${query}`);

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/operations/wrestling-league/roster', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('a coach reads the roster but cannot add to it', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  mockList.mockResolvedValue([]);

  expect((await GET(getRequest('season_id=s-1'))).status).toBe(200);
  expect((await POST(postRequest({ season_id: 's-1', athlete_id: 'ath-1' }))).status).toBeGreaterThanOrEqual(400);
  expect(mockAdd).not.toHaveBeenCalled();
});

// Unchanged behaviour, narrowed wording: the SEASON arm is still a hidden
// not-found (addLeagueRosterEntry returns null for a season it cannot see).
// The athlete arm is now answered earlier, by the access gate below, whose
// refusal is identical for a missing, foreign, or unassigned athlete -- so
// nothing that was hidden became visible.
test('a season the caller cannot see is a hidden not-found', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAdd.mockResolvedValue(null);

  const response = await POST(postRequest({ season_id: 's-1', athlete_id: 'ath-1' }));

  expect(response.status).toBe(404);
});

test('a duplicate roster add answers 409', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAdd.mockRejectedValue(new Error('LEAGUE_ROSTER_DUPLICATE_ENTRY: athlete already on this season roster'));

  const response = await POST(postRequest({ season_id: 's-1', athlete_id: 'ath-1' }));
  const payload = await response.json();

  expect(response.status).toBe(409);
  expect(payload.error).toMatch(/already on the season roster/i);
});

test('a valid add files the link under the caller', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAdd.mockResolvedValue({ entry_id: 'entry-1' });

  await POST(postRequest({ season_id: 's-1', athlete_id: 'ath-1' }));

  expect(mockAdd).toHaveBeenCalledWith({
    organizationId: 'org-1',
    seasonId: 's-1',
    athleteId: 'ath-1',
    createdByAccountId: 'acct-1',
  });
});

const patchRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/operations/wrestling-league/roster', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('a coach cannot withdraw a roster entry; an admin can, and it audits', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  expect((await PATCH(patchRequest({ entry_id: 'e-1', status: 'inactive' }))).status).toBeGreaterThanOrEqual(400);
  expect(mockWithdraw).not.toHaveBeenCalled();

  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockWithdraw.mockResolvedValue({ entry_id: 'e-1', status: 'inactive' });

  const response = await PATCH(patchRequest({ entry_id: 'e-1', status: 'inactive' }));
  const payload = await response.json();

  expect(response.status).toBe(200);
  expect(payload.item.status).toBe('inactive');
  expect(mockWithdraw).toHaveBeenCalledWith({ organizationId: 'org-1', entryId: 'e-1' });
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    entity_type: 'wrestling_league_roster_entry',
    details: { action: 'withdraw' },
  }));
});

test('an invented status is a 400', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  const response = await PATCH(patchRequest({ entry_id: 'e-1', status: 'active' }));

  expect(response.status).toBe(400);
  expect(mockWithdraw).not.toHaveBeenCalled();
});

test('withdrawing an already-inactive (or cross-org) roster entry is a hidden not-found', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockWithdraw.mockResolvedValue(null);

  const response = await PATCH(patchRequest({ entry_id: 'e-gone', status: 'inactive' }));

  expect(response.status).toBe(404);
  expect(mockAudit).not.toHaveBeenCalled();
});

test('the safety gates run against this athlete and this season, before the write', async () => {
  const actor = principal({});
  mockRequirePrincipal.mockResolvedValue(actor);
  mockAdd.mockResolvedValue({ entry_id: 'entry-1' });

  const response = await POST(postRequest({ season_id: 's-1', athlete_id: 'ath-1' }));

  expect(response.status).toBe(200);
  expect(mockGates).toHaveBeenCalledWith({
    actor,
    athleteId: 'ath-1',
    kind: 'wrestling_league_season',
    contextId: 's-1',
  });
  // Order matters more than the call itself: a gate that runs after the insert
  // is not a gate.
  expect(mockGates.mock.invocationCallOrder[0]).toBeLessThan(mockAdd.mock.invocationCallOrder[0]);
});

test('a coach with no standing on the athlete is refused 403 and no roster row is written', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  mockGates.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

  const response = await POST(postRequest({ season_id: 's-1', athlete_id: 'ath-not-mine' }));

  // A coach cannot reach this write today (LEAGUE_WRITE_ROLES is admin-only),
  // so the role check refuses first -- what this pins is that if a coach is
  // ever added to the write set, the per-athlete gate is already the thing
  // standing between them and a child they have no relationship with.
  expect(response.status).toBe(403);
  expect(mockAdd).not.toHaveBeenCalled();
});

test('an athlete under a hold covering contact cannot be put on a season roster', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockGates.mockRejectedValue(new ForbiddenError(
    'Training hold: this athlete cannot be added to a wrestling league season roster while a hold covering contact is active (scope: contact_only).'
    + ' Your ribs need two more weeks before contact.',
    'TRAINING_HOLD_BLOCKS_COMPETITION',
  ));

  const response = await POST(postRequest({ season_id: 's-1', athlete_id: 'ath-1' }));
  const payload = await response.json();

  expect(response.status).toBe(403);
  // The athlete's own words survive the trip out -- not "Internal server error".
  expect(payload.error).toMatch(/hold covering contact/);
  expect(payload.code).toBe('TRAINING_HOLD_BLOCKS_COMPETITION');
  expect(mockAdd).not.toHaveBeenCalled();
});

test('a missing travel waiver cannot be put on a season roster', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockGates.mockRejectedValue(new ConflictError(
    'Travel waiver missing: no signed travel waiver is on file for this athlete, and a wrestling league season roster means taking a minor off-site.',
    'TRAVEL_WAIVER_NOT_SIGNED',
  ));

  const response = await POST(postRequest({ season_id: 's-1', athlete_id: 'ath-1' }));
  const payload = await response.json();

  expect(response.status).toBe(409);
  expect(payload.error).toMatch(/no signed travel waiver/i);
  expect(payload.code).toBe('TRAVEL_WAIVER_NOT_SIGNED');
  expect(mockAdd).not.toHaveBeenCalled();
});

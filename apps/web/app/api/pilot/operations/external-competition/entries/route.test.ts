import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { assertAthleteMayBeEnteredInCompetition } from '@/src/server/pilot/competitionSafetyGates';
import { ConflictError, ForbiddenError } from '@/src/server/pilot/errors';
import {
  addCompetitionEntry,
  listCompetitionEntries,
  recordEntryResult,
  withdrawCompetitionEntry,
} from '@/src/server/pilot/externalCompetition';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// The three safety gates are unit-tested against their own conditions in
// src/server/pilot/competitionSafetyGates.test.ts. What this file has to pin is
// the wiring: that the entry POST calls the gate BEFORE the write, with this
// competition and this athlete, and that each refusal reaches the caller with
// its own status instead of being flattened into a 500.
jest.mock('@/src/server/pilot/competitionSafetyGates', () => ({
  assertAthleteMayBeEnteredInCompetition: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

jest.mock('@/src/server/pilot/externalCompetition', () => {
  const actual = jest.requireActual('@/src/server/pilot/externalCompetition');
  return {
    ...actual,
    addCompetitionEntry: jest.fn(),
    listCompetitionEntries: jest.fn(),
    recordEntryResult: jest.fn(),
    withdrawCompetitionEntry: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAdd = addCompetitionEntry as jest.Mock;
const mockList = listCompetitionEntries as jest.Mock;
const mockRecord = recordEntryResult as jest.Mock;
const mockWithdraw = withdrawCompetitionEntry as jest.Mock;
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
  new NextRequest(`http://localhost/api/pilot/operations/external-competition/entries?${query}`);

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/operations/external-competition/entries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('a coach reads entries but cannot add one', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  mockList.mockResolvedValue([]);

  expect((await GET(getRequest('competition_id=c-1'))).status).toBe(200);
  expect(mockList).toHaveBeenCalledWith('org-1', 'c-1');
  expect((await POST(postRequest({ competition_id: 'c-1', athlete_id: 'ath-1' }))).status).toBeGreaterThanOrEqual(400);
  expect(mockAdd).not.toHaveBeenCalled();
});

test('a missing competition_id is a 400, not an unscoped read', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));

  expect((await GET(getRequest(''))).status).toBe(400);
  expect(mockList).not.toHaveBeenCalled();
});

// Unchanged behaviour, narrowed wording: the COMPETITION arm is still a hidden
// not-found (addCompetitionEntry returns null for a competition it cannot see).
// The athlete arm is now answered earlier, by the access gate below, whose
// refusal is identical for a missing, foreign, or unassigned athlete -- so
// nothing that was hidden became visible.
test('a competition the caller cannot see is a hidden not-found', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAdd.mockResolvedValue(null);

  const response = await POST(postRequest({ competition_id: 'c-1', athlete_id: 'ath-1' }));

  expect(response.status).toBe(404);
});

test('a duplicate entry answers 409', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAdd.mockRejectedValue(new Error('COMPETITION_DUPLICATE_ENTRY: athlete already entered in this competition'));

  const response = await POST(postRequest({ competition_id: 'c-1', athlete_id: 'ath-1' }));
  const payload = await response.json();

  expect(response.status).toBe(409);
  expect(payload.error).toMatch(/already entered/i);
});

test('a valid entry files the link under the caller', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAdd.mockResolvedValue({ entry_id: 'entry-1' });

  await POST(postRequest({ competition_id: 'c-1', athlete_id: 'ath-1' }));

  expect(mockAdd).toHaveBeenCalledWith({
    organizationId: 'org-1',
    competitionId: 'c-1',
    athleteId: 'ath-1',
    createdByAccountId: 'acct-1',
  });
});

test('the safety gates run against this athlete and this competition, before the write', async () => {
  const actor = principal({});
  mockRequirePrincipal.mockResolvedValue(actor);
  mockAdd.mockResolvedValue({ entry_id: 'entry-1' });

  const response = await POST(postRequest({ competition_id: 'c-1', athlete_id: 'ath-1' }));

  expect(response.status).toBe(200);
  expect(mockGates).toHaveBeenCalledWith({
    actor,
    athleteId: 'ath-1',
    kind: 'external_competition',
    contextId: 'c-1',
  });
  // Order matters more than the call itself: a gate that runs after the insert
  // is not a gate.
  expect(mockGates.mock.invocationCallOrder[0]).toBeLessThan(mockAdd.mock.invocationCallOrder[0]);
});

test('a coach with no standing on the athlete is refused 403 and no entry is written', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  mockGates.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

  const response = await POST(postRequest({ competition_id: 'c-1', athlete_id: 'ath-not-mine' }));

  // A coach cannot reach this write today (COMPETITION_WRITE_ROLES is
  // admin-only), so the role check refuses first -- what this pins is that if a
  // coach is ever added to the write set, the per-athlete gate is already the
  // thing standing between them and a child they have no relationship with.
  expect(response.status).toBe(403);
  expect(mockAdd).not.toHaveBeenCalled();
});

test('an athlete under a hold covering contact cannot be entered into a competition', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockGates.mockRejectedValue(new ForbiddenError(
    'Training hold: this athlete cannot be added to an external competition while a hold covering contact is active (scope: all_training).'
    + ' We are giving your head time to heal before you train again.',
    'TRAINING_HOLD_BLOCKS_COMPETITION',
  ));

  const response = await POST(postRequest({ competition_id: 'c-1', athlete_id: 'ath-1' }));
  const payload = await response.json();

  expect(response.status).toBe(403);
  // The athlete's own words survive the trip out -- not "Internal server error".
  expect(payload.error).toMatch(/hold covering contact/);
  expect(payload.code).toBe('TRAINING_HOLD_BLOCKS_COMPETITION');
  expect(mockAdd).not.toHaveBeenCalled();
});

test('a missing travel waiver cannot be entered into a competition', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockGates.mockRejectedValue(new ConflictError(
    'Travel waiver missing: no signed travel waiver is on file for this athlete, and an external competition means taking a minor off-site.',
    'TRAVEL_WAIVER_NOT_SIGNED',
  ));

  const response = await POST(postRequest({ competition_id: 'c-1', athlete_id: 'ath-1' }));
  const payload = await response.json();

  expect(response.status).toBe(409);
  expect(payload.error).toMatch(/no signed travel waiver/i);
  expect(payload.code).toBe('TRAVEL_WAIVER_NOT_SIGNED');
  expect(mockAdd).not.toHaveBeenCalled();
});

const patchRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/operations/external-competition/entries', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('a loss cannot be recorded without its lesson -- refused with the reason, and coaches cannot record at all', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  expect((await PATCH(patchRequest({ entry_id: 'e-1', result: 'won' }))).status).toBeGreaterThanOrEqual(400);
  expect(mockRecord).not.toHaveBeenCalled();

  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockRecord.mockRejectedValue(new Error('COMPETITION_LOSS_NEEDS_LESSON: a loss cannot be recorded without its lesson'));
  const refused = await PATCH(patchRequest({ entry_id: 'e-1', result: 'lost' }));
  expect(refused.status).toBe(400);
  const payload = await refused.json();
  expect(payload.error).toMatch(/What did it teach/);
  expect(mockAudit).not.toHaveBeenCalled();
});

test('an invented result is a 400; a real result records and audits with its lesson flag', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  expect((await PATCH(patchRequest({ entry_id: 'e-1', result: 'crushed_it' }))).status).toBe(400);
  expect(mockRecord).not.toHaveBeenCalled();

  mockRecord.mockResolvedValue({ entry_id: 'e-1', result: 'lost', lesson_note: 'kept dropping the right hand in round 2' });
  const response = await PATCH(patchRequest({
    entry_id: 'e-1', result: 'lost', lesson_note: 'kept dropping the right hand in round 2',
  }));
  expect(response.status).toBe(200);
  expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
    result: 'lost', lessonNote: 'kept dropping the right hand in round 2',
  }));
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    entity_type: 'external_competition_entry',
    details: expect.objectContaining({ action: 'record_result', result: 'lost', has_lesson: true }),
  }));
});

test('a coach cannot withdraw an entry; an admin can, and it audits', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  expect((await PATCH(patchRequest({ entry_id: 'e-1', status: 'withdrawn' }))).status).toBeGreaterThanOrEqual(400);
  expect(mockWithdraw).not.toHaveBeenCalled();

  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockWithdraw.mockResolvedValue({ entry_id: 'e-1', status: 'withdrawn' });

  const response = await PATCH(patchRequest({ entry_id: 'e-1', status: 'withdrawn' }));
  const payload = await response.json();

  expect(response.status).toBe(200);
  expect(payload.item.status).toBe('withdrawn');
  expect(mockWithdraw).toHaveBeenCalledWith({ organizationId: 'org-1', entryId: 'e-1' });
  expect(mockRecord).not.toHaveBeenCalled();
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    entity_type: 'external_competition_entry',
    details: { action: 'withdraw' },
  }));
});

test('an invented status is a 400', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  const response = await PATCH(patchRequest({ entry_id: 'e-1', status: 'benched' }));

  expect(response.status).toBe(400);
  expect(mockWithdraw).not.toHaveBeenCalled();
});

test('withdrawing an already-withdrawn (or cross-org) entry is a hidden not-found', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockWithdraw.mockResolvedValue(null);

  const response = await PATCH(patchRequest({ entry_id: 'e-gone', status: 'withdrawn' }));

  expect(response.status).toBe(404);
  expect(mockAudit).not.toHaveBeenCalled();
});

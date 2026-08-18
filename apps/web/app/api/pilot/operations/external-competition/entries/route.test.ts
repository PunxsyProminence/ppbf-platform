import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
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

test('a competition or athlete outside the organization is a hidden not-found', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAdd.mockResolvedValue(null);

  const response = await POST(postRequest({ competition_id: 'c-1', athlete_id: 'ath-other-org' }));

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

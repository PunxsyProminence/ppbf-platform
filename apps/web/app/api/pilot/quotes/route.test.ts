import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import { createQuote, listQuotes, updateQuote } from '@/src/server/pilot/orgQuotes';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

jest.mock('@/src/server/pilot/orgQuotes', () => {
  const actual = jest.requireActual('@/src/server/pilot/orgQuotes');
  return { ...actual, listQuotes: jest.fn(), createQuote: jest.fn(), updateQuote: jest.fn() };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockList = listQuotes as jest.Mock;
const mockCreate = createQuote as jest.Mock;
const mockUpdate = updateQuote as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

const QUOTE_ID = '11111111-2222-3333-4444-555555555555';
const QUOTE = { quote_id: QUOTE_ID, organization_id: 'org-1', quote_text: 'Hands up.', quote_type: 'gym_saying', active: true };

beforeEach(() => {
  mockList.mockResolvedValue([QUOTE]);
  mockCreate.mockResolvedValue(QUOTE);
  mockUpdate.mockResolvedValue(QUOTE);
});

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

const getRequest = () => new NextRequest('http://localhost/api/pilot/quotes');
const bodyRequest = (method: 'POST' | 'PATCH', body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/quotes', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const NEW_QUOTE = { quote_text: 'Hands up.', quote_type: 'gym_saying' };

test('coaches and org admins read the library, scoped to their own organization', async () => {
  for (const role of ['coach', 'organization_admin', 'admin'] as const) {
    mockPrincipal.mockResolvedValue(principal({ role, organizationId: 'org-9' }));
    expect((await GET(getRequest())).status).toBe(200);
  }
  expect(mockList).toHaveBeenCalledTimes(3);
  expect(mockList.mock.calls.every(([org]) => org === 'org-9')).toBe(true);
});

test('athletes, parents, board and the platform owner cannot read', async () => {
  for (const role of ['athlete', 'parent', 'board', 'platform_owner'] as const) {
    mockPrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(getRequest())).status).toBe(403);
  }
  expect(mockList).not.toHaveBeenCalled();
});

test('only the organization admin writes: coaches and everyone else are refused on POST and PATCH', async () => {
  for (const role of ['coach', 'athlete', 'parent', 'board', 'platform_owner'] as const) {
    mockPrincipal.mockResolvedValue(principal({ role }));
    expect((await POST(bodyRequest('POST', NEW_QUOTE))).status).toBe(403);
    expect((await PATCH(bodyRequest('PATCH', { quote_id: QUOTE_ID, active: false }))).status).toBe(403);
  }
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});

test('an unauthenticated caller gets 401', async () => {
  mockPrincipal.mockRejectedValue(new Error('Unauthorized'));
  expect((await GET(getRequest())).status).toBe(401);
  expect((await POST(bodyRequest('POST', NEW_QUOTE))).status).toBe(401);
});

test('create uses the principal organization, never one from the request, defaults to active, and audits', async () => {
  mockPrincipal.mockResolvedValue(principal({ organizationId: 'org-1' }));

  const res = await POST(bodyRequest('POST', { ...NEW_QUOTE, organization_id: 'org-evil', speaker: ' Coach ' }));

  expect(res.status).toBe(200);
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
    organizationId: 'org-1', quoteText: 'Hands up.', speaker: 'Coach', source: '',
    quoteType: 'gym_saying', shown: ['anywhere'], active: true,
  }));
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    event_type: 'create', organization_id: 'org-1', entity_type: 'org_quote', entity_id: QUOTE_ID,
  }));
});

test('update uses the principal organization, and a quote in another organization is a 404', async () => {
  mockPrincipal.mockResolvedValue(principal({ organizationId: 'org-1' }));

  expect((await PATCH(bodyRequest('PATCH', { quote_id: QUOTE_ID, organization_id: 'org-evil', active: false }))).status).toBe(200);
  expect(mockUpdate).toHaveBeenCalledWith('org-1', QUOTE_ID, expect.objectContaining({ active: false }));

  mockUpdate.mockResolvedValueOnce(null);
  expect((await PATCH(bodyRequest('PATCH', { quote_id: QUOTE_ID, active: false }))).status).toBe(404);
});

test('bad input is refused with 400 before anything is written', async () => {
  mockPrincipal.mockResolvedValue(principal({}));
  const bad: Array<['POST' | 'PATCH', Record<string, unknown>]> = [
    ['POST', { quote_type: 'gym_saying' }],
    ['POST', { ...NEW_QUOTE, quote_text: '   ' }],
    ['POST', { ...NEW_QUOTE, quote_type: 'slogan' }],
    ['POST', { quote_text: 'x' }],
    ['POST', { ...NEW_QUOTE, quote_text: 'x'.repeat(281) }],
    ['POST', { ...NEW_QUOTE, shown: [] }],
    ['POST', { ...NEW_QUOTE, shown: ['always'] }],
    ['POST', { ...NEW_QUOTE, active: 'yes' }],
    ['PATCH', { quote_id: 'not-a-uuid', active: false }],
    ['PATCH', { quote_id: QUOTE_ID }],
    ['PATCH', { quote_id: QUOTE_ID, quote_text: '  ' }],
  ];
  for (const [method, body] of bad) {
    const res = await (method === 'POST' ? POST : PATCH)(bodyRequest(method, body));
    expect([method, body, res.status]).toEqual([method, body, 400]);
  }
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
});

test('the length limit counts characters, not UTF-16 units', async () => {
  mockPrincipal.mockResolvedValue(principal({}));
  // 280 astral characters are 560 UTF-16 units but exactly 280 characters.
  const res = await POST(bodyRequest('POST', { ...NEW_QUOTE, quote_text: '\u{1F94A}'.repeat(280) }));
  expect(res.status).toBe(200);
});

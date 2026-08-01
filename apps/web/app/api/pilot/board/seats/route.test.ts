import { NextRequest } from 'next/server';

import { DELETE, GET, PATCH, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  BoardSeatConflictError,
  assertCanManageBoardSeats,
  assignBoardSeat,
  listBoardRoster,
  listSeatHolders,
  removeBoardSeat,
  setPrimarySeatHolder,
} from '@/src/server/pilot/boardSeats';
import { requireMicrosoftAuthenticatedPrincipal, requirePrincipal } from '@/src/server/pilot/http';

// The conflict class and the seat vocabulary stay real: the 409 the route
// returns is decided by `instanceof`, and a stubbed class would let that pass
// while the deployed route fell through to a generic failure.
jest.mock('@/src/server/pilot/boardSeats', () => ({
  ...jest.requireActual('@/src/server/pilot/boardSeats'),
  assertCanManageBoardSeats: jest.fn(),
  assignBoardSeat: jest.fn(),
  listBoardRoster: jest.fn(),
  listSeatHolders: jest.fn(),
  removeBoardSeat: jest.fn(),
  setPrimarySeatHolder: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => ({
  requirePrincipal: jest.fn(),
  requireMicrosoftAuthenticatedPrincipal: jest.fn(),
  jsonError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith('Unauthorized')
      ? 401
      : message.startsWith('Forbidden')
        ? 403
        : message.startsWith('Missing') || message.startsWith('Unsupported')
          ? 400
          : message.startsWith('Not found')
            ? 404
            : 500;
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  },
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockRequireMicrosoft = jest.mocked(requireMicrosoftAuthenticatedPrincipal);
const mockAssertCanManage = jest.mocked(assertCanManageBoardSeats);
const mockAssign = jest.mocked(assignBoardSeat);
const mockRoster = jest.mocked(listBoardRoster);
const mockSeatHolders = jest.mocked(listSeatHolders);
const mockRemove = jest.mocked(removeBoardSeat);
const mockSetPrimary = jest.mocked(setPrimarySeatHolder);
const mockAudit = jest.mocked(writePilotAuditEvent);

function principal(role: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-caller',
    role,
    organizationId: 'org-a',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as never;
}

function request(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(`https://ppbf.example${url}`, init as never);
}

function jsonRequest(method: string, body: Record<string, unknown>): NextRequest {
  return request('/api/pilot/board/seats', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAssertCanManage.mockResolvedValue(undefined);
  mockAudit.mockResolvedValue(undefined);
});

describe('GET /api/pilot/board/seats', () => {
  test('a board member reads their own board roster', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('board'));
    mockRoster.mockResolvedValueOnce([
      { seat: 'treasurer', account_id: 'acct-treasurer', is_primary: true, assigned_at: 'when' },
    ]);

    const response = await GET(request('/api/pilot/board/seats'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      organization_id: 'org-a',
      holders: [{ seat: 'treasurer', account_id: 'acct-treasurer', is_primary: true }],
    });
  });

  test('the organization comes from the session, never from the request', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockRoster.mockResolvedValueOnce([]);

    await GET(request('/api/pilot/board/seats?organization_id=org-b'));

    expect(mockRoster).toHaveBeenCalledWith('org-a');
  });

  test('one seat lists its holders', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('board'));
    mockSeatHolders.mockResolvedValueOnce([]);

    const response = await GET(request('/api/pilot/board/seats?seat=chair'));

    expect(response.status).toBe(200);
    expect(mockSeatHolders).toHaveBeenCalledWith('org-a', 'chair');
    expect(mockRoster).not.toHaveBeenCalled();
  });

  test('a seat no page can open is refused rather than queried', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('board'));

    const response = await GET(request('/api/pilot/board/seats?seat=vice-president'));

    expect(response.status).toBe(400);
    expect(mockSeatHolders).not.toHaveBeenCalled();
  });

  test.each(['coach', 'athlete', 'parent', 'staff', 'volunteer', 'platform_owner'])(
    'refuses %s',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));

      const response = await GET(request('/api/pilot/board/seats'));

      expect(response.status).toBe(403);
      expect(mockRoster).not.toHaveBeenCalled();
    },
  );
});

describe('POST /api/pilot/board/seats', () => {
  test('assigns a seat and records who made the appointment', async () => {
    mockRequireMicrosoft.mockResolvedValueOnce(principal('organization_admin'));
    mockAssign.mockResolvedValueOnce({
      seat: 'treasurer',
      account_id: 'acct-treasurer',
      is_primary: true,
      assigned_at: 'when',
    });

    const response = await POST(jsonRequest('POST', {
      seat: 'treasurer',
      account_id: 'acct-treasurer',
      is_primary: true,
    }));

    expect(response.status).toBe(200);
    expect(mockAssign).toHaveBeenCalledWith({
      organizationId: 'org-a',
      seat: 'treasurer',
      accountId: 'acct-treasurer',
      isPrimary: true,
      assignedByAccountId: 'acct-caller',
    });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      entity_type: 'board_seat',
      entity_id: 'treasurer',
    }));
  });

  test('taking the seat outright is asked for, never assumed', async () => {
    mockRequireMicrosoft.mockResolvedValueOnce(principal('organization_admin'));
    mockAssign.mockResolvedValueOnce({
      seat: 'chair',
      account_id: 'acct-cover',
      is_primary: false,
      assigned_at: 'when',
    });

    await POST(jsonRequest('POST', { seat: 'chair', account_id: 'acct-cover' }));

    expect(mockAssign).toHaveBeenCalledWith(expect.objectContaining({ isPrimary: false }));
  });

  // The rule the board depends on, reported so the caller can act on it: hand
  // the seat over rather than retrying an assignment that cannot succeed.
  test('a seat already held outright answers 409 naming the current holder', async () => {
    mockRequireMicrosoft.mockResolvedValueOnce(principal('organization_admin'));
    mockAssign.mockRejectedValueOnce(new BoardSeatConflictError('treasurer', 'acct-sitting'));

    const response = await POST(jsonRequest('POST', {
      seat: 'treasurer',
      account_id: 'acct-challenger',
      is_primary: true,
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('acct-sitting'),
      seat: 'treasurer',
      current_holder_account_id: 'acct-sitting',
    });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('the President may assign, and a board member who is not may not', async () => {
    mockRequireMicrosoft.mockResolvedValueOnce(principal('board', { accountId: 'acct-president' }));
    mockAssign.mockResolvedValueOnce({
      seat: 'secretary',
      account_id: 'acct-secretary',
      is_primary: true,
      assigned_at: 'when',
    });

    const allowed = await POST(jsonRequest('POST', {
      seat: 'secretary',
      account_id: 'acct-secretary',
      is_primary: true,
    }));
    expect(allowed.status).toBe(200);

    mockRequireMicrosoft.mockResolvedValueOnce(principal('board', { accountId: 'acct-at-large' }));
    mockAssertCanManage.mockRejectedValueOnce(
      new Error('Forbidden: only an organization administrator or the board President may manage board seats'),
    );

    const refused = await POST(jsonRequest('POST', {
      seat: 'secretary',
      account_id: 'acct-someone',
      is_primary: true,
    }));
    expect(refused.status).toBe(403);
    expect(mockAssign).toHaveBeenCalledTimes(1);
  });

  test('a PIN session can never manage the board roster', async () => {
    mockRequireMicrosoft.mockRejectedValueOnce(new Error('Forbidden: Microsoft-authenticated session required'));

    const response = await POST(jsonRequest('POST', { seat: 'chair', account_id: 'acct-board' }));

    expect(response.status).toBe(403);
    expect(mockAssertCanManage).not.toHaveBeenCalled();
    expect(mockAssign).not.toHaveBeenCalled();
  });

  test.each([
    ['an unroutable seat', { seat: 'vice-president', account_id: 'acct-board' }],
    ['a missing seat', { account_id: 'acct-board' }],
    ['a missing account', { seat: 'chair' }],
    ['a blank account', { seat: 'chair', account_id: '   ' }],
  ])('refuses %s before writing anything', async (_label, body) => {
    mockRequireMicrosoft.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(jsonRequest('POST', body));

    expect(response.status).toBe(400);
    expect(mockAssign).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/pilot/board/seats', () => {
  test('hands the seat to the named holder', async () => {
    mockRequireMicrosoft.mockResolvedValueOnce(principal('organization_admin'));
    mockSetPrimary.mockResolvedValueOnce([
      { seat: 'secretary', account_id: 'acct-incoming', is_primary: true, assigned_at: 'when' },
      { seat: 'secretary', account_id: 'acct-outgoing', is_primary: false, assigned_at: 'when' },
    ]);

    const response = await PATCH(jsonRequest('PATCH', {
      seat: 'secretary',
      account_id: 'acct-incoming',
    }));

    expect(response.status).toBe(200);
    expect(mockSetPrimary).toHaveBeenCalledWith({
      organizationId: 'org-a',
      seat: 'secretary',
      accountId: 'acct-incoming',
    });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'update' }));
  });

  test('promoting someone who does not hold the seat is a 404', async () => {
    mockRequireMicrosoft.mockResolvedValueOnce(principal('organization_admin'));
    mockSetPrimary.mockRejectedValueOnce(new Error('Not found: that person does not hold this board seat'));

    const response = await PATCH(jsonRequest('PATCH', { seat: 'chair', account_id: 'acct-stranger' }));

    expect(response.status).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/pilot/board/seats', () => {
  test('ends one appointment', async () => {
    mockRequireMicrosoft.mockResolvedValueOnce(principal('organization_admin'));
    mockRemove.mockResolvedValueOnce({
      seat: 'at-large',
      account_id: 'acct-board',
      is_primary: false,
      assigned_at: 'when',
    });

    const response = await DELETE(request(
      '/api/pilot/board/seats?seat=at-large&account_id=acct-board',
      { method: 'DELETE' },
    ));

    expect(response.status).toBe(200);
    expect(mockRemove).toHaveBeenCalledWith({
      organizationId: 'org-a',
      seat: 'at-large',
      accountId: 'acct-board',
    });
  });

  test('an assignment this organization never recorded is a 404, not a silent success', async () => {
    mockRequireMicrosoft.mockResolvedValueOnce(principal('organization_admin'));
    mockRemove.mockResolvedValueOnce(null);

    const response = await DELETE(request(
      '/api/pilot/board/seats?seat=at-large&account_id=acct-elsewhere',
      { method: 'DELETE' },
    ));

    expect(response.status).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

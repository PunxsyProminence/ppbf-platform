import { NextRequest } from 'next/server';

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { resolvePrincipal, type PilotPrincipal } from '@/src/server/pilot/auth';
import {
  getRabbitHole,
  setRabbitHoleStatus,
  updateRabbitHole,
  type AuthoredRabbitHole,
} from '@/src/server/pilot/rabbitHoles';

import { POST } from './route';

jest.mock('@/src/server/pilot/auth', () => ({
  resolvePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

// The reads and writes are stubbed; the authorship rule between them is the
// real one.
jest.mock('@/src/server/pilot/rabbitHoles', () => ({
  ...jest.requireActual('@/src/server/pilot/rabbitHoles'),
  getRabbitHole: jest.fn(),
  updateRabbitHole: jest.fn(),
  setRabbitHoleStatus: jest.fn(),
}));

const mockResolvePrincipal = resolvePrincipal as jest.MockedFunction<typeof resolvePrincipal>;
const mockGet = getRabbitHole as jest.MockedFunction<typeof getRabbitHole>;
const mockUpdate = updateRabbitHole as jest.MockedFunction<typeof updateRabbitHole>;
const mockSetStatus = setRabbitHoleStatus as jest.MockedFunction<typeof setRabbitHoleStatus>;
const mockAudit = writePilotAuditEvent as jest.MockedFunction<typeof writePilotAuditEvent>;

function lesson(overrides: Partial<AuthoredRabbitHole> = {}): AuthoredRabbitHole {
  return {
    rabbit_hole_id: 'rh-1',
    anchor_type: 'gap_type',
    anchor_key: 'technique',
    audience: 'athlete',
    title: 'Kinetic force transfer',
    concept: 'Power does not generate in the shoulders.',
    homework: 'Thirty slow crosses, three seconds at full extension.',
    author_display_name: 'Coach Jason',
    citation: null,
    created_at: '2026-07-30T12:00:00.000Z',
    updated_at: '2026-07-30T12:00:00.000Z',
    status: 'published',
    author_account_id: 'acct-coach',
    library_document_id: null,
    ...overrides,
  };
}

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-coach',
    role: 'coach',
    organizationId: 'org-a',
    athleteId: null,
    sessionToken: 'token-1',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/rabbit-holes/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue(lesson());
  mockUpdate.mockResolvedValue(lesson({ title: 'Renamed' }));
  mockSetStatus.mockResolvedValue(lesson({ status: 'retired' }));
});

describe('POST /api/pilot/rabbit-holes/update', () => {
  test('refuses an unauthenticated caller and a PIN session', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(null);
    expect((await POST(request({ rabbit_hole_id: 'rh-1', title: 'Renamed' }))).status).toBe(401);

    mockResolvePrincipal.mockResolvedValueOnce(principal({ authProvider: 'ppbf_local' }));
    expect((await POST(request({ rabbit_hole_id: 'rh-1', title: 'Renamed' }))).status).toBe(403);

    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // The lookup is organization-scoped, so another gym's lesson is simply not
  // there -- and it returns the same 404 a lesson that never existed returns,
  // so the two are indistinguishable to the caller.
  test('a lesson in another gym is not found rather than forbidden', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    mockGet.mockResolvedValueOnce(null);

    const response = await POST(request({ rabbit_hole_id: 'rh-elsewhere', title: 'Renamed' }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('a coach may not rewrite another coach lesson', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());
    mockGet.mockResolvedValueOnce(lesson({ author_account_id: 'acct-other-coach' }));

    const response = await POST(request({ rabbit_hole_id: 'rh-1', title: 'Renamed' }));

    expect(response.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('a coach edits their own lesson, and the change is audited', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(request({ rabbit_hole_id: 'rh-1', title: 'Renamed' }));

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-a', rabbitHoleId: 'rh-1', title: 'Renamed' }),
    );
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'update', entity_type: 'rabbit_hole', entity_id: 'rh-1' }),
    );
  });

  // Retiring is how a lesson leaves the surface. Nothing is deleted.
  test('retiring sets the status and never deletes', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(request({ rabbit_hole_id: 'rh-1', status: 'retired' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.rabbit_hole.status).toBe('retired');
    expect(payload.rabbit_hole.homework).toBe('Thirty slow crosses, three seconds at full extension.');
    expect(mockSetStatus).toHaveBeenCalledWith({
      organizationId: 'org-a',
      rabbitHoleId: 'rh-1',
      status: 'retired',
    });
  });

  // An administrator can still take a lesson down after the author account is
  // gone -- author_account_id clears, and the lesson outlives it.
  test('an administrator may retire a lesson whose author account has been removed', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal({ accountId: 'acct-admin', role: 'organization_admin' }));
    mockGet.mockResolvedValueOnce(lesson({ author_account_id: null }));

    const response = await POST(request({ rabbit_hole_id: 'rh-1', status: 'retired' }));

    expect(response.status).toBe(200);
  });

  test('a request that changes nothing is refused rather than audited as a change', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(request({ rabbit_hole_id: 'rh-1' }));

    expect(response.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockSetStatus).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a missing rabbit_hole_id is refused before anything is read', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(request({ title: 'Renamed' }));

    expect(response.status).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });
});

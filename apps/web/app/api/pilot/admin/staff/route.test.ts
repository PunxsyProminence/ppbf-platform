import { NextRequest } from 'next/server';

import { DELETE, GET, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  createOrUpdateMicrosoftStaffAccount,
  listOrganizationGuardianLinks,
  listOrganizationMembers,
  removeGuardianLink,
} from '@/src/server/pilot/staffProvisioning';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

// requireGuardianLinkForParentInvite and the role vocabulary stay real: the
// refusal of an unlinked parent invite is the behaviour under test, and a
// stubbed guard would let the route pass this suite while shipping the silent
// failure it exists to stop.
jest.mock('@/src/server/pilot/staffProvisioning', () => ({
  ...jest.requireActual('@/src/server/pilot/staffProvisioning'),
  createOrUpdateMicrosoftStaffAccount: jest.fn(),
  listOrganizationMembers: jest.fn(),
  listOrganizationGuardianLinks: jest.fn(),
  removeGuardianLink: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => ({
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

const mockRequireMicrosoft = jest.mocked(requireMicrosoftAuthenticatedPrincipal);
const mockProvision = jest.mocked(createOrUpdateMicrosoftStaffAccount);
const mockListMembers = jest.mocked(listOrganizationMembers);
const mockListGuardianLinks = jest.mocked(listOrganizationGuardianLinks);
const mockRemoveLink = jest.mocked(removeGuardianLink);
const mockAudit = jest.mocked(writePilotAuditEvent);

function principal(role = 'organization_admin') {
  return {
    accountId: 'admin-1',
    role,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as never;
}

function jsonRequest(method: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://ppbf.example/api/pilot/admin/staff', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  } as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireMicrosoft.mockResolvedValue(principal());
  mockListMembers.mockResolvedValue([]);
  mockListGuardianLinks.mockResolvedValue([]);
});

describe('GET', () => {
  test('returns guardian links alongside the members', async () => {
    mockListGuardianLinks.mockResolvedValue([
      {
        account_id: 'dana@example.com',
        parent_id: 'par-dana@example.com',
        athlete_id: 'ath-1',
        athlete_full_name: 'Alex Johnson',
        relationship_to_athlete: 'mother',
      },
    ]);

    const response = await GET(new NextRequest('https://ppbf.example/api/pilot/admin/staff'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.guardian_links).toHaveLength(1);
    // Both reads are scoped to the session's organization, never a parameter.
    expect(mockListGuardianLinks).toHaveBeenCalledWith('org-1');
    expect(mockListMembers).toHaveBeenCalledWith('org-1');
  });

  test('refuses a caller who is not an organization admin', async () => {
    mockRequireMicrosoft.mockResolvedValue(principal('coach'));

    const response = await GET(new NextRequest('https://ppbf.example/api/pilot/admin/staff'));

    expect(response.status).toBe(403);
    expect(mockListGuardianLinks).not.toHaveBeenCalled();
  });
});

describe('POST', () => {
  test('refuses a parent invite that names no athlete, and provisions nothing', async () => {
    const response = await POST(
      jsonRequest('POST', { login_email: 'dana@example.com', role: 'parent' }),
    );
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/Missing guardian link/);
    expect(mockProvision).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('passes the chosen athlete through so the link is written with the account', async () => {
    mockProvision.mockResolvedValue({
      accountId: 'dana@example.com',
      organizationId: 'org-1',
      role: 'parent',
      loginEmail: 'dana@example.com',
      created: true,
      guardianLink: { parentId: 'par-dana@example.com', athleteId: 'ath-1' },
    });

    const response = await POST(
      jsonRequest('POST', {
        login_email: 'dana@example.com',
        role: 'parent',
        guardian: { athlete_id: 'ath-1', full_name: 'Dana Johnson', relationship_to_athlete: 'mother' },
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockProvision).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'parent',
        organizationId: 'org-1',
        guardian: { athleteId: 'ath-1', fullName: 'Dana Johnson', relationshipToAthlete: 'mother' },
      }),
    );
    expect(payload.guardian_link).toEqual({ parent_id: 'par-dana@example.com', athlete_id: 'ath-1' });
    // Which adult was given access to which minor is the part of this write a
    // safeguarding review has to be able to reconstruct.
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ guardian_athlete_id: 'ath-1' }),
      }),
    );
  });

  test('refuses a guardian link attached to a non-parent role', async () => {
    const response = await POST(
      jsonRequest('POST', {
        login_email: 'coach@example.com',
        role: 'coach',
        guardian: { athlete_id: 'ath-1', full_name: 'Dana Johnson', relationship_to_athlete: 'mother' },
      }),
    );

    expect(response.status).toBe(403);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  test('an organization admin still cannot invite another organization admin', async () => {
    const response = await POST(
      jsonRequest('POST', { login_email: 'peer@example.com', role: 'organization_admin' }),
    );

    expect(response.status).toBe(400);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  test('a coach invite carries no guardian and still succeeds', async () => {
    mockProvision.mockResolvedValue({
      accountId: 'coach@example.com',
      organizationId: 'org-1',
      role: 'coach',
      loginEmail: 'coach@example.com',
      created: true,
      guardianLink: null,
    });

    const response = await POST(jsonRequest('POST', { login_email: 'coach@example.com', role: 'coach' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.guardian_link).toBeNull();
    expect(mockProvision).toHaveBeenCalledWith(expect.objectContaining({ guardian: undefined }));
  });

  test('a volunteer invite surfaces the roster link the provisioning module wrote', async () => {
    mockProvision.mockResolvedValue({
      accountId: 'val@example.com',
      organizationId: 'org-1',
      role: 'volunteer',
      loginEmail: 'val@example.com',
      created: true,
      guardianLink: null,
      volunteerLink: { volunteerId: 'vol-1', created: true },
    });

    const response = await POST(jsonRequest('POST', { login_email: 'val@example.com', role: 'volunteer' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.volunteer_id).toBe('vol-1');
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ volunteer_id: 'vol-1' }),
      }),
    );
  });
});

describe('DELETE', () => {
  test('removes a guardian link within the caller\'s own organization', async () => {
    mockRemoveLink.mockResolvedValue({ parentId: 'par-1', athleteId: 'ath-2' });

    const response = await DELETE(
      jsonRequest('DELETE', { account_id: 'dana@example.com', athlete_id: 'ath-2' }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.athlete_id).toBe('ath-2');
    expect(mockRemoveLink).toHaveBeenCalledWith({
      organizationId: 'org-1',
      accountId: 'dana@example.com',
      athleteId: 'ath-2',
    });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ action: 'organization_admin_remove_guardian_link' }),
      }),
    );
  });

  test('surfaces the refusal to strand a guardian rather than reporting success', async () => {
    mockRemoveLink.mockRejectedValue(
      new Error('Forbidden: this is the only athlete this guardian is linked to'),
    );

    const response = await DELETE(
      jsonRequest('DELETE', { account_id: 'dana@example.com', athlete_id: 'ath-1' }),
    );
    const payload = await response.json();

    expect(response.status).toBe(403);
    expect(payload.error).toMatch(/only athlete this guardian is linked to/);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('refuses a caller who is not an organization admin', async () => {
    mockRequireMicrosoft.mockResolvedValue(principal('coach'));

    const response = await DELETE(
      jsonRequest('DELETE', { account_id: 'dana@example.com', athlete_id: 'ath-2' }),
    );

    expect(response.status).toBe(403);
    expect(mockRemoveLink).not.toHaveBeenCalled();
  });

  test('requires both identifiers', async () => {
    const response = await DELETE(jsonRequest('DELETE', { account_id: 'dana@example.com' }));

    expect(response.status).toBe(400);
    expect(mockRemoveLink).not.toHaveBeenCalled();
  });
});

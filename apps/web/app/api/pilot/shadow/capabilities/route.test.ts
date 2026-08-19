import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/**
 * WHAT A DENIED ROLE IS SENT.
 *
 * This route had requirePrincipal and no role gate, so it answered any session
 * that existed. The SHADOW chat page fetched it before knowing whether the
 * signed-in role may use SHADOW at all, which meant a board member -- a role
 * the chat, sessions, jobs and feedback routes all refuse by name, and whose
 * room DNA lists "Ask SHADOW chat" first under FORBIDDEN -- got a 200 carrying
 * crossOrganizationRead, canAccessProtectedHealthInformation,
 * canReviewChatSafetyTelemetry, canExportConversationHistory and the tier in
 * `mode`.
 *
 * None of it was ever rendered. All of it was sent, which is why no screenshot
 * could have caught this and why the assertion below is about the BODY rather
 * than about the status code.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;

function principal(role: PilotPrincipal['role']): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function request() {
  return new NextRequest('http://localhost/api/pilot/shadow/capabilities');
}

/** Every name the payload would disclose. None may appear in a refusal. */
const CAPABILITY_NAMES = [
  'mode',
  'crossOrganizationRead',
  'canAccessProtectedHealthInformation',
  'canReviewChatSafetyTelemetry',
  'canExportConversationHistory',
  'allowedSessionTypes',
  'canUseManualTier',
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/shadow/capabilities', () => {
  test('refuses an unauthenticated caller', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    expect((await GET(request())).status).toBe(401);
  });

  test('refuses a board member, the role SHADOW chat refuses everywhere else', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('board'));

    const response = await GET(request());

    expect(response.status).toBe(403);
  });

  test('tells a refused role none of the capability names', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('board'));

    const body = JSON.stringify(await (await GET(request())).json());

    for (const name of CAPABILITY_NAMES) {
      expect(body).not.toContain(name);
    }
    expect(body).not.toContain('capabilities');
  });

  test.each(['coach', 'athlete', 'parent', 'staff', 'volunteer'] as const)(
    'still answers %s, who may use SHADOW chat',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));

      const response = await GET(request());
      const payload = await response.json() as {
        success: boolean;
        capabilities: { mode: string; allowedSessionTypes: string[] };
      };

      expect(response.status).toBe(200);
      expect(payload.success).toBe(true);
      expect(payload.capabilities.mode).toBe('scoped');
      expect(payload.capabilities.allowedSessionTypes).toContain('quick_round');
    },
  );

  test('still answers an organization admin with its own tier', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const payload = await (await GET(request())).json() as {
      capabilities: { mode: string };
    };

    expect(payload.capabilities.mode).toBe('master');
  });

  test('still answers Omega with its own tier', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const payload = await (await GET(request())).json() as {
      capabilities: { mode: string; crossOrganizationRead: boolean };
    };

    expect(payload.capabilities.mode).toBe('omega');
    expect(payload.capabilities.crossOrganizationRead).toBe(true);
  });

  // 'admin' is the legacy spelling of organization_admin (roleEquals in
  // access.ts). A gate that listed only one of the pair would lock out live
  // rows of the other.
  test('answers the legacy admin spelling as well as organization_admin', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('admin'));

    expect((await GET(request())).status).toBe(200);
  });
});

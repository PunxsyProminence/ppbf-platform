import { NextRequest } from 'next/server';

import { POST } from './route';
import { query } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { buildPersonalShadowPrompt } from '@/src/server/pilot/shadowPersonalization';
import { updateShadowUserProfile } from '@/src/server/pilot/shadowUserProfile';
import { getAzureAiRuntimeConfig, buildAzureAiChatCompletionsUrl } from '@/src/server/pilot/azureAiRuntime';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
}));

jest.mock('@/src/server/pilot/shadowPersonalization', () => ({
  buildPersonalShadowPrompt: jest.fn(),
}));

jest.mock('@/src/server/pilot/shadowUserProfile', () => ({
  updateShadowUserProfile: jest.fn(),
}));

jest.mock('@/src/server/pilot/azureAiRuntime', () => ({
  getAzureAiRuntimeConfig: jest.fn(),
  buildAzureAiChatCompletionsUrl: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockBuildPrompt = buildPersonalShadowPrompt as jest.Mock;
const mockUpdateProfile = updateShadowUserProfile as jest.Mock;
const mockGetRuntimeConfig = getAzureAiRuntimeConfig as jest.Mock;
const mockBuildUrl = buildAzureAiChatCompletionsUrl as jest.Mock;

const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  mockBuildPrompt.mockResolvedValue({ systemPrompt: 'system', userContext: '' });
  mockQuery.mockResolvedValue([]);
  mockUpdateProfile.mockResolvedValue(undefined);
  mockGetRuntimeConfig.mockReturnValue({
    ok: true,
    missing: [],
    config: { endpoint: 'https://example.invalid', apiKey: 'test-key', deploymentName: 'test-deployment', apiVersion: '2024-12-01-preview' },
  });
  mockBuildUrl.mockReturnValue('https://example.invalid/openai/deployments/test-deployment/chat/completions');
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'hi' } }] }),
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'athlete',
    organizationId: 'org-real',
    athleteId: 'ath-1',
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/athlete/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/pilot/athlete/chat', () => {
  test('ignores a client-supplied organizationId and always uses the principal\'s organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ organizationId: 'org-real' }));

    const res = await POST(
      postRequest({ message: 'hello', organizationId: 'org-attacker' }),
    );

    expect(res.status).toBe(200);

    // SHADOW prompt building must use the principal's real org, never the body's.
    expect(mockBuildPrompt).toHaveBeenCalledWith('acct-1', 'org-real', 'athlete', 'hello');

    // The audit insert's organization_id column must be the principal's org.
    const auditCallArgs = mockQuery.mock.calls[0][1];
    expect(auditCallArgs[0]).toBe('org-real');
    expect(auditCallArgs).not.toContain('org-attacker');

    // The SHADOW profile update must target the principal's real org.
    expect(mockUpdateProfile).toHaveBeenCalledWith('acct-1', 'org-real', expect.anything());
  });

  test('request body no longer accepts an organizationId field', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ organizationId: 'org-real' }));

    // Even with no organizationId in the body at all, behavior is identical --
    // proving the field is inert rather than merely defaulted.
    const res = await POST(postRequest({ message: 'hello' }));

    expect(res.status).toBe(200);
    expect(mockBuildPrompt).toHaveBeenCalledWith('acct-1', 'org-real', 'athlete', 'hello');
  });
});

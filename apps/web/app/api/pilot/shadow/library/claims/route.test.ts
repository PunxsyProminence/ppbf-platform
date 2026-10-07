import { NextRequest } from 'next/server';

import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { requirePrincipal } from '@/src/server/pilot/http';
import { createShadowLibraryClaim } from '@/src/server/pilot/shadowLibrary';
import { enforceShadowRateLimit, ShadowRateLimitExceeded } from '@/src/server/pilot/shadowRateLimit';
import { POST } from './route';

// The cap the route enforces (overwatch proposal 2026-10-06). Route files may
// only export handlers, so it is restated here rather than imported.
const LIBRARY_CLAIM_QUESTION_MAX_CHARS = 2_000;

/**
 * Audit CL-C15. Every role may ask the Library a question, and each question
 * the Library cannot answer opens a research requirement. With no length cap
 * and no rate limit, one account could mint an unbounded number of open
 * requirements by varying the text -- each one a row every later claim and
 * the research-bridge export had to read.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/shadowLibrary', () => ({
  createShadowLibraryClaim: jest.fn(),
}));

jest.mock('@/src/server/pilot/shadowRateLimit', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowRateLimit');
  return { ...actual, enforceShadowRateLimit: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockClaim = createShadowLibraryClaim as jest.MockedFunction<typeof createShadowLibraryClaim>;
const mockEnforce = enforceShadowRateLimit as jest.MockedFunction<typeof enforceShadowRateLimit>;

function principal(): PilotPrincipal {
  return {
    accountId: 'athlete-acct',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function postRaw(body: string) {
  return new NextRequest('http://localhost/api/pilot/shadow/library/claims', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

const post = (body: Record<string, unknown>) => postRaw(JSON.stringify(body));

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockEnforce.mockResolvedValue(undefined as never);
  mockClaim.mockResolvedValue({ status: 'unsupported' } as never);
});

describe('library claims caps (CL-C15)', () => {
  test('a question over the cap is a 400 naming the limit, and opens nothing', async () => {
    const response = await POST(post({ question: 'a'.repeat(LIBRARY_CLAIM_QUESTION_MAX_CHARS + 1) }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('2,000 characters');
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockEnforce).not.toHaveBeenCalled();
  });

  test('a question exactly at the cap is answered', async () => {
    const response = await POST(post({ question: 'a'.repeat(LIBRARY_CLAIM_QUESTION_MAX_CHARS) }));

    expect(response.status).toBe(200);
    expect(mockClaim).toHaveBeenCalledTimes(1);
  });

  test('each claim is charged to the per-account library_claim bucket', async () => {
    await POST(post({ question: 'How long should a jab drill run?' }));

    expect(mockEnforce).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      accountId: 'athlete-acct',
      endpointKey: 'library_claim',
      limit: 120,
      windowSeconds: 3_600,
    }));
  });

  test('over the rate limit is a 429 with Retry-After, and opens nothing', async () => {
    mockEnforce.mockRejectedValueOnce(new ShadowRateLimitExceeded(1_200, 'library_claim'));

    const response = await POST(post({ question: 'How long should a jab drill run?' }));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('1200');
    expect((await response.json()).error).toMatch(/Library/);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  test('an invalid body is refused before the rate limit is charged', async () => {
    const response = await POST(postRaw('{not json'));

    expect(response.status).toBe(400);
    expect(mockEnforce).not.toHaveBeenCalled();
  });
});

import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import {
  createShadowLibrarySource,
  listShadowLibrarySources,
  updateShadowLibrarySourceClassification,
} from '@/src/server/pilot/shadowLibrary';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/shadowLibrary', () => ({
  createShadowLibrarySource: jest.fn(),
  listShadowLibrarySources: jest.fn(),
  updateShadowLibrarySourceClassification: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockCreate = createShadowLibrarySource as jest.MockedFunction<typeof createShadowLibrarySource>;
const mockList = listShadowLibrarySources as jest.MockedFunction<typeof listShadowLibrarySources>;
const mockReclassify = updateShadowLibrarySourceClassification as jest.MockedFunction<typeof updateShadowLibrarySourceClassification>;

function principal(role: PilotPrincipal['role'] = 'organization_admin'): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-real',
    athleteId: role === 'athlete' ? 'ath-1' : null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/shadow/library/sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getRequest(search = '') {
  return new NextRequest(`http://localhost/api/pilot/shadow/library/sources${search}`, { method: 'GET' });
}

const validBody = {
  title: 'SHADOW Canonical Authority Model',
  publisher: 'Punxsy Prominence',
  source_type: 'internal_policy',
  authority_tier: 1,
  status: 'active',
  publication_date: '2026-07-15',
  metadata: { canonical: true },
};

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks keeps a mockResolvedValue; reset it so no test inherits a
  // principal from the one before.
  mockRequirePrincipal.mockReset();
  mockCreate.mockResolvedValue({ source_id: 'source_1' } as never);
  mockList.mockResolvedValue([]);
});

describe('POST /api/pilot/shadow/library/sources', () => {
  test('rejects an unauthenticated caller', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(401);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test.each(['coach', 'athlete', 'parent', 'board', 'volunteer', 'staff'] as const)(
    'refuses %s, which may read the Library but not curate it',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));

      const response = await POST(postRequest(validBody));

      expect(response.status).toBe(403);
      expect(mockCreate).not.toHaveBeenCalled();
    },
  );

  test.each(['organization_admin', 'admin'] as const)(
    'admits %s',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));

      const response = await POST(postRequest(validBody));

      expect(response.status).toBe(201);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    },
  );

  // OD-2026-10-02-015 D3: platform material on the platform shelf, gym
  // material on the gym shelf. The platform owner no longer writes a gym's.
  test('refuses platform_owner on the gym shelf, with or without naming it', async () => {
    for (const body of [validBody, { ...validBody, shelf: 'gym' }]) {
      mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));
      const response = await POST(postRequest(body));
      expect(response.status).toBe(403);
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('returns the source under the key the seed script reads', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockCreate.mockResolvedValueOnce({ source_id: 'source_abc' } as never);

    const response = await POST(postRequest(validBody));
    const payload = await response.json();

    // seed-shadow-library.mjs does `payload.source.source_id` and passes it
    // straight to the documents route, so this shape is a contract.
    expect(payload.source.source_id).toBe('source_abc');
  });

  test('takes the organization from the session, never from the body', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    await POST(postRequest({ ...validBody, organization_id: 'org-attacker' }));

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-real' }),
    );
  });

  test('does not pre-approve its own write', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    await POST(postRequest({ ...validBody, approval_state: 'approved', verification_state: 'verified' }));

    // Approval belongs to PATCH /shadow/evidence/review. If this route could
    // carry it, any curator could make a source citable without review.
    const call = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('approvalState');
    expect(call).not.toHaveProperty('verificationState');
  });

  test.each([
    ['an unknown source_type', { source_type: 'blog_post' }],
    ['a missing title', { title: '   ' }],
    ['an out-of-range authority_tier', { authority_tier: 9 }],
    ['a non-integer authority_tier', { authority_tier: 1.5 }],
    ['a malformed publication_date', { publication_date: 'July 15 2026' }],
    ['an unknown status', { status: 'live' }],
    ['array metadata', { metadata: ['canonical'] }],
  ])('rejects %s', async (_label, override) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(postRequest({ ...validBody, ...override }));

    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('reports a repeated url as a conflict rather than a server fault', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockCreate.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "shadow_library_sources_organization_id_url_key"'),
    );

    const response = await POST(postRequest({ ...validBody, url: 'https://example.org/a' }));

    expect(response.status).toBe(409);
  });
});

describe('GET /api/pilot/shadow/library/sources', () => {
  test('returns items under the key the seed script reads', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockList.mockResolvedValueOnce([{ source_id: 'source_1' }] as never);

    const response = await GET(getRequest('?source_type=internal_policy&status=active&limit=200'));
    const payload = await response.json();

    // findCanonicalSource reads `response.items` and treats a non-array as
    // empty, which would silently re-register the doctrine source on every run.
    expect(Array.isArray(payload.items)).toBe(true);
    expect(payload.items[0].source_id).toBe('source_1');
  });

  test('passes the seed script filters through', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    await GET(getRequest('?source_type=internal_policy&status=active&limit=200'));

    expect(mockList).toHaveBeenCalledWith({
      organizationId: 'org-real',
      sourceType: 'internal_policy',
      status: 'active',
      limit: 200,
      offset: 0,
    });
  });

  test.each([
    ['a limit above the cap', '?limit=201'],
    ['a zero limit', '?limit=0'],
    ['a non-numeric limit', '?limit=all'],
    ['a negative offset', '?offset=-1'],
    ['an unknown source_type', '?source_type=blog_post'],
  ])('rejects %s', async (_label, search) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await GET(getRequest(search));

    expect(response.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('scopes the listing to the session organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    await GET(getRequest('?organization_id=org-attacker'));

    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-real' }),
    );
  });
});

// Classification correction (issue #345 workflow 3): curator-gated, taxonomy-
// validated, and narrower than every other write on this route.
describe('PATCH /api/pilot/shadow/library/sources', () => {
  function patchRequest(body: Record<string, unknown>) {
    return new NextRequest('http://localhost/api/pilot/shadow/library/sources', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('a coach cannot reclassify', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));

    const response = await PATCH(patchRequest({ source_id: 'src-1', classification_domain: 'ai_ml_data_science' }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockReclassify).not.toHaveBeenCalled();
  });

  test('a label outside the shared taxonomy is refused', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await PATCH(patchRequest({ source_id: 'src-1', classification_domain: 'astrology' }));

    expect(response.status).toBe(400);
    expect(mockReclassify).not.toHaveBeenCalled();
  });

  test('a valid correction is org-scoped, and a missing source hides as not-found', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockReclassify.mockResolvedValueOnce({ source_id: 'src-1' } as never);

    const ok = await PATCH(patchRequest({ source_id: 'src-1', classification_domain: 'youth_development_safeguarding' }));
    expect(ok.status).toBe(200);
    expect(mockReclassify).toHaveBeenCalledWith('org-real', 'src-1', 'youth_development_safeguarding');

    mockReclassify.mockResolvedValueOnce(null);
    const missing = await PATCH(patchRequest({ source_id: 'src-x', classification_domain: 'youth_development_safeguarding' }));
    expect(missing.status).toBe(404);
  });
});

// RINT-05a. OD-2026-10-02-013 answer 1B: the platform owner writes the
// platform shelf in the app. The shelf is a name in the request, resolved to an
// organization id on the server; no organization id is read from the request.
describe('the platform shelf on /api/pilot/shadow/library/sources', () => {
  const NON_OWNERS = ['organization_admin', 'admin', 'coach', 'athlete', 'parent', 'board', 'volunteer', 'staff'] as const;

  function patchRequest(body: Record<string, unknown>) {
    return new NextRequest('http://localhost/api/pilot/shadow/library/sources', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('platform_owner registers on the platform shelf, not its own organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await POST(postRequest({ ...validBody, shelf: 'platform', organization_id: 'org-attacker' }));

    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ organizationId: '__platform__' }));
  });

  test.each(NON_OWNERS)('%s gets 403 for shelf: platform on every method', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));

    const post = await POST(postRequest({ ...validBody, shelf: 'platform' }));
    const get = await GET(getRequest('?shelf=platform'));
    const patch = await PATCH(patchRequest({ source_id: 'src-1', classification_domain: 'ai_ml_data_science', shelf: 'platform' }));

    expect([post.status, get.status, patch.status]).toEqual([403, 403, 403]);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
    expect(mockReclassify).not.toHaveBeenCalled();
  });

  test('platform_owner lists and reclassifies on the platform shelf', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('platform_owner'));
    mockReclassify.mockResolvedValueOnce({ source_id: 'src-1' } as never);

    expect((await GET(getRequest('?shelf=platform&organization_id=org-attacker'))).status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ organizationId: '__platform__' }));

    const patch = await PATCH(patchRequest({ source_id: 'src-1', classification_domain: 'ai_ml_data_science', shelf: 'platform' }));
    expect(patch.status).toBe(200);
    expect(mockReclassify).toHaveBeenCalledWith('__platform__', 'src-1', 'ai_ml_data_science');
  });

  // D3 bars the platform owner's gym-shelf WRITES only; reading a gym's
  // Library is unchanged.
  test('platform_owner still reads its gym shelf when no shelf is named', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    expect((await GET(getRequest())).status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-real' }));
  });

  test('platform_owner cannot reclassify a gym-shelf source', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await PATCH(patchRequest({ source_id: 'src-1', classification_domain: 'ai_ml_data_science' }));

    expect(response.status).toBe(403);
    expect(mockReclassify).not.toHaveBeenCalled();
  });

  test.each([['an organization id', 'org-real'], ['the reserved id', '__platform__'], ['a number', 1]])(
    'refuses %s as a shelf',
    async (_label, shelf) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

      const response = await POST(postRequest({ ...validBody, shelf }));

      expect(response.status).toBe(400);
      expect(mockCreate).not.toHaveBeenCalled();
    },
  );

  test('a gym admin naming the gym shelf is the same as naming none', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(postRequest({ ...validBody, shelf: 'gym' }));

    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-real' }));
  });
});

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

  test.each(['coach', 'athlete', 'parent', 'volunteer', 'staff'] as const)(
    'refuses %s, which may read the Library but not curate it',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));

      const response = await POST(postRequest(validBody));

      expect(response.status).toBe(403);
      expect(mockCreate).not.toHaveBeenCalled();
    },
  );

  test.each(['organization_admin', 'admin', 'platform_owner'] as const)(
    'admits %s',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));

      const response = await POST(postRequest(validBody));

      expect(response.status).toBe(201);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    },
  );

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

  test('a layer outside the shared taxonomy is refused', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await PATCH(patchRequest({ source_id: 'src-1', classification_layer: 'astrology' }));

    expect(response.status).toBe(400);
    expect(mockReclassify).not.toHaveBeenCalled();
  });

  test('neither domain nor layer is refused', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await PATCH(patchRequest({ source_id: 'src-1' }));

    expect(response.status).toBe(400);
    expect(mockReclassify).not.toHaveBeenCalled();
  });

  test('a valid correction is org-scoped, and a missing source hides as not-found', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockReclassify.mockResolvedValueOnce({ source_id: 'src-1' } as never);

    const ok = await PATCH(patchRequest({ source_id: 'src-1', classification_domain: 'youth_development_safeguarding' }));
    expect(ok.status).toBe(200);
    expect(mockReclassify).toHaveBeenCalledWith('org-real', 'src-1', {
      domain: 'youth_development_safeguarding',
      layer: undefined,
    });

    mockReclassify.mockResolvedValueOnce(null);
    const missing = await PATCH(patchRequest({ source_id: 'src-x', classification_domain: 'youth_development_safeguarding' }));
    expect(missing.status).toBe(404);
  });

  test('domain and layer can be corrected independently or together', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockReclassify.mockResolvedValueOnce({ source_id: 'src-1' } as never);

    const layerOnly = await PATCH(patchRequest({ source_id: 'src-1', classification_layer: 'evidence' }));
    expect(layerOnly.status).toBe(200);
    expect(mockReclassify).toHaveBeenCalledWith('org-real', 'src-1', { domain: undefined, layer: 'evidence' });

    mockReclassify.mockResolvedValueOnce({ source_id: 'src-1' } as never);
    const both = await PATCH(patchRequest({
      source_id: 'src-1',
      classification_domain: 'youth_development_safeguarding',
      classification_layer: 'doctrine',
    }));
    expect(both.status).toBe(200);
    expect(mockReclassify).toHaveBeenCalledWith('org-real', 'src-1', {
      domain: 'youth_development_safeguarding',
      layer: 'doctrine',
    });
  });
});

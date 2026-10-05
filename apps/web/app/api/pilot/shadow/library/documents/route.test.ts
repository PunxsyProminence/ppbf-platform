import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { createShadowLibraryDocument } from '@/src/server/pilot/shadowLibrary';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/shadowLibrary', () => ({
  createShadowLibraryDocument: jest.fn(),
}));

// requireRole stays real so the role sets are exercised; only the per-athlete
// check is mocked, because its real implementation reaches the database for
// coach and organization-admin actors.
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockCreate = createShadowLibraryDocument as jest.MockedFunction<typeof createShadowLibraryDocument>;
const mockAssertAthlete = assertActorCanAccessAthlete as jest.MockedFunction<typeof assertActorCanAccessAthlete>;

function principal(role: PilotPrincipal['role'] = 'organization_admin'): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-real',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/shadow/library/documents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const sha = 'a'.repeat(64);
const validBody = {
  source_id: 'source_1',
  document_name: 'SHADOW Canonical Authority Model',
  content_sha256: sha,
  ingest_state: 'chunking',
  metadata: { canonical: true },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue({ document_id: 'doc_1' } as never);
  mockAssertAthlete.mockResolvedValue(undefined);
});

describe('POST /api/pilot/shadow/library/documents', () => {
  test('rejects an unauthenticated caller', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(401);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test.each(['coach', 'athlete', 'parent'] as const)('refuses %s', async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal(role));

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('returns the document under the key the seed script reads', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockCreate.mockResolvedValueOnce({ document_id: 'doc_abc' } as never);

    const response = await POST(postRequest(validBody));
    const payload = await response.json();

    // seed-shadow-library.mjs does `payload.document.document_id` and feeds it
    // to every chunk it then registers.
    expect(payload.document.document_id).toBe('doc_abc');
  });

  test('takes the organization from the session, never from the body', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    await POST(postRequest({ ...validBody, organization_id: 'org-attacker' }));

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-real' }),
    );
  });

  describe('subject-scoped documents', () => {
    test('runs the per-athlete check when subject_id is supplied', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());

      await POST(postRequest({ ...validBody, subject_id: 'ath-9' }));

      expect(mockAssertAthlete).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-real' }),
        'ath-9',
      );
    });

    test('skips the per-athlete check for organization doctrine', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());

      await POST(postRequest(validBody));

      expect(mockAssertAthlete).not.toHaveBeenCalled();
    });

    test('refuses platform_owner athlete-scoped evidence on the gym shelf', async () => {
      // Omega is broader in breadth and strictly narrower in depth: it must
      // never reach a named athlete's record. Since OD-2026-10-02-015 D3 it
      // does not write a gym's shelf at all, so the refusal now comes from the
      // shelf resolver, before the per-athlete check is ever reached. (On the
      // platform shelf, an athlete-scoped document is a 400; see below.)
      mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

      const response = await POST(postRequest({ ...validBody, subject_id: 'ath-9' }));

      expect(response.status).toBe(403);
      expect(mockAssertAthlete).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    // OD-2026-10-02-015 D3: the platform owner no longer writes a gym's
    // shelf, doctrine included. Its shelf is the platform one (tests below).
    test('refuses platform_owner on the gym shelf even for doctrine with no subject', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

      const response = await POST(postRequest(validBody));

      expect(response.status).toBe(403);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test('treats a blank subject_id as absent rather than as a subject', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());

      await POST(postRequest({ ...validBody, subject_id: '   ' }));

      expect(mockAssertAthlete).not.toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ subjectId: null }));
    });
  });

  test('refuses a document that arrives claiming to be indexed', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(postRequest({ ...validBody, ingest_state: 'indexed' }));

    // searchShadowLibrary keys on ingest_state='indexed'. Accepting it here
    // would let a caller make a document retrievable without ever passing
    // evidence review.
    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test.each([
    ['a missing source_id', { source_id: '' }],
    ['a missing document_name', { document_name: '  ' }],
    ['an unknown ingest_state', { ingest_state: 'transcribing' }],
    ['a malformed content_sha256', { content_sha256: 'not-a-digest' }],
    ['a non-string subject_id', { subject_id: 42 }],
    ['array metadata', { metadata: [] }],
  ])('rejects %s', async (_label, override) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(postRequest({ ...validBody, ...override }));

    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test.each(['copied_from_source_id', 'copied_from_document_id', 'copied_for_scope'])(
    'refuses importer-only provenance metadata.%s',
    async (key) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());

      const response = await POST(postRequest({ ...validBody, metadata: { [key]: 'doc_x' } }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(`metadata.${key} is set only by the research importer`);
      expect(mockCreate).not.toHaveBeenCalled();
    },
  );

  test('reports a source in another organization as absent, not as forbidden', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockCreate.mockRejectedValueOnce(new Error('Source does not exist in this organization.'));

    const response = await POST(postRequest(validBody));

    // A 403 here would confirm that the id names a real source somewhere else.
    expect(response.status).toBe(404);
  });

  test('reports repeated content as a conflict', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockCreate.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "shadow_library_documents_organization_id_content_sha256_key"'),
    );

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(409);
  });
});

// RINT-05a: the platform shelf, resolved on the server (OD-2026-10-02-013 1B).
describe('the platform shelf on POST /api/pilot/shadow/library/documents', () => {
  test('platform_owner registers a document on the platform shelf', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await POST(postRequest({ ...validBody, shelf: 'platform', organization_id: 'org-attacker' }));

    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ organizationId: '__platform__' }));
  });

  test.each(['organization_admin', 'admin', 'coach', 'athlete', 'parent', 'board', 'volunteer', 'staff'] as const)(
    '%s gets 403 for shelf: platform',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));

      const response = await POST(postRequest({ ...validBody, shelf: 'platform' }));

      expect(response.status).toBe(403);
      expect(mockCreate).not.toHaveBeenCalled();
    },
  );

  test('refuses an athlete-scoped document on the platform shelf before the database does', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await POST(postRequest({ ...validBody, shelf: 'platform', subject_id: 'ath-9' }));

    expect(response.status).toBe(400);
    expect(mockAssertAthlete).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('an unknown shelf is a 400', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(postRequest({ ...validBody, shelf: 'everyone' }));

    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

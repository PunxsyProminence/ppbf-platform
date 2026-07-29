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

    test('refuses platform_owner, which must not author athlete-scoped evidence', async () => {
      // Omega is broader in breadth and strictly narrower in depth. It may
      // curate an organization's doctrine but must never reach a named
      // athlete's record, so the real assertActorCanAccessAthlete is used here
      // rather than the mock -- this asserts the actual boundary, not a stub.
      const { assertActorCanAccessAthlete: real } = jest.requireActual('@/src/server/pilot/access');
      mockAssertAthlete.mockImplementationOnce(real);
      mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

      const response = await POST(postRequest({ ...validBody, subject_id: 'ath-9' }));

      expect(response.status).toBe(403);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test('still admits platform_owner for doctrine with no subject', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

      const response = await POST(postRequest(validBody));

      expect(response.status).toBe(201);
      expect(mockCreate).toHaveBeenCalledTimes(1);
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

import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { createShadowLibraryChunk } from '@/src/server/pilot/shadowLibrary';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/shadowLibrary', () => ({
  createShadowLibraryChunk: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockCreate = createShadowLibraryChunk as jest.MockedFunction<typeof createShadowLibraryChunk>;

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
  return new NextRequest('http://localhost/api/pilot/shadow/library/chunks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = {
  document_id: 'doc_1',
  ordinal: 0,
  text_content: 'Authority boundaries constrain what SHADOW may assert without evidence.',
  metadata: { chunk_type: 'doctrine' },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue({ chunk_id: 'chunk_1' } as never);
});

describe('POST /api/pilot/shadow/library/chunks', () => {
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

  test('registers a chunk against the session organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(postRequest({ ...validBody, organization_id: 'org-attacker' }));

    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith({
      organizationId: 'org-real',
      actorAccountId: 'acct-1',
      actorRole: 'organization_admin',
      documentId: 'doc_1',
      ordinal: 0,
      textContent: validBody.text_content,
      metadata: { chunk_type: 'doctrine' },
    });
  });

  test('accepts ordinal 0, which the seed script sends for the first chunk', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(postRequest({ ...validBody, ordinal: 0 }));

    // A truthiness check on ordinal would reject the first chunk of every
    // document and leave the Library permanently one chunk short.
    expect(response.status).toBe(201);
  });

  test.each([
    ['a missing document_id', { document_id: '' }],
    ['a negative ordinal', { ordinal: -1 }],
    ['a fractional ordinal', { ordinal: 1.5 }],
    ['a missing ordinal', { ordinal: undefined }],
    ['an ordinal above the cap', { ordinal: 100_001 }],
    ['empty text_content', { text_content: '   ' }],
    ['array metadata', { metadata: [] }],
  ])('rejects %s', async (_label, override) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(postRequest({ ...validBody, ...override }));

    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('rejects text_content beyond the length bound', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await POST(postRequest({ ...validBody, text_content: 'x'.repeat(20_001) }));

    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('reports a document in another organization as absent, not as forbidden', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockCreate.mockRejectedValueOnce(new Error('Document does not exist in this organization.'));

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(404);
  });

  test('reports a repeated ordinal as a conflict', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockCreate.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "shadow_library_chunks_document_id_ordinal_key"'),
    );

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(409);
  });
});

// RINT-05a: the platform shelf, resolved on the server (OD-2026-10-02-013 1B;
// OD-2026-10-02-015 D3).
describe('the platform shelf on POST /api/pilot/shadow/library/chunks', () => {
  test('platform_owner adds a chunk on the platform shelf', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await POST(postRequest({ ...validBody, shelf: 'platform', organization_id: 'org-attacker' }));

    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ organizationId: '__platform__' }));
  });

  test('platform_owner cannot add a chunk on the gym shelf', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await POST(postRequest(validBody));

    expect(response.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
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

  test('a gym admin without a shelf writes its own organization, as before', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    expect((await POST(postRequest(validBody))).status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-real' }));
  });
});

import { NextRequest } from 'next/server';

import { GET, PATCH } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import {
  completeShadowLibraryDocumentIndexing,
  listShadowLibraryReviewQueue,
  reviewShadowLibraryDocument,
  reviewShadowLibrarySource,
} from '@/src/server/pilot/shadowLibrary';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/shadowLibrary', () => ({
  completeShadowLibraryDocumentIndexing: jest.fn(),
  listShadowLibraryReviewQueue: jest.fn(),
  reviewShadowLibraryDocument: jest.fn(),
  reviewShadowLibrarySource: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockIndex = completeShadowLibraryDocumentIndexing as jest.MockedFunction<typeof completeShadowLibraryDocumentIndexing>;
const mockQueue = listShadowLibraryReviewQueue as jest.MockedFunction<typeof listShadowLibraryReviewQueue>;
const mockReviewDocument = reviewShadowLibraryDocument as jest.MockedFunction<typeof reviewShadowLibraryDocument>;
const mockReviewSource = reviewShadowLibrarySource as jest.MockedFunction<typeof reviewShadowLibrarySource>;

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

function getRequest(search = '') {
  return new NextRequest(`http://localhost/api/pilot/shadow/evidence/review${search}`, { method: 'GET' });
}

function patchRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/shadow/evidence/review', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const approveSource = { entityType: 'source', entityId: 'src_abc', action: 'review', approvalState: 'approved' };
const approveDocument = { entityType: 'document', entityId: 'doc_abc', action: 'review', approvalState: 'approved' };
const indexDocument = { entityType: 'document', entityId: 'doc_abc', action: 'complete_indexing' };

function writeMocks() {
  return [mockIndex, mockReviewDocument, mockReviewSource];
}

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks keeps a mockResolvedValue; reset it so no test inherits a
  // principal from the one before.
  mockRequirePrincipal.mockReset();
  mockQueue.mockResolvedValue({ sources: [], documents: [] });
  mockIndex.mockResolvedValue({} as never);
  mockReviewDocument.mockResolvedValue({} as never);
  mockReviewSource.mockResolvedValue({} as never);
});

// Unchanged behaviour: a request naming no shelf reviews the caller's own
// organization, for every reviewer role, platform owner included
// (OD-2026-10-02-013 answer 5A, "as today").
describe('evidence review without a shelf, as before', () => {
  test.each(['organization_admin', 'admin', 'platform_owner'] as const)(
    '%s reviews its own organization',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal(role));

      expect((await GET(getRequest())).status).toBe(200);
      expect((await PATCH(patchRequest(approveSource))).status).toBe(200);
      expect((await PATCH(patchRequest(indexDocument))).status).toBe(200);
      expect((await PATCH(patchRequest(approveDocument))).status).toBe(200);

      expect(mockQueue).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-real' }));
      for (const mock of writeMocks()) {
        expect(mock).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-real' }));
      }
    },
  );

  test.each(['coach', 'athlete', 'parent', 'board', 'volunteer', 'staff'] as const)('%s is refused', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));

    expect((await GET(getRequest())).status).toBe(403);
    expect((await PATCH(patchRequest(approveSource))).status).toBe(403);
    expect(mockQueue).not.toHaveBeenCalled();
    expect(mockReviewSource).not.toHaveBeenCalled();
  });
});

// RINT-05a: OD-2026-10-02-013 answer 1B -- the platform owner reviews the
// platform shelf on /evidence. The shelf is resolved on the server.
describe('evidence review on the platform shelf', () => {
  test('platform_owner lists, indexes and approves on __platform__', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('platform_owner'));

    expect((await GET(getRequest('?shelf=platform&organization_id=org-attacker'))).status).toBe(200);
    expect((await PATCH(patchRequest({ ...approveSource, shelf: 'platform', organizationId: 'org-attacker' }))).status).toBe(200);
    expect((await PATCH(patchRequest({ ...indexDocument, shelf: 'platform' }))).status).toBe(200);
    expect((await PATCH(patchRequest({ ...approveDocument, shelf: 'platform' }))).status).toBe(200);

    expect(mockQueue).toHaveBeenCalledWith(expect.objectContaining({ organizationId: '__platform__' }));
    for (const mock of writeMocks()) {
      expect(mock).toHaveBeenCalledWith(expect.objectContaining({ organizationId: '__platform__' }));
    }
  });

  test.each(['organization_admin', 'admin', 'coach', 'athlete', 'parent', 'board', 'volunteer', 'staff'] as const)(
    '%s gets 403 for shelf: platform',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal(role));

      expect((await GET(getRequest('?shelf=platform'))).status).toBe(403);
      expect((await PATCH(patchRequest({ ...approveSource, shelf: 'platform' }))).status).toBe(403);
      expect((await PATCH(patchRequest({ ...indexDocument, shelf: 'platform' }))).status).toBe(403);
      expect((await PATCH(patchRequest({ ...approveDocument, shelf: 'platform' }))).status).toBe(403);

      expect(mockQueue).not.toHaveBeenCalled();
      for (const mock of writeMocks()) {
        expect(mock).not.toHaveBeenCalled();
      }
    },
  );

  test('an unknown shelf is a 400 and reaches nothing', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('platform_owner'));

    expect((await GET(getRequest('?shelf=org-real'))).status).toBe(400);
    expect((await PATCH(patchRequest({ ...approveSource, shelf: '__platform__' }))).status).toBe(400);
    expect(mockQueue).not.toHaveBeenCalled();
    expect(mockReviewSource).not.toHaveBeenCalled();
  });
});

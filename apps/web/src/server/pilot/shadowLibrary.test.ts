jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));
jest.mock('./access', () => ({
  assertActorCanAccessAthlete: jest.fn(),
}));
jest.mock('./shadowEvents', () => ({ emitShadowEvent: jest.fn() }));
jest.mock('./shadowTelemetry', () => ({ writeShadowTelemetryEvent: jest.fn() }));
jest.mock('./shadowResearch', () => ({
  createShadowResearchRequirement: jest.fn(),
  listShadowResearchRequirements: jest.fn(),
}));

import { assertActorCanAccessAthlete } from './access';
import { query, queryOne } from './db';
import {
  createShadowLibraryChunk,
  normalizeSearchScope,
  searchShadowLibrary,
} from './shadowLibrary';

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;
const mockAssertActorCanAccessAthlete = jest.mocked(assertActorCanAccessAthlete);

describe('SHADOW library search scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue([]);
    mockQueryOne.mockReset();
    mockAssertActorCanAccessAthlete.mockResolvedValue(undefined);
  });
  it('forces an athlete to their own subject scope', () => {
    expect(normalizeSearchScope({
      actorRole: 'athlete',
      athleteId: 'athlete-a',
      scope: 'scoped',
    })).toEqual({
      scope: 'subject',
      effectiveSubjectId: 'athlete-a',
    });
  });

  it('rejects an athlete-supplied subject override', () => {
    expect(() => normalizeSearchScope({
      actorRole: 'athlete',
      athleteId: 'athlete-a',
      subjectId: 'athlete-b',
      scope: 'subject',
    })).toThrow('Forbidden: athlete cannot search another subject');
  });

  it('fails closed when an athlete principal has no athlete identity', () => {
    expect(() => normalizeSearchScope({
      actorRole: 'athlete',
      athleteId: null,
    })).toThrow('Forbidden: athlete SHADOW library access requires an athlete identity');
  });

  // Regression guard. 'master' scope applied no subject predicate in the search
  // query, so it returned every athlete-scoped chunk in an organization to any
  // caller who could name it -- including an organization admin who had not been
  // authorized for those specific athletes. It is removed, and no role may
  // resurrect it, not even platform_owner.
  it.each(['coach', 'organization_admin', 'admin', 'platform_owner'] as const)(
    'rejects the removed master scope for %s',
    (actorRole) => {
      expect(() => normalizeSearchScope({
        actorRole,
        // Cast is deliberate: the union no longer admits 'master'. This asserts
        // the runtime guard holds for callers that bypass the type, such as
        // values arriving from JSON.
        scope: 'master' as unknown as Parameters<typeof normalizeSearchScope>[0]['scope'],
      })).toThrow('Forbidden: unrecognized SHADOW library scope');
    },
  );

  it('rejects any unrecognized scope rather than defaulting to a wide one', () => {
    expect(() => normalizeSearchScope({
      actorRole: 'organization_admin',
      scope: 'all' as unknown as Parameters<typeof normalizeSearchScope>[0]['scope'],
    })).toThrow('Forbidden: unrecognized SHADOW library scope');
  });

  it('requires a subject ID for explicit subject scope', () => {
    expect(() => normalizeSearchScope({
      actorRole: 'coach',
      scope: 'subject',
    })).toThrow('Missing SHADOW library subject');
  });

  it('limits scoped searches without a subject to organization-global chunks', async () => {
    await searchShadowLibrary({
      organizationId: 'org-1',
      actorAccountId: 'coach-1',
      actorRole: 'coach',
      scope: 'scoped',
      queryText: 'footwork',
    });

    expect(String(mockQuery.mock.calls[0][0])).toContain(
      "$2::text = 'scoped' and c.subject_id is null",
    );
    expect(mockQuery.mock.calls[0][1]?.slice(0, 3)).toEqual(['org-1', 'scoped', null]);
    expect(mockAssertActorCanAccessAthlete).not.toHaveBeenCalled();
  });

  it('retrieves only active, approved, verified, fully indexed evidence', async () => {
    await searchShadowLibrary({
      organizationId: 'org-1',
      actorAccountId: 'coach-1',
      actorRole: 'coach',
      scope: 'scoped',
      queryText: 'defense',
    });

    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain("s.status = 'active'");
    expect(sql).toContain("s.approval_state = 'approved'");
    expect(sql).toContain("s.verification_state = 'verified'");
    expect(sql).toContain("d.ingest_state = 'indexed'");
    expect(sql).toContain('d.index_completed_at is not null');
    expect(sql).toContain("d.approval_state = 'approved'");
    expect(sql).toContain("d.verification_state = 'verified'");
  });

  it('binds organization scope through chunks, documents, and sources', async () => {
    await searchShadowLibrary({
      organizationId: 'org-a',
      actorAccountId: 'coach-a',
      actorRole: 'coach',
      scope: 'scoped',
      queryText: 'footwork',
    });

    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain('c.organization_id = $1');
    expect(sql).toContain('d.organization_id = c.organization_id');
    expect(sql).toContain('s.organization_id = c.organization_id');
    expect(mockQuery.mock.calls[0][1]?.[0]).toBe('org-a');
  });

  it('canonically authorizes an exact subject before searching global plus subject chunks', async () => {
    await searchShadowLibrary({
      organizationId: 'org-1',
      actorAccountId: 'coach-1',
      actorRole: 'coach',
      scope: 'subject',
      subjectId: 'athlete-a',
      queryText: 'footwork',
    });

    expect(mockAssertActorCanAccessAthlete).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'coach-1',
        organizationId: 'org-1',
        role: 'coach',
      }),
      'athlete-a',
    );
    expect(mockQuery.mock.calls[0][1]?.slice(0, 3))
      .toEqual(['org-1', 'subject', 'athlete-a']);
  });

  it('does not mark a document indexed merely because one chunk was inserted', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        document_id: 'doc-a',
        source_id: 'source-a',
        subject_id: null,
      } as never)
      .mockResolvedValueOnce({
        chunk_id: 'chunk-a',
        document_id: 'doc-a',
        source_id: 'source-a',
        organization_id: 'org-a',
        subject_id: null,
        ordinal: 0,
        text_content: 'A bounded chunk',
        metadata: {},
        created_by_account_id: 'account-a',
        created_by_role: 'organization_admin',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as never);

    await createShadowLibraryChunk({
      organizationId: 'org-a',
      actorAccountId: 'account-a',
      actorRole: 'organization_admin',
      documentId: 'doc-a',
      ordinal: 0,
      textContent: 'A bounded chunk',
    });

    const stateUpdate = mockQuery.mock.calls.find((call) => (
      String(call[0]).includes('update pilot.shadow_library_documents')
    ));
    expect(String(stateUpdate?.[0])).toContain("ingest_state = 'chunking'");
    expect(String(stateUpdate?.[0])).toContain('index_completed_at = null');
    expect(String(stateUpdate?.[0])).not.toContain("ingest_state = 'indexed'");
  });
});

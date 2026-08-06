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
jest.mock('./shadowEmbeddings', () => ({
  ...jest.requireActual('./shadowEmbeddings'),
  // Enablement and the network call are mocked; cosineSimilarity stays REAL
  // so the ranking under test is the real math.
  isSemanticLibrarySearchEnabled: jest.fn(() => false),
  embedText: jest.fn(),
  getEmbeddingDeploymentName: jest.fn(() => 'test-embedding'),
}));

import { assertActorCanAccessAthlete } from './access';
import { query, queryOne } from './db';
import { embedText, isSemanticLibrarySearchEnabled } from './shadowEmbeddings';
import { createShadowResearchRequirement, listShadowResearchRequirements } from './shadowResearch';
import {
  createShadowLibraryChunk,
  createShadowLibraryClaim,
  normalizeSearchScope,
  searchShadowLibrary,
} from './shadowLibrary';

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;
const mockAssertActorCanAccessAthlete = jest.mocked(assertActorCanAccessAthlete);
const mockIsSemanticEnabled = jest.mocked(isSemanticLibrarySearchEnabled);
const mockEmbedText = jest.mocked(embedText);

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

describe('SHADOW library semantic search', () => {
  const searchInput = {
    organizationId: 'org-1',
    actorAccountId: 'acct-1',
    actorRole: 'organization_admin' as const,
    queryText: 'jab timing drills',
    limit: 2,
  };

  function candidate(chunkId: string, embedding: number[], authorityTier = 3) {
    return {
      chunk_id: chunkId,
      document_id: 'doc-1',
      source_id: 'src-1',
      subject_id: null,
      ordinal: 0,
      document_name: 'Coaching Manual',
      source_title: 'Manual',
      source_publisher: null,
      source_type: 'textbook',
      authority_tier: authorityTier,
      source_status: 'active',
      publication_date: null,
      text_content: 'chunk text',
      score: 0,
      embedding,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertActorCanAccessAthlete.mockResolvedValue(undefined);
    // clearAllMocks does not restore factory implementations, but explicit
    // mockReturnValue state is cleared -- each test block re-states enablement
    // so no test depends on a neighbor's setting.
    mockIsSemanticEnabled.mockReturnValue(true);
  });

  it('ranks candidates by real cosine similarity and never runs the keyword SQL', async () => {
    mockEmbedText.mockResolvedValue([1, 0]);
    mockQuery.mockResolvedValueOnce([
      candidate('chunk_far', [0.1, 0.99]),
      candidate('chunk_near', [0.98, 0.05]),
      candidate('chunk_mid', [0.7, 0.7]),
    ] as never);

    const results = await searchShadowLibrary(searchInput);
    expect(results.map((r) => r.chunk_id)).toEqual(['chunk_near', 'chunk_mid']);
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[0]).not.toHaveProperty('embedding');
    // One db call: the candidate load. The keyword statement never ran.
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(String(mockQuery.mock.calls[0][0])).toContain('c.embedding is not null');
  });

  it('restricts semantic candidates to the current embedding deployment', async () => {
    // A chunk embedded by a retired model shares a dimension with the
    // current one and would rank as a real-looking, meaningless score if the
    // database query did not filter it out before it ever reached
    // cosineSimilarity -- so the assertion is on the query sent, not the
    // ranking, since a mocked query already only returns what the real SQL
    // would have.
    mockEmbedText.mockResolvedValue([1, 0]);
    mockQuery.mockResolvedValueOnce([candidate('chunk_current_model', [0.98, 0.05])] as never);

    await searchShadowLibrary(searchInput);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('c.embedding_model = $4');
    expect(params).toContain('test-embedding');
  });

  it('falls back to keyword search when every candidate is below the relevance floor', async () => {
    mockEmbedText.mockResolvedValue([1, 0]);
    mockQuery
      .mockResolvedValueOnce([candidate('chunk_noise', [0.01, 0.999])] as never)
      .mockResolvedValueOnce([] as never);

    const results = await searchShadowLibrary(searchInput);
    expect(results).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(String(mockQuery.mock.calls[1][0])).toContain("like '%' || $4 || '%'");
  });

  it('falls back to keyword search when the embedding call degrades to null', async () => {
    mockEmbedText.mockResolvedValue(null);
    mockQuery.mockResolvedValueOnce([] as never);

    await searchShadowLibrary(searchInput);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(String(mockQuery.mock.calls[0][0])).toContain("like '%' || $4 || '%'");
  });

  it('stays fully on the keyword path when the feature is disabled', async () => {
    mockIsSemanticEnabled.mockReturnValue(false);
    mockQuery.mockResolvedValueOnce([] as never);

    await searchShadowLibrary(searchInput);
    expect(mockEmbedText).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(String(mockQuery.mock.calls[0][0])).toContain("like '%' || $4 || '%'");
  });
});

describe('SHADOW library claim honesty', () => {
  function evidenceRow(sourceId: string) {
    return {
      chunk_id: `chunk-${sourceId}`,
      document_id: 'doc-1',
      source_id: sourceId,
      subject_id: null,
      ordinal: 0,
      document_name: 'Coaching Manual',
      source_title: 'Manual',
      source_publisher: null,
      source_type: 'textbook',
      authority_tier: 3,
      source_status: 'active',
      publication_date: null,
      text_content: 'chunk text',
      score: 0,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertActorCanAccessAthlete.mockResolvedValue(undefined);
    mockIsSemanticEnabled.mockReturnValue(false);
    jest.mocked(listShadowResearchRequirements).mockResolvedValue([]);
    jest.mocked(createShadowResearchRequirement).mockResolvedValue(101);
  });

  // confidence's three fixed values (0.78/0.46/0.12) are a status label
  // wearing a percentage's clothes, not a calibrated score -- these counts are
  // the numbers a caller can actually reason about, and this test exists so a
  // future edit cannot drop them back off the return value unnoticed.
  it('reports evidenceCount and distinctSourceCount alongside the ordinal status', async () => {
    mockQuery.mockResolvedValueOnce([evidenceRow('src-a'), evidenceRow('src-b')] as never);

    const result = await createShadowLibraryClaim({
      organizationId: 'org-1',
      actorAccountId: 'acct-1',
      actorRole: 'organization_admin',
      question: 'What does the evidence say about jab timing drills?',
    });

    expect(result.status).toBe('supported');
    expect(result.evidenceCount).toBe(2);
    expect(result.distinctSourceCount).toBe(2);
    expect(result.confidence).toBe(0.78);
  });

  it('reports zero counts and the unsupported band when nothing was found', async () => {
    mockQuery.mockResolvedValueOnce([] as never);

    const result = await createShadowLibraryClaim({
      organizationId: 'org-1',
      actorAccountId: 'acct-1',
      actorRole: 'organization_admin',
      question: 'Is there evidence for a claim nobody has written about?',
    });

    expect(result.status).toBe('unsupported');
    expect(result.evidenceCount).toBe(0);
    expect(result.distinctSourceCount).toBe(0);
  });
});

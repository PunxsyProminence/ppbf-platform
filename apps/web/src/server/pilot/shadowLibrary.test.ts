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
  // The constants stay real, so the event names asserted below are the ones
  // the module actually writes.
  ...jest.requireActual('./shadowResearch'),
  createShadowResearchRequirement: jest.fn(),
  listShadowResearchRequirements: jest.fn(),
  resolveCoveredCapabilityGapRequirements: jest.fn(),
  syncCapabilityGapRequirement: jest.fn(),
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
import { emitShadowEvent } from './shadowEvents';
import {
  createShadowResearchRequirement,
  listShadowResearchRequirements,
  resolveCoveredCapabilityGapRequirements,
  syncCapabilityGapRequirement,
} from './shadowResearch';
import {
  createShadowLibraryChunk,
  createShadowLibraryClaim,
  listApprovedGlobalEvidenceForResearchBridge,
  listShadowCapabilityCoverage,
  normalizeSearchScope,
  recomputeShadowCapabilityCoverage,
  confidenceLevelForScore,
  searchShadowLibrary,
  searchShadowLibraryRanked,
} from './shadowLibrary';

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;
const mockAssertActorCanAccessAthlete = jest.mocked(assertActorCanAccessAthlete);
const mockIsSemanticEnabled = jest.mocked(isSemanticLibrarySearchEnabled);
const mockEmbedText = jest.mocked(embedText);
const mockEmitShadowEvent = jest.mocked(emitShadowEvent);

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
    expect(mockQuery.mock.calls[0][1]?.slice(0, 3))
      .toEqual([['org-1', '__platform__'], 'scoped', null]);
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
    // The chunk predicate admits a set -- the caller's organization and the
    // platform evidence baseline -- but the two joins still restate tenancy
    // against the chunk rather than against the parameter. That is what keeps
    // the widening from ever assembling a row out of two organizations: a
    // platform chunk can only pair with a platform document and source.
    expect(sql).toContain('c.organization_id = any($1::text[])');
    expect(sql).toContain('d.organization_id = c.organization_id');
    expect(sql).toContain('s.organization_id = c.organization_id');

    // Exactly two shelves, and the caller's is one of them. A third entry here
    // would be another gym's evidence.
    expect(mockQuery.mock.calls[0][1]?.[0]).toEqual(['org-a', '__platform__']);
  });

  it('never admits a third organization to the retrieval set', async () => {
    // The failure this guards is a call site that widens the set from something
    // other than libraryRetrievalOrganizationIds -- the predicate is an any(),
    // so an over-long array is a cross-tenant read with no other symptom.
    for (const organizationId of ['org-a', 'org-b', 'audit-test-gym3']) {
      mockQuery.mockClear();
      await searchShadowLibrary({
        organizationId,
        actorAccountId: 'coach-a',
        actorRole: 'coach',
        scope: 'scoped',
        queryText: 'footwork',
      });
      expect(mockQuery.mock.calls[0][1]?.[0]).toEqual([organizationId, '__platform__']);
    }
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
      .toEqual([['org-1', '__platform__'], 'subject', 'athlete-a']);
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

  // A floor miss used to fall through to the loose substring keyword path,
  // which is how a nonsense question got an unrelated passage.
  it('does NOT fall back to keywords when every candidate is below the relevance floor', async () => {
    mockEmbedText.mockResolvedValue([1, 0]);
    mockQuery.mockResolvedValueOnce([candidate('chunk_noise', [0.01, 0.999])] as never);

    const ranked = await searchShadowLibraryRanked(searchInput);
    expect(ranked.relevant).toEqual([]);
    expect(ranked.nearest).toEqual([]);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('keeps a candidate between the floor and the relevance bar as nearest, not as evidence', async () => {
    mockEmbedText.mockResolvedValue([1, 0]);
    // cosine([1,0],[0.2,0.98]) is about 0.20: above the 0.15 floor, below the 0.30 bar.
    mockQuery.mockResolvedValueOnce([candidate('chunk_close', [0.2, 0.98])] as never);
    const ranked = await searchShadowLibraryRanked(searchInput);
    expect(ranked.relevant).toEqual([]);
    expect(ranked.nearest.map((r) => r.chunk_id)).toEqual(['chunk_close']);

    mockQuery.mockResolvedValueOnce([candidate('chunk_close', [0.2, 0.98])] as never);
    expect(await searchShadowLibrary(searchInput)).toEqual([]);
  });

  it('falls back to keyword search when the embedding call degrades to null', async () => {
    mockEmbedText.mockResolvedValue(null);
    mockQuery.mockResolvedValueOnce([] as never);

    await searchShadowLibrary(searchInput);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(String(mockQuery.mock.calls[0][0])).toContain("~ ('\\m' || term || '(s|es)?\\M')");
  });

  it('stays fully on the keyword path when the feature is disabled', async () => {
    mockIsSemanticEnabled.mockReturnValue(false);
    mockQuery.mockResolvedValueOnce([] as never);

    await searchShadowLibrary(searchInput);
    expect(mockEmbedText).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(String(mockQuery.mock.calls[0][0])).toContain("~ ('\\m' || term || '(s|es)?\\M')");
  });
});

describe('SHADOW library keyword relevance', () => {
  const input = {
    organizationId: 'org-1',
    actorAccountId: 'acct-1',
    actorRole: 'organization_admin' as const,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertActorCanAccessAthlete.mockResolvedValue(undefined);
    mockIsSemanticEnabled.mockReturnValue(false);
    mockQuery.mockResolvedValue([] as never);
  });

  it('matches whole words, with the term list as a parameter and no authority bonus in the score', async () => {
    await searchShadowLibrary({ ...input, queryText: 'jab footwork' });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("~ ('\\m' || term || '(s|es)?\\M')");
    expect(String(sql)).not.toMatch(/like\s+'%'/);
    const scoreExpr = String(sql).slice(String(sql).indexOf('select count(*)'), String(sql).indexOf(') as score'));
    expect(scoreExpr).toContain('cardinality');
    expect(scoreExpr).not.toContain('authority_tier');
    expect(params?.[3]).toEqual(['jab', 'footwork']);
  });

  it('drops stop words, repeats and short words from the terms', async () => {
    await searchShadowLibrary({ ...input, queryText: 'What is the jab? JAB, and how to use it' });
    expect(mockQuery.mock.calls[0][1]?.[3]).toEqual(['jab']);
  });

  it('folds plain plurals so "drills" still finds "drill"', async () => {
    await searchShadowLibrary({ ...input, queryText: 'jab drills punches glass' });
    expect(mockQuery.mock.calls[0][1]?.[3]).toEqual(['jab', 'drill', 'punche', 'glass']);
  });

  it('runs no query at all when the question has no meaningful word left', async () => {
    const ranked = await searchShadowLibraryRanked({ ...input, queryText: 'what is the way to do it' });
    expect(ranked.relevant).toEqual([]);
    expect(ranked.nearest).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('splits rows at the keyword relevance bar', async () => {
    mockQuery.mockResolvedValueOnce([
      { ...kwRow('a'), score: 1 },
      { ...kwRow('b'), score: 0.6 },
      { ...kwRow('c'), score: 0.25 },
    ] as never);
    const ranked = await searchShadowLibraryRanked({ ...input, queryText: 'alpha beta gamma delta' });
    expect(ranked.relevant.map((r) => r.chunk_id)).toEqual(['chunk-a', 'chunk-b']);
    expect(ranked.nearest.map((r) => r.chunk_id)).toEqual(['chunk-c']);
    expect(ranked.mode).toBe('keyword');
  });

  it('maps score to a plain confidence level on each path', () => {
    expect(confidenceLevelForScore('keyword', 1)).toBe('high');
    expect(confidenceLevelForScore('keyword', 0.8)).toBe('high');
    expect(confidenceLevelForScore('keyword', 0.6)).toBe('medium');
    expect(confidenceLevelForScore('keyword', 0.59)).toBe('low');
    expect(confidenceLevelForScore('semantic', 0.5)).toBe('high');
    expect(confidenceLevelForScore('semantic', 0.3)).toBe('medium');
    expect(confidenceLevelForScore('semantic', 0.29)).toBe('low');
  });
});

function kwRow(id: string) {
  return {
    chunk_id: `chunk-${id}`,
    document_id: 'doc-1',
    source_id: `src-${id}`,
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
    score: 1,
  };
}

describe('SHADOW library claim honesty', () => {
  function evidenceRow(sourceId: string, score = 1) {
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
      score,
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
    expect(result.confidence).toBe(0.78);    expect(result.confidenceLevel).toBe('high');
  });

  // JASON'S RULING 2026-10-03: below the relevance bar the closest passages are
  // still shown, labelled low confidence, and the gap is filed as research.
  it('a below-bar match is shown as low confidence and opens a research requirement', async () => {
    mockQuery.mockResolvedValueOnce([evidenceRow('src-a', 0.25)] as never);

    const result = await createShadowLibraryClaim({
      organizationId: 'org-1',
      actorAccountId: 'acct-1',
      actorRole: 'organization_admin',
      question: 'alpha beta gamma delta nonsense',
    });

    expect(result.status).toBe('weak');
    expect(result.confidenceLevel).toBe('low');
    expect(result.evidence).toHaveLength(1);
    expect(result.evidenceCount).toBe(0);
    expect(result.answer).toMatch(/^Confidence: low\./);
    expect(result.answer).toContain('Closest Library passages');
    expect(result.answer).not.toContain('Library-backed answer');
    expect(result.researchRequirementId).toBe(101);
    expect(createShadowResearchRequirement).toHaveBeenCalledTimes(1);
  });

  it('a question made only of stop words is unsupported and still opens a research requirement', async () => {
    const result = await createShadowLibraryClaim({
      organizationId: 'org-1',
      actorAccountId: 'acct-1',
      actorRole: 'organization_admin',
      question: 'what is the way to do it',
    });

    expect(mockQuery).not.toHaveBeenCalled();
    expect(result.status).toBe('unsupported');
    expect(result.confidenceLevel).toBe('none');
    expect(createShadowResearchRequirement).toHaveBeenCalledTimes(1);
  });

  it('one relevant source is capped at medium confidence', async () => {
    mockQuery.mockResolvedValueOnce([evidenceRow('src-a', 1)] as never);

    const result = await createShadowLibraryClaim({
      organizationId: 'org-1',
      actorAccountId: 'acct-1',
      actorRole: 'organization_admin',
      question: 'jab',
    });

    expect(result.status).toBe('weak');
    expect(result.confidenceLevel).toBe('medium');
  });

  it('a real match with two sources is supported and opens no research requirement', async () => {
    mockQuery.mockResolvedValueOnce([evidenceRow('src-a', 0.7), evidenceRow('src-b', 0.65)] as never);

    const result = await createShadowLibraryClaim({
      organizationId: 'org-1',
      actorAccountId: 'acct-1',
      actorRole: 'organization_admin',
      question: 'alpha beta',
    });

    expect(result.status).toBe('supported');
    expect(result.confidenceLevel).toBe('medium');
    expect(createShadowResearchRequirement).not.toHaveBeenCalled();
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

  // ensureClaimResearchRequirement's call into createShadowResearchRequirement
  // is where an athlete-scoped claim gap becomes a subject_id-scoped
  // requirement row -- the only writer this migration's column depends on
  // actually reaching. A future edit that stops threading subjectId through
  // would silently reopen the "no writer populates the clean column" gap.
  it('threads the claim subject through to the created research requirement', async () => {
    mockQuery.mockResolvedValueOnce([] as never);

    await createShadowLibraryClaim({
      organizationId: 'org-1',
      actorAccountId: 'acct-1',
      actorRole: 'organization_admin',
      scope: 'subject',
      subjectId: 'athlete-x',
      question: 'Is there evidence for a claim about this athlete specifically?',
    });

    expect(createShadowResearchRequirement).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: 'athlete-x' }),
    );
  });

  it('logs the gap event with requirement/knowledge-gap text a research-intake panel can render', async () => {
    mockQuery.mockResolvedValueOnce([] as never); // no evidence -> unsupported

    await createShadowLibraryClaim({
      organizationId: 'org-1',
      actorAccountId: 'acct-1',
      actorRole: 'organization_admin',
      question: 'Is there evidence for a claim nobody has written about?',
    });

    expect(mockEmitShadowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'SHADOW_LIBRARY_CLAIM_GAP_DETECTED',
        payload: expect.objectContaining({
          research_requirement: expect.any(String),
          knowledge_gap: expect.stringContaining('Is there evidence for a claim nobody has written about?'),
        }),
      }),
    );
  });
});

// What search serves is the bar. The coverage count used to accept any active
// source, so a rule read "covered" on a source still waiting for review, never
// indexed, or suppressed for retraction -- while search returned nothing for
// it -- and a covered rule opens no research gap. The real-database proof is
// shadowLibraryCoverage.pg.test.ts; this pins the predicates in the SQL itself,
// whitespace-normalized, for a run without Postgres.
describe('SHADOW library capability coverage counts only servable sources', () => {
  function normalizedSql(callIndex: number): string {
    return String(mockQuery.mock.calls[callIndex][0])
      .replace(/--[^\n]*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** The LATERAL subquery that produces matched_sources. */
  function matchedSourcesSubquery(sql: string): string {
    const start = sql.indexOf('left join lateral (');
    const end = sql.indexOf(') ms on true');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return sql.slice(start, end);
  }

  const SERVABLE_PREDICATES = [
    "s.status = 'active'",
    "s.approval_state = 'approved'",
    "s.verification_state = 'verified'",
    'not coalesce(s.retrieval_suppressed, false)',
    // A gym-wide search returns no athlete-scoped chunk, so an athlete-scoped
    // document is no gym-wide coverage.
    'd.subject_id is null',
    "d.ingest_state = 'indexed'",
    'd.index_completed_at is not null',
    "d.approval_state = 'approved'",
    "d.verification_state = 'verified'",
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue([]);
    jest.mocked(listShadowResearchRequirements).mockResolvedValue([]);
  });

  it('the listed count requires everything search requires', async () => {
    await listShadowCapabilityCoverage('org-1');

    const subquery = matchedSourcesSubquery(normalizedSql(0));
    for (const predicate of SERVABLE_PREDICATES) {
      expect({ predicate, present: subquery.includes(predicate) }).toEqual({ predicate, present: true });
    }
  });

  it('recompute grades on the same count it lists', async () => {
    await recomputeShadowCapabilityCoverage({
      organizationId: 'org-1',
      actorAccountId: 'acct-1',
      actorRole: 'organization_admin',
    });

    // Call 0 computes the states; the last call is the list returned to the
    // caller. With no rules there is no update in between.
    const computed = matchedSourcesSubquery(normalizedSql(0));
    const listed = matchedSourcesSubquery(normalizedSql(mockQuery.mock.calls.length - 1));
    for (const predicate of SERVABLE_PREDICATES) {
      expect({ predicate, present: computed.includes(predicate) }).toEqual({ predicate, present: true });
    }
    expect(computed).toBe(listed);
  });

  // R1 (Jason 2026-09-29): coverage counts every shelf search reads -- the
  // gym's own and the shared platform baseline -- and no other. Counting the
  // gym's shelf alone called a rule uncovered while search was answering it.
  it('counts the gym shelf and the platform shelf, exactly the organizations search reads', async () => {
    await listShadowCapabilityCoverage('org-1');
    await recomputeShadowCapabilityCoverage({
      organizationId: 'org-1',
      actorAccountId: 'acct-1',
      actorRole: 'organization_admin',
    });

    const coverageCalls = mockQuery.mock.calls.filter(([sql]) => String(sql).includes(') ms on true'));
    expect(coverageCalls.length).toBeGreaterThanOrEqual(3);
    for (const [sql, params] of coverageCalls) {
      const subquery = matchedSourcesSubquery(String(sql).replace(/\s+/g, ' '));
      expect(subquery).toContain('s.organization_id = any($2::text[])');
      // The rule's own organization is no longer the shelf filter.
      expect(subquery).not.toContain('s.organization_id = cm.organization_id');
      // Still one shelf per source: the chunk sits on the source's shelf and
      // the document on the chunk's, so a platform source is never paired
      // with a gym chunk or document.
      expect(subquery).toContain('c.organization_id = s.organization_id');
      expect(subquery).toContain('d.organization_id = c.organization_id');
      expect(params).toEqual(['org-1', ['org-1', '__platform__']]);
    }
  });

  // Search serves a source through the chunks that cite it, not through a
  // document the source owns (searchShadowLibrary joins `s.source_id =
  // c.source_id` and `d.document_id = c.document_id`). In the research corpus
  // every document belongs to one programme source and the chunks cite
  // hundreds of others, so an ownership join counted almost nothing search
  // serves. The real-database proof is the "real corpus shape" case in
  // shadowLibraryCoverage.pg.test.ts.
  it('counts a source through the chunks that cite it, joined the way search joins them', async () => {
    await listShadowCapabilityCoverage('org-1');

    const subquery = matchedSourcesSubquery(normalizedSql(0));
    expect(subquery).toContain('from pilot.shadow_library_chunks c');
    expect(subquery).toContain('c.source_id = s.source_id');
    expect(subquery).toContain('d.document_id = c.document_id');
    // A gym-wide search returns no athlete-scoped chunk.
    expect(subquery).toContain('c.subject_id is null');
    // Document ownership is not what search asks.
    expect(subquery).not.toContain('d.source_id = s.source_id');
  });
});

// R2 (Jason 2026-09-29): the coverage check closes its own gap tickets once a
// capability grades covered, and brings a ticket back when the gap returns.
// The real-database proof is shadowLibraryCoverage.pg.test.ts.
describe('SHADOW library capability coverage manages its own gap tickets', () => {
  const mockSync = jest.mocked(syncCapabilityGapRequirement);
  const mockResolveCovered = jest.mocked(resolveCoveredCapabilityGapRequirements);
  const mockCreateRequirement = jest.mocked(createShadowResearchRequirement);

  const ruleRow = (key: string, matched: number, minimum = 1) => ({
    capability_map_id: `map-${key}`,
    capability_key: key,
    required_source_types: [],
    minimum_authority_tier: 3,
    minimum_source_count: minimum,
    matched_sources: matched,
  });

  const gapEvents = () =>
    mockEmitShadowEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.eventName === 'SHADOW_LIBRARY_CAPABILITY_GAP_DETECTED');

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue([]);
    jest.mocked(listShadowResearchRequirements).mockResolvedValue([]);
    mockSync.mockResolvedValue(null);
    mockResolveCovered.mockResolvedValue([]);
    mockCreateRequirement.mockResolvedValue(1);
  });

  async function recomputeWith(rows: ReturnType<typeof ruleRow>[]) {
    mockQuery.mockResolvedValueOnce(rows as never);
    return recomputeShadowCapabilityCoverage({
      organizationId: 'org-1',
      actorAccountId: 'acct-curator',
      actorRole: 'organization_admin',
    });
  }

  it('closes the open gap ticket of every rule that grades covered, and only those', async () => {
    mockResolveCovered.mockResolvedValue([{ research_requirement_id: 41, capability_key: 'cap-covered' }]);

    await recomputeWith([ruleRow('cap-covered', 2), ruleRow('cap-uncovered', 0), ruleRow('cap-partial', 1, 2)]);

    expect(mockResolveCovered).toHaveBeenCalledTimes(1);
    expect(mockResolveCovered).toHaveBeenCalledWith({
      organizationId: 'org-1',
      covered: [{ capabilityKey: 'cap-covered', matchedSources: 2 }],
      resolvedByAccountId: 'acct-curator',
      resolvedByRole: 'organization_admin',
    });

    // The pass records what it closed on the event that names who ran it.
    const recomputed = mockEmitShadowEvent.mock.calls
      .map(([event]) => event)
      .find((event) => event.eventName === 'SHADOW_LIBRARY_CAPABILITY_COVERAGE_RECOMPUTED');
    expect(recomputed?.payload).toEqual({ rules: 3, closed_research_requirement_ids: [41] });
  });

  it('hands every uncovered and partial rule, and no covered one, to the ticket sync with the gap as graded now', async () => {
    await recomputeWith([ruleRow('cap-covered', 2), ruleRow('cap-uncovered', 0), ruleRow('cap-partial', 1, 2)]);

    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(mockSync).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      capabilityKey: 'cap-uncovered',
      sourceStatus: 'missing',
      createdByAccountId: 'acct-curator',
      metadata: expect.objectContaining({ capability_key: 'cap-uncovered', coverage_state: 'uncovered' }),
    }));
    expect(mockSync).toHaveBeenCalledWith(expect.objectContaining({
      capabilityKey: 'cap-partial',
      sourceStatus: 'weak',
      knowledgeGap: expect.stringContaining('has only 1 qualifying sources'),
      metadata: expect.objectContaining({ coverage_state: 'partial', matched_sources: 1 }),
    }));
    // The generic create, whose on-conflict is a no-op, is no longer the path.
    expect(mockCreateRequirement).not.toHaveBeenCalled();
  });

  it('records a gap event when the sync opened, refreshed or reopened a ticket', async () => {
    mockSync.mockResolvedValue(41);

    await recomputeWith([ruleRow('cap-lost-its-source', 0)]);

    expect(gapEvents()).toEqual([expect.objectContaining({
      entityId: 'cap-lost-its-source',
      payload: expect.objectContaining({ coverage_state: 'uncovered' }),
    })]);
  });

  it('records no gap event when the sync wrote nothing, so an unchanged gap is not re-recorded every recompute', async () => {
    mockSync.mockResolvedValue(null);

    await recomputeWith([ruleRow('cap-same-gap', 0), ruleRow('cap-same-partial', 1, 2)]);

    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(gapEvents()).toEqual([]);
  });
});

describe('SHADOW research-bridge export excludes retracted sources', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue([]);
  });

  // suppressSource flips only retrieval_suppressed; approval and verification
  // stay as they were. So without its own predicate the export shipped a
  // source's text under approved_evidence after search had dropped it.
  it('filters out a source suppressed for retraction, as search does', async () => {
    await listApprovedGlobalEvidenceForResearchBridge({ organizationId: 'org-1' });

    const sql = String(mockQuery.mock.calls[0][0])
      .replace(/--[^\n]*/g, ' ')
      .replace(/\s+/g, ' ');
    expect(sql).toContain('not coalesce(s.retrieval_suppressed, false)');
  });
});

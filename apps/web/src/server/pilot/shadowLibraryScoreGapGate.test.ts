// Score-gap gate (F-161, lane LG; study SHADOW-NO-ANSWER-2026-10-22). On
// text-embedding-3-small, a semantic search whose top-1 cosine stands less than
// SEMANTIC_GAP_BAR above the mean of the top ten is "no confident answer":
// nothing is evidence and every ranked passage is only "closest". The claims
// page and the chat then take the no-answer paths they already have. Real
// shadowLibrary and shadowEvidence; only the database, the embedding call and
// the side-effect writers are mocked, and cosineSimilarity stays real.
jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));
jest.mock('./access', () => ({ assertActorCanAccessAthlete: jest.fn() }));
jest.mock('./shadowEvents', () => ({ emitShadowEvent: jest.fn() }));
jest.mock('./shadowTelemetry', () => ({ writeShadowTelemetryEvent: jest.fn() }));
jest.mock('./shadowResearch', () => ({
  ...jest.requireActual('./shadowResearch'),
  createShadowResearchRequirement: jest.fn(),
}));
jest.mock('./shadowEmbeddings', () => ({
  ...jest.requireActual('./shadowEmbeddings'),
  isSemanticLibrarySearchEnabled: jest.fn(() => true),
  embedText: jest.fn(),
  getEmbeddingDeploymentName: jest.fn(() => 'text-embedding-3-small'),
}));

import { query, queryOne, withTransaction } from './db';
import { embedText, getEmbeddingDeploymentName } from './shadowEmbeddings';
import { retrieveShadowEvidenceBundle, unavailableShadowEvidenceBundle } from './shadowEvidence';
import { createShadowResearchRequirement } from './shadowResearch';
import { writeShadowTelemetryEvent } from './shadowTelemetry';
import {
  createShadowLibraryClaim,
  isScoreGapGateEnabled,
  searchShadowLibrary,
  SEMANTIC_GAP_BAR,
  type ShadowLibrarySearchDetail,
} from './shadowLibrary';

const mockQuery = jest.mocked(query);
const mockTelemetry = jest.mocked(writeShadowTelemetryEvent);
const mockModel = jest.mocked(getEmbeddingDeploymentName);

// With the query vector [1, 0], this candidate's cosine is exactly `cosine`.
function candidate(index: number, cosine: number) {
  return {
    chunk_id: `chunk_${String(index).padStart(2, '0')}`,
    document_id: `doc-${index}`,
    source_id: `src-${index}`,
    subject_id: null,
    ordinal: 0,
    document_name: `Manual ${index}`,
    source_title: `Source ${index}`,
    source_publisher: null,
    source_type: 'textbook',
    authority_tier: 3,
    source_status: 'active',
    publication_date: null,
    text_content: `Jab timing drills passage ${index}.`,
    score: 0,
    embedding: [cosine, Math.sqrt(1 - cosine * cosine)],
  };
}

// Ten candidates: one at `top1`, nine at 0.5. gap = 0.9 * top1 - 0.45, and
// every one of them clears the 0.30 cosine bar, so on the bar alone all are evidence.
const library = (top1: number, others = 9) => [candidate(0, top1), ...Array.from({ length: others }, (_, i) => candidate(i + 1, 0.5))];
const BELOW = library(0.553); // gap 0.0477
const ABOVE = library(0.556); // gap 0.0504

function serve(rows: ReturnType<typeof candidate>[]) {
  mockQuery.mockImplementation((async (sql: string) => (sql.includes('c.embedding is not null') ? rows : [])) as never);
}

const searchInput = {
  organizationId: 'org-1',
  actorAccountId: 'acct-1',
  actorRole: 'organization_admin' as const,
  queryText: 'jab timing drills',
  limit: 8,
};

async function ranked() {
  const detail: ShadowLibrarySearchDetail = { nearest: [], mode: 'keyword' };
  const relevant = await searchShadowLibrary(searchInput, detail);
  return { relevant, nearest: detail.nearest, mode: detail.mode };
}

function searchDimensions() {
  const calls = mockTelemetry.mock.calls.filter(([event]) => event.metricName === 'shadow.library.search');
  expect(calls).toHaveLength(1);
  return calls[0][0].dimensions as Record<string, unknown>;
}

const savedFlag = process.env.PPBF_SHADOW_SCORE_GAP_GATE_ENABLED;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.PPBF_SHADOW_SCORE_GAP_GATE_ENABLED;
  mockModel.mockReturnValue('text-embedding-3-small');
  jest.mocked(embedText).mockResolvedValue([1, 0]);
  jest.mocked(queryOne).mockResolvedValue(null as never);
  jest.mocked(createShadowResearchRequirement).mockResolvedValue(101);
});

afterAll(() => {
  if (savedFlag === undefined) delete process.env.PPBF_SHADOW_SCORE_GAP_GATE_ENABLED;
  else process.env.PPBF_SHADOW_SCORE_GAP_GATE_ENABLED = savedFlag;
});

describe('SHADOW score-gap gate: search', () => {
  it('sits at 0.049, from the study', () => {
    expect(SEMANTIC_GAP_BAR).toBe(0.049);
  });

  it('below the gap: no evidence, every ranked passage is closest, and the log says abstained', async () => {
    serve(BELOW);

    const result = await ranked();

    expect(result.mode).toBe('semantic');
    expect(result.relevant).toEqual([]);
    // Best first, one per source, up to the limit: the same list the bar would have cited.
    expect(result.nearest.map((row) => row.chunk_id)).toEqual(BELOW.slice(0, 8).map((row) => row.chunk_id));
    const dimensions = searchDimensions();
    expect(dimensions.gap_gate).toBe('abstained');
    expect(dimensions.score_gap as number).toBeCloseTo(0.0477, 10);
    expect(dimensions.result_count).toBe(0);
    expect(dimensions.nearest_count).toBe(8);
    // Unchanged meaning: the cosine bar alone would have delivered evidence.
    expect(dimensions.bar_delivered).toBe(true);
  });

  it('above the gap: the bar decides, as today, and the log says passed', async () => {
    serve(ABOVE);

    const result = await ranked();

    expect(result.relevant.map((row) => row.chunk_id)).toEqual(ABOVE.slice(0, 8).map((row) => row.chunk_id));
    expect(result.nearest).toEqual([]);
    expect(searchDimensions().gap_gate).toBe('passed');
  });

  it('leaves any other embedding model on the cosine bar alone', async () => {
    mockModel.mockReturnValue('text-embedding-3-large');
    serve(BELOW);

    const result = await ranked();

    expect(result.relevant).toHaveLength(8);
    expect(result.nearest).toEqual([]);
    expect(searchDimensions().gap_gate).toBe('other_model');
  });

  it.each(['false', ' FALSE '])('kill switch PPBF_SHADOW_SCORE_GAP_GATE_ENABLED=%j leaves search as today', async (value) => {
    process.env.PPBF_SHADOW_SCORE_GAP_GATE_ENABLED = value;
    serve(BELOW);

    const result = await ranked();

    expect(result.relevant).toHaveLength(8);
    expect(searchDimensions().gap_gate).toBe('off');
  });

  it('is on when the flag is unset or holds anything but false', () => {
    expect(isScoreGapGateEnabled({})).toBe(true);
    expect(isScoreGapGateEnabled({ PPBF_SHADOW_SCORE_GAP_GATE_ENABLED: 'true' })).toBe(true);
    expect(isScoreGapGateEnabled({ PPBF_SHADOW_SCORE_GAP_GATE_ENABLED: '' })).toBe(true);
    expect(isScoreGapGateEnabled({ PPBF_SHADOW_SCORE_GAP_GATE_ENABLED: 'false' })).toBe(false);
  });

  it('stands aside below ten candidates, where the gap is not the fitted statistic', async () => {
    // Nine candidates with a gap under the bar (0.553 - 4.553 / 9 = 0.0471);
    // and one alone, whose gap is always 0. Both keep the bar's answer (limit 8).
    serve(library(0.553, 8));
    expect((await ranked()).relevant).toHaveLength(8);
    expect(searchDimensions().score_gap as number).toBeLessThan(SEMANTIC_GAP_BAR);
    expect(searchDimensions().gap_gate).toBe('few_candidates');

    mockTelemetry.mockClear();
    serve([candidate(0, 0.8)]);
    expect((await ranked()).relevant.map((row) => row.chunk_id)).toEqual(['chunk_00']);
    const dimensions = searchDimensions();
    expect(dimensions.score_gap).toBe(0);
    expect(dimensions.gap_gate).toBe('few_candidates');
  });
});

describe('SHADOW score-gap gate: the readers take their existing no-answer paths', () => {
  it('claims page: below the gap is the below-bar answer -- closest passages, low confidence, a research requirement', async () => {
    serve(BELOW);

    const claim = await createShadowLibraryClaim({
      organizationId: 'org-1',
      actorAccountId: 'acct-1',
      actorRole: 'organization_admin',
      question: 'jab timing drills',
    });

    expect(claim.status).toBe('weak');
    expect(claim.confidenceLevel).toBe('low');
    expect(claim.confidence).toBe(0.25);
    expect(claim.evidenceCount).toBe(0);
    expect(claim.distinctSourceCount).toBe(0);
    expect(claim.evidence).toHaveLength(5);
    expect(claim.answer).toMatch(/^Confidence: low\. The Library has no passage that clearly answers this question;/);
    expect(claim.researchRequirementId).toBe(101);
    expect(createShadowResearchRequirement).toHaveBeenCalledTimes(1);
  });

  it('claims page: above the gap is answered as today', async () => {
    serve(ABOVE);
    mockQuery.mockImplementation((async (sql: string) => {
      if (sql.includes('c.embedding is not null')) return ABOVE;
      if (sql.includes('from pilot.shadow_library_sources where source_id')) {
        return ABOVE.map((row) => ({ source_id: row.source_id, url: `https://example.com/${row.source_id}`, metadata: {} }));
      }
      return [];
    }) as never);

    const claim = await createShadowLibraryClaim({
      organizationId: 'org-1',
      actorAccountId: 'acct-1',
      actorRole: 'organization_admin',
      question: 'jab timing drills',
    });

    expect(claim.status).toBe('supported');
    expect(claim.evidenceCount).toBe(5);
    expect(claim.researchRequirementId).toBeNull();
  });

  function stubBundleWrites() {
    const client = {
      query: jest.fn(async (_sql: string, params?: unknown[]) => ({
        rows: [{ evidence_id: params?.[0], passage_displayable: false, excerpt_locator: null }],
      })),
    };
    jest.mocked(withTransaction).mockImplementation((async (work: (c: typeof client) => Promise<unknown>) => work(client)) as never);
    return client;
  }

  it('chat: below the gap the evidence bundle is empty, so the route answers Research Needed and files the request', async () => {
    // The route's handling of an empty bundle (RESEARCH_NEEDED tier,
    // NO_VERIFIED_EVIDENCE notice, research filed) is unchanged and pinned by
    // app/api/pilot/shadow/chat/route.test.ts.
    serve(BELOW);
    const client = stubBundleWrites();

    const bundle = await retrieveShadowEvidenceBundle({
      actor: { accountId: 'acct-1', organizationId: 'org-1', athleteId: null, role: 'coach' },
      queryText: 'jab timing drills',
    });

    expect(bundle.availability).toBe('unavailable');
    expect(bundle.items).toEqual([]);
    expect(bundle.allowedEvidenceIds).toEqual([]);
    expect(bundle.context).toBe(unavailableShadowEvidenceBundle().context);
    // The stored bundle says so too: unavailable, no items.
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls[0][1]?.slice(5)).toEqual(['unavailable', 0]);
  });

  it('chat: above the gap the bundle carries the passages, as today', async () => {
    serve(ABOVE);
    stubBundleWrites();

    const bundle = await retrieveShadowEvidenceBundle({
      actor: { accountId: 'acct-1', organizationId: 'org-1', athleteId: null, role: 'coach' },
      queryText: 'jab timing drills',
    });

    expect(bundle.availability).toBe('available');
    expect(bundle.items.map((item) => item.chunkId)).toEqual(ABOVE.slice(0, 4).map((row) => row.chunk_id));
  });
});

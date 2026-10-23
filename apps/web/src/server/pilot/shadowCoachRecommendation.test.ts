jest.mock('./db', () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock('./formulas/repository', () => ({ listLatestFormulaResultsPerOutput: jest.fn() }));
jest.mock('./shadowLibrary', () => ({ searchShadowLibrary: jest.fn() }));
jest.mock('./shadowAuditEntries', () => ({ writeShadowAuditEntry: jest.fn() }));
jest.mock('./shadowRecommendations', () => ({ readMedicalStatusOnFile: jest.fn() }));

import { query, withTransaction } from './db';
import { listLatestFormulaResultsPerOutput } from './formulas/repository';
import type { FormulaResult } from './formulas/types';
import { searchShadowLibrary } from './shadowLibrary';
import { readMedicalStatusOnFile } from './shadowRecommendations';
import { writeShadowAuditEntry } from './shadowAuditEntries';
import {
  CoachDraftUnavailableError, eligibleFormula, generateCoachDraft, getCoachDraftOrigins, isNoSupportedAnswer,
  listCoachDraftChoices, openCoachDraft, previewCoachDraft, saveCoachDraft,
  sealCoachDraft, StaleCoachDraftError, unsealCoachDraft, validModelCandidate,
  type DraftModelOutput,
} from './shadowCoachRecommendation';
import { LIBRARY_HAS_NOTHING_YET } from './shadowNoAnswer';

const mockFormula = jest.mocked(listLatestFormulaResultsPerOutput);
const mockSearch = jest.mocked(searchShadowLibrary);
const mockWithTransaction = jest.mocked(withTransaction);
const mockMedical = jest.mocked(readMedicalStatusOnFile);
const mockAudit = jest.mocked(writeShadowAuditEntry);
const mockQuery = jest.mocked(query);

const actor = {
  organizationId: 'gym-a', accountId: 'coach-a', athleteId: null, role: 'coach' as const,
};
const formula = {
  resultId: 'formula-result-a', calculationKey: 'calc-a',
  formulaId: 'MVP-03' as const, formulaVersion: '1',
  outputKey: 'accuracy', policyVersion: '1', parameters: {},
  organizationId: 'gym-a', athleteId: 'athlete-a', contextId: 'round-a',
  value: 45, unit: 'percent' as const,
  computedAt: '2026-10-17T14:00:00.000Z',
  inputObservationIds: ['obs-1'],
  provenance: [],
  validation: { state: 'valid' as const, hardBlocks: [], warnings: [] },
  quality: { confidence: 'MODERATE' as const, completeness: 1, worstSourceQuality: 'moderate' as const },
  unavailableReason: null, humanReviewRequired: false,
} satisfies FormulaResult;
const passage = {
  chunk_id: 'chunk-a', document_id: 'doc-a', source_id: 'src-a',
  subject_id: null, ordinal: 0,
  document_name: 'Verified study', source_title: 'Coach evidence',
  source_publisher: null, source_type: 'peer_reviewed', authority_tier: 1,
  source_status: 'active', publication_date: null,
  text_content: 'Structured repetition improves mastery of the recorded task.',
  score: 0.9, evidence_class: null, boxing_specificity: null,
};
const modelCandidate: DraftModelOutput = {
  recommendationText: 'Ask the athlete to repeat the measured task with coaching feedback.',
  expectedOutcome: 'Coach observes accuracy on the next recorded attempt.',
  citedChunkIds: ['chunk-a'], modelUsed: 'fake-model',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFormula.mockResolvedValue([formula]);
  mockSearch.mockResolvedValue([passage]);
  mockMedical.mockResolvedValue({
    medicalStatusOnFile: 'no_record', medicalStatusId: null, medicalStatusExpiresAt: null,
  });
  mockAudit.mockResolvedValue(undefined);
});

describe('SHADOW F2 coach-requested drafts', () => {
  it('admits an eligible current measurement, never substitutes missing data', () => {
    expect(eligibleFormula(formula)).toBe(true);
    expect(eligibleFormula({ ...formula, value: null })).toBe(false);
    expect(eligibleFormula({ ...formula, validation: { state: 'invalid', hardBlocks: [], warnings: [] } })).toBe(false);
    expect(eligibleFormula({ ...formula, unavailableReason: 'INSUFFICIENT_DATA' })).toBe(false);
    expect(eligibleFormula({ ...formula, quality: { ...formula.quality, worstSourceQuality: 'failed' } })).toBe(false);
  });

  it('returns only current formula choices for the actor-scoped athlete', async () => {
    const choices = await listCoachDraftChoices('gym-a', 'athlete-a');
    expect(choices).toHaveLength(1);
    expect(choices[0].resultId).toBe('formula-result-a');
    expect(mockFormula).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'gym-a', athleteId: 'athlete-a',
    }));
  });

  it('a preview does not write; its origin and exact allowed citations are visible', async () => {
    const result = await previewCoachDraft({
      actor, athleteId: 'athlete-a', resultId: 'formula-result-a',
      question: 'What should the coach practice next?', sessionToken: 'session-secret-a',
      generate: async () => modelCandidate,
    });
    expect(result.kind).toBe('draft');
    if (result.kind !== 'draft') throw Error('Expected draft');
    expect(result.preview.recommendationText).toBe(modelCandidate.recommendationText);
    expect(result.preview.citations[0].chunkId).toBe('chunk-a');
    expect(result.preview.semanticSupportVerified).toBe(false);
    expect(unsealCoachDraft(result.preview.previewToken, 'session-secret-a')?.draftId)
      .toBe(result.preview.draftId);
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'gym-a', actorRole: 'coach', scope: 'subject', subjectId: 'athlete-a',
    }));
  });

  it('refuses a foreign result without reading any Library evidence', async () => {
    const r = await previewCoachDraft({
      actor, athleteId: 'athlete-b', resultId: 'formula-result-a',
      question: 'Review this', sessionToken: 's',
      generate: async () => modelCandidate,
    });
    expect(r).toEqual({ kind: 'abstain', reason: 'source_not_found' });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('refuses absent evidence distinctly from evidence search failure', async () => {
    mockSearch.mockResolvedValueOnce([]);
    const input = {
      actor, athleteId: 'athlete-a', resultId: 'formula-result-a',
      question: 'Review this', sessionToken: 's',
      generate: async () => modelCandidate,
    };
    expect(await previewCoachDraft(input)).toEqual({ kind: 'abstain', reason: 'no_eligible_evidence' });
    mockSearch.mockRejectedValueOnce(new Error('Library down'));
    expect(await previewCoachDraft(input)).toEqual({ kind: 'abstain', reason: 'evidence_unavailable' });
  });

  it('refuses invented citation IDs, including a plausible foreign ID', async () => {
    expect(validModelCandidate({ ...modelCandidate, citedChunkIds: ['chunk-foreign'] }, [passage])).toBe(false);
    expect(validModelCandidate(modelCandidate, [passage])).toBe(true);
    const r = await previewCoachDraft({
      actor, athleteId: 'athlete-a', resultId: 'formula-result-a',
      question: 'Review', sessionToken: 's',
      generate: async () => ({ ...modelCandidate, citedChunkIds: ['chunk-foreign'] }),
    });
    expect(r).toEqual({ kind: 'abstain', reason: 'invalid_generated_candidate' });
  });

  it('marks provider failure as generation unavailable', async () => {
    const r = await previewCoachDraft({
      actor, athleteId: 'athlete-a', resultId: 'formula-result-a',
      question: 'Review', sessionToken: 's',
      generate: async () => null,
    });
    expect(r).toEqual({ kind: 'abstain', reason: 'generation_unavailable' });
  });

  it('rejects token tampering, other session and expired preview', () => {
    const input = {
      version: 1 as const, draftId: 'draft-a',
      issuedAt: 1_000, expiresAt: 901_000, organizationId: 'gym-a',
      athleteId: 'athlete-a', requestedByAccountId: 'coach-a',
      question: 'Q', resultId: 'res', formulaFingerprint: 'hash', formulaId: 'MVP-03',
      modelUsed: 'model-a', recommendationText: 'R', expectedOutcome: 'O',
      citations: [{ chunkId: 'chunk-a', sourceTitle: 'Source', documentName: 'Document', contentHash: 'hash' }],
    };
    const token = sealCoachDraft(input, 'session-a');
    expect(unsealCoachDraft(token, 'session-a', 1_001)?.draftId).toBe('draft-a');
    expect(unsealCoachDraft(token, 'session-b', 1_001)).toBeNull();
    expect(unsealCoachDraft(token, 'session-a', 901_001)).toBeNull();
    expect(unsealCoachDraft(token.slice(0, -2) + 'XX', 'session-a', 1_001)).toBeNull();
  });

  it('refuses saving another coach draft before a transaction is begun', async () => {
    const original = await previewCoachDraft({
      actor, athleteId: 'athlete-a', resultId: 'formula-result-a',
      question: 'Review', sessionToken: 'session-a', generate: async () => modelCandidate,
    });
    if (original.kind !== 'draft') throw Error('Expected preview');
    const saved = await saveCoachDraft({
      actor: { ...actor, accountId: 'coach-b' }, athleteId: 'athlete-a',
      previewToken: original.preview.previewToken, sessionToken: 'session-a',
    });
    expect(saved).toBeNull();
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  it('serializes save on athlete and stores one row with generated provenance', async () => {
    const original = await previewCoachDraft({
      actor, athleteId: 'athlete-a', resultId: 'formula-result-a',
      question: 'Review', sessionToken: 'session-a', generate: async () => modelCandidate,
    });
    if (original.kind !== 'draft') throw Error('Expected preview');
    const record = {
      recommendation_id: 'rec-a', organization_id: 'gym-a', athlete_id: 'athlete-a',
      source_formula_result_id: 'formula-result-a', recommendation_text: modelCandidate.recommendationText,
      expected_outcome: modelCandidate.expectedOutcome,
      status: 'provisional', created_by_account_id: 'coach-a',
      created_at: new Date().toISOString(), expires_at: new Date().toISOString(),
      decided_by_account_id: null, decided_at: null,
    };
    const statements: string[] = [];
    const clientQuery = jest.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('for update')) return { rows: [{ athlete_id: 'athlete-a' }] };
      if (sql.includes('insert into pilot.shadow_recommendations')) return { rows: [record] };
      return { rows: [] };
    });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));
    const saved = await saveCoachDraft({
      actor, athleteId: 'athlete-a', previewToken: original.preview.previewToken,
      sessionToken: 'session-a',
    });
    expect(saved?.recommendation_id).toBe('rec-a');
    expect(statements[0]).toContain('for update');
    expect(statements[1]).toContain('a.after_state');
    expect(statements[2]).toContain("'provisional'");
    expect(mockAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorAccountId: 'coach-a',
      afterState: expect.objectContaining({
        f2: expect.objectContaining({
          generatedBy: 'SHADOW',
          sourceFormulaResultId: 'formula-result-a',
          semanticSupportVerified: false,
        }),
      }),
    }));
  });

  it('reads saved origin receipts without exposing passage text', async () => {
    mockQuery.mockResolvedValueOnce([{
      recommendation_id: 'rec-a',
      f2: {
        generatedBy: 'SHADOW', modelUsed: 'model-x', requestedByAccountId: 'coach-a',
        sourceFormulaResultId: 'formula-result-a', semanticSupportVerified: false,
        citations: [{ chunkId: 'chunk-a', sourceTitle: 'Source', documentName: 'Document', contentHash: 'digest' }],
      },
    }]);
    const origins = await getCoachDraftOrigins('gym-a', 'athlete-a');
    expect(origins['rec-a'].modelUsed).toBe('model-x');
    expect(origins['rec-a'].citations[0]).toEqual({
      chunkId: 'chunk-a', sourceTitle: 'Source', documentName: 'Document',
    });
    expect(JSON.stringify(origins)).not.toContain('digest');
    // The requesting coach's account id (a sign-in address) stays in the audit entry.
    expect(origins['rec-a']).not.toHaveProperty('requestedByAccountId');
    expect(JSON.stringify(origins)).not.toContain('coach-a');
  });

  it('does not invent a model reply when Azure is not configured', async () => {
    const original = process.env.AZURE_AI_ENDPOINT;
    try {
      delete process.env.AZURE_AI_ENDPOINT;
      const r = await generateCoachDraft({ coachQuestion: 'Review', result: formula, evidence: [passage] });
      expect(r).toBeNull();
    } finally {
      if (original === undefined) delete process.env.AZURE_AI_ENDPOINT;
      else process.env.AZURE_AI_ENDPOINT = original;
    }
  });
});

// What main changed under #1727 (F-161 score-gap gate #1817, cite or abstain
// #1820, staff names #1829), and the save path's live-row lock.
describe('SHADOW F2 on current main: abstain plainly, cite nothing invented', () => {
  const ask = (overrides: Partial<Parameters<typeof previewCoachDraft>[0]> = {}) => previewCoachDraft({
    actor, athleteId: 'athlete-a', resultId: 'formula-result-a',
    question: 'What should the coach practice next?', sessionToken: 'session-a',
    generate: async () => modelCandidate,
    ...overrides,
  });

  it('a gated Library search (score-gap abstention) makes no draft and calls no model', async () => {
    // What searchShadowLibrary returns when the gate abstains: no evidence,
    // every ranked passage only as "closest" in the detail object.
    mockSearch.mockImplementationOnce(async (_input, detail) => {
      if (detail) { detail.nearest = [passage]; detail.mode = 'semantic'; }
      return [];
    });
    const generate = jest.fn(async () => modelCandidate);
    const r = await ask({ generate });
    expect(r).toEqual({ kind: 'abstain', reason: 'no_eligible_evidence' });
    expect(generate).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain('chunk-a');
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  it('an ineligible formula result makes no draft, searches nothing and calls no model', async () => {
    mockFormula.mockResolvedValue([{ ...formula, value: null, unavailableReason: 'INSUFFICIENT_DATA' }]);
    const generate = jest.fn(async () => modelCandidate);
    expect(await ask({ generate })).toEqual({ kind: 'abstain', reason: 'source_unavailable' });
    expect(mockSearch).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('searches the Library with the coach question alone, not the formula id', async () => {
    await ask();
    expect(mockSearch).toHaveBeenCalledWith(expect.objectContaining({
      queryText: 'What should the coach practice next?',
    }));
  });

  it('the model saying the Library has nothing, uncited, is an honest no-draft', async () => {
    const r = await ask({
      generate: async () => ({
        ...modelCandidate, recommendationText: LIBRARY_HAS_NOTHING_YET, expectedOutcome: '', citedChunkIds: [],
      }),
    });
    expect(r).toEqual({ kind: 'abstain', reason: 'no_supported_answer' });
  });

  it('a "nothing on that yet" text is not a proposal even when it cites a passage', async () => {
    const r = await ask({
      generate: async () => ({ ...modelCandidate, recommendationText: `Sorry, ${LIBRARY_HAS_NOTHING_YET}.` }),
    });
    expect(r).toEqual({ kind: 'abstain', reason: 'no_supported_answer' });
  });

  it('an empty proposal is a no-draft; an uncited real proposal is still refused as unsourced', async () => {
    expect(await ask({ generate: async () => ({ ...modelCandidate, recommendationText: '  ' }) }))
      .toEqual({ kind: 'abstain', reason: 'no_supported_answer' });
    expect(await ask({ generate: async () => ({ ...modelCandidate, citedChunkIds: [] }) }))
      .toEqual({ kind: 'abstain', reason: 'invalid_generated_candidate' });
    expect(isNoSupportedAnswer(modelCandidate)).toBe(false);
  });

  it('save is refused as stale when the same search now abstains, before any transaction', async () => {
    const original = await ask();
    if (original.kind !== 'draft') throw Error('Expected preview');
    mockSearch.mockResolvedValueOnce([]);
    await expect(saveCoachDraft({
      actor, athleteId: 'athlete-a', previewToken: original.preview.previewToken, sessionToken: 'session-a',
    })).rejects.toBeInstanceOf(StaleCoachDraftError);
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  it('save locks only a live athlete row; a deleted athlete gets nothing inserted', async () => {
    const original = await ask();
    if (original.kind !== 'draft') throw Error('Expected preview');
    const statements: string[] = [];
    const clientQuery = jest.fn(async (sql: string) => { statements.push(sql); return { rows: [] }; });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));
    const saved = await saveCoachDraft({
      actor, athleteId: 'athlete-a', previewToken: original.preview.previewToken, sessionToken: 'session-a',
    });
    expect(saved).toBeNull();
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/deleted_at is null\s+for update/);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('a second save of the same draft returns the stored row and inserts nothing', async () => {
    const original = await ask();
    if (original.kind !== 'draft') throw Error('Expected preview');
    const stored = { recommendation_id: 'rec-a', athlete_id: 'athlete-a', status: 'provisional' };
    const statements: string[] = [];
    const params: unknown[][] = [];
    const clientQuery = jest.fn(async (sql: string, values: unknown[]) => {
      statements.push(sql);
      params.push(values);
      if (sql.includes('for update')) return { rows: [{ athlete_id: 'athlete-a' }] };
      if (sql.includes("->'f2'->>'draftId'")) return { rows: [stored] };
      return { rows: [] };
    });
    mockWithTransaction.mockImplementation(async (callback) => callback({ query: clientQuery } as never));
    const saved = await saveCoachDraft({
      actor, athleteId: 'athlete-a', previewToken: original.preview.previewToken, sessionToken: 'session-a',
    });
    expect(saved).toBe(stored);
    expect(params[1]).toEqual(['gym-a', 'athlete-a', original.preview.draftId, 'coach-a']);
    expect(statements.some((sql) => sql.includes('insert into'))).toBe(false);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('only a coach previews or saves', async () => {
    for (const role of ['organization_admin', 'admin', 'athlete', 'parent', 'platform_owner'] as const) {
      expect(await ask({ actor: { ...actor, role } })).toEqual({ kind: 'abstain', reason: 'invalid_request' });
      expect(await saveCoachDraft({
        actor: { ...actor, role }, athleteId: 'athlete-a', previewToken: 'x.y', sessionToken: 'session-a',
      })).toBeNull();
    }
    expect(mockFormula).not.toHaveBeenCalled();
  });
});

describe('generateCoachDraft against a stubbed provider (no real model call)', () => {
  const ENV = ['AZURE_AI_ENDPOINT', 'AZURE_AI_KEY', 'AZURE_AI_DEPLOYMENT_NAME'] as const;
  const saved: Record<string, string | undefined> = {};
  const realFetch = global.fetch;
  let sent: Array<{ url: string; body: Record<string, unknown> }> = [];

  function reply(content: unknown, ok = true) {
    sent = [];
    global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return { ok, json: async () => ({ choices: [{ message: { content } }] }) } as Response;
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    for (const key of ENV) saved[key] = process.env[key];
    process.env.AZURE_AI_ENDPOINT = 'https://stub.invalid';
    process.env.AZURE_AI_KEY = 'stub-key';
    process.env.AZURE_AI_DEPLOYMENT_NAME = 'stub-deployment';
  });
  afterEach(() => {
    jest.mocked(console.error).mockRestore();
    global.fetch = realFetch;
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const input = { coachQuestion: 'Review', result: formula, evidence: [passage] };
  const FENCE = '`'.repeat(3);

  it('asks for the Library-has-nothing words and no citations when nothing supports a proposal', async () => {
    reply(JSON.stringify({ recommendationText: 'R', expectedOutcome: 'O', citedChunkIds: ['chunk-a'] }));
    await generateCoachDraft(input);
    const messages = sent[0].body.messages as Array<{ role: string; content: string }>;
    expect(messages[0].content).toContain(LIBRARY_HAS_NOTHING_YET);
    expect(sent[0].body).not.toHaveProperty('temperature');
    expect(sent[0].url).toContain('/openai/deployments/stub-deployment/');
  });

  it('reads a JSON reply wrapped in a code fence', async () => {
    const json = JSON.stringify({ recommendationText: 'R', expectedOutcome: 'O', citedChunkIds: ['chunk-a'] });
    reply(`${FENCE}json\n${json}\n${FENCE}`);
    expect(await generateCoachDraft(input)).toEqual({
      recommendationText: 'R', expectedOutcome: 'O', citedChunkIds: ['chunk-a'], modelUsed: 'stub-deployment',
    });
  });

  it('a reply with no recommendationText field is unavailable, not "the Library has nothing"', async () => {
    reply(JSON.stringify({ expectedOutcome: 'O', citedChunkIds: [] }));
    expect(await generateCoachDraft(input)).toBeNull();
  });

  it('a provider error or unreadable reply is unavailable, logged without the reply or the key', async () => {
    reply('not json');
    expect(await generateCoachDraft(input)).toBeNull();
    reply(JSON.stringify({ recommendationText: 'R' }), false);
    expect(await generateCoachDraft(input)).toBeNull();
    const logged = JSON.stringify(jest.mocked(console.error).mock.calls);
    expect(logged).toContain('unreadable_reply');
    expect(logged).not.toContain('stub-key');
    expect(logged).not.toContain('not json');
  });
});

// Review round (lane LF2 reviewers): the save names only what the preview was
// for, tells "expired" and "outage" apart from "changed", and a cited proposal
// is read for the prompt's own no-answer words only.
describe('SHADOW F2 save: what the signed preview binds, and what each refusal means', () => {
  async function draftFor(athleteId = 'athlete-a') {
    const r = await previewCoachDraft({
      actor, athleteId, resultId: 'formula-result-a', question: 'Review', sessionToken: 'session-a',
      generate: async () => modelCandidate,
    });
    if (r.kind !== 'draft') throw Error('Expected preview');
    return r.preview;
  }

  it('a preview for one athlete cannot be saved for another', async () => {
    const draft = await draftFor('athlete-a');
    mockFormula.mockClear();
    expect(await saveCoachDraft({
      actor, athleteId: 'athlete-b', previewToken: draft.previewToken, sessionToken: 'session-a',
    })).toBeNull();
    expect(mockFormula).not.toHaveBeenCalled();
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  it('a preview made in one gym cannot be saved in another', async () => {
    const draft = await draftFor('athlete-a');
    mockFormula.mockClear();
    expect(await saveCoachDraft({
      actor: { ...actor, organizationId: 'gym-b' }, athleteId: 'athlete-a',
      previewToken: draft.previewToken, sessionToken: 'session-a',
    })).toBeNull();
    expect(mockFormula).not.toHaveBeenCalled();
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  it('an expired preview of this session is out of date (stale), not "not found"', async () => {
    const token = sealCoachDraft({
      version: 1, draftId: 'draft-old', issuedAt: 1_000, expiresAt: 1_000 + 15 * 60 * 1000,
      organizationId: 'gym-a', athleteId: 'athlete-a', requestedByAccountId: 'coach-a',
      question: 'Q', resultId: 'formula-result-a', formulaFingerprint: 'f', formulaId: 'MVP-03',
      modelUsed: 'm', recommendationText: 'R', expectedOutcome: 'O',
      citations: [{ chunkId: 'chunk-a', sourceTitle: 'S', documentName: 'D', contentHash: 'h' }],
    }, 'session-a');
    expect(openCoachDraft(token, 'session-a')).toEqual({ status: 'expired' });
    // A forged or foreign token is never reported as merely expired.
    expect(openCoachDraft(token, 'session-b')).toEqual({ status: 'invalid' });
    await expect(saveCoachDraft({
      actor, athleteId: 'athlete-a', previewToken: token, sessionToken: 'session-a',
    })).rejects.toBeInstanceOf(StaleCoachDraftError);
    expect(mockFormula).not.toHaveBeenCalled();
  });

  it('a Library outage at save is "unavailable", not "the sources changed"; a refusal is not found', async () => {
    const draft = await draftFor();
    mockSearch.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(saveCoachDraft({
      actor, athleteId: 'athlete-a', previewToken: draft.previewToken, sessionToken: 'session-a',
    })).rejects.toBeInstanceOf(CoachDraftUnavailableError);
    mockSearch.mockRejectedValueOnce(new Error('Forbidden: athlete does not belong to organization'));
    expect(await saveCoachDraft({
      actor, athleteId: 'athlete-a', previewToken: draft.previewToken, sessionToken: 'session-a',
    })).toBeNull();
    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  it('a cited proposal that lacks context for one point is still a draft', async () => {
    const candidate = {
      ...modelCandidate,
      recommendationText: 'Repeat the measured task with feedback; I need more context on round length.',
    };
    expect(isNoSupportedAnswer(candidate)).toBe(false);
    expect(isNoSupportedAnswer({ ...candidate, citedChunkIds: [] })).toBe(true);
    const r = await previewCoachDraft({
      actor, athleteId: 'athlete-a', resultId: 'formula-result-a', question: 'Review', sessionToken: 'session-a',
      generate: async () => candidate,
    });
    expect(r.kind).toBe('draft');
  });

  it('a preview too long for the save to open is not offered', async () => {
    mockSearch.mockResolvedValueOnce([{ ...passage, source_title: 'T'.repeat(70_000) }]);
    const r = await previewCoachDraft({
      actor, athleteId: 'athlete-a', resultId: 'formula-result-a', question: 'Review', sessionToken: 'session-a',
      generate: async () => modelCandidate,
    });
    expect(r).toEqual({ kind: 'abstain', reason: 'invalid_generated_candidate' });
  });
});

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
  eligibleFormula, generateCoachDraft, getCoachDraftOrigins,
  listCoachDraftChoices, previewCoachDraft, saveCoachDraft,
  sealCoachDraft, unsealCoachDraft, validModelCandidate,
  type DraftModelOutput,
} from './shadowCoachRecommendation';

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

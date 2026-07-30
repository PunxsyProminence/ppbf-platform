jest.mock('./db', () => ({
  withTransaction: jest.fn(),
}));
jest.mock('./shadowLibrary', () => ({
  searchShadowLibrary: jest.fn(),
}));

import { withTransaction } from './db';
import { retrieveShadowEvidenceBundle } from './shadowEvidence';
import { searchShadowLibrary } from './shadowLibrary';

const mockWithTransaction = jest.mocked(withTransaction);
const mockSearchShadowLibrary = jest.mocked(searchShadowLibrary);
const actor = {
  accountId: 'account-a',
  organizationId: 'org-a',
  athleteId: null,
  role: 'coach' as const,
};

describe('SHADOW evidence bundles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates bounded server-owned citations from the authenticated organization and subject', async () => {
    const privateQuery = 'Compare the private athlete training note';
    const privateExcerpt = 'Private athlete note: worked only approved defensive drills.';
    mockSearchShadowLibrary.mockResolvedValue([{
      chunk_id: 'chunk-a',
      document_id: 'doc-a',
      source_id: 'source-a',
      subject_id: 'athlete-a',
      ordinal: 0,
      document_name: 'Approved training record',
      source_title: 'Approved coaching source',
      source_publisher: null,
      source_type: 'coach_observation',
      authority_tier: 2,
      source_status: 'active',
      publication_date: null,
      text_content: privateExcerpt,
      score: 50,
    }]);
    const clientQuery = jest.fn(async (sql: string, params: unknown[]) => ({
      rows: sql.includes('returning evidence_id') ? [{ evidence_id: params[0] }] : [],
    }));
    mockWithTransaction.mockImplementation(async (callback) => callback({
      query: clientQuery,
    } as never));

    const bundle = await retrieveShadowEvidenceBundle({
      actor,
      subjectId: 'athlete-a',
      queryText: privateQuery,
    });

    expect(mockSearchShadowLibrary).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-a',
      actorAccountId: 'account-a',
      scope: 'subject',
      subjectId: 'athlete-a',
      limit: 4,
    }));
    expect(bundle.bundleId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bundle.items).toHaveLength(1);
    expect(bundle.items[0].evidenceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bundle.context).toContain(bundle.items[0].token);
    expect(bundle.context).toContain(privateExcerpt);

    const persistedParameters = JSON.stringify(clientQuery.mock.calls.map((call) => call[1]));
    expect(persistedParameters).not.toContain(privateQuery);
    expect(persistedParameters).not.toContain(privateExcerpt);
    expect(String(clientQuery.mock.calls[1][0])).toContain('c.organization_id = $3');
    expect(clientQuery.mock.calls[1][1]).toEqual(expect.arrayContaining([
      'org-a',
      'account-a',
      'source-a',
      'doc-a',
      'chunk-a',
      'athlete-a',
    ]));
  });

  it('persists an explicit unavailable bundle when no qualified evidence exists', async () => {
    mockSearchShadowLibrary.mockResolvedValue([]);
    const clientQuery = jest.fn().mockResolvedValue({ rows: [] });
    mockWithTransaction.mockImplementation(async (callback) => callback({
      query: clientQuery,
    } as never));

    const bundle = await retrieveShadowEvidenceBundle({
      actor,
      queryText: 'What evidence is available?',
    });

    expect(bundle.availability).toBe('unavailable');
    expect(bundle.bundleId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bundle.allowedEvidenceIds).toEqual([]);
    expect(bundle.context).toContain('EVIDENCE UNAVAILABLE');
    expect(clientQuery).toHaveBeenCalledTimes(1);
    expect(clientQuery.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'org-a',
      'account-a',
      'unavailable',
      0,
    ]));
  });

  it('fails closed if evidence loses approval between search and bundle persistence', async () => {
    mockSearchShadowLibrary.mockResolvedValue([{
      chunk_id: 'chunk-a',
      document_id: 'doc-a',
      source_id: 'source-a',
      subject_id: null,
      ordinal: 0,
      document_name: 'Document',
      source_title: 'Source',
      source_publisher: null,
      source_type: 'internal_policy',
      authority_tier: 1,
      source_status: 'active',
      publication_date: null,
      text_content: 'Approved text at search time.',
      score: 50,
    }]);
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockWithTransaction.mockImplementation(async (callback) => callback({
      query: clientQuery,
    } as never));

    await expect(retrieveShadowEvidenceBundle({
      actor,
      queryText: 'Find approved policy',
    })).rejects.toThrow('SHADOW_EVIDENCE_QUALIFICATION_CHANGED');
  });
});

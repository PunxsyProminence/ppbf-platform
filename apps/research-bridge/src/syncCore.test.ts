import assert from 'node:assert/strict';
import test from 'node:test';

import { toIndexDocuments } from './syncCore.js';
import type { ResearchExport } from './schemas.js';

test('indexes only the explicit sanitized export fields', () => {
  const snapshot: ResearchExport = {
    schema_version: '1',
    classification: 'sanitized-staging-only',
    generated_at: '2026-08-06T20:00:00.000Z',
    research_needs: [{
      id: 'need_0123456789abcdef',
      title: 'Study adaptive stance cues',
      knowledge_gap: 'Evidence is incomplete.',
      evidence_status: 'missing',
      confidence_tier: 'INSUFFICIENT',
      verification_state: 'unknown',
      status: 'open',
      created_at: '2026-08-06T19:00:00.000Z',
    }],
    approved_evidence: [{
      id: 'evidence_0123456789ab',
      title: 'Adaptive boxing review',
      publisher: 'Example Journal',
      source_type: 'peer_reviewed',
      authority_tier: 1,
      url: 'https://example.org/review',
      publication_date: '2026-01-01',
      excerpt: 'Reviewed evidence excerpt.',
    }],
  };

  const documents = toIndexDocuments(snapshot);
  assert.equal(documents.length, 2);
  assert.deepEqual(Object.keys(documents[0]).sort(), [
    'authorityTier', 'content', 'id', 'kind', 'publicationDate', 'publisher', 'sourceType', 'status', 'syncedAt', 'title', 'url',
  ]);
  assert.equal(documents[0].kind, 'research_need');
  assert.equal(documents[1].kind, 'approved_evidence');
  assert.equal(documents[1].publisher, 'Example Journal');
});

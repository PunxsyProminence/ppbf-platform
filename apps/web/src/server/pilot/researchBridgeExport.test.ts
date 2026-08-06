import {
  listApprovedGlobalEvidenceForResearchBridge,
} from './shadowLibrary';
import { listShadowResearchRequirements } from './shadowResearch';
import {
  buildResearchBridgeExport,
  sanitizeApprovedEvidence,
  sanitizeResearchNeeds,
} from './researchBridgeExport';

jest.mock('./shadowLibrary', () => ({
  listApprovedGlobalEvidenceForResearchBridge: jest.fn(),
}));

jest.mock('./shadowResearch', () => ({
  listShadowResearchRequirements: jest.fn(),
}));

const mockNeeds = listShadowResearchRequirements as jest.MockedFunction<typeof listShadowResearchRequirements>;
const mockEvidence = listApprovedGlobalEvidenceForResearchBridge as jest.MockedFunction<typeof listApprovedGlobalEvidenceForResearchBridge>;

function need(overrides: Record<string, unknown> = {}) {
  return {
    research_requirement_id: 17,
    organization_id: 'org-private-id',
    source_event_name: 'SHADOW_LIBRARY_CAPABILITY_GAP_DETECTED',
    source_entity_type: 'shadow_library_capability_map',
    source_entity_id: 'balance-cues',
    research_requirement: 'Study adaptive stance cues',
    knowledge_gap: 'Email coach@example.org or call 585-555-0101',
    evidence_label: null,
    source_status: 'missing',
    source_confidence_tier: 'INSUFFICIENT',
    source_verification_state: 'unknown',
    status: 'open',
    created_by_account_id: 'acct-private',
    created_by_role: 'system',
    metadata: {},
    created_at: '2026-08-06T18:00:00.000Z',
    resolved_at: null,
    ...overrides,
  } as never;
}

describe('research bridge sanitizer', () => {
  test('exports only non-subject system research gaps and uses opaque IDs', () => {
    const rows = sanitizeResearchNeeds([
      need(),
      need({ research_requirement_id: 18, source_entity_type: 'shadow_library_claim', metadata: { scope: 'subject', subject_id: 'athlete-private' } }),
      need({ research_requirement_id: 19, source_entity_type: 'manual_note' }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^need_[a-f0-9]{32}$/);
    expect(rows[0].id).not.toContain('17');
    expect(rows[0].knowledge_gap).toContain('[REDACTED_EMAIL]');
    expect(rows[0].knowledge_gap).toContain('[REDACTED_PHONE]');
    expect(rows[0]).not.toHaveProperty('organization_id');
  });

  test('exports only allowlisted evidence fields and redacts obvious identifiers', () => {
    const rows = sanitizeApprovedEvidence('org-private-id', [{
      chunk_id: 'chunk-private-id',
      source_title: 'Adaptive Boxing Review',
      source_publisher: 'Journal editor@example.org',
      source_type: 'peer_reviewed',
      authority_tier: 1,
      source_url: 'https://example.org/review',
      publication_date: '2026-01-01',
      text_content: 'Contact 585-555-0101 for private notes.',
    }]);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^evidence_[a-f0-9]{32}$/);
    expect(rows[0].publisher).toContain('[REDACTED_EMAIL]');
    expect(rows[0].excerpt).toContain('[REDACTED_PHONE]');
    expect(rows[0]).not.toHaveProperty('chunk_id');
  });

  test('builds the export from the configured organization only', async () => {
    mockNeeds.mockResolvedValueOnce([need()]);
    mockEvidence.mockResolvedValueOnce([]);

    const payload = await buildResearchBridgeExport('org-configured');

    expect(mockNeeds).toHaveBeenCalledWith('org-configured');
    expect(mockEvidence).toHaveBeenCalledWith({ organizationId: 'org-configured', limit: 2_000 });
    expect(payload.classification).toBe('sanitized-staging-only');
  });
});

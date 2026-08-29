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

// requireActual for the rest: the eligibility filter now asks
// shadowResearch's own subjectAthleteIdOf which athlete a row is about, and a
// bare-object mock would leave that helper undefined and turn every
// sanitizer test into a TypeError instead of an assertion. Only the
// database-reaching list function is stubbed.
jest.mock('./shadowResearch', () => {
  const actual = jest.requireActual('./shadowResearch');
  return { ...actual, listShadowResearchRequirements: jest.fn() };
});

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
    // The dedicated column. Defaulted here so a row that names no athlete
    // says so in the same field the storage layer actually populates,
    // rather than by the field being absent from the fixture.
    subject_id: null,
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

  // WHICH ATHLETE A ROW IS ABOUT is decided by shadowResearch's
  // subjectAthleteIdOf, which reads the dedicated subject_id COLUMN first and
  // only then the two metadata fallbacks. The filter here used to inspect
  // metadata alone, so a row whose column named a child -- exactly what
  // pilot_slice_postgres_research_requirement_subject_migration.sql added the
  // column to record -- read as subject-less and was exported.
  describe('a row that names an athlete is not exportable, whichever field names it', () => {
    test('the subject_id column alone excludes the row, with empty metadata', () => {
      // The reachable shape: POST /api/pilot/shadow/research-requirements
      // passes source_entity_type straight from the request body, so an
      // allowlisted value, a subject_id, and no metadata at all is a row a
      // caller can write today.
      const rows = sanitizeResearchNeeds([
        need({
          research_requirement_id: 21,
          source_entity_type: 'shadow_library_capability_map',
          subject_id: 'athlete-private',
          metadata: {},
        }),
      ]);

      expect(rows).toEqual([]);
    });

    test('the subject_id column excludes a scoped claim row too', () => {
      const rows = sanitizeResearchNeeds([
        need({
          research_requirement_id: 22,
          source_entity_type: 'shadow_library_claim',
          subject_id: 'athlete-private',
          metadata: { scope: 'scoped' },
        }),
      ]);

      expect(rows).toEqual([]);
    });

    test('a blank or whitespace-only subject_id is not an athlete, and does not exclude', () => {
      // namedAthleteId treats a blank as absent, the same way the write path
      // does. Asserted so "excluded" cannot quietly come to mean "any
      // non-null column value".
      const rows = sanitizeResearchNeeds([
        need({ research_requirement_id: 23, subject_id: '   ' }),
      ]);

      expect(rows).toHaveLength(1);
    });

    // The metadata fallbacks are PRESERVED, not replaced. subject_id and
    // athlete_id are the two the canonical resolver reads; the other three are
    // person-naming keys this filter has always refused and still must.
    test.each([
      ['subject_id', { subject_id: 'athlete-private' }],
      ['athlete_id', { athlete_id: 'athlete-private' }],
      ['account_id', { account_id: 'acct-private' }],
      ['parent_id', { parent_id: 'acct-guardian' }],
      ['guardian_id', { guardian_id: 'acct-guardian' }],
    ])('metadata.%s still excludes the row', (_key, metadata) => {
      const rows = sanitizeResearchNeeds([
        need({ research_requirement_id: 24, subject_id: null, metadata }),
      ]);

      expect(rows).toEqual([]);
    });

    test('a genuinely subject-less requirement is still exported', () => {
      // The other direction, and the reason this is a pair: an org-wide
      // capability-coverage gap names no child in the column and none in
      // metadata, and the research bridge is for exactly these.
      const rows = sanitizeResearchNeeds([
        need({ research_requirement_id: 25, subject_id: null, metadata: {} }),
        need({
          research_requirement_id: 26,
          source_entity_type: 'shadow_library_claim',
          subject_id: null,
          metadata: { scope: 'scoped' },
        }),
      ]);

      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.id)).toEqual([
        expect.stringMatching(/^need_[a-f0-9]{32}$/),
        expect.stringMatching(/^need_[a-f0-9]{32}$/),
      ]);
    });
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

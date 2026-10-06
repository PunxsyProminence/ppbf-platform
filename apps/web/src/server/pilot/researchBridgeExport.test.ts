import {
  listApprovedGlobalEvidenceForResearchBridge,
  listShadowCapabilityCoverage,
} from './shadowLibrary';
import { listShadowResearchRequirements } from './shadowResearch';
import {
  buildResearchBridgeExport,
  sanitizeApprovedEvidence,
  sanitizeResearchNeeds,
} from './researchBridgeExport';

jest.mock('./shadowLibrary', () => ({
  listApprovedGlobalEvidenceForResearchBridge: jest.fn(),
  listShadowCapabilityCoverage: jest.fn(),
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
const mockRules = listShadowCapabilityCoverage as jest.MockedFunction<typeof listShadowCapabilityCoverage>;

// The curator's capability rules (pilot.shadow_library_capability_map, as
// listShadowCapabilityCoverage reads them). The export takes every field of a
// gap's text from here, never from the requirement row.
function rule(capabilityKey: string, overrides: Record<string, unknown> = {}) {
  return {
    capability_map_id: `cap_${capabilityKey}`,
    organization_id: 'org-private-id',
    capability_key: capabilityKey,
    required_source_types: ['peer_reviewed', 'textbook'],
    minimum_authority_tier: 2,
    minimum_source_count: 2,
    coverage_state: 'uncovered',
    matched_sources: 0,
    last_evaluated_at: null,
    created_at: '2026-08-06T18:00:00.000Z',
    updated_at: '2026-08-06T18:00:00.000Z',
    ...overrides,
  } as never;
}

const RULES = [rule('balance_cues'), rule('coach_cue_feedback')];

function sanitizeNeeds(rows: never[], rules: never[] = RULES) {
  return sanitizeResearchNeeds(rows, rules);
}

const CAPABILITY_METADATA = {
  capability_key: 'balance_cues',
  coverage_state: 'uncovered',
  matched_sources: 0,
  minimum_source_count: 2,
  minimum_authority_tier: 2,
  required_source_types: ['peer_reviewed', 'textbook'],
};

function need(overrides: Record<string, unknown> = {}) {
  return {
    research_requirement_id: 17,
    organization_id: 'org-private-id',
    source_event_name: 'SHADOW_LIBRARY_CAPABILITY_GAP_DETECTED',
    source_entity_type: 'shadow_library_capability_map',
    source_entity_id: 'balance_cues',
    research_requirement: 'Study adaptive stance cues',
    knowledge_gap: 'Email coach@example.org or call 585-555-0101',
    evidence_label: null,
    source_status: 'missing',
    source_confidence_tier: 'INSUFFICIENT',
    source_verification_state: 'unknown',
    status: 'open',
    created_by_account_id: 'acct-private',
    created_by_role: 'system',
    // The shape syncCapabilityGapRequirement writes. The exporter rebuilds the
    // need's text from these fields and never ships the stored prose.
    metadata: { ...CAPABILITY_METADATA },
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
    const rows = sanitizeNeeds([
      need(),
      need({ research_requirement_id: 18, source_entity_type: 'shadow_library_claim', metadata: { scope: 'subject', subject_id: 'athlete-private' } }),
      need({ research_requirement_id: 19, source_entity_type: 'manual_note' }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^need_[a-f0-9]{32}$/);
    expect(rows[0].id).not.toContain('17');
    // The stored prose never leaves; the text is the system's own template.
    expect(rows[0].knowledge_gap).not.toContain('example.org');
    expect(rows[0].knowledge_gap).not.toContain('585');
    expect(rows[0].title).toBe('Close SHADOW Library coverage gap for capability balance_cues');
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
      const rows = sanitizeNeeds([
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
      const rows = sanitizeNeeds([
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
      const rows = sanitizeNeeds([
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
      const rows = sanitizeNeeds([
        need({ research_requirement_id: 24, subject_id: null, metadata: { ...CAPABILITY_METADATA, ...metadata } }),
      ]);

      expect(rows).toEqual([]);
    });

    test('a genuinely subject-less requirement is still exported', () => {
      // The other direction, and the reason this is a pair: an org-wide
      // capability-coverage gap names no child in the column and none in
      // metadata, and the research bridge is for exactly these.
      const rows = sanitizeNeeds([
        need({ research_requirement_id: 25, subject_id: null }),
        need({
          research_requirement_id: 26,
          subject_id: null,
          source_entity_id: 'coach_cue_feedback',
          metadata: { ...CAPABILITY_METADATA, capability_key: 'coach_cue_feedback' },
        }),
      ]);

      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.id)).toEqual([
        expect.stringMatching(/^need_[a-f0-9]{32}$/),
        expect.stringMatching(/^need_[a-f0-9]{32}$/),
      ]);
    });
  });

  // CL-C5. Any organization member may POST a research requirement and pick
  // its source_entity_type, and every member's Library question becomes a
  // scoped claim row whose knowledge_gap quotes the question. Only text the
  // system itself composes may leave.
  describe('only system-composed text is exportable', () => {
    test("a subject-less Library claim row is never exported: its text is the member's question", () => {
      const rows = sanitizeNeeds([
        need({
          research_requirement_id: 30,
          source_event_name: 'SHADOW_LIBRARY_CLAIM_GAP_DETECTED',
          source_entity_type: 'shadow_library_claim',
          source_entity_id: 'scoped:global:1',
          knowledge_gap: 'Question lacks sufficient SHADOW Library evidence: my son Jake keeps getting headaches.',
          metadata: { scope: 'scoped', subject_id: null, question: 'my son Jake keeps getting headaches' },
        }),
      ]);

      expect(rows).toEqual([]);
    });

    test.each([
      ['another source_event_name', { source_event_name: 'MEMBER_NOTE' }],
      ['a capability key the gym has no rule for', { source_entity_id: 'jane_doe_concussion' }],
      ['a capability key that is prose, not a key', { source_entity_id: 'Jake hit his head at practice' }],
    ])('a capability-map row with %s is not exported', (_label, overrides) => {
      expect(sanitizeNeeds([need(overrides)])).toEqual([]);
    });

    test.each([
      ['now graded covered', { coverage_state: 'covered' }],
      ['naming a source type the Library does not have', { required_source_types: ['jane_doe_concussion'] }],
      ['with a non-integer minimum', { minimum_source_count: 'Jake' }],
    ])('a gap whose rule is %s is not exported', (_label, overrides) => {
      expect(sanitizeNeeds([need()], [rule('balance_cues', overrides)])).toEqual([]);
    });

    // The resolve action merges caller metadata into a row it may resolve, and
    // every member role but parent may resolve an organization-wide gap. Words
    // put there must not come out (adversarial review of this change).
    test('metadata a member merged into a gap ticket never reaches the export', () => {
      const rows = sanitizeNeeds([
        need({
          status: 'resolved',
          metadata: {
            ...CAPABILITY_METADATA,
            required_source_types: ['jane', 'doe', 'age', 'eleven', 'concussion'],
            minimum_source_count: 7,
            coverage_state: 'partial',
            matched_sources: 3,
          },
        }),
      ]);

      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).not.toMatch(/jane|doe|eleven|concussion/);
      expect(rows[0].knowledge_gap).toContain('Required source types: peer_reviewed, textbook.');
      expect(rows[0].knowledge_gap).toContain('Minimum source count: 2.');
    });

    test('a forged capability-map row carries none of its stored prose out', () => {
      const rows = sanitizeNeeds([
        need({
          research_requirement: 'Athlete Jake Smith, age 12, concussion history',
          knowledge_gap: 'Jake Smith had two concussions this season; mother is worried.',
        }),
      ]);

      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).not.toMatch(/Jake|concussion|mother/);
      expect(rows[0].knowledge_gap).toBe(
        'No qualifying SHADOW Library sources currently support capability balance_cues. Required source types: peer_reviewed, textbook. Minimum authority tier: 2. Minimum source count: 2.',
      );
    });
  });

  // CL-C11. The bridge rejects a whole export that breaks its schema
  // (apps/research-bridge/src/schemas.ts): at most 500 needs, 2,000 evidence
  // rows and 2,000-character URLs. A rejected export stops the delete step, so
  // retracted evidence stays served. The exporter keeps inside those limits.
  describe('the export stays inside the bridge schema limits', () => {
    test('at most 500 research needs, newest first', () => {
      const rows = Array.from({ length: 501 }, (_unused, index) => need({
        research_requirement_id: 1_000 + index,
        source_entity_id: `cap_${index}`,
        metadata: { ...CAPABILITY_METADATA, capability_key: `cap_${index}` },
        created_at: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
      }));

      const exported = sanitizeNeeds(rows, rows.map((_row, index) => rule(`cap_${index}`)));

      expect(exported).toHaveLength(500);
      expect(exported[0].title).toMatch(/ cap_500$/);
      expect(exported.some((row) => row.title.endsWith(' cap_0'))).toBe(false);
    });

    test('an evidence URL over 2,000 characters is dropped, not shipped', () => {
      const [row] = sanitizeApprovedEvidence('org-private-id', [{
        chunk_id: 'chunk-long-url',
        source_title: 'Long URL source',
        source_publisher: null,
        source_type: 'peer_reviewed',
        authority_tier: 1,
        source_url: `https://example.org/${'a'.repeat(2_100)}`,
        publication_date: null,
        text_content: 'Open-licence excerpt.',
      }]);

      expect(row.url).toBeNull();
    });

    test('at most 2,000 evidence rows', () => {
      const rows = Array.from({ length: 2_001 }, (_unused, index) => ({
        chunk_id: `chunk-${index}`,
        source_title: 'Source',
        source_publisher: null,
        source_type: 'peer_reviewed' as const,
        authority_tier: 1,
        source_url: null,
        publication_date: null,
        text_content: 'Excerpt.',
      }));

      expect(sanitizeApprovedEvidence('org-private-id', rows)).toHaveLength(2_000);
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
    mockRules.mockResolvedValueOnce(RULES);
    mockEvidence.mockResolvedValueOnce([]);

    const payload = await buildResearchBridgeExport('org-configured');

    expect(mockNeeds).toHaveBeenCalledWith('org-configured');
    expect(mockRules).toHaveBeenCalledWith('org-configured');
    expect(payload.research_needs).toHaveLength(1);
    expect(mockEvidence).toHaveBeenCalledWith({ organizationId: 'org-configured', limit: 2_000 });
    expect(payload.classification).toBe('sanitized-staging-only');
  });
});

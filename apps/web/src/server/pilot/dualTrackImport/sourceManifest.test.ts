import {
  type DuplicateGroup,
  type SourceManifest,
  type SourceRecord,
  validateDuplicateGroup,
  validateSourceManifest,
} from './sourceManifest';

function exampleSource(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    sourceKey: 'src-example-001',
    system: 'microsoft',
    title: 'Example source title',
    athleteSpecific: true,
    classification: 'support_reference',
    contentSha256: null,
    versionOrModifiedAt: null,
    discoveryQuery: 'example query term',
    provenanceNote: 'placeholder provenance note',
    ...overrides,
  };
}

describe('source manifest deduplication rules', () => {
  it('accepts a duplicate group whose authority pick cites a content comparison', () => {
    const group: DuplicateGroup = {
      groupId: 'dup-1',
      memberSourceKeys: ['src-a', 'src-b'],
      selectedAuthoritySourceKey: 'src-b',
      selectionRationale: 'src-b content includes an additional confirmed section absent from src-a; both were diffed.',
      contentCompared: true,
    };
    expect(validateDuplicateGroup(group).valid).toBe(true);
  });

  it('rejects selecting authority by modification date alone', () => {
    const group: DuplicateGroup = {
      groupId: 'dup-2',
      memberSourceKeys: ['src-a', 'src-b'],
      selectedAuthoritySourceKey: 'src-b',
      selectionRationale: 'src-b is the most recent copy.',
      contentCompared: true,
    };
    const result = validateDuplicateGroup(group);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('AUTHORITY_SELECTION_RATIONALE_APPEARS_DATE_ONLY');
  });

  it('rejects an authority selection that was never content-compared', () => {
    const group: DuplicateGroup = {
      groupId: 'dup-3',
      memberSourceKeys: ['src-a', 'src-b'],
      selectedAuthoritySourceKey: 'src-a',
      selectionRationale: 'src-a looked more complete.',
      contentCompared: false,
    };
    const result = validateDuplicateGroup(group);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('AUTHORITY_SELECTION_REQUIRES_CONTENT_COMPARISON');
  });

  it('rejects an authority pick that is not a member of its own group', () => {
    const group: DuplicateGroup = {
      groupId: 'dup-4',
      memberSourceKeys: ['src-a', 'src-b'],
      selectedAuthoritySourceKey: 'src-c',
      selectionRationale: 'content comparison performed',
      contentCompared: true,
    };
    const result = validateDuplicateGroup(group);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('SELECTED_AUTHORITY_MUST_BE_A_GROUP_MEMBER');
  });

  it('flags a duplicate group referencing an unknown source key at the manifest level', () => {
    const manifest: SourceManifest = {
      organizationId: 'org-example',
      athleteId: 'athlete-example-0001',
      generatedAt: '2026-07-24T00:00:00.000Z',
      sources: [exampleSource({ sourceKey: 'src-a' })],
      duplicateGroups: [
        {
          groupId: 'dup-5',
          memberSourceKeys: ['src-a', 'src-missing'],
          selectedAuthoritySourceKey: null,
          selectionRationale: '',
          contentCompared: false,
        },
      ],
    };
    const result = validateSourceManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('UNKNOWN_SOURCE_KEY:src-missing'))).toBe(true);
  });
});

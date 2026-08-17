import { buildShadowLibraryMirrorMarkdown, shadowLibraryMirrorPath } from './shadowLibraryMirror';
import type { ShadowLibraryMirrorDocument, ShadowLibrarySourceRow } from './shadowLibrary';

function source(overrides: Partial<ShadowLibrarySourceRow> = {}): ShadowLibrarySourceRow {
  return {
    source_id: 'src-1',
    organization_id: 'org-1',
    title: 'Youth safeguarding review',
    publisher: 'USA Boxing',
    source_type: 'governing_body',
    authority_tier: 2,
    url: 'https://example.org/review',
    publication_date: '2026-01-01',
    status: 'active',
    approval_state: 'approved',
    verification_state: 'verified',
    approved_by_account_id: 'acct-1',
    approved_at: '2026-01-02T00:00:00.000Z',
    verified_by_account_id: 'acct-1',
    verified_at: '2026-01-02T00:00:00.000Z',
    metadata: {},
    created_by_account_id: 'acct-1',
    created_by_role: 'organization_admin',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as ShadowLibrarySourceRow;
}

describe('shadowLibraryMirrorPath', () => {
  test('files under domain/layer when both are set', () => {
    const s = source({ metadata: { classification_domain: 'youth_development_safeguarding', classification_layer: 'doctrine' } });
    expect(shadowLibraryMirrorPath(s)).toBe(
      'SHADOW Library Mirror/youth_development_safeguarding/doctrine/src-1.md',
    );
  });

  test('falls back to unclassified for either axis independently', () => {
    const s = source({ metadata: { classification_domain: 'youth_development_safeguarding' } });
    expect(shadowLibraryMirrorPath(s)).toBe(
      'SHADOW Library Mirror/youth_development_safeguarding/unclassified/src-1.md',
    );
  });

  test('falls back to unclassified for both axes when neither is set', () => {
    expect(shadowLibraryMirrorPath(source())).toBe('SHADOW Library Mirror/unclassified/unclassified/src-1.md');
  });
});

describe('buildShadowLibraryMirrorMarkdown', () => {
  test('includes source metadata, human-readable classification labels, and every document', () => {
    const s = source({ metadata: { classification_domain: 'youth_development_safeguarding', classification_layer: 'doctrine' } });
    const documents: ShadowLibraryMirrorDocument[] = [
      { document_id: 'doc-1', document_name: 'Safeguarding Policy.pdf', content: 'Full extracted text here.' },
    ];

    const markdown = buildShadowLibraryMirrorMarkdown(s, documents, '2026-08-17T00:00:00.000Z');

    expect(markdown).toContain('# Youth safeguarding review');
    expect(markdown).toContain('Youth development / safeguarding');
    expect(markdown).toContain('Doctrine (settled positions / accepted policy)');
    expect(markdown).toContain('Mirrored from PPBF SHADOW Library on: 2026-08-17T00:00:00.000Z');
    expect(markdown).toContain('## Safeguarding Policy.pdf');
    expect(markdown).toContain('Full extracted text here.');
  });

  test('marks unclassified axes and a source with no documents plainly', () => {
    const markdown = buildShadowLibraryMirrorMarkdown(source(), [], '2026-08-17T00:00:00.000Z');

    expect(markdown).toContain('Classification domain: (unclassified)');
    expect(markdown).toContain('Classification layer: (unclassified)');
    expect(markdown).not.toContain('##');
  });
});

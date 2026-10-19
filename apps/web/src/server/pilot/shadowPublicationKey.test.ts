import { publicationKey, type PublicationKeySource } from './shadowPublicationKey';

// F-136: Jason 2026-10-18, "A: DOI/PMID/URL key (Rec.)".
function src(
  id: string,
  url: string | null = null,
  metadata: Record<string, unknown> | null = null,
): PublicationKeySource {
  return { source_id: id, url, metadata };
}

describe('publicationKey (F-136)', () => {
  it('a DOI in metadata and a doi.org url are the same paper', () => {
    expect(publicationKey(src('a', null, { doi: '10.1000/abc.1' }))).toBe(
      publicationKey(src('b', 'https://doi.org/10.1000/abc.1')),
    );
    expect(publicationKey(src('a', null, { doi: '10.1000/abc.1' }))).toBe('doi:10.1000/abc.1');
  });

  it('DOIs are case-insensitive and tolerate prefixes and trailing punctuation', () => {
    const keys = [
      publicationKey(src('a', null, { doi: '10.1000/ABC.1' })),
      publicationKey(src('b', null, { identifier_kind: 'doi', identifier: 'doi:10.1000/abc.1' })),
      publicationKey(src('c', null, { doi: 'https://doi.org/10.1000/abc.1.' })),
    ];
    expect(new Set(keys)).toEqual(new Set(['doi:10.1000/abc.1']));
  });

  it('a PMID in metadata and a PubMed url are the same paper', () => {
    expect(publicationKey(src('a', null, { pmid: '31452104' }))).toBe(
      publicationKey(src('b', 'https://pubmed.ncbi.nlm.nih.gov/31452104/')),
    );
    expect(publicationKey(src('a', null, { pmid: 31452104 }))).toBe('pmid:31452104');
    expect(publicationKey(src('c', 'https://www.ncbi.nlm.nih.gov/pubmed/31452104'))).toBe('pmid:31452104');
  });

  it('a DOI beats a PMID', () => {
    expect(publicationKey(src('a', null, { doi: '10.4000/both', pmid: '123' }))).toBe('doi:10.4000/both');
  });

  it('url variants collapse: scheme, www, trailing slash, fragment, utm params', () => {
    const keys = [
      'http://www.Example.com/Paper/1/',
      'https://example.com/Paper/1#methods',
      'https://example.com/Paper/1?utm_source=x&UTM_Medium=y',
    ].map((url, i) => publicationKey(src(`s${i}`, url)));
    expect(new Set(keys)).toEqual(new Set(['url:example.com/Paper/1']));
  });

  it('keeps a non-utm param, in order, and path case', () => {
    expect(publicationKey(src('a', 'https://example.com/Paper/1?id=5&utm_source=x&b=2'))).toBe(
      'url:example.com/Paper/1?id=5&b=2',
    );
  });

  it('different papers differ', () => {
    expect(publicationKey(src('a', 'https://example.com/Paper/1'))).not.toBe(
      publicationKey(src('b', 'https://example.com/Paper/2')),
    );
    expect(publicationKey(src('a', null, { doi: '10.1000/a' }))).not.toBe(
      publicationKey(src('b', null, { doi: '10.1000/b' })),
    );
  });

  it('falls back to the source id when nothing identifies the paper', () => {
    expect(publicationKey(src('only-id'))).toBe('source:only-id');
  });

  it('blank strings and non-numeric PMIDs count as absent', () => {
    expect(publicationKey(src('s-blank', '   ', { doi: '  ', pmid: '', identifier_kind: 'doi', identifier: ' ' }))).toBe(
      'source:s-blank',
    );
    expect(publicationKey(src('x', null, { pmid: 'PMID: abc' }))).toBe('source:x');
  });
});

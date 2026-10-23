import { publicationIdentifiers, publicationKey, type PublicationKeySource } from './shadowPublicationKey';

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

// #345 D1: General Research saves its one "DOI or PMID" box at
// metadata.provenance.doi_or_pmid (app/research/page.tsx). "Same paper counted
// once, however it was entered" (OD-2026-10-18-005).
describe('publicationKey reads the General Research DOI/PMID box (#345)', () => {
  const box = (id: string, value: unknown, url: string | null = null, extra: Record<string, unknown> = {}) =>
    src(id, url, { general_research: true, provenance: { doi_or_pmid: value, provider: 'Penn State Library' }, ...extra });

  it('a DOI in the box, in any case or form, is the DOI key', () => {
    const keys = [
      publicationKey(box('a', '10.1000/abc.1')),
      publicationKey(box('b', '10.1000/ABC.1')),
      publicationKey(box('c', 'doi:10.1000/abc.1')),
      publicationKey(box('d', 'DOI: 10.1000/ABC.1.')),
      publicationKey(box('e', 'https://doi.org/10.1000/abc.1')),
      publicationKey(box('f', `  10.1000/abc.1${String.fromCharCode(0xa0)}(2019)`)),
      // A pasted link loses its query and fragment, as in the URL field.
      publicationKey(box('g', 'https://doi.org/10.1000/abc.1?utm_source=x')),
      publicationKey(box('h', 'https://doi.org/10.1000/abc.1#methods')),
      publicationKey(src('i', 'https://doi.org/10.1000/abc.1?utm_source=x')),
    ];
    expect(new Set(keys)).toEqual(new Set(['doi:10.1000/abc.1']));
  });

  it('a PMID in the box, bare, labelled, as a number or a PubMed link, is the PMID key', () => {
    const keys = [
      publicationKey(box('a', '31452104')),
      publicationKey(box('b', 'PMID: 31452104')),
      publicationKey(box('c', 'pmid 31452104')),
      publicationKey(box('d', 'PMID:31452104')),
      publicationKey(box('e', ' PMID31452104 ')),
      publicationKey(box('f', 31452104)),
      publicationKey(box('g', 'https://pubmed.ncbi.nlm.nih.gov/31452104/')),
    ];
    expect(new Set(keys)).toEqual(new Set(['pmid:31452104']));
  });

  it('a box that is blank, not a DOI and not a whole PMID identifies nothing', () => {
    for (const value of ['', '   ', 'PMC1234567', 'PMID: 123 (2019)', 'Penn State', 'PMID: abc', null, true, 12.5, -3, 1e20]) {
      expect(publicationKey(box('x', value))).toBe('source:x');
    }
    expect(publicationKey(src('y', null, { provenance: 'PMID 123' }))).toBe('source:y');
    expect(publicationKey(src('z', null, { provenance: ['10.1000/abc'] }))).toBe('source:z');
  });

  it('precedence: DOI before PMID before URL; within each, the explicit field before the box before identifier', () => {
    // An explicit metadata.doi beats a different DOI in the box.
    expect(publicationKey(box('a', '10.1000/box', null, { doi: '10.1000/field' }))).toBe('doi:10.1000/field');
    // A DOI in the box beats any PMID.
    expect(publicationKey(box('b', '10.1000/box', null, { pmid: '123' }))).toBe('doi:10.1000/box');
    expect(publicationKey(box('c', '10.1000/box', 'https://pubmed.ncbi.nlm.nih.gov/123/'))).toBe('doi:10.1000/box');
    // A DOI anywhere beats a PMID in the box.
    expect(publicationKey(box('d', 'PMID: 123', 'https://doi.org/10.1000/url'))).toBe('doi:10.1000/url');
    // The box beats identifier_kind/identifier.
    expect(publicationKey(box('e', '10.1000/box', null, { identifier_kind: 'doi', identifier: '10.1000/ident' }))).toBe(
      'doi:10.1000/box',
    );
    expect(publicationKey(box('f', 'PMID: 123', null, { identifier_kind: 'pmid', identifier: '456' }))).toBe('pmid:123');
    // An explicit metadata.pmid beats a different PMID in the box.
    expect(publicationKey(box('g', 'PMID: 123', null, { pmid: '789' }))).toBe('pmid:789');
    // Either beats a plain URL.
    expect(publicationKey(box('h', 'PMID: 123', 'https://example.com/paper'))).toBe('pmid:123');
    expect(publicationKey(box('i', '10.1000/box', 'https://example.com/paper'))).toBe('doi:10.1000/box');
    // The box beats the URL within a tier.
    expect(publicationKey(box('j', '10.1000/box', 'https://doi.org/10.1000/url2'))).toBe('doi:10.1000/box');
    expect(publicationKey(box('k', 'PMID: 1', 'https://pubmed.ncbi.nlm.nih.gov/2/'))).toBe('pmid:1');
  });

  it('two registrations of one paper count once, whichever field holds its id', () => {
    const doiPaper = [
      box('gr-1', '10.1000/abc.1'),
      box('gr-2', 'doi:10.1000/ABC.1'),
      src('seed', null, { identifier_kind: 'doi', identifier: '10.1000/abc.1' }),
      src('url', 'https://doi.org/10.1000/abc.1'),
    ];
    expect(new Set(doiPaper.map(publicationKey)).size).toBe(1);
    const pmidPaper = [
      box('gr-1', 'PMID: 27217246'),
      src('seed', 'https://pubmed.ncbi.nlm.nih.gov/27217246/', { identifier_kind: 'pmid', identifier: '27217246' }),
      src('meta', null, { pmid: 27217246 }),
    ];
    expect(new Set(pmidPaper.map(publicationKey)).size).toBe(1);
    expect(publicationKey(box('gr-3', '10.1000/abc.2'))).not.toBe(publicationKey(box('gr-4', '10.1000/abc.1')));
  });
});

// #345 D2: registration refuses a paper whose DOI or PMID is already on the
// shelf, matching on ANY shared identifier (Q2, applied by Overwatch; F-136,
// OD-2026-10-18-005). The key keeps one; these keep them all.
describe('publicationIdentifiers: every DOI and PMID a source carries (#345 D2)', () => {
  const box = (id: string, value: unknown, url: string | null = null, extra: Record<string, unknown> = {}) =>
    src(id, url, { general_research: true, provenance: { doi_or_pmid: value }, ...extra });
  const shares = (a: PublicationKeySource, b: PublicationKeySource) =>
    publicationIdentifiers(a).some((identifier) => publicationIdentifiers(b).includes(identifier));

  it('LR1 edge pair: a PubMed URL plus a DOI in the box shares the PMID with a seeded PMID-only record', () => {
    const generalResearch = {
      source_id: 'gr',
      url: 'https://pubmed.ncbi.nlm.nih.gov/27217246/',
      metadata: { general_research: true, provenance: { doi_or_pmid: '10.1177/1745691616635591' } },
    };
    const seeded = { source_id: 'seed', url: null, metadata: { identifier_kind: 'pmid', identifier: '27217246' } };
    // The keys still differ (the key is not changed here) ...
    expect(publicationKey(generalResearch)).toBe('doi:10.1177/1745691616635591');
    expect(publicationKey(seeded)).toBe('pmid:27217246');
    // ... but the identifiers meet.
    expect(publicationIdentifiers(generalResearch)).toEqual(['doi:10.1177/1745691616635591', 'pmid:27217246']);
    expect(publicationIdentifiers(seeded)).toEqual(['pmid:27217246']);
    expect(shares(generalResearch, seeded)).toBe(true);
  });

  it('reads every place: metadata, the box, identifier_kind and the URL, each normalised as the key is', () => {
    expect(publicationIdentifiers(box('c', '10.1000/box', 'https://pubmed.ncbi.nlm.nih.gov/123/'))).toEqual([
      'doi:10.1000/box',
      'pmid:123',
    ]);
    expect(publicationIdentifiers(src('all', 'https://doi.org/10.1000/URL.', {
      doi: 'DOI: 10.1000/Field',
      pmid: 456,
      identifier_kind: 'doi',
      identifier: '10.1000/ident',
      provenance: { doi_or_pmid: 'PMID: 789' },
    }))).toEqual(['doi:10.1000/field', 'doi:10.1000/ident', 'doi:10.1000/url', 'pmid:456', 'pmid:789']);
    expect(publicationIdentifiers(src('kind', 'https://www.ncbi.nlm.nih.gov/pubmed/42?dopt=Abstract', {
      identifier_kind: 'pmid',
      identifier: '41',
    }))).toEqual(['pmid:41', 'pmid:42']);
  });

  it('one identifier found twice is listed once', () => {
    expect(publicationIdentifiers(box('same', 'https://doi.org/10.1000/abc', 'https://doi.org/10.1000/ABC', { doi: '10.1000/abc.' })))
      .toEqual(['doi:10.1000/abc']);
  });

  it('a source with no DOI or PMID has none and shares nothing, even with another such source', () => {
    const plain = [
      src('bare'),
      src('url-only', 'https://example.com/paper/1'),
      src('blank', '   ', { doi: '  ', pmid: '', identifier_kind: 'doi', identifier: ' ' }),
      box('pmc', 'PMC1234567'),
      box('not-whole', 'PMID: 123 (2019)'),
      src('not-object', null, { provenance: 'PMID 123' }),
    ];
    for (const source of plain) expect(publicationIdentifiers(source)).toEqual([]);
    expect(shares(plain[0], plain[1])).toBe(false);
    expect(shares(src('same-url', 'https://example.com/paper/1'), plain[1])).toBe(false);
  });

  it('different papers share nothing', () => {
    expect(shares(box('a', '10.1000/a'), box('b', '10.1000/b'))).toBe(false);
    expect(shares(box('a', 'PMID: 1'), src('b', 'https://pubmed.ncbi.nlm.nih.gov/2/'))).toBe(false);
  });

  it('the key is always one of the identifiers when the key is a DOI or a PMID', () => {
    const sources = [
      box('a', '10.1000/box', 'https://pubmed.ncbi.nlm.nih.gov/123/'),
      box('b', 'PMID: 123', 'https://doi.org/10.1000/url'),
      src('c', null, { identifier_kind: 'pmid', identifier: '777' }),
      src('d', 'https://doi.org/10.1000/abc.1'),
    ];
    for (const source of sources) expect(publicationIdentifiers(source)).toContain(publicationKey(source));
  });
});

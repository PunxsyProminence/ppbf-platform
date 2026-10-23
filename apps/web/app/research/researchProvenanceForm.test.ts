// researchProvenanceForm.ts: the request the General Research form builds and
// the lines it shows. The rules themselves live in the contract
// (src/shared/researchProvenance.ts); these pin that the form defers to it.

import { RESEARCH_PROTECTED_DOMAINS } from '@/src/shared/researchProvenance';
import {
  EMPTY_PROVENANCE_DRAFT,
  buildProvenanceRegistration,
  provenanceWords,
  savedProvenanceLines,
  type ProvenanceDraft,
} from './researchProvenanceForm';

const draft = (changes: Partial<ProvenanceDraft>): ProvenanceDraft => ({ ...EMPTY_PROVENANCE_DRAFT, ...changes });

describe('buildProvenanceRegistration', () => {
  test('an empty draft adds nothing to what the form already sent', () => {
    expect(buildProvenanceRegistration(EMPTY_PROVENANCE_DRAFT, {})).toEqual({ ok: true, provenance: {}, fields: {} });
    expect(buildProvenanceRegistration(EMPTY_PROVENANCE_DRAFT, { doi_or_pmid: '10.1/x' })).toEqual({
      ok: true,
      provenance: { doi_or_pmid: '10.1/x' },
      fields: {},
    });
  });

  test('the journal and publication date are columns, not provenance keys', () => {
    expect(buildProvenanceRegistration(draft({ journal: ' BJSM ', publicationDate: '2020-01-31' }), {})).toEqual({
      ok: true,
      provenance: {},
      fields: { publisher: 'BJSM', publication_date: '2020-01-31' },
    });
  });

  test('a year is sent as a number; authors are split on semicolons and new lines', () => {
    const built = buildProvenanceRegistration(draft({ year: ' 2020 ', authors: 'A B; C D\n\n E F ;' }), {});
    expect(built).toMatchObject({ ok: true, provenance: { year: 2020, authors: ['A B', 'C D', 'E F'] } });
  });

  test('only checked domains become flags', () => {
    const built = buildProvenanceRegistration(draft({ protectedDomains: { contact: true, sparring: false } }), {});
    expect(built).toMatchObject({ ok: true, provenance: { protected_domains: { contact: true } } });
  });

  test.each([
    ['a year that is not a number', { year: 'abc' }, /year must be a whole year/],
    ['a year before the contract\'s earliest', { year: '1700' }, /year must be a whole year/],
    ['a value outside boxing specificity\'s set', { boxingSpecificity: 'sort_of' }, /boxing_specificity must be one of/],
    ['a population over the contract\'s limit', { population: 'x'.repeat(10_000) }, /population must be \d+ characters or fewer/],
  ])('refuses %s with the contract\'s own message', (_name, changes, message) => {
    const built = buildProvenanceRegistration(draft(changes), {});
    expect(built.ok).toBe(false);
    expect(built.ok === false && built.error).toMatch(message);
  });

  test('the values it was given by the form are checked too', () => {
    const built = buildProvenanceRegistration(EMPTY_PROVENANCE_DRAFT, { doi_or_pmid: 'x'.repeat(10_000) });
    expect(built.ok).toBe(false);
  });
});

describe('savedProvenanceLines', () => {
  test('a source with nothing saved has no lines, whatever its metadata looks like', () => {
    expect(savedProvenanceLines({})).toEqual([]);
    expect(savedProvenanceLines({ metadata: null })).toEqual([]);
    expect(savedProvenanceLines({ metadata: { provenance: 'text' } })).toEqual([]);
    expect(savedProvenanceLines({ metadata: { provenance: [] } })).toEqual([]);
    expect(savedProvenanceLines({ publisher: '  ', publication_date: null, metadata: { provenance: {} } })).toEqual([]);
  });

  test('a value of the wrong shape is left out, not shown', () => {
    expect(savedProvenanceLines({
      metadata: {
        provenance: { year: '2019', authors: 'Smith', population: { a: 1 }, sex: '', protected_domains: [] },
      },
    })).toEqual([]);
  });

  test('every contract field has a line when set, in a fixed order', () => {
    const flags = Object.fromEntries(RESEARCH_PROTECTED_DOMAINS.map((domain) => [domain, true]));
    const lines = savedProvenanceLines({
      publisher: 'BJSM',
      publication_date: '2020-01-31',
      metadata: {
        provenance: {
          doi_or_pmid: 12345678,
          institutional_source_id: 'ID-1',
          provider: 'Library',
          original_filename: 'a.pdf',
          authors: ['A', 'B'],
          year: 2020,
          study_design: 'RCT',
          population: 'Boxers',
          age_range: '16-18',
          sex: 'Mixed',
          transfer_status: 'Direct',
          boxing_specificity: 'boxing_specific',
          protected_domains: flags,
        },
      },
    });
    expect(lines.map((line) => line.label)).toEqual([
      'Journal', 'Publication date', 'Year', 'Authors', 'DOI / PMID', 'Institutional source ID', 'Provider',
      'Original filename', 'Study design', 'Population', 'Age range', 'Sex', 'Transfer status',
      'Boxing specificity', 'Protected domains',
    ]);
    expect(lines.find((line) => line.label === 'DOI / PMID')?.value).toBe('12345678');
    expect(lines.find((line) => line.label === 'Protected domains')?.value).toBe(
      'Medical, Safeguarding, Nutrition, Weight management, Contact, Return to play, Sparring',
    );
  });

  test('a protected-domain object with no true flag gives no line', () => {
    expect(savedProvenanceLines({ metadata: { provenance: { protected_domains: { medical: false } } } })).toEqual([]);
  });
});

test('provenanceWords spaces the contract\'s values and keeps PPBF in capitals', () => {
  expect(provenanceWords('return_to_play')).toBe('Return to play');
  expect(provenanceWords('ppbf_specific')).toBe('PPBF specific');
});

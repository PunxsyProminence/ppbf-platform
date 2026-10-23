import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseResearchProvenance,
  RESEARCH_BOXING_SPECIFICITY_VALUES,
  RESEARCH_PROTECTED_DOMAINS,
} from './researchProvenance';

const NOW = new Date('2026-10-23T12:00:00Z');

const FULL = {
  doi_or_pmid: '10.1000/xyz123',
  provider: 'Penn State library',
  original_filename: 'smith-2019-punch-force.pdf',
  institutional_source_id: 'PSU-ILL-004417',
  authors: ['Smith J', 'Ortega M'],
  year: 2019,
  population: 'Amateur boxers, club level',
  age_range: '18-35',
  sex: 'male',
  study_design: 'Cross-sectional laboratory study',
  boxing_specificity: 'boxing_specific',
  transfer_status: 'Not transferred: studied in boxers',
  protected_domains: { contact: true, sparring: true, medical: false },
};

describe('parseResearchProvenance', () => {
  test('accepts a full record and returns it as given', () => {
    expect(parseResearchProvenance(FULL, NOW)).toEqual({ ok: true, provenance: FULL });
  });

  test.each([
    ['nothing', {}],
    ['one field', { year: 2020 }],
    ['the three keys the General Research form sends today', { doi_or_pmid: '31234567', provider: 'Penn State library', original_filename: 'a.pdf' }],
    ['a transferred study with a design only', { boxing_specificity: 'transferred', study_design: 'Systematic review' }],
  ])('accepts %s (everything is optional)', (_label, input) => {
    expect(parseResearchProvenance(input, NOW)).toEqual({ ok: true, provenance: input });
  });

  test('null and blank values are absence: left out, not stored and not refused', () => {
    const result = parseResearchProvenance(
      { population: '   ', sex: null, authors: null, year: null, boxing_specificity: '', protected_domains: null, provider: ' Penn State library ' },
      NOW,
    );
    expect(result).toEqual({ ok: true, provenance: { provider: 'Penn State library' } });
  });

  test('a blank year, authors or protected_domains is absence too, as a form that sends empty inputs would', () => {
    expect(parseResearchProvenance({ year: '', authors: '  ', protected_domains: '' }, NOW)).toEqual({ ok: true, provenance: {} });
  });

  // doi_or_pmid is stored as the form sent it (another lane reads it for the
  // publication key); a bare PMID may arrive as a number, as that reader allows.
  test('doi_or_pmid is kept exactly as given, and a numeric PMID is allowed', () => {
    expect(parseResearchProvenance({ doi_or_pmid: ' 10.1000/XYZ ' }, NOW)).toEqual({ ok: true, provenance: { doi_or_pmid: ' 10.1000/XYZ ' } });
    expect(parseResearchProvenance({ doi_or_pmid: 31234567 }, NOW)).toEqual({ ok: true, provenance: { doi_or_pmid: 31234567 } });
    for (const bad of [-1, 1.5, true, ['31234567']]) {
      expect(parseResearchProvenance({ doi_or_pmid: bad }, NOW)).toEqual({ ok: false, error: 'metadata.provenance.doi_or_pmid must be a string' });
    }
  });

  test('blank author entries are dropped, and a list of only blanks is left out', () => {
    expect(parseResearchProvenance({ authors: [' Smith J ', '', '  '] }, NOW)).toEqual({ ok: true, provenance: { authors: ['Smith J'] } });
    expect(parseResearchProvenance({ authors: ['', ' '] }, NOW)).toEqual({ ok: true, provenance: {} });
  });

  test('does not change the object it is given', () => {
    const input = { population: ' adult ', authors: [' A '] };
    const copy = JSON.parse(JSON.stringify(input));
    parseResearchProvenance(input, NOW);
    expect(input).toEqual(copy);
  });

  // The importer's own four values (shadowEvidenceTier.ts ShadowBoxingSpecificity).
  test('boxing_specificity takes exactly the importer values', () => {
    expect([...RESEARCH_BOXING_SPECIFICITY_VALUES].sort()).toEqual(
      ['boxing_specific', 'partly_boxing_specific', 'ppbf_specific', 'transferred'],
    );
    for (const value of RESEARCH_BOXING_SPECIFICITY_VALUES) {
      expect(parseResearchProvenance({ boxing_specificity: value }, NOW).ok).toBe(true);
    }
  });

  test.each([
    ['a value outside the set', { boxing_specificity: 'boxing' }],
    ['the wrong case', { boxing_specificity: 'Transferred' }],
    ['a non-string boxing_specificity', { boxing_specificity: true }],
    ['a year before 1800', { year: 1799 }],
    ['a year two past this one', { year: 2028 }],
    ['a fractional year', { year: 2019.5 }],
    ['a year given as text', { year: '2019' }],
    ['authors as one string', { authors: 'Smith J' }],
    ['more than 100 authors', { authors: Array.from({ length: 101 }, (_, i) => `Author ${i}`) }],
    ['an author that is not text', { authors: ['Smith J', 7] }],
    ['an author name over 200 characters', { authors: ['x'.repeat(201)] }],
    ['a text field given as a number', { population: 40 }],
    ['a text field given as a list', { sex: ['male'] }],
    ['protected_domains as a list', { protected_domains: ['contact'] }],
    ['a protected-domain flag that is not a boolean', { protected_domains: { contact: 'yes' } }],
    ['a protected domain that does not exist', { protected_domains: { astrology: true } }],
  ])('refuses %s', (_label, input) => {
    const result = parseResearchProvenance(input, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^metadata\.provenance/);
  });

  test.each([
    ['doi_or_pmid', 200],
    ['provider', 200],
    ['original_filename', 300],
    ['institutional_source_id', 200],
    ['population', 300],
    ['age_range', 120],
    ['sex', 120],
    ['study_design', 300],
    ['transfer_status', 400],
  ])('%s holds %i characters and no more', (key, limit) => {
    expect(parseResearchProvenance({ [key]: 'x'.repeat(limit) }, NOW).ok).toBe(true);
    const over = parseResearchProvenance({ [key]: 'x'.repeat(limit + 1) }, NOW);
    expect(over).toEqual({ ok: false, error: `metadata.provenance.${key} must be ${limit} characters or fewer` });
  });

  test('the year bound follows the clock: next year is allowed for an in-press paper', () => {
    expect(parseResearchProvenance({ year: 2027 }, NOW).ok).toBe(true);
    expect(parseResearchProvenance({ year: 2027 }, new Date('2025-01-01T00:00:00Z')).ok).toBe(false);
  });

  test.each([
    ['an unknown key', { journal: 'Journal of Boxing' }, 'metadata.provenance.journal is not a provenance field'],
    ['a key that is only a near miss', { age: '18-35' }, 'metadata.provenance.age is not a provenance field'],
    ['a long unknown key, named by its first 60 characters', { ['k'.repeat(90)]: 1 }, `metadata.provenance.${'k'.repeat(60)} is not a provenance field`],
  ])('refuses %s and says which', (_label, input, message) => {
    expect(parseResearchProvenance({ ...FULL, ...input }, NOW)).toEqual({ ok: false, error: message });
  });

  test('prototype-shaped keys from parsed JSON are refused as unknown, not stored', () => {
    for (const json of ['{"__proto__":{"polluted":true}}', '{"constructor":{"prototype":{}}}']) {
      const result = parseResearchProvenance(JSON.parse(json), NOW);
      expect(result.ok).toBe(false);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('an unknown key hidden beside valid ones is not stored by being ignored', () => {
    const result = parseResearchProvenance({ population: 'adult boxers', evidence_tier: 'PROVEN' }, NOW);
    expect(result.ok).toBe(false);
  });

  test.each([[null], [undefined], [[]], ['population'], [7]])('refuses %p as the whole record', (input) => {
    expect(parseResearchProvenance(input, NOW)).toEqual({ ok: false, error: 'metadata.provenance must be an object' });
  });

  test('names the protected domains the issue lists, and no others', () => {
    expect([...RESEARCH_PROTECTED_DOMAINS]).toEqual([
      'medical', 'safeguarding', 'nutrition', 'weight_management', 'contact', 'return_to_play', 'sparring',
    ]);
  });
});

// boxing_specificity in CHUNK metadata is the evidence tier rule's input
// (shadowEvidenceTier.ts). The same name here describes the source and must
// never be written to a chunk, so the code that writes chunks must not reach
// this contract.
describe('the code that writes chunks does not use the provenance contract', () => {
  const root = join(__dirname, '..', '..');

  test.each([
    'src/server/pilot/shadowLibrary.ts',
    'app/api/pilot/shadow/library/chunks/route.ts',
    'app/api/pilot/shadow/library/documents/route.ts',
    'scripts/import-shadow-research.mjs',
  ])('%s, which writes chunks or documents, does not use the provenance contract', (file) => {
    const text = readFileSync(join(root, file), 'utf8');
    expect(text).not.toMatch(/researchProvenance|parseResearchProvenance/);
  });

  test('the contract has no chunk writer in it', () => {
    const text = readFileSync(join(__dirname, 'researchProvenance.ts'), 'utf8');
    expect(text).not.toMatch(/shadow_library_chunks|createShadowLibraryChunk/);
  });
});

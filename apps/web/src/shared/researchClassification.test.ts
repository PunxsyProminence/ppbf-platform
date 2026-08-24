import fs from 'node:fs';
import path from 'node:path';

import {
  RESEARCH_CLASSIFICATION_DOMAINS,
  isResearchClassificationDomain,
  researchClassificationArchiveCode,
  researchClassificationLabel,
} from './researchClassification';

// The crosswalk table in docs/SHADOW_RESEARCH_ARCHITECTURE.md section 5 is the
// document half of this contract, and the constant is the code half. Restating
// the constant inside this file would prove nothing -- a wrong label on a right
// key, a renamed key, or R10 and R12 swapped would all be copied into the
// "expected" value along with the mistake.
//
// So this reads the SHIPPED MARKDOWN OFF DISK and compares, the way
// athleteCheckIns.pg.test.ts reads the shipped SQL rather than re-typing it.
// The assertion is independent of the constant, which is what makes it able to
// fail: it closes the key/label/archiveCode PAIRING gap and the doc-drift gap
// with one comparison. A wrong pairing on either side now fails here.
//
// NOTE ON SCOPE. This proves the constant matches the DOCUMENT. It cannot prove
// either matches the archive.
//
// Corrected 2026-08-24: this note said section 1 was "an unconfirmed proposal
// with no manifest, export, or connector record". The R01-R19 structure is now
// verified to exist in the permanent SharePoint archive. What this test can
// prove did not change -- it reads a markdown table and a TypeScript constant,
// and neither is the archive. archiveCode remains a documentation crosswalk
// rather than verified archive conformance, now because nothing in this
// repository is wired to it rather than because the folders were in doubt.
// The test names below say only what is actually asserted.

const ARCHITECTURE_DOC = path.resolve(
  __dirname,
  '../../../../docs/SHADOW_RESEARCH_ARCHITECTURE.md',
);

interface CrosswalkRow {
  key: string;
  label: string;
  archiveCode: string;
}

function readDocumentedCrosswalk(): CrosswalkRow[] {
  const markdown = fs.readFileSync(ARCHITECTURE_DOC, 'utf8');
  const rows: CrosswalkRow[] = [];

  // | R01 | `boxing_athlete_development` | Boxing and athlete development |
  const rowPattern = /^\|\s*(R\d{2})\s*\|\s*`([a-z0-9_]+)`\s*\|\s*(.+?)\s*\|\s*$/;
  for (const line of markdown.split('\n')) {
    const match = rowPattern.exec(line);
    if (match) rows.push({ archiveCode: match[1], key: match[2], label: match[3] });
  }

  // A silently-empty parse would make every comparison below vacuously pass, so
  // the parser proves it found the table before anything is compared to it.
  if (rows.length === 0) {
    throw new Error(
      `No | R-code | \`key\` | label | rows parsed from ${ARCHITECTURE_DOC}. `
      + 'Section 5 of that document must keep its three-column crosswalk shape.',
    );
  }
  return rows;
}

describe('research classification taxonomy', () => {
  test('matches the section 5 crosswalk table in the shipped architecture document, row for row', () => {
    // toEqual on the whole ordered list, not per-field loops: order, arity, and
    // every key/label/archiveCode triple are pinned in one comparison, so a
    // swapped pair or a renamed key cannot slip through a field-wise check.
    expect(readDocumentedCrosswalk()).toEqual(
      RESEARCH_CLASSIFICATION_DOMAINS.map((domain) => ({
        key: domain.key,
        label: domain.label,
        archiveCode: domain.archiveCode,
      })),
    );
  });

  test('carries the documentation archive codes R01 through R19, in order and without repetition', () => {
    const expectedCodes = Array.from({ length: 19 }, (_value, index) => (
      `R${String(index + 1).padStart(2, '0')}`
    ));

    expect(RESEARCH_CLASSIFICATION_DOMAINS.map((domain) => domain.archiveCode)).toEqual(expectedCodes);
    // The Set checks that USED to sit here for archiveCode were dead: toEqual
    // against 19 distinct codes already forces 19 distinct codes. Keys and
    // labels are not implied by that, so those two remain.
    expect(new Set(RESEARCH_CLASSIFICATION_DOMAINS.map((domain) => domain.key)).size).toBe(19);
    expect(new Set(RESEARCH_CLASSIFICATION_DOMAINS.map((domain) => domain.label)).size).toBe(19);
  });

  test('includes the five archive domains added after the original issue-345 taxonomy', () => {
    expect(RESEARCH_CLASSIFICATION_DOMAINS.slice(-5)).toEqual([
      { key: 'water_safety_aquatics', label: 'Water safety and aquatics', archiveCode: 'R15' },
      { key: 'adaptive_inclusive_practice', label: 'Adaptive and inclusive practice', archiveCode: 'R16' },
      { key: 'multidiscipline_wrestling_grappling', label: 'Multidiscipline wrestling and grappling', archiveCode: 'R17' },
      { key: 'learning_science_skill_acquisition', label: 'Learning science and skill acquisition', archiveCode: 'R18' },
      { key: 'measurement_assessment_instruments', label: 'Measurement and assessment instruments', archiveCode: 'R19' },
    ]);
  });

  // R00 (Unsorted Drop) and R98 (Duplicate Hold) are processing states, not
  // subject domains. The old version of this test only asked whether the
  // STRINGS 'R00' and 'duplicate_hold' were accepted as keys -- which they
  // never would be, since no key looks like that. It could not catch the thing
  // that actually goes wrong: a real row whose key IS one of those states, e.g.
  // { key: 'unsorted_drop', ... }. The exclusion is now checked on the constant
  // itself, from both directions.
  test('excludes the R00 and R98 processing states from the constant, by key and by code', () => {
    for (const domain of RESEARCH_CLASSIFICATION_DOMAINS) {
      expect(['R00', 'R98']).not.toContain(domain.archiveCode);
      expect(['unsorted_drop', 'duplicate_hold']).not.toContain(domain.key);
      expect(domain.label.toLowerCase()).not.toContain('unsorted drop');
      expect(domain.label.toLowerCase()).not.toContain('duplicate hold');
    }
  });

  test('accepts only controlled subject-domain keys', () => {
    for (const domain of RESEARCH_CLASSIFICATION_DOMAINS) {
      expect(isResearchClassificationDomain(domain.key)).toBe(true);
    }

    expect(isResearchClassificationDomain('unsorted_drop')).toBe(false);
    expect(isResearchClassificationDomain('duplicate_hold')).toBe(false);
    expect(isResearchClassificationDomain('R00')).toBe(false);
    expect(isResearchClassificationDomain('astrology')).toBe(false);
    expect(isResearchClassificationDomain(null)).toBe(false);
  });

  test('resolves human labels and archive codes without inventing a fallback code', () => {
    expect(researchClassificationLabel('adaptive_inclusive_practice')).toBe('Adaptive and inclusive practice');
    expect(researchClassificationArchiveCode('adaptive_inclusive_practice')).toBe('R16');

    expect(researchClassificationLabel('unknown_domain')).toBe('unknown_domain');
    expect(researchClassificationArchiveCode('unknown_domain')).toBeNull();
  });
});

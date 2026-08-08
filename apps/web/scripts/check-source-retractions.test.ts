import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(
  path.resolve(__dirname, 'check-source-retractions.mjs'),
).href;

function evaluate(expression: string) {
  const script = `
    import * as m from ${JSON.stringify(moduleUrl)};
    const value = await (${expression});
    process.stdout.write(JSON.stringify(value));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }));
}

describe('check-source-retractions identifier extraction', () => {
  // Shared with verify-research-citations.mjs, including the DOI-fragment
  // guard: a bare DOI must never yield a PMID.
  test('a bare DOI yields zero PMIDs', () => {
    const result = evaluate('m.extractIdentifiers("10.1080/02640414.2021.2001175")');
    expect(result.pmids).toEqual([]);
    expect(result.dois).toEqual(['10.1080/02640414.2021.2001175']);
  });

  test('the Wakefield 1998 identifiers extract cleanly', () => {
    const result = evaluate(
      'm.extractIdentifiers("PMID 9500320, doi:10.1016/S0140-6736(97)11096-0")',
    );
    expect(result.pmids).toEqual(['9500320']);
    expect(result.dois).toEqual(['10.1016/S0140-6736(97)11096-0']);
  });
});

describe('check-source-retractions PubMed pubtype classification', () => {
  // Verified control: PMID 9500320 (Wakefield 1998) returns exactly this
  // pubtype list from esummary.
  test('the real Wakefield 1998 pubtype list classifies as retracted', () => {
    const result = evaluate(
      'm.classifyPubtypes(["Journal Article", "Research Support, Non-U.S. Gov\'t", "Retracted Publication"])',
    );
    expect(result.status).toBe('retracted');
    expect(result.evidence).toContain('retracted publication');
  });

  test('an ordinary article with no retraction pubtype is clear', () => {
    const result = evaluate('m.classifyPubtypes(["Journal Article", "Randomized Controlled Trial"])');
    expect(result).toEqual({ status: 'clear', evidence: '' });
  });

  test('an expression of concern is distinguished from a full retraction', () => {
    const result = evaluate('m.classifyPubtypes(["Journal Article", "Expression of Concern"])');
    expect(result.status).toBe('expression_of_concern');
  });

  test('a published erratum classifies as corrected, not retracted', () => {
    const result = evaluate('m.classifyPubtypes(["Journal Article", "Published Erratum"])');
    expect(result.status).toBe('corrected');
  });

  test('no pubtypes at all is clear', () => {
    expect(evaluate('m.classifyPubtypes(undefined)')).toEqual({ status: 'clear', evidence: '' });
    expect(evaluate('m.classifyPubtypes([])')).toEqual({ status: 'clear', evidence: '' });
  });
});

describe('check-source-retractions Crossref updated-by classification', () => {
  // Verified control: DOI 10.1016/S0140-6736(97)11096-0 (the Wakefield 1998
  // Lancet paper) returns both a correction and a retraction entry from
  // Crossref's updated-by, sourced from Retraction Watch. Severity is
  // ordered worst-first, so this must resolve to retracted, not corrected.
  test('a work carrying both a correction and a retraction resolves to retracted', () => {
    const result = evaluate(`m.classifyCrossrefUpdates([
      { type: 'correction', source: 'retraction-watch', label: 'Correction', DOI: '10.1016/x',
        updated: { 'date-parts': [[2004, 3, 5]] } },
      { type: 'retraction', source: 'retraction-watch', label: 'Retraction', DOI: '10.1016/y',
        updated: { 'date-parts': [[2010, 2, 2]] } },
    ])`);
    expect(result.status).toBe('retracted');
    expect(result.noticeDoi).toBe('10.1016/y');
    expect(result.noticeDate).toBe('2010-02-02');
  });

  test('a correction alone is corrected, not retracted', () => {
    const result = evaluate(`m.classifyCrossrefUpdates([
      { type: 'correction', source: 'retraction-watch', label: 'Correction', DOI: '10.1016/x',
        updated: { 'date-parts': [[2004, 3, 5]] } },
    ])`);
    expect(result.status).toBe('corrected');
  });

  test('an unrecognized update type is ignored, not misclassified', () => {
    const result = evaluate(`m.classifyCrossrefUpdates([
      { type: 'new_edition', source: 'crossref', DOI: '10.1016/x' },
    ])`);
    expect(result).toEqual({ status: 'clear', evidence: '' });
  });

  test('no updated-by entries at all is clear', () => {
    expect(evaluate('m.classifyCrossrefUpdates(undefined)')).toEqual({ status: 'clear', evidence: '' });
    expect(evaluate('m.classifyCrossrefUpdates([])')).toEqual({ status: 'clear', evidence: '' });
  });
});

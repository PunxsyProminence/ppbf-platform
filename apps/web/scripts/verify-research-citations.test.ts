import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(
  path.resolve(__dirname, 'verify-research-citations.mjs'),
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

describe('verify-research-citations identifier extraction', () => {
  // THE MANDATORY REGRESSION TEST. A naive \b\d{7,8}\b PMID pattern run over text
  // that also holds a DOI harvests digits from inside the DOI suffix --
  // 10.1080/02640414.2021.2001175 yields the real but unrelated PMID 2001175.
  // This exact defect produced 173 contaminated rows (31 with no genuine PMID at
  // all) in the research program that built the seeded corpus. A bare DOI must
  // never yield a PMID.
  test('a bare DOI yields zero PMIDs (the DOI-fragment defect)', () => {
    const result = evaluate('m.extractIdentifiers("10.1080/02640414.2021.2001175")');
    expect(result.pmids).toEqual([]);
    expect(result.dois).toEqual(['10.1080/02640414.2021.2001175']);
  });

  test('a labelled PMID is still extracted from text that also carries a DOI', () => {
    const result = evaluate(
      'm.extractIdentifiers("PMID: 33253204, doi: 10.1080/02640414.2021.2001175")',
    );
    expect(result.pmids).toEqual(['33253204']);
    expect(result.dois).toEqual(['10.1080/02640414.2021.2001175']);
  });

  test('a bare 7-8 digit PMID outside any DOI is still found', () => {
    const result = evaluate('m.extractIdentifiers("see PMID 9500320 for the retraction notice")');
    expect(result.pmids).toEqual(['9500320']);
    expect(result.dois).toEqual([]);
  });

  test('multiple DOIs in one field are all stripped before the PMID scan', () => {
    const result = evaluate(
      'm.extractIdentifiers("10.1016/S0140-6736(97)11096-0 and 10.1080/02640414.2021.2001175")',
    );
    expect(result.pmids).toEqual([]);
    expect(result.dois).toEqual(['10.1016/S0140-6736(97)11096-0', '10.1080/02640414.2021.2001175']);
  });

  test('empty and non-string input yields no identifiers', () => {
    expect(evaluate('m.extractIdentifiers("")')).toEqual({ pmids: [], dois: [] });
    expect(evaluate('m.extractIdentifiers(null)')).toEqual({ pmids: [], dois: [] });
  });

  test('a trailing punctuation-adjacent DOI is trimmed cleanly', () => {
    const result = evaluate('m.extractIdentifiers("see (10.1016/S0140-6736(97)11096-0).")');
    expect(result.dois).toEqual(['10.1016/S0140-6736(97)11096-0']);
  });
});

describe('verify-research-citations title matching', () => {
  test('high content-word overlap scores near 1', () => {
    const result = evaluate(
      'm.titleOverlap("Effects of sparring exposure on youth boxing injury rates", '
      + '"Effects of sparring exposure on youth boxing injury rates")',
    );
    expect(result).toBeGreaterThanOrEqual(0.5);
  });

  test('unrelated titles score below the match threshold', () => {
    const result = evaluate(
      'm.titleOverlap("Effects of sparring exposure on youth boxing injury rates", '
      + '"Nutrition timing strategies for endurance cyclists")',
    );
    expect(result).toBeLessThan(0.5);
  });

  test('no retrieved title returns null, not zero', () => {
    expect(evaluate('m.titleOverlap("anything", "")')).toBeNull();
  });

  test('author-year style matches on surname and a year within one', () => {
    const result = evaluate('m.authorYearMatch("Smith et al., 2021", ["Smith J", "Jones A"], "2020")');
    expect(result).toEqual({ surnameHit: true, yearHit: true });
  });

  test('author-year style misses when neither surname nor year appears', () => {
    const result = evaluate('m.authorYearMatch("Totally unrelated citation text", ["Smith J"], "2021")');
    expect(result).toEqual({ surnameHit: false, yearHit: false });
  });
});

describe('verify-research-citations adjudication', () => {
  test('no record at all is unresolved', () => {
    const result = evaluate(
      'm.adjudicate({claimedTitle: "x", identifierKind: "pmid", identifierValue: "1", record: null})',
    );
    expect(result.outcome).toBe('unresolved');
  });

  test('a resolver error is resolver_unavailable, never unresolved', () => {
    const result = evaluate(
      'm.adjudicate({claimedTitle: "x", identifierKind: "pmid", identifierValue: "1", '
      + 'record: {unavailable: true}})',
    );
    expect(result.outcome).toBe('resolver_unavailable');
  });

  test('a resolved record with no title is resolved_title_unknown', () => {
    const result = evaluate(
      'm.adjudicate({claimedTitle: "x", identifierKind: "pmid", identifierValue: "1", '
      + 'record: {title: "", year: "2021", authors: []}})',
    );
    expect(result.outcome).toBe('resolved_title_unknown');
  });

  test('matching titles resolve as a title_overlap match', () => {
    const result = evaluate(
      'm.adjudicate({claimedTitle: "Effects of sparring exposure on youth boxing injury rates", '
      + 'identifierKind: "pmid", identifierValue: "1", '
      + 'record: {title: "Effects of sparring exposure on youth boxing injury rates", year: "2021", authors: []}})',
    );
    expect(result.outcome).toBe('resolved_title_match');
    expect(result.matchMethod).toBe('title_overlap');
  });

  test('low overlap with a matching author/year clears on author_year, not a mismatch', () => {
    const result = evaluate(
      'm.adjudicate({claimedTitle: "Smith et al., 2021", identifierKind: "pmid", identifierValue: "1", '
      + 'record: {title: "Effects of sparring exposure on youth boxing injury rates", year: "2021", '
      + 'authors: ["Smith J"]}})',
    );
    expect(result.outcome).toBe('resolved_title_match');
    expect(result.matchMethod).toBe('author_year');
  });

  // THE DOI-FRAGMENT DEFECT, END TO END: the contaminated PMID resolves to a
  // real but unrelated paper. Neither title overlap nor author-year clears it,
  // so it must be flagged for adjudication -- exactly the case that a boolean
  // pass/fail would have hidden.
  test('an unrelated resolved paper is flagged as a title mismatch', () => {
    const result = evaluate(
      'm.adjudicate({claimedTitle: "Effects of sparring exposure on youth boxing injury rates", '
      + 'identifierKind: "pmid", identifierValue: "2001175", '
      + 'record: {title: "Molecular pathways in unrelated crustacean biology", year: "1998", '
      + 'authors: ["Zhang Q"]}})',
    );
    expect(result.outcome).toBe('resolved_title_mismatch');
    expect(result.retrieved.title).toBe('Molecular pathways in unrelated crustacean biology');
  });
});

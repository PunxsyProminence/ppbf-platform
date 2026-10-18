// The offline SHADOW evaluation, held to its recorded baseline.
//
// A case that moves in EITHER direction fails this test until baseline.json is
// updated in the same change (`npm run shadow:eval -- --update`). A regression
// is a defect; an improvement is a claim, and the diff to the baseline is where
// a reviewer sees exactly which cases it covers.

import fs from 'node:fs';
import path from 'node:path';

import { ROUTING_CASES } from './routingCases';
import {
  compareWithBaseline,
  formatEvaluationReport,
  parseBaseline,
  runOfflineEvaluation,
  toBaseline,
  type EvaluationBaseline,
  type EvaluationResult,
} from './runEvaluation';

const BASELINE_PATH = path.join(__dirname, 'baseline.json');

function readBaseline(): EvaluationBaseline {
  return parseBaseline(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

describe('SHADOW offline evaluation', () => {
  test('every case matches its recorded outcome', () => {
    const results = runOfflineEvaluation();

    if (process.env.SHADOW_EVAL_UPDATE === '1') {
      // Update mode rewrites the file it is about to compare against, so it
      // passes whatever the code does. Never in CI.
      if (process.env.CI) {
        throw new Error('SHADOW_EVAL_UPDATE is set in CI; the baseline is updated locally and committed');
      }
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(toBaseline(results), null, 2)}\n`);
    }

    const comparison = compareWithBaseline(results, readBaseline());
    if (process.env.SHADOW_EVAL_REPORT === '1') {
      console.log(formatEvaluationReport(results, comparison));
    }

    const moved = [
      ...comparison.regressions.map((r) => `regressed: ${r.suite}/${r.id} (${r.mismatches.join('; ')})`),
      ...comparison.improvements.map((r) => `improved, baseline not updated: ${r.suite}/${r.id}`),
      ...comparison.unrecorded.map((r) => `no baseline entry: ${r.suite}/${r.id}`),
      ...comparison.stale.map((key) => `baseline entry with no case: ${key}`),
    ];
    expect(moved).toEqual([]);
  });

  test('case ids are unique within a suite', () => {
    const keys = runOfflineEvaluation().map((r) => `${r.suite}/${r.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every routing case checks at least one thing', () => {
    // An empty expectation passes against any code.
    expect(ROUTING_CASES.filter((c) => Object.values(c.expect).every((v) => v === undefined)).map((c) => c.id))
      .toEqual([]);
  });
});

describe('baseline file', () => {
  test('a value other than pass or fail is refused, so a typo cannot make a case immune', () => {
    expect(() => parseBaseline('{"routing":{"a":"passed"}}')).toThrow('routing/a');
    expect(() => parseBaseline('{"routing":{"a":"ok"}}')).toThrow('routing/a');
    expect(() => parseBaseline('{"routing":["pass"]}')).toThrow('routing');
    expect(parseBaseline('{"routing":{"a":"pass","b":"fail"}}')).toEqual({ routing: { a: 'pass', b: 'fail' } });
  });
});

describe('baseline comparison', () => {
  const result = (id: string, outcome: 'pass' | 'fail'): EvaluationResult => ({
    suite: 's', id, outcome, mismatches: outcome === 'fail' ? ['x'] : [], note: '',
  });

  test('sorts each kind of movement into its own list', () => {
    const comparison = compareWithBaseline(
      [result('kept', 'pass'), result('broke', 'fail'), result('fixed', 'pass'), result('new', 'fail')],
      { s: { kept: 'pass', broke: 'pass', fixed: 'fail', gone: 'pass' } },
    );
    expect(comparison.regressions.map((r) => r.id)).toEqual(['broke']);
    expect(comparison.improvements.map((r) => r.id)).toEqual(['fixed']);
    expect(comparison.unrecorded.map((r) => r.id)).toEqual(['new']);
    expect(comparison.stale).toEqual(['s/gone']);
  });

  test('a failing case recorded as failing is not movement', () => {
    const comparison = compareWithBaseline([result('gap', 'fail')], { s: { gap: 'fail' } });
    expect(comparison).toEqual({ regressions: [], improvements: [], unrecorded: [], stale: [] });
  });

  test('the written baseline is sorted by suite and id', () => {
    const baseline = toBaseline([result('b', 'pass'), result('a', 'fail')]);
    expect(Object.keys(baseline.s)).toEqual(['a', 'b']);
  });
});

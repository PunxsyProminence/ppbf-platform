// runEvaluation.ts -- runs SHADOW's offline evaluation sets and compares the
// outcome with the recorded baseline.
//
// PURPOSE. A model, prompt, retrieval or rule change should be judged against
// the same questions before and after. This runs fixed cases from the repo,
// with no live data and no hosted model, and reports each case as pass or
// fail. baseline.json records what main currently does; evaluation.test.ts
// fails when a case moves in either direction until the baseline is updated
// in the same change, so every before/after is visible in the diff.
//
// Run `npm run shadow:eval` (apps/web) to print the table, and
// `npm run shadow:eval -- --update` to rewrite the baseline.
//
// What this does NOT measure: whether an answer is good. That needs a model to
// grade it, and calling one is a separately approved step.

import { classifyRequest } from '../shadowClassifier';
import { ROUTING_CASES, type RoutingCase } from './routingCases';

export type EvaluationOutcome = 'pass' | 'fail';

export interface EvaluationResult {
  suite: string;
  id: string;
  outcome: EvaluationOutcome;
  /** What did not match, one entry per checked field; empty when the case passed. */
  mismatches: string[];
  note: string;
}

/** suite -> case id -> outcome. Sorted keys, so the file diffs cleanly. */
export type EvaluationBaseline = Record<string, Record<string, EvaluationOutcome>>;

export function runRoutingEvaluation(cases: readonly RoutingCase[] = ROUTING_CASES): EvaluationResult[] {
  return cases.map((testCase) => {
    const result = classifyRequest(testCase.message, testCase.role, testCase.manualTier);
    const mismatches: string[] = [];
    const { expect } = testCase;
    if (expect.tier !== undefined && result.tier !== expect.tier) {
      mismatches.push(`tier: expected ${expect.tier}, got ${result.tier}`);
    }
    if (expect.topic !== undefined && result.topic !== expect.topic) {
      mismatches.push(`topic: expected ${expect.topic}, got ${result.topic}`);
    }
    if (expect.topicNot !== undefined && result.topic === expect.topicNot) {
      mismatches.push(`topic: expected anything but ${expect.topicNot}, got ${result.topic}`);
    }
    if (expect.complexity !== undefined && result.complexity.toFixed(2) !== expect.complexity.toFixed(2)) {
      mismatches.push(`complexity: expected ${expect.complexity.toFixed(2)}, got ${result.complexity.toFixed(2)}`);
    }
    if (expect.manualOverrideOffered !== undefined && result.requiresManualOverride !== expect.manualOverrideOffered) {
      mismatches.push(`override offered: expected ${expect.manualOverrideOffered}, got ${result.requiresManualOverride}`);
    }
    return {
      suite: 'routing',
      id: testCase.id,
      outcome: mismatches.length === 0 ? 'pass' : 'fail',
      mismatches,
      note: testCase.note,
    };
  });
}

/** Every offline suite. Retrieval and pattern-function suites join this list as they land. */
export function runOfflineEvaluation(): EvaluationResult[] {
  return [...runRoutingEvaluation()];
}

/**
 * Read a baseline, refusing any outcome other than 'pass' or 'fail'. A typo
 * ("passed") would otherwise match neither branch of the comparison, and the
 * case would never be reported as moving.
 */
export function parseBaseline(text: string): EvaluationBaseline {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('evaluation baseline must be an object of suites');
  }
  const baseline: EvaluationBaseline = {};
  for (const [suite, cases] of Object.entries(parsed)) {
    if (!cases || typeof cases !== 'object' || Array.isArray(cases)) {
      throw new Error(`evaluation baseline suite ${suite} must be an object of case outcomes`);
    }
    baseline[suite] = {};
    for (const [id, outcome] of Object.entries(cases)) {
      if (outcome !== 'pass' && outcome !== 'fail') {
        throw new Error(`evaluation baseline ${suite}/${id} is ${JSON.stringify(outcome)}; expected "pass" or "fail"`);
      }
      baseline[suite][id] = outcome;
    }
  }
  return baseline;
}

export function toBaseline(results: readonly EvaluationResult[]): EvaluationBaseline {
  const baseline: EvaluationBaseline = {};
  for (const suite of [...new Set(results.map((result) => result.suite))].sort()) {
    baseline[suite] = {};
    for (const result of results.filter((r) => r.suite === suite).sort((a, b) => a.id.localeCompare(b.id))) {
      baseline[suite][result.id] = result.outcome;
    }
  }
  return baseline;
}

export interface BaselineComparison {
  /** Recorded as passing, now failing. */
  regressions: EvaluationResult[];
  /** Recorded as failing, now passing. */
  improvements: EvaluationResult[];
  /** Cases with no baseline entry. */
  unrecorded: EvaluationResult[];
  /** Baseline entries with no case (a case was removed or renamed). */
  stale: string[];
}

export function compareWithBaseline(
  results: readonly EvaluationResult[],
  baseline: EvaluationBaseline,
): BaselineComparison {
  const comparison: BaselineComparison = { regressions: [], improvements: [], unrecorded: [], stale: [] };
  const seen = new Set<string>();
  for (const result of results) {
    seen.add(`${result.suite}/${result.id}`);
    const recorded = baseline[result.suite]?.[result.id];
    if (recorded === undefined) comparison.unrecorded.push(result);
    else if (recorded === 'pass' && result.outcome === 'fail') comparison.regressions.push(result);
    else if (recorded === 'fail' && result.outcome === 'pass') comparison.improvements.push(result);
  }
  for (const [suite, cases] of Object.entries(baseline)) {
    for (const id of Object.keys(cases)) {
      if (!seen.has(`${suite}/${id}`)) comparison.stale.push(`${suite}/${id}`);
    }
  }
  return comparison;
}

export function formatEvaluationReport(results: readonly EvaluationResult[], comparison?: BaselineComparison): string {
  const lines: string[] = [];
  for (const suite of [...new Set(results.map((result) => result.suite))].sort()) {
    const inSuite = results.filter((result) => result.suite === suite);
    const passed = inSuite.filter((result) => result.outcome === 'pass').length;
    lines.push(`${suite}: ${passed}/${inSuite.length} pass`);
    for (const result of inSuite) {
      lines.push(`  ${result.outcome === 'pass' ? 'PASS' : 'FAIL'}  ${result.id}`);
      for (const mismatch of result.mismatches) lines.push(`        ${mismatch}`);
    }
  }
  if (comparison) {
    lines.push(
      '',
      `against baseline: ${comparison.regressions.length} regressed, ${comparison.improvements.length} improved, `
        + `${comparison.unrecorded.length} unrecorded, ${comparison.stale.length} stale`,
    );
    for (const result of comparison.regressions) lines.push(`  REGRESSED  ${result.suite}/${result.id}`);
    for (const result of comparison.improvements) lines.push(`  IMPROVED   ${result.suite}/${result.id}`);
    for (const result of comparison.unrecorded) lines.push(`  UNRECORDED ${result.suite}/${result.id}`);
    for (const key of comparison.stale) lines.push(`  STALE      ${key}`);
  }
  return lines.join('\n');
}

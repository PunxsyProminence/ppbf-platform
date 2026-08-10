import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'csv-parse/sync';

/**
 * Runs the quality-weighted evidence-tier rule (shadowEvidenceTier.ts)
 * over the real 1,193-chunk seed corpus and confirms the resulting
 * distribution matches EVIDENCE_TIER_SPEC.md's own claimed numbers
 * (115 PROVEN / 796 EMERGING / 227 EXPERIMENTAL / 55 RESEARCH_NEEDED).
 *
 * WHY THIS IS THE CHECK, NOT AN OLD-RULE-VS-NEW-RULE DIFF. The spec's
 * recommended migration check ("run both rules side by side over the
 * corpus, review the differing rows") assumes the old rule is a per-claim
 * property computable from static data. It is not: the old rule graded
 * citationCount, a property of one CHAT RESPONSE's retrieval at runtime,
 * not of a claim in the registry. There is no old-rule tier for a claim
 * that was never the strongest citation in an answered chat -- the two
 * rules do not share a domain to diff over statically. What IS
 * checkable without a live database is whether the new rule, applied to
 * every claim's own evidence_class/authority_tier/boxing_specificity,
 * reproduces the distribution the spec claims -- which is this script.
 * The old-rule comparison the spec describes has to happen after the
 * corpus and the new rule are both live, by comparing tier labels on
 * real chat citations before and after the switch.
 *
 * Mirrors deriveEvidenceTier's decision table exactly
 * (src/server/pilot/shadowEvidenceTier.ts) -- kept as a duplicate, not an
 * import, because this script must run with zero database connection and
 * zero TypeScript build step, matching every other apps/web/scripts/*.mjs
 * convention. If the two ever disagree, this script's own assertion
 * against the spec's published numbers is what catches the drift.
 */

const BOXING_SPECIFIC_VALUES = new Set(['boxing_specific', 'ppbf_specific']);

function deriveTier({ evidenceClass, authorityTier, boxingSpecificity }) {
  if (evidenceClass === 'INSUFFICIENT EVIDENCE') {
    return 'RESEARCH_NEEDED';
  }
  if (
    evidenceClass === 'CONTESTED PRACTICE'
    || evidenceClass === 'HYPOTHESIS REQUIRING TESTING'
    || evidenceClass === 'COACHING/FILM-STUDY INTERPRETATION'
  ) {
    return 'EXPERIMENTAL';
  }
  if (evidenceClass === 'STRONG EVIDENCE-SUPPORTED INFERENCE') {
    return authorityTier <= 3 ? 'EMERGING' : 'EXPERIMENTAL';
  }
  if (evidenceClass === 'VERIFIED EVIDENCE') {
    if (authorityTier <= 2 && BOXING_SPECIFIC_VALUES.has(boxingSpecificity)) {
      return 'PROVEN';
    }
    if (authorityTier <= 3) {
      return 'EMERGING';
    }
    return 'EXPERIMENTAL';
  }
  throw new Error(`UNKNOWN_EVIDENCE_CLASS:${evidenceClass}`);
}

const EXPECTED_DISTRIBUTION = Object.freeze({
  PROVEN: 115,
  EMERGING: 796,
  EXPERIMENTAL: 227,
  RESEARCH_NEEDED: 55,
});

export async function computeCorpusDistribution(chunksCsvPath) {
  const source = await fs.readFile(chunksCsvPath, 'utf8');
  const rows = parse(source, { bom: true, columns: true, skip_empty_lines: true });

  const distribution = { PROVEN: 0, EMERGING: 0, EXPERIMENTAL: 0, RESEARCH_NEEDED: 0 };
  const byTier = { PROVEN: [], EMERGING: [], EXPERIMENTAL: [], RESEARCH_NEEDED: [] };

  for (const row of rows) {
    const metadata = JSON.parse(row.metadata || '{}');
    const tier = deriveTier({
      evidenceClass: metadata.evidence_class,
      authorityTier: metadata.authority_tier,
      boxingSpecificity: metadata.boxing_specificity,
    });
    distribution[tier] += 1;
    byTier[tier].push(metadata.claim_id ?? row.chunk_id);
  }

  return { totalRows: rows.length, distribution, byTier };
}

export async function run() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const chunksCsvPath = path.resolve(
    __dirname,
    '../seed-data/shadow-research/2026-08-07/seed_shadow_library_chunks.csv',
  );

  const { totalRows, distribution } = await computeCorpusDistribution(chunksCsvPath);

  console.log(`total chunks scored: ${totalRows}`);
  console.log(JSON.stringify(distribution, null, 2));

  const mismatches = Object.entries(EXPECTED_DISTRIBUTION)
    .filter(([tier, expected]) => distribution[tier] !== expected)
    .map(([tier, expected]) => `${tier}: expected ${expected}, got ${distribution[tier]}`);

  if (mismatches.length > 0) {
    throw new Error(`EVIDENCE_TIER_DISTRIBUTION_MISMATCH:\n${mismatches.join('\n')}`);
  }

  console.log('Matches EVIDENCE_TIER_SPEC.md exactly: 115 PROVEN / 796 EMERGING / 227 EXPERIMENTAL / 55 RESEARCH_NEEDED.');
  console.log('EVIDENCE TIER CORPUS VERIFICATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('EVIDENCE TIER CORPUS VERIFICATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}

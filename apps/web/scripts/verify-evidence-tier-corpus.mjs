import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'csv-parse/sync';

/**
 * Runs the quality-weighted evidence-tier rule (shadowEvidenceTier.ts)
 * over the real 1,193-chunk seed corpus and confirms the resulting
 * distribution matches the one EVIDENCE_TIER_SPEC.md section 4 publishes.
 *
 * GRADED ON THE SOURCE ROW'S TIER, AS RUNTIME IS. SHADOW labels a claim
 * with the authority_tier of the chunk's SOURCE ROW: the retrieval query
 * selects s.authority_tier (shadowLibrary.ts), shadowEvidence.ts carries it
 * as authorityTier, and the chat route and job processor pass that to
 * deriveEvidenceTier. evidence_class and boxing_specificity come from the
 * chunk's metadata. This script used to read authority_tier from the
 * chunk's metadata instead -- a copy that is not what runtime reads -- so
 * when #1008 changed tiers on source rows only, this gate kept reporting
 * the old distribution while the labels users see had moved. It now joins
 * chunk.source_id to seed_shadow_library_sources.csv, exactly as runtime
 * joins the tables, and fails on a chunk whose source is missing (runtime's
 * inner join would silently drop it). The chunk-metadata copy is still
 * reported, and the number of chunks whose copy disagrees with their
 * source, so drift between the two stays visible without being graded on.
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
 * every claim's own evidence_class/boxing_specificity and its source's
 * authority_tier, reproduces the distribution the spec publishes -- which
 * is this script. The old-rule comparison the spec describes has to happen
 * after the corpus and the new rule are both live, by comparing tier
 * labels on real chat citations before and after the switch.
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

// EVIDENCE_TIER_SPEC.md section 4, graded on the source row. Moved from
// 115/796/227/55 (graded on the chunk metadata copy) on 2026-09-29, after the
// owner's "set them by the spec" tier corrections were written to source rows
// and chunk metadata and the result was confirmed claim by claim.
const EXPECTED_DISTRIBUTION = Object.freeze({
  PROVEN: 122,
  EMERGING: 821,
  EXPERIMENTAL: 195,
  RESEARCH_NEEDED: 55,
});

function emptyDistribution() {
  return { PROVEN: 0, EMERGING: 0, EXPERIMENTAL: 0, RESEARCH_NEEDED: 0 };
}

async function readCsv(csvPath) {
  const source = await fs.readFile(csvPath, 'utf8');
  return parse(source, { bom: true, columns: true, skip_empty_lines: true });
}

/** source_id -> authority_tier, the value runtime grades on. */
async function readSourceTiers(sourcesCsvPath) {
  const tiers = new Map();
  for (const row of await readCsv(sourcesCsvPath)) {
    if (!/^[1-5]$/.test(String(row.authority_tier))) {
      throw new Error(`INVALID_SOURCE_AUTHORITY_TIER:${row.source_id}:${row.authority_tier}`);
    }
    tiers.set(row.source_id, Number(row.authority_tier));
  }
  return tiers;
}

/**
 * Scores every chunk on its source row's authority_tier (the runtime
 * basis). `sourcesCsvPath` defaults to the sources file beside the chunks
 * file, which is how the seed package ships them.
 */
export async function computeCorpusDistribution(
  chunksCsvPath,
  sourcesCsvPath = path.join(path.dirname(chunksCsvPath), 'seed_shadow_library_sources.csv'),
) {
  const rows = await readCsv(chunksCsvPath);
  const sourceTiers = await readSourceTiers(sourcesCsvPath);

  const distribution = emptyDistribution();
  const byTier = { PROVEN: [], EMERGING: [], EXPERIMENTAL: [], RESEARCH_NEEDED: [] };
  const chunkMetadataDistribution = emptyDistribution();
  const chunkTierMismatches = [];

  for (const row of rows) {
    const metadata = JSON.parse(row.metadata || '{}');
    if (!sourceTiers.has(row.source_id)) {
      throw new Error(`CHUNK_SOURCE_MISSING:${row.chunk_id}:${row.source_id}`);
    }
    const sourceTier = sourceTiers.get(row.source_id);
    const tier = deriveTier({
      evidenceClass: metadata.evidence_class,
      authorityTier: sourceTier,
      boxingSpecificity: metadata.boxing_specificity,
    });
    distribution[tier] += 1;
    byTier[tier].push(metadata.claim_id ?? row.chunk_id);

    chunkMetadataDistribution[deriveTier({
      evidenceClass: metadata.evidence_class,
      authorityTier: metadata.authority_tier,
      boxingSpecificity: metadata.boxing_specificity,
    })] += 1;
    if (metadata.authority_tier !== sourceTier) {
      chunkTierMismatches.push(metadata.claim_id ?? row.chunk_id);
    }
  }

  return { totalRows: rows.length, distribution, byTier, chunkMetadataDistribution, chunkTierMismatches };
}

function format(distribution) {
  return `${distribution.PROVEN} PROVEN / ${distribution.EMERGING} EMERGING / `
    + `${distribution.EXPERIMENTAL} EXPERIMENTAL / ${distribution.RESEARCH_NEEDED} RESEARCH_NEEDED`;
}

export async function run() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const chunksCsvPath = path.resolve(
    __dirname,
    '../seed-data/shadow-research/2026-08-07/seed_shadow_library_chunks.csv',
  );

  const { totalRows, distribution, chunkMetadataDistribution, chunkTierMismatches } = await computeCorpusDistribution(
    chunksCsvPath,
  );

  console.log(`total chunks scored: ${totalRows}`);
  console.log(`graded on the source row's authority_tier (runtime basis): ${format(distribution)}`);
  console.log(`for reference, graded on the chunk metadata copy:         ${format(chunkMetadataDistribution)}`);
  console.log(`chunks whose metadata authority_tier differs from their source row: ${chunkTierMismatches.length}`);

  const mismatches = Object.entries(EXPECTED_DISTRIBUTION)
    .filter(([tier, expected]) => distribution[tier] !== expected)
    .map(([tier, expected]) => `${tier}: expected ${expected}, got ${distribution[tier]}`);

  if (mismatches.length > 0) {
    throw new Error(`EVIDENCE_TIER_DISTRIBUTION_MISMATCH:\n${mismatches.join('\n')}`);
  }

  console.log(`Matches EVIDENCE_TIER_SPEC.md section 4 exactly: ${format(EXPECTED_DISTRIBUTION)}.`);
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

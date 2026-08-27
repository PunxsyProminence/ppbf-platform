import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse } from 'csv-parse/sync';

import {
  deriveEvidenceTier,
  type ShadowBoxingSpecificity,
  type ShadowEvidenceClass,
  type ShadowEvidenceTier,
} from './shadowEvidenceTier';

/**
 * evidence-corpus.yml runs scripts/verify-evidence-tier-corpus.mjs, which
 * scores the 1,193-chunk corpus with its OWN copy of the tier rule and
 * asserts the distribution EVIDENCE_TIER_SPEC.md publishes. That copy is
 * the hole: nothing ran the PRODUCTION rule (shadowEvidenceTier.ts, the
 * one shadowJobProcessor.ts actually labels chat responses with) over the
 * corpus, so the application rule could change the real distribution while
 * the new gate went on reporting 115/796/227/55 from the duplicate.
 *
 * This suite closes it from the other side. It runs the production export
 * over the same committed CSV and compares BOTH the distribution against
 * the published numbers AND every row's tier against what the script's
 * duplicate assigns it -- so the two implementations cannot drift apart
 * silently in either direction, and a change to the production rule turns
 * a jest suite red on the normal CI path even when the corpus itself is
 * untouched.
 *
 * The two are not the same function. Production gates on answer state
 * first (a filtered/degraded/queued response grades RESEARCH_NEEDED before
 * any evidence is looked at) and treats an unrecognised evidence_class as
 * VERIFIED EVIDENCE by fall-through; the script throws on one. Neither
 * difference applies to a corpus chunk, which is a stored claim rather
 * than a chat response -- so the parity comparison below feeds production
 * an answered, evidence-available response, and a separate test pins that
 * the corpus never carries a class outside the declared vocabulary, which
 * is the only input on which the two would legitimately disagree.
 */

const WEB_ROOT = path.resolve(__dirname, '../../..');
const CORPUS_CSV = path.join(
  WEB_ROOT,
  'seed-data/shadow-research/2026-08-07/seed_shadow_library_chunks.csv',
);
const VERIFIER_SCRIPT = path.join(WEB_ROOT, 'scripts/verify-evidence-tier-corpus.mjs');
const WORKFLOW = path.resolve(WEB_ROOT, '../../.github/workflows/evidence-corpus.yml');

// Verbatim from EVIDENCE_TIER_SPEC.md, and duplicated on purpose: the
// script asserts the same four numbers against its own copy of the rule.
// If a corpus change moves the real distribution, BOTH have to be updated
// deliberately, which is the point.
const PUBLISHED_DISTRIBUTION: Readonly<Record<ShadowEvidenceTier, number>> = Object.freeze({
  PROVEN: 115,
  EMERGING: 796,
  EXPERIMENTAL: 227,
  RESEARCH_NEEDED: 55,
});
const PUBLISHED_TOTAL = 1193;

const DECLARED_EVIDENCE_CLASSES: ReadonlySet<string> = new Set<ShadowEvidenceClass>([
  'VERIFIED EVIDENCE',
  'STRONG EVIDENCE-SUPPORTED INFERENCE',
  'CONTESTED PRACTICE',
  'HYPOTHESIS REQUIRING TESTING',
  'COACHING/FILM-STUDY INTERPRETATION',
  'INSUFFICIENT EVIDENCE',
]);

interface CorpusChunk {
  key: string;
  evidenceClass: string;
  authorityTier: number;
  boxingSpecificity: string;
}

interface Scored {
  totalRows: number;
  distribution: Record<ShadowEvidenceTier, number>;
  byTier: Record<ShadowEvidenceTier, string[]>;
}

function emptyScored(): Scored {
  return {
    totalRows: 0,
    distribution: { PROVEN: 0, EMERGING: 0, EXPERIMENTAL: 0, RESEARCH_NEEDED: 0 },
    byTier: { PROVEN: [], EMERGING: [], EXPERIMENTAL: [], RESEARCH_NEEDED: [] },
  };
}

function readCorpus(): CorpusChunk[] {
  const source = fs.readFileSync(CORPUS_CSV, 'utf8');
  const rows: Array<Record<string, string>> = parse(source, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
  });
  return rows.map((row) => {
    const metadata = JSON.parse(row.metadata || '{}');
    return {
      // Mirrors the script's own `metadata.claim_id ?? row.chunk_id`, so
      // the two byTier listings are comparable identity for identity.
      key: metadata.claim_id ?? row.chunk_id,
      evidenceClass: metadata.evidence_class,
      authorityTier: metadata.authority_tier,
      boxingSpecificity: metadata.boxing_specificity,
    };
  });
}

/** The production rule, fed a chunk as if it were the strongest citation of an answered response. */
function scoreWithProductionRule(chunks: CorpusChunk[]): Scored {
  const scored = emptyScored();
  for (const chunk of chunks) {
    const tier = deriveEvidenceTier({
      isAnsweredState: true,
      evidenceAvailability: 'available',
      strongestEvidence: {
        evidenceClass: chunk.evidenceClass as ShadowEvidenceClass,
        authorityTier: chunk.authorityTier,
        boxingSpecificity: chunk.boxingSpecificity as ShadowBoxingSpecificity,
      },
    });
    scored.distribution[tier] += 1;
    scored.byTier[tier].push(chunk.key);
  }
  scored.totalRows = chunks.length;
  return scored;
}

/**
 * The script is ESM and the default jest runner has no ESM loader, so its
 * exported computeCorpusDistribution is invoked in a child process -- the
 * same shape the workflow runs it in, not a re-implementation of it.
 */
function scoreWithVerifierScript(): Scored {
  const stdout = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        `const { computeCorpusDistribution } = await import(${JSON.stringify(pathToFileURL(VERIFIER_SCRIPT).href)});`,
        `const result = await computeCorpusDistribution(${JSON.stringify(CORPUS_CSV)});`,
        'process.stdout.write(JSON.stringify(result));',
      ].join('\n'),
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, cwd: WEB_ROOT },
  );
  return JSON.parse(stdout);
}

let corpus: CorpusChunk[];
let production: Scored;

beforeAll(() => {
  corpus = readCorpus();
  production = scoreWithProductionRule(corpus);
});

describe('the production evidence-tier rule over the real seed corpus', () => {
  it('scores every chunk the spec counts', () => {
    expect(production.totalRows).toBe(PUBLISHED_TOTAL);
  });

  it('reproduces the distribution EVIDENCE_TIER_SPEC.md publishes', () => {
    expect(production.distribution).toEqual(PUBLISHED_DISTRIBUTION);
  });

  it('never falls through on an evidence class outside the declared vocabulary', () => {
    // deriveEvidenceTier has no unknown-class branch: anything it does not
    // recognise lands in the VERIFIED EVIDENCE tail and can be graded
    // PROVEN. The script throws UNKNOWN_EVIDENCE_CLASS instead. That is the
    // one input where the two legitimately disagree, so the corpus must
    // never contain it.
    const undeclared = [
      ...new Set(corpus.map((chunk) => chunk.evidenceClass).filter((cls) => !DECLARED_EVIDENCE_CLASSES.has(cls))),
    ];
    expect(undeclared).toEqual([]);
  });

  it('exercises every branch of the rule and produces every tier', () => {
    // A corpus that happened to be all one class would satisfy the
    // distribution assertion above while proving almost nothing about the
    // rule, so state what the corpus actually covers: all six declared
    // classes are present, and all four tiers come out non-empty.
    const classes = [...new Set(corpus.map((chunk) => chunk.evidenceClass))].sort();
    expect(classes).toEqual([...DECLARED_EVIDENCE_CLASSES].sort());
    for (const tier of Object.keys(PUBLISHED_DISTRIBUTION) as ShadowEvidenceTier[]) {
      expect(production.distribution[tier]).toBeGreaterThan(0);
    }
  });

  it('has no chunk that separates ppbf_specific from boxing_specific at the PROVEN gate', () => {
    // A stated blind spot, not coverage. BOXING_SPECIFIC_VALUES counts
    // ppbf_specific as boxing-specific, and shadowEvidenceTier.ts's own
    // comment says the corpus contains no VERIFIED EVIDENCE row at
    // authority tier <= 2 carrying it -- so dropping ppbf_specific from
    // that set moves no chunk here and nothing above would go red.
    // Measured rather than assumed: the corpus does carry ppbf_specific
    // chunks, none of them reach the gate, and the day one does this goes
    // red and whoever added it decides deliberately.
    const ppbfSpecific = corpus.filter((chunk) => chunk.boxingSpecificity === 'ppbf_specific');
    expect(ppbfSpecific.length).toBeGreaterThan(0);

    const atProvenGate = ppbfSpecific.filter(
      (chunk) => chunk.evidenceClass === 'VERIFIED EVIDENCE' && chunk.authorityTier <= 2,
    );
    expect(atProvenGate.map((chunk) => chunk.key)).toEqual([]);
  });
});

describe('parity with the verifier script evidence-corpus.yml runs', () => {
  it('assigns every single chunk the same tier as the duplicated rule', () => {
    const script = scoreWithVerifierScript();
    expect(script.totalRows).toBe(production.totalRows);
    expect(script.distribution).toEqual(production.distribution);
    for (const tier of Object.keys(PUBLISHED_DISTRIBUTION) as ShadowEvidenceTier[]) {
      expect([...script.byTier[tier]].sort()).toEqual([...production.byTier[tier]].sort());
    }
  });
});

describe('evidence-corpus.yml fires when its inputs change', () => {
  const workflow = () => fs.readFileSync(WORKFLOW, 'utf8');

  it('watches the production rule, not only the corpus and the script', () => {
    // The gate was originally filtered to the corpus and the script alone,
    // so a pull request editing shadowEvidenceTier.ts skipped it entirely.
    expect(workflow()).toContain('apps/web/src/server/pilot/shadowEvidenceTier.ts');
  });

  it('watches this parity suite', () => {
    expect(workflow()).toContain('apps/web/src/server/pilot/shadowEvidenceTierCorpus.test.ts');
  });
});

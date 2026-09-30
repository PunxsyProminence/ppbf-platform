import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
 * the new gate went on reporting the published numbers from the duplicate.
 *
 * This suite closes it from the other side. It runs the production export
 * over the same committed CSVs and compares BOTH the distribution against
 * the published numbers AND every row's tier against what the script's
 * duplicate assigns it -- so the two implementations cannot drift apart
 * silently in either direction, and a change to the production rule turns
 * a jest suite red on the normal CI path even when the corpus itself is
 * untouched.
 *
 * GRADED ON THE SOURCE ROW, AS RUNTIME IS. Runtime labels a claim with its
 * source row's authority_tier (shadowLibrary.ts selects s.authority_tier;
 * evidence_class and boxing_specificity come from the chunk's metadata).
 * Both this suite and the script used to read the tier copy in the chunk's
 * metadata instead, which is how #1008 changed the labels users see while
 * this gate went on reporting the old distribution. Both now join the
 * chunk's source_id to seed_shadow_library_sources.csv. The chunk copy is
 * still held consistent below, but it is not what gets graded.
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
const CORPUS_DIR = path.join(WEB_ROOT, 'seed-data/shadow-research/2026-08-07');
const CORPUS_CSV = path.join(CORPUS_DIR, 'seed_shadow_library_chunks.csv');
const SOURCES_CSV = path.join(CORPUS_DIR, 'seed_shadow_library_sources.csv');
const VERIFIER_SCRIPT = path.join(WEB_ROOT, 'scripts/verify-evidence-tier-corpus.mjs');
const WORKFLOW = path.resolve(WEB_ROOT, '../../.github/workflows/evidence-corpus.yml');

// Verbatim from EVIDENCE_TIER_SPEC.md section 4, and duplicated on purpose:
// the script asserts the same four numbers against its own copy of the rule.
// If a corpus change moves the real distribution, BOTH have to be updated
// deliberately, which is the point. Graded on the source row since
// 2026-09-29; it read 115/796/227/55 graded on the chunk metadata copy.
const PUBLISHED_DISTRIBUTION: Readonly<Record<ShadowEvidenceTier, number>> = Object.freeze({
  PROVEN: 122,
  EMERGING: 821,
  EXPERIMENTAL: 195,
  RESEARCH_NEEDED: 55,
});
const PUBLISHED_TOTAL = 1193;

// Chunks whose metadata tier still differs from their source row. None is on
// a source whose tier was set by the spec (that is asserted below); they
// predate #1008 and are an open owner item -- several sources look mis-tiered
// against the spec -- not something to paper over by copying one value onto
// the other. Pinned so the number can only move deliberately.
const KNOWN_CHUNK_SOURCE_TIER_DIFFERENCES = 33;

const DECLARED_EVIDENCE_CLASSES: ReadonlySet<string> = new Set<ShadowEvidenceClass>([
  'VERIFIED EVIDENCE',
  'STRONG EVIDENCE-SUPPORTED INFERENCE',
  'CONTESTED PRACTICE',
  'HYPOTHESIS REQUIRING TESTING',
  'COACHING/FILM-STUDY INTERPRETATION',
  'INSUFFICIENT EVIDENCE',
]);

interface CorpusSource {
  sourceId: string;
  authorityTier: number;
  metadata: { tier_conflict?: { tier_set?: number } };
}

interface CorpusChunk {
  key: string;
  sourceId: string;
  evidenceClass: string;
  /** The SOURCE ROW's authority_tier: what runtime grades on. */
  authorityTier: number;
  /** The copy in the chunk's own metadata: kept consistent, not graded on. */
  metadataAuthorityTier: number;
  metadataEvidenceTier: string;
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

function readCsv(file: string): Array<Record<string, string>> {
  return parse(fs.readFileSync(file, 'utf8'), { bom: true, columns: true, skip_empty_lines: true });
}

function readSources(): Map<string, CorpusSource> {
  return new Map(readCsv(SOURCES_CSV).map((row) => [row.source_id, {
    sourceId: row.source_id,
    authorityTier: Number(row.authority_tier),
    metadata: JSON.parse(row.metadata || '{}'),
  }]));
}

function readCorpus(sourcesById: Map<string, CorpusSource>): CorpusChunk[] {
  return readCsv(CORPUS_CSV).map((row) => {
    const metadata = JSON.parse(row.metadata || '{}');
    const source = sourcesById.get(row.source_id);
    if (!source) throw new Error(`chunk ${row.chunk_id} names a missing source ${row.source_id}`);
    return {
      // Mirrors the script's own `metadata.claim_id ?? row.chunk_id`, so
      // the two byTier listings are comparable identity for identity.
      key: metadata.claim_id ?? row.chunk_id,
      sourceId: row.source_id,
      evidenceClass: metadata.evidence_class,
      authorityTier: source.authorityTier,
      metadataAuthorityTier: metadata.authority_tier,
      metadataEvidenceTier: metadata.evidence_tier,
      boxingSpecificity: metadata.boxing_specificity,
    };
  });
}

function productionTier(evidenceClass: string, authorityTier: number, boxingSpecificity: string): ShadowEvidenceTier {
  return deriveEvidenceTier({
    isAnsweredState: true,
    evidenceAvailability: 'available',
    strongestEvidence: {
      evidenceClass: evidenceClass as ShadowEvidenceClass,
      authorityTier,
      boxingSpecificity: boxingSpecificity as ShadowBoxingSpecificity,
    },
  });
}

/** The production rule, fed a chunk as if it were the strongest citation of an answered response. */
function scoreWithProductionRule(chunks: CorpusChunk[]): Scored {
  const scored = emptyScored();
  for (const chunk of chunks) {
    const tier = productionTier(chunk.evidenceClass, chunk.authorityTier, chunk.boxingSpecificity);
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
function scoreWithVerifierScript(chunksCsv: string = CORPUS_CSV, sourcesCsv?: string): Scored {
  const args = [chunksCsv, ...(sourcesCsv ? [sourcesCsv] : [])].map((arg) => JSON.stringify(arg)).join(', ');
  const stdout = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        `const { computeCorpusDistribution } = await import(${JSON.stringify(pathToFileURL(VERIFIER_SCRIPT).href)});`,
        `const result = await computeCorpusDistribution(${args});`,
        'process.stdout.write(JSON.stringify(result));',
      ].join('\n'),
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, cwd: WEB_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(stdout);
}

let sources: Map<string, CorpusSource>;
let corpus: CorpusChunk[];
let production: Scored;

beforeAll(() => {
  sources = readSources();
  corpus = readCorpus(sources);
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

describe('graded on the source row, as runtime is', () => {
  // A two-row package where the chunk's metadata copy and its source row
  // disagree. Only the source row decides, because only the source row is
  // what shadowLibrary.ts selects.
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-tier-basis-'));
    fs.writeFileSync(
      path.join(dir, 'seed_shadow_library_sources.csv'),
      'source_id,authority_tier\nsrc_position_statement,1\n',
    );
    const metadata = JSON.stringify({
      claim_id: 'X-001',
      evidence_class: 'VERIFIED EVIDENCE',
      authority_tier: 4,
      boxing_specificity: 'boxing_specific',
    });
    fs.writeFileSync(
      path.join(dir, 'seed_shadow_library_chunks.csv'),
      `chunk_id,source_id,metadata\nchk_one,src_position_statement,"${metadata.replace(/"/g, '""')}"\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'orphan_chunks.csv'),
      `chunk_id,source_id,metadata\nchk_two,src_not_there,"${metadata.replace(/"/g, '""')}"\n`,
    );
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the script grades the claim on its source row, not on the chunk metadata copy', () => {
    // Graded on the copy (tier 4) this would be EXPERIMENTAL; the source row
    // says tier 1, boxing-specific, verified -- PROVEN, which is what a user
    // would be shown.
    const script = scoreWithVerifierScript(path.join(dir, 'seed_shadow_library_chunks.csv'));
    expect(script.byTier.PROVEN).toEqual(['X-001']);
    expect(productionTier('VERIFIED EVIDENCE', 1, 'boxing_specific')).toBe('PROVEN');
  });

  it('the script refuses a chunk whose source row is missing instead of grading it', () => {
    // Runtime's inner join would silently drop such a chunk; a corpus gate
    // that graded it anyway would count evidence nobody can retrieve.
    expect(() => scoreWithVerifierScript(
      path.join(dir, 'orphan_chunks.csv'),
      path.join(dir, 'seed_shadow_library_sources.csv'),
    )).toThrow(/CHUNK_SOURCE_MISSING:chk_two:src_not_there/);
  });
});

describe('the chunk metadata copy of the tier stays consistent', () => {
  it('every tier the owner ruling set is on the source row and on every chunk of it', () => {
    // metadata.tier_conflict records where duplicate copies disagreed and the
    // tier the spec then set. A source whose row, or any of whose chunks,
    // says something else has contradicted that resolution.
    const ruled = [...sources.values()].filter((source) => source.metadata.tier_conflict);
    expect(ruled.length).toBeGreaterThan(0);
    const contradictions: string[] = [];
    for (const source of ruled) {
      const tierSet = source.metadata.tier_conflict?.tier_set;
      if (tierSet === undefined) {
        contradictions.push(`${source.sourceId}: tier_conflict records no tier_set`);
        continue;
      }
      if (source.authorityTier !== tierSet) {
        contradictions.push(`${source.sourceId}: source row ${source.authorityTier} vs tier_set ${tierSet}`);
      }
      for (const chunk of corpus.filter((c) => c.sourceId === source.sourceId)) {
        if (chunk.metadataAuthorityTier !== tierSet) {
          contradictions.push(`${chunk.key}: chunk metadata ${chunk.metadataAuthorityTier} vs tier_set ${tierSet}`);
        }
      }
    }
    expect(contradictions).toEqual([]);
  });

  it("every chunk's metadata.evidence_tier is the label its own metadata derives", () => {
    // A half-applied tier edit -- authority_tier changed, the stored label
    // not -- leaves a chunk contradicting itself. The label is not graded on;
    // it just must not lie.
    const stale = corpus
      .filter((chunk) => chunk.metadataEvidenceTier
        !== productionTier(chunk.evidenceClass, chunk.metadataAuthorityTier, chunk.boxingSpecificity))
      .map((chunk) => chunk.key);
    expect(stale).toEqual([]);
  });

  it('the chunks whose metadata tier still differs from their source are a known number', () => {
    const differing = corpus.filter((chunk) => chunk.metadataAuthorityTier !== chunk.authorityTier);
    expect(differing.length).toBe(KNOWN_CHUNK_SOURCE_TIER_DIFFERENCES);
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

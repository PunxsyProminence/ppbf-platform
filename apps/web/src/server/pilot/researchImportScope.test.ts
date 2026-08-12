// Contract tests for the corpus scope split and the capability feeder tracks.
//
// These run against the REAL seed package in
// seed-data/shadow-research/2026-08-07, not a fixture. That is the point: the
// split is defined by properties of that corpus -- which sources are
// internal_policy, which of them is the structural programme row every document
// hangs off, and which documents the policy chunks happen to sit in. A fixture
// would let all of those drift without a test noticing, and the failure mode is
// silent: a platform baseline missing evidence looks exactly like a platform
// baseline.
//
// The module under test is real ESM (.mjs) consumed by a node script, and the
// default jest runner has no ESM loader (`npm test` does not pass
// --experimental-vm-modules). As in postgresWriteTarget.test.ts, everything is
// evaluated in one real `node` child process.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MODULE_URL = pathToFileURL(
  path.resolve(__dirname, '../../../scripts/import-shadow-research.mjs'),
).href;

const PROGRAMME_SOURCE_ID = 'src_6563c68e39047128';
const COPIED_PROGRAMME_SOURCE_ID = 'src_ppbfpol_6563c68e39047128';
const ORG = '__platform__';
const GYM = 'ppbf-gym-1';
const ACCOUNT = 'acct-admin';

interface Row {
  source_id?: string;
  document_id?: string;
  chunk_id?: string;
  source_type?: string;
  capability_key?: string;
  feeder_tracks?: string[];
  metadata?: Record<string, unknown>;
}

interface Package {
  sources: Row[];
  documents: Row[];
  chunks: Row[];
  capabilityMap: Row[];
  requirements: Row[];
}

let whole: Package;
let baseline: Package;
let policy: Package;
let identityIsSameObject: boolean;
let unknownScopeError: string;
let feeder: Record<string, string[] | null>;

beforeAll(() => {
  const script = `
    import * as importer from ${JSON.stringify(MODULE_URL)};

    const base = { seedDir: undefined, accountId: ${JSON.stringify(ACCOUNT)} };
    const whole = await importer.loadSeedPackage({ ...base, organizationId: ${JSON.stringify(GYM)} });
    const baseline = await importer.loadSeedPackage({
      ...base, organizationId: ${JSON.stringify(ORG)}, scope: 'platform_baseline',
    });
    const policy = await importer.loadSeedPackage({
      ...base, organizationId: ${JSON.stringify(GYM)}, scope: 'ppbf_policy',
    });

    // A null scope must not merely produce equal output -- it must not touch the
    // package at all, which is what keeps every pre-split caller unaffected.
    const identityIsSameObject = importer.applySeedScope(whole, null) === whole;

    let unknownScopeError = '';
    try { importer.applySeedScope(whole, 'not_a_scope'); }
    catch (e) { unknownScopeError = e.message; }

    const feeder = {
      single: importer.parseFeederTracks('A1'),
      piped: importer.parseFeederTracks('A3|A6'),
      spaced: importer.parseFeederTracks(' A4 | B1 |B3 '),
      empty: importer.parseFeederTracks(''),
      nullish: importer.parseFeederTracks(null),
      trailing: importer.parseFeederTracks('A5|'),
    };

    process.stdout.write(JSON.stringify({
      whole, baseline, policy, identityIsSameObject, unknownScopeError, feeder,
    }));
  `;

  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout);
  whole = parsed.whole;
  baseline = parsed.baseline;
  policy = parsed.policy;
  identityIsSameObject = parsed.identityIsSameObject;
  unknownScopeError = parsed.unknownScopeError;
  feeder = parsed.feeder;
});

function counts(pkg: Package) {
  return {
    sources: pkg.sources.length,
    documents: pkg.documents.length,
    chunks: pkg.chunks.length,
    capabilityMap: pkg.capabilityMap.length,
    requirements: pkg.requirements.length,
  };
}

describe('no scope', () => {
  test('imports the whole corpus, unchanged', () => {
    expect(counts(whole)).toEqual({
      sources: 1214, documents: 14, chunks: 1193, capabilityMap: 30, requirements: 229,
    });
  });

  test('returns the very same package object, not a copy', () => {
    // Every caller that predates the split goes through this path.
    expect(identityIsSameObject).toBe(true);
  });

  test('refuses a scope it does not know instead of importing everything', () => {
    expect(unknownScopeError).toBe('UNKNOWN_SEED_SCOPE:not_a_scope');
  });
});

describe('platform_baseline scope', () => {
  test('THE POINT: everything except PPBF house documents', () => {
    expect(counts(baseline)).toEqual({
      sources: 1194, documents: 14, chunks: 1173, capabilityMap: 30, requirements: 229,
    });
  });

  test('holds no PPBF policy source', () => {
    const policySources = baseline.sources.filter(
      (row) => row.source_type === 'internal_policy' && row.source_id !== PROGRAMME_SOURCE_ID,
    );
    expect(policySources).toEqual([]);
  });

  test('keeps the structural programme source, which is also internal_policy', () => {
    // Filtering on source_type alone would take this row -- and with it the
    // parent of all 14 documents, which is every chunk in the corpus.
    expect(baseline.sources.some((row) => row.source_id === PROGRAMME_SOURCE_ID)).toBe(true);
  });

  test('drops exactly the 20 chunks that cite a policy source', () => {
    expect(whole.chunks.length - baseline.chunks.length).toBe(20);
  });

  test('every surviving chunk still cites a source in the package', () => {
    // loadSeedPackage would have thrown CHUNK_SOURCE_NOT_IN_PACKAGE, but assert
    // it here too: this is the property that makes the split safe to import.
    const ids = new Set(baseline.sources.map((row) => row.source_id));
    expect(baseline.chunks.filter((row) => !ids.has(row.source_id!))).toEqual([]);
  });
});

describe('ppbf_policy scope', () => {
  test('THE POINT: the house documents, their chunks, and the documents holding them', () => {
    expect(counts(policy)).toEqual({
      sources: 21, documents: 6, chunks: 20, capabilityMap: 0, requirements: 0,
    });
  });

  test('carries only policy sources plus one copied programme row', () => {
    const copied = policy.sources.filter((row) => row.source_id === COPIED_PROGRAMME_SOURCE_ID);
    expect(copied).toHaveLength(1);
    const rest = policy.sources.filter((row) => row.source_id !== COPIED_PROGRAMME_SOURCE_ID);
    expect(rest).toHaveLength(20);
    expect(rest.every((row) => row.source_type === 'internal_policy')).toBe(true);
  });

  test('copies the programme source rather than moving it', () => {
    // The original stays in the baseline; both organizations need a parent for
    // their documents, and document_id/source_id are primary keys.
    expect(policy.sources.some((row) => row.source_id === PROGRAMME_SOURCE_ID)).toBe(false);
    expect(baseline.sources.some((row) => row.source_id === PROGRAMME_SOURCE_ID)).toBe(true);
  });

  test('gives copied documents new ids, so they do not collide with the baseline', () => {
    // Still `doc_`-prefixed: the evidence review route validates library ids on
    // that first segment, so a copy that led with the copy marker would be a
    // document no reviewer could approve.
    expect(policy.documents.every((row) => row.document_id!.startsWith('doc_ppbfpol_'))).toBe(true);
    const baselineIds = new Set(baseline.documents.map((row) => row.document_id));
    expect(policy.documents.filter((row) => baselineIds.has(row.document_id))).toEqual([]);
  });

  test('records what each copy copies', () => {
    for (const document of policy.documents) {
      expect(typeof document.metadata!.copied_from_document_id).toBe('string');
      expect(document.metadata!.copied_for_scope).toBe('ppbf_policy');
      expect(document.document_id).toBe(
        `doc_ppbfpol_${(document.metadata!.copied_from_document_id as string).replace(/^doc_/, '')}`,
      );
    }
  });

  test('repoints every chunk at its copied document', () => {
    // A chunk pointing at the baseline's document id would be a cross-tenant
    // citation, which retrieval cannot resolve -- shadowLibrary.ts joins chunks
    // to documents on organization_id as well as document_id.
    const ids = new Set(policy.documents.map((row) => row.document_id));
    expect(policy.chunks.filter((row) => !ids.has(row.document_id!))).toEqual([]);
  });

  test('carries no capability map or requirements', () => {
    // Those describe platform-wide coverage, not one gym's policies.
    expect(policy.capabilityMap).toEqual([]);
    expect(policy.requirements).toEqual([]);
  });

  test('the two scopes partition the corpus with nothing lost or duplicated', () => {
    expect(baseline.chunks.length + policy.chunks.length).toBe(1193);
    const baselineChunks = new Set(baseline.chunks.map((row) => row.chunk_id));
    expect(policy.chunks.filter((row) => baselineChunks.has(row.chunk_id))).toEqual([]);
  });
});

describe('capability feeder tracks', () => {
  test('every capability now carries the tracks that feed it', () => {
    // The axis the owner asked for. Before this, the importer dropped the column
    // and the capability map arrived with no link to any chunk.
    expect(baseline.capabilityMap).toHaveLength(30);
    expect(baseline.capabilityMap.every((row) => Array.isArray(row.feeder_tracks))).toBe(true);
    expect(baseline.capabilityMap.every((row) => row.feeder_tracks!.length > 0)).toBe(true);
  });

  test('the tracks named are tracks the chunks actually carry', () => {
    // The join has to close: a feeder naming a track no chunk has would make a
    // capability permanently uncovered for a reason no query could explain.
    const chunkTracks = new Set(
      baseline.chunks.map((row) => (row.metadata as { track?: string }).track).filter(Boolean),
    );
    const declared = new Set(baseline.capabilityMap.flatMap((row) => row.feeder_tracks!));
    expect([...declared].filter((track) => !chunkTracks.has(track))).toEqual([]);
    expect(chunkTracks.size).toBe(14);
  });

  test('splits a multi-track feeder into separate tracks', () => {
    const multi = baseline.capabilityMap.filter((row) => row.feeder_tracks!.length > 1);
    expect(multi.length).toBeGreaterThan(0);
    expect(multi.some((row) => row.feeder_tracks!.length === 3)).toBe(true);
  });

  test('parses the corpus spelling of the column', () => {
    expect(feeder.single).toEqual(['A1']);
    expect(feeder.piped).toEqual(['A3', 'A6']);
    expect(feeder.spaced).toEqual(['A4', 'B1', 'B3']);
  });

  test('treats an absent feeder as an empty list rather than a parse failure', () => {
    expect(feeder.empty).toEqual([]);
    expect(feeder.nullish).toEqual([]);
    expect(feeder.trailing).toEqual(['A5']);
  });
});

// Provenance on the copied programme source, added when the re-scope tool needed
// to identify copies from the package rather than by matching an id prefix.
// pilot-rescope-library-baseline.mjs reads copied_from_source_id to know which
// row to copy from, so this is a contract between the two files, not decoration.
describe('copied programme source provenance', () => {
  test('records which source it copies and for which scope', () => {
    const copied = policy.sources.find((row) => row.source_id === COPIED_PROGRAMME_SOURCE_ID);
    expect(copied).toBeDefined();
    expect(copied!.metadata!.copied_from_source_id).toBe(PROGRAMME_SOURCE_ID);
    expect(copied!.metadata!.copied_for_scope).toBe('ppbf_policy');
  });

  test('exactly one source in the package is a copy', () => {
    const copies = policy.sources.filter((row) => row.metadata?.copied_from_source_id);
    expect(copies).toHaveLength(1);
  });

  test('the baseline carries no copies at all', () => {
    // The baseline holds originals only; a copy there would be a duplicate of a
    // row that is already in it.
    expect(baseline.sources.filter((row) => row.metadata?.copied_from_source_id)).toEqual([]);
    expect(baseline.documents.filter((row) => row.metadata?.copied_from_document_id)).toEqual([]);
  });
});

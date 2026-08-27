import fs from 'node:fs';
import path from 'node:path';

// Two evidence registries sit in this repository under different roots, and
// nothing ties them together.
//
//   seed-data/research-evidence/2026-08-07/   1193 claims -- the reviewer-facing
//                                             registry, named by
//                                             docs/RESEARCH_EVIDENCE_REGISTRY.md
//                                             as what a funder or academic runs
//                                             the citation screen against
//   seed-data/shadow-research/2026-08-08/     1243 claims -- a PROPOSED package
//                                             whose own README opens "NOT
//                                             PRODUCTION AUTHORITY"
//
// The relationship is lineage, not duplication: the 1193 are byte-identical in
// both, and the second adds 50. So an edit to either copy silently
// desynchronises a set that is currently exactly consistent, and no test would
// notice.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not choose a surviving copy, and
// nothing here should be read as licence to delete one. NEITHER PACKAGE
// SUBSUMES THE OTHER: 2026-08-08 uniquely holds the 42 Penn State and 8
// combatives claims and the licensed extracts; research-evidence/2026-08-07
// uniquely holds RESEARCH_METHODS.md and track_evidence_summary.csv, which
// exist nowhere else in the repository. "Which copy survives" is not an owner
// decision that has gone unanswered -- it is a question with no correct answer,
// because either deletion destroys the sole copy of something.
//
// AGENT_KERNEL.md also places storage authority and promotion rules with an
// ACTIVE source outside this repository, so promoting or retiring a research
// artifact is not this repository's call to make in the first place.
//
// This records the relationship so drift is visible. That is all it does.
//
// The sibling guard researchPackageDivergence.test.ts covers a different
// question -- which package the importer loads, and where same-named files
// INSIDE seed-data/shadow-research disagree. Its SEED_ROOT never reaches
// research-evidence/, so the cross-root relationship below is outside it.

const PILOT_DIR = __dirname;
const SEED_DATA = path.resolve(PILOT_DIR, '../../../seed-data');
const REVIEWER_ROOT = path.join(SEED_DATA, 'research-evidence/2026-08-07');
const PROPOSED_ROOT = path.join(SEED_DATA, 'shadow-research/2026-08-08');

/** Split one CSV line, honouring quoted fields that contain commas. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuote = false;
  for (const char of line) {
    if (char === '"') inQuote = !inQuote;
    else if (char === ',' && !inQuote) { out.push(field); field = ''; }
    else field += char;
  }
  out.push(field);
  return out;
}

/** Rows keyed by one column; the value is the WHOLE row, so any edit shows. */
function readKeyed(file: string, keyColumn: string): Map<string, string> {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const rows: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of text) {
    if (char === '"') { quoted = !quoted; current += char; continue; }
    if (char === '\n' && !quoted) { rows.push(current); current = ''; continue; }
    current += char;
  }
  if (current.trim()) rows.push(current);

  const keyAt = splitLine(rows[0]).indexOf(keyColumn);
  if (keyAt === -1) throw new Error(`${path.basename(file)}: no ${keyColumn} column`);

  const keyed = new Map<string, string>();
  for (const row of rows.slice(1)) {
    if (!row.trim()) continue;
    keyed.set(splitLine(row)[keyAt], row);
  }
  return keyed;
}

function compare(fileName: string, keyColumn: string) {
  const reviewer = readKeyed(path.join(REVIEWER_ROOT, fileName), keyColumn);
  const proposed = readKeyed(path.join(PROPOSED_ROOT, fileName), keyColumn);
  const shared = [...reviewer.keys()].filter((key) => proposed.has(key));
  return {
    reviewer,
    proposed,
    shared,
    onlyProposed: [...proposed.keys()].filter((key) => !reviewer.has(key)).sort(),
    onlyReviewer: [...reviewer.keys()].filter((key) => !proposed.has(key)).sort(),
    differing: shared.filter((key) => reviewer.get(key) !== proposed.get(key)).sort(),
  };
}

describe('the two evidence registries are lineage, not duplicates', () => {
  it('both roots exist and both files parse', () => {
    // A broken path would make every assertion below vacuously pass.
    expect(fs.existsSync(REVIEWER_ROOT)).toBe(true);
    expect(fs.existsSync(PROPOSED_ROOT)).toBe(true);
    const registry = compare('evidence_registry_boxing_learning.csv', 'claim_id');
    expect(registry.reviewer.size).toBeGreaterThan(1000);
    expect(registry.proposed.size).toBeGreaterThan(1000);
  });

  it('the proposed registry is a strict superset, with every shared claim untouched', () => {
    const registry = compare('evidence_registry_boxing_learning.csv', 'claim_id');

    // The property worth protecting. If a shared claim is ever edited in one
    // copy and not the other, a reviewer running the citation screen against
    // the 1193 gets a different answer from anyone reading the 1243, and
    // nothing else in the repository would say so.
    expect(registry.differing).toEqual([]);
    expect(registry.onlyReviewer).toEqual([]);

    expect(registry.reviewer.size).toBe(1193);
    expect(registry.proposed.size).toBe(1243);
    expect(registry.onlyProposed).toHaveLength(50);
  });

  it('names the provenance of the 50 added claims rather than just their count', () => {
    // A count alone would still pass if the added set were swapped wholesale.
    const registry = compare('evidence_registry_boxing_learning.csv', 'claim_id');
    const prefixes = registry.onlyProposed.reduce<Record<string, number>>((acc, id) => {
      const prefix = id.split('-')[0];
      acc[prefix] = (acc[prefix] ?? 0) + 1;
      return acc;
    }, {});

    // PS = the Penn State batch; CB = the combatives fragment.
    expect(prefixes).toEqual({ PS: 42, CB: 8 });
  });

  it('records the one revised conflict adjudication, and the two added', () => {
    const ledger = compare('cross_track_conflict_ledger.csv', 'conflict_id');

    // CT-23's adjudication was revised. A reviewer reading the 2026-08-07 copy
    // is reading the pre-revision text. Recorded, not resolved.
    expect(ledger.differing).toEqual(['CT-23']);
    expect(ledger.onlyProposed).toEqual(['CT-35', 'CT-36']);
    expect(ledger.onlyReviewer).toEqual([]);
    expect(ledger.reviewer.size).toBe(34);
    expect(ledger.proposed.size).toBe(36);
  });

  it('compares whole rows, so an edit to any field is a difference', () => {
    // Guards the comparison itself. Keying on the id and storing only the id
    // would report zero differences forever.
    const registry = compare('evidence_registry_boxing_learning.csv', 'claim_id');
    const sample = registry.reviewer.get(registry.shared[0])!;
    expect(sample).toContain(',');
    expect(sample.length).toBeGreaterThan(50);
  });

  it('neither registry is read by any runtime or seed path', () => {
    // The premise the rest of this file rests on. If a loader is ever pointed
    // at either copy, the authority question stops being theoretical and this
    // guard should fail so it gets answered first, rather than being settled
    // silently by whoever wired the loader.
    const roots = [
      path.resolve(PILOT_DIR, '../../../scripts'),
      path.resolve(PILOT_DIR, '../..'),
    ];
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|mjs|js)$/.test(entry.name)) continue;
        if (/\.test\.tsx?$/.test(entry.name)) continue;
        const source = fs.readFileSync(full, 'utf8');
        // A path used to READ a file, not merely named in prose.
        if (/research-evidence\/2026-08-07/.test(source)
          && /readFile|readFileSync|createReadStream/.test(source)) {
          offenders.push(path.relative(SEED_DATA, full));
        }
      }
    };
    for (const root of roots) walk(root);

    expect(offenders).toEqual([]);
  });
});

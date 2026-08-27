import fs from 'node:fs';
import path from 'node:path';

// seed-data/shadow-research/ holds more than one dated research package, and
// import-shadow-research.mjs loads exactly ONE of them. Where two packages ship
// a file under the SAME NAME, the loader silently takes the one in its own
// directory and the other is inert -- present in the repository, read by
// nobody, and indistinguishable at a glance from data the platform is using.
//
// That is not hypothetical. 2026-08-08 recomputed
// seed_shadow_library_capability_map.csv after fixing a parsing bug in the
// coverage recompute (the feeder-track column uses `|` for multi-track entries
// and the recompute split on `,` only, so five capabilities computed from an
// empty claim set). Its README states the corrected values "are more accurate
// than the prior values". The loader points at 2026-08-07. So the map the
// platform loads is the one its own authors describe as wrong, and eight
// capabilities carry a different coverage_state on each side -- including
// safeguarding_boundaries and weight_management_safety, which the LOADED
// corpus reports as fully covered and the correction reports as partial.
//
// Nothing tied the two files together. The contradiction was recorded in prose,
// in a README, in the directory nothing loads. This ties them at the source
// level, the way drillSeedPrerequisite.test.ts ties the drill CSVs to the
// migration they require: it costs no database and runs in the fast suite.
//
// This test does NOT decide which package is authoritative. That is an owner
// decision, and the 2026-08-08 package is explicitly marked PROPOSED -- it
// supplies one of the importer's five required files, so it cannot be loaded as
// it stands. What this test decides is that no divergence gets to be silent.

const PILOT_DIR = __dirname;
const SEED_ROOT = path.resolve(PILOT_DIR, '../../../seed-data/shadow-research');
const IMPORTER = path.resolve(PILOT_DIR, '../../../scripts/import-shadow-research.mjs');

/**
 * The package the importer actually loads, read out of the importer rather than
 * written down here. A constant repeated in a test is a constant that can drift
 * from the code it describes without either side failing.
 */
function loadedPackageName(importerSource: string): string | null {
  const match = importerSource.match(/DEFAULT_SEED_DIR\s*=\s*path\.resolve\(([\s\S]*?)\)/);
  if (!match) return null;
  const dir = match[1].match(/['"]\.\.\/seed-data\/shadow-research\/([^'"]+)['"]/);
  return dir ? dir[1] : null;
}

/** Every dated package on disk, discovered rather than listed. */
function packagesOnDisk(): string[] {
  return fs
    .readdirSync(SEED_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function filesIn(pkg: string): string[] {
  return fs.readdirSync(path.join(SEED_ROOT, pkg)).sort();
}

function readPackageFile(pkg: string, file: string): string {
  return fs.readFileSync(path.join(SEED_ROOT, pkg, file), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Files that exist under the same name in the loaded package and in some other
 * package, with the content differing. Every entry needs a recorded reason
 * below, or this suite fails.
 */
function sharedNameDivergences(loaded: string): { file: string; other: string }[] {
  const loadedFiles = new Set(filesIn(loaded));
  const found: { file: string; other: string }[] = [];
  for (const other of packagesOnDisk()) {
    if (other === loaded) continue;
    for (const file of filesIn(other)) {
      if (!loadedFiles.has(file)) continue;
      if (readPackageFile(loaded, file) !== readPackageFile(other, file)) {
        found.push({ file, other });
      }
    }
  }
  return found.sort((a, b) => `${a.other}/${a.file}`.localeCompare(`${b.other}/${b.file}`));
}

/**
 * Known, reasoned divergences. Keyed `<other-package>/<filename>`.
 *
 * Adding an entry here is a claim that somebody looked at both files and
 * decided the platform should keep loading the one it loads. Deleting a file or
 * making the two agree must remove the entry -- the staleness check below
 * enforces that, because an exemption nobody can trip is an exemption nobody
 * will revisit.
 */
const RECORDED_DIVERGENCES: Record<string, string> = {
  '2026-08-08/seed_shadow_library_capability_map.csv':
    'Recomputed after the feeder-track parsing fix described in that package README section 5. '
    + 'Its authors call the corrected values more accurate than the loaded ones. It is NOT loaded '
    + 'because the 2026-08-08 package supplies only this one of the importer five required seed '
    + 'files and EXPECTED_COUNTS pins the loadable corpus to 2026-08-07. Adopting the correction '
    + 'is an owner decision, not a refactor: see the coverage_state test below for what the two '
    + 'sides currently disagree about.',
};

/** capability_key -> coverage_state, for a package copy of the capability map. */
function coverageStates(pkg: string): Map<string, string> {
  const lines = readPackageFile(pkg, 'seed_shadow_library_capability_map.csv')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  const header = lines[0].split(',');
  const keyAt = header.indexOf('capability_key');
  const stateAt = header.indexOf('coverage_state');
  if (keyAt === -1 || stateAt === -1) {
    throw new Error('capability map: expected capability_key and coverage_state columns');
  }
  // Every field before coverage_state is unquoted and comma-free in this
  // corpus (ids, keys, integers) except required_source_types, which is a
  // braced set that may be quoted. Split only as far as needed, honouring one
  // level of quoting, rather than pulling in a CSV parser for two columns.
  const states = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const fields: string[] = [];
    let current = '';
    let quoted = false;
    for (const char of line) {
      if (char === '"') quoted = !quoted;
      else if (char === ',' && !quoted) { fields.push(current); current = ''; }
      else current += char;
    }
    fields.push(current);
    states.set(fields[keyAt], fields[stateAt]);
  }
  return states;
}

describe('shadow-research package divergence', () => {
  const importerSource = fs.readFileSync(IMPORTER, 'utf8');
  const loaded = loadedPackageName(importerSource);

  it('reads the importer and finds the package it loads', () => {
    // A broken regex here would make every assertion below vacuously pass:
    // sharedNameDivergences would compare a package against itself and find
    // nothing, and the suite would report green while checking nothing.
    expect(loaded).not.toBeNull();
    expect(packagesOnDisk()).toContain(loaded);
    expect(fs.existsSync(path.join(SEED_ROOT, loaded!, 'seed_shadow_library_capability_map.csv'))).toBe(true);
  });

  it('derives the loaded package from the text it is given', () => {
    // Guards the derivation against quietly becoming a hardcoded constant that
    // agrees with the importer by coincidence rather than by reading it.
    expect(loadedPackageName('')).toBeNull();
    expect(
      loadedPackageName("DEFAULT_SEED_DIR = path.resolve(x, '../seed-data/shadow-research/1999-01-01')"),
    ).toBe('1999-01-01');
  });

  it('ships more than one research package, so the comparison has something to compare', () => {
    // If the repository is ever reduced to a single package this whole file
    // should be deleted rather than left asserting a rule about nothing.
    expect(packagesOnDisk().length).toBeGreaterThan(1);
  });

  it('every same-named file that differs from the loaded package is recorded', () => {
    const unrecorded = sharedNameDivergences(loaded!)
      .map(({ file, other }) => `${other}/${file}`)
      .filter((key) => !(key in RECORDED_DIVERGENCES));

    // Fix by reading both files and adding an entry to RECORDED_DIVERGENCES
    // saying why the platform keeps loading the one it loads -- or by making
    // the loader point at the newer file, which is an owner decision.
    expect(unrecorded).toEqual([]);
  });

  it('does not carry a record for a divergence that no longer exists', () => {
    const live = new Set(sharedNameDivergences(loaded!).map(({ file, other }) => `${other}/${file}`));
    const stale = Object.keys(RECORDED_DIVERGENCES).filter((key) => !live.has(key));
    expect(stale).toEqual([]);
  });

  it('states exactly which capabilities the loaded corpus reports differently', () => {
    const loadedStates = coverageStates(loaded!);
    const corrected = coverageStates('2026-08-08');

    expect(loadedStates.size).toBeGreaterThan(0);
    expect([...corrected.keys()].sort()).toEqual([...loadedStates.keys()].sort());

    const differing: Record<string, string> = {};
    for (const [capability, state] of loadedStates) {
      const other = corrected.get(capability);
      if (other !== state) differing[capability] = `${state} -> ${other}`;
    }

    // Read this list as: what the platform currently reports, and what the
    // corrected recompute says instead. The first two are the ones that matter
    // most -- this platform holds records about minors, and the loaded corpus
    // reports its safeguarding and weight-management evidence as meeting every
    // threshold where the correction says it only partly does.
    expect(differing).toEqual({
      safeguarding_boundaries: 'covered -> partial',
      weight_management_safety: 'covered -> partial',
      operating_models: 'covered -> partial',
      operational_data_model: 'uncovered -> partial',
      capacity_planning: 'partial -> covered',
      emergency_medical_response: 'partial -> covered',
      injury_head_impact_risk: 'partial -> covered',
      staffing_supervision_ratios: 'partial -> covered',
    });
  });

  it('parses coverage_state by column name, not by position', () => {
    // The two files have identical headers today. Reading by index would keep
    // passing if one of them gained a column, silently comparing coverage_state
    // against something else entirely.
    const states = coverageStates(loaded!);
    expect([...new Set(states.values())].sort()).toEqual(['covered', 'partial', 'uncovered']);
  });
});

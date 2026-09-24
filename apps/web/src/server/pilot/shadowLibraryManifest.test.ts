// Contract tests for the SHADOW Library seed manifest reader.
//
// WHAT THIS IS FOR
//
// seed-shadow-library.mjs registers each manifest entry through live API
// calls -- source, then document, then N chunks -- and reads the entry's file
// INSIDE that loop. loadManifest validated that every entry carried a
// non-empty "file" STRING, and never that the string named a file that exists.
//
// So a manifest whose second entry names a missing document seeded the first
// entry completely and then threw ENOENT: a half-registered Library, with no
// step that could finish it, because a re-run skips by doctrine_kind and the
// missing file is still missing.
//
// verifySession, one function above, already states the principle this applies:
// "Fails fast against a cheap read rather than surfacing the first auth problem
// partway through, once some rows are already written." The script believed it
// about sessions and not about its own files.
//
// HOW IT RUNS. The module is real ESM and the default jest runner has no ESM
// loader (`npm test` does not pass --experimental-vm-modules; only the
// .pg.test.ts scripts do). So each case is evaluated in one real node child
// process, the same loader the seed itself runs under. loadManifest is the one
// part of that script touching no network, which is what makes this testable
// at all.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WEB_ROOT = path.resolve(__dirname, '../../..');
// A file:// URL, not a bare path: on Windows an absolute path is not a legal
// ESM specifier.
const MODULE_URL = pathToFileURL(path.join(WEB_ROOT, 'scripts/seed-shadow-library.mjs')).href;

// A real document, so a "file present" case proves resolution rather than
// asserting that nothing was checked. Entry paths are repository-root
// relative, which is why the child runs with cwd = apps/web: the script
// resolves them as cwd/../.. and is invoked from there by its npm script.
const REAL_FILE = 'docs/SHADOW_AUTHORITY_MODEL.md';
const MISSING_FILE = 'docs/THIS_DOCUMENT_DOES_NOT_EXIST.md';
const ALSO_MISSING = 'docs/NOR_DOES_THIS_ONE.md';

function entry(file: string, kind = 'authority_model') {
  return { title: `Title for ${kind}`, source_type: 'internal_policy', doctrine_kind: kind, file };
}

const CASES: Record<string, unknown> = {
  all_files_present: { sources: [entry(REAL_FILE)] },
  // fs.access() answers "does this path exist", which a DIRECTORY also
  // satisfies -- and readFile on a directory throws EISDIR. Checking existence
  // rather than readability rebuilds the partial seed this preflight exists to
  // stop, one entry later.
  entry_names_a_directory: { sources: [entry(REAL_FILE), entry('docs', 'specification')] },
  one_file_missing: { sources: [entry(REAL_FILE), entry(MISSING_FILE, 'specification')] },
  every_missing_file_reported: {
    sources: [entry(MISSING_FILE, 'specification'), entry(ALSO_MISSING, 'event_model')],
  },
  entry_missing_a_field: { sources: [{ title: 'No file key', source_type: 'internal_policy', doctrine_kind: 'x' }] },
  no_sources_at_all: { sources: [] },
};

type Outcome =
  | { ok: true; count: number; contentLengths: number[]; files?: string[] }
  | { ok: false; message: string };

// The checked-in manifest, read in-process. The synthetic cases above prove the
// READER refuses a bad manifest; they cannot prove the manifest this repository
// actually ships is good, and that is the failure that happened: the
// `shadow-specification` entry still pointed at docs/SHADOW_SPECIFICATION.md
// after that document moved to docs/archive/. Because the preflight reads every
// entry and aborts on any unreadable one -- "Nothing was registered." -- one
// dead path took the ENTIRE doctrine seed down for anyone who ran it.
const REAL_MANIFEST_PATH = path.join(WEB_ROOT, 'scripts/shadow-library-seed-manifest.json');
const REAL_MANIFEST = JSON.parse(fs.readFileSync(REAL_MANIFEST_PATH, 'utf8')) as {
  sources: { doctrine_kind: string; file: string }[];
};

let outcomes: Record<string, Outcome>;
let workdir: string;

beforeAll(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-shadow-manifest-'));
  const manifestPaths: Record<string, string> = {};
  for (const [name, manifest] of Object.entries(CASES)) {
    const file = path.join(workdir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify(manifest));
    manifestPaths[name] = file;
  }

  // Deleting the override rather than setting it: this case must exercise the
  // DEFAULT path resolution, which is what the npm script uses and therefore
  // what actually runs in an operator's hands.
  const realCase =
    `try { delete process.env.PILOT_LIBRARY_MANIFEST;`
    + ` const r = await m.loadManifest();`
    + ` out["real_manifest"] = {ok: true, count: r.length,`
    + ` contentLengths: r.map((e) => (typeof e.contents === 'string' ? e.contents.length : -1)),`
    + ` files: r.map((e) => e.file)}; }`
    + ` catch (e) { out["real_manifest"] = {ok: false, message: e.message}; }`;

  const body = Object.keys(CASES)
    .map((name) =>
      `try { process.env.PILOT_LIBRARY_MANIFEST = P[${JSON.stringify(name)}];`
      + ` const r = await m.loadManifest();`
      + ` out[${JSON.stringify(name)}] = {ok: true, count: r.length,`
      + ` contentLengths: r.map((e) => (typeof e.contents === 'string' ? e.contents.length : -1))}; }`
      + ` catch (e) { out[${JSON.stringify(name)}] = {ok: false, message: e.message}; }`)
    .join('\n')
    .concat('\n', realCase);

  const script = `
    import * as m from ${JSON.stringify(MODULE_URL)};
    const P = ${JSON.stringify(manifestPaths)};
    const out = {};
    ${body}
    process.stdout.write(JSON.stringify(out));
  `;

  try {
    outcomes = JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        cwd: WEB_ROOT,
      }),
    );
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}, 60_000);

function refusal(name: string): string {
  const outcome = outcomes[name];
  if (outcome.ok) {
    throw new Error(`${name} was ACCEPTED; it must be refused`);
  }
  return outcome.message;
}

describe('SHADOW library seed manifest', () => {
  // Importing the module must not run the seed. If it did, this suite would be
  // reporting on a process that had already tried to reach a live API.
  it('can be imported without the seed running', () => {
    expect(Object.keys(outcomes).sort()).toEqual([...Object.keys(CASES), 'real_manifest'].sort());
  });

  it('accepts a manifest whose files all exist', () => {
    const outcome = outcomes.all_files_present;
    if (!outcome.ok) {
      throw new Error(`a manifest naming a real file was refused: ${outcome.message}`);
    }
    expect(outcome.count).toBe(1);
  });

  // Existence is not readability. A directory exists; reading it throws
  // EISDIR -- and that throw would land inside the registration loop, after
  // earlier entries were already written, which is the failure this preflight
  // is for. Raised by the Codex review bot against the first version of this
  // check, which used fs.access().
  it('refuses an entry naming a directory rather than a document', () => {
    expect(refusal('entry_names_a_directory')).toContain('docs');
  });

  // The stronger property, and the one that actually closes the hole: the
  // contents are READ during validation and retained, so the seeding loop
  // never performs a second read that could fail after writes have started.
  it('reads and retains every file, so the seed loop re-reads nothing', () => {
    const outcome = outcomes.all_files_present;
    if (!outcome.ok) {
      throw new Error(`a manifest naming a real file was refused: ${outcome.message}`);
    }
    expect(outcome.contentLengths).toHaveLength(1);
    expect(outcome.contentLengths[0]).toBeGreaterThan(0);
  });

  // The case this exists for: without it, entry one registers through live API
  // calls and entry two throws ENOENT, leaving a Library nothing can finish.
  it('refuses the whole manifest when any named file is missing', () => {
    expect(refusal('one_file_missing')).toContain(MISSING_FILE);
  });

  // Named together, so an operator fixes them in one pass rather than
  // discovering the next one on the next run.
  it('names every missing file, not just the first', () => {
    const message = refusal('every_missing_file_reported');
    expect(message).toContain(MISSING_FILE);
    expect(message).toContain(ALSO_MISSING);
  });

  // Pre-existing guards, kept honest.
  it('still refuses an entry missing a required field', () => {
    expect(refusal('entry_missing_a_field')).toContain('file');
  });

  it('still refuses a manifest with no sources', () => {
    expect(refusal('no_sources_at_all')).toContain('no sources');
  });
});

// ---------------------------------------------------------------------------
// The manifest this repository actually ships.
//
// Everything above tests the reader against manifests the test itself wrote.
// These test the artifact, because a reader that correctly refuses a broken
// manifest is no comfort when the broken manifest is the one in the repository.
// ---------------------------------------------------------------------------

describe('the checked-in SHADOW doctrine manifest', () => {
  it('passes its own preflight, so the doctrine seed can register anything at all', () => {
    const outcome = outcomes.real_manifest;
    if (!outcome.ok) {
      throw new Error(
        'the checked-in manifest is refused by its own preflight, so seed:shadow:library '
        + `registers NOTHING: ${outcome.message}`,
      );
    }
    expect(outcome.count).toBe(REAL_MANIFEST.sources.length);
  });

  it('names only files that are readable and non-empty', () => {
    const outcome = outcomes.real_manifest;
    if (!outcome.ok) {
      throw new Error(`the checked-in manifest was refused: ${outcome.message}`);
    }
    // -1 is the sentinel for "entry carried no string contents" -- a preflight
    // that returned an entry it never actually read.
    expect(outcome.contentLengths.filter((n) => n <= 0)).toEqual([]);
  });

  // The regression itself. docs/archive/SHADOW_SPECIFICATION.md opens with
  // "ARCHIVED -- HISTORICAL VISION DOCUMENT. DO NOT BUILD FROM THIS." and states
  // that most of its BUILT claims are false against the running platform.
  // Repointing the dead entry there would have turned a broken seed into a
  // working seed that publishes known-false doctrine at authority_tier 1, which
  // SHADOW could then retrieve and cite. The entry was removed instead, and this
  // keeps any archived document out of the doctrine set.
  it('registers no document from docs/archive/', () => {
    const archived = REAL_MANIFEST.sources
      .filter((entry) => entry.file.split('\\').join('/').includes('docs/archive/'))
      .map((entry) => `${entry.doctrine_kind}: ${entry.file}`);

    expect({ archivedDoctrineEntries: archived }).toEqual({ archivedDoctrineEntries: [] });
  });

  // Guards the shape the two tests above depend on: an emptied manifest would
  // let `contentLengths.filter(...)` pass over an empty array while guarding
  // nothing at all.
  it('still carries doctrine to register', () => {
    expect(REAL_MANIFEST.sources.length).toBeGreaterThan(0);
  });
});

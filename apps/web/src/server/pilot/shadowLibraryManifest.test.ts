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
  one_file_missing: { sources: [entry(REAL_FILE), entry(MISSING_FILE, 'specification')] },
  every_missing_file_reported: {
    sources: [entry(MISSING_FILE, 'specification'), entry(ALSO_MISSING, 'event_model')],
  },
  entry_missing_a_field: { sources: [{ title: 'No file key', source_type: 'internal_policy', doctrine_kind: 'x' }] },
  no_sources_at_all: { sources: [] },
};

type Outcome = { ok: true; count: number } | { ok: false; message: string };

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

  const body = Object.keys(CASES)
    .map((name) =>
      `try { process.env.PILOT_LIBRARY_MANIFEST = P[${JSON.stringify(name)}];`
      + ` const r = await m.loadManifest();`
      + ` out[${JSON.stringify(name)}] = {ok: true, count: r.length}; }`
      + ` catch (e) { out[${JSON.stringify(name)}] = {ok: false, message: e.message}; }`)
    .join('\n');

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
    expect(Object.keys(outcomes).sort()).toEqual(Object.keys(CASES).sort());
  });

  it('accepts a manifest whose files all exist', () => {
    const outcome = outcomes.all_files_present;
    if (!outcome.ok) {
      throw new Error(`a manifest naming a real file was refused: ${outcome.message}`);
    }
    expect(outcome.count).toBe(1);
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

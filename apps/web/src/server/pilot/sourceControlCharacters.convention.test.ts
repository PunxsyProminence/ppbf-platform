/**
 * NO INVISIBLE CONTROL CHARACTERS IN THE SOURCE.
 *
 * What this guards against happened four times before anyone saw it (#1411,
 * #1420). A literal backspace byte (0x08) sat inside a regex where a word
 * boundary was meant. The two look identical in an editor, in a diff and in a
 * review. A regex holding the byte matches only a backspace, so:
 *
 *   - three `not.toMatch` assertions could never fail, one of them the guard on
 *     which board the public wall display serves;
 *   - the route walker's role scanner matched nothing, and 482 inventory rows
 *     recorded an empty role list while their drift test compared empty with
 *     empty and passed.
 *
 * A fifth file joined and split a list on a literal NUL byte. That one worked,
 * and it also made git and grep treat the file as binary, so its diffs and
 * searches showed nothing.
 *
 * HOW THE BYTE GETS IN. A tool that collapses a doubled backslash on the way to
 * disk turns the two characters "backslash, b" into the single control
 * character they spell. Nothing fails at the time.
 *
 * TWO GUARDS, BECAUSE THEY SEE DIFFERENT THINGS.
 *
 *   1. The byte scan below reads every tracked file under apps/web and packages
 *      as BYTES and refuses any C0 control character other than tab, line feed
 *      and carriage return (and DEL). It has no regex of its own to go blind.
 *   2. ESLint's no-control-regex, switched on in apps/web/eslint.config.mjs,
 *      also refuses a control character written as an escape inside a regex.
 *      Nine files do that on purpose, to strip or refuse such characters, and
 *      the rule is off for exactly those nine. This file asks ESLint itself
 *      which files the rule is not enforced for, so the list cannot grow, and
 *      the rule cannot be dropped, without a test going red.
 */

import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const APP_ROOT = path.resolve(__dirname, '../../..');
const REPO_ROOT = path.resolve(APP_ROOT, '../..');
const APP_PREFIX = 'apps/web/';

/** Everything tracked under these is read. */
const SCANNED_ROOTS = ['apps/web', 'packages'];

/**
 * The only files not read: formats that are bytes, not text. Every other
 * tracked file is scanned whatever its extension, so a new kind of text file is
 * covered without anyone remembering to list it. A new BINARY format fails the
 * scan until its extension is added here, which is a decision somebody makes on
 * purpose rather than a gap nobody notices.
 */
const BINARY_EXTENSIONS = new Set(['.ico', '.jpg', '.png', '.woff2']);

const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const DELETE = 0x7f;

const RULE = 'no-control-regex';
const ESLINT_CONFIG = `${APP_PREFIX}eslint.config.mjs`;
const THIS_FILE = `${APP_PREFIX}src/server/pilot/sourceControlCharacters.convention.test.ts`;

/**
 * Must equal CONTROL_CHARACTER_HANDLERS in eslint.config.mjs. Each of these
 * strips or refuses control characters with visible escapes. Adding a tenth
 * means changing this list too, in a diff a reviewer reads.
 */
const RULE_OFF_ON_PURPOSE = [
  'app/api/pilot/quotes/route.ts',
  'app/shadow/page.tsx',
  'src/server/pilot/athleteMentalSkills.ts',
  'src/server/pilot/libraryPdfText.ts',
  'src/server/pilot/profileIdentity.ts',
  'src/server/pilot/profilePhotoPolicy.ts',
  'src/server/pilot/shadowUploadPolicy.ts',
  'src/server/pilot/videoUploadPolicy.ts',
  'src/testing/legacyLoaderGoldenData/generate.mjs',
];

/**
 * App files ESLint does not lint at all, so the rule cannot reach them. Listed
 * so that taking a file out of lint is as visible as switching the rule off for
 * it. The byte scan still reads every one of them.
 */
const NOT_LINTED = ['next-env.d.ts'];

const LINTED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * Every control character in the bytes that is not a tab, a line feed or a
 * carriage return. Reads bytes, never decoded text, and uses no regex.
 */
function controlBytes(bytes: Buffer): string[] {
  const found: string[] = [];
  let line = 1;
  let column = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte === LINE_FEED) {
      line += 1;
      column = 0;
      continue;
    }
    column += 1;
    if (byte === TAB || byte === CARRIAGE_RETURN) continue;
    if (byte < 0x20 || byte === DELETE) {
      found.push(`line ${line}, byte ${column}: 0x${byte.toString(16).toUpperCase().padStart(2, '0')}`);
    }
  }
  return found;
}

/** Tracked files under the scanned roots, as git names them (forward slashes). */
function trackedFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--', ...SCANNED_ROOTS], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return listed
    .toString('utf8')
    .split(String.fromCharCode(0))
    .filter((name) => name.length > 0);
}

/** The tracked files the scan reads: not a binary format, and present on disk. */
function scannedFiles(): string[] {
  return trackedFiles().filter(
    (name) => !BINARY_EXTENSIONS.has(path.extname(name).toLowerCase()) && fs.existsSync(path.join(REPO_ROOT, name)),
  );
}

/** One line per file that holds a control character, naming its first three. */
function offendersIn(root: string, names: string[]): string[] {
  const offenders: string[] = [];
  for (const name of names) {
    const found = controlBytes(fs.readFileSync(path.join(root, name)));
    if (found.length > 0) {
      const more = found.length > 3 ? ` (and ${found.length - 3} more)` : '';
      offenders.push(`${name}: ${found.slice(0, 3).join('; ')}${more}`);
    }
  }
  return offenders;
}

function rawBytes(...parts: Array<string | number>): Buffer {
  return Buffer.concat(parts.map((part) => (typeof part === 'number' ? Buffer.from([part]) : Buffer.from(part, 'utf8'))));
}

describe('tracked source holds no invisible control characters', () => {
  const files = scannedFiles();

  it('reads the files it is meant to read', () => {
    // A scan that lists nothing passes everything. These are the floor: the
    // two roots, the files this guard was written about, and this file.
    expect(files.length).toBeGreaterThan(2000);
    expect(files.filter((name) => name.startsWith('packages/')).length).toBeGreaterThan(10);
    expect(files).toEqual(
      expect.arrayContaining([
        THIS_FILE,
        ESLINT_CONFIG,
        `${APP_PREFIX}components/achievementCeremony.ts`,
        `${APP_PREFIX}components/coachFloorFocus.test.tsx`,
        `${APP_PREFIX}src/server/pilot/shadowRateLimit.test.ts`,
        `${APP_PREFIX}src/server/pilot/wallDisplayPrivacy.test.ts`,
        `${APP_PREFIX}src/server/pilot/routeGateWalk.ts`,
      ]),
    );
  });

  it('no file holds a C0 control character other than tab, line feed and carriage return', () => {
    const offenders = offendersIn(REPO_ROOT, files);
    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} tracked file(s) hold an invisible control character:\n  `
          + `${offenders.slice(0, 40).join('\n  ')}\n\n`
          + 'In a regex a control byte matches only itself, so a pattern that reads as a word boundary '
          + 'matches nothing and the check built on it can never fail. A backspace (0x08) where '
          + '"backslash, b" was meant is the usual cause: some tool collapsed a doubled backslash on the '
          + 'way to disk. Rewrite the spot as the visible escape and look at the bytes afterwards. If the '
          + 'file is a binary format, add its extension to BINARY_EXTENSIONS in this test.',
      );
    }
  });
});

describe('the byte scanner', () => {
  it('accepts ordinary text: tabs, both line endings, and characters beyond ASCII', () => {
    expect(controlBytes(rawBytes('const a = 1;', LINE_FEED, TAB, 'return a;', CARRIAGE_RETURN, LINE_FEED))).toEqual([]);
    // An em dash, an accented letter and a zero-width space: none is a C0 byte.
    expect(controlBytes(rawBytes(String.fromCharCode(0x2014, 0xe9, 0x200b), LINE_FEED))).toEqual([]);
    expect(controlBytes(Buffer.alloc(0))).toEqual([]);
  });

  it('reports the line and byte of the defect this guard was written for', () => {
    const poisoned = rawBytes(
      'const a = 1;',
      LINE_FEED,
      '    expect(sql).not.toMatch(/',
      0x08,
      'insert',
      0x08,
      '/i);',
      LINE_FEED,
    );
    expect(controlBytes(poisoned)).toEqual(['line 2, byte 30: 0x08', 'line 2, byte 37: 0x08']);
  });

  it('reports a NUL used as a separator', () => {
    expect(controlBytes(rawBytes("earned.join('", 0x00, "');"))).toEqual(['line 1, byte 14: 0x00']);
  });

  it('refuses every C0 control character and DEL, and only tab, line feed and carriage return pass', () => {
    const refused: number[] = [];
    for (let byte = 0; byte <= 0xff; byte += 1) {
      if (controlBytes(Buffer.from([0x61, byte, 0x62])).length > 0) refused.push(byte);
    }
    const expected: number[] = [];
    for (let byte = 0; byte < 0x20; byte += 1) {
      if (byte !== TAB && byte !== LINE_FEED && byte !== CARRIAGE_RETURN) expected.push(byte);
    }
    expected.push(DELETE);
    expect(refused).toEqual(expected);
    expect(expected).toHaveLength(30);
  });

  it('counts lines by line feed, so a carriage return pair does not shift the report', () => {
    const crlf = rawBytes('a', CARRIAGE_RETURN, LINE_FEED, 'b', CARRIAGE_RETURN, LINE_FEED, 'c', 0x1b);
    expect(controlBytes(crlf)).toEqual(['line 3, byte 2: 0x1B']);
  });

  it('reads files from disk and names only the ones that hold a control character', () => {
    // The repository scan above passes on a clean tree whether or not it reads
    // anything. This runs the same function over files known to be poisoned.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-control-scan-'));
    try {
      fs.writeFileSync(path.join(dir, 'clean.ts'), rawBytes('const a = 1;', LINE_FEED));
      fs.writeFileSync(path.join(dir, 'one.ts'), rawBytes('const b = /', 0x08, 'x/;', LINE_FEED));
      fs.writeFileSync(path.join(dir, 'five.mjs'), rawBytes(0x00, 0x01, 0x02, LINE_FEED, 0x03, 0x04));

      expect(offendersIn(dir, ['clean.ts', 'one.ts', 'five.mjs'])).toEqual([
        'one.ts: line 1, byte 12: 0x08',
        'five.mjs: line 1, byte 1: 0x00; line 1, byte 2: 0x01; line 1, byte 3: 0x02 (and 2 more)',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Asks ESLint, in a child process, what it would do with each file: lint it
 * with the rule as an error, lint it without, or not lint it at all. The
 * config is an ES module, which this jest setup cannot import, and asking
 * ESLint is the point anyway: it answers for the config as it resolves, not as
 * its text reads.
 */
const ASK_ESLINT = `
const { ESLint } = require(process.argv[1]);
const rule = process.argv[2];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const names = JSON.parse(input);
    const eslint = new ESLint({ cwd: process.cwd() });
    const answer = { enforced: 0, notEnforced: [], notLinted: [] };
    for (const name of names) {
      const config = (await eslint.isPathIgnored(name)) ? undefined : await eslint.calculateConfigForFile(name);
      if (!config) { answer.notLinted.push(name); continue; }
      const setting = config.rules ? config.rules[rule] : undefined;
      const severity = Array.isArray(setting) ? setting[0] : setting;
      if (severity === 2 || severity === 'error') { answer.enforced += 1; } else { answer.notEnforced.push(name); }
    }
    process.stdout.write(JSON.stringify(answer));
  } catch (error) {
    process.stderr.write(String(error && error.stack ? error.stack : error));
    process.exit(1);
  }
});
`;

interface EslintAnswer {
  enforced: number;
  notEnforced: string[];
  notLinted: string[];
}

function askEslint(names: string[]): EslintAnswer {
  const result = spawnSync(process.execPath, ['-e', ASK_ESLINT, require.resolve('eslint'), RULE], {
    cwd: APP_ROOT,
    input: JSON.stringify(names),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 150_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`ESLint could not be asked about ${RULE}: ${result.error?.message ?? result.stderr}`);
  }
  return JSON.parse(result.stdout) as EslintAnswer;
}

describe(`ESLint ${RULE} is on for the app`, () => {
  const appCode = trackedFiles()
    .filter((name) => name.startsWith(APP_PREFIX) && LINTED_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .filter((name) => fs.existsSync(path.join(REPO_ROOT, name)))
    .map((name) => name.slice(APP_PREFIX.length));

  it('is an error for every linted file except the nine that handle control characters on purpose', () => {
    const answer = askEslint(appCode);

    expect([...answer.notEnforced].sort()).toEqual([...RULE_OFF_ON_PURPOSE].sort());
    expect([...answer.notLinted].sort()).toEqual([...NOT_LINTED].sort());
    // Everything else, counted, so "no file is exempt" cannot mean "no file was asked about".
    expect(answer.enforced).toBe(appCode.length - RULE_OFF_ON_PURPOSE.length - NOT_LINTED.length);
    expect(answer.enforced).toBeGreaterThan(2000);
  }, 180_000);

  it('is not switched off from inside a file: only the config and this test name the rule', () => {
    // An "eslint-disable" comment naming the rule would exempt a file without
    // touching the list above. Nothing else has a reason to mention it.
    const mentions = scannedFiles().filter((name) =>
      fs.readFileSync(path.join(REPO_ROOT, name)).includes(RULE),
    );
    expect(mentions.sort()).toEqual([ESLINT_CONFIG, THIS_FILE].sort());
  });

  it('the nine exempt files still exist, so the list does not outlive what it describes', () => {
    for (const name of RULE_OFF_ON_PURPOSE) {
      expect({ name, exists: fs.existsSync(path.join(APP_ROOT, name)) }).toEqual({ name, exists: true });
    }
  });
});

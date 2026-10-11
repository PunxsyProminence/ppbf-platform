/**
 * NO C0 CONTROL CHARACTERS IN THE SOURCE, AND NO REGEX THAT HIDES ONE.
 *
 * What this guards against happened four times before anyone saw it (#1411,
 * #1420). A literal backspace byte (0x08) sat inside a regex where a word
 * boundary was meant. The two look identical in an editor, in a diff and in a
 * review. A regex holding the byte matches only a backspace, so:
 *
 *   - three `not.toMatch` assertions could never fail, one of them the guard on
 *     which board the public wall display serves;
 *   - the route walker's role scanner matched nothing, and every inventory row
 *     recorded an empty role list while the drift test compared empty with
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
 * THREE GUARDS, BECAUSE THEY SEE DIFFERENT THINGS.
 *
 *   1. The byte scan below reads every tracked file under apps/web and packages
 *      as BYTES and refuses any C0 control character other than tab, line feed
 *      and carriage return. It also refuses DEL (0x7F), which is not C0 but is
 *      just as invisible. It has no regex of its own to go blind.
 *   2. ESLint's no-control-regex, switched on in apps/web/eslint.config.mjs,
 *      also refuses a control character written as an escape inside a regex.
 *      Nine files do that on purpose and the rule is off for exactly those nine.
 *   3. A no-restricted-syntax entry in the same config refuses a backspace in a
 *      string or a template (String.raw aside): the same accident when the
 *      regex is built from text, where the damaged source is two visible
 *      characters and neither of the first two guards can see it.
 *
 * This file asks ESLint itself what it enforces, file by file, hands it
 * known-bad samples, and refuses any comment that would switch either rule off
 * from inside a file. Dropping a rule, replacing its selectors, or exempting
 * one more file turns a test red.
 *
 * WHAT IS NOT COVERED. Only apps/web and packages are read. Characters beyond
 * C0 that are also hard to see (zero-width, bidirectional marks, C1) pass. A
 * word boundary that lost its backslash inside a String.raw template is not a
 * control character at all and is not caught. A regex that spells a control
 * character as "backslash, c, letter" is not reported by no-control-regex.
 * Changing what the lint script itself runs is not watched here. packages/ has
 * no ESLint, so only the byte scan reaches it.
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
const BACKSLASH = String.fromCharCode(0x5c);

const CONTROL_REGEX_RULE = 'no-control-regex';
const RESTRICTED_SYNTAX_RULE = 'no-restricted-syntax';
/** The comment directive that switches lint off. Assembled so this file does not hold one. */
const DISABLE_DIRECTIVE = ['eslint', 'disable'].join('-');
const ESLINT_CONFIG = `${APP_PREFIX}eslint.config.mjs`;
const THIS_FILE = `${APP_PREFIX}src/server/pilot/sourceControlCharacters.convention.test.ts`;

/**
 * Must equal CONTROL_CHARACTER_HANDLERS in eslint.config.mjs. Each of these
 * names control characters on purpose, as visible escapes. Adding a tenth means
 * changing this list too, in a diff a reviewer reads.
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
 * App files ESLint does not lint at all, so no rule can reach them. Listed so
 * that taking a file out of lint is as visible as switching a rule off for it.
 * The byte scan still reads every one of them.
 */
const NOT_LINTED = ['next-env.d.ts'];

const LINTED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** Reading a few thousand files is quick, but not always inside jest's default five seconds on a busy machine. */
const WHOLE_TREE_TIMEOUT_MS = 120_000;

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

/**
 * Lines holding a lint-off comment that names no rule, which switches EVERY
 * rule off for its line, the next line or the rest of the file. Such a comment
 * exempts a file from the rules above without naming them, so the checks on the
 * config would never notice.
 *
 * A directive is the first thing in its comment: directly after a line-comment
 * opener on the same line, or after a block-comment opener with any white space
 * between, line breaks included. What follows it, up to the end of the comment
 * and before any "--" explanation, must name at least one rule.
 */
function blanketDisables(text: string): number[] {
  const newline = String.fromCharCode(LINE_FEED);
  const lines: number[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(DISABLE_DIRECTIVE, from);
    if (at < 0) break;
    from = at + DISABLE_DIRECTIVE.length;
    const before = text.slice(0, at);
    const inBlock = before.trimEnd().endsWith('/*');
    const inLine = !inBlock && before.slice(before.lastIndexOf(newline) + 1).trimEnd().endsWith('//');
    if (!inBlock && !inLine) continue;
    let rest = text.slice(from);
    for (const suffix of ['-next-line', '-line']) {
      if (rest.startsWith(suffix)) {
        rest = rest.slice(suffix.length);
        break;
      }
    }
    const end = rest.indexOf(inBlock ? '*/' : newline);
    if (end >= 0) rest = rest.slice(0, end);
    const explanation = rest.indexOf('--');
    if (explanation >= 0) rest = rest.slice(0, explanation);
    if (rest.split(',').join('').trim().length === 0) lines.push(before.split(newline).length);
  }
  return lines;
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

function isOnDisk(name: string): boolean {
  return fs.existsSync(path.join(REPO_ROOT, name));
}

function rawBytes(...parts: Array<string | number>): Buffer {
  return Buffer.concat(parts.map((part) => (typeof part === 'number' ? Buffer.from([part]) : Buffer.from(part, 'utf8'))));
}

const TRACKED = trackedFiles();
/** What the byte scan reads: every tracked file that is not a binary format. */
const SCANNED = TRACKED.filter((name) => !BINARY_EXTENSIONS.has(path.extname(name).toLowerCase()) && isOnDisk(name));
/** The app's code files, named from the app root as ESLint names them. */
const APP_CODE = TRACKED
  .filter((name) => name.startsWith(APP_PREFIX) && LINTED_EXTENSIONS.has(path.extname(name).toLowerCase()) && isOnDisk(name))
  .map((name) => name.slice(APP_PREFIX.length));

describe('tracked files under apps/web and packages hold no C0 control characters', () => {
  it('reads the files it is meant to read', () => {
    // A scan that lists nothing passes everything. A tracked file that is not
    // on disk, or whose name did not survive decoding, would be skipped without
    // a word, so that is refused here rather than tolerated.
    const absent = TRACKED.filter((name) => !isOnDisk(name));
    if (absent.length > 0) {
      throw new Error(
        `${absent.length} tracked file(s) are not on disk, so this guard cannot read them: ${absent.slice(0, 10).join(', ')}. `
          + 'If you deleted them on purpose, stage the deletion (git rm) and run this again.',
      );
    }
    expect(SCANNED.length).toBeGreaterThan(2000);
    expect(SCANNED.filter((name) => name.startsWith('packages/')).length).toBeGreaterThan(10);
    expect(SCANNED).toEqual(
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
    const offenders = offendersIn(REPO_ROOT, SCANNED);
    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} tracked file(s) hold a control character:\n  `
          + `${offenders.slice(0, 40).join('\n  ')}\n\n`
          + 'In a regex a control byte matches only itself, so a pattern that reads as a word boundary '
          + 'matches nothing and the check built on it can never fail. A backspace (0x08) where '
          + '"backslash, b" was meant is the usual cause: some tool collapsed a doubled backslash on the '
          + 'way to disk. Rewrite the spot as the visible escape and look at the bytes afterwards. If the '
          + 'file is a binary format, add its extension to BINARY_EXTENSIONS in this test.',
      );
    }
  }, WHOLE_TREE_TIMEOUT_MS);
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
 * Asks ESLint, in a child process, two things. For each file: would it lint it
 * at all, and with each rule as an error? And for each sample of source text:
 * which of the two rules does it report? The config is an ES module, which this
 * jest setup cannot import, and asking ESLint is the point anyway: it answers
 * for the config as it resolves, not as its text reads.
 */
const ASK_ESLINT = `
const { ESLint } = require(process.argv[1]);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    const asked = JSON.parse(input);
    const eslint = new ESLint({ cwd: process.cwd() });
    const answer = { notLinted: [], notEnforced: {}, samples: {} };
    for (const rule of asked.rules) answer.notEnforced[rule] = [];
    for (const name of asked.names) {
      const config = (await eslint.isPathIgnored(name)) ? undefined : await eslint.calculateConfigForFile(name);
      if (!config) { answer.notLinted.push(name); continue; }
      for (const rule of asked.rules) {
        const setting = config.rules ? config.rules[rule] : undefined;
        const severity = Array.isArray(setting) ? setting[0] : setting;
        const options = Array.isArray(setting) ? setting.slice(1) : [];
        const selectors = options.map((option) => (option && typeof option === 'object' ? option.selector : option));
        const complete = (asked.required[rule] || []).every((selector) => selectors.includes(selector));
        if ((severity !== 2 && severity !== 'error') || !complete) answer.notEnforced[rule].push(name);
      }
    }
    for (const sample of asked.samples) {
      const results = await eslint.lintText(sample.code, { filePath: asked.sampleFile });
      const messages = results.length > 0 ? results[0].messages : [{ ruleId: null, message: 'not linted' }];
      const reported = messages
        .filter((message) => message.ruleId === null || asked.rules.includes(message.ruleId))
        .map((message) => (message.ruleId === null ? 'FATAL ' + message.message : message.ruleId));
      answer.samples[sample.label] = [...new Set(reported)].sort();
    }
    process.stdout.write(JSON.stringify(answer));
  } catch (error) {
    process.stderr.write(String(error && error.stack ? error.stack : error));
    process.exit(1);
  }
});
`;

interface EslintAnswer {
  notLinted: string[];
  notEnforced: Record<string, string[]>;
  samples: Record<string, string[]>;
}

/**
 * Source text ESLint is asked about. Built from character codes so that this
 * file holds neither a control character nor a damaged escape of its own.
 */
const BACKSPACE_BYTE = String.fromCharCode(0x08);
const WORD_BOUNDARY = `${BACKSLASH}b`;
const SAMPLES = [
  // The original defect: the byte itself, inside a regex literal.
  { label: 'a raw backspace in a regex literal', code: `export const a = /insert${BACKSPACE_BYTE}/;` },
  // The same character, spelled out.
  { label: 'an escaped control character in a regex literal', code: `export const a = /insert${BACKSLASH}x08/;` },
  // One backslash where two were needed: the string holds a backspace.
  {
    label: 'a lost backslash in a string handed to RegExp',
    code: `export const a = new RegExp('${WORD_BOUNDARY}insert${WORD_BOUNDARY}');`,
  },
  {
    label: 'a lost backslash in a string kept for later',
    code: `export const a = '${WORD_BOUNDARY}insert${WORD_BOUNDARY}';`,
  },
  {
    label: 'a lost backslash in a template handed to RegExp',
    code: `export const a = (word: string) => new RegExp(${'`'}${WORD_BOUNDARY}${'$'}{word}${WORD_BOUNDARY}${'`'});`,
  },
  // Only String.raw keeps the two characters apart. Any other tag gets the backspace.
  {
    label: 'a lost backslash in a template with a tag that is not String.raw',
    code: `export const a = (tag: (parts: TemplateStringsArray) => string) => tag${'`'}${WORD_BOUNDARY}insert${'`'};`,
  },
  // The three right ways to write it. None may be reported.
  {
    label: 'correct: a regex literal, a doubled backslash, a String.raw template',
    code: [
      `export const a = /${WORD_BOUNDARY}insert${WORD_BOUNDARY}/;`,
      `export const b = new RegExp('${BACKSLASH}${WORD_BOUNDARY}insert${BACKSLASH}${WORD_BOUNDARY}');`,
      `export const c = (word: string) => new RegExp(String.raw${'`'}${WORD_BOUNDARY}${'$'}{word}${WORD_BOUNDARY}${'`'});`,
    ].join(String.fromCharCode(LINE_FEED)),
  },
];

/**
 * Must equal the two selectors in eslint.config.mjs, character for character.
 * The rule is one shared list, so a later config block that sets it again
 * replaces these; asking only "is the rule an error" would not notice.
 */
const BACKSPACE_SELECTORS = [
  `Literal[value=/${BACKSPACE_BYTE}/]`,
  'TemplateLiteral:not(TaggedTemplateExpression[tag.object.name="String"][tag.property.name="raw"] > TemplateLiteral)'
    + ` > TemplateElement[value.cooked=/${BACKSPACE_BYTE}/]`,
];

function askEslint(): EslintAnswer {
  const asked = {
    rules: [CONTROL_REGEX_RULE, RESTRICTED_SYNTAX_RULE],
    required: { [RESTRICTED_SYNTAX_RULE]: BACKSPACE_SELECTORS },
    names: APP_CODE,
    samples: SAMPLES,
    // An ordinary app path that no override names. The file does not exist.
    sampleFile: 'src/server/pilot/controlCharacterSample.ts',
  };
  const result = spawnSync(process.execPath, ['-e', ASK_ESLINT, require.resolve('eslint')], {
    cwd: APP_ROOT,
    input: JSON.stringify(asked),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 150_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`ESLint could not be asked what it enforces: ${result.error?.message ?? result.stderr}`);
  }
  return JSON.parse(result.stdout) as EslintAnswer;
}

describe('ESLint refuses a control character in a regex, for the app', () => {
  let answer: EslintAnswer;
  beforeAll(() => {
    answer = askEslint();
  }, 180_000);

  it('lints every app code file but the one it is told to ignore', () => {
    expect([...answer.notLinted].sort()).toEqual([...NOT_LINTED].sort());
    // Counted, so "nothing is exempt" cannot mean "nothing was asked about".
    expect(APP_CODE.length).toBeGreaterThan(2000);
  });

  it(`${CONTROL_REGEX_RULE} is an error everywhere except the nine files that name control characters on purpose`, () => {
    expect([...answer.notEnforced[CONTROL_REGEX_RULE]].sort()).toEqual([...RULE_OFF_ON_PURPOSE].sort());
  });

  it('the backspace-in-a-string rule is an error, with both selectors, for every linted file', () => {
    expect(answer.notEnforced[RESTRICTED_SYNTAX_RULE]).toEqual([]);
  });

  it('reports each way the defect can be written, and none of the right ways', () => {
    expect(answer.samples).toEqual({
      'a raw backspace in a regex literal': [CONTROL_REGEX_RULE],
      'an escaped control character in a regex literal': [CONTROL_REGEX_RULE],
      'a lost backslash in a string handed to RegExp': [CONTROL_REGEX_RULE, RESTRICTED_SYNTAX_RULE],
      'a lost backslash in a string kept for later': [RESTRICTED_SYNTAX_RULE],
      'a lost backslash in a template handed to RegExp': [RESTRICTED_SYNTAX_RULE],
      'a lost backslash in a template with a tag that is not String.raw': [RESTRICTED_SYNTAX_RULE],
      'correct: a regex literal, a doubled backslash, a String.raw template': [],
    });
  });

  it('the nine exempt files still exist, so the list does not outlive what it describes', () => {
    for (const name of RULE_OFF_ON_PURPOSE) {
      expect({ name, exists: fs.existsSync(path.join(APP_ROOT, name)) }).toEqual({ name, exists: true });
    }
  });
});

describe('neither rule is switched off from inside a file', () => {
  it('only the config and this test name either rule', () => {
    // A comment naming a rule (to switch it off for a line or a file, or to
    // reconfigure it) would exempt that file without touching the config.
    // Nothing else has a reason to mention either one. If a second use of
    // no-restricted-syntax ever needs an exception, it belongs in the config,
    // where the test above can see it.
    const mentions = SCANNED.filter((name) => {
      const bytes = fs.readFileSync(path.join(REPO_ROOT, name));
      return bytes.includes(CONTROL_REGEX_RULE) || bytes.includes(RESTRICTED_SYNTAX_RULE);
    });
    expect(mentions.sort()).toEqual([ESLINT_CONFIG, THIS_FILE].sort());
  }, WHOLE_TREE_TIMEOUT_MS);

  it('every lint-off comment in the app names the rules it switches off', () => {
    const blanket: string[] = [];
    for (const name of APP_CODE) {
      const lines = blanketDisables(fs.readFileSync(path.join(APP_ROOT, name), 'utf8'));
      if (lines.length > 0) blanket.push(`${name}: line ${lines.join(', ')}`);
    }
    expect(blanket).toEqual([]);
  }, WHOLE_TREE_TIMEOUT_MS);

  it('tells a lint-off comment that names its rules from one that switches everything off', () => {
    const next = `${DISABLE_DIRECTIVE}-next-line`;
    const named = [
      `// ${next} react-hooks/set-state-in-effect`,
      `    // ${next} @next/next/no-img-element -- a data URL, not a remote image`,
      `/* ${DISABLE_DIRECTIVE} no-console */`,
      `const a = 1; // ${DISABLE_DIRECTIVE}-line no-console`,
      `{/* ${next} @next/next/no-img-element */}`,
      `// the ${next} below is there because of the effect`,
      `const text = 'how to write an ${DISABLE_DIRECTIVE} comment';`,
      '/*',
      `  ${DISABLE_DIRECTIVE} no-console,`,
      '  no-alert',
      '*/',
      '/* a note',
      `   ${DISABLE_DIRECTIVE}`,
      '*/',
    ].join(String.fromCharCode(LINE_FEED));
    expect(blanketDisables(named)).toEqual([]);

    const blanketed = [
      'const a = 1;',
      `/* ${DISABLE_DIRECTIVE} */`,
      `// ${next}`,
      `const b = 2; // ${DISABLE_DIRECTIVE}-line`,
      `// ${next} -- because`,
      `{/* ${next} */}`,
      `/* ${DISABLE_DIRECTIVE} no-console */ /* ${DISABLE_DIRECTIVE} */`,
      // Spread over three lines, and with both line endings.
      '/*',
      `  ${DISABLE_DIRECTIVE}`,
      '*/',
      `// ${next} ,`,
      `// ${next}${String.fromCharCode(CARRIAGE_RETURN)}`,
      'const c = 3;',
    ].join(String.fromCharCode(LINE_FEED));
    expect(blanketDisables(blanketed)).toEqual([2, 3, 4, 5, 6, 7, 9, 11, 12]);
  });
});

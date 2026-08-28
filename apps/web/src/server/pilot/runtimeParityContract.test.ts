import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The runtime-parity detector, and the proof that it bites.
 *
 * WHAT IT GUARDS. Every place that selects or executes a deployable's Node
 * runtime must agree with that deployable's own contract: the manifests that
 * declare it, the workflows that install it, the image stages that build with
 * it, and the final image stage that actually runs it. The web image shipped
 * with the last of those disagreeing -- `FROM alpine:3.19` plus
 * `apk add nodejs`, so the served container ran whichever Node major Alpine
 * 3.19 packaged while every other declaration said 22.
 *
 * WHAT IT DELIBERATELY DOES NOT GUARD. One Node major across the monorepo.
 * Research Bridge runs Node 24 with its own CI and its own image on purpose.
 * The tests below assert that this difference produces NO finding, because a
 * guard that cannot tell an intentional difference from drift would be
 * answered by deleting it.
 *
 * METHOD. scripts/runtime-parity.mjs is real ESM consumed by
 * scripts/verify-package-integrity.mjs, and the default jest runner has no ESM
 * loader (`npm test` does not pass --experimental-vm-modules). As in
 * check-migration-declaration.test.ts and shadowLibraryManifest.test.ts, every
 * expression is evaluated in one real `node` child process.
 *
 * The mutation tests copy the REAL repository files into a temporary root and
 * damage one of them, so what is proven red is the detector reading genuine
 * repository content -- not a hand-written miniature that could drift away
 * from the shapes this repository actually uses. `expect(after).not.toBe(
 * before)` inside the mutation helper is what stops a stale anchor from
 * turning a mutation test into a second copy of the clean-tree test.
 */

const REPOSITORY_ROOT = path.resolve(__dirname, '../../../../..');
const MODULE_URL = pathToFileURL(
  path.join(REPOSITORY_ROOT, 'scripts', 'runtime-parity.mjs'),
).href;

function evaluate<T>(expression: string): T {
  const script = `
    import * as m from ${JSON.stringify(MODULE_URL)};
    const value = await (${expression});
    process.stdout.write(JSON.stringify(value ?? null));
  `;

  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
}

type ParityResult = {
  problems: string[];
  summary: string[];
  deployables: {
    id: string;
    label: string;
    contract: { major: number; source: string } | null;
    coverage: { manifests: string[]; workflows: string[]; dockerfiles: string[] };
  }[];
};

function check(root: string): ParityResult {
  return evaluate<ParityResult>(`m.checkRuntimeParity(${JSON.stringify(root)})`);
}

/** Exactly the files the detector reads, copied from the real repository. */
function fixtureFiles(): string[] {
  const dockerfiles = fs
    .readdirSync(REPOSITORY_ROOT)
    .filter((file) => /^Dockerfile(\..+)?$/.test(file));

  const workflows = fs
    .readdirSync(path.join(REPOSITORY_ROOT, '.github', 'workflows'))
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => path.posix.join('.github/workflows', file));

  return [
    'package.json',
    'apps/web/package.json',
    'apps/research-bridge/package.json',
    ...dockerfiles,
    ...workflows,
  ];
}

const temporaryRoots: string[] = [];

function makeFixture(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ppbf-runtime-parity-')));
  temporaryRoots.push(root);

  for (const relativePath of fixtureFiles()) {
    const from = path.join(REPOSITORY_ROOT, relativePath);
    if (!fs.existsSync(from)) continue;

    const to = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }

  return root;
}

afterAll(() => {
  for (const root of temporaryRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Damage one fixture file, and fail loudly if the anchor no longer matches. */
function mutate(root: string, relativePath: string, from: string | RegExp, to: string): void {
  const file = path.join(root, relativePath);
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(from, to);

  // A mutation test whose anchor has gone stale silently becomes a duplicate
  // of the clean-tree test: green, and proving nothing.
  expect(after).not.toBe(before);

  fs.writeFileSync(file, after);
}

function write(root: string, relativePath: string, contents: string): void {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function matching(problems: string[], pattern: RegExp): string[] {
  return problems.filter((problem) => pattern.test(problem));
}

// ---------------------------------------------------------------------------
// Parsing primitives. One child process for the whole table.
// ---------------------------------------------------------------------------

describe('reading a Node major out of a declaration', () => {
  it('accepts the range shapes that pin exactly one major, and refuses the rest', () => {
    const specs = ['22.x', '24.x', '^22.0.0', '~24.1', '22', '=22.11.0', 'v22', '>=20', 'lts/*', '20 || 22', '', 'x'];

    expect(
      evaluate<(number | null)[]>(
        `${JSON.stringify(specs)}.map(m.parseEnginesMajor)`,
      ),
    ).toEqual([22, 24, 22, 24, 22, 22, 22, null, null, null, null, null]);

    // Non-strings never throw; they are simply not a contract.
    expect(evaluate<number | null>('m.parseEnginesMajor(undefined)')).toBeNull();
    expect(evaluate<number | null>('m.parseEnginesMajor(22)')).toBeNull();
  });

  it('reads the major from a node: image reference and nothing else', () => {
    const references = [
      'node:22-alpine',
      'node:24-alpine',
      'node:22',
      'node:22.11.0-alpine3.20',
      'docker.io/library/node:24-alpine',
      'node:22-alpine@sha256:abc',
      // Not a pinned Node major -- these must not be read as one.
      'alpine:3.19',
      'node:lts-alpine',
      'ubuntu:24.04',
      'mynode:22-alpine',
      'base',
    ];

    expect(
      evaluate<(number | null)[]>(`${JSON.stringify(references)}.map(m.nodeMajorFromImage)`),
    ).toEqual([22, 24, 22, 22, 24, 22, null, null, null, null, null]);
  });
});

describe('reading a Dockerfile', () => {
  const dockerfile = [
    '# a comment naming node:99-alpine, which is not an instruction',
    'FROM node:22-alpine AS base',
    'RUN apk add --no-cache \\',
    '    libc6-compat',
    '',
    'FROM base AS builder',
    'RUN npm run build',
    '',
    'FROM alpine:3.19 AS runner',
    'RUN apk add --no-cache \\',
    '    nodejs \\',
    '    ffmpeg',
  ].join('\n');

  it('records each stage, its alias and its line, ignoring comments', () => {
    expect(
      evaluate<{ image: string; alias: string | null; line: number }[]>(
        `m.parseDockerfile(${JSON.stringify(dockerfile)}).map(({ image, alias, line }) => ({ image, alias, line }))`,
      ),
    ).toEqual([
      { image: 'node:22-alpine', alias: 'base', line: 2 },
      { image: 'base', alias: 'builder', line: 6 },
      { image: 'alpine:3.19', alias: 'runner', line: 9 },
    ]);
  });

  it('follows an internal stage reference to the external image it rests on', () => {
    // `FROM base AS builder` names a stage, not an image. Reading only the
    // FROM line would report the runtime as "base" and find no Node major.
    expect(
      evaluate<string>(
        `(() => { const s = m.parseDockerfile(${JSON.stringify(dockerfile)});`
        + ' return m.resolveStageChain(s, s[1]).baseImage; })()',
      ),
    ).toBe('node:22-alpine');

    expect(
      evaluate<string>(
        `(() => { const s = m.parseDockerfile(${JSON.stringify(dockerfile)});`
        + ' return m.resolveStageChain(s, s[2]).baseImage; })()',
      ),
    ).toBe('alpine:3.19');
  });

  it('skips a FROM flag rather than reading it as the image', () => {
    // `FROM --platform=... node:22-alpine` would otherwise record the flag as
    // the base image, leaving the stage's real runtime unread and unchecked.
    const flagged = 'FROM --platform=linux/amd64 node:22-alpine AS base\nRUN npm ci';

    expect(
      evaluate<{ image: string; alias: string | null }[]>(
        `m.parseDockerfile(${JSON.stringify(flagged)}).map(({ image, alias }) => ({ image, alias }))`,
      ),
    ).toEqual([{ image: 'node:22-alpine', alias: 'base' }]);
  });

  it('sees a distro Node install split across continuation lines', () => {
    // The audited defect was written as one line, but folding continuations is
    // what stops the same install being hidden by a line break.
    expect(
      evaluate<{ line: number }[]>(
        `(() => { const s = m.parseDockerfile(${JSON.stringify(dockerfile)});`
        + ' return m.distroNodeInstalls(s[2]).map(({ line }) => ({ line })); })()',
      ),
    ).toEqual([{ line: 10 }]);

    // ...and does not mistake the ordinary libc6-compat install for one.
    expect(
      evaluate<unknown[]>(
        `(() => { const s = m.parseDockerfile(${JSON.stringify(dockerfile)});`
        + ' return m.distroNodeInstalls(s[0]); })()',
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The repository as committed.
// ---------------------------------------------------------------------------

describe('the repository as committed', () => {
  const result = check(REPOSITORY_ROOT);

  it('reports no runtime parity problems', () => {
    expect(result.problems).toEqual([]);
  });

  it('measured real deployables (guard against a vacuous pass)', () => {
    expect(result.deployables.length).toBeGreaterThan(1);

    for (const deployable of result.deployables) {
      expect(deployable.contract).not.toBeNull();
      expect(deployable.contract!.major).toBeGreaterThan(0);
      expect(deployable.coverage.dockerfiles.length).toBeGreaterThan(0);
      expect(deployable.coverage.workflows.length).toBeGreaterThan(0);
    }
  });

  it('holds the web deployable to the major its own manifest declares', () => {
    const web = result.deployables.find((deployable) => deployable.id === 'web')!;
    const declared = JSON.parse(
      fs.readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
    ).engines.node;

    // Read from the manifest rather than written here: a test that repeats the
    // number is a second place the contract lives.
    expect(web.contract!.major).toBe(Number(String(declared).match(/\d+/)![0]));
    expect(web.coverage.manifests).toEqual(
      expect.arrayContaining(['package.json', 'apps/web/package.json']),
    );
    expect(web.coverage.dockerfiles).toContain('Dockerfile');
  });

  it("permits Research Bridge's intentionally separate contract", () => {
    const web = result.deployables.find((deployable) => deployable.id === 'web')!;
    const bridge = result.deployables.find((deployable) => deployable.id === 'research-bridge')!;

    // The whole point of the model: these differ, on purpose, and that is not
    // a finding. Asserted as a difference rather than as two literals, so the
    // test does not become a third place either version number is recorded.
    expect(bridge.contract!.major).not.toBe(web.contract!.major);
    expect(result.problems).toEqual([]);
    expect(bridge.coverage.dockerfiles).toEqual(['Dockerfile.research-bridge']);
    expect(bridge.coverage.workflows).toEqual(['research-bridge-ci.yml']);
  });

  it('runs from verify-package-integrity.mjs, which CI runs above its fast path', () => {
    // Wiring, not behaviour: the guard is only load-bearing because it is
    // reached by the required `validate` job before the documentation-only
    // fast path, and by package-integrity.yml, whose verdict survives a
    // cancelled validate run.
    const integrity = fs.readFileSync(
      path.join(REPOSITORY_ROOT, 'scripts', 'verify-package-integrity.mjs'),
      'utf8',
    );
    expect(integrity).toMatch(/import\s*\{\s*checkRuntimeParity\s*\}\s*from\s*'\.\/runtime-parity\.mjs'/);
    expect(integrity).toMatch(/checkRuntimeParity\(repositoryRoot\)/);

    for (const workflow of ['ci.yml', 'package-integrity.yml']) {
      const contents = fs.readFileSync(
        path.join(REPOSITORY_ROOT, '.github', 'workflows', workflow),
        'utf8',
      );
      expect(contents).toContain('node scripts/verify-package-integrity.mjs');
    }

    // In ci.yml specifically it must precede the classifier step that can skip
    // everything below it.
    const ci = fs.readFileSync(
      path.join(REPOSITORY_ROOT, '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    expect(ci.indexOf('node scripts/verify-package-integrity.mjs')).toBeLessThan(
      ci.indexOf('- name: Classify changed surface'),
    );
  });
});

// ---------------------------------------------------------------------------
// Mutation proof. Each case damages one real declaration and watches it go red.
// ---------------------------------------------------------------------------

describe('mutations the guard must catch', () => {
  it('the untouched fixture is clean, so every finding below is the mutation', () => {
    expect(check(makeFixture()).problems).toEqual([]);
  });

  it('web CI moved to another Node major', () => {
    const root = makeFixture();
    mutate(root, '.github/workflows/ci.yml', /node-version: 22/, 'node-version: 20');

    const { problems } = check(root);
    expect(matching(problems, /ci\.yml:\d+ sets "node-version: 20"/)).toHaveLength(1);
    expect(problems.join('\n')).toMatch(/PPBF web/);
    expect(problems.join('\n')).toMatch(/the contract is Node 22 \(package\.json engines\.node "22\.x"\)/);
  });

  it('the web Docker BUILD stage moved to another Node major', () => {
    const root = makeFixture();
    mutate(root, 'Dockerfile', 'FROM node:22-alpine AS base', 'FROM node:20-alpine AS base');

    const { problems } = check(root);
    expect(matching(problems, /Dockerfile:\d+ builds on "node:20-alpine" \(Node 20\)/)).toHaveLength(1);
  });

  it('the web final runtime stage moved to another Node major', () => {
    const root = makeFixture();
    mutate(root, 'Dockerfile', 'FROM node:22-alpine AS runner', 'FROM node:24-alpine AS runner');

    const { problems } = check(root);
    expect(
      matching(problems, /is the final stage and rests on "node:24-alpine" \(Node 24\)/),
    ).toHaveLength(1);
  });

  it('the web final runtime stage regressed to an OS base with a distro Node package', () => {
    // The exact defect this slice fixed, replayed against the detector.
    const root = makeFixture();
    mutate(root, 'Dockerfile', 'FROM node:22-alpine AS runner', 'FROM alpine:3.19 AS runner');
    mutate(root, 'Dockerfile', 'RUN apk add --no-cache ffmpeg', 'RUN apk add --no-cache nodejs ffmpeg');

    const { problems } = check(root);
    expect(
      matching(problems, /is the final stage and rests on "alpine:3\.19", which pins no Node major/),
    ).toHaveLength(1);
    expect(matching(problems, /installs Node from a distro package/)).toHaveLength(1);
  });

  it('a web manifest drifted away from the contract', () => {
    const root = makeFixture();
    mutate(root, 'apps/web/package.json', '"node": "22.x"', '"node": "20.x"');

    const { problems } = check(root);
    expect(
      matching(problems, /apps\/web\/package\.json declares engines\.node "20\.x" \(Node 20\)/),
    ).toHaveLength(1);
  });

  it('the contract itself was loosened into a range that pins nothing', () => {
    const root = makeFixture();
    mutate(root, 'package.json', '"node": "22.x"', '"node": ">=22"');

    const { problems } = check(root);
    expect(matching(problems, /does not pin a single Node major/)).toHaveLength(1);
  });

  it('the unused migration image drifted, even though no workflow builds it', () => {
    const root = makeFixture();
    mutate(root, 'Dockerfile.migration', 'FROM node:22-alpine', 'FROM node:18-alpine');

    const { problems } = check(root);
    expect(matching(problems, /Dockerfile\.migration:\d+/)).not.toHaveLength(0);
  });

  it('a NEW web workflow arrived on the wrong major, with nobody registering it', () => {
    // The default direction has to be "checked". A guard that only sees what
    // somebody remembered to add is a list, not a detector.
    const root = makeFixture();
    write(
      root,
      '.github/workflows/brand-new-thing.yml',
      ['name: brand-new-thing', 'jobs:', '  go:', '    steps:', '      - uses: actions/setup-node@v7', '        with:', '          node-version: 18', ''].join('\n'),
    );

    const { problems } = check(root);
    expect(matching(problems, /brand-new-thing\.yml:\d+ sets "node-version: 18"/)).toHaveLength(1);
  });

  it('a NEW Dockerfile arrived with no deployable owning it', () => {
    const root = makeFixture();
    write(root, 'Dockerfile.something', 'FROM node:18-alpine\nCMD ["node", "x.js"]\n');

    const { problems } = check(root);
    expect(
      matching(problems, /Dockerfile\.something is not assigned to a deployable/),
    ).toHaveLength(1);
  });

  it('a registered Dockerfile disappeared', () => {
    const root = makeFixture();
    fs.rmSync(path.join(root, 'Dockerfile.migration'));

    const { problems } = check(root);
    expect(
      matching(problems, /assigns Dockerfile\.migration to a deployable, but the file does not exist/),
    ).toHaveLength(1);
  });
});

describe("Research Bridge's separate contract is enforced, not exempted", () => {
  it('its own CI drifting off its own major is a finding', () => {
    const root = makeFixture();
    mutate(root, '.github/workflows/research-bridge-ci.yml', /node-version: 24/, 'node-version: 22');

    const { problems } = check(root);
    // Named against Research Bridge's contract, not web's -- moving it TO the
    // web major is still drift, because it is not what its image runs.
    expect(
      matching(problems, /Research Bridge: \.github\/workflows\/research-bridge-ci\.yml:\d+ sets "node-version: 22"/),
    ).toHaveLength(1);
  });

  it('its image disagreeing with itself makes its contract unreadable, and says so', () => {
    const root = makeFixture();
    mutate(root, 'Dockerfile.research-bridge', 'FROM node:24-alpine AS runner', 'FROM node:22-alpine AS runner');

    const { problems } = check(root);
    expect(
      matching(problems, /Research Bridge: Dockerfile\.research-bridge pins Node 22 and 24 in different stages/),
    ).toHaveLength(1);
  });

  it('web drifting does not implicate Research Bridge, and vice versa', () => {
    const root = makeFixture();
    mutate(root, '.github/workflows/ci.yml', /node-version: 22/, 'node-version: 20');

    const { problems } = check(root);
    expect(problems.every((problem) => !problem.startsWith('Research Bridge:'))).toBe(true);
  });
});

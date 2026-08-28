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
    coverage: { manifests: string[]; workflows: string[]; dockerfiles: string[]; types: string[] };
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

  // Discovered the same way the module discovers them, so a new workspace in
  // the real repository lands in the fixture without this list being edited.
  const workspaces: string[] = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8'),
  ).workspaces ?? [];

  const manifests = ['package.json'];

  for (const pattern of workspaces) {
    if (!pattern.endsWith('/*')) continue;
    const parent = path.join(REPOSITORY_ROOT, pattern.slice(0, -2));
    if (!fs.existsSync(parent)) continue;

    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = path.posix.join(pattern.slice(0, -2), entry.name, 'package.json');
      if (fs.existsSync(path.join(REPOSITORY_ROOT, manifest))) manifests.push(manifest);
    }
  }

  return [
    ...manifests,
    // The lockfile decides which @types/node each workspace's compiler sees,
    // so a fixture without it cannot exercise the resolution check at all.
    'package-lock.json',
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

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Edit one key of a fixture JSON, addressed by its path. Every step of that
 * path is asserted to exist first, for the same reason `mutate()` asserts the
 * text actually changed: a mutation aimed at a key that has been renamed does
 * nothing, and a test that mutates nothing quietly becomes a second copy of
 * the clean-tree test.
 */
function editJson(
  root: string,
  relativePath: string,
  keys: string[],
  apply: (parent: JsonObject, last: string) => void,
): void {
  const file = path.join(root, relativePath);
  const document = JSON.parse(fs.readFileSync(file, 'utf8')) as JsonObject;

  let node: JsonObject = document;

  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    expect(isJsonObject(next)).toBe(true);
    node = next as JsonObject;
  }

  const last = keys[keys.length - 1];
  expect(last in node).toBe(true);
  apply(node, last);

  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
}

function setJson(root: string, relativePath: string, keys: string[], value: JsonValue): void {
  editJson(root, relativePath, keys, (parent, last) => {
    parent[last] = value;
  });
}

function deleteJson(root: string, relativePath: string, keys: string[]): void {
  editJson(root, relativePath, keys, (parent, last) => {
    delete parent[last];
  });
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

describe('discovering which manifests exist at all', () => {
  it('finds the root plus every workspace directory that has a manifest', () => {
    const discovered = evaluate<string[]>(
      `m.discoverWorkspaceManifests(${JSON.stringify(REPOSITORY_ROOT)}, ${JSON.stringify(
        JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, 'package.json'), 'utf8')).workspaces,
      )})`,
    );

    expect(discovered[0]).toBe('package.json');
    expect(discovered).toEqual(expect.arrayContaining([
      'apps/web/package.json',
      'apps/research-bridge/package.json',
    ]));

    // Every entry is real, and a workspace directory carrying no manifest
    // contributes nothing rather than a phantom path.
    for (const manifest of discovered) {
      expect(fs.existsSync(path.join(REPOSITORY_ROOT, manifest))).toBe(true);
    }
  });

  it('expands only the trailing-* form npm supports, and refuses to escape the root', () => {
    const root = makeFixture();

    expect(evaluate<string[]>(`m.discoverWorkspaceManifests(${JSON.stringify(root)}, ['apps/*'])`))
      .toEqual(expect.arrayContaining(['apps/web/package.json']));

    // An exact path is taken as written.
    expect(evaluate<string[]>(`m.discoverWorkspaceManifests(${JSON.stringify(root)}, ['apps/web'])`))
      .toEqual(['package.json', 'apps/web/package.json']);

    // Neither a mid-pattern star nor a traversal contributes anything.
    for (const pattern of ['apps/*/deep', '../*', 'apps/../../*']) {
      expect(
        evaluate<string[]>(
          `m.discoverWorkspaceManifests(${JSON.stringify(root)}, ${JSON.stringify([pattern])})`,
        ),
      ).toEqual(['package.json']);
    }

    // A non-array is not a crash; the caller reports it as a finding.
    expect(evaluate<string[]>(`m.discoverWorkspaceManifests(${JSON.stringify(root)}, undefined)`))
      .toEqual(['package.json']);
  });
});

describe('reading the type surface a workspace compiles against', () => {
  it('reads the major of a concrete installed version, and only of one', () => {
    const versions = ['22.20.1', '24.13.3', '20.19.43', '^22', '22', '', 'next'];

    expect(
      evaluate<(number | null)[]>(`${JSON.stringify(versions)}.map(m.majorOfVersion)`),
    ).toEqual([22, 24, 20, null, null, null, null]);

    // A range is not an installed version; parseEnginesMajor owns those.
    expect(evaluate<number | null>('m.majorOfVersion(undefined)')).toBeNull();
  });

  it("walks npm's own resolution order, own node_modules first and root last", () => {
    // This ordering is the whole finding: a workspace that declares nothing
    // still resolves something, from a parent directory it never chose.
    expect(
      evaluate<string[]>(`m.lockResolutionCandidates('apps/research-bridge')`),
    ).toEqual([
      'apps/research-bridge/node_modules/@types/node',
      'apps/node_modules/@types/node',
      'node_modules/@types/node',
    ]);

    expect(evaluate<string[]>(`m.lockResolutionCandidates('')`)).toEqual([
      'node_modules/@types/node',
    ]);
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

  it('every deployable compiles against the Node major it runs', () => {
    // Read from the result rather than written here: the majors live in the
    // repository, and a test that repeats them becomes another place they
    // drift from.
    for (const deployable of result.deployables) {
      expect(deployable.coverage.types.length).toBeGreaterThan(0);

      for (const line of deployable.coverage.types) {
        const resolved = /@ (\d+)\./.exec(line);
        expect(resolved).not.toBeNull();
        expect(Number(resolved![1])).toBe(deployable.contract!.major);
      }
    }
  });

  it('the two deployables resolve their types from different places, on purpose', () => {
    const web = result.deployables.find((deployable) => deployable.id === 'web')!;
    const bridge = result.deployables.find((deployable) => deployable.id === 'research-bridge')!;

    // Research Bridge cannot share the hoisted copy, because its major differs.
    // If these ever collapse onto one entry, one of them is compiling against
    // the other's runtime -- which is exactly the state this slice corrected.
    expect(bridge.coverage.types.join()).toContain('apps/research-bridge/node_modules/');
    expect(web.coverage.types.join()).not.toContain('apps/research-bridge/node_modules/');
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

describe('mutations of the type surface the guard must catch', () => {
  const TYPES_KEY = ['devDependencies', '@types/node'];
  const LOCK_ROOT = 'node_modules/@types/node';
  const LOCK_BRIDGE = 'apps/research-bridge/node_modules/@types/node';

  it('a workspace declaring types for a Node major it does not run', () => {
    const root = makeFixture();
    setJson(root, 'apps/research-bridge/package.json', TYPES_KEY, '^20.19.33');

    const { problems } = check(root);
    expect(
      matching(problems, /research-bridge\/package\.json declares @types\/node "\^20\.19\.33" \(Node 20 types\)/),
    ).toHaveLength(1);
    expect(problems.join('\n')).toMatch(/would check this workspace against a runtime it does not run/);
  });

  it('a types range that pins no single major', () => {
    const root = makeFixture();
    setJson(root, 'package.json', TYPES_KEY, '>=22');

    const { problems } = check(root);
    expect(
      matching(problems, /package\.json declares @types\/node ">=22", which does not pin a single major/),
    ).toHaveLength(1);
  });

  it('the lockfile installing a major the manifest did not ask for', () => {
    // The range and the installed version can disagree -- a hand-edited lock,
    // a bad merge resolution. `npm ci` installs the lock, so the lock wins.
    const root = makeFixture();
    setJson(root, 'package-lock.json', ['packages', LOCK_ROOT, 'version'], '20.19.43');

    const { problems } = check(root);
    expect(
      matching(problems, /resolves @types\/node 20\.19\.43 \(Node 20 types\) from node_modules\/@types\/node/),
    ).not.toHaveLength(0);
  });

  it('THE SHAPE THIS SLICE FIXED: declaring nothing, and inheriting a hoist', () => {
    // Reconstructed exactly: the root workspace declares no @types/node, and
    // the hoisted copy is another workspace's Node 20. Before this slice that
    // was the live state of the repository, and nothing reported it.
    const root = makeFixture();
    deleteJson(root, 'package.json', TYPES_KEY);
    deleteJson(root, 'apps/web/package.json', TYPES_KEY);
    setJson(root, 'package-lock.json', ['packages', LOCK_ROOT, 'version'], '20.19.43');

    const { problems } = check(root);

    // The resolution finding, naming the inheritance rather than only the number.
    expect(
      matching(problems, /declares no @types\/node of its own, so it inherits whatever another workspace hoists/),
    ).not.toHaveLength(0);

    // ...and the deployable-level finding: nothing it owns pins a type surface.
    expect(
      matching(problems, /PPBF web: no manifest it owns declares @types\/node/),
    ).toHaveLength(1);
  });

  it('a deployable whose types are pinned nowhere it owns', () => {
    const root = makeFixture();
    deleteJson(root, 'apps/research-bridge/package.json', TYPES_KEY);

    const { problems } = check(root);
    expect(
      matching(problems, /Research Bridge: no manifest it owns declares @types\/node/),
    ).toHaveLength(1);
  });

  it('a workspace that resolves no types at all', () => {
    const root = makeFixture();
    deleteJson(root, 'package-lock.json', ['packages', LOCK_ROOT]);
    deleteJson(root, 'package-lock.json', ['packages', LOCK_BRIDGE]);

    const { problems } = check(root);
    expect(
      matching(problems, /resolves no @types\/node at all in package-lock\.json/),
    ).not.toHaveLength(0);
  });

  it('a missing lockfile is a finding, not a silent skip', () => {
    const root = makeFixture();
    fs.rmSync(path.join(root, 'package-lock.json'));

    const { problems } = check(root);
    expect(
      matching(problems, /package-lock\.json is missing, so no workspace's resolved @types\/node can be read/),
    ).toHaveLength(1);
  });

  it('the runtime and the types are independent findings, not one', () => {
    // A guard that only ever reported them together would hide whichever
    // half moved on its own.
    const root = makeFixture();
    mutate(root, '.github/workflows/ci.yml', /node-version: 22/, 'node-version: 20');

    const { problems } = check(root);
    expect(matching(problems, /ci\.yml:\d+ sets "node-version: 20"/)).toHaveLength(1);
    expect(matching(problems, /@types\/node/)).toHaveLength(0);
  });
});

describe('a workspace nobody registered', () => {
  // THE FAIL-OPEN LEG THIS SLICE CLOSED. Dockerfiles and workflows were always
  // discovered from disk and fail closed when unregistered; manifests were a
  // hardcoded list of three paths, so a new workspace on the wrong major was
  // never looked at. Both cases below passed silently before.

  it('a NEW app workspace on the wrong Node major is caught', () => {
    const root = makeFixture();
    write(
      root,
      'apps/newthing/package.json',
      `${JSON.stringify({
        name: 'newthing',
        private: true,
        engines: { node: '18.x' },
        devDependencies: { '@types/node': '^18' },
      }, null, 2)}\n`,
    );

    const { problems } = check(root);
    expect(
      matching(problems, /apps\/newthing\/package\.json declares engines\.node "18\.x" \(Node 18\)/),
    ).toHaveLength(1);
    expect(
      matching(problems, /apps\/newthing\/package\.json declares @types\/node "\^18"/),
    ).toHaveLength(1);
  });

  it('a NEW packages/* workspace is caught too, though that glob matches nothing today', () => {
    // packages/* is declared in workspaces but contributes no manifest at
    // present, so this is the case a hardcoded list would never have grown.
    const root = makeFixture();
    write(
      root,
      'packages/newlib/package.json',
      `${JSON.stringify({ name: 'newlib', private: true, engines: { node: '20.x' } }, null, 2)}\n`,
    );

    const { problems } = check(root);
    expect(
      matching(problems, /packages\/newlib\/package\.json declares engines\.node "20\.x"/),
    ).toHaveLength(1);
  });

  it('a new workspace declaring neither field is not invented into a finding', () => {
    // Fail-closed must not mean noisy: a workspace with no Node opinion of its
    // own inherits the hoisted types, and today those already match.
    const root = makeFixture();
    write(root, 'apps/quiet/package.json', `${JSON.stringify({ name: 'quiet', private: true }, null, 2)}\n`);

    expect(check(root).problems).toEqual([]);
  });

  it('losing the workspaces array is itself a finding', () => {
    const root = makeFixture();
    deleteJson(root, 'package.json', ['workspaces']);

    const { problems } = check(root);
    expect(
      matching(problems, /declares no "workspaces" array, so no workspace manifest beyond the root can be discovered/),
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

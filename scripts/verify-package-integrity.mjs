// Fails when a manifest a release depends on has been gutted.
//
// WHY THIS EXISTS
// ---------------
// apps/web/package.json went from ~39 KB to 327 bytes across commits pushed
// straight to main. Every dependency, the `test` script, all 96
// `pilot:apply-*` migration runners and the whole `test:migrations` chain went
// with it. `ci.yml` does trigger on push to main, but it did not report the
// damage: back-to-back direct pushes leave each queued run cancelled (GitHub
// cancels *pending* runs in a concurrency group regardless of
// `cancel-in-progress`), and the documentation-only fast path then reports
// green for every later commit that happens to touch only `.md` files. So the
// last word on main was "success" while the manifest was a stub.
//
// This check therefore has to be cheap enough to run unconditionally, before
// any classifier fast path, and it must not depend on the thing it guards:
// no `npm ci`, no node_modules, no network. Plain node, standard library only.
//
// The assertions are derived from the repository, never from a remembered
// count -- the file list on disk and the script names in the manifest are the
// source of truth. Deleting a runner and its script together is a legitimate
// change; deleting one side is what this catches. It mirrors the `list-check`
// mode in .github/workflows/apply-migrations.yml: report every discrepancy
// with a `::error::` annotation, then exit non-zero.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const problems = [];

function fail(message) {
  problems.push(message);
  console.error(`::error::${message}`);
}

function readJson(relativePath) {
  const absolute = path.join(repositoryRoot, relativePath);

  if (!fs.existsSync(absolute)) {
    fail(`${relativePath} is missing.`);
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    fail(`${relativePath} does not parse as JSON: ${error.message}`);
    return null;
  }
}

function scriptsOf(manifest, relativePath) {
  const scripts = manifest?.scripts;

  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
    fail(`${relativePath} has no "scripts" object.`);
    return {};
  }

  return scripts;
}

// Every `npm run <name>` a script chains to. Cross-workspace delegation is
// written `npm --workspace web run x`, which this pattern deliberately does not
// match -- those names resolve in another manifest and are checked separately.
function chainedScriptNames(command) {
  return [...command.matchAll(/npm\s+run\s+([A-Za-z0-9:_.-]+)/g)].map(
    (match) => match[1],
  );
}

function checkRequiredScripts(scripts, relativePath, required) {
  for (const name of required) {
    const command = scripts[name];

    if (typeof command !== 'string' || command.trim() === '') {
      fail(`${relativePath} is missing the "${name}" script a release depends on.`);
    }
  }
}

// Every `npm run x` inside a manifest resolves to a script that manifest
// defines. This is what catches a truncated `test:migrations` chain: the chain
// survives, the suites it names do not.
function checkChainsResolve(scripts, relativePath) {
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') {
      fail(`${relativePath} script "${name}" is not a string.`);
      continue;
    }

    for (const target of chainedScriptNames(command)) {
      if (!(target in scripts)) {
        fail(
          `${relativePath} script "${name}" runs "npm run ${target}", which ${relativePath} does not define.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// apps/web -- the manifest that was destroyed.
// ---------------------------------------------------------------------------

const webManifestPath = 'apps/web/package.json';
const webManifest = readJson(webManifestPath);
const webScripts = webManifest ? scriptsOf(webManifest, webManifestPath) : {};

for (const field of ['dependencies', 'devDependencies']) {
  const value = webManifest?.[field];

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (webManifest) fail(`${webManifestPath} has no "${field}" object.`);
  } else if (Object.keys(value).length === 0) {
    fail(`${webManifestPath} "${field}" is empty -- the application cannot install.`);
  }
}

checkRequiredScripts(webScripts, webManifestPath, [
  'test',
  'test:migrations',
  'build',
  'lint',
  'typecheck',
]);

checkChainsResolve(webScripts, webManifestPath);

// Every migration suite the repository defines has to be in the chain the
// release gate runs. A suite that exists but is not chained is invisible.
const migrationChain = webScripts['test:migrations'];

if (typeof migrationChain === 'string') {
  const chained = new Set(chainedScriptNames(migrationChain));

  for (const name of Object.keys(webScripts)) {
    if (name.startsWith('test:migrations:') && !chained.has(name)) {
      fail(
        `${webManifestPath} defines "${name}" but the "test:migrations" chain never runs it.`,
      );
    }
  }
}

// Migration runners on disk and the scripts that invoke them must agree in
// both directions. The scripts name the file they run, so the pairing is read
// from the command rather than guessed from a filename convention.
const runnerDirectory = 'apps/web/scripts';
const runnerDirectoryPath = path.join(repositoryRoot, runnerDirectory);

const runnerFiles = fs.existsSync(runnerDirectoryPath)
  ? fs
      .readdirSync(runnerDirectoryPath)
      .filter((file) => /^pilot-apply-.+\.mjs$/.test(file))
      .sort()
  : [];

if (runnerFiles.length === 0) {
  fail(`${runnerDirectory} contains no pilot-apply-*.mjs migration runners.`);
}

const applyScriptEntries = Object.entries(webScripts).filter(([name]) =>
  name.startsWith('pilot:apply-'),
);

const referencedRunners = new Map();

for (const [name, command] of applyScriptEntries) {
  if (typeof command !== 'string') continue;

  const referenced = [...command.matchAll(/scripts\/([A-Za-z0-9._-]+\.mjs)/g)].map(
    (match) => match[1],
  );

  if (referenced.length === 0) {
    fail(`${webManifestPath} script "${name}" runs no scripts/*.mjs runner.`);
    continue;
  }

  for (const file of referenced) {
    referencedRunners.set(file, name);

    if (!fs.existsSync(path.join(runnerDirectoryPath, file))) {
      fail(
        `${webManifestPath} script "${name}" runs ${runnerDirectory}/${file}, which does not exist.`,
      );
    }
  }
}

for (const file of runnerFiles) {
  if (!referencedRunners.has(file)) {
    fail(
      `${runnerDirectory}/${file} has no pilot:apply-* script in ${webManifestPath} -- the migration cannot be dispatched.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Root manifest -- every workspace entrypoint CI and the deploy jobs call.
// ---------------------------------------------------------------------------

const rootManifestPath = 'package.json';
const rootManifest = readJson(rootManifestPath);
const rootScripts = rootManifest ? scriptsOf(rootManifest, rootManifestPath) : {};

if (rootManifest && !Array.isArray(rootManifest.workspaces)) {
  fail(`${rootManifestPath} has no "workspaces" array -- apps/web stops resolving.`);
}

checkRequiredScripts(rootScripts, rootManifestPath, [
  'test',
  'test:migrations',
  'build',
  'lint',
  'typecheck',
]);

checkChainsResolve(rootScripts, rootManifestPath);

// The root manifest is a thin delegator; if it forwards to a web script that
// no longer exists, `npm run build` at the root dies with "Missing script".
for (const [name, command] of Object.entries(rootScripts)) {
  if (typeof command !== 'string') continue;

  for (const match of command.matchAll(
    /npm\s+--workspace\s+web\s+run\s+([A-Za-z0-9:_.-]+)/g,
  )) {
    if (!(match[1] in webScripts)) {
      fail(
        `${rootManifestPath} script "${name}" delegates to web script "${match[1]}", which ${webManifestPath} does not define.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// package-lock.json -- `npm ci` fails outright when it disagrees with a
// manifest, so lock drift is the same class of breakage.
// ---------------------------------------------------------------------------

const lockPath = 'package-lock.json';
const lock = readJson(lockPath);

if (lock) {
  if (!lock.packages || typeof lock.packages !== 'object') {
    fail(`${lockPath} has no "packages" map -- npm ci cannot use it.`);
  } else {
    const lockedWorkspaces = [
      ['', rootManifest, rootManifestPath],
      ['apps/web', webManifest, webManifestPath],
    ];

    for (const [key, manifest, manifestPath] of lockedWorkspaces) {
      if (!manifest) continue;

      const locked = lock.packages[key];

      if (!locked) {
        fail(`${lockPath} has no entry for the "${key || 'root'}" workspace.`);
        continue;
      }

      for (const field of ['dependencies', 'devDependencies']) {
        const declared = Object.keys(manifest[field] ?? {});
        const lockedNames = new Set(Object.keys(locked[field] ?? {}));

        for (const name of declared) {
          if (!lockedNames.has(name)) {
            fail(
              `${lockPath} does not lock "${name}" (${field} of ${manifestPath}) -- npm ci will refuse to install.`,
            );
          }
        }

        for (const name of lockedNames) {
          if (!declared.includes(name)) {
            fail(
              `${lockPath} locks "${name}" in ${field} of "${key || 'root'}", but ${manifestPath} no longer declares it.`,
            );
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// design-system/ppbf.css -- the single stylesheet every room renders against.
// A truncated stylesheet still "builds", so check it structurally.
// ---------------------------------------------------------------------------

const stylesheetPath = 'design-system/ppbf.css';
const stylesheetAbsolute = path.join(repositoryRoot, stylesheetPath);

if (!fs.existsSync(stylesheetAbsolute)) {
  fail(`${stylesheetPath} is missing.`);
} else {
  const stylesheet = fs.readFileSync(stylesheetAbsolute, 'utf8');
  const opened = (stylesheet.match(/\{/g) ?? []).length;
  const closed = (stylesheet.match(/\}/g) ?? []).length;

  if (!stylesheet.includes(':root')) {
    fail(`${stylesheetPath} declares no :root block -- the design tokens are gone.`);
  }

  if (opened !== closed) {
    fail(
      `${stylesheetPath} has ${opened} "{" and ${closed} "}" -- the file is truncated or malformed.`,
    );
  }
}

// ---------------------------------------------------------------------------

if (problems.length > 0) {
  console.error('');
  console.error(
    `Package integrity check failed with ${problems.length} problem${
      problems.length === 1 ? '' : 's'
    }.`,
  );
  process.exit(1);
}

console.log(
  [
    'Package integrity verified:',
    `- ${webManifestPath}: ${Object.keys(webScripts).length} scripts, ` +
      `${Object.keys(webManifest?.dependencies ?? {}).length} dependencies, ` +
      `${Object.keys(webManifest?.devDependencies ?? {}).length} devDependencies`,
    `- ${runnerFiles.length} pilot-apply-*.mjs runners, each with a pilot:apply-* script`,
    `- test:migrations chains ${
      chainedScriptNames(webScripts['test:migrations'] ?? '').length
    } suites, all defined`,
    `- ${rootManifestPath} delegates only to scripts that exist`,
    `- ${lockPath} agrees with both manifests`,
    `- ${stylesheetPath} is structurally intact`,
  ].join('\n'),
);

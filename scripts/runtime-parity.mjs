// Runtime & toolchain parity: one Node major per deployable, agreed by every
// place that SELECTS or EXECUTES that deployable's runtime.
//
// WHY THIS EXISTS
// ---------------
// The web image's final execution stage was `FROM alpine:3.19` and obtained
// its Node from `apk add nodejs` -- an Alpine package whose major is chosen by
// the distro release, not by this repository. Everything upstream of it agreed
// on 22 (root and apps/web `engines.node`, ci.yml's `node-version`, and the
// image's own `FROM node:22-alpine` build stage); the container that actually
// served traffic did not, and nothing in the repository could say so. The
// Dockerfile's own header records the previous instance of the same defect
// class, when CI and the Docker build ran different majors.
//
// The rule is NOT "one Node major everywhere in the monorepo". Research Bridge
// runs Node 24 on purpose, with its own CI and its own image, and that is a
// legitimate, explicitly declared difference. The defect class is UNINTENTIONAL
// drift inside one deployable's own set of declarations.
//
// HOW THE FACTS ARE DERIVED
// -------------------------
// This module contains no Node version numbers. It carries ownership only --
// which file belongs to which deployable -- and reads every major out of the
// repository:
//
//   * `web` takes its contract from the root `package.json` `engines.node`.
//   * `research-bridge` declares no `engines` field, so its contract is the
//     Node major its own Dockerfile pins. Requiring it to add an `engines`
//     field would be a change to another deployable's contract; this module
//     reads the declaration that already exists instead.
//
// Ownership is deliberately fail-closed in both directions. Dockerfiles are
// discovered from disk and every one of them must be registered below, so a
// new image cannot join unmeasured. Workflows are discovered from disk and
// every workflow that sets a `node-version` and is NOT explicitly assigned
// elsewhere is held to the web contract, so a new web workflow on the wrong
// major fails without anyone remembering to register it.
//
// METHOD, stated honestly: raw file text plus regular expressions, the same
// idiom as workflowResourceGroupContract.test.ts and
// migrationDispatchCoverage.test.ts. js-yaml exists in this repository only as
// an undeclared transitive dependency, so no real YAML parser is used, and the
// Dockerfile parser below is a small purpose-built one rather than a general
// implementation of the Dockerfile grammar.
//
// THE TYPE SURFACE IS THE SAME CONTRACT, one layer up. A workspace whose
// `@types/node` major differs from the Node it runs is checked by the compiler
// against a runtime nobody deploys: APIs added since are unresolvable, APIs
// removed since still typecheck, and `tsc --noEmit` is green either way. That
// is drift with no failing signal at all, so it is checked here beside the
// runtime it belongs to rather than left to be noticed.
//
// Two things are checked, because they fail differently:
//
//   * the DECLARED range in each manifest, and
//   * the RESOLVED version each workspace actually gets, read out of
//     package-lock.json by walking npm's own resolution order.
//
// The second is the one that matters. The root workspace declared no
// `@types/node` at all and silently inherited Node 20 types hoisted from
// apps/research-bridge, while every workflow ran its scripts on Node 22.
// Declaring nothing is not neutral: it hands the version to whatever another
// workspace happens to hoist, which is the same defect as taking Node from a
// distro package instead of an explicit base image. So a deployable that
// declares no types package fails here.
//
// WHAT THIS CANNOT CATCH. It is static. It cannot build an image, cannot run
// `node --version` inside one, and cannot observe what a deployed revision is
// executing. It does not see a `--build-arg` supplied at build time, a base
// image whose own contents changed under a moving tag, or a workflow that
// installs Node without an `actions/setup-node` `node-version:` line
// (azure-static-web-apps-purple-bush-04c73e010.yml declares none and is
// therefore outside this check). What it CAN catch is every declaration this
// repository actually makes, which is where all of the observed drift lived.

import fs from 'node:fs';
import path from 'node:path';

/** Deployables, and the file that declares each one's runtime contract. */
export const DEPLOYABLES = [
  {
    id: 'web',
    label: 'PPBF web',
    // The major is READ from this manifest's engines.node -- not stated here.
    contract: { kind: 'engines', file: 'package.json' },
  },
  {
    id: 'research-bridge',
    label: 'Research Bridge',
    // No engines field anywhere in this workspace, so its own image is the
    // declaration. Intentionally a different major from web; that difference
    // is permitted, and this module verifies it is internally consistent
    // rather than forcing it onto the web contract.
    contract: { kind: 'dockerfile', file: 'Dockerfile.research-bridge' },
  },
];

/**
 * Every Dockerfile in the repository root, and which deployable owns it.
 * Discovery below asserts this map and the files on disk are the same set.
 */
export const DOCKERFILE_OWNERSHIP = {
  'Dockerfile': 'web',
  // Builds nothing today -- no workflow references it -- but it is a real
  // Dockerfile pinning a Node major for the root-workspace migration runner,
  // so it is held to the same contract rather than left unmeasured.
  'Dockerfile.migration': 'web',
  'Dockerfile.research-bridge': 'research-bridge',
};

/**
 * Workflows that belong to a deployable OTHER than web. Every other workflow
 * declaring a node-version is web's, by default, so the default is the safe
 * direction: a new workflow is checked unless somebody deliberately reassigns
 * it here.
 */
export const WORKFLOW_OWNERSHIP = {
  'research-bridge-ci.yml': 'research-bridge',
};

/** Manifest path prefixes owned by a non-web deployable. */
const MANIFEST_OWNERSHIP_PREFIXES = [
  ['apps/research-bridge/', 'research-bridge'],
];

const WORKFLOW_DIRECTORY = '.github/workflows';
const LOCKFILE = 'package-lock.json';
const ROOT_MANIFEST = 'package.json';

/** The package that carries the Node API surface the compiler checks against. */
const TYPES_PACKAGE = '@types/node';

// ---------------------------------------------------------------------------
// Parsing primitives. Exported so the contract test can drive them directly.
// ---------------------------------------------------------------------------

/**
 * The single Node major an `engines.node` range pins, or null when the range
 * does not pin exactly one. `">=20"` returns null on purpose: a floor is not a
 * contract, and treating it as one would let the runtime drift by a major
 * without any file changing.
 */
export function parseEnginesMajor(spec) {
  if (typeof spec !== 'string') return null;
  const match = /^\s*(?:\^|~|=|v)?\s*(\d+)(?:\.(?:x|\*|\d+))?(?:\.(?:x|\*|\d+))?\s*$/.exec(spec);
  return match ? Number(match[1]) : null;
}

/**
 * The Node major an image reference pins, or null when the reference is not a
 * `node:` image. Registry prefixes, digests and patch-level tags are all
 * accepted; `node:lts-alpine` is not, because it names no major.
 */
export function nodeMajorFromImage(reference) {
  if (typeof reference !== 'string') return null;
  const withoutDigest = reference.split('@')[0];
  const match = /(?:^|\/)node:(\d+)(?:\.\d+){0,2}(?:-[\w.]+)*$/.exec(withoutDigest.trim());
  return match ? Number(match[1]) : null;
}

/** The major of a concrete installed version. Ranges belong to parseEnginesMajor. */
export function majorOfVersion(version) {
  const match = /^(\d+)\.\d+/.exec(String(version ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * The package-lock keys a workspace would consult for `@types/node`, in npm's
 * own order: its own node_modules first, then each parent directory's, ending
 * at the root. The first one present is what its tsconfig resolves, which is
 * why a workspace that declares nothing still gets a version -- somebody
 * else's.
 */
export function lockResolutionCandidates(workspaceDirectory) {
  const parts = workspaceDirectory.split('/').filter(Boolean);
  const candidates = [];

  for (let depth = parts.length; depth >= 0; depth -= 1) {
    const prefix = parts.slice(0, depth).join('/');
    candidates.push(
      prefix ? `${prefix}/node_modules/${TYPES_PACKAGE}` : `node_modules/${TYPES_PACKAGE}`,
    );
  }

  return candidates;
}

/**
 * Every workspace manifest in the repository: the root, plus each directory a
 * `workspaces` entry resolves to that actually contains a package.json.
 *
 * DISCOVERED, not listed. This used to be three hardcoded paths, which made
 * manifests the one fail-OPEN leg of this module: Dockerfiles and workflows are
 * read off disk and a new one that is not registered fails, but a new workspace
 * declaring `engines.node` or `@types/node` for a major nothing runs was simply
 * not looked at. A guard whose coverage depends on somebody remembering to add
 * a path is a list, not a detector -- the same argument this module already
 * makes about workflow ownership.
 *
 * Only the trailing-`*` form npm actually supports is expanded; an exact path
 * is taken as written. Directories without a package.json are skipped, which is
 * why `packages/*` contributes nothing today.
 */
export function discoverWorkspaceManifests(repositoryRoot, workspaces) {
  const found = [ROOT_MANIFEST];
  const patterns = Array.isArray(workspaces) ? workspaces : [];

  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.includes('..')) continue;

    const directories = [];

    if (pattern.endsWith('/*')) {
      const parent = pattern.slice(0, -2);
      const absolute = path.join(repositoryRoot, parent);

      if (fs.existsSync(absolute)) {
        for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
          if (entry.isDirectory()) directories.push(path.posix.join(parent, entry.name));
        }
      }
    } else if (!pattern.includes('*')) {
      directories.push(pattern);
    }

    for (const directory of directories.sort()) {
      const manifest = path.posix.join(directory, 'package.json');
      if (fs.existsSync(path.join(repositoryRoot, manifest)) && !found.includes(manifest)) {
        found.push(manifest);
      }
    }
  }

  return found;
}

/**
 * Dockerfile stages: the base image each one names, its alias, its line, and
 * the instruction text belonging to it. Comments are dropped and backslash
 * continuations are folded, so `apk add --no-cache \\\n nodejs` reads as one
 * instruction rather than two unrelated lines.
 */
export function parseDockerfile(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const stages = [];
  let pending = '';
  let pendingLine = 0;

  const flush = () => {
    if (!pending.trim()) {
      pending = '';
      return;
    }

    const instruction = pending.trim();
    // `--platform=...` and any other FROM flag is skipped rather than mistaken
    // for the image, which would leave the stage's real base unread.
    const from = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(instruction);

    if (from) {
      stages.push({
        index: stages.length,
        image: from[1],
        alias: from[2] ?? null,
        line: pendingLine,
        instructions: [],
      });
    } else if (stages.length > 0) {
      stages[stages.length - 1].instructions.push({ text: instruction, line: pendingLine });
    }

    pending = '';
  };

  lines.forEach((raw, offset) => {
    const lineNumber = offset + 1;

    // A comment line ends any continuation it interrupts, which is also how
    // the Docker builder reads it.
    if (/^\s*#/.test(raw)) {
      flush();
      return;
    }

    if (pending === '') pendingLine = lineNumber;

    if (/\\\s*$/.test(raw)) {
      pending += `${raw.replace(/\\\s*$/, '')} `;
      return;
    }

    pending += raw;
    flush();
  });

  flush();

  return stages;
}

/**
 * Follow a stage's `FROM` through internal stage aliases to the external image
 * the chain ultimately rests on. Returns the chain so a caller can inspect
 * every stage the final image inherits, not only the last one.
 */
export function resolveStageChain(stages, stage) {
  const byAlias = new Map(
    stages.filter((candidate) => candidate.alias).map((candidate) => [candidate.alias.toLowerCase(), candidate]),
  );

  const chain = [stage];
  let current = stage;

  while (byAlias.has(current.image.toLowerCase())) {
    const parent = byAlias.get(current.image.toLowerCase());
    if (chain.includes(parent)) break; // malformed self-reference; stop rather than loop
    chain.push(parent);
    current = parent;
  }

  return { chain, baseImage: current.image };
}

/** A distro package manager being asked for Node. This is the audited defect. */
const DISTRO_NODE_INSTALL =
  /\b(?:apk\s+add|apk\s+--no-cache\s+add|apt-get\s+install|apt\s+install|yum\s+install|dnf\s+install)\b[^\n]*\bnodejs\b/i;

export function distroNodeInstalls(stage) {
  return stage.instructions.filter((instruction) => DISTRO_NODE_INSTALL.test(instruction.text));
}

/** Every `node-version:` a workflow declares, with its line number. */
export function workflowNodeVersions(text) {
  const found = [];

  text.replace(/\r\n/g, '\n').split('\n').forEach((line, offset) => {
    const match = /^\s*node-version:\s*['"]?(\d+)(?:\.[\d.x*]+)?['"]?\s*$/.exec(line);
    if (match) found.push({ major: Number(match[1]), line: offset + 1, raw: line.trim() });
  });

  return found;
}

// ---------------------------------------------------------------------------
// The check.
// ---------------------------------------------------------------------------

/**
 * Measure runtime parity for every deployable under `repositoryRoot`.
 *
 * Returns `{ problems, summary, deployables }`. `problems` is empty when every
 * deployable's declarations agree with its own contract; deployables are never
 * compared with each other.
 */
export function checkRuntimeParity(repositoryRoot) {
  const problems = [];
  const fail = (message) => problems.push(message);

  const readText = (relativePath) =>
    fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8').replace(/\r\n/g, '\n');
  const exists = (relativePath) => fs.existsSync(path.join(repositoryRoot, relativePath));

  const byId = new Map(DEPLOYABLES.map((deployable) => [deployable.id, deployable]));

  // -- Dockerfiles: discovered from disk, every one registered ---------------

  const discoveredDockerfiles = fs
    .readdirSync(repositoryRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^Dockerfile(\..+)?$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const registeredDockerfiles = Object.keys(DOCKERFILE_OWNERSHIP).sort();

  for (const file of discoveredDockerfiles) {
    if (!(file in DOCKERFILE_OWNERSHIP)) {
      fail(
        `${file} is not assigned to a deployable in scripts/runtime-parity.mjs -- `
        + 'its Node runtime is unmeasured. Register it, so a new image cannot drift unnoticed.',
      );
    }
  }

  for (const file of registeredDockerfiles) {
    if (!discoveredDockerfiles.includes(file)) {
      fail(
        `scripts/runtime-parity.mjs assigns ${file} to a deployable, but the file does not exist. `
        + 'Remove the registration or restore the file.',
      );
    }
  }

  if (discoveredDockerfiles.length === 0) {
    fail('No Dockerfile was found at the repository root -- this check would pass vacuously.');
  }

  const dockerfileStages = new Map();

  for (const file of discoveredDockerfiles) {
    dockerfileStages.set(file, parseDockerfile(readText(file)));
  }

  // -- Workflows: discovered from disk, assigned by exception ---------------

  const workflowDirectory = path.join(repositoryRoot, WORKFLOW_DIRECTORY);
  const workflowFiles = fs.existsSync(workflowDirectory)
    ? fs
      .readdirSync(workflowDirectory)
      .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
      .sort()
    : [];

  const workflowVersions = new Map();

  for (const file of workflowFiles) {
    const versions = workflowNodeVersions(readText(path.posix.join(WORKFLOW_DIRECTORY, file)));
    if (versions.length > 0) workflowVersions.set(file, versions);
  }

  for (const file of Object.keys(WORKFLOW_OWNERSHIP)) {
    if (!workflowVersions.has(file)) {
      fail(
        `scripts/runtime-parity.mjs assigns ${WORKFLOW_DIRECTORY}/${file} to `
        + `"${WORKFLOW_OWNERSHIP[file]}", but that workflow declares no node-version. `
        + 'Remove the assignment or restore the declaration.',
      );
    }
  }

  if (workflowVersions.size === 0) {
    fail(
      `No workflow under ${WORKFLOW_DIRECTORY} declares a node-version -- `
      + 'this check would pass vacuously.',
    );
  }

  // -- Manifests: whichever exist and declare engines.node ------------------

  const manifests = new Map();
  const typesDeclarations = new Map();
  const workspaceManifests = [];

  let rootWorkspaces = null;

  if (exists(ROOT_MANIFEST)) {
    try {
      rootWorkspaces = JSON.parse(readText(ROOT_MANIFEST)).workspaces;
    } catch {
      // Reported below, when the same file fails to parse as a manifest.
    }
  }

  const discoveredManifests = discoverWorkspaceManifests(repositoryRoot, rootWorkspaces);

  if (!Array.isArray(rootWorkspaces)) {
    fail(
      `${ROOT_MANIFEST} declares no "workspaces" array, so no workspace manifest beyond `
      + 'the root can be discovered and any of them could drift unmeasured.',
    );
  }

  for (const relativePath of discoveredManifests) {
    if (!exists(relativePath)) continue;

    let manifest;
    try {
      manifest = JSON.parse(readText(relativePath));
    } catch (error) {
      fail(`${relativePath} does not parse as JSON: ${error.message}`);
      continue;
    }

    workspaceManifests.push(relativePath);

    const declaredTypes = {
      ...(manifest?.dependencies ?? {}),
      ...(manifest?.devDependencies ?? {}),
    }[TYPES_PACKAGE];

    if (declaredTypes !== undefined) typesDeclarations.set(relativePath, declaredTypes);

    const declared = manifest?.engines?.node;
    if (declared === undefined) continue;

    manifests.set(relativePath, declared);
  }

  // The lockfile is what `npm ci` installs, so it -- not the range -- decides
  // which type surface each workspace's compiler actually sees.
  let lock = null;

  if (!exists(LOCKFILE)) {
    fail(`${LOCKFILE} is missing, so no workspace's resolved ${TYPES_PACKAGE} can be read.`);
  } else {
    try {
      lock = JSON.parse(readText(LOCKFILE));
    } catch (error) {
      fail(`${LOCKFILE} does not parse as JSON: ${error.message}`);
    }

    if (lock && (!lock.packages || typeof lock.packages !== 'object')) {
      fail(`${LOCKFILE} has no "packages" map, so resolved versions cannot be read.`);
      lock = null;
    }
  }

  // -- Ownership resolution -------------------------------------------------

  const ownerOfWorkflow = (file) => WORKFLOW_OWNERSHIP[file] ?? 'web';
  const ownerOfManifest = (relativePath) => {
    for (const [prefix, id] of MANIFEST_OWNERSHIP_PREFIXES) {
      if (relativePath.startsWith(prefix)) return id;
    }
    return 'web';
  };

  for (const [file, id] of Object.entries({ ...DOCKERFILE_OWNERSHIP, ...WORKFLOW_OWNERSHIP })) {
    if (!byId.has(id)) {
      fail(`${file} is assigned to unknown deployable "${id}" in scripts/runtime-parity.mjs.`);
    }
  }

  // -- Contract majors, read from the repository ----------------------------

  const contracts = new Map();

  for (const deployable of DEPLOYABLES) {
    const { kind, file } = deployable.contract;

    if (kind === 'engines') {
      const declared = manifests.get(file);

      if (declared === undefined) {
        fail(
          `${deployable.label}: ${file} declares no engines.node, so this deployable has no `
          + 'runtime contract to hold anything to.',
        );
        continue;
      }

      const major = parseEnginesMajor(declared);

      if (major === null) {
        fail(
          `${deployable.label}: ${file} engines.node is "${declared}", which does not pin a single `
          + 'Node major. A floor or an open range is not a runtime contract.',
        );
        continue;
      }

      contracts.set(deployable.id, { major, source: `${file} engines.node "${declared}"` });
      continue;
    }

    // kind === 'dockerfile': the image itself is the declaration.
    const stages = dockerfileStages.get(file);

    if (!stages) {
      fail(`${deployable.label}: ${file} is missing, so its runtime contract cannot be read.`);
      continue;
    }

    const majors = [...new Set(
      stages.map((stage) => nodeMajorFromImage(stage.image)).filter((major) => major !== null),
    )];

    if (majors.length === 0) {
      fail(
        `${deployable.label}: ${file} pins no node:<major> image, so its runtime contract `
        + 'cannot be established from the file that is supposed to declare it.',
      );
      continue;
    }

    if (majors.length > 1) {
      fail(
        `${deployable.label}: ${file} pins Node ${majors.sort((a, b) => a - b).join(' and ')} in `
        + 'different stages, so its intended runtime major is ambiguous. A deployable with an '
        + 'ambiguous contract cannot be checked -- decide the major, then re-run.',
      );
      continue;
    }

    contracts.set(deployable.id, { major: majors[0], source: `${file} FROM node:${majors[0]}` });
  }

  // -- Every declaration agrees with its own deployable's contract ----------

  const coverage = new Map(DEPLOYABLES.map((deployable) => [
    deployable.id,
    { manifests: [], workflows: [], dockerfiles: [], types: [] },
  ]));

  for (const [relativePath, declared] of manifests) {
    const id = ownerOfManifest(relativePath);
    const contract = contracts.get(id);
    coverage.get(id)?.manifests.push(relativePath);
    if (!contract) continue;

    const major = parseEnginesMajor(declared);

    if (major === null) {
      fail(
        `${byId.get(id).label}: ${relativePath} engines.node is "${declared}", which does not pin a `
        + `single Node major. The contract is Node ${contract.major} (${contract.source}).`,
      );
      continue;
    }

    if (major !== contract.major) {
      fail(
        `${byId.get(id).label}: ${relativePath} declares engines.node "${declared}" (Node ${major}), `
        + `but the contract is Node ${contract.major} (${contract.source}).`,
      );
    }
  }

  for (const [file, versions] of workflowVersions) {
    const id = ownerOfWorkflow(file);
    const contract = contracts.get(id);
    coverage.get(id)?.workflows.push(file);
    if (!contract) continue;

    for (const version of versions) {
      if (version.major !== contract.major) {
        fail(
          `${byId.get(id).label}: ${WORKFLOW_DIRECTORY}/${file}:${version.line} sets `
          + `"${version.raw}", but the contract is Node ${contract.major} (${contract.source}).`,
        );
      }
    }
  }

  for (const [file, id] of Object.entries(DOCKERFILE_OWNERSHIP)) {
    const stages = dockerfileStages.get(file);
    const contract = contracts.get(id);
    if (!byId.has(id)) continue;
    coverage.get(id)?.dockerfiles.push(file);
    if (!stages || !contract) continue;

    const label = byId.get(id).label;

    if (stages.length === 0) {
      fail(`${label}: ${file} declares no FROM instruction.`);
      continue;
    }

    // Every node: tag anywhere in the file. A build stage on a different major
    // from the runtime stage is the earlier instance of this defect class.
    for (const stage of stages) {
      const major = nodeMajorFromImage(stage.image);
      if (major !== null && major !== contract.major) {
        fail(
          `${label}: ${file}:${stage.line} builds on "${stage.image}" (Node ${major}), but the `
          + `contract is Node ${contract.major} (${contract.source}).`,
        );
      }
    }

    // The stage the image actually runs: the last one, which is what a build
    // without an explicit --target produces.
    const finalStage = stages[stages.length - 1];
    const { chain, baseImage } = resolveStageChain(stages, finalStage);
    const baseMajor = nodeMajorFromImage(baseImage);

    if (baseMajor === null) {
      fail(
        `${label}: ${file}:${finalStage.line} is the final stage and rests on "${baseImage}", which `
        + `pins no Node major. The runtime this image executes must come from an explicit `
        + `node:${contract.major} base image, not from whatever Node the base OS happens to carry.`,
      );
    } else if (baseMajor !== contract.major) {
      fail(
        `${label}: ${file}:${finalStage.line} is the final stage and rests on "${baseImage}" `
        + `(Node ${baseMajor}), but the contract is Node ${contract.major} (${contract.source}).`,
      );
    }

    // ...and it must not acquire Node from a distro package on top of that.
    // This is the exact shape the web image shipped: an OS base plus
    // `apk add nodejs`, whose major is the distro release's choice.
    for (const stage of chain) {
      for (const instruction of distroNodeInstalls(stage)) {
        fail(
          `${label}: ${file}:${instruction.line} installs Node from a distro package `
          + `("${instruction.text.slice(0, 80)}"). The major that lands is chosen by the base `
          + `image's package repository, not by this repository, so the executed runtime is not `
          + `pinned to the Node ${contract.major} contract.`,
        );
      }
    }
  }

  // -- The type surface each workspace compiles against ---------------------
  //
  // Same contract, one layer up. The DECLARED range is checked because that is
  // what a reader sees; the RESOLVED version is checked because that is what
  // the compiler sees, and the two came apart here already: the root workspace
  // declared nothing and inherited Node 20 types hoisted out of another
  // workspace while running Node 22.
  // -------------------------------------------------------------------------

  for (const [relativePath, declaredRange] of typesDeclarations) {
    const id = ownerOfManifest(relativePath);
    const contract = contracts.get(id);
    if (!contract) continue;

    const major = parseEnginesMajor(declaredRange);

    if (major === null) {
      fail(
        `${byId.get(id).label}: ${relativePath} declares ${TYPES_PACKAGE} `
        + `"${declaredRange}", which does not pin a single major. The runtime contract `
        + `is Node ${contract.major} (${contract.source}), so the types have to pin it too.`,
      );
      continue;
    }

    if (major !== contract.major) {
      fail(
        `${byId.get(id).label}: ${relativePath} declares ${TYPES_PACKAGE} "${declaredRange}" `
        + `(Node ${major} types), but the contract is Node ${contract.major} `
        + `(${contract.source}). The compiler would check this workspace against a runtime `
        + `it does not run.`,
      );
    }
  }

  for (const relativePath of workspaceManifests) {
    const id = ownerOfManifest(relativePath);
    const contract = contracts.get(id);
    if (!contract || !lock) continue;

    const directory = path.posix.dirname(relativePath) === '.'
      ? ''
      : path.posix.dirname(relativePath);

    const resolvedKey = lockResolutionCandidates(directory)
      .find((candidate) => lock.packages[candidate]?.version !== undefined);

    if (resolvedKey === undefined) {
      fail(
        `${byId.get(id).label}: ${relativePath} resolves no ${TYPES_PACKAGE} at all in `
        + `${LOCKFILE}, so nothing types the Node API surface it compiles against.`,
      );
      continue;
    }

    const resolvedVersion = lock.packages[resolvedKey].version;
    const resolvedMajor = majorOfVersion(resolvedVersion);

    coverage.get(id)?.types.push(`${relativePath} -> ${resolvedKey} @ ${resolvedVersion}`);

    if (resolvedMajor !== contract.major) {
      const inherited = !typesDeclarations.has(relativePath)
        ? ` ${relativePath} declares no ${TYPES_PACKAGE} of its own, so it inherits whatever`
          + ' another workspace hoists -- a version this repository never chose.'
        : '';

      fail(
        `${byId.get(id).label}: ${relativePath} resolves ${TYPES_PACKAGE} `
        + `${resolvedVersion} (Node ${resolvedMajor} types) from ${resolvedKey}, but the `
        + `contract is Node ${contract.major} (${contract.source}).${inherited}`,
      );
    }
  }

  // Declaring nothing is not neutral -- it is the hoist deciding. Every
  // deployable has to pin its own type surface somewhere.
  for (const deployable of DEPLOYABLES) {
    if (!contracts.has(deployable.id)) continue;

    const declares = [...typesDeclarations.keys()].some(
      (relativePath) => ownerOfManifest(relativePath) === deployable.id,
    );

    if (!declares) {
      fail(
        `${deployable.label}: no manifest it owns declares ${TYPES_PACKAGE}, so its type `
        + 'surface is whatever another workspace hoists rather than a version this '
        + 'repository chose.',
      );
    }
  }

  // -- No deployable may pass without having been measured ------------------

  for (const deployable of DEPLOYABLES) {
    const covered = coverage.get(deployable.id);
    if (!contracts.has(deployable.id)) continue;

    if (covered.dockerfiles.length === 0) {
      fail(`${deployable.label}: no Dockerfile is assigned to it, so its runtime is unmeasured.`);
    }

    if (covered.workflows.length === 0) {
      fail(`${deployable.label}: no workflow declaring a node-version is assigned to it.`);
    }
  }

  const summary = DEPLOYABLES.map((deployable) => {
    const contract = contracts.get(deployable.id);
    const covered = coverage.get(deployable.id);

    if (!contract) return `- ${deployable.label}: contract UNRESOLVED`;

    return [
      `- ${deployable.label}: Node ${contract.major} (${contract.source})`,
      `    manifests:   ${covered.manifests.join(', ') || 'none declaring engines.node'}`,
      `    dockerfiles: ${covered.dockerfiles.join(', ') || 'none'}`,
      `    workflows:   ${covered.workflows.length} declaring node-version`,
      `    types:       ${covered.types.join('\n                 ') || 'none resolved'}`,
    ].join('\n');
  });

  return {
    problems,
    summary,
    deployables: DEPLOYABLES.map((deployable) => ({
      id: deployable.id,
      label: deployable.label,
      contract: contracts.get(deployable.id) ?? null,
      coverage: coverage.get(deployable.id),
    })),
  };
}

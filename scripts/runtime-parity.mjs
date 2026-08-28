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

/** Manifests this module reads, if they exist. `packages/*` declares none. */
const CANDIDATE_MANIFESTS = [
  'package.json',
  'apps/web/package.json',
  'apps/research-bridge/package.json',
];

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

  for (const relativePath of CANDIDATE_MANIFESTS) {
    if (!exists(relativePath)) continue;

    let manifest;
    try {
      manifest = JSON.parse(readText(relativePath));
    } catch (error) {
      fail(`${relativePath} does not parse as JSON: ${error.message}`);
      continue;
    }

    const declared = manifest?.engines?.node;
    if (declared === undefined) continue;

    manifests.set(relativePath, declared);
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
    { manifests: [], workflows: [], dockerfiles: [] },
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

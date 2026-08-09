// Runs the runtime-verification probes against a deployed environment and
// prints a ledger.
//
//   npm run pilot:runtime-verify -- --target=staging
//   npm run pilot:runtime-verify -- --target=production --item=T-003,PR-238ab
//   npm run pilot:runtime-verify -- --target=staging --json > ledger.json
//
// This produces evidence. It does not promote it. Moving a queue row to
// RUNTIME_VERIFIED, and writing docs/current/PRODUCTION_STATE.json, stay with
// the gatekeeper -- that separation is the reason the state file is trusted at
// all, and a tool that closed the loop itself would quietly remove it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANIFEST, PROBES, probesForItems } from './runtime-probes.manifest.mjs';
import { runProbes } from './lib/runtime-probe.mjs';

// Same shape as the other eight scripts that need it. Deliberately not shared
// with them in this change: consolidating a helper across eight callers is its
// own diff, and mixing it into a new feature is how unrelated regressions get
// attributed to the wrong commit.
async function loadEnvLocal() {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.local');

  let contents;
  try {
    contents = await fs.readFile(envPath, 'utf8');
  } catch {
    return; // No .env.local (CI, or a container). The env vars must be set.
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;

    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function parseArgs(argv) {
  const args = {
    target: null,
    items: null,
    json: false,
    baseUrl: null,
    allowProductionSessionMint: false,
  };

  for (const arg of argv) {
    if (arg === '--json') args.json = true;
    else if (arg === '--allow-production-session-mint') args.allowProductionSessionMint = true;
    else if (arg.startsWith('--target=')) args.target = arg.slice('--target='.length);
    else if (arg.startsWith('--base-url=')) args.baseUrl = arg.slice('--base-url='.length);
    else if (arg.startsWith('--item=')) {
      args.items = arg
        .slice('--item='.length)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    }
  }

  if (!['staging', 'production'].includes(args.target)) {
    throw new Error('Pass --target=staging or --target=production.');
  }

  return args;
}

/**
 * Production's origin is recorded in PRODUCTION_STATE.json, so defaulting it
 * saves a typo-prone paste. Staging has no recorded origin, so it must be
 * supplied rather than guessed -- a wrong guess would silently probe nothing
 * and report ERROR for every row, which reads like an outage.
 */
export function resolveBaseUrl(args, env) {
  if (args.baseUrl) return args.baseUrl;
  if (env.PILOT_GATE_BASE_URL) return env.PILOT_GATE_BASE_URL;
  if (args.target === 'production') return 'https://www.punxsyprominence.org';
  throw new Error(
    'No base URL for staging. Pass --base-url=https://... or set PILOT_GATE_BASE_URL.',
  );
}

function renderLedger(ledger, { items }) {
  const line = '='.repeat(72);
  console.log('Runtime verification ledger');
  console.log(line);
  console.log(`target:   ${ledger.target}`);
  console.log(`base url: ${ledger.baseUrl}`);
  console.log(`probes:   ${ledger.results.length}${items ? ` (filtered to ${items.join(', ')})` : ''}`);
  console.log('');

  let currentItem = null;
  for (const result of ledger.results) {
    if (result.item && result.item !== currentItem) {
      currentItem = result.item;
      const entry = MANIFEST.find((candidate) => candidate.item === currentItem);
      console.log(`  ${currentItem} -- ${entry?.title ?? ''}`);
    }

    const marker = { PASS: 'ok  ', FAIL: 'FAIL', ERROR: 'ERR ', SKIPPED: 'skip' }[result.status];
    console.log(`    ${marker} ${result.id}`);
    if (result.status === 'FAIL') {
      console.log(`         expected ${result.expected}, observed ${result.observed}`);
      console.log(`         why this matters: ${result.because}`);
    } else if (result.status === 'ERROR' || result.status === 'SKIPPED') {
      console.log(`         ${result.reason}`);
    } else if (result.detail) {
      console.log(`         ${result.detail}`);
    }
  }

  console.log('');
  console.log(line);
  const tally = Object.entries(ledger.tally).map(([k, v]) => `${k}=${v}`).join('  ');
  console.log(`tally: ${tally || 'none'}`);
  console.log(`sessions minted: ${ledger.sessionsMinted}, revoked: ${ledger.sessionsRevoked}`);
  if (ledger.sessionsMinted !== ledger.sessionsRevoked) {
    console.log('WARNING: a probe session was not revoked. Revoke it by hand before walking away.');
  }

  // The most important thing this tool prints. A green run means the boundaries
  // hold, not that the features do, and the difference is exactly the mistake
  // the RUNTIME_VERIFIED rung exists to prevent.
  const outstanding = MANIFEST.filter((entry) => entry.acceptanceProbeOutstanding)
    .filter((entry) => !items || items.includes(entry.item));
  if (outstanding.length > 0) {
    console.log('');
    console.log(`${outstanding.length} item(s) still need a human-authored acceptance probe:`);
    for (const entry of outstanding) {
      console.log(`  - ${entry.item}: ${entry.acceptanceProbeOutstanding}`);
    }
    console.log('');
    console.log('A green run above does NOT clear RUNTIME_VERIFIED for those items. It clears the');
    console.log('deployed-and-gated question only. Do not promote a row on this output alone.');
  }
  console.log(line);
}

async function run() {
  await loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = resolveBaseUrl(args, process.env);

  const probes = args.items ? probesForItems(args.items) : PROBES;
  if (probes.length === 0) {
    throw new Error(`No probes matched ${args.items?.join(', ') ?? '(all)'}.`);
  }

  const ledger = await runProbes({
    probes,
    baseUrl,
    target: args.target,
    connectionString: process.env.AZURE_POSTGRES_CONNECTION_STRING || null,
    allowProductionSessionMint: args.allowProductionSessionMint,
  });

  if (args.json) {
    // Drop predicates: functions do not survive JSON, and a half-serialized
    // probe in a ledger file is worse than an absent one.
    console.log(JSON.stringify(ledger, null, 2));
  } else {
    renderLedger(ledger, { items: args.items });
  }

  // SKIPPED is not a failure. A missing coach fixture means less was checked,
  // and the ledger says so plainly; exiting non-zero for it would train the
  // operator to ignore the exit code.
  if (!ledger.ok) process.exit(1);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('RUNTIME VERIFICATION FAILED TO RUN');
    console.error(String(error?.message || error));
    process.exit(1);
  }
}

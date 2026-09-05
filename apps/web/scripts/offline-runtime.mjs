#!/usr/bin/env node
/*
 * Local-only PPBF launcher. It applies the complete repository schema to an
 * embedded loopback database and seeds only records marked "offline" or
 * "Demo". It never reads or writes apps/web/.env.local.
 *
 * Start/stop/status are scoped to THIS checkout. They will not stop another
 * worktree's replica.
 */
import { createHash, randomBytes, scrypt as nodeScrypt } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';
import {
  HELP_TEXT,
  createRuntimeState,
  formatStatus,
  inspectRuntime,
  parseRuntimeArgs,
  readPostmasterPid,
  readRuntimeState,
  removeRuntimeState,
  removeStaleLockFileIfNeeded,
  runtimePaths,
  stopRecordedProcesses,
  writeRuntimeState,
} from './lib/offline-runtime-lifecycle.mjs';
import { buildOfflineChildEnv } from './lib/offline-runtime-env.mjs';
import {
  applyPendingMigrations,
  baselineMigrationHistory,
  hasMigrationHistory,
} from './lib/offline-db-evolution.mjs';

const scrypt = promisify(nodeScrypt);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.resolve(scriptDir, '..');
const repoDir = path.resolve(workspaceDir, '..', '..');
const { runtimeDir, databaseDir, stateFile } = runtimePaths(repoDir);
const markerTable = 'offline_runtime_metadata';
const generatedProjectFiles = [
  path.join(workspaceDir, 'next-env.d.ts'),
  path.join(workspaceDir, 'tsconfig.json'),
];

async function findPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(pin, salt, 64);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

async function stopThisCheckoutRuntime() {
  const state = await readRuntimeState(stateFile, repoDir);
  const { unstopped, ambiguous } = await stopRecordedProcesses(state, databaseDir, { repoDir });
  const problems = [];

  if (unstopped.length) {
    problems.push(`PPBF proved these processes belong to this checkout but could not stop them: ${unstopped.join(', ')}.`);
  }

  // Ownership was never proven for these, so they were never signalled. Not
  // proven owned is not the same as proven unrelated, and the difference is
  // exactly what stops this message from recommending a blind state delete.
  if (ambiguous.length) {
    problems.push(
      `PPBF did not signal recorded process(es) ${ambiguous.join(', ')}: it could not prove they belong to this checkout. `
      + 'That is a limit of what PPBF can observe, not a finding that they are unrelated. '
      + "To recover, either end such a process yourself if it is this checkout's offline runtime and rerun this command, "
      + 'or, only after independently verifying that a live process is unrelated to this checkout, remove the preserved state file by hand.',
    );
  }

  if (problems.length) {
    throw new Error(
      `PPBF offline runtime stop did not complete, so start and restart are blocked. ${problems.join(' ')} `
      + `Runtime state was preserved. State file: ${stateFile}`,
    );
  }

  await removeRuntimeState(stateFile);
}

async function printStatus() {
  const state = await readRuntimeState(stateFile, repoDir);
  console.log(formatStatus(state, inspectRuntime(state)));
}

/**
 * Classify this checkout's database directory before anything can act on it.
 *
 * Only a genuine "no such entry" proves the directory is absent. Every other
 * failure means PPBF could not look, which is not the same as nothing being
 * there -- treating the two alike is how an unreadable directory would end up
 * initialised over. Anything short of a positive proof lands on UNUSABLE, and
 * UNUSABLE never authorizes destruction.
 *
 * `deps` exists so the inspection-failure cases can be proven deterministically
 * without manipulating real filesystem permissions.
 */
export async function classifyDatabaseDirectory(dir, deps = {}) {
  const access = deps.access ?? ((target) => fs.access(target));
  const readdir = deps.readdir ?? ((target) => fs.readdir(target));

  try {
    await access(dir);
  } catch (error) {
    return error && error.code === 'ENOENT' ? 'absent' : 'unusable';
  }

  try {
    const entries = await readdir(dir);
    const required = ['PG_VERSION', 'base', 'global'];
    return required.every((entry) => entries.includes(entry)) ? 'valid' : 'unusable';
  } catch {
    return 'unusable';
  }
}

/**
 * The only place a destructive or initialising action is chosen. Every branch
 * is named, so `initialise` is reachable from an explicit reset or a positively
 * absent directory and from nothing else -- never from the negation of a
 * boolean that several different situations can produce. An unrecognised state
 * refuses.
 */
export function databaseStartAction(state, reset) {
  if (reset) return 'reset-and-initialise';
  if (state === 'absent') return 'initialise';
  if (state === 'valid') return 'reuse';
  return 'refuse';
}

async function seedSyntheticData(client) {
  const seeded = await client.query(`select to_regclass('pilot.${markerTable}') as table_name`);
  if (seeded.rows[0].table_name) return;
  const org = 'ppbf-offline-demo';
  const accounts = [
    ['offline-owner', 'platform_owner', null], ['offline-admin', 'organization_admin', null],
    ['offline-program-admin', 'admin', null], ['offline-volunteer', 'volunteer', null], ['offline-staff', 'staff', null],
    ['offline-coach', 'coach', null], ['offline-athlete', 'athlete', 'offline-athlete-record'],
    ['offline-parent', 'parent', null],
  ];
  const pinHash = await hashPin('246810');
  await client.query('begin');
  try {
    await client.query('insert into pilot.organizations (organization_id, organization_name, status) values ($1, $2, $3)', [org, 'PPBF Offline Demo', 'active']);
    for (const [accountId, role, athleteId] of accounts) {
      await client.query(
        `insert into pilot.accounts (account_id, login_email, auth_provider, role, organization_id, is_platform_owner, athlete_id, pin_hash, active_flag, has_master_shadow_access)
         values ($1, $2, 'ppbf_local', $3, $4, $5, $6, $7, true, $8)`,
        [accountId, `${accountId}@offline.invalid`, role, org, role === 'platform_owner', athleteId, pinHash, role === 'platform_owner'],
      );
      await client.query('insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, $3, true)', [accountId, org, role]);
    }
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, 'offline-athlete-record', 'Demo Athlete', '2011-06-15', 'demo', 'active', 'Synthetic emergency contact — do not use', true, 'offline-coach', now(), now())`, [org],
    );
    await client.query(`insert into pilot.goals (organization_id, goal_id, athlete_id, title, target_date, metric, status, created_at, updated_at)
      values ($1, 'offline-goal-1', 'offline-athlete-record', 'Complete synthetic demo check-in', current_date + 30, 'participation', 'active', now(), now())`, [org]);
    await client.query(`insert into pilot.sessions (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes, completed_flag, created_at, updated_at)
      values ($1, 'offline-session-1', 'offline-athlete-record', current_date, 5, 'athlete_post_session_self_report', 'Synthetic local-only training record.', true, now(), now())`, [org]);
    await client.query(`create table pilot.${markerTable} (created_at timestamptz not null default now(), seed_fingerprint text not null)`);
    await client.query(`insert into pilot.${markerTable} (seed_fingerprint) values ($1)`, [createHash('sha256').update('ppbf-offline-synthetic-v1').digest('hex')]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

async function prepareDatabase(connectionString) {
  const client = new Client({ connectionString, ssl: false });
  await client.connect();
  try {
    const marker = await client.query(`select to_regclass('pilot.${markerTable}') as table_name`);
    const pilotSchema = await client.query(`select to_regnamespace('pilot') as schema_name`);
    const historyExists = await hasMigrationHistory(client);

    if (!historyExists) {
      if (marker.rows[0].table_name) {
        if (process.env.PPBF_OFFLINE_ALLOW_LEGACY_BASELINE !== 'true') {
          throw new Error(
            'Existing PPBF offline database predates migration history. ' +
            'Set PPBF_OFFLINE_ALLOW_LEGACY_BASELINE=true for one verified local startup to adopt the current migration set without reset.',
          );
        }

        const baseline = await baselineMigrationHistory(client);
        console.log(`Offline legacy schema baseline recorded: ${baseline.recorded} migrations.`);
      } else {
        if (pilotSchema.rows[0].schema_name) {
          throw new Error(
            'Offline database has a partial pilot schema but no runtime marker or migration history; refusing implicit replay.',
          );
        }

        const { applyFullSchema } = await import(pathToFileURL(path.join(scriptDir, 'lib', 'full-schema.mjs')).href);
        const result = await applyFullSchema(client);
        console.log(`Offline schema ready: ${result.order.length} migrations in ${result.rounds} rounds.`);

        const baseline = await baselineMigrationHistory(client);
        console.log(`Offline schema baseline recorded: ${baseline.recorded} migrations.`);
      }
    } else {
      const evolution = await applyPendingMigrations(client);
      console.log(`Offline schema reconciled: ${evolution.applied.length} new migration(s) in ${evolution.rounds} round(s).`);
    }

    await seedSyntheticData(client);
  } finally { await client.end(); }
}

async function startRuntime({ reset, port }) {
  await stopThisCheckoutRuntime();

  if (reset) {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
  await fs.mkdir(runtimeDir, { recursive: true });

  const databaseState = await classifyDatabaseDirectory(databaseDir);
  const databaseAction = databaseStartAction(databaseState, reset);

  if (databaseAction === 'refuse') {
    throw new Error(
      `PPBF offline start stopped without touching the database directory at ${databaseDir}. `
      + 'It could not be verified as a reusable embedded PostgreSQL cluster, so PPBF did not '
      + 'delete or reinitialize it and your data is preserved exactly as it was. Being unable '
      + 'to verify it is not the same as finding it damaged. Ordinary start never replaces an '
      + 'existing database. If you intend to discard this checkout\'s offline data and build a '
      + 'new cluster, rerun with --reset, which deletes this checkout\'s .ppbf-offline/ '
      + 'directory.',
    );
  }

  await removeStaleLockFileIfNeeded(databaseDir);

  const databasePort = await findPort();
  const postgres = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password: 'postgres',
    port: databasePort,
    persistent: true,
    // Windows otherwise inherits CP-1252; repository migrations are UTF-8.
    initdbFlags: ['--encoding=UTF8'],
  });

  if (databaseAction === 'reset-and-initialise' || databaseAction === 'initialise') {
    await postgres.initialise();
  }

  await postgres.start();
  const connectionString = `postgres://postgres:postgres@127.0.0.1:${databasePort}/postgres`;
  await prepareDatabase(connectionString);
  const nextBin = path.join(repoDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  // Next rewrites these project files when it generates route types for a
  // custom distDir. Restore their exact pre-launch bytes when the offline
  // server stops, so the local launcher leaves no source configuration drift.
  const generatedFileSnapshots = await Promise.all(generatedProjectFiles.map(async (file) => [file, await fs.readFile(file)]));
  const restoreGeneratedProjectFiles = async () => {
    await Promise.all(generatedFileSnapshots.map(async ([file, contents]) => fs.writeFile(file, contents)));
  };
  const child = spawn(process.execPath, [nextBin, 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: workspaceDir, stdio: 'inherit',
    env: {
      ...buildOfflineChildEnv(process.env), NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', PPBF_OFFLINE_RUNTIME: 'true', PPBF_PILOT_DEFAULT_ORG_ID: 'ppbf-offline-demo',
      NODE_OPTIONS: `--require=${path.join(scriptDir, 'offline-network-guard.cjs')}`.trim(),
      AZURE_POSTGRES_CONNECTION_STRING: connectionString, AZURE_STORAGE_CONNECTION_STRING: '', AZURE_AI_ENDPOINT: '', AZURE_AI_KEY: '',
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', MICROSOFT_CLIENT_ID: '', MICROSOFT_CLIENT_SECRET: '',
      PAYMENT_CONNECT_CLIENT_ID: '', PAYMENT_PLATFORM_SECRET_KEY: '', PAYMENT_PLATFORM_WEBHOOK_SECRET: '',
    },
  });
  const postgresPid = await readPostmasterPid(databaseDir);
  await writeRuntimeState(stateFile, createRuntimeState({
    repoDir,
    appPort: port,
    databasePort,
    launcherPid: process.pid,
    nextPid: child.pid,
    postgresPid,
  }));
  const shutdown = async (signal) => {
    child.kill(signal);
    await postgres.stop().catch(() => {});
    await restoreGeneratedProjectFiles();
    await removeRuntimeState(stateFile);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  child.once('exit', async (code) => {
    await postgres.stop().catch(() => {});
    await restoreGeneratedProjectFiles();
    await removeRuntimeState(stateFile);
    process.exit(code ?? 0);
  });
  console.log(`PPBF offline replica: http://127.0.0.1:${port}`);
  console.log(`Checkout: ${repoDir}`);
  console.log('Synthetic accounts: offline-owner, offline-admin, offline-program-admin, offline-coach, offline-athlete, offline-parent, offline-volunteer, offline-staff');
  console.log('Shared synthetic PIN: 246810');
}

async function main() {
  const options = parseRuntimeArgs(process.argv.slice(2));
  if (options.command === 'help') {
    console.log(HELP_TEXT);
    return;
  }
  if (options.command === 'status') {
    await printStatus();
    return;
  }
  if (options.command === 'stop') {
    await stopThisCheckoutRuntime();
    console.log(`PPBF offline runtime stopped for ${repoDir}`);
    return;
  }
  if (options.command === 'restart') {
    await startRuntime({ reset: options.reset, port: options.port });
    return;
  }
  await startRuntime({ reset: options.reset, port: options.port });
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    console.error('Unable to start the PPBF offline replica.', error);
    process.exit(1);
  });
}

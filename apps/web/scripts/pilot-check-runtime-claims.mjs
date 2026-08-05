import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Read-only verification of claims this platform makes about itself that
 * nobody has checked against a real database.
 *
 * The 2026-08-01 audit and the fix list both carry items whose truth depends on
 * what a deployed environment actually contains, and both label them as
 * derived-from-source rather than observed. The house rule is blunt about why
 * that matters: merged is not working. This repo has shipped a chat tier whose
 * every request failed, a job system that 400'd on every call, and a migration
 * that was never parseable -- all green in CI.
 *
 * So this asks the database three questions that reading code cannot answer.
 *
 * 1. IS THE SHADOW RUNTIME MIGRATION ACTUALLY APPLIED? evidence_tier and
 *    handoff were added to pilot.shadow_chat_messages. The audit confirmed this
 *    "via workflow run history, not by inspecting the schema" -- which proves a
 *    workflow reported success, not that the columns exist.
 *
 * 2. DOES THE RESTORE FALLBACK MATTER IN PRACTICE? The client falls back to
 *    RESEARCH_NEEDED for rows predating those columns. That path is only real
 *    if such rows exist. If production holds none, the fallback has never run
 *    and "it restores correctly" is untested rather than true -- and the honest
 *    report is that the risk is theoretical, not that it is handled.
 *
 * 3. IS THE DURABLE RATE LIMITER ACTUALLY DURABLE? pilot.auth_rate_limit_buckets
 *    stopped being created by an unauthenticated login request last night and
 *    became a migration. If the table is absent, every limiter call is silently
 *    falling back to the in-memory limiter -- which is the designed failure mode
 *    and NOT an error anyone would see, so nothing would report it.
 *
 * Every statement is a SELECT inside an explicit READ ONLY transaction, so
 * Postgres itself refuses any write this file could attempt. It counts rows and
 * reads column metadata; it never reads the content of a message.
 */

async function loadEnvLocal() {
  const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.local');

  let contents;
  try {
    contents = await fs.readFile(envPath, 'utf8');
  } catch {
    return; // No .env.local (CI, or a container). The env var must be set.
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;

    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(
      `Missing required environment variable: ${name}. `
      + 'Set it in apps/web/.env.local, or export it before running this script.',
    );
  }
  return value;
}

function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

export async function checkRuntimeClaims(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const database = (await client.query('select current_database() as db')).rows[0].db;

    const shadowColumns = await client.query(
      `select column_name, is_nullable, data_type
         from information_schema.columns
        where table_schema = 'pilot'
          and table_name = 'shadow_chat_messages'
          and column_name in ('evidence_tier', 'handoff', 'topic', 'session_type')
        order by column_name`,
    );

    const messagesPresent = (
      await client.query("select to_regclass('pilot.shadow_chat_messages') is not null as present")
    ).rows[0].present;

    // Rows predating the migration are exactly the ones the client's
    // RESEARCH_NEEDED fallback exists for. Counting them says whether that path
    // is live or merely written.
    const preMigrationRows = messagesPresent
      ? (
        await client.query(
          `select count(*)::int as total,
                  count(*) filter (where evidence_tier is null)::int as null_tier
             from pilot.shadow_chat_messages`,
        )
      ).rows[0]
      : { total: 0, null_tier: 0 };

    const rateLimitPresent = (
      await client.query("select to_regclass('pilot.auth_rate_limit_buckets') is not null as present")
    ).rows[0].present;

    const rateLimitState = rateLimitPresent
      ? (
        await client.query(
          `select count(*)::int as buckets,
                  count(*) filter (where blocked_until > now())::int as active_blocks
             from pilot.auth_rate_limit_buckets`,
        )
      ).rows[0]
      : { buckets: 0, active_blocks: 0 };

    const rateLimitKey = rateLimitPresent
      ? (
        await client.query(
          `select pg_get_constraintdef(oid) as def
             from pg_constraint
            where conrelid = to_regclass('pilot.auth_rate_limit_buckets')
              and contype = 'p'`,
        )
      ).rows[0]
      : null;

    await client.query('COMMIT');
    return {
      database,
      shadowColumns: shadowColumns.rows,
      messagesPresent,
      preMigrationRows,
      rateLimitPresent,
      rateLimitState,
      rateLimitKey: rateLimitKey?.def ?? null,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function run() {
  await loadEnvLocal();
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  const client = new Client({ connectionString, ssl: resolveSslConfig() });
  await client.connect();
  let report;
  try {
    report = await checkRuntimeClaims(client);
  } finally {
    await client.end();
  }

  const {
    database, shadowColumns, messagesPresent, preMigrationRows,
    rateLimitPresent, rateLimitState, rateLimitKey,
  } = report;

  console.log('Runtime claim check');
  console.log('===================================================================');
  console.log(`database: ${database}`);
  console.log('');

  console.log('1. SHADOW runtime migration');
  if (!messagesPresent) {
    console.log('   pilot.shadow_chat_messages: ABSENT');
  } else {
    const names = shadowColumns.map((row) => row.column_name);
    for (const wanted of ['evidence_tier', 'handoff', 'topic', 'session_type']) {
      const found = shadowColumns.find((row) => row.column_name === wanted);
      console.log(`   ${wanted}: ${found ? `present (${found.data_type}, nullable=${found.is_nullable})` : 'MISSING'}`);
    }
    console.log(`   columns found: ${names.length}/4`);
  }
  console.log('');

  console.log('2. Restore fallback (RESEARCH_NEEDED for rows predating the migration)');
  console.log(`   messages total: ${preMigrationRows.total}`);
  console.log(`   with no evidence_tier: ${preMigrationRows.null_tier}`);
  if (preMigrationRows.total === 0) {
    console.log('   -> No messages at all. The fallback has never run and cannot be');
    console.log('      confirmed here. Not a fault; an untested path.');
  } else if (preMigrationRows.null_tier === 0) {
    console.log('   -> Every message carries a tier. The fallback is unexercised in');
    console.log('      this database, so "it restores correctly" remains untested.');
  } else {
    console.log('   -> Rows predating the migration EXIST, so the fallback is live and');
    console.log('      a conversation reload genuinely depends on it.');
  }
  console.log('');

  console.log('3. Durable rate limiter');
  if (!rateLimitPresent) {
    console.log('   pilot.auth_rate_limit_buckets: ABSENT');
    console.log('   -> Every limiter call is silently falling back to in-memory. That is');
    console.log('      the designed failure mode and raises no error, so nothing else');
    console.log('      would report it. Apply the rate-limit migration.');
  } else {
    console.log(`   table present, primary key: ${rateLimitKey ?? '(none)'}`);
    console.log(`   buckets: ${rateLimitState.buckets}, currently blocking: ${rateLimitState.active_blocks}`);
    if (rateLimitState.buckets === 0) {
      console.log('   -> Table exists and is empty. Correct after a fresh migration, and');
      console.log('      it means no failed sign-in has been recorded durably yet.');
    } else {
      console.log('   -> Rows exist, so the durable path is genuinely in use rather than');
      console.log('      silently degrading to memory.');
    }
  }
  console.log('===================================================================');

  return report;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('RUNTIME CLAIM CHECK FAILED TO RUN');
    console.error(String(error));
    process.exit(1);
  }
}

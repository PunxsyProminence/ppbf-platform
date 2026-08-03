import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

/**
 * Read-only report on how often SHADOW withholds an answer, and on whether the
 * Heavy Bag cap is being reached.
 *
 * Why this exists: three separate over-filters were found in
 * validateShadowResponse on 2026-08-01/02, by three unrelated routes -- a
 * staging gate stumbling into one (#168), a deliberate corpus sweep (#169), and
 * reproducing a gate failure from source (#174). Three independent discoveries
 * in two days does not mean three bugs are gone. It means the real rate was
 * never measured.
 *
 * The failure mode is the one nobody reports. A coach who asks a reasonable
 * question and gets "I can't safely provide that generated answer" does not file
 * a bug. They conclude the tool is not useful and stop opening it, and that
 * shows up in no queue anywhere. An over-filter is invisible by construction,
 * which is exactly why it needs a number rather than an anecdote.
 *
 * The #174 evidence for why it matters: the gate run that passed after the fix
 * came back with 4 citations at PROVEN, where the last passing run before it
 * managed 0 citations at EXPERIMENTAL. The filter was not withholding random
 * answers -- it was preferentially killing the well-evidenced ones, because a
 * thorough answer is the one that states intervals and names injury risks.
 *
 * Every statement is a SELECT inside an explicit READ ONLY transaction, so
 * Postgres itself refuses any write this file could attempt. Safe against
 * production by construction, not by intent.
 */

/**
 * Filtered rate above this is reported as needing a human, via exit code.
 *
 * Not zero, deliberately. Some filtering is the validator working: a genuinely
 * unsafe generation SHOULD be withheld, and a report that cried wolf on a single
 * correct refusal would be ignored within a week. But unsafe generations should
 * be rare against a prompt that is doing its job, so a sustained rate above this
 * means one of two things is wrong -- the model is producing unsafe content
 * often (a prompt problem) or the validator is over-firing (the problem this
 * script was written for). Both need a person.
 */
const FILTER_RATE_ATTENTION_THRESHOLD = 0.01;

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

function rate(filtered, total) {
  if (!total) return null;
  return filtered / total;
}

function formatRate(value) {
  if (value === null) return '     -';
  return `${(value * 100).toFixed(2).padStart(5)}%`;
}

export async function checkShadowFilterRate(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const database = (await client.query('select current_database() as db')).rows[0].db;

    // Assistant messages only. A user message has no response_state, and
    // counting it would dilute the denominator with turns the validator never
    // looked at.
    const overall = await client.query(
      `select
         count(*)::int as total,
         count(*) filter (where response_state = 'filtered')::int as filtered,
         count(*) filter (where response_state is null)::int as unrecorded,
         min(created_at)::date::text as first_day,
         max(created_at)::date::text as last_day
       from pilot.shadow_chat_messages
       where role = 'assistant'`,
    );

    const windows = [];
    for (const days of [7, 30]) {
      const result = await client.query(
        `select
           count(*)::int as total,
           count(*) filter (where response_state = 'filtered')::int as filtered
         from pilot.shadow_chat_messages
         where role = 'assistant'
           and created_at >= now() - ($1::int * interval '1 day')`,
        [days],
      );
      windows.push({ days, ...result.rows[0] });
    }

    // By tier. Heavy Bag is the expensive path and the one #174's over-filters
    // hit hardest, so a split that hides it inside an average is no use.
    const bySessionType = await client.query(
      `select
         session_type,
         count(*)::int as total,
         count(*) filter (where response_state = 'filtered')::int as filtered
       from pilot.shadow_chat_messages
       where role = 'assistant'
         and created_at >= now() - interval '30 days'
       group by session_type
       order by count(*) filter (where response_state = 'filtered') desc, session_type`,
    );

    // By topic. A filter concentrated in one topic is a different problem from
    // one spread evenly: concentrated means a rule is mis-scoped to that
    // subject matter, spread means the validator is broadly too tight.
    const byTopic = await client.query(
      `select
         topic,
         count(*)::int as total,
         count(*) filter (where response_state = 'filtered')::int as filtered
       from pilot.shadow_chat_messages
       where role = 'assistant'
         and created_at >= now() - interval '30 days'
       group by topic
       having count(*) filter (where response_state = 'filtered') > 0
       order by count(*) filter (where response_state = 'filtered') desc
       limit 15`,
    );

    // Daily trend. A fix landing should show as a step change, not a slope --
    // that is how you tell a real improvement from ordinary variance.
    const byDay = await client.query(
      `select
         created_at::date::text as day,
         count(*)::int as total,
         count(*) filter (where response_state = 'filtered')::int as filtered
       from pilot.shadow_chat_messages
       where role = 'assistant'
         and created_at >= now() - interval '14 days'
       group by created_at::date
       order by created_at::date desc`,
    );

    // Who is being turned away. shadow_chat_messages has no role, but the audit
    // trail does, and a filter that lands mostly on coaches is a different
    // product problem from one that lands on administrators testing it.
    const byRole = await client.query(
      `select
         user_role,
         count(*)::int as total,
         count(*) filter (where was_filtered)::int as filtered
       from pilot.shadow_chat_audit
       where created_at >= now() - interval '30 days'
       group by user_role
       order by count(*) filter (where was_filtered) desc, user_role`,
    );

    // Rate limits. request_count is the running total within a window, so a
    // window whose count reached the cap is one where someone was refused.
    const buckets = await client.query(
      `select
         endpoint_key,
         count(*)::int as windows,
         max(request_count)::int as max_count,
         min(window_started_at)::date::text as oldest_window,
         max(window_started_at)::date::text as newest_window
       from pilot.shadow_rate_limit_buckets
       group by endpoint_key
       order by endpoint_key`,
    );

    // Named separately because it is the one cap shipped on 2026-08-01 by owner
    // decision, and the only one nobody has seen under real load.
    const heavyBagAtCap = await client.query(
      `select
         count(*)::int as windows_at_cap,
         count(distinct account_id)::int as accounts_affected
       from pilot.shadow_rate_limit_buckets
       where endpoint_key = 'heavy_bag'
         and request_count >= 10`,
    );

    await client.query('COMMIT');

    return {
      database,
      overall: overall.rows[0],
      windows,
      bySessionType: bySessionType.rows,
      byTopic: byTopic.rows,
      byDay: byDay.rows,
      byRole: byRole.rows,
      buckets: buckets.rows,
      heavyBagAtCap: heavyBagAtCap.rows[0],
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function report(result) {
  const lines = [];
  const push = (line = '') => lines.push(line);

  push(`SHADOW filter-rate report -- database: ${result.database}`);
  push();

  const { overall } = result;
  push('=== Withheld answers (assistant messages) ===');
  if (!overall.total) {
    push('  No assistant messages recorded. Nothing to measure yet.');
  } else {
    push(`  All time     ${String(overall.filtered).padStart(7)} filtered of ${String(overall.total).padStart(7)}   ${formatRate(rate(overall.filtered, overall.total))}`);
    for (const window of result.windows) {
      push(`  Last ${String(window.days).padStart(2)} days ${String(window.filtered).padStart(7)} filtered of ${String(window.total).padStart(7)}   ${formatRate(rate(window.filtered, window.total))}`);
    }
    push(`  Span: ${overall.first_day} to ${overall.last_day}`);
    if (overall.unrecorded > 0) {
      // Pre-dates the column, or a path that never set it. Called out because it
      // is denominator that cannot be classified either way.
      push(`  ${overall.unrecorded} message(s) carry no response_state and are excluded from every rate above.`);
    }
  }

  const section = (title, rows, labelKey) => {
    push();
    push(`=== ${title} ===`);
    if (!rows.length) {
      push('  (none)');
      return;
    }
    for (const row of rows) {
      const label = String(row[labelKey] ?? '(null)').padEnd(18);
      push(`  ${label} ${String(row.filtered).padStart(6)} of ${String(row.total).padStart(7)}   ${formatRate(rate(row.filtered, row.total))}`);
    }
  };

  section('By tier, last 30 days', result.bySessionType, 'session_type');
  section('By topic, last 30 days (filtered only)', result.byTopic, 'topic');
  section('By role, last 30 days (from the audit trail)', result.byRole, 'user_role');
  section('By day, last 14 days', result.byDay, 'day');

  push();
  push('=== Rate limit buckets ===');
  if (!result.buckets.length) {
    push('  (no buckets -- nothing has been rate limited recently)');
  } else {
    for (const bucket of result.buckets) {
      push(`  ${String(bucket.endpoint_key).padEnd(18)} ${String(bucket.windows).padStart(5)} window(s), peak ${String(bucket.max_count).padStart(5)}   ${bucket.oldest_window} to ${bucket.newest_window}`);
    }
  }
  push(`  Heavy Bag windows that reached the cap of 10: ${result.heavyBagAtCap.windows_at_cap}`
    + ` (across ${result.heavyBagAtCap.accounts_affected} account(s))`);

  push();
  push('=== What this report cannot tell you ===');
  // Stated rather than left for the reader to discover, because both limits
  // change how the numbers above should be read.
  push('  * WHICH validator rule fired. No table stores the filter reasons --');
  push('    not shadow_chat_messages, not shadow_chat_audit, and the chat route');
  push('    emits no telemetry on the filter path. Reasons exist only in');
  push('    application logs. If this report shows a rate worth chasing, the');
  push('    cheapest next step is persisting the reason alongside');
  push('    response_state, which turns a log dig into a GROUP BY.');
  push('  * Heavy Bag cap history beyond ~2 days. enforceShadowRateLimit purges');
  push('    buckets older than two days, so the cap figures above are a recent');
  push('    window, not a full history. A zero there means "not in the last two');
  push('    days", not "never".');

  return lines.join('\n');
}

export function needsAttention(result) {
  const recent = result.windows.find((window) => window.days === 30);
  const recentRate = recent ? rate(recent.filtered, recent.total) : null;
  const overThreshold = recentRate !== null && recentRate > FILTER_RATE_ATTENTION_THRESHOLD;
  const capReached = result.heavyBagAtCap.windows_at_cap > 0;
  return { overThreshold, capReached, recentRate };
}

async function run() {
  await loadEnvLocal();
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');

  const client = new Client({ connectionString, ssl: resolveSslConfig() });
  await client.connect();

  let result;
  try {
    result = await checkShadowFilterRate(client);
  } finally {
    await client.end();
  }

  console.log(report(result));

  const { overThreshold, capReached, recentRate } = needsAttention(result);
  console.log();
  if (overThreshold) {
    console.log(
      `SHADOW FILTER RATE NEEDS A HUMAN: ${formatRate(recentRate).trim()} of answers withheld over 30 days, `
      + `above the ${(FILTER_RATE_ATTENTION_THRESHOLD * 100).toFixed(0)}% threshold.`,
    );
  }
  if (capReached) {
    console.log('HEAVY BAG CAP REACHED: at least one account hit 10 rounds in an hour. Worth deciding whether 10 is right.');
  }
  if (!overThreshold && !capReached) {
    console.log('SHADOW FILTER RATE CHECK PASS');
  }

  // Non-zero only when a person still has to decide something, matching the
  // other pilot:check-* scripts.
  process.exitCode = overThreshold || capReached ? 1 : 0;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('SHADOW FILTER RATE CHECK FAIL');
    console.error(String(error));
    process.exit(1);
  }
}

#!/usr/bin/env node
/**
 * PPBF Data Seed Script
 * Bulk upload athletes, goals, and sessions data to PostgreSQL
 *
 * Usage:
 *   npm run seed:data:dry                     -- preview, writes nothing
 *   npm run seed:data                         -- requires PPBF_ALLOW_DESTRUCTIVE_SEED=true
 *   npm run seed:data -- --config path/to/seed-data.config.ts
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parse as csvParse } from 'csv-parse/sync';
// Relative, not '@/...'. That alias is declared in apps/web/tsconfig.json and
// this file sits outside that project, so the alias resolved for the editor
// and for nothing else -- `npm run seed:data` died on TS2307 before it read a
// single row. db.ts pulls in only `pg` and a relative './env', so reaching it
// directly costs nothing and needs no root tsconfig to exist.
import { query } from '../apps/web/src/server/pilot/db';
// The guard the six apps/web reference-data loaders already use. Imported
// rather than reimplemented: this repository carries many inline copies of the
// same parse, and postgresWriteTarget.test.ts covers this one.
import { assertDeclaredWriteTargetFromEnv } from '../apps/web/scripts/lib/postgres-write-target.mjs';

interface SeedConfig {
  organizationId: string;
  dataDir: string;
  files: {
    athletes?: string;
    goals?: string;
    sessions?: string;
  };
  options: {
    dryRun?: boolean;
    skipValidation?: boolean;
    batchSize?: number;
    continueOnError?: boolean;
  };
}

interface SeedResult {
  table: string;
  /** Distinct guardian records written, as opposed to athlete links. Only set by insertGuardians. */
  newParents?: number;
  inserted: number;
  skipped: number;
  errors: Array<{ row: number; error: string }>;
}

// ============================================================================
// Loaders
// ============================================================================

async function loadCsvFile(filePath: string) {
  const content = fs.readFileSync(filePath, 'utf-8');
  return csvParse(content, { columns: true, skip_empty_lines: true });
}

async function loadJsonFile(filePath: string) {
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content);
}

async function loadFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv') return loadCsvFile(filePath);
  if (ext === '.json') return loadJsonFile(filePath);
  throw new Error(`Unsupported file format: ${ext}`);
}

// ============================================================================
// Validation
// ============================================================================

// checkCoach is false only when a dry run could not reach a database. See
// resolveCoachCheck below for why that is allowed to happen at all.
/**
 * A real YYYY-MM-DD calendar day, not a regex that admits 2010-13-45.
 *
 * Date.parse would accept "2010" and "Jan 1 2010" and quietly normalise both;
 * this platform stores a calendar day for a minor, and a roster cell that is
 * not one is an operator error to report, never a value to infer. Round-trips
 * through Date so the month/day are checked against the real calendar --
 * 2011-02-29 fails here rather than becoming March 1st in the database.
 */
export function isCalendarDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return false;
  }
  const trimmed = value.trim();
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === trimmed;
}

async function validateAthleteRow(row: any, org: string, checkCoach: boolean): Promise<string[]> {
  const errors: string[] = [];

  if (!row.athlete_id) errors.push('Missing athlete_id');
  if (!row.full_name) errors.push('Missing full_name');
  if (!row.dob) {
    errors.push('Missing dob (format: YYYY-MM-DD)');
  } else if (!isCalendarDate(row.dob)) {
    // The message here has always PROMISED a format and never checked one, so
    // `NOT-A-DATE` validated clean and failed later against the date column --
    // landing in result.errors, one row among many, attributed to Postgres
    // rather than to the cell the operator typed. A date of birth decides
    // which age band a child trains in; keep the failure with its author.
    errors.push(`Invalid dob "${String(row.dob)}" (format: YYYY-MM-DD)`);
  }
  if (!row.weight_class) errors.push('Missing weight_class');
  if (!row.gym_status) errors.push('Missing gym_status');
  if (!row.emergency_contact) errors.push('Missing emergency_contact');
  if (!row.coach_id) errors.push('Missing coach_id');

  // Verify coach exists
  if (checkCoach && row.coach_id && !errors.length) {
    const coachExists = await query(
      `SELECT 1 FROM pilot.accounts WHERE account_id = $1 AND organization_id = $2`,
      [row.coach_id, org]
    );
    // .length, not .rowCount: query() returns result.rows, so this was reading
    // an undefined property on an array. `undefined === 0` is false, so the
    // check never once fired and a roster naming a coach who does not exist
    // validated clean and got inserted.
    if (coachExists.length === 0) {
      errors.push(`Coach not found: ${row.coach_id}`);
    }
  }

  return errors;
}

async function validateGoalRow(row: any, org: string, athleteIds: Set<string>): Promise<string[]> {
  const errors: string[] = [];

  if (!row.goal_id) errors.push('Missing goal_id');
  if (!row.athlete_id) errors.push('Missing athlete_id');
  if (!row.title) errors.push('Missing title');
  if (!row.target_date) errors.push('Missing target_date (format: YYYY-MM-DD)');
  if (!row.metric) errors.push('Missing metric');
  if (!row.status) errors.push('Missing status');

  // Verify athlete exists
  if (row.athlete_id && !athleteIds.has(row.athlete_id)) {
    errors.push(`Athlete not found: ${row.athlete_id}`);
  }

  return errors;
}

async function validateSessionRow(row: any, org: string, athleteIds: Set<string>): Promise<string[]> {
  const errors: string[] = [];

  if (!row.session_id) errors.push('Missing session_id');
  if (!row.athlete_id) errors.push('Missing athlete_id');
  if (!row.date) errors.push('Missing date (format: YYYY-MM-DD)');
  if (row.rpe === undefined || row.rpe === '') errors.push('Missing rpe (0-10)');
  if (!row.notes && row.notes !== '') errors.push('Missing notes');

  // Verify athlete exists
  if (row.athlete_id && !athleteIds.has(row.athlete_id)) {
    errors.push(`Athlete not found: ${row.athlete_id}`);
  }

  return errors;
}

// ============================================================================
// Inserters
// ============================================================================

async function insertAthletes(
  rows: any[],
  org: string,
  dryRun: boolean,
  checkCoach: boolean
): Promise<{ result: SeedResult; athleteIds: Set<string> }> {
  const result: SeedResult = { table: 'athletes', inserted: 0, skipped: 0, errors: [] };
  const athleteIds = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const errors = await validateAthleteRow(row, org, checkCoach);

    if (errors.length > 0) {
      result.errors.push({ row: i + 1, error: errors.join('; ') });
      result.skipped++;
      continue;
    }

    if (!dryRun) {
      try {
        await query(
          `INSERT INTO pilot.athletes (
            organization_id, athlete_id, full_name, dob, weight_class, gym_status,
            emergency_contact, active_flag, coach_id, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
          ON CONFLICT (organization_id, athlete_id) DO UPDATE SET
            full_name = excluded.full_name,
            dob = excluded.dob,
            weight_class = excluded.weight_class,
            gym_status = excluded.gym_status,
            emergency_contact = excluded.emergency_contact,
            coach_id = excluded.coach_id,
            updated_at = NOW()`,
          [
            org,
            row.athlete_id,
            row.full_name,
            row.dob,
            row.weight_class,
            row.gym_status,
            row.emergency_contact,
            row.active_flag !== 'false' && row.active_flag !== '0',
            row.coach_id,
          ]
        );
      } catch (err) {
        result.errors.push({ row: i + 1, error: (err as Error).message });
        result.skipped++;
        continue;
      }
    }

    athleteIds.add(row.athlete_id);
    result.inserted++;
  }

  return { result, athleteIds };
}

/**
 * Guardian records from the athlete rows, when they carry guardian columns.
 *
 * WHY THIS WRITES NO ACCOUNT AND NO PIN. pilot.parents.account_id is nullable on purpose -- a
 * guardian can be RECORDED before they have a login, which is how intake already works. So this
 * populates who the guardian is and which child they are responsible for, and stops there. It
 * deliberately does not create accounts: pinPolicy.ts states that an account should be created
 * when you are with the athlete, "not in a batch the week before", because the window between
 * account creation and first sign-in is the exposure. Creating 40 logins here would widen exactly
 * that window 40-fold. Inviting a guardian stays a per-family action through staffProvisioning,
 * which attaches account_id to the row this writes.
 *
 * ONE PARENT ROW PER GUARDIAN, NOT PER CHILD. Siblings share a guardian, so rows are deduplicated
 * within the run: by email when present, otherwise by name+phone. Without this, a family with two
 * athletes in the gym becomes two guardian records that later diverge, and no read path can tell
 * which one is current.
 *
 * The guardian columns are OPTIONAL. A roster file predating them imports exactly as before and
 * reports zero guardians rather than failing -- the gym's existing files must not break.
 */
async function insertGuardians(
  rows: any[],
  org: string,
  dryRun: boolean,
  athleteIds: Set<string>
): Promise<SeedResult> {
  const result: SeedResult = { table: 'guardians', inserted: 0, skipped: 0, errors: [] };

  // parent_id per deduplication key, so the second sibling links to the first's parent row.
  const parentIdByKey = new Map<string, string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = (row.guardian_full_name ?? '').trim();
    const email = (row.guardian_email ?? '').trim().toLowerCase();
    const phone = (row.guardian_phone ?? '').trim();
    const relationship = (row.guardian_relationship ?? '').trim();

    // No guardian columns at all: not an error, just nothing to do for this athlete.
    if (!name && !email && !phone && !relationship) continue;

    if (!name) {
      result.errors.push({
        row: i + 1,
        error: "guardian_full_name is required when any guardian column is present -- the guardian's own name is what pilot.parents records",
      });
      result.skipped++;
      continue;
    }
    if (!relationship) {
      // guardian_links.relationship_to_athlete is NOT NULL, and guessing "parent" would put an
      // invented family relationship on a minor's record.
      result.errors.push({
        row: i + 1,
        error: 'guardian_relationship is required when a guardian is named (relationship_to_athlete is not nullable and must not be guessed)',
      });
      result.skipped++;
      continue;
    }
    if (!athleteIds.has(row.athlete_id)) {
      // The athlete row failed validation or was skipped, so a link would dangle.
      result.errors.push({
        row: i + 1,
        error: `guardian named for athlete ${row.athlete_id}, which was not imported`,
      });
      result.skipped++;
      continue;
    }

    // A guardian identified only by name cannot be deduplicated. Two different people who share a
    // name would collapse into one parent row and every one of their children would be linked to
    // the same adult -- a wrong statement about who is responsible for a minor, and not one any
    // later screen could detect. Refusing is the only correct answer; there is nothing to infer.
    if (!email && !phone) {
      result.errors.push({
        row: i + 1,
        error: 'guardian_email or guardian_phone is required -- a guardian identified only by name cannot be told apart from another of the same name, and merging two families is not recoverable',
      });
      result.skipped++;
      continue;
    }

    const dedupeKey = email ? `email:${email}` : `name:${name.toLowerCase()}|phone:${phone}`;
    let parentId = parentIdByKey.get(dedupeKey);
    const isNewParent = parentId === undefined;
    if (parentId === undefined) {
      // HASH THE WHOLE KEY, never a prefix of it. This previously base64'd the key and truncated to
      // 24 characters -- which encodes only the first 18 BYTES -- so two addresses sharing a long
      // prefix produced the SAME parent_id, and the second guardian silently overwrote the first,
      // taking their children with them. The example roster in this repo triggered it exactly:
      // example.guardian1@example.invalid and example.guardian2@example.invalid diverge at byte 22,
      // past the cut, and the summary still reported two distinct guardians. A digest of the
      // complete key cannot lose a distinguishing character wherever in the string it falls.
      parentId = `par_${org}_${createHash('sha256').update(dedupeKey).digest('hex').slice(0, 24)}`;
      parentIdByKey.set(dedupeKey, parentId);
    }

    if (!dryRun) {
      try {
        // account_id is left alone entirely -- omitted on insert, untouched on conflict -- so
        // re-running this can never detach a guardian who has since been invited.
        await query(
          `INSERT INTO pilot.parents (
            organization_id, parent_id, full_name, phone, email, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
          ON CONFLICT (organization_id, parent_id) DO UPDATE SET
            full_name = excluded.full_name,
            phone = excluded.phone,
            email = excluded.email,
            updated_at = NOW()`,
          [org, parentId, name, phone || null, email || null]
        );
        await query(
          `INSERT INTO pilot.guardian_links (
            organization_id, parent_id, athlete_id, relationship_to_athlete, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, NOW(), NOW())
          ON CONFLICT (organization_id, parent_id, athlete_id) DO UPDATE SET
            relationship_to_athlete = excluded.relationship_to_athlete,
            updated_at = NOW()`,
          [org, parentId, row.athlete_id, relationship]
        );
      } catch (err) {
        result.errors.push({ row: i + 1, error: (err as Error).message });
        result.skipped++;
        continue;
      }
    }

    // Counts links, not parents: two siblings sharing a guardian is two links and one parent row,
    // and reporting one would understate what was written.
    result.inserted++;
    if (isNewParent) result.newParents = (result.newParents ?? 0) + 1;
  }

  return result;
}

async function insertGoals(
  rows: any[],
  org: string,
  athleteIds: Set<string>,
  dryRun: boolean
): Promise<SeedResult> {
  const result: SeedResult = { table: 'goals', inserted: 0, skipped: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const errors = await validateGoalRow(row, org, athleteIds);

    if (errors.length > 0) {
      result.errors.push({ row: i + 1, error: errors.join('; ') });
      result.skipped++;
      continue;
    }

    if (!dryRun) {
      try {
        await query(
          `INSERT INTO pilot.goals (
            organization_id, goal_id, athlete_id, title, target_date, metric, status, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
          ON CONFLICT (organization_id, goal_id) DO UPDATE SET
            title = excluded.title,
            target_date = excluded.target_date,
            metric = excluded.metric,
            status = excluded.status,
            updated_at = NOW()`,
          [org, row.goal_id, row.athlete_id, row.title, row.target_date, row.metric, row.status]
        );
      } catch (err) {
        result.errors.push({ row: i + 1, error: (err as Error).message });
        result.skipped++;
        continue;
      }
    }

    result.inserted++;
  }

  return result;
}

async function insertSessions(
  rows: any[],
  org: string,
  athleteIds: Set<string>,
  dryRun: boolean
): Promise<SeedResult> {
  const result: SeedResult = { table: 'sessions', inserted: 0, skipped: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const errors = await validateSessionRow(row, org, athleteIds);

    if (errors.length > 0) {
      result.errors.push({ row: i + 1, error: errors.join('; ') });
      result.skipped++;
      continue;
    }

    if (!dryRun) {
      try {
        await query(
          `INSERT INTO pilot.sessions (
            organization_id, session_id, athlete_id, date, rpe, notes, completed_flag, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
          ON CONFLICT (organization_id, session_id) DO UPDATE SET
            rpe = excluded.rpe,
            notes = excluded.notes,
            completed_flag = excluded.completed_flag,
            updated_at = NOW()`,
          [
            org,
            row.session_id,
            row.athlete_id,
            row.date,
            parseFloat(row.rpe),
            row.notes,
            row.completed_flag !== 'false' && row.completed_flag !== '0',
          ]
        );
      } catch (err) {
        result.errors.push({ row: i + 1, error: (err as Error).message });
        result.skipped++;
        continue;
      }
    }

    result.inserted++;
  }

  return result;
}

// ============================================================================
// Main Seed Function
// ============================================================================

// Unlike roster import (insertAthleteIfAbsent, ON CONFLICT DO NOTHING), every
// insert below is ON CONFLICT DO UPDATE -- pointed at a populated database,
// this silently replaces a real athlete's name, dob, weight class, coach, and
// goal/session history with whatever is in the seed file. --dry-run makes no
// writes and is always allowed; anything else needs an explicit opt-in so a
// config pointed at a live organization id can't be run by habit. The CLI
// section below checks this BEFORE the config file is even imported, so the
// refusal happens before any INSERT/UPDATE could run; this copy stays here too
// so a future programmatic caller of seedData() gets the same guard rather
// than none.
function destructiveSeedAllowed(dryRun: boolean, cliOverride = false): boolean {
  return (
    dryRun
    || cliOverride
    || process.env.PPBF_ALLOW_DESTRUCTIVE_SEED === 'true'
    || process.env.NODE_ENV === 'test'
  );
}

function assertDestructiveSeedAllowed(dryRun: boolean): void {
  if (destructiveSeedAllowed(dryRun)) {
    return;
  }
  throw new Error(
    'Refusing to run: this script overwrites existing athletes, goals, and sessions on conflict '
    + '(roster import never does). Set PPBF_ALLOW_DESTRUCTIVE_SEED=true to confirm you want that '
    + 'against this database, or pass --dry-run to preview without writing.',
  );
}

// Refuses a real seed against a database nobody named.
//
// WHY THIS SCRIPT NEEDED IT AND DID NOT HAVE IT
//
// Every loader under apps/web/scripts asserts its write target before writing
// a row -- postgres-write-target.mjs records why: a run from a laptop or agent
// shell holding a production connection string put 361 orphaned rows into
// production, and nothing objected because the script had no notion of an
// intended target. This script had no such assertion at all. It is also the
// one that writes pilot.athletes, pilot.parents and pilot.guardian_links --
// children's records -- so it was the seeder with the most to lose and the
// least protection.
//
// DRY RUN IS EXEMPT, deliberately, and for the reason resolveCoachCheck below
// already records: a dry run writes nothing, and requiring a live connection
// string made --dry-run unusable on the laptop most likely to want a preview.
// A guard on a path that cannot write buys nothing and costs the preview.
//
// The refusal never echoes the connection string: it carries credentials, and
// the shared guard throws bare machine tokens for exactly that reason. These
// translate each token into what the operator should do about it.
const TARGET_REFUSALS: Record<string, string> = {
  MISSING_PPBF_EXPECTED_POSTGRES_HOSTNAME:
    'Refusing to run: PPBF_EXPECTED_POSTGRES_HOSTNAME is not set, so this script cannot tell '
    + 'which database it is about to write children\'s records into. Set it and '
    + 'PPBF_EXPECTED_POSTGRES_DATABASE to the target you intend, or pass --dry-run.',
  MISSING_PPBF_EXPECTED_POSTGRES_DATABASE:
    'Refusing to run: PPBF_EXPECTED_POSTGRES_DATABASE is not set, so this script cannot tell '
    + 'which database it is about to write children\'s records into. Set it and '
    + 'PPBF_EXPECTED_POSTGRES_HOSTNAME to the target you intend, or pass --dry-run.',
  POSTGRES_TARGET_MISMATCH:
    'Refusing to run: AZURE_POSTGRES_CONNECTION_STRING points at a different host or database '
    + 'than PPBF_EXPECTED_POSTGRES_HOSTNAME / PPBF_EXPECTED_POSTGRES_DATABASE declare. One of '
    + 'the two is wrong; this script will not guess which.',
  INVALID_POSTGRES_CONNECTION_STRING:
    'Refusing to run: AZURE_POSTGRES_CONNECTION_STRING is not a parseable URL.',
  INVALID_POSTGRES_PROTOCOL:
    'Refusing to run: AZURE_POSTGRES_CONNECTION_STRING is not a postgres:// or postgresql:// URL.',
  INCOMPLETE_POSTGRES_TARGET:
    'Refusing to run: AZURE_POSTGRES_CONNECTION_STRING names no hostname or no database.',
};

export function assertDeclaredWriteTarget(dryRun: boolean, env = process.env): void {
  if (dryRun) {
    return;
  }

  const connectionString = env.AZURE_POSTGRES_CONNECTION_STRING?.trim();
  if (!connectionString) {
    throw new Error(
      'Refusing to run: AZURE_POSTGRES_CONNECTION_STRING is not set, so there is no target to '
      + 'check. Pass --dry-run to preview without writing.',
    );
  }

  try {
    assertDeclaredWriteTargetFromEnv(connectionString, env);
  } catch (error) {
    const token = error instanceof Error ? error.message : String(error);
    throw new Error(TARGET_REFUSALS[token] ?? `Refusing to run: ${token}.`);
  }
}

// Whether the coach-existence check can run.
//
// A real seed always needs the database -- it is about to write to it, and a
// connection failure there must stay fatal. A DRY RUN is different: the only
// thing it needed a database for was this one lookup, so requiring a live
// AZURE_POSTGRES_CONNECTION_STRING made `--dry-run` unusable on exactly the
// machine most likely to want a preview -- a laptop with the roster file and
// no production credentials. It failed with a bare "Missing required
// environment variable" before printing a single parsed row.
//
// So a dry run degrades instead of dying, and says so loudly rather than
// quietly returning a weaker answer that looks like the strong one.
async function resolveCoachCheck(dryRun: boolean): Promise<boolean> {
  if (!dryRun) {
    return true;
  }
  try {
    await query('SELECT 1');
    return true;
  } catch {
    console.warn('⚠️  No database reachable — previewing file contents only.');
    console.warn('   Coach-existence checks are SKIPPED, so this run CANNOT tell you');
    console.warn('   whether coach_id values resolve to real accounts.');
    console.warn('   Set AZURE_POSTGRES_CONNECTION_STRING for a complete preview.\n');
    return false;
  }
}

/** What the run actually did, so the caller can decide whether it succeeded. */
export interface SeedOutcome {
  readonly totalInserted: number;
  readonly totalSkipped: number;
  /** Rows that did not import, whether refused by validation or rejected by the database. */
  readonly totalErrors: number;
}

async function seedData(config: SeedConfig): Promise<SeedOutcome> {
  const dryRun = config.options.dryRun || false;
  assertDestructiveSeedAllowed(dryRun);
  assertDeclaredWriteTarget(dryRun);

  console.log(`\n📊 PPBF Data Seed Script`);
  console.log(`Organization: ${config.organizationId}`);
  console.log(`Dry Run: ${dryRun ? 'YES' : 'NO'}\n`);

  const checkCoach = await resolveCoachCheck(dryRun);

  const results: SeedResult[] = [];
  let athleteIds = new Set<string>();

  try {
    // ========== ATHLETES ==========
    if (config.files.athletes) {
      console.log(`Loading athletes from ${config.files.athletes}...`);
      const athletes = await loadFile(path.join(config.dataDir, config.files.athletes));
      const { result, athleteIds: ids } = await insertAthletes(
        athletes,
        config.organizationId,
        dryRun,
        checkCoach
      );
      athleteIds = ids;
      results.push(result);
      console.log(
        `  ✓ Inserted: ${result.inserted}, Skipped: ${result.skipped}, Errors: ${result.errors.length}\n`
      );

      // Guardians ride along on the athlete file rather than needing a second one: the link is
      // per athlete, and a separate file would let the two drift out of step. Runs after athletes
      // so a link is only written for a child who actually imported.
      const guardianResult = await insertGuardians(
        athletes,
        config.organizationId,
        dryRun,
        athleteIds
      );
      if (
        guardianResult.inserted > 0
        || guardianResult.skipped > 0
        || guardianResult.errors.length > 0
      ) {
        results.push(guardianResult);
        console.log(
          `  ✓ Guardian links: ${guardianResult.inserted} (${guardianResult.newParents ?? 0} distinct guardians), Skipped: ${guardianResult.skipped}, Errors: ${guardianResult.errors.length}`
        );
        console.log(
          '    Guardians are recorded WITHOUT accounts or PINs. Invite each family through the\n'
          + '    People screen when you are with them -- see pinPolicy.ts.\n'
        );
      } else {
        console.log('  (no guardian columns in this file -- nothing to link)\n');
      }
    }

    // ========== GOALS ==========
    if (config.files.goals) {
      console.log(`Loading goals from ${config.files.goals}...`);
      const goals = await loadFile(path.join(config.dataDir, config.files.goals));
      const result = await insertGoals(goals, config.organizationId, athleteIds, dryRun);
      results.push(result);
      console.log(
        `  ✓ Inserted: ${result.inserted}, Skipped: ${result.skipped}, Errors: ${result.errors.length}\n`
      );
    }

    // ========== SESSIONS (Workouts) ==========
    if (config.files.sessions) {
      console.log(`Loading sessions from ${config.files.sessions}...`);
      const sessions = await loadFile(path.join(config.dataDir, config.files.sessions));
      const result = await insertSessions(sessions, config.organizationId, athleteIds, dryRun);
      results.push(result);
      console.log(
        `  ✓ Inserted: ${result.inserted}, Skipped: ${result.skipped}, Errors: ${result.errors.length}\n`
      );
    }

    // ========== Summary ==========
    console.log(`\n📈 Summary:`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    let totalInserted = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (const result of results) {
      console.log(`${result.table.padEnd(20)} | Inserted: ${String(result.inserted).padStart(6)} | Skipped: ${String(result.skipped).padStart(6)} | Errors: ${String(result.errors.length).padStart(6)}`);
      totalInserted += result.inserted;
      totalSkipped += result.skipped;
      totalErrors += result.errors.length;

      if (result.errors.length > 0 && result.errors.length <= 10) {
        for (const err of result.errors) {
          console.log(`  ⚠️  Row ${err.row}: ${err.error}`);
        }
      } else if (result.errors.length > 10) {
        console.log(`  ⚠️  ${result.errors.length} errors (showing first 10)...`);
        for (const err of result.errors.slice(0, 10)) {
          console.log(`  ⚠️  Row ${err.row}: ${err.error}`);
        }
      }
    }

    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Total: Inserted ${totalInserted} | Skipped ${totalSkipped} | Errors ${totalErrors}`);

    if (dryRun) {
      console.log(`\n✨ Dry run complete. No changes were made.`);
      // Restated at the end, not only at the start. Somebody reading the tail
      // of a long run should not mistake a partial check for a clean bill.
      if (!checkCoach) {
        console.log(`   PARTIAL: no database was reachable, so coach_id values were`);
        console.log(`   not verified. A clean result here does not mean the roster`);
        console.log(`   will import cleanly.`);
      }
    } else if (totalErrors === 0) {
      console.log(`\n✅ Seed complete!`);
    } else {
      // NOT "complete". Every row above that failed is a child who is not in
      // the roster, and the operator is the only one who can put them there.
      console.log(`\n⚠️  Seed finished with ${totalErrors} row(s) NOT imported. See the errors above.`);
    }

    return { totalInserted, totalSkipped, totalErrors };
  } catch (error) {
    console.error(`\n❌ Error during seeding:`, error);
    process.exit(1);
  }
}

// ============================================================================
// CLI
// ============================================================================

function runCli(): void {
  const args = process.argv.slice(2);
  let configPath = 'scripts/seed-data.config.ts';
  let dryRun = false;
  let iUnderstandOverwrite = false;
  let allowPartialImport = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config') configPath = args[i + 1];
    if (args[i] === '--dry-run') dryRun = true;
    if (args[i] === '--i-understand-overwrite') iUnderstandOverwrite = true;
    if (args[i] === '--allow-partial-import') allowPartialImport = true;
  }

  // Checked before the config file is even imported, so refusal never depends
  // on how far a real run would have gotten -- the config could point at
  // production and this still exits before that path is read.
  if (!destructiveSeedAllowed(dryRun, iUnderstandOverwrite)) {
    console.error(
      'Refusing to run: this script overwrites existing athletes, goals, and sessions on conflict '
      + '(roster import never does). Preview with --dry-run, or confirm the overwrite explicitly '
      + 'with --i-understand-overwrite or PPBF_ALLOW_DESTRUCTIVE_SEED=true.',
    );
    process.exit(2);
  }

  // Same placement, same reason: the target is checked before the config is
  // read, so a config naming a production organization cannot get as far as
  // being loaded against a database nobody declared. seedData() checks it
  // again for a programmatic caller, exactly as the destructive guard does.
  try {
    assertDeclaredWriteTarget(dryRun);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

// Import config.
//
// pathToFileURL, not the bare absolute path: on Windows path.resolve() yields
// `C:\...`, and the ESM loader reads the drive letter as a URL scheme and
// refuses it -- "Only URLs with a scheme in: file, data, and node". That made
// the script unusable on the platform it is developed on, and the failure
// arrived as a protocol error that says nothing about paths.
// seedData() is deliberately NOT chained inside this .then(). It was, and the
// single .catch() then attributed every seeding failure to the config file:
// refusing a destructive run printed "Failed to load config from ..." followed
// by a message about overwriting athletes, which sends the reader to inspect a
// file that loaded perfectly. Loading and running fail for unrelated reasons
// and now report separately.
  void import(pathToFileURL(path.resolve(configPath)).href)
    .catch((err) => {
      console.error(`Failed to load config from ${configPath}:`, err.message);
      if (err instanceof Error && 'code' in err && err.code === 'ERR_MODULE_NOT_FOUND') {
        console.error(
          'Copy scripts/seed-data.config.example.ts to scripts/seed-data.config.ts, '
          + 'or pass --config <path>.',
        );
      }
      process.exit(1);
    })
    .then(async (module) => {
      const config: SeedConfig = module.default;
      if (dryRun) config.options.dryRun = true;
      const outcome = await seedData(config);

      // A ROW THAT DID NOT IMPORT IS A FAILED RUN.
      //
      // Every per-row failure was collected, counted, printed -- and then the
      // exit code said 0 anyway, in both modes. A roster where 30 of 40
      // children failed their coach_id ended on "Seed complete!" and returned
      // success, so CI, a runbook step and an operator all read a half-loaded
      // table of minors as finished.
      //
      // The dry run is the half that matters most: SEED_GUIDE.md tells the
      // operator to preview first, and a preview that finds four bad rows and
      // exits 0 is the reassurance it exists to withhold.
      //
      // --allow-partial-import is the deliberate escape, for an operator who
      // has read the errors and wants the good rows anyway. It has to be typed;
      // it is never the default.
      if (outcome.totalErrors > 0 && !allowPartialImport) {
        console.error(
          `\nExiting non-zero: ${outcome.totalErrors} row(s) did not import. `
          + 'Fix them and re-run, or pass --allow-partial-import to accept a partial load.',
        );
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}

// Run the CLI only when this file IS the entry point.
//
// Without this the whole block above executed on import -- reading argv,
// possibly calling process.exit(2), and importing a config that deliberately
// does not exist in the repository. That is why nothing tests this file: it
// could not be imported. Matches the pattern
// apps/web/scripts/pilot-apply-drills-migration.mjs already uses, and
// path.resolve on argv[1] so a relative invocation (`tsx scripts/seed-data.ts`)
// compares equal to the resolved module path.
const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMainModule) {
  runCli();
}

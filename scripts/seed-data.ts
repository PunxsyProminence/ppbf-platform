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

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { parse as csvParse } from 'csv-parse/sync';
// Relative, not '@/...'. That alias is declared in apps/web/tsconfig.json and
// this file sits outside that project, so the alias resolved for the editor
// and for nothing else -- `npm run seed:data` died on TS2307 before it read a
// single row. db.ts pulls in only `pg` and a relative './env', so reaching it
// directly costs nothing and needs no root tsconfig to exist.
import { query } from '../apps/web/src/server/pilot/db';

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

async function validateAthleteRow(row: any, org: string): Promise<string[]> {
  const errors: string[] = [];

  if (!row.athlete_id) errors.push('Missing athlete_id');
  if (!row.full_name) errors.push('Missing full_name');
  if (!row.dob) errors.push('Missing dob (format: YYYY-MM-DD)');
  if (!row.weight_class) errors.push('Missing weight_class');
  if (!row.gym_status) errors.push('Missing gym_status');
  if (!row.emergency_contact) errors.push('Missing emergency_contact');
  if (!row.coach_id) errors.push('Missing coach_id');

  // Verify coach exists
  if (row.coach_id && !errors.length) {
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
  dryRun: boolean
): Promise<{ result: SeedResult; athleteIds: Set<string> }> {
  const result: SeedResult = { table: 'athletes', inserted: 0, skipped: 0, errors: [] };
  const athleteIds = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const errors = await validateAthleteRow(row, org);

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
// config pointed at a live organization id can't be run by habit.
function assertDestructiveSeedAllowed(dryRun: boolean): void {
  if (dryRun) {
    return;
  }
  if (process.env.PPBF_ALLOW_DESTRUCTIVE_SEED === 'true' || process.env.NODE_ENV === 'test') {
    return;
  }
  throw new Error(
    'Refusing to run: this script overwrites existing athletes, goals, and sessions on conflict '
    + '(roster import never does). Set PPBF_ALLOW_DESTRUCTIVE_SEED=true to confirm you want that '
    + 'against this database, or pass --dry-run to preview without writing.',
  );
}

async function seedData(config: SeedConfig) {
  assertDestructiveSeedAllowed(config.options.dryRun || false);

  console.log(`\n📊 PPBF Data Seed Script`);
  console.log(`Organization: ${config.organizationId}`);
  console.log(`Dry Run: ${config.options.dryRun ? 'YES' : 'NO'}\n`);

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
        config.options.dryRun || false
      );
      athleteIds = ids;
      results.push(result);
      console.log(
        `  ✓ Inserted: ${result.inserted}, Skipped: ${result.skipped}, Errors: ${result.errors.length}\n`
      );
    }

    // ========== GOALS ==========
    if (config.files.goals) {
      console.log(`Loading goals from ${config.files.goals}...`);
      const goals = await loadFile(path.join(config.dataDir, config.files.goals));
      const result = await insertGoals(goals, config.organizationId, athleteIds, config.options.dryRun || false);
      results.push(result);
      console.log(
        `  ✓ Inserted: ${result.inserted}, Skipped: ${result.skipped}, Errors: ${result.errors.length}\n`
      );
    }

    // ========== SESSIONS (Workouts) ==========
    if (config.files.sessions) {
      console.log(`Loading sessions from ${config.files.sessions}...`);
      const sessions = await loadFile(path.join(config.dataDir, config.files.sessions));
      const result = await insertSessions(sessions, config.organizationId, athleteIds, config.options.dryRun || false);
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

    if (config.options.dryRun) {
      console.log(`\n✨ Dry run complete. No changes were made.`);
    } else {
      console.log(`\n✅ Seed complete!`);
    }
  } catch (error) {
    console.error(`\n❌ Error during seeding:`, error);
    process.exit(1);
  }
}

// ============================================================================
// CLI
// ============================================================================

const args = process.argv.slice(2);
let configPath = 'scripts/seed-data.config.ts';
let dryRun = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config') configPath = args[i + 1];
  if (args[i] === '--dry-run') dryRun = true;
}

// Import config.
//
// pathToFileURL, not the bare absolute path: on Windows path.resolve() yields
// `C:\...`, and the ESM loader reads the drive letter as a URL scheme and
// refuses it -- "Only URLs with a scheme in: file, data, and node". That made
// the script unusable on the platform it is developed on, and the failure
// arrived as a protocol error that says nothing about paths.
import(pathToFileURL(path.resolve(configPath)).href)
  .then((module) => {
    const config: SeedConfig = module.default;
    if (dryRun) config.options.dryRun = true;
    return seedData(config);
  })
  .catch((err) => {
    console.error(`Failed to load config from ${configPath}:`, err.message);
    if (err instanceof Error && 'code' in err && err.code === 'ERR_MODULE_NOT_FOUND') {
      console.error(
        'Copy scripts/seed-data.config.example.ts to scripts/seed-data.config.ts, '
        + 'or pass --config <path>.',
      );
    }
    process.exit(1);
  });

#!/usr/bin/env node
/**
 * PPBF Data Seed Script
 * Bulk upload workouts, research, and athlete data to PostgreSQL
 *
 * Usage:
 *   npx ts-node scripts/seed-data.ts --config scripts/seed-data.config.ts
 *   npx ts-node scripts/seed-data.ts --org ppbf-demo --dry-run
 */

import fs from 'fs';
import path from 'path';
import { parse as csvParse } from 'csv-parse/sync';
import { query } from '@/src/server/pilot/db';

interface SeedConfig {
  organizationId: string;
  dataDir: string;
  files: {
    athletes?: string;
    goals?: string;
    sessions?: string;
    researchSources?: string;
    researchDocuments?: string;
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
    if (coachExists.rowCount === 0) {
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

async function seedData(config: SeedConfig) {
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

// Import config
import(path.resolve(configPath))
  .then((module) => {
    const config: SeedConfig = module.default;
    if (dryRun) config.options.dryRun = true;
    return seedData(config);
  })
  .catch((err) => {
    console.error(`Failed to load config from ${configPath}:`, err.message);
    process.exit(1);
  });

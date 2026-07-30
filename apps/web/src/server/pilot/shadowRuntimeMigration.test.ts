import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const canonicalSchemaPath = path.join(
  repositoryRoot,
  'infra/azure/pilot_slice_postgres.sql',
);
const migrationPath = path.join(
  repositoryRoot,
  'infra/azure/pilot_slice_postgres_shadow_runtime_migration.sql',
);
const formulaFoundationMigrationPath = path.join(
  repositoryRoot,
  'infra/azure/pilot_slice_postgres_shadow_formula_foundation_migration.sql',
);
const decisionLoopMigrationPath = path.join(
  repositoryRoot,
  'infra/azure/pilot_slice_postgres_shadow_decision_loop_migration.sql',
);
const runnerPath = path.join(
  repositoryRoot,
  'apps/web/scripts/pilot-apply-shadow-runtime-migration.mjs',
);

describe('SHADOW runtime migration contract', () => {
  const canonicalSchema = fs.readFileSync(canonicalSchemaPath, 'utf8');
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const formulaFoundationMigration = fs.readFileSync(
    formulaFoundationMigrationPath,
    'utf8',
  );
  const decisionLoopMigration = fs.readFileSync(decisionLoopMigrationPath, 'utf8');
  const runner = fs.readFileSync(runnerPath, 'utf8');

  test('keeps the additive migration transactional and aligned with required tables', () => {
    expect(migration.trim()).toMatch(/^--[\s\S]*\nbegin;/i);
    expect(migration.trim()).toMatch(/commit;$/i);

    const requiredSchemaFragments = [
      'pilot.shadow_chat_sessions',
      'pilot.shadow_chat_messages',
      'pilot.shadow_jobs',
      'pilot.shadow_learning_events',
      'pilot.shadow_formula_observations',
      'pilot.shadow_formula_results',
      'pilot.shadow_formula_baseline_snapshots',
      'pilot.shadow_rate_limit_buckets',
      'topic text not null',
      'session_type text not null',
      'idx_shadow_feedback_unique_message',
      'reviewed_by_account_id text null',
      'reviewed_at timestamptz null',
    ];

    for (const fragment of requiredSchemaFragments) {
      expect(migration).toContain(fragment);
      expect(canonicalSchema).toContain(fragment);
    }
  });

  test('fails safely before hardening incompatible legacy SHADOW data', () => {
    const precheckPosition = migration.indexOf('do $shadow_runtime_precheck$');
    const notNullPosition = migration.indexOf(
      'alter column feedback_id set not null',
    );
    const constraintsPosition = migration.indexOf(
      'do $shadow_runtime_constraints$',
    );

    expect(precheckPosition).toBeGreaterThan(0);
    expect(notNullPosition).toBeGreaterThan(precheckPosition);
    expect(constraintsPosition).toBeGreaterThan(notNullPosition);
    expect(migration).toContain("message = 'SHADOW_RUNTIME_PRECHECK_FAILED'");

    const precheckedTables = [
      'shadow_feedback',
      'shadow_jobs',
      'shadow_research_requirements',
      'shadow_recommendation_effectiveness',
      'shadow_learning_events',
      'shadow_library_review_flags',
      'shadow_monthly_stats',
      'shadow_formula_observations',
      'shadow_formula_results',
      'shadow_formula_baseline_snapshots',
    ];

    for (const table of precheckedTables) {
      expect(migration).toContain(`detail = '${table}'`);
    }

    expect(migration).not.toMatch(/\bupdate\s+pilot\.shadow_/i);
    expect(migration).not.toMatch(/\bdelete\s+from\s+pilot\.shadow_/i);
  });

  test('idempotently applies the canonical learning and metrics constraints', () => {
    const canonicalConstraintFragments = [
      "verification_state in ('unverified', 'durable_client', 'human_reviewed')",
      'effectiveness_score between 0 and 1',
      "review_state in ('pending', 'approved', 'rejected', 'resolved')",
      "proposed_action in ('promote', 'demote', 'retain')",
      "status in ('open', 'resolved')",
      "month ~ '^[0-9]{4}-[0-9]{2}$'",
      'interaction_count >= 0',
      'avg_filter_rate between 0 and 1',
      'avg_effectiveness_score between 0 and 1',
      "source_quality in ('verified', 'high', 'moderate', 'low', 'failed')",
      "validation_state in ('valid', 'warning', 'invalid', 'insufficient', 'unsupported')",
      "confidence in ('HIGH', 'MODERATE', 'LOW', 'INSUFFICIENT')",
      'completeness between 0 and 1',
      'window_size between 1 and 1000',
      "history_status in ('insufficient_history', 'building', 'adequate')",
    ];

    for (const fragment of canonicalConstraintFragments) {
      expect(canonicalSchema).toContain(fragment);
      expect(migration).toContain(fragment);
    }

    expect(migration).toContain("from pg_constraint");
    expect(migration).toContain(
      'shadow_learning_events_feedback_id_verification_state_key',
    );
    expect(migration).toContain(
      'shadow_feedback_reviewed_by_account_id_fkey',
    );
    expect(migration).toContain(
      'shadow_jobs_organization_id_subject_id_fkey',
    );
    expect(migration).toContain('idx_shadow_research_requirements_source');
    expect(migration).toContain(
      'group by organization_id, source_event_name, source_entity_type, source_entity_id',
    );
    expect(canonicalSchema).toContain(
      'unique (organization_id, source_event_name, source_entity_type, source_entity_id)',
    );
  });

  test('keeps formula observation, multi-output, and baseline identity additive and aligned', () => {
    const formulaFoundationFragments = [
      "dimensions jsonb not null default '{}'::jsonb",
      'idempotency_key text not null',
      'idx_shadow_formula_observations_idempotency',
      'idx_shadow_formula_observations_supersedes',
      'calculation_key text not null',
      'output_key text not null',
      'policy_version text not null',
      "parameters jsonb not null default '{}'::jsonb",
      'idx_shadow_formula_results_calculation',
      'metric_key text not null',
      'unit text not null',
      'idx_shadow_formula_baseline_calculation',
      'shadow_formula_observations_dimensions_check',
      'shadow_formula_results_identity_check',
      'shadow_formula_baseline_identity_check',
    ];

    for (const fragment of formulaFoundationFragments) {
      expect(canonicalSchema).toContain(fragment);
      expect(formulaFoundationMigration).toContain(fragment);
    }
    expect(formulaFoundationMigration.trim()).toMatch(/^--[\s\S]*\nbegin;/i);
    expect(formulaFoundationMigration.trim()).toMatch(/commit;$/i);
    expect(formulaFoundationMigration).toContain(
      'add column if not exists idempotency_key text not null default gen_random_uuid()::text',
    );
    expect(formulaFoundationMigration).toContain(
      'add column if not exists calculation_key text not null default gen_random_uuid()::text',
    );
    expect(formulaFoundationMigration).toContain(
      'SHADOW_FORMULA_FOUNDATION_PRECHECK_FAILED',
    );
    expect(formulaFoundationMigration).not.toMatch(/\bupdate\s+pilot\.shadow_/i);
    expect(formulaFoundationMigration).not.toMatch(/\bdelete\s+from\s+pilot\.shadow_/i);

    expect(migration).not.toContain('idx_shadow_formula_observations_idempotency');
    expect(migration).not.toContain('idx_shadow_formula_results_calculation');
    expect(migration).not.toContain('shadow_formula_results_identity_check');
  });

  test('keeps the decision-loop migration transactional and free of new writes to existing tables', () => {
    expect(decisionLoopMigration.trim()).toMatch(/^--[\s\S]*\nbegin;/i);
    expect(decisionLoopMigration.trim()).toMatch(/commit;$/i);

    const decisionLoopTables = [
      'pilot.shadow_medical_administrative_status',
      'pilot.shadow_recommendations',
      'pilot.shadow_decisions',
      'pilot.shadow_near_misses',
      'pilot.shadow_decision_outcomes',
      'pilot.shadow_audit_entries',
    ];
    for (const table of decisionLoopTables) {
      expect(decisionLoopMigration).toContain(table);
    }

    // Recommendations must always start provisional -- the only place a
    // caller could sneak a different default in would be right here.
    expect(decisionLoopMigration).toContain("status text not null default 'provisional'");
    expect(decisionLoopMigration).toContain(
      "check (status in ('provisional', 'accepted', 'rejected', 'expired', 'superseded'))",
    );
    // This migration only adds new tables -- no ALTER on any existing one,
    // including shadow_recommendation_effectiveness (the unrelated, post-hoc
    // chat-feedback scoring table).
    expect(decisionLoopMigration).not.toMatch(/\balter\s+table\b/i);
    expect(decisionLoopMigration).not.toMatch(/\bupdate\s+pilot\./i);
    expect(decisionLoopMigration).not.toMatch(/\bdelete\s+from\s+pilot\./i);
  });

  test('uses the ordered approved additive migrations and hard-asserts the target', () => {
    for (const migrationFile of [
      'pilot_slice_postgres_shadow_runtime_migration.sql',
      'pilot_slice_postgres_shadow_formula_foundation_migration.sql',
      'pilot_slice_postgres_shadow_evidence_migration.sql',
      'pilot_slice_postgres_shadow_job_lease_migration.sql',
      'pilot_slice_postgres_board_role_migration.sql',
      'pilot_slice_postgres_shadow_decision_loop_migration.sql',
    ]) {
      expect(runner).toContain(migrationFile);
    }
    expect(runner).toContain('PPBF_EXPECTED_POSTGRES_HOSTNAME');
    expect(runner).toContain('PPBF_EXPECTED_POSTGRES_DATABASE');
    expect(runner).toContain('POSTGRES_TARGET_MISMATCH');
    expect(runner).toContain('delete process.env.AZURE_POSTGRES_CONNECTION_STRING');
    expect(runner).toContain('rejectUnauthorized: true');
  });

  test('every migration the runner applies is transactional, leading comments and all', () => {
    const moduleUrl = pathToFileURL(runnerPath).href;
    // Trailing separator matters: `new URL('x.sql', 'file:///a/b')` resolves
    // to /a/x.sql, dropping the directory.
    const migrationsDir = pathToFileURL(
      path.join(repositoryRoot, 'infra/azure') + path.sep,
    ).href;

    // Derived from the runner's own MIGRATION_FILES, not a list maintained
    // here. The previous version of this test named three files by hand, so
    // when the chunk-embedding migration was added to the runner it was never
    // checked -- it shipped without `begin;`/`commit;`, and because the runner
    // asserts the boundary before applying anything, it took EVERY
    // shadow-runtime migration down with it on any environment.
    const applied = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          `import fs from 'node:fs';`,
          `import { assertTransactionalMigration, MIGRATION_FILES } from ${JSON.stringify(moduleUrl)};`,
          `for (const file of MIGRATION_FILES) {`,
          `  const url = new URL(file, ${JSON.stringify(migrationsDir)});`,
          `  try {`,
          `    assertTransactionalMigration(fs.readFileSync(url, 'utf8'));`,
          `  } catch (error) {`,
          `    throw new Error(file + ': ' + error.message);`,
          `  }`,
          `}`,
          `process.stdout.write(JSON.stringify(MIGRATION_FILES));`,
        ].join('\n'),
      ],
      { stdio: 'pipe' },
    ).toString();

    // A list that resolved empty would make the loop above pass vacuously.
    const files: string[] = JSON.parse(applied);
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files).toContain('pilot_slice_postgres_shadow_chunk_embedding_migration.sql');
  });

  test('verifies readiness without printing raw errors or secret material', () => {
    expect(runner).toContain('SHADOW_SCHEMA_NOT_READY');
    expect(runner).toContain('shadow_schema_ready: true');
    expect(runner).not.toContain('console.error(String(error))');
    expect(runner).not.toContain('console.log(connectionString)');
    expect(runner).toContain('shadow_evidence_bundles');
    expect(runner).toContain('formula_baseline_identity_ready');
    expect(runner).toContain('formula_uniqueness_ready');
    expect(runner).toContain('lease_expires_at');
    expect(runner).toContain('board_membership_role_ready');
    expect(runner).toContain('medical_status_ready');
    expect(runner).toContain('recommendations_ready');
    expect(runner).toContain('decisions_ready');
    expect(runner).toContain('near_misses_ready');
    expect(runner).toContain('decision_outcomes_ready');
    expect(runner).toContain('audit_entries_ready');
  });
});

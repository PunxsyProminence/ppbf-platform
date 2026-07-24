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
const runnerPath = path.join(
  repositoryRoot,
  'apps/web/scripts/pilot-apply-shadow-runtime-migration.mjs',
);

describe('SHADOW runtime migration contract', () => {
  const canonicalSchema = fs.readFileSync(canonicalSchemaPath, 'utf8');
  const migration = fs.readFileSync(migrationPath, 'utf8');
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

  test('uses the one approved migration file and hard-asserts the target', () => {
    expect(runner).toContain(
      'pilot_slice_postgres_shadow_runtime_migration.sql',
    );
    expect(runner).toContain('PPBF_EXPECTED_POSTGRES_HOSTNAME');
    expect(runner).toContain('PPBF_EXPECTED_POSTGRES_DATABASE');
    expect(runner).toContain('POSTGRES_TARGET_MISMATCH');
    expect(runner).toContain('delete process.env.AZURE_POSTGRES_CONNECTION_STRING');
    expect(runner).toContain('rejectUnauthorized: true');
  });

  test('accepts the approved leading comments before the transaction boundary', () => {
    const moduleUrl = pathToFileURL(runnerPath).href;
    const migrationUrl = pathToFileURL(migrationPath).href;

    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          `import fs from 'node:fs';`,
          `import { assertTransactionalMigration } from ${JSON.stringify(moduleUrl)};`,
          `assertTransactionalMigration(fs.readFileSync(new URL(${JSON.stringify(migrationUrl)}), 'utf8'));`,
        ].join('\n'),
      ],
      { stdio: 'pipe' },
    );
  });

  test('verifies readiness without printing raw errors or secret material', () => {
    expect(runner).toContain('SHADOW_SCHEMA_NOT_READY');
    expect(runner).toContain('shadow_schema_ready: true');
    expect(runner).not.toContain('console.error(String(error))');
    expect(runner).not.toContain('console.log(connectionString)');
  });
});

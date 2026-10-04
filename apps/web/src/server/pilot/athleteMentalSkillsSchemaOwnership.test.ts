import fs from 'node:fs';
import path from 'node:path';

import { FIELD_TIERS } from './privacyTiers';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const read = (relative: string) => fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');

const moduleSource = read('apps/web/src/server/pilot/athleteMentalSkills.ts');
const migration = read('infra/azure/pilot_slice_postgres_athlete_mental_skills_migration.sql');
const runner = read('apps/web/scripts/pilot-apply-athlete-mental-skills-migration.mjs');
const workflow = read('.github/workflows/apply-migrations.yml');
const packageJson = JSON.parse(read('apps/web/package.json'));

const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('athlete mental skills schema ownership', () => {
  test('the module issues no DDL, deletes nothing, and scopes every statement by organization_id', () => {
    const code = stripComments(moduleSource);
    expect(code).not.toMatch(/create\s+table|create\s+index|alter\s+table|drop\s+table/i);
    expect(code).not.toMatch(/\bdelete\s+from\b|\bupdate\s+pilot\./i);

    const statements = code.match(/`[^`]*pilot\.athlete_mental_skill_entries[^`]*`/g) ?? [];
    expect(statements).toHaveLength(5);
    for (const statement of statements) {
      expect(statement).toMatch(
        /where organization_id = \$1 and athlete_id = \$2|insert into pilot\.athlete_mental_skill_entries\s*\(organization_id,/,
      );
    }
  });

  test('every read and write runs the per-athlete gate before touching the table', () => {
    const code = stripComments(moduleSource);
    for (const fn of ['readMentalSkills', 'requireSelfAthlete']) {
      const body = code.slice(code.indexOf(`function ${fn}`));
      const gate = body.indexOf('assertActorCanAccessAthlete(');
      const firstQuery = body.search(/\bquery(One)?</);
      expect(gate).toBeGreaterThan(-1);
      expect(firstQuery === -1 || gate < firstQuery).toBe(true);
    }
    for (const fn of ['setSelfTalkCue', 'logImagerySession']) {
      const body = code.slice(code.indexOf(`function ${fn}`));
      const self = body.indexOf('await requireSelfAthlete(actor)');
      expect(self).toBeGreaterThan(-1);
      expect(self).toBeLessThan(body.indexOf('insertEntry('));
    }
  });

  test('the limit, the insert and the audit record share one locked transaction', () => {
    const code = stripComments(moduleSource);
    const body = code.slice(code.indexOf('async function insertEntry'), code.indexOf('export async function setSelfTalkCue'));
    const tx = body.indexOf('withTransaction(');
    const lock = body.indexOf('pg_advisory_xact_lock(');
    const count = body.indexOf('count(*)');
    const insert = body.indexOf('insert(client, entryId)');
    const audit = body.indexOf('writePilotAuditEvent(');
    expect(tx).toBeGreaterThan(-1);
    expect([tx, lock, count, insert, audit].every((at, i, all) => at > -1 && (i === 0 || at > all[i - 1]))).toBe(true);
    expect(body.slice(audit)).toMatch(/\},\s*client,\s*\)/);
    expect(body).not.toMatch(/cue_text\s*:/);
  });

  test('the migration owns the table, its guards and its index, with no transaction boundary', () => {
    expect(migration).toMatch(/create table if not exists pilot\.athlete_mental_skill_entries/i);
    expect(migration).toMatch(/references pilot\.athletes\(organization_id, athlete_id\) on delete cascade/i);
    expect(migration).toMatch(/primary key \(organization_id, entry_id\)/i);
    for (const name of ['kind_check', 'cue_text_check', 'cue_kind_check', 'minutes_check', 'content_key_check', 'shape_check']) {
      expect(migration).toContain(`pilot_athlete_mental_skill_entries_${name}`);
    }
    expect(migration).toMatch(/create index if not exists idx_athlete_mental_skill_entries_athlete/i);
    expect(migration).not.toMatch(/^\s*(begin|commit)\s*;/im);
    expect(migration).not.toMatch(/\b(drop|alter)\s+table\b/i);
  });

  test('the runner reads this migration and verifies readiness before committing', () => {
    expect(runner).toContain('pilot_slice_postgres_athlete_mental_skills_migration.sql');
    expect(runner).toContain('ATHLETE_MENTAL_SKILLS_TABLE_NOT_READY');
    expect(runner).toContain('idx_athlete_mental_skill_entries_athlete');
    expect(runner).toContain('pilot_athlete_mental_skill_entries_shape_check');
    expect(runner).toContain('POSTGRES_TARGET_MISMATCH');
    expect(runner).toContain('rejectUnauthorized: true');
  });

  test('the migration is dispatchable, in every hand-maintained list, and has an embedded-pg suite', () => {
    expect(packageJson.scripts['pilot:apply-athlete-mental-skills']).toBe(
      'node scripts/pilot-apply-athlete-mental-skills-migration.mjs',
    );
    expect(packageJson.scripts['test:migrations:athlete-mental-skills']).toContain(
      'src/server/pilot/athleteMentalSkills.pg.test.ts',
    );
    expect(workflow).toMatch(/^\s+- athlete-mental-skills$/m);
    expect(workflow.match(/for m in ([a-z0-9 -]+); do/)?.[1].split(' ')).toContain('athlete-mental-skills');
    expect(workflow.match(/case " ([a-z0-9 -]+) " in/)?.[1].split(' ')).toContain('athlete-mental-skills');
  });

  test('the athlete-typed cue is registered at the per-athlete tier', () => {
    expect(FIELD_TIERS['athlete_mental_skill_entries.cue_text']?.tier).toBe('athlete_record');
  });
});

import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const read = (relative: string) => fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');

const moduleSource = read('apps/web/src/server/pilot/videoClipTags.ts');
const migration = read('infra/azure/pilot_slice_postgres_video_clip_tags_migration.sql');
const runner = read('apps/web/scripts/pilot-apply-video-clip-tags-migration.mjs');
const workflow = read('.github/workflows/apply-migrations.yml');
const packageJson = JSON.parse(read('apps/web/package.json'));

describe('video clip tags schema ownership', () => {
  test('the module issues no DDL, never hard-deletes, and scopes every statement by organization', () => {
    const code = moduleSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).not.toMatch(/create\s+table|create\s+index|alter\s+table|drop\s+table/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    // The to_regclass probes read the catalog, not rows.
    const statements = (code.match(/`[^`]*pilot\.video_clip_tags[^`]*`/g) ?? [])
      .filter((statement) => !statement.includes('to_regclass'));
    expect(statements.length).toBeGreaterThanOrEqual(6);
    for (const statement of statements) {
      // other.organization_id = t.organization_id: the shared visibility
      // fragment, correlated to a tag row whose own statement is scoped by $1.
      expect(statement).toMatch(/organization_id\s*=\s*\$1|insert into pilot\.video_clip_tags\s*\(\s*organization_id|clip_tag\.organization_id|other\.organization_id\s*=\s*t\.organization_id/);
    }
  });

  test('the migration owns the table and the keys that hold it to one organization and a real entry', () => {
    expect(migration).toMatch(/create table if not exists pilot\.video_clip_tags/i);
    expect(migration).toMatch(/create unique index if not exists idx_video_sessions_org_video/i);
    expect(migration).toContain('pilot_video_clip_tags_video_fk');
    expect(migration).toContain('pilot_video_clip_tags_athlete_fk');
    expect(migration).toMatch(/pilot_video_clip_tags_entry_fk foreign key \(organization_id, competition_id, athlete_id\)/);
    expect(migration).toContain('pilot_video_clip_tags_event_check');
    expect(migration).toMatch(/create unique index if not exists idx_video_clip_tags_one_live/i);
    // Additive only: nothing existing is dropped or altered.
    expect(migration).not.toMatch(/\bdrop\s+(table|column|constraint|index)\b/i);
    expect(migration).not.toMatch(/\balter\s+table\b/i);
    expect(migration).not.toMatch(/^\s*(begin|commit)\s*;/im);
  });

  test('the runner verifies its target and readiness before committing', () => {
    expect(runner).toContain('pilot_slice_postgres_video_clip_tags_migration.sql');
    expect(runner).toContain('VIDEO_CLIP_TAGS_NOT_READY');
    expect(runner).toContain('POSTGRES_TARGET_MISMATCH');
    expect(runner).toContain('rejectUnauthorized: true');
    expect(runner).toContain("client.query('ROLLBACK')");
  });

  test('the migration is dispatchable, in every hand-maintained list, and has an embedded-pg suite', () => {
    expect(packageJson.scripts['pilot:apply-video-clip-tags']).toBe('node scripts/pilot-apply-video-clip-tags-migration.mjs');
    expect(packageJson.scripts['test:migrations:video-clip-tags']).toContain('src/server/pilot/videoClipTags.pg.test.ts');
    expect(workflow).toMatch(/^\s+- video-clip-tags$/m);
    const allList = workflow.match(/for m in ([a-z0-9 -]+); do/);
    expect(allList?.[1].split(' ')).toContain('video-clip-tags');
    // After everything it depends on, in the dependency-ordered 'all' run.
    const order = allList?.[1].split(' ') ?? [];
    for (const dependency of ['video-sessions', 'external-competition', 'capture-sessions', 'publications']) {
      expect(order.indexOf(dependency)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(dependency)).toBeLessThan(order.indexOf('video-clip-tags'));
    }
    const listCheck = workflow.match(/case " ([a-z0-9 -]+) " in/);
    expect(listCheck?.[1].split(' ')).toContain('video-clip-tags');
  });
});

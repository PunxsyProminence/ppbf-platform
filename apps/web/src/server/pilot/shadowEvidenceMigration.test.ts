import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const migrationPath = path.join(
  repositoryRoot,
  'infra/azure/pilot_slice_postgres_shadow_evidence_migration.sql',
);

describe('SHADOW evidence migration contract', () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');

  test('is an additive transaction with durable review, bundle, claim, and citation state', () => {
    expect(migration.trim()).toMatch(/^--[\s\S]*\nbegin;/i);
    expect(migration.trim()).toMatch(/commit;$/i);
    expect(migration).toContain("add column if not exists approval_state text not null default 'pending_review'");
    expect(migration).toContain("add column if not exists verification_state text not null default 'unverified'");
    expect(migration).toContain('add column if not exists index_completed_at timestamptz null');
    expect(migration).toContain('create table if not exists pilot.shadow_evidence_bundles');
    expect(migration).toContain('create table if not exists pilot.shadow_evidence_items');
    expect(migration).toContain('create table if not exists pilot.shadow_evidence_claims');
    expect(migration).toContain('create table if not exists pilot.shadow_message_citations');
  });

  test('stores hashes and identifiers instead of raw query or excerpt content', () => {
    const evidenceSchema = migration.slice(migration.indexOf('create table if not exists pilot.shadow_evidence_bundles'));
    expect(evidenceSchema).toContain('query_sha256');
    expect(evidenceSchema).toContain('excerpt_sha256');
    expect(evidenceSchema).not.toMatch(/\bquery_text\b/i);
    expect(evidenceSchema).not.toMatch(/\bexcerpt_text\b/i);
    expect(evidenceSchema).not.toMatch(/\btext_content\b/i);
  });

  test('does not rewrite, delete, or automatically approve existing library data', () => {
    expect(migration).not.toMatch(/\bupdate\s+pilot\.shadow_library_/i);
    expect(migration).not.toMatch(/\bdelete\s+from\s+pilot\./i);
    expect(migration).not.toMatch(/\bdrop\s+(table|column)\b/i);
    expect(migration).not.toMatch(/default\s+'approved'/i);
    expect(migration).not.toMatch(/default\s+'verified'/i);
  });
});

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(
  path.resolve(__dirname, 'import-shadow-research.mjs'),
).href;

function evaluate(expression: string) {
  const script = `
    import * as m from ${JSON.stringify(moduleUrl)};
    const value = await (${expression});
    process.stdout.write(JSON.stringify(value));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  }));
}

describe('SHADOW research intake package', () => {
  test('loads the complete package and resolves tenant placeholders', () => {
    const result = evaluate(`(async () => {
      const seed = await m.loadSeedPackage({
        organizationId: 'org-research-test',
        accountId: 'account-research-test',
        createdByRole: 'organization_admin',
      });
      return {
        counts: Object.fromEntries(Object.entries(seed).map(([name, rows]) => [name, rows.length])),
        organizations: [...new Set(Object.values(seed).flat().map((row) => row.organization_id))],
        roles: [...new Set([
          ...seed.sources,
          ...seed.documents,
          ...seed.chunks,
          ...seed.requirements,
        ].map((row) => row.created_by_role))],
        firstCapabilityTypes: seed.capabilityMap[0].required_source_types,
      };
    })()`);

    expect(result.counts).toEqual({
      sources: 1214,
      documents: 14,
      chunks: 1193,
      capabilityMap: 30,
      requirements: 229,
    });
    expect(result.organizations).toEqual(['org-research-test']);
    expect(result.roles).toEqual(['organization_admin']);
    expect(result.firstCapabilityTypes).toEqual(['peer_reviewed']);
  });

  test('refuses malformed PostgreSQL array literals', () => {
    const result = evaluate(`(() => {
      try { m.parsePostgresTextArray('peer_reviewed'); }
      catch (error) { return error.message; }
      return 'unexpected-pass';
    })()`);
    expect(result).toBe('INVALID_POSTGRES_TEXT_ARRAY:peer_reviewed');
  });
});

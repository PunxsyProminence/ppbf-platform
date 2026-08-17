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

  test('no seeded source or document row lands with an approved or verified state', () => {
    const result = evaluate(`(async () => {
      const seed = await m.loadSeedPackage({
        organizationId: 'org-research-test',
        accountId: 'account-research-test',
        createdByRole: 'organization_admin',
      });
      return {
        sourceStates: [...new Set(seed.sources.map((r) => \`\${r.approval_state}:\${r.verification_state}\`))],
        documentStates: [...new Set(seed.documents.map((r) => \`\${r.approval_state}:\${r.verification_state}\`))],
      };
    })()`);
    expect(result.sourceStates).toEqual(['pending_review:unverified']);
    expect(result.documentStates).toEqual(['pending_review:unverified']);
  });

  test('all 14 document rows land with ingest_state=pending, never indexed', () => {
    const result = evaluate(`(async () => {
      const seed = await m.loadSeedPackage({
        organizationId: 'org-research-test',
        accountId: 'account-research-test',
        createdByRole: 'organization_admin',
      });
      return [...new Set(seed.documents.map((r) => r.ingest_state))];
    })()`);
    expect(result).toEqual(['pending']);
  });

  test('refuses a coverage verdict outside the ShadowCoverageState vocabulary', () => {
    const result = evaluate(`(() => {
      try { m.parseCoverageState('mostly_covered'); }
      catch (error) { return error.message; }
      return 'unexpected-pass';
    })()`);
    expect(result).toBe('INVALID_COVERAGE_STATE:mostly_covered');
  });

  // The capability map is the one seed file with a second, disagreeing copy in the tree
  // (2026-08-08, reference data, not loadable). Pinning the distribution means swapping the
  // loaded map for another one fails here instead of importing silently.
  test('the loaded capability map carries the documented 19/10/1 coverage distribution', () => {
    const result = evaluate(`(async () => {
      const seed = await m.loadSeedPackage({
        organizationId: 'org-research-test',
        accountId: 'account-research-test',
        createdByRole: 'organization_admin',
      });
      const states = {};
      for (const row of seed.capabilityMap) {
        states[row.coverage_state] = (states[row.coverage_state] ?? 0) + 1;
      }
      return states;
    })()`);
    expect(result).toEqual({ covered: 19, partial: 10, uncovered: 1 });
  });
});

import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
const apiRoot = path.join(repositoryRoot, 'apps/web/app/api');
const readmePath = path.join(repositoryRoot, 'README.md');
const masterIndexPath = path.join(repositoryRoot, 'MASTER_INDEX.md');

// Statement forms that reshape the database rather than read or write rows.
const DDL_PATTERN =
  /\b(create|alter|drop|truncate)\s+(table|schema|index|extension|view|type|sequence)\b/i;

function typeScriptFilesUnder(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return typeScriptFilesUnder(full);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('HTTP routes and schema changes', () => {
  // The rule both README and MASTER_INDEX state: the schema is owned by the
  // migration files in infra/azure and applied by the pilot:apply-* runners.
  // A request handler that issues DDL puts the shape of the youth-data schema
  // behind whatever credential guards that route, and makes "the migration has
  // been applied" mean different things in different environments.
  test('no request handler under app/api issues DDL', () => {
    const files = typeScriptFilesUnder(apiRoot).filter((file) => !/\.test\.tsx?$/.test(file));
    expect(files.length).toBeGreaterThan(100);

    const offenders = files.filter((file) => DDL_PATTERN.test(fs.readFileSync(file, 'utf8')));
    expect(offenders.map((file) => path.relative(repositoryRoot, file))).toEqual([]);
  });

  test('both entry-point documents still state the rule', () => {
    for (const docPath of [readmePath, masterIndexPath]) {
      // Both documents wrap prose, so the sentence can carry a line break.
      expect(fs.readFileSync(docPath, 'utf8')).toMatch(/No\s+HTTP\s+route\s+changes\s+the\s+schema/);
    }
  });
});

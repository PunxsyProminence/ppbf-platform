import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { queryOne, query } from './db';
import { guardianAthleteIds, isGuardianLinkedToAthlete } from './guardianAccess';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockQueryOne = queryOne as jest.Mock;
const mockQuery = query as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

describe('isGuardianLinkedToAthlete', () => {
  test('true when a link row exists; the parents subselect is org-scoped on both levels', async () => {
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' });

    await expect(isGuardianLinkedToAthlete('org-1', 'parent-acct-1', 'ath-1')).resolves.toBe(true);

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(String(sql)).toContain('pilot.guardian_links');
    expect(String(sql)).toContain('pilot.parents');
    // The organization predicate appears on BOTH the link and the parent row
    // -- losing either one lets a parent account provisioned in one gym
    // reach a child in another.
    expect(String(sql).match(/organization_id = \$1/g)?.length).toBe(2);
    expect(params).toEqual(['org-1', 'ath-1', 'parent-acct-1']);
  });

  test('false when no link exists', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    await expect(isGuardianLinkedToAthlete('org-1', 'parent-acct-1', 'ath-other')).resolves.toBe(false);
  });
});

describe('guardianAthleteIds', () => {
  test('returns the distinct linked athlete ids', async () => {
    mockQuery.mockResolvedValueOnce([{ athlete_id: 'ath-1' }, { athlete_id: 'ath-2' }]);

    await expect(guardianAthleteIds('org-1', 'parent-acct-1')).resolves.toEqual(['ath-1', 'ath-2']);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('select distinct');
    expect(String(sql)).toContain('pilot.guardian_links');
    expect(params).toEqual(['org-1', 'parent-acct-1']);
  });

  test('no links means [], never undefined -- an empty scope must match nothing', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await expect(guardianAthleteIds('org-1', 'parent-lonely')).resolves.toEqual([]);
  });
});

describe('consolidation holds: no new hand-written viewer-scoped guardian join appears', () => {
  // The point of this module is that "which athletes may this parent reach"
  // has ONE definition. A VIEWER-SCOPED join is one that filters
  // guardian_links through a parent ACCOUNT (account_id = $n) -- the
  // privacy-bearing direction. Subject-scoped joins (athlete -> guardians,
  // staff roster surfaces) filter by athlete_id and are deliberately out of
  // scope. This sweep fails on any file that hand-writes the viewer-scoped
  // form instead of calling guardianAccess, unless it carries a reasoned
  // allowlist entry here.
  const ALLOWED = new Set([
    'guardianAccess.ts',
    // profileDb resolves relationships for the minor circle and is the only
    // place 'guardian_of_subject' is minted; its file header documents why
    // it stays self-contained (see guardianAccess.ts header).
    'profileDb.ts',
    // athletes/list projects full athlete rows through the link in one
    // statement; splitting it into ids-then-fetch would change its shape
    // for no privacy gain. The join is organization-scoped on both levels.
    'app/api/pilot/athletes/list/route.ts',
  ]);

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const resolved = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walk(resolved);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        yield resolved;
      }
    }
  }

  test('every server module and route either uses guardianAccess or is on the reasoned allowlist', () => {
    const webRoot = path.resolve(__dirname, '../../..');
    const roots = [__dirname, path.join(webRoot, 'app/api/pilot')];
    const offenders: string[] = [];

    for (const root of roots) {
      for (const file of walk(root)) {
        const relative = path.relative(webRoot, file).replace(/\\/g, '/').replace('src/server/pilot/', '');
        if (ALLOWED.has(relative)) continue;
        const source = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/\/\/[^\n]*/g, ' ');
        // The signature is per-STATEMENT, not per-file: a viewer-scoped
        // join names guardian_links and filters by a parent account inside
        // the same SQL literal. Subject-scoped reads (filter by athlete),
        // link CRUD, and org-wide admin listings all mention the table
        // without the account predicate and are legitimately inline.
        const sqlLiterals = source.match(/`[^`]*`|'[^']*'/g) ?? [];
        const handWritten = sqlLiterals.some(
          (literal) => literal.includes('pilot.guardian_links') && /account_id\s*=\s*\$\d/.test(literal),
        );
        if (handWritten) {
          offenders.push(relative);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

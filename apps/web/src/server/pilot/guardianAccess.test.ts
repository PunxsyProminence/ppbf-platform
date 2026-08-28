import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { queryOne, query } from './db';
import { guardianAthleteIds, guardianParentIdForAthlete, guardianParentIds, isGuardianLinkedToAthlete } from './guardianAccess';

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

  test('the parents join is organization-scoped on both levels', async () => {
    // The load-bearing clause. parent_id is only unique PER ORG (composite
    // primary key), so a join missing `p.organization_id = gl.organization_id`
    // could match another org's parents row carrying this account id and
    // widen the caller's athlete scope across the tenant boundary. Three
    // call sites' scope lists now ride on this one function -- the exact
    // consolidation risk this module's header names, pinned here the same
    // way the sibling check pins it.
    mockQuery.mockResolvedValueOnce([]);

    await guardianAthleteIds('org-1', 'parent-acct-1');

    const [sql] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('pilot.parents');
    expect(String(sql)).toContain('p.organization_id = gl.organization_id');
    expect(String(sql)).toContain('gl.organization_id = $1');
  });

  test('no links means [], never undefined -- an empty scope must match nothing', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await expect(guardianAthleteIds('org-1', 'parent-lonely')).resolves.toEqual([]);
  });
});

describe('guardianParentIds', () => {
  test('returns every pilot.parents row this account backs, in this org', async () => {
    mockQuery.mockResolvedValueOnce([{ parent_id: 'p1' }, { parent_id: 'p2' }]);

    await expect(guardianParentIds('org-1', 'parent-acct-1')).resolves.toEqual(['p1', 'p2']);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('pilot.parents');
    expect(String(sql)).toContain('organization_id = $1');
    expect(String(sql)).toContain('account_id = $2');
    expect(params).toEqual(['org-1', 'parent-acct-1']);
  });

  test('no rows means [], never undefined', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await expect(guardianParentIds('org-1', 'parent-lonely')).resolves.toEqual([]);
  });
});

describe('guardianParentIdForAthlete', () => {
  test('resolves the parent_id that is actually a guardian_links guardian of the given athlete', async () => {
    mockQueryOne.mockResolvedValueOnce({ parent_id: 'p1', full_name: 'Jane Guardian' });

    const result = await guardianParentIdForAthlete('org-a', 'acct-parent', 'ath-1');

    expect(result).toEqual({ parentId: 'p1', fullName: 'Jane Guardian' });
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(String(sql)).toContain('join pilot.guardian_links');
    expect(params).toEqual(['org-a', 'acct-parent', 'ath-1']);
  });

  test('null when this account has no parent row linked to this specific athlete', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await guardianParentIdForAthlete('org-a', 'acct-parent', 'ath-1');

    expect(result).toBeNull();
  });

  // T-008 round-8 review finding: an account backing two parent rows, each
  // guardian of a DIFFERENT child, must never resolve the wrong one just
  // because it happened to be "first". Athlete-scoping the join (not just an
  // ORDER BY) is what makes that structurally impossible rather than merely
  // unlikely.
  test('an account backing two parent rows for two different children resolves the one actually linked to the requested athlete', async () => {
    mockQueryOne.mockImplementation(async (_sql: string, params: unknown[] = []) => {
      const athleteId = params[2];
      if (athleteId === 'ath-1') return { parent_id: 'parent-1', full_name: 'Parent One' };
      if (athleteId === 'ath-2') return { parent_id: 'parent-2', full_name: 'Parent Two' };
      return null;
    });

    const result = await guardianParentIdForAthlete('org-a', 'acct-parent', 'ath-2');

    expect(result).toEqual({ parentId: 'parent-2', fullName: 'Parent Two' });
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
    // for no privacy gain. The join is organization-scoped on both levels
    // AND filters a.deleted_at -- this entry once said only the former, and
    // the missing soft-delete filter rode in under it: an exemption granted
    // for one property reads as an exemption from all of them. The route's
    // real statement is executed against a withdrawn athlete by
    // softDeletedAthleteAccess.pg.test.ts rather than trusted to this note.
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

  // One left-to-right tokenizing pass, so comments and string literals
  // shield each other: a `//` inside a URL string is consumed as string
  // content (stripping it first truncated the literal and desynchronized
  // every later quote pairing in the file -- a real bug: any file with an
  // https:// string above its SQL was effectively unswept), and a quote
  // inside a comment is consumed as comment content. Escapes handled.
  function sqlLiteralsOf(source: string): string[] {
    const tokens = source.match(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:[^`\\]|\\[\s\S])*`|'(?:[^'\\\n]|\\[\s\S])*'|"(?:[^"\\\n]|\\[\s\S])*"/g,
    ) ?? [];
    return tokens.filter((token) => token.startsWith('`') || token.startsWith("'") || token.startsWith('"'));
  }

  // The signature is per-STATEMENT, not per-file: a viewer-scoped join
  // names guardian_links and filters by a parent account inside the same
  // SQL literal. The account predicate covers the codebase's parameter
  // idioms -- `= $n`, `= any($n...)`, `in ($n`, and dynamically indexed
  // `$${...}` -- not just bare positional equality. Subject-scoped reads
  // (filter by athlete), link CRUD, and org-wide admin listings all mention
  // the table without an account predicate and are legitimately inline.
  const VIEWER_SCOPED = (literal: string): boolean =>
    literal.includes('pilot.guardian_links') && /account_id\s*(=|in\s*\()\s*(any\s*\(\s*)?\$/.test(literal);

  test('the sweep catches its target patterns (probe self-test)', () => {
    // Teeth, proven inline: the canonical join is flagged even when an
    // https:// URL string precedes it (the tokenizer-order regression), and
    // the house-style variants are flagged too.
    const canonical = '`select athlete_id from pilot.guardian_links where account_id = $1`';
    const withUrlAbove = "const help = 'see https://example.com/docs';\nconst sql = " + canonical + ';';
    expect(sqlLiteralsOf(withUrlAbove).some(VIEWER_SCOPED)).toBe(true);
    expect(sqlLiteralsOf('const sql = `from pilot.guardian_links where p.account_id = any($2::text[])`;').some(VIEWER_SCOPED)).toBe(true);
    expect(sqlLiteralsOf('const sql = `from pilot.guardian_links where account_id in ($2)`;').some(VIEWER_SCOPED)).toBe(true);
    expect(sqlLiteralsOf('const sql = `from pilot.guardian_links where account_id = $${i}`;').some(VIEWER_SCOPED)).toBe(true);
    // And the legitimate shapes stay clean: subject-scoped and link CRUD.
    expect(sqlLiteralsOf('const sql = `from pilot.guardian_links where athlete_id = $2`;').some(VIEWER_SCOPED)).toBe(false);
    expect(sqlLiteralsOf('const sql = `insert into pilot.guardian_links (organization_id) values ($1)`;').some(VIEWER_SCOPED)).toBe(false);
  });

  test('every server module and route either uses guardianAccess or is on the reasoned allowlist', () => {
    const webRoot = path.resolve(__dirname, '../../..');
    const roots = [__dirname, path.join(webRoot, 'app/api/pilot')];
    const offenders: string[] = [];

    for (const root of roots) {
      for (const file of walk(root)) {
        const relative = path.relative(webRoot, file).replace(/\\/g, '/').replace('src/server/pilot/', '');
        if (ALLOWED.has(relative)) continue;
        if (sqlLiteralsOf(readFileSync(file, 'utf8')).some(VIEWER_SCOPED)) {
          offenders.push(relative);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

/**
 * Every row lock on pilot.guardian_links goes through guardianConsent.ts's
 * lock helpers, so there is one lock order to reason about. The retention
 * purge script cannot import that file and holds the one sanctioned copy of
 * lockGuardianLinksForPurge's statement, which must stay identical.
 * guardianLinkLockOrder.pg.test.ts proves the order keeps the lockers out of a
 * deadlock; this keeps a new locker from quietly skipping it.
 *
 * It parses string and template literals in non-test source under src/, app/
 * and scripts/: a literal that names pilot.guardian_links and carries a FOR
 * SHARE/UPDATE clause is a lock. A lock assembled across separate literals, or
 * the implicit lock of a plain UPDATE/DELETE or a cascade, would slip past;
 * nothing here builds one that way, and the helper is the easier thing to call.
 */

import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

const WEB_ROOT = path.resolve(__dirname, '../../..');
const SCAN_ROOTS = ['src', 'app', 'scripts'].map((dir) => path.join(WEB_ROOT, dir));
const HELPER_FILE = path.join(WEB_ROOT, 'src/server/pilot/guardianConsent.ts');
const PURGE_SCRIPT = path.join(WEB_ROOT, 'scripts/pilot-cleanup-deleted-data.mjs');

const LOCK_CLAUSE = /\bfor\s+(?:no\s+key\s+update|key\s+share|update|share)\b|\bfor\s+\$\{/i;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.(?:tsx?|mjs)$/.test(entry.name) && !/\.test\.(?:tsx?|mjs)$/.test(entry.name) ? [full] : [];
  });
}

// Literals come from the TypeScript parser, not a regex, so an apostrophe in
// a comment cannot knock a real template literal out of alignment. A
// template's interpolations are kept as `${` so `for ${mode}` still counts.
function literals(text: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      found.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      found.push([node.head.text, ...node.templateSpans.map((span) => `\${${span.literal.text}`)].join(''));
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile('scan.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  return found;
}

function guardianLinkLocks(text: string): string[] {
  // Parsing is the slow part; a file that never names the table has no lock on it.
  if (!/guardian_links/i.test(text)) return [];
  return literals(text).filter(
    (literal) => /pilot\.guardian_links/i.test(literal) && LOCK_CLAUSE.test(literal),
  );
}

describe('guardian_links row locks', () => {
  test('the scanner recognises a raw lock, and ignores a plain read', () => {
    expect(guardianLinkLocks("q(`select 1 from pilot.guardian_links where athlete_id = $1\n for update`)")).toHaveLength(1);
    expect(guardianLinkLocks("q('SELECT parent_id FROM pilot.guardian_links FOR SHARE')")).toHaveLength(1);
    expect(guardianLinkLocks("q('select parent_id from pilot.guardian_links where athlete_id = $1')")).toHaveLength(0);
  });

  test('are taken only by the helpers in guardianConsent.ts and the purge script', () => {
    const offenders = SCAN_ROOTS.flatMap(sourceFiles)
      .filter((file) => file !== HELPER_FILE && file !== PURGE_SCRIPT)
      .flatMap((file) => guardianLinkLocks(fs.readFileSync(file, 'utf8')).map(
        (literal) => `${path.relative(WEB_ROOT, file)}: ${literal.slice(0, 80)}`,
      ));
    expect(offenders).toEqual([]);
  });

  test('guardianConsent.ts holds exactly the four helper locks, each in the shared order', () => {
    const locks = guardianLinkLocks(fs.readFileSync(HELPER_FILE, 'utf8'));
    expect(locks).toHaveLength(4);
    const C = (column: string) => `${column} collate "C"`;
    // One athlete, every guardian.
    expect(locks.filter((l) => new RegExp(`order by ${C('parent_id')}\\s+for `).test(l))).toHaveLength(1);
    // Several athletes.
    expect(locks.filter((l) => l.includes(`order by ${C('athlete_id')}, ${C('parent_id')}`))).toHaveLength(1);
    // The purge.
    expect(locks.filter((l) => l.includes(`order by ${C('gl.organization_id')}, ${C('gl.athlete_id')}, ${C('gl.parent_id')}`))).toHaveLength(1);
    // The one-row lock names the whole key.
    expect(locks.filter((l) => /parent_id = \$2 and athlete_id = \$3\s+for update/.test(l))).toHaveLength(1);
  });

  test("the purge script's one lock is the same statement as lockGuardianLinksForPurge", () => {
    const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim();
    const scriptLocks = guardianLinkLocks(fs.readFileSync(PURGE_SCRIPT, 'utf8'));
    expect(scriptLocks).toHaveLength(1);
    const helperPurge = guardianLinkLocks(fs.readFileSync(HELPER_FILE, 'utf8'))
      .find((l) => l.includes('gl.organization_id, gl.parent_id'));
    expect(normalise(scriptLocks[0])).toBe(normalise(helperPurge ?? ''));
  });
});

/*
 * Every INSERT into pilot.guardian_links takes the consent-set lock EXCLUSIVE
 * in the same function, before it (consentSetLock.ts). A link added without it
 * is a guardian an in-flight consent reader never evaluates: the phantom
 * consentSetPhantom.pg.test.ts proves against real Postgres. Scans src/ and
 * app/; scripts/ seed fixtures and are not request paths.
 *
 * A textual check: it sees that the call precedes the insert in an enclosing
 * function, not that it ran on the same connection for the same athlete, and
 * it reads only a template's head. It catches the omission, which is the
 * failure that happened; the pg suite is what proves the lock works.
 */
const INSERT_INTO_LINKS = /insert\s+into\s+pilot\.guardian_links/i;
const EXCLUSIVE_CALL = /lock(?:ConsentSet|ConsentSets)\(\s*[^;]*?'exclusive'\s*,?\s*\)/;

function unguardedLinkInserts(text: string): string[] {
  if (!/guardian_links/i.test(text)) return [];
  const source = ts.createSourceFile('scan.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const offenders: string[] = [];
  const visit = (node: ts.Node) => {
    const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      ? node.text
      : ts.isTemplateExpression(node) ? node.head.text : null;
    if (literal !== null && INSERT_INTO_LINKS.test(literal)) {
      // The enclosing functions, nearest first: the lock may sit in the
      // function itself or around a callback handed to withTransaction.
      const scopes: ts.Node[] = [];
      for (let up: ts.Node | undefined = node.parent; up; up = up.parent) {
        if (ts.isFunctionLike(up)) scopes.push(up);
      }
      // Comments stripped, so a comment naming the call does not count as taking it.
      const before = (scope: ts.Node) => text
        .slice(scope.getStart(source), node.getStart(source))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (!scopes.some((scope) => EXCLUSIVE_CALL.test(before(scope)))) {
        offenders.push(literal.replace(/\s+/g, ' ').slice(0, 80));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return offenders;
}

describe('guardian_links inserts', () => {
  test('the scanner flags an insert with no exclusive consent-set lock before it', () => {
    expect(unguardedLinkInserts("async function f(c) { await c.query('insert into pilot.guardian_links (a) values ($1)'); }")).toHaveLength(1);
    expect(unguardedLinkInserts("async function f(c) { await c.query('insert into pilot.guardian_links (a) values ($1)'); await lockConsentSet(c, o, a, 'exclusive'); }")).toHaveLength(1);
    expect(unguardedLinkInserts("async function f(c) { await lockConsentSet(c, o, a, 'shared'); await c.query('insert into pilot.guardian_links (a) values ($1)'); }")).toHaveLength(1);
    expect(unguardedLinkInserts("async function f(c) { await lockConsentSet(c, o, a, 'exclusive'); await c.query(`insert into pilot.guardian_links (a) values ($1)`); }")).toHaveLength(0);
    expect(unguardedLinkInserts("async function f(c) {\n // lockConsentSet(c, o, a, 'exclusive')\n await c.query('insert into pilot.guardian_links (a) values ($1)'); }")).toHaveLength(1);
  });

  test('every one in src/ and app/ takes the exclusive consent-set lock first', () => {
    const files = ['src', 'app'].map((dir) => path.join(WEB_ROOT, dir)).flatMap(sourceFiles);
    const offenders = files.flatMap((file) => unguardedLinkInserts(fs.readFileSync(file, 'utf8')).map(
      (literal) => `${path.relative(WEB_ROOT, file)}: ${literal}`,
    ));
    expect(offenders).toEqual([]);
    // Found at least the two shipped writers, so an empty list is not a scan that matched nothing.
    const found = files.filter((file) => INSERT_INTO_LINKS.test(fs.readFileSync(file, 'utf8')));
    expect(found.length).toBeGreaterThanOrEqual(2);
  });
});

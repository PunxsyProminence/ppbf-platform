/**
 * Every row lock on pilot.guardian_links goes through guardianConsent.ts
 * (lockGuardianLinksForAthlete / lockGuardianLink), so there is one lock
 * order to reason about. guardianLinkLockOrder.pg.test.ts proves that order
 * keeps the sweep and the readers out of a deadlock; this keeps a new locker
 * from quietly skipping it.
 *
 * It parses string and template literals in non-test source under src/ and
 * app/: a literal that names pilot.guardian_links and carries a FOR
 * SHARE/UPDATE clause is a lock, and the two helper bodies are the only ones
 * allowed. A lock assembled across separate literals would slip past; nothing
 * here does that, and the helper is the easier thing to call.
 */

import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

const WEB_ROOT = path.resolve(__dirname, '../../..');
const SCAN_ROOTS = ['src', 'app'].map((dir) => path.join(WEB_ROOT, dir));
const HELPER_FILE = path.join(WEB_ROOT, 'src/server/pilot/guardianConsent.ts');

const LOCK_CLAUSE = /\bfor\s+(?:no\s+key\s+update|key\s+share|update|share)\b|\bfor\s+\$\{/i;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
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

  test('are taken only by the two helpers in guardianConsent.ts', () => {
    const offenders = SCAN_ROOTS.flatMap(sourceFiles)
      .filter((file) => file !== HELPER_FILE)
      .flatMap((file) => guardianLinkLocks(fs.readFileSync(file, 'utf8')).map(
        (literal) => `${path.relative(WEB_ROOT, file)}: ${literal.slice(0, 80)}`,
      ));
    expect(offenders).toEqual([]);
  });

  test('guardianConsent.ts holds exactly the two helper locks, and the set lock is ordered by parent_id', () => {
    const locks = guardianLinkLocks(fs.readFileSync(HELPER_FILE, 'utf8'));
    expect(locks).toHaveLength(2);
    const setLock = locks.find((literal) => /athlete_id = \$2/.test(literal) && !/parent_id = \$2/.test(literal));
    expect(setLock).toMatch(/order by parent_id\s+for /);
  });
});

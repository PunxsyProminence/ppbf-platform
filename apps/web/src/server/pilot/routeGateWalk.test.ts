// The route walker's role scanner, tested directly.
//
// WHY THIS FILE EXISTS (#1411). requireRoleLiterals in routeGateWalk.ts is the
// only thing that reads which roles a handler passes to requireRole, and
// apiRouteInventory.json pins what it reads. From the walker's first commit
// (#1302) its call pattern held one backspace byte (0x08) where the regex word
// boundary was meant: an escape that was unescaped once too often on its way
// into the file. A backspace is invisible in an editor and in a diff, the
// pattern matched nothing, every inventory row recorded "roleLiterals": [],
// and the drift test compared empty with empty and passed. No role list was
// pinned, so a pull request widening a route's roles was not caught.
//
// WHAT THIS FAILS ON.
//   1. The walker returning anything but the real role list of a named route.
//   2. requireRoleLiterals misreading any of the forms it documents: an inline
//      array, a same-file constant, a spread of one, an imported constant, a
//      call inside a same-file helper -- or matching a longer identifier that
//      merely ends in "requireRole".
//   3. A control or invisible character anywhere in the walker or in the
//      convention tests that consume it. Read as BYTES and checked by code
//      point, with no regex of its own to go wrong the same way.

import fs from 'node:fs';
import path from 'node:path';
import {
  blankLiterals,
  collectFunctionBodies,
  findHandlers,
  reachableNames,
  requireRoleLiterals,
  walkApiRoutes,
} from './routeGateWalk';

const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;

function lines(...source: string[]): string {
  return source.join(String.fromCharCode(LINE_FEED));
}

/** The role lists the first handler in `source` reaches, as the walker reads them. */
function literalsOf(source: string): string[] {
  const blanked = blankLiterals(source);
  const bodies = collectFunctionBodies(blanked);
  const [handler] = findHandlers(blanked);
  if (!handler) throw new Error('the fixture has no exported HTTP handler');
  return requireRoleLiterals(source, blanked, reachableNames(blanked, bodies, handler.span).spans);
}

describe('the walker reads the roles a real handler passes to requireRole', () => {
  // The named route. Its POST is `requireRole(principal, ['organization_admin',
  // 'admin'])` at app/api/admin/volunteers/route.ts:31, inline, with no branch
  // and no imported constant. If the route's roles are changed on purpose this
  // expectation moves with the inventory row, in the same pull request.
  const NAMED_ROUTE = 'app/api/admin/volunteers/route.ts#POST';

  test(`${NAMED_ROUTE} admits admin and organization_admin`, () => {
    const handler = walkApiRoutes().find((h) => h.id === NAMED_ROUTE);
    expect(handler).toBeDefined();
    expect(handler?.authorizationGates).toContain('requireRole');
    expect(handler?.roleLiterals).toEqual(['admin,organization_admin']);
  });
});

describe('requireRoleLiterals reads each form it documents', () => {
  test('an inline array, sorted and de-duplicated', () => {
    expect(literalsOf(lines(
      'export async function GET(request) {',
      '  const principal = await requirePrincipal(request);',
      "  requireRole(principal, ['coach', 'organization_admin', 'admin', 'coach']);",
      '}',
    ))).toEqual(['admin,coach,organization_admin']);
  });

  test('a same-file constant, and a spread of one', () => {
    expect(literalsOf(lines(
      "const READ_ROLES = ['coach', 'admin'] as const;",
      'export async function GET(request) {',
      '  const principal = await requirePrincipal(request);',
      '  requireRole(principal, READ_ROLES);',
      '}',
    ))).toEqual(['admin,coach']);
    expect(literalsOf(lines(
      "const READ_ROLES = ['coach', 'admin'] as const;",
      'export async function POST(request) {',
      '  const principal = await requirePrincipal(request);',
      "  requireRole(principal, [...READ_ROLES, 'parent']);",
      '}',
    ))).toEqual(['admin,coach,parent']);
  });

  test('an imported constant comes back as its expression, not as a guess', () => {
    expect(literalsOf(lines(
      "import { STAFF_ROLES } from './elsewhere';",
      'export async function GET(request) {',
      '  const principal = await requirePrincipal(request);',
      '  requireRole(principal, [...STAFF_ROLES]);',
      '}',
    ))).toEqual(['<[...STAFF_ROLES]>']);
  });

  test('a call inside a same-file helper is read, and two different lists are both kept', () => {
    expect(literalsOf(lines(
      'function gate(principal) {',
      "  requireRole(principal, ['board']);",
      '}',
      'export async function PATCH(request) {',
      '  const principal = await requirePrincipal(request);',
      '  gate(principal);',
      "  if (request.wide) requireRole(principal, ['coach', 'admin']);",
      '}',
    ))).toEqual(['admin,coach', 'board']);
  });

  test('a role named only in a comment or a string is not a call', () => {
    expect(literalsOf(lines(
      'export async function GET(request) {',
      "  // requireRole(principal, ['athlete']);",
      "  const note = \"requireRole(principal, ['parent'])\";",
      "  requireRole(principal, ['coach']);",
      '}',
    ))).toEqual(['coach']);
  });

  // The word boundary is what the backspace byte stood in for. Without it the
  // pattern would also read the role list of any function whose name merely
  // ends in "requireRole".
  test('a longer identifier ending in requireRole is not requireRole', () => {
    expect(literalsOf(lines(
      'export async function GET(request) {',
      '  const principal = await requirePrincipal(request);',
      "  neverrequireRole(principal, ['athlete']);",
      '}',
    ))).toEqual([]);
  });
});

/**
 * Characters that change what source means without being visible in an editor
 * or a diff: the C0 controls other than line feed (and a carriage return that
 * is half of a CRLF), DEL, the C1 controls, and the Unicode format and
 * separator characters that hide or reorder text. A tab is refused too: none
 * of the guarded files has one, and inside a regex it is one more thing nobody
 * can see.
 */
function invisibleCharacters(bytes: Buffer): string[] {
  const text = bytes.toString('utf8');
  const found: string[] = [];
  let line = 1;
  let column = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    column += 1;
    if (code === LINE_FEED) {
      line += 1;
      column = 0;
      continue;
    }
    if (code === CARRIAGE_RETURN && text.charCodeAt(i + 1) === LINE_FEED) continue;
    const invisible = code < 0x20
      || (code >= 0x7f && code <= 0x9f)
      || code === 0xad
      || (code >= 0x200b && code <= 0x200f)
      || (code >= 0x2028 && code <= 0x202e)
      || (code >= 0x2060 && code <= 0x2069)
      || code === 0xfeff
      || code === 0xfffd;
    if (invisible) found.push(`line ${line}, column ${column}: U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
  }
  return found;
}

describe('no control or invisible character hides in the walker or its convention tests', () => {
  const GUARDED_FILES = [
    'routeGateWalk.ts',
    'routeGateWalk.test.ts',
    'apiRouteInventory.convention.test.ts',
    'routeGateDeclaration.convention.test.ts',
    'signOutGate.convention.test.ts',
  ];

  test.each(GUARDED_FILES)('%s', (name) => {
    const offenders = invisibleCharacters(fs.readFileSync(path.join(__dirname, name)));
    if (offenders.length > 0) {
      throw new Error(
        `${name} holds characters that cannot be seen in an editor or a diff. `
        + 'In a regex literal one of these silently replaces the escape that was meant '
        + '(#1411: a backspace where a word boundary belonged). Remove or retype them: '
        + offenders.join('; '),
      );
    }
  });

  test('the scan itself sees a backspace inside a regex literal, and passes clean source', () => {
    const backspace = String.fromCharCode(8);
    const poisoned = Buffer.from(lines('const ok = 1;', `const callPattern = /${backspace}requireRole/g;`), 'utf8');
    expect(invisibleCharacters(poisoned)).toEqual(['line 2, column 22: U+0008']);
    for (const code of [0, 9, 11, 27, 127, 133, 173, 0x200b, 0x2028, 0x202e, 0xfeff]) {
      expect(invisibleCharacters(Buffer.from(`a${String.fromCharCode(code)}b`, 'utf8'))).toHaveLength(1);
    }
    expect(invisibleCharacters(Buffer.from([0x61, 0xff, 0x62]))).toHaveLength(1);
    const crlf = String.fromCharCode(CARRIAGE_RETURN, LINE_FEED);
    expect(invisibleCharacters(Buffer.from(`const a = 1;${crlf}const b = 'caf${String.fromCharCode(0xe9)}';${crlf}`, 'utf8'))).toEqual([]);
    expect(invisibleCharacters(Buffer.from(`lone${String.fromCharCode(CARRIAGE_RETURN)}return`, 'utf8'))).toHaveLength(1);
  });
});

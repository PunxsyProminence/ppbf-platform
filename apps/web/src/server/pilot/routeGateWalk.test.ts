// The route walker's role scanner, tested directly.
//
// WHY THIS FILE EXISTS (#1411). requireRoleLiterals in routeGateWalk.ts is the
// only thing that reads which roles a handler passes to requireRole, and
// apiRouteInventory.json pins what it reads. From the walker's first commit
// (#1302) its call pattern held one backspace byte (0x08) where the regex word
// boundary was meant. A backspace is invisible in an editor and in a diff, the
// pattern matched nothing, every inventory row recorded "roleLiterals": [],
// and the drift test compared empty with empty and passed. No role list was
// pinned, so a pull request widening a route's roles was not caught.
//
// WHAT THIS FAILS ON.
//   1. The walker returning anything but the real role list of two named
//      routes (one inline array, one same-file constant).
//   2. requireRoleLiterals misreading any form it documents, or -- worse than
//      reading nothing -- resolving a name to the wrong array: a constant that
//      a parameter or a second declaration shadows, one that exists only in a
//      comment, one that is filtered or pushed to after it is declared.
//   3. Any byte in the walker or in the convention tests that consume it that
//      is not printable ASCII or a line ending. Checked on the raw BYTES, with
//      no regex of its own to go wrong the same way.

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

/** The role lists one handler in `source` reaches, as the walker reads them. */
function literalsOf(source: string, method?: string): string[] {
  const blanked = blankLiterals(source);
  const bodies = collectFunctionBodies(blanked);
  const handlers = findHandlers(blanked);
  const handler = method ? handlers.find((h) => h.method === method) : handlers[0];
  if (!handler) throw new Error('the fixture has no such exported HTTP handler');
  return requireRoleLiterals(source, blanked, reachableNames(blanked, bodies, handler.span).spans);
}

describe('the walker reads the roles real handlers pass to requireRole', () => {
  const walked = walkApiRoutes();
  const rolesOf = (id: string): string[] | undefined => walked.find((h) => h.id === id)?.roleLiterals;

  // The named routes. If a route's roles are changed on purpose, its
  // expectation moves with its inventory row, in the same pull request.

  // `requireRole(principal, ['organization_admin', 'admin'])`, inline, at
  // app/api/admin/volunteers/route.ts:31.
  test('app/api/admin/volunteers/route.ts#POST admits admin and organization_admin (an inline array)', () => {
    expect(rolesOf('app/api/admin/volunteers/route.ts#POST')).toEqual(['admin,organization_admin']);
  });

  // `requireRole(principal, [...ADMIN_ROLES])` at
  // app/api/pilot/admin/credentials/route.ts:63, where line 58 declares
  // `const ADMIN_ROLES = ['organization_admin', 'admin'] as const;`.
  test('app/api/pilot/admin/credentials/route.ts#GET admits admin and organization_admin (a same-file constant)', () => {
    expect(rolesOf('app/api/pilot/admin/credentials/route.ts#GET')).toEqual(['admin,organization_admin']);
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
      "export const READ_ROLES: readonly PilotRole[] = ['coach', 'admin'] as const satisfies readonly PilotRole[];",
      "const WRITE_ROLES = [...READ_ROLES, 'board'];",
      'export async function POST(request) {',
      '  const principal = await requirePrincipal(request);',
      "  requireRole(principal, [...WRITE_ROLES, 'parent']);",
      '}',
    ))).toEqual(['admin,board,coach,parent']);
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

  test('a conditional between two same-file lists yields both lists', () => {
    expect(literalsOf(lines(
      "const RAISE_ROLES = ['organization_admin', 'admin', 'coach'] as const;",
      "const REVIEW_ROLES = ['organization_admin', 'admin'] as const;",
      'export async function PATCH(request) {',
      '  const principal = await requirePrincipal(request);',
      '  requireRole(principal, TIERS.has(request.tier) ? [...REVIEW_ROLES] : [...RAISE_ROLES]);',
      '}',
    ))).toEqual(['admin,coach,organization_admin', 'admin,organization_admin']);
    // One unreadable branch and the whole expression is reported, not half of it.
    expect(literalsOf(lines(
      "const REVIEW_ROLES = ['organization_admin', 'admin'] as const;",
      'export async function PATCH(request) {',
      '  const principal = await requirePrincipal(request);',
      '  requireRole(principal, request.wide ? [...IMPORTED_ROLES] : [...REVIEW_ROLES]);',
      '}',
    ))).toEqual(['<request.wide ? [...IMPORTED_ROLES] : [...REVIEW_ROLES]>']);
  });

  test('a comment between elements, a trailing comma and a third argument change nothing', () => {
    expect(literalsOf(lines(
      'const READ_ROLES = [',
      "  'coach', // the head coach",
      "  /* and */ 'admin',",
      '] as const;',
      'export async function GET(request) {',
      '  const principal = await requirePrincipal(request);',
      '  requireRole(',
      '    principal,',
      "    [...READ_ROLES, 'parent', /* family */],",
      '  );',
      "  requireRole(principal, ['board'], 'ignored');",
      '}',
    ))).toEqual(['admin,coach,parent', 'board']);
  });

  test('a role named only in a comment or a string is not a call', () => {
    expect(literalsOf(lines(
      'export async function GET(request) {',
      "  // requireRole(principal, ['athlete']);",
      '  const note = "requireRole(principal, [1])";',
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
      "  $requireRole(principal, ['parent']);",
      '}',
    ))).toEqual([]);
  });
});

// Found while repairing the scanner (#1411 review): an expression-bodied arrow
// helper used to be given "the next brace in the file" as its body, which is
// the body of whichever function follows it. Two inventory rows
// (coach/intervention-review POST and PATCH) recorded a gate that only GET
// calls, through `const optionalString = (value) => typeof value === ...`.
describe('a helper is credited with its own body, never the next function', () => {
  const reached = (source: string, method: string): string[] => {
    const blanked = blankLiterals(source);
    const handler = findHandlers(blanked).find((h) => h.method === method);
    if (!handler) throw new Error('the fixture has no such exported HTTP handler');
    return [...reachableNames(blanked, collectFunctionBodies(blanked), handler.span).reached].sort();
  };

  const source = lines(
    "const text = (value: unknown): string => (typeof value === 'string' ? value : '');",
    'export async function GET(request) {',
    '  const principal = await requirePrincipal(request);',
    "  requireRole(principal, ['organization_admin']);",
    '  await accessibleAthleteIds(principal, []);',
    '}',
    'export async function DELETE(request) {',
    '  const id = text(request.id);',
    '  await remove(id);',
    '}',
  );

  test('a handler that calls an expression-bodied helper does not inherit the next handler', () => {
    expect(reached(source, 'DELETE')).toEqual(['remove', 'text']);
    expect(literalsOf(source, 'DELETE')).toEqual([]);
    expect(reached(source, 'GET')).toEqual(['accessibleAthleteIds', 'requirePrincipal', 'requireRole']);
    expect(literalsOf(source, 'GET')).toEqual(['organization_admin']);
  });

  test('a gate inside an arrow helper still counts, block body or expression body', () => {
    const gated = lines(
      "const gateBlock = (principal): { ok: boolean } => {",
      "  requireRole(principal, ['coach']);",
      '  return { ok: true };',
      '};',
      "const gateExpression = async (principal) => requireRole(principal, ['board']);",
      'export async function GET(request) {',
      '  gateBlock(await requirePrincipal(request));',
      '}',
      'export async function POST(request) {',
      '  await gateExpression(await requirePrincipal(request));',
      '}',
    );
    expect(literalsOf(gated, 'GET')).toEqual(['coach']);
    expect(literalsOf(gated, 'POST')).toEqual(['board']);
  });

  test('a parenthesised value is not a function', () => {
    const bodies = collectFunctionBodies(blankLiterals(lines(
      'export async function POST(request) {',
      '  const body = (await request.json()) as { name?: string };',
      '  const total = (body.a + body.b) * 2;',
      '  const pick = (x) => { return x; };',
      '  return pick(total);',
      '}',
    )));
    expect([...bodies.keys()].sort()).toEqual(['POST', 'pick']);
  });
});

// A wrong list pinned as the right one is worse than no list: the inventory
// would then vouch for it. Where the walker cannot be sure which array a name
// means, it must say '<NAME>'.
describe('requireRoleLiterals does not resolve a name it cannot be sure of', () => {
  test('two handlers each with their own local constant of the same name', () => {
    const source = lines(
      'export async function GET(request) {',
      "  const roles = ['organization_admin'];",
      '  requireRole(principal, roles);',
      '}',
      'export async function POST(request) {',
      "  const roles = ['organization_admin', 'coach', 'parent'];",
      '  requireRole(principal, roles);',
      '}',
    );
    expect(literalsOf(source, 'GET')).toEqual(['<roles>']);
    expect(literalsOf(source, 'POST')).toEqual(['<roles>']);
  });

  test('a module constant shadowed by a parameter of the same name', () => {
    expect(literalsOf(lines(
      "const roles = ['organization_admin'];",
      'function gate(principal, roles) {',
      '  requireRole(principal, roles);',
      '}',
      'export async function GET(request) {',
      "  gate(principal, ['athlete', 'parent']);",
      '}',
    ))).toEqual(['<roles>']);
    expect(literalsOf(lines(
      "const roles = ['organization_admin'];",
      'const gate = (principal, roles) => {',
      '  requireRole(principal, [...roles]);',
      '};',
      'export async function GET(request) {',
      "  gate(principal, ['athlete', 'parent']);",
      '}',
    ))).toEqual(['<[...roles]>']);
  });

  test('a declaration that exists only inside a comment or a template string', () => {
    expect(literalsOf(lines(
      "const READ_ROLES = ['organization_admin'] as const;",
      '/*',
      "const READ_ROLES = ['organization_admin', 'coach', 'parent'];",
      '*/',
      'const help = `',
      "const READ_ROLES = ['athlete'];",
      '`;',
      'export async function GET(request) {',
      '  requireRole(principal, READ_ROLES);',
      '}',
    ))).toEqual(['organization_admin']);
  });

  test('an array that is filtered, or pushed to, after it is declared', () => {
    expect(literalsOf(lines(
      "const STAFF = ['coach', 'parent'].filter((role) => role !== 'parent');",
      'export async function GET(request) {',
      '  requireRole(principal, STAFF);',
      '}',
    ))).toEqual(['<STAFF>']);
    expect(literalsOf(lines(
      "const ALLOWED = ['coach'];",
      'export async function GET(request) {',
      "  if (request.family) ALLOWED.push('parent');",
      '  requireRole(principal, ALLOWED);',
      '}',
    ))).toEqual(['<ALLOWED>']);
  });

  test('an element that is not a plain string or a known constant', () => {
    expect(literalsOf(lines(
      'export async function GET(request) {',
      "  requireRole(principal, ['coach', `admin`]);",
      '}',
    ))).toEqual(["<['coach', `admin`]>"]);
  });
});

/**
 * Every byte that is not printable ASCII (0x20 to 0x7E), a line feed, or the
 * carriage return of a CRLF pair. That refuses the control characters (a tab
 * included: none of the guarded files has one), DEL, and every non-ASCII
 * character, visible or not -- these files are pure ASCII, and "ASCII only"
 * needs no table of which Unicode characters happen to be invisible.
 */
function unexpectedBytes(bytes: Buffer): string[] {
  const found: string[] = [];
  let line = 1;
  let column = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    column += 1;
    if (byte === LINE_FEED) {
      line += 1;
      column = 0;
      continue;
    }
    if (byte === CARRIAGE_RETURN && bytes[i + 1] === LINE_FEED) continue;
    if (byte < 0x20 || byte > 0x7e) {
      found.push(`line ${line}, byte ${column}: 0x${byte.toString(16).toUpperCase().padStart(2, '0')}`);
    }
  }
  return found;
}

describe('the walker and its convention tests hold only printable ASCII', () => {
  // The walker and every file that imports it.
  const GUARDED_FILES = [
    'routeGateWalk.ts',
    'routeGateWalk.test.ts',
    'apiRouteInventory.convention.test.ts',
    'routeGateDeclaration.convention.test.ts',
    'signOutGate.convention.test.ts',
  ];

  test.each(GUARDED_FILES)('%s', (name) => {
    const offenders = unexpectedBytes(fs.readFileSync(path.join(__dirname, name)));
    if (offenders.length > 0) {
      throw new Error(
        `${name} holds bytes that are not printable ASCII. In a regex literal a control `
        + 'character silently replaces the escape that was meant (#1411: a backspace where a '
        + 'word boundary belonged), and it cannot be seen in an editor or a diff. Retype '
        + 'them as escapes or plain ASCII: ' + offenders.slice(0, 20).join('; '),
      );
    }
  });

  test('the scan itself sees a backspace inside a regex literal, and passes clean source', () => {
    const backspace = String.fromCharCode(8);
    const poisoned = Buffer.from(lines('const ok = 1;', `const callPattern = /${backspace}requireRole/g;`), 'latin1');
    expect(unexpectedBytes(poisoned)).toEqual(['line 2, byte 22: 0x08']);
    for (const byte of [0, 9, 11, 27, 127, 128, 160, 255]) {
      expect(unexpectedBytes(Buffer.from([97, byte, 98]))).toHaveLength(1);
    }
    // A zero-width space is three bytes in UTF-8, none of them ASCII.
    expect(unexpectedBytes(Buffer.from(`a${String.fromCharCode(0x200b)}b`, 'utf8'))).toHaveLength(3);
    const crlf = String.fromCharCode(CARRIAGE_RETURN, LINE_FEED);
    expect(unexpectedBytes(Buffer.from(`const a = 1;${crlf}const b = '~';${crlf}`, 'latin1'))).toEqual([]);
    expect(unexpectedBytes(Buffer.from(`lone${String.fromCharCode(CARRIAGE_RETURN)}return`, 'latin1'))).toHaveLength(1);
  });
});

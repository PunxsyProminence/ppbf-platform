// Convention gate: every exported HTTP handler under app/api has a row in the
// committed inventory (apiRouteInventory.json), and that row still describes
// the code.
//
// WHAT THE INVENTORY IS. One row per handler: the gate that decides who may
// call it, the roles admitted, whether it touches athlete (minors') data,
// whether it writes, whether the coach-reach rule is applied, and a
// reviewer's flag when something looks wider than the data warrants. The
// judgment columns were drafted by small-model readers and spot-checked by
// the lane lead (PR body says how); they are a DRAFT read of the code, not
// proof. The mechanical columns -- which gate helpers the handler reaches and
// which role arrays it passes to requireRole -- are recomputed from disk here,
// every run, by the same walker routeGateDeclaration.convention.test.ts uses.
//
// WHAT THIS FAILS ON.
//   1. A handler with no inventory row (a new route shipped without a
//      declared gate/roles), or a row whose handler no longer exists.
//   2. A row whose mechanical facts no longer match the code: a gate removed
//      or added, a requireRole array changed. The row must be re-read and
//      re-committed, which is the point -- the reviewer sees the diff.
//   3. A row that declares no gate, or no admitted roles while the code does
//      resolve a session (an unauthenticated-by-design route may declare []).
//   4. A row whose admitted roles contradict the single inline requireRole
//      array the handler reaches, where that is the only authorization gate.
//   5. A scanner that has gone blind: a handler that reaches requireRole but
//      for which the walker read no role list, or an inventory in which no
//      row records one. From #1302 until #1411 the role scanner's pattern
//      held a backspace byte where a word boundary was meant, matched nothing,
//      and every row carried "roleLiterals": [] while (2) above passed --
//      empty agreed with empty. (routeGateWalk.test.ts guards the byte.)
//
// REGENERATING THE MECHANICAL COLUMNS. Run this file with
// UPDATE_API_ROUTE_INVENTORY=1 and it rewrites each existing row's
// `mechanical` block from the walker before the tests read the file. The run
// that rewrites the file fails on purpose, once, to say so. What the tool
// does and does not vouch for is written at rewriteInventoryIfAsked below.
//
// WHAT IT DOES NOT ASSERT. It has no opinion about whether the roles admitted
// are the RIGHT roles; that is the owner's call and the `looksWrong` column is
// where the draft says so. routeGateDeclaration.convention.test.ts remains the
// gate that says "declare something"; this one says "and keep the declaration
// true".

import fs from 'node:fs';
import path from 'node:path';
import { walkApiRoutes, type WalkedHandler } from './routeGateWalk';

const INVENTORY_PATH = path.join(__dirname, 'apiRouteInventory.json');

const ROLE_NAMES = new Set([
  'platform_owner',
  'organization_admin',
  'admin',
  'coach',
  'athlete',
  'parent',
  'board',
  'volunteer',
  'staff',
  'any-authenticated',
]);

export interface InventoryRow {
  id: string;
  method: string;
  path: string;
  gate: string;
  rolesAdmitted: string[];
  athleteData: boolean;
  writes: boolean;
  coachReachRule: 'applied' | 'not-applied' | 'n/a';
  missingGate: boolean;
  looksWrong: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string;
  mechanical: {
    sessionGates: string[];
    authorizationGates: string[];
    roleLiterals: string[];
  };
}

function loadInventory(): InventoryRow[] {
  return JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8')) as InventoryRow[];
}

export const UPDATE_VARIABLE = 'UPDATE_API_ROUTE_INVENTORY';

const LINE_FEED = String.fromCharCode(10);

/**
 * The rows with each `mechanical` block replaced by what the walker reads
 * today. Nothing else moves: no row is added, removed or reordered, a row
 * whose handler is gone is left exactly as it is (the stale-row test names
 * it), and every judgment column keeps its value and its key position.
 */
export function regenerateMechanical(rows: InventoryRow[], walked: WalkedHandler[]): InventoryRow[] {
  const liveById = new Map(walked.map((h) => [h.id, h]));
  return rows.map((row) => {
    const handler = liveById.get(row.id);
    return handler ? { ...row, mechanical: inventoryRowFor(handler).mechanical } : row;
  });
}

/** The committed file's exact form: two-space JSON and one trailing newline. */
export function serializeInventory(rows: InventoryRow[]): string {
  return JSON.stringify(rows, null, 2) + LINE_FEED;
}

export type RewriteOutcome = 'not-asked' | 'unchanged' | 'rewritten';

/**
 * The inventory's only generator, and it is opt-in: it does nothing unless
 * UPDATE_API_ROUTE_INVENTORY is exactly '1'. It refuses to run under CI,
 * where rewriting the file first would make the drift test below pass
 * whatever the code says.
 *
 * It saves typing. It does not bless a change: every row it rewrites must
 * still be re-read by a person against its handler before the diff is
 * committed, and rolesAdmitted / coachReachRule / looksWrong / notes updated
 * by hand where the new facts change them -- those columns were written for
 * the old facts.
 */
export function rewriteInventoryIfAsked(
  env: Record<string, string | undefined>,
  walked: WalkedHandler[],
  io: { read: () => string; write: (text: string) => void },
): RewriteOutcome {
  if (env[UPDATE_VARIABLE] !== '1') return 'not-asked';
  if (env.CI || env.GITHUB_ACTIONS || env.TF_BUILD) {
    throw new Error(
      `${UPDATE_VARIABLE} is set under CI. The inventory is regenerated on a `
      + 'developer machine and the diff is reviewed; CI only checks it.',
    );
  }
  // A checkout that converted line endings still holds the same inventory.
  const before = io.read().split(String.fromCharCode(13) + LINE_FEED).join(LINE_FEED);
  const after = serializeInventory(regenerateMechanical(JSON.parse(before) as InventoryRow[], walked));
  if (after === before) return 'unchanged';
  io.write(after);
  return 'rewritten';
}

/** admin and organization_admin satisfy each other (roleAlias.ts). */
function canonicalRoles(roles: string[]): string[] {
  return [...new Set(roles.map((r) => (r === 'admin' ? 'organization_admin' : r)))].sort();
}

describe('every API handler has a row in the committed inventory, and the row still describes the code', () => {
  const walked = walkApiRoutes();
  const rewrite = rewriteInventoryIfAsked(process.env, walked, {
    read: () => fs.readFileSync(INVENTORY_PATH, 'utf8'),
    write: (text) => fs.writeFileSync(INVENTORY_PATH, text, 'utf8'),
  });
  const inventory = loadInventory();

  // A run that rewrote the file must not be green: the drift test below has
  // just been handed a file that cannot drift, and the variable stays set for
  // the rest of a PowerShell session. It fails once, here, and says what to do.
  test('this run did not regenerate the inventory', () => {
    if (rewrite === 'rewritten') {
      throw new Error(
        `apiRouteInventory.json was regenerated by this run (${UPDATE_VARIABLE}=1): each changed `
        + "row's mechanical block now says what the walker reads. Read the diff row by row "
        + 'against each handler, update the judgment columns the new facts change, then unset '
        + `${UPDATE_VARIABLE} and run this file again.`,
      );
    }
  });
  const byId = new Map(inventory.map((row) => [row.id, row]));
  const liveIds = new Set(walked.map((h) => h.id));

  test('the walk still examines the whole tree', () => {
    expect(walked.length).toBeGreaterThan(300);
  });

  test('every handler on disk has exactly one inventory row', () => {
    const missing = walked.map((h) => h.id).filter((id) => !byId.has(id));
    const duplicates = inventory.map((r) => r.id).filter((id, i, all) => all.indexOf(id) !== i);
    if (missing.length > 0 || duplicates.length > 0) {
      throw new Error(
        'Handlers with no inventory row (add one to apiRouteInventory.json '
        + 'saying which gate decides who may call it and which roles it admits):\n  '
        + missing.join('\n  ')
        + (duplicates.length > 0 ? '\nDuplicate rows:\n  ' + duplicates.join('\n  ') : ''),
      );
    }
  });

  test('every inventory row names a handler that still exists', () => {
    const stale = inventory.map((r) => r.id).filter((id) => !liveIds.has(id));
    expect(stale).toEqual([]);
  });

  test('every row declares a gate, admitted roles, and the three yes/no columns', () => {
    const offenders: string[] = [];
    for (const row of inventory) {
      const problems: string[] = [];
      if (typeof row.gate !== 'string' || row.gate.trim().length === 0) problems.push('gate empty');
      if (!Array.isArray(row.rolesAdmitted)) problems.push('rolesAdmitted not an array');
      else {
        const bad = row.rolesAdmitted.filter((r) => !ROLE_NAMES.has(r));
        if (bad.length > 0) problems.push(`unknown roles: ${bad.join(',')}`);
        if (row.rolesAdmitted.length === 0 && row.mechanical.sessionGates.length > 0) {
          problems.push('rolesAdmitted empty but the handler resolves a session');
        }
      }
      if (typeof row.athleteData !== 'boolean') problems.push('athleteData not boolean');
      if (typeof row.writes !== 'boolean') problems.push('writes not boolean');
      if (typeof row.missingGate !== 'boolean') problems.push('missingGate not boolean');
      if (!['applied', 'not-applied', 'n/a'].includes(row.coachReachRule)) problems.push('coachReachRule invalid');
      if (!['high', 'medium', 'low'].includes(row.confidence)) problems.push('confidence invalid');
      if (typeof row.notes !== 'string' || row.notes.trim().length < 20) problems.push('notes too thin');
      if (problems.length > 0) offenders.push(`${row.id}: ${problems.join('; ')}`);
    }
    if (offenders.length > 0) {
      throw new Error('Inventory rows that do not declare what they must:\n  ' + offenders.join('\n  '));
    }
  });

  test('the mechanical columns still match the code', () => {
    const drift: string[] = [];
    for (const h of walked) {
      const row = byId.get(h.id);
      if (!row) continue; // reported by the coverage test above
      const expected = {
        sessionGates: h.sessionGates,
        authorizationGates: h.authorizationGates,
        roleLiterals: h.roleLiterals,
      };
      if (JSON.stringify(row.mechanical) !== JSON.stringify(expected)) {
        drift.push(`${h.id}\n    inventory: ${JSON.stringify(row.mechanical)}\n    code:      ${JSON.stringify(expected)}`);
      }
    }
    if (drift.length > 0) {
      throw new Error(
        'The gates or role arrays these handlers reach have changed since their '
        + 'inventory row was written. Re-read the handler, update the row '
        + '(including rolesAdmitted / coachReachRule / looksWrong if the change '
        + 'affects them), and commit the diff:\n  '
        + drift.join('\n  '),
      );
    }
  });

  // The two tests that would have caught #1411. The drift test above compares
  // the walker with the file, so a walker that reads nothing and a file that
  // records nothing agree with each other; these two refuse that agreement.
  test('every handler that reaches requireRole has a role list the walker could read', () => {
    const blind = walked
      .filter((h) => h.authorizationGates.includes('requireRole') && h.roleLiterals.length === 0)
      .map((h) => h.id);
    if (blind.length > 0) {
      throw new Error(
        `${blind.length} handler(s) call requireRole but the walker read no role list from them. `
        + 'Either requireRoleLiterals in routeGateWalk.ts has stopped matching, or the call '
        + 'passes no second argument or does not close:' + LINE_FEED + '  ' + blind.join(LINE_FEED + '  '),
      );
    }
  });

  // Non-empty is not enough: a scanner that answered '<something>' for every
  // call would satisfy the test above. Most role lists are inline arrays or
  // same-file constants and must come back as role names (297 of the 386
  // handlers that reach requireRole when this was written; the rest import
  // their list). The floor is half, on disk and as walked.
  test('most handlers that reach requireRole have a role list read down to role names', () => {
    const named = (lists: string[]): boolean => lists.length > 0 && lists.every((list) => !list.startsWith('<'));
    const reaching = walked.filter((h) => h.authorizationGates.includes('requireRole'));
    expect(reaching.length).toBeGreaterThan(200);
    expect(reaching.filter((h) => named(h.roleLiterals)).length).toBeGreaterThan(reaching.length / 2);
    expect(inventory.filter((row) => named(row.mechanical.roleLiterals)).length).toBeGreaterThan(reaching.length / 2);
  });

  // Where the code's own role array is the only authorization gate, the
  // draft's rolesAdmitted must not be NARROWER than it: a row claiming the
  // route admits fewer roles than the code does is false assurance, which is
  // the one direction a draft must never err in. Wider is allowed, because a
  // requireRole inside one branch (announcements/get's authoring view) leaves
  // the other branch open to every session, and the row says so.
  test('rolesAdmitted is never narrower than a sole resolved requireRole array', () => {
    const disagree: string[] = [];
    for (const h of walked) {
      const row = byId.get(h.id);
      if (!row) continue;
      if (h.authorizationGates.length !== 1 || h.authorizationGates[0] !== 'requireRole') continue;
      if (h.roleLiterals.length !== 1 || h.roleLiterals[0].startsWith('<')) continue;
      if (row.rolesAdmitted.includes('any-authenticated')) continue;
      const fromCode = canonicalRoles(h.roleLiterals[0].split(','));
      const fromRow = new Set(canonicalRoles(row.rolesAdmitted));
      const omitted = fromCode.filter((r) => !fromRow.has(r));
      if (omitted.length > 0) {
        disagree.push(`${h.id}: code admits ${fromCode.join(',')}; inventory omits ${omitted.join(',')}`);
      }
    }
    if (disagree.length > 0) {
      throw new Error('Inventory rows whose rolesAdmitted contradicts the requireRole array in the code:\n  ' + disagree.join('\n  '));
    }
  });

  // A row is allowed to say the gate is missing; it is not allowed to say so
  // silently. Every missingGate=true row must carry a looksWrong sentence so
  // the list for the owner is the same list the test sees.
  test('every missingGate row says what looks wrong', () => {
    const silent = inventory.filter((r) => r.missingGate && (r.looksWrong ?? '').trim().length === 0).map((r) => r.id);
    expect(silent).toEqual([]);
  });
});

describe('the inventory regenerator is opt-in and rewrites only the mechanical block', () => {
  const handler = (id: string, roleLiterals: string[]): WalkedHandler => ({
    id,
    file: id.split('#')[0],
    method: id.split('#')[1],
    path: '/api/x',
    sessionGates: ['requireStaffSessionPrincipal'],
    authorizationGates: ['requireRole', 'assertActorCanAccessAthlete'],
    roleLiterals,
    coachReachGate: false,
    writesLikely: false,
    imports: [],
  });
  const row = (id: string, notes: string): InventoryRow => ({
    id,
    method: id.split('#')[1],
    path: '/api/x',
    gate: 'requirePrincipal + requireRole',
    rolesAdmitted: ['coach'],
    athleteData: true,
    writes: false,
    coachReachRule: 'applied',
    missingGate: false,
    looksWrong: 'kept',
    confidence: 'low',
    notes,
    mechanical: { sessionGates: ['requirePrincipal'], authorizationGates: ['requireRole'], roleLiterals: [] },
  });
  const rows = [
    row('app/api/b/route.ts#GET', 'second by name, first in the file'),
    row('app/api/a/route.ts#GET', 'first by name, second in the file'),
    row('app/api/gone/route.ts#GET', 'its handler has been deleted'),
  ];
  const walked = [
    handler('app/api/a/route.ts#GET', ['coach']),
    handler('app/api/b/route.ts#GET', ['admin,coach']),
    handler('app/api/new/route.ts#POST', ['parent']),
  ];
  const onDisk = serializeInventory(rows);

  test('without the variable set to exactly 1 it reads nothing and writes nothing', () => {
    for (const value of [undefined, '', '0', 'true', 'yes', ' 1', '11']) {
      const disk = { read: jest.fn(() => onDisk), write: jest.fn() };
      expect(rewriteInventoryIfAsked({ [UPDATE_VARIABLE]: value }, walked, disk)).toBe('not-asked');
      expect(disk.read).not.toHaveBeenCalled();
      expect(disk.write).not.toHaveBeenCalled();
    }
  });

  test('under CI it refuses rather than rewrite the file the drift test is about to read', () => {
    for (const runner of ['CI', 'GITHUB_ACTIONS', 'TF_BUILD']) {
      const disk = { read: jest.fn(() => onDisk), write: jest.fn() };
      expect(() => rewriteInventoryIfAsked({ [UPDATE_VARIABLE]: '1', [runner]: 'true' }, walked, disk)).toThrow(/under CI/);
      expect(disk.write).not.toHaveBeenCalled();
    }
  });

  test('a checkout with converted line endings is the same inventory, not a change', () => {
    const settled = serializeInventory(regenerateMechanical(rows, walked));
    const converted = settled.split(LINE_FEED).join(String.fromCharCode(13) + LINE_FEED);
    const disk = { read: jest.fn(() => converted), write: jest.fn() };
    expect(rewriteInventoryIfAsked({ [UPDATE_VARIABLE]: '1' }, walked, disk)).toBe('unchanged');
    expect(disk.write).not.toHaveBeenCalled();
  });

  test('asked, it rewrites the mechanical block and nothing else', () => {
    const disk = { read: jest.fn(() => onDisk), write: jest.fn() };
    expect(rewriteInventoryIfAsked({ [UPDATE_VARIABLE]: '1' }, walked, disk)).toBe('rewritten');
    expect(disk.write).toHaveBeenCalledTimes(1);
    const written = disk.write.mock.calls[0][0] as string;
    const after = JSON.parse(written) as InventoryRow[];
    // No row added (the new handler is the coverage test's to report), none
    // removed (the dead one is the stale-row test's), none reordered.
    expect(after.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    // All three mechanical columns of a live row are the walker's; the dead
    // row keeps the block it had.
    const live = { sessionGates: ['requireStaffSessionPrincipal'], authorizationGates: ['requireRole', 'assertActorCanAccessAthlete'] };
    expect(after.map((r) => r.mechanical)).toEqual([
      { ...live, roleLiterals: ['admin,coach'] },
      { ...live, roleLiterals: ['coach'] },
      rows[2].mechanical,
    ]);
    // Every judgment column, and the order of the keys, is untouched.
    const judgment = (r: InventoryRow): Partial<InventoryRow> => ({ ...r, mechanical: undefined });
    expect(after.map(judgment)).toEqual(rows.map(judgment));
    expect(after.map((r) => Object.keys(r))).toEqual(rows.map((r) => Object.keys(r)));
    expect(written).toBe(JSON.stringify(after, null, 2) + LINE_FEED);
  });

  test('asked, with nothing to change, it leaves the file alone', () => {
    const settled = serializeInventory(regenerateMechanical(rows, walked));
    const disk = { read: jest.fn(() => settled), write: jest.fn() };
    expect(rewriteInventoryIfAsked({ [UPDATE_VARIABLE]: '1' }, walked, disk)).toBe('unchanged');
    expect(disk.write).not.toHaveBeenCalled();
  });
});

export function inventoryRowFor(h: WalkedHandler): Pick<InventoryRow, 'id' | 'method' | 'path' | 'mechanical'> {
  return {
    id: h.id,
    method: h.method,
    path: h.path,
    mechanical: {
      sessionGates: h.sessionGates,
      authorizationGates: h.authorizationGates,
      roleLiterals: h.roleLiterals,
    },
  };
}

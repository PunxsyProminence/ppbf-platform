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

/** admin and organization_admin satisfy each other (roleAlias.ts). */
function canonicalRoles(roles: string[]): string[] {
  return [...new Set(roles.map((r) => (r === 'admin' ? 'organization_admin' : r)))].sort();
}

describe('every API handler has a row in the committed inventory, and the row still describes the code', () => {
  const walked = walkApiRoutes();
  const inventory = loadInventory();
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

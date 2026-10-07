// Convention gate: the session readers that skip requirePrincipal's
// bootstrap-PIN stop are called only where that stop protects nothing.
//
// WHY THIS EXISTS. requirePrincipal (http.ts) refuses a session whose account
// still owes a PIN change, so an athlete who was handed a starting PIN can
// reach nothing until they choose their own. Two readers deliberately skip
// that stop: requirePrincipalAllowingPinChange, for the PIN-change route, and
// requirePrincipalForSignOut, for the two sign-out routes (a session that owes
// a PIN change must still be able to end itself on a shared gym tablet). Both
// are exported from the same module every route imports its gate from, so the
// only thing keeping them out of a data-serving route was a comment -- and a
// comment on requirePrincipalAllowingPinChange said "only for the PIN change
// route" for months while nothing checked it.
//
// WHAT THIS ASSERTS. Two things, by two different methods, because each has a
// blind spot the other covers:
//
//   1. Per HANDLER, through the same walker the gate-declaration test uses:
//      the set of handlers reaching each exempt reader is EXACTLY the pinned
//      set. Catches a route that starts calling the reader, directly or through
//      a same-file helper. Blind to code outside app/api.
//   2. Per FILE, by a plain text scan of every non-test source under apps/web:
//      the files that so much as mention each reader are exactly its
//      definition, its pinned callers, and the files that describe it. Catches
//      a server module (not a route) that imports the reader, which the walker
//      never sees. Blind to nothing in the tree, but it is a substring match,
//      which is why it is the second check and not the only one.
//
// The pins are equalities, not floors. Adding a legitimate caller means
// editing this file, which is the point: a reviewer sees the exemption widen.

import fs from 'node:fs';
import path from 'node:path';

import { API_ROOT, WEB_ROOT, walkApiRoutes } from './routeGateWalk';

/** Handlers (route file + method) that may reach each exempt session reader. */
const EXEMPT_READER_HANDLERS: Record<string, string[]> = {
  requirePrincipalForSignOut: [
    'app/api/pilot/auth/logout-all/route.ts#POST',
    'app/api/pilot/auth/logout/route.ts#POST',
  ],
  requirePrincipalAllowingPinChange: [
    'app/api/pilot/auth/change-pin/route.ts#POST',
  ],
};

/**
 * Files (relative to apps/web, forward slashes) allowed to contain each
 * reader's name at all, test files excluded. The definition, the callers, and
 * the files whose job is to describe gates. Anything else mentioning the name
 * is either a new caller or a comment that will become one.
 */
const EXEMPT_READER_FILES: Record<string, string[]> = {
  requirePrincipalForSignOut: [
    'src/server/pilot/http.ts',
    'app/api/pilot/auth/logout-all/route.ts',
    'app/api/pilot/auth/logout/route.ts',
    'src/server/pilot/routeGateWalk.ts',
    'src/server/pilot/apiRouteInventory.json',
  ],
  requirePrincipalAllowingPinChange: [
    'src/server/pilot/http.ts',
    'app/api/pilot/auth/change-pin/route.ts',
    'src/server/pilot/routeGateWalk.ts',
    'src/server/pilot/apiRouteInventory.json',
  ],
};

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', 'coverage', 'playwright-report', 'test-results']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js', '.json']);

function isTestFile(rel: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || rel.startsWith('e2e/');
}

/** Every non-test source file under apps/web, as a forward-slash relative path. */
function sourceFiles(root: string = WEB_ROOT): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      // isDirectory() is false for the node_modules junction this worktree may
      // carry on Windows, and the name is skipped anyway; both are deliberate.
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (isTestFile(rel)) continue;
      out.push(rel);
    }
  }
  return out.sort();
}

describe('the session readers that skip the bootstrap-PIN stop are called only where it protects nothing', () => {
  const walked = walkApiRoutes(API_ROOT);

  test('the walk still examines the whole tree', () => {
    expect(walked.length).toBeGreaterThan(300);
  });

  for (const [reader, pinned] of Object.entries(EXEMPT_READER_HANDLERS)) {
    test(`${reader} is reached by exactly its pinned handlers`, () => {
      const reaching = walked
        .filter((handler) => handler.sessionGates.includes(reader))
        .map((handler) => handler.id)
        .sort();

      expect(reaching).toEqual([...pinned].sort());
    });
  }

  // A pinned handler that no longer exists would make the equality above
  // fail loudly, but say so by name rather than as a diff of two arrays.
  test('every pinned handler still exists', () => {
    const live = new Set(walked.map((handler) => handler.id));
    const missing = Object.values(EXEMPT_READER_HANDLERS).flat().filter((id) => !live.has(id));
    expect(missing).toEqual([]);
  });

  const files = sourceFiles();

  test('the file scan still examines the whole tree', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('src/server/pilot/http.ts');
    expect(files).toContain('app/api/pilot/auth/logout/route.ts');
  });

  for (const [reader, allowed] of Object.entries(EXEMPT_READER_FILES)) {
    test(`${reader} is named only in its definition, its pinned callers and the gate inventories`, () => {
      const mentioning = files
        .filter((rel) => fs.readFileSync(path.join(WEB_ROOT, rel), 'utf8').includes(reader))
        .sort();

      expect(mentioning).toEqual([...allowed].sort());
    });
  }

  // The two pins must agree with each other: every handler pinned above lives
  // in a file allowed below. Otherwise one list could be edited without the
  // other and the suite would still be green on one of them.
  test('every pinned handler is in a file the scan allows', () => {
    for (const [reader, handlers] of Object.entries(EXEMPT_READER_HANDLERS)) {
      const allowed = new Set(EXEMPT_READER_FILES[reader]);
      for (const id of handlers) {
        expect(allowed.has(id.split('#')[0])).toBe(true);
      }
    }
  });

  // requirePrincipal itself must still be what every other route reaches
  // through. If a reader were added to http.ts and to SESSION_GATES without a
  // pin here, it would pass the gate-declaration test silently; this says the
  // recogniser set and the pins above name the same exemptions.
  test('every session gate the walker recognises is either requirePrincipal-derived or pinned here', () => {
    const recognised = new Set(walked.flatMap((handler) => handler.sessionGates));
    const derivedFromRequirePrincipal = new Set([
      'requirePrincipal',
      'requireMicrosoftAuthenticatedPrincipal',
      'requireMicrosoftOrAttestedLocalPinPrincipal',
      'requireStaffSessionPrincipal',
    ]);
    // resolvePrincipal is the raw reader behind every gate; auth/session POST
    // uses it on purpose to answer {authenticated: false}, and the
    // gate-declaration test's allowlist records that. It is not a stop-skipping
    // GATE, so it is listed here as known rather than pinned as exempt.
    const known = new Set(['resolvePrincipal', ...Object.keys(EXEMPT_READER_HANDLERS)]);

    const unaccounted = [...recognised].filter(
      (gate) => !derivedFromRequirePrincipal.has(gate) && !known.has(gate),
    );
    expect(unaccounted).toEqual([]);
  });
});

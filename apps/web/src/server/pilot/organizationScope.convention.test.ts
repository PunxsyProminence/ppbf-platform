// Convention gate: a route may not take organization_id from the caller
// without a guard that ties it back to who the caller actually is.
//
// Every gym's data lives in the same tables, separated only by organization_id.
// So the question "which gym is this request about" is the entire tenancy
// boundary, and there are exactly two safe answers: derive it from the session
// (principal.organizationId), or accept it from the caller and then prove the
// caller is allowed to name it. A route that takes the value and uses it
// directly has handed a stranger the key to every gym on the platform, and it
// looks completely ordinary in review -- one destructured field among ten.
//
// This is not hypothetical. verifyCompletion shipped with organizationId
// OPTIONAL and an unscoped fallback that updated by completion_id alone (#214),
// and a completion_id is handed to the client on every write. Both callers
// happened to pass the organization, so nothing failed -- the hole was one
// forgotten argument away, in a repo where several agents write routes in
// parallel. A human caught that one by reading. This catches the next one.
//
// WHAT COUNTS AS A GUARD. Four shapes, all currently in use:
//
//   1. platform_owner role gate. Those routes are cross-gym BY DESIGN -- they
//      create organizations and appoint their admins, so they must be able to
//      name a gym that is not "theirs". The role check is the guard.
//   2. A resolver: resolveOrganizationId / resolveTargetOrganization /
//      assertOrganizationAccess. These take the requested value and the
//      principal together and refuse the mismatch.
//   3. Compare-and-reject against principal.organizationId, which is what
//      platform/users/create does: the body value is read only to be checked,
//      never to be used.
//   4. An explicit allowlist entry below, with the reason recorded.
//
// Scope: route handlers under app/api. Test files are excluded -- a test may
// legitimately construct a request body naming any organization it likes.

import fs from 'node:fs';
import path from 'node:path';

const WEB_ROOT = path.resolve(__dirname, '../../..');
const API_ROOT = path.join(WEB_ROOT, 'app', 'api');

/**
 * Reading organization_id off the request. Covers the query string and the
 * parsed body, including the optional-chained form, because both appear in
 * this codebase and both are equally load-bearing.
 */
const ORG_FROM_REQUEST = [
  /searchParams\.get\(\s*['"`]organization_id['"`]/,
  /\bbody\??\.\s*organization_id\b/,
];

/** Guard shapes that make naming an organization legitimate. */
const GUARDS = [
  // 1. Cross-gym by design, gated on the role that is allowed to be cross-gym.
  // No dotAll flag: [^)] is a negated class, so it already spans the newlines
  // in a multi-line requireRole([...]) call. The flag was both unnecessary and
  // a type error below ES2018.
  /requireRole\([^)]*platform_owner/,
  // 2. Resolvers that weigh the requested value against the principal.
  /resolveOrganizationId\s*\(/,
  /resolveTargetOrganization\s*\(/,
  /assertOrganizationAccess\s*\(/,
  // 3. Compare-and-reject: the body value is read only in order to be checked.
  /principal\.organizationId/,
];

/**
 * Routes that legitimately accept an organization_id with none of the guards
 * above. Every entry needs a reason, because the next person to add one should
 * have to write down why.
 */
const ALLOWLIST = new Map<string, string>([
  [
    'app/api/public/store/route.ts',
    'The public store is addressed per gym by design -- there is no global '
      + 'store because there is no global gym, and a signed-out visitor has no '
      + 'principal to derive the organization from. It reads only PUBLIC_FIELDS '
      + '(see gearCatalog.ts), so naming a gym reveals nothing that gym has not '
      + 'chosen to publish.',
  ],
  [
    'app/api/pilot/admin/bootstrap/platform-owner-microsoft/route.ts',
    'Bootstrap: this route CREATES the first organization, so there is no '
      + 'principal and no existing organization to derive from. It is guarded '
      + 'by the PPBF_PILOT_BOOTSTRAP_KEY environment secret instead, which is '
      + 'checked before anything is read from the body.',
  ],
]);

function collectRouteFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectRouteFiles(full));
    } else if (entry.name === 'route.ts' || entry.name === 'route.tsx') {
      found.push(full);
    }
  }
  return found;
}

/**
 * Forward slashes always. path.relative returns backslashes on Windows, so an
 * allowlist keyed on 'app/api/...' would never match there -- green in CI on
 * ubuntu, failing on every Windows run. The apiBase convention test learned
 * this the hard way; the same normalisation is applied here for the same
 * reason.
 */
function relative(filePath: string): string {
  return path.relative(WEB_ROOT, filePath).split(path.sep).join('/');
}

test('a route that accepts organization_id proves the caller may name it', () => {
  const offenders: string[] = [];

  for (const filePath of collectRouteFiles(API_ROOT)) {
    const rel = relative(filePath);
    if (ALLOWLIST.has(rel)) continue;

    const source = fs.readFileSync(filePath, 'utf8');
    const takesOrgFromRequest = ORG_FROM_REQUEST.some((pattern) => pattern.test(source));
    if (!takesOrgFromRequest) continue;

    if (!GUARDS.some((pattern) => pattern.test(source))) {
      offenders.push(rel);
    }
  }

  if (offenders.length > 0) {
    throw new Error(
      'These routes read organization_id from the request without tying it back '
      + 'to the caller. Every gym\'s data shares one set of tables and is kept '
      + 'apart only by organization_id, so an unguarded value here reaches '
      + 'another gym\'s records (see #214). Use principal.organizationId, or a '
      + 'resolver, or gate on platform_owner if the route is cross-gym by '
      + 'design -- or allowlist it below with the reason:\n  '
      + offenders.join('\n  '),
    );
  }
});

// The allowlist is the part that rots. An entry naming a file that no longer
// exists is a permission nobody reviewed still sitting open, and it would
// silently start covering a different route if that path were ever reused.
test('every allowlisted route still exists', () => {
  const missing = [...ALLOWLIST.keys()].filter(
    (rel) => !fs.existsSync(path.join(WEB_ROOT, rel)),
  );

  expect(missing).toEqual([]);
});

// A guard list that matches nothing would make the first test vacuous: it would
// pass because no file was ever examined, not because every file was safe.
// Pin the fact that routes taking organization_id exist and are being checked.
test('the sweep actually examines routes, rather than passing vacuously', () => {
  const examined = collectRouteFiles(API_ROOT).filter((filePath) => {
    if (ALLOWLIST.has(relative(filePath))) return false;
    const source = fs.readFileSync(filePath, 'utf8');
    return ORG_FROM_REQUEST.some((pattern) => pattern.test(source));
  });

  expect(examined.length).toBeGreaterThan(0);
});

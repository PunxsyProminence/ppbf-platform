/**
 * NO PAGE OFFERS THE OPERATIONS HUB TO A ROLE THAT WOULD BE REFUSED IT.
 *
 * The owner decision of 2026-08-26 made the hub admin and platform owner
 * only. The page gate enforces that and is the authorization; this file is
 * about the CONTROL, which is a different failure and a quieter one -- a link
 * offered to somebody who will be bounced is a dead end with the gym's name
 * on it, and on an ungated page it is also a signpost to a door that exists.
 *
 * WHY A SCANNER AND NOT A UNIT TEST. The restriction pass converted thirteen
 * in-page links to <OperationsLink>, and an adversarial review found four it
 * had missed: two on /source-control pages that carry NO gate at all -- so
 * every role and every signed-out visitor was shown the hub -- and two on
 * /admin queues whose own gates admit a coach. Ten more raw links were
 * harmless only because their page happened to be admin-gated, and NOTHING
 * held that coupling in place. Widen any of those ten gates later and the
 * link silently becomes the same defect again, with no test to say so.
 *
 * So the rule is stated once, over the whole tree, as a relationship rather
 * than a list: a page may hardcode a link to /operations only if its own gate
 * already admits nobody outside OPERATIONS_ROLES. Every other page must go
 * through <OperationsLink>, which reads the session.
 *
 * This is a VISIBILITY guard. It is not the authorization and must never be
 * mistaken for it -- see the same warning in operationsAccess.ts. A page that
 * passes this file is a page that does not OFFER the hub to the wrong role;
 * the gate on /operations is what refuses them if they type the URL.
 *
 * MUTATION CHECK: put `<Link href="/operations">` back on
 * app/source-control/page.tsx (ungated), or on app/admin/attendance/page.tsx
 * (admits 'coach'), and this file names that file and the roles that would
 * have seen it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { OPERATIONS_ROLES } from './operationsAccess';

const APP_DIR = path.resolve(__dirname, '../app');

/** Stands in for a gate whose role list this file cannot read from source. */
const UNREADABLE_GATE = '(gate roles not literal in this file)';

/** Every page/layout under app/, so a new route is covered the day it lands. */
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // `api` holds route handlers, which render no links.
      if (entry.name === 'api' || entry.name === 'node_modules') continue;
      out.push(...routeFiles(full));
      continue;
    }
    if (!entry.name.endsWith('.tsx')) continue;
    if (entry.name.includes('.test.')) continue;
    out.push(full);
  }
  return out;
}

/**
 * A hardcoded link to the hub ITSELF. `/operations/wrestling-league` and
 * `/operations/external-competition` are deliberately excluded: they carry
 * their own ['coach','admin'] gates, and the prefix is not the gate.
 */
function linksToTheHub(source: string): boolean {
  return /href\s*[=:]\s*['"{`]?\s*['"]\/operations['"]/.test(source);
}

/**
 * The roles a page's own gate admits, or null when it declares no gate.
 *
 * Read from the source rather than by rendering: the question is what the
 * file COMMITS to, and a render would only answer for whichever role the
 * test happened to mount it as.
 */
function gateRoles(source: string): string[] | null {
  const gate = source.match(/allowedRoles=\{\[([^\]]*)\]\}/);
  if (gate) {
    const literals = [...gate[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    /* A gate built from a spread or a variable -- `allowedRoles={[...FOO]}`.
       The roles cannot be read from this file, so the safe answer is "I do
       not know", not "none". Reported rather than assumed, because assuming
       the closed side is how a scanner goes quietly blind. */
    return literals.length > 0 ? literals : [UNREADABLE_GATE];
  }
  // The server-side guard states its role inline.
  const page = source.match(/requirePageRole\(\s*['"]([^'"]+)['"]/);
  if (page) return [page[1]];
  return null;
}

const ALLOWED = new Set<string>(OPERATIONS_ROLES);

/* `platform_owner` is the session role; `organization_admin` is the legacy
   spelling of `admin` that several older gates still use. Both resolve to a
   reader this decision admits. */
const GATE_SYNONYMS: Record<string, string> = { organization_admin: 'admin' };

const offenders = routeFiles(APP_DIR)
  .filter((file) => linksToTheHub(readFileSync(file, 'utf8')))
  .map((file) => {
    const roles = gateRoles(readFileSync(file, 'utf8'));
    return {
      file: path.relative(APP_DIR, file),
      roles,
      leakedTo:
        roles === null
          ? ['(no gate: every role, and a signed-out visitor)']
          : roles.filter((role) => !ALLOWED.has(GATE_SYNONYMS[role] ?? role)),
    };
  })
  .filter((entry) => entry.leakedTo.length > 0);

/* Jest's expect takes no message argument, so the explanation is carried in
   the values themselves -- a failure has to tell whoever reads it what to do,
   not just that an array was not empty. */
const report = offenders.map(
  (entry) =>
    `${entry.file} renders a raw link to /operations but admits ${entry.leakedTo.join(', ')}` +
    ' -- use <OperationsLink>, which reads the session and renders nothing for a refused role',
);

it('offers a hardcoded Operations link only from pages already closed to everyone else', () => {
  expect(report).toEqual([]);
});

/* The scan has to be looking at something. A refactor that moved these pages,
   or a regex that stopped matching, would otherwise leave this file green and
   blind -- which is precisely the state the tree was in before it existed. */
it('is actually scanning the route tree', () => {
  const files = routeFiles(APP_DIR);
  expect(files.length).toBeGreaterThan(100);
  expect(files.some((f) => f.endsWith(path.join('operations', 'page.tsx')))).toBe(true);

  // And the matcher recognises both spellings the tree actually uses.
  expect(linksToTheHub('<Link href="/operations" className="btn">')).toBe(true);
  expect(linksToTheHub("{ label: 'Operations Hub', href: '/operations' },")).toBe(true);
  // ...without catching the two sub-routes, which are not this decision.
  expect(linksToTheHub('<Link href="/operations/wrestling-league">')).toBe(false);
  expect(linksToTheHub('<Link href="/operations/external-competition">')).toBe(false);
});

/* The gate reader is the half that decides whether an offender is an
   offender, so its own failure mode is a silent pass. */
it('reads a page gate the way the tree writes one', () => {
  expect(gateRoles("<RoleSessionGate allowedRoles={['admin', 'coach']}>")).toEqual(['admin', 'coach']);
  // A gate this file cannot read is reported, never assumed to be closed.
  expect(gateRoles('<RoleSessionGate allowedRoles={[...OPERATIONS_ROLES]}>')).toEqual([UNREADABLE_GATE]);
  expect(gateRoles("await requirePageRole('admin');")).toEqual(['admin']);
  expect(gateRoles('export default function Page() { return null; }')).toBeNull();
});

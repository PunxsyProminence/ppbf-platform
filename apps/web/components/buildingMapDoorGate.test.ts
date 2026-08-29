/**
 * A door must not advertise a role its page will refuse.
 *
 * buildingMap.ts's own header states this rule in prose:
 *
 *   "It exists so the corridor does not advertise a door that will bounce
 *    you... If this list and a page guard ever disagree, the guard wins and
 *    the fix belongs here, not there."
 *
 * Nothing checked it. The gap was found by mutation while building the
 * calibration adjudication door: swapping that door's `roles: ['admin']` for
 * ADMIN_GATE -- which additionally carries platform_owner, a role the route
 * behind it refuses by name -- left every suite in the repository green. The
 * door would have advertised a surface to someone the API bounces, which is
 * the precise failure the header warns against.
 *
 * That was made executable for one door, inside that door's own route suite.
 * This is the same claim for all of them.
 *
 * WHAT THIS COMPARES, AND WHY IT IS THE PAGE AND NOT THE ROUTE. `roles` is a
 * visibility hint; authority is the page's own guard and, behind it, the API's
 * access checks. The page gate is the one a reader hits first and the one that
 * is declared uniformly enough to compare against -- `allowedRoles={[...]}` on
 * RoleSessionGate and its siblings. A door naming a role that gate omits is
 * advertising a bounce, and that is a defect regardless of what the API would
 * have said afterwards.
 *
 * WHAT IT DOES NOT COMPARE. Doors whose `roles` is OPEN (no gate today, and
 * the header says several arguably should have one -- separate work), doors
 * whose roles come from a constant this file cannot resolve statically, and
 * pages that do not declare `allowedRoles` as a literal. Those are skipped
 * rather than guessed at, and the floor assertion below is what stops the
 * skipping from quietly becoming everything.
 *
 * DIRECTION IS DELIBERATE. This asserts the door's roles are a SUBSET of the
 * page's, not equality. A page admitting a role the corridor does not list is
 * a door that is merely unadvertised to someone who could open it -- untidy,
 * sometimes deliberate, and not a bounce. The reverse is the bug.
 */
import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(__dirname, '../../..');
const mapPath = path.join(repositoryRoot, 'apps/web/components/buildingMap.ts');
const appDir = path.join(repositoryRoot, 'apps/web/app');

const mapSource = fs.readFileSync(mapPath, 'utf8');

/** Locally declared role constants, so a door naming one can still be read. */
const roleConstants: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const match of mapSource.matchAll(/^(?:export )?const ([A-Z_]+)(?::[^=]+)?\s*=\s*(\[[^\]]*\])/gm)) {
    try {
      out[match[1]] = JSON.parse(match[2].replace(/'/g, '"').replace(/,\s*\]/, ']'));
    } catch {
      // A constant this cannot parse is left out and its doors are skipped,
      // which the floor below keeps honest.
    }
  }
  return out;
})();

interface Door {
  readonly href: string;
  readonly rolesSource: string;
  readonly roles: string[] | null;
}

const doors: Door[] = [...mapSource.matchAll(
  /\{\s*href:\s*'([^']+)'[\s\S]*?roles:\s*(\[[^\]]*\]|[A-Za-z_]+)/g,
)].map((match) => {
  const raw = match[2];
  let roles: string[] | null = null;
  if (raw.startsWith('[')) {
    try {
      roles = JSON.parse(raw.replace(/'/g, '"').replace(/,\s*\]/, ']'));
    } catch {
      roles = null;
    }
  } else if (raw in roleConstants) {
    roles = roleConstants[raw];
  }
  return { href: match[1], rolesSource: raw, roles };
});

/** The page gate for a door, or null when there is nothing to compare. */
function pageRolesFor(href: string): string[] | null {
  const pagePath = path.join(appDir, href, 'page.tsx');
  if (!fs.existsSync(pagePath)) return null;
  const match = fs.readFileSync(pagePath, 'utf8').match(/allowedRoles=\{(\[[^\]]*\])\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  } catch {
    return null;
  }
}

const comparable = doors
  .filter((door): door is Door & { roles: string[] } => Array.isArray(door.roles))
  .map((door) => ({ door, pageRoles: pageRolesFor(door.href) }))
  .filter((entry): entry is { door: Door & { roles: string[] }; pageRoles: string[] } =>
    entry.pageRoles !== null);

describe('a door does not advertise a role its page refuses', () => {
  test('the map parsed and enough doors are actually being compared', () => {
    // Guards the guard. Every assertion below is a loop over `comparable`, so
    // a regex that silently stopped matching -- a reformatted map, a renamed
    // prop -- would empty it and turn this file into a green no-op. The floors
    // are set below the counts measured when this was written (118 doors, 90
    // comparable) with room for churn, and are meant to fail loudly rather
    // than track the exact number.
    expect(doors.length).toBeGreaterThan(100);
    expect(comparable.length).toBeGreaterThan(70);
  });

  test.each(comparable.map((entry) => [entry.door.href, entry] as const))(
    '%s advertises no role its page gate omits',
    (_href, entry) => {
      const advertisedButRefused = entry.door.roles.filter((role) => !entry.pageRoles.includes(role));
      expect({
        href: entry.door.href,
        doorRoles: entry.door.roles,
        pageAllowedRoles: entry.pageRoles,
        advertisedButRefused,
      }).toEqual({
        href: entry.door.href,
        doorRoles: entry.door.roles,
        pageAllowedRoles: entry.pageRoles,
        advertisedButRefused: [],
      });
    },
  );
});

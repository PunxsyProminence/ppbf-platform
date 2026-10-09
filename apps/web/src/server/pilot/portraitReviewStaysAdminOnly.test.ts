import fs from 'node:fs';
import path from 'node:path';

/**
 * Portrait review is admin-only, and this is what keeps it that way.
 *
 * One route moves a portrait out of 'pending_review':
 *
 *   api/pilot/admin/portrait-review   lists who is waiting, decides on them,
 *                                     organization admin only, and an approve
 *                                     must prove the reviewer viewed the exact
 *                                     photograph. Called by /admin/portrait-review,
 *                                     which has a door in the building map.
 *
 * There used to be a second, api/pilot/profile/photo/review, with a BROADER
 * gate (coach_of_subject and self alongside admin) and no screen. T-004 built
 * the console and, in its own words, "narrows the actor to organization admin
 * only, per the ticket; it does not touch or loosen the sibling route's own
 * (broader, deliberate) gate." The owner reaffirmed it on 2026-08-29: portrait
 * review stays admin-only, and no coach-facing surface is to be built.
 *
 * A REACHABILITY SWEEP READ THIS BACKWARDS ONCE (see
 * docs/PLATFORM_AUDIT_2026-08-28_ROUTE_REACHABILITY.md) and reported the older
 * route as a safeguarding control with no door. The near-miss was building a
 * coach-facing screen that would have widened who reviews children's
 * photographs, against a decision already made.
 *
 * LANE W7 (2026-10-09) REMOVED THE OLDER ROUTE. It did the same job as the
 * console's POST but without the view attestation that POST requires, so a
 * coach who knew an account_id could release a child's portrait nobody had
 * looked at; nothing in the app called it. Removing it is the decision made
 * executable: the route a decision says nobody should use does not exist.
 *
 * So the decision is asserted here rather than left in a comment. A comment
 * loses to the next person who greps for a missing route and sees a gap; a
 * failing test makes them read this file and change the decision on purpose.
 */

const webRoot = path.resolve(__dirname, '../../..');

/**
 * Every file that could call an API, excluding the routes themselves.
 *
 * Tests and the runtime-probe manifest are excluded for the same reason the
 * audit's own sweep excludes them: naming a path in a fixture or a probe list
 * is not a door somebody can walk through. Including them is what hid
 * floor-hours/public from the audit's first pass.
 */
function callerSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.next', '.git'].includes(entry.name)) continue;
        if (full === path.join(webRoot, 'app', 'api')) continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|mjs|js)$/.test(entry.name)) continue;
      if (entry.name.includes('.test.')) continue;
      if (entry.name.endsWith('.manifest.mjs')) continue;
      out.push(full);
    }
  };
  walk(webRoot);
  return out;
}

const sources = callerSources().map((file) => ({
  file: path.relative(webRoot, file),
  code: fs.readFileSync(file, 'utf8'),
}));

describe('portrait review stays admin-only', () => {
  it('scanned a plausible number of files, so the assertions below are not vacuous', () => {
    // Guards the guard: a walk that silently returned nothing would make every
    // "no caller" assertion pass by finding no callers anywhere.
    expect(sources.length).toBeGreaterThan(200);
    expect(sources.some((source) => source.code.includes('/api/pilot/admin/portrait-review'))).toBe(true);
  });

  it('the broader-gated route no longer exists', () => {
    // THE DECISION, made executable. If this fails, somebody has rebuilt a
    // coach- or self-facing exit from pending_review -- read this file's
    // header before deciding the test is wrong. The admin console's POST is
    // the one place a portrait of a child is released, and it attests that
    // the reviewer viewed the photograph.
    expect(fs.existsSync(path.join(webRoot, 'app/api/pilot/profile/photo/review'))).toBe(false);
  });

  it('nothing calls the removed route, so nothing is broken by its absence', () => {
    const callers = sources
      .filter((source) => source.code.includes('/api/pilot/profile/photo/review'))
      .map((source) => source.file);

    expect(callers).toEqual([]);
  });

  it('keeps the admin console pointed at the admin route', () => {
    const console_ = sources.find((source) => source.file.endsWith(path.join('app', 'admin', 'portrait-review', 'page.tsx')));
    expect(console_).toBeDefined();
    expect(console_?.code).toContain('/api/pilot/admin/portrait-review');
  });

  it('keeps the admin console reachable, so admin-only does not become nobody', () => {
    // The whole decision rests on admins being able to do this. A door that
    // disappeared would turn "admin-only" into "no one", and the portraits
    // would be stuck in exactly the way the audit wrongly claimed they were.
    const buildingMap = sources.find((source) => source.file.endsWith(path.join('components', 'buildingMap.ts')));
    expect(buildingMap).toBeDefined();
    expect(buildingMap?.code).toContain("href: '/admin/portrait-review'");
  });

  it('the admin route is admin-only and attests the view before a release', () => {
    const route = fs.readFileSync(
      path.join(webRoot, 'app/api/pilot/admin/portrait-review/route.ts'),
      'utf8',
    );
    expect(route).toContain("requireRole(principal, ['organization_admin', 'admin'])");
    expect(route).not.toContain("'coach'");
    expect(route).toContain('attestedUploadedAt');
  });
});

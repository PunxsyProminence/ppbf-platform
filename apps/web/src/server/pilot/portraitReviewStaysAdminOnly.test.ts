import fs from 'node:fs';
import path from 'node:path';

/**
 * Portrait review is admin-only, and this is what keeps it that way.
 *
 * Two routes can move a portrait out of 'pending_review'. Only one has a
 * screen, and that asymmetry is a decision rather than an oversight:
 *
 *   api/pilot/admin/portrait-review   lists who is waiting, decides on them,
 *                                     organization admin only. Called by
 *                                     /admin/portrait-review, which has a door
 *                                     in the building map.
 *
 *   api/pilot/profile/photo/review    the older exit, with a BROADER gate --
 *                                     coach_of_subject and self alongside
 *                                     admin. No screen anywhere.
 *
 * T-004 built the console and, in its own words, "narrows the actor to
 * organization admin only, per the ticket; it does not touch or loosen the
 * sibling route's own (broader, deliberate) gate." The owner reaffirmed it on
 * 2026-08-29: portrait review stays admin-only, and no coach-facing surface is
 * to be built.
 *
 * A REACHABILITY SWEEP READ THIS BACKWARDS ONCE (see
 * docs/PLATFORM_AUDIT_2026-08-28_ROUTE_REACHABILITY.md) and reported the route
 * as a safeguarding control with no door, on the reasoning that a photograph
 * could therefore never be released. That was wrong -- the console releases
 * them -- and the near-miss was building a coach-facing screen that would have
 * widened who reviews children's photographs, against a decision already made.
 *
 * So the decision is asserted here rather than left in a comment. A comment
 * loses to the next person who greps for an orphaned route and sees an
 * opportunity; a failing test makes them read this file and change the
 * decision on purpose.
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

  it('gives the broader-gated route no screen', () => {
    // THE DECISION. profile/photo/review admits coach_of_subject and self;
    // building a surface for it would widen who reviews a child's photograph
    // beyond what T-004 scoped and the owner reaffirmed. If this fails,
    // somebody has built that surface -- read this file's header before
    // deciding the test is wrong.
    const callers = sources
      .filter((source) => source.code.includes('/api/pilot/profile/photo/review'))
      .map((source) => source.file);

    expect(callers).toEqual([]);
  });

  it('keeps the admin console pointed at the admin route, not the broader one', () => {
    // The two routes are one path segment apart and do the same job. Wiring
    // the console to the broader one would look identical on screen and
    // quietly move the decision to a route with a wider gate.
    const console_ = sources.find((source) => source.file.endsWith(path.join('app', 'admin', 'portrait-review', 'page.tsx')));
    expect(console_).toBeDefined();
    expect(console_?.code).toContain('/api/pilot/admin/portrait-review');
    expect(console_?.code).not.toContain('/api/pilot/profile/photo/review');
  });

  it('keeps the admin console reachable, so admin-only does not become nobody', () => {
    // The whole decision rests on admins being able to do this. A door that
    // disappeared would turn "admin-only" into "no one", and the portraits
    // would be stuck in exactly the way the audit wrongly claimed they were.
    const buildingMap = sources.find((source) => source.file.endsWith(path.join('components', 'buildingMap.ts')));
    expect(buildingMap).toBeDefined();
    expect(buildingMap?.code).toContain("href: '/admin/portrait-review'");
  });

  it('leaves the route\'s own gate alone, and says so where the gate is', () => {
    // Not narrowing profile/photo/review is as deliberate as not widening its
    // surface: T-004 declined to touch it, so this change does too. The route
    // header has to carry that, because a reader who finds the gate broader
    // than the screen deserves to know which way it was decided.
    const route = fs.readFileSync(
      path.join(webRoot, 'app/api/pilot/profile/photo/review/route.ts'),
      'utf8',
    );
    expect(route).toContain('STAYS ADMIN-ONLY');
    // The gate itself is untouched -- coach and self are still admitted.
    expect(route).toContain("requireRole(principal, ['organization_admin', 'admin', 'coach'])");
    expect(route).toContain("relationship === 'coach_of_subject'");
  });
});

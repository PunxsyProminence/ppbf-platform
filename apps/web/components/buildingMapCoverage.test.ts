import fs from 'node:fs';
import path from 'node:path';

import { BUILDING } from './buildingMap';

// buildingMap.ts's header says every surface that exists should have a row,
// and buildingMap.test.ts pins a hand-written list of the eight surfaces that
// were orphaned when that list was written. A hand-written list cannot catch
// the NEXT orphan: three coach pages (session-scripts, cohorts, disciplines)
// shipped reachable only by typing the URL, with the whole suite green.
//
// This walks app/ instead. A new page either gets a door or gets an explicit
// line in EXCLUDED below saying why it should not have one -- and the reason
// gets read by whoever adds the next page, which a silent omission never is.

const APP_DIR = path.resolve(__dirname, '../app');

/**
 * Routes that deliberately carry no door, each with the reason from
 * buildingMap.ts's own "WHAT IS DELIBERATELY NOT HERE" note.
 *
 * Adding a route here is a decision, not a formality. If the reason is not one
 * of the two below, it probably wants a door instead.
 */
const EXCLUDED: Record<string, string> = {
  '/': 'the way in -- you arrive through it, not to it',
  '/login': 'the way in',
  '/athlete/sign-in': 'the way in',
  '/activate': 'the way in',
  '/change-pin': 'the way in',
  '/auth/link': 'the way in -- magic-link landing, arrived at from an email',
  '/launch': 'a one-line re-export of /operations, not a second surface',
};

/**
 * Orphans this guard found on the day it was written, all pre-dating it.
 *
 * These are NOT decisions. Each is a real surface reachable only by typing its
 * URL, and each needs an owner call on whether it gets a door and which roles
 * see it -- inventing seven role sets unsupervised is how a catalog starts
 * advertising the wrong doors, which buildingMap.ts's own header warns about.
 *
 * They are listed separately from EXCLUDED so the distinction survives: an
 * EXCLUDED entry is settled, an entry here is outstanding work. Emptying this
 * map is the goal; moving something into EXCLUDED is a valid way to do it, but
 * only with a reason as concrete as the ones above.
 */
const PENDING_TRIAGE: Record<string, string> = {
  '/admin/export': 'real admin feature ("Take Your Roster With You") -- wants a door, roles unconfirmed',
  '/admin/import': 'real admin feature ("Load a roster") -- wants a door, roles unconfirmed',
  '/admin/gear': 'real admin feature ("Equipment and margin") -- wants a door, roles unconfirmed',
  '/admin/gear/vendors': 'real admin feature ("Suppliers and accounts") -- wants a door, roles unconfirmed',
  '/admin/athletes': 'renders a notice ("Athlete records are managed per gym") -- may be a signpost, not a surface',
  '/admin/organizations/test': 'renders "Test Wizard Disabled" -- scaffolding, probably wants deleting not a door',
  '/admin/platform/overview': 'platform-owner gated ("Platform Owner Access Required") -- door depends on whether platform_owner gets a corridor at all',
};

/** Every route in app/ that renders a page, as a URL path. */
function routesOnDisk(dir: string = APP_DIR, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      if (entry.name === 'page.tsx' || entry.name === 'page.ts') {
        found.push(prefix === '' ? '/' : prefix);
      }
      continue;
    }
    // Route groups (parens) do not appear in the URL; api/ has no pages;
    // dynamic segments are per-record surfaces reached from a list, not doors.
    if (entry.name === 'api' || entry.name.startsWith('_')) continue;
    if (entry.name.startsWith('(') || entry.name.startsWith('[')) {
      found.push(...routesOnDisk(path.join(dir, entry.name), prefix));
      continue;
    }
    found.push(...routesOnDisk(path.join(dir, entry.name), `${prefix}/${entry.name}`));
  }
  return found;
}

describe('the building map covers what is actually on disk', () => {
  const onDisk = routesOnDisk().filter((r) => !r.includes('['));
  const doors = new Set(BUILDING.map((d) => d.href));

  it('finds the app directory and a plausible number of routes', () => {
    // A broken walk would make every assertion below vacuously pass.
    expect(onDisk.length).toBeGreaterThan(40);
    expect(onDisk).toContain('/coach/drills');
  });

  it('gives every page on disk either a door or a stated reason for having none', () => {
    const orphaned = onDisk.filter(
      (r) => !doors.has(r) && !(r in EXCLUDED) && !(r in PENDING_TRIAGE),
    );

    // Whoever trips this needs to know the fix is a door OR an EXCLUDED entry,
    // not a deletion and not a quiet addition to PENDING_TRIAGE.
    expect(orphaned).toEqual([]);
  });

  it('does not let PENDING_TRIAGE grow past the backlog it was opened with', () => {
    // The whole point of separating it from EXCLUDED is that it shrinks. A new
    // orphan parked here instead of given a door would otherwise be invisible
    // again, which is the failure this file exists to stop.
    expect(Object.keys(PENDING_TRIAGE).length).toBeLessThanOrEqual(7);
  });

  it('does not carry a pending entry for a route that no longer exists', () => {
    const stale = Object.keys(PENDING_TRIAGE).filter((r) => !onDisk.includes(r));
    expect(stale).toEqual([]);
  });

  it('never lists the same route as both settled and outstanding', () => {
    const both = Object.keys(PENDING_TRIAGE).filter((r) => r in EXCLUDED);
    expect(both).toEqual([]);
  });

  it('never leaves a door and a pending entry pointing at the same route', () => {
    // Giving one of these a door without clearing its entry would make the map
    // look like it still owes work it has already done.
    const contradictory = Object.keys(PENDING_TRIAGE).filter((r) => doors.has(r));
    expect(contradictory).toEqual([]);
  });

  it('does not keep doors to pages that no longer exist', () => {
    const diskSet = new Set(onDisk);
    // Doors to dynamic or external targets are not disk-backed; skip those.
    const dangling = [...doors].filter((h) => !diskSet.has(h) && !h.includes('[') && !h.startsWith('http'));

    expect(dangling).toEqual([]);
  });

  it('does not carry an exclusion for a route that no longer exists', () => {
    // A stale exclusion is a standing permission to orphan a path that may
    // later be reused for something that does need a door.
    const stale = Object.keys(EXCLUDED).filter((r) => !onDisk.includes(r));

    expect(stale).toEqual([]);
  });

  it('has a door for each of the three surfaces added in the folder 06-08 work', () => {
    // These are the ones that prompted this guard; pinned by name so a later
    // refactor that drops them fails loudly rather than silently re-orphaning.
    expect(doors.has('/coach/session-scripts')).toBe(true);
    expect(doors.has('/coach/cohorts')).toBe(true);
    expect(doors.has('/coach/disciplines')).toBe(true);
  });
});

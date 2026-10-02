import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * GOLDEN ERA 007 — THE FRONT DESK (People Console, /admin/people).
 *
 * Three separate contracts live here, and the last two are the ones that
 * matter.
 *
 * 1. THE TOKEN SCOPE. `.ge-frontoffice` redefines the brass ramp to aged
 *    bronze so every shared component on this route resolves Golden Era metal
 *    together -- .btn, .btn--ghost, .frame, .rivet, the .mat-leather rail, and
 *    the ACTIVE tab, whose fill comes from app/globals.css's
 *    `--accent-strong: var(--brass-500)`. A property override leaks wherever it
 *    is forgotten; a token override cannot. Same seam .ge-bell, .ge-floorboard
 *    and .ge-locker use.
 *
 * 2. THE REAL CONTROL SET SURVIVES THE MOCKUP. The locked 007 reference draws a
 *    tab rail reading PEOPLE / NOTICES / VOLUNTEERS over four panels: Roster,
 *    Notices, PIN Management, Attendance KPIs. Only the roster is this route.
 *    Notices is /notices, Volunteers is /admin/volunteer-management, PIN
 *    Management is /admin/pin and Attendance is /admin/attendance -- four
 *    separate doors in the same room, drawn together because the packet is a
 *    picture of the ROOM rather than of this page. Implementing the image
 *    literally would rename all three working tabs and invent three panels with
 *    nothing behind them.
 *
 *    A visual pass is exactly when that kind of quiet deletion happens, so it
 *    is pinned: the three real tabs must still be there, and the mockup's
 *    labels must NOT appear in the tab list. If the owner later decides the
 *    people console really should absorb those routes, that is an
 *    information-architecture change with its own PR and its own tests -- not a
 *    side effect of restyling.
 *
 * 3. THE AUTHORISATION CHAIN IS NOT CHROME. This is an admin console that
 *    creates sign-ins and publishes starting PINs. A restyle has no business
 *    anywhere near its gate, so the whole chain is pinned in the same file that
 *    introduces the styling: RoleSessionGate's allowlist, the narrowing to an
 *    organization admin (RoleSessionGate's 'admin' also covers platform
 *    owners), and the refusal notice that narrowing renders. The scope class is
 *    required to be on the authorised console ONLY -- one occurrence -- so a
 *    later edit cannot quietly dress the refusal surface as the working one.
 *
 * MUTATION CHECK: set a `--brass-NNN` rung on `.ge-frontoffice` back to its
 * legacy value, or drop the class from the page, or rename a real tab to a
 * mockup label, or widen the gate -- each turns this suite red.
 */

const css = readDesignSystemCss(DESIGN_SYSTEM_ENTRY);

/* THE MEDICAL-STOP NAMES: --locked, its --locked-* rungs, and every custom
   property whose every declaration resolves to one of them. Read from the
   sheets rather than listed, because app/globals.css aliases --locked as
   --safety-locked, --status-critical and --status-danger, and a check on the
   bare name waves all three through. ("Every declaration", so a slot such as
   `--badge`, which only the locked variant of .badge fills with --locked, is
   not counted.) */
const GLOBALS_CSS = readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8');
const MEDICAL_STOP_TOKENS: readonly string[] = (() => {
  const values = new Map<string, string[]>();
  for (const [, name, value] of `${css}\n${GLOBALS_CSS}`
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/(?<![\w-])(--[\w-]+)\s*:\s*([^;{}]*)/g)) {
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  const tokens = new Set([...values.keys()].filter((name) => /^--locked(?:-|$)/.test(name)));
  const resolvesToStop = (value: string) =>
    [...value.matchAll(/var\(\s*(--[\w-]+)/g)].some(([, ref]) => tokens.has(ref));
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, all] of values) {
      if (tokens.has(name) || !all.every(resolvesToStop)) continue;
      tokens.add(name);
      grew = true;
    }
  }
  return [...tokens].sort();
})();

/** The medical-stop names `text` refers to, matched as whole property names. */
function medicalStopReferences(text: string): string[] {
  return MEDICAL_STOP_TOKENS.filter((token) => new RegExp(`(?<![\\w-])${token}(?![\\w-])`).test(text));
}

const PAGE = readFileSync(
  path.resolve(__dirname, '../../app/admin/people/page.tsx'),
  'utf8',
);

/** Every rule whose selector list mentions `.ge-frontoffice`, as [selectors, body]. */
function scopedRules(): Array<[string, string]> {
  const rules: Array<[string, string]> = [];
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selectors = rule[1].trim();
    if (selectors.includes('.ge-frontoffice')) rules.push([selectors, rule[2]]);
  }
  return rules;
}

/* 2026-10-02 (OD-2026-10-02-004, OD-2026-10-02-007): nothing about the look
   binds, so the cases here that pinned this screen's look were removed -- the
   bronze ramp and its channel triples, the scope class, selector shape, "only
   markup this pass added", control counts and "not renamed". What remains
   guards meaning and function: the --locked token, stamps and badges, gates
   and refusals, real controls still present, nothing invented. Where the
   header above describes a removed case it is history, kept as the record of
   why the case was written. */

describe('golden-era front office scope', () => {

  /* The office keeps its register in bronze ink, and --locked means a medical
     stop, which is not chrome. Red itself is not reserved (OD-2026-09-29-001),
     so the hue and --stamp-red are not refused here. */
  test('the scope spends no --locked medical-stop token on chrome', () => {
    expect(MEDICAL_STOP_TOKENS)
      .toEqual(expect.arrayContaining(['--locked', '--safety-locked', '--status-critical', '--status-danger']));
    for (const [, body] of scopedRules()) {
      expect(body).not.toMatch(/var\(--locked[^)]*\)/);
      expect(medicalStopReferences(body)).toEqual([]);
    }
  });

  test('reads a real set of scoped rules, or the checks above are vacuous', () => {
    expect(scopedRules().length).toBeGreaterThan(5);
  });
});

describe('the 007 mockup did not rename or invent front-office controls', () => {
  /** The tab tuple array only, so a label appearing elsewhere in the file
   *  (a heading, a button, a comment) cannot satisfy or break these. */
  function tabBlock(): string {
    const m = PAGE.match(/\{\(\[([\s\S]*?)\] as Array<\[Tab, string\]>\)/);
    expect(m).not.toBeNull();
    return (m as RegExpMatchArray)[1];
  }

  // Every tab key that really exists on current main, with the label it carries.
  const REAL_TABS: Array<[string, string]> = [
    ['people', 'Everyone'],
    ['invite-staff', 'Add Coach, Staff Or Guardian'],
    ['add-athlete', 'Add Athlete'],
  ];

  test.each(REAL_TABS)('the real tab %s still exists, labelled %s', (key, label) => {
    expect(tabBlock()).toContain(`'${key}'`);
    expect(tabBlock()).toContain(label);
  });

  test('no tab was renamed to a reference-image label', () => {
    // Drawn in the locked mockup as tabs of this rail, but each is its own
    // route: /notices, /admin/volunteer-management, /admin/pin.
    for (const label of ['Notices', 'Volunteers', 'PIN Management']) {
      expect(tabBlock()).not.toContain(label);
    }
  });

  test('no panel was invented from the reference image', () => {
    // Notices, PIN Management and Attendance KPIs are separate front-office
    // routes. A restyle may not grow this console a panel for any of them.
    // ('Volunteer' is deliberately absent from this list: it is a real staff
    // role option on the invite form, not a mockup panel.)
    for (const panel of ['Notices', 'PIN Management', 'Attendance KPIs']) {
      expect(PAGE).not.toContain(panel);
    }
  });
});

describe('the restyle left the console gate exactly where it was', () => {
  test('RoleSessionGate still admits only admin and platform_owner', () => {
    expect(PAGE).toContain("<RoleSessionGate allowedRoles={['admin', 'platform_owner']}>");
  });

  test('the console is still narrowed to an organization admin', () => {
    expect(PAGE).toMatch(/if \(!isOrganizationAdminSessionRole\(session\.role\)\) \{\s*return <WrongRoleNotice \/>;/);
  });

  test('the refusal notice is still rendered by that narrowing', () => {
    expect(PAGE).toContain('function WrongRoleNotice()');
  });
});

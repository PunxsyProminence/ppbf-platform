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

const BRASS_RUNGS = ['200', '300', '400', '500', '600', '700', '800', '900'] as const;

const css = readDesignSystemCss(DESIGN_SYSTEM_ENTRY);

const PAGE = readFileSync(
  path.resolve(__dirname, '../../app/admin/people/page.tsx'),
  'utf8',
);

/** The bare `.ge-frontoffice { … }` token rule, not its descendant rules. */
function scopeBody(source: string): string | null {
  const match = source.match(/^\.ge-frontoffice\s*\{([^}]*)\}/m);
  return match ? match[1] : null;
}

function legacyRung(source: string, rung: string): string | null {
  const withoutScope = source.replace(/^\.ge-frontoffice\s*\{[^}]*\}/m, '');
  const m = withoutScope.match(new RegExp(`--brass-${rung}\\s*:\\s*(#[0-9A-Fa-f]{3,8})`, 'i'));
  return m ? m[1].toLowerCase() : null;
}

/** Every rule whose selector list mentions `.ge-frontoffice`, as [selectors, body]. */
function scopedRules(): Array<[string, string]> {
  const rules: Array<[string, string]> = [];
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selectors = rule[1].trim();
    if (selectors.includes('.ge-frontoffice')) rules.push([selectors, rule[2]]);
  }
  return rules;
}

describe('golden-era front office scope', () => {
  test('the bronze ramp is on the .ge-frontoffice class scope, not :root', () => {
    expect(scopeBody(css)).not.toBeNull();
    /* `?? []` turns "the regex found no :root block" into "there is nothing to
       check", and a for-loop over nothing asserts nothing -- so this half of the
       test reports that no :root carries the bronze in exactly the same voice
       whether that is true or whether the scan simply broke. Seven :root blocks
       resolve today; the floor is the honest claim, which is that at least one
       was read and the loop below therefore ran. */
    expect((css.match(/:root\s*\{[^}]*\}/g) ?? []).length).toBeGreaterThan(0);
    for (const block of css.match(/:root\s*\{[^}]*\}/g) ?? []) {
      expect(block).not.toContain('#E7C88A');
    }
  });

  test.each(BRASS_RUNGS)('brass rung %s is redefined on the scope and differs from legacy', (rung) => {
    const body = scopeBody(css);
    expect(body).not.toBeNull();
    const scoped = (body as string).match(new RegExp(`--brass-${rung}\\s*:\\s*(#[0-9A-Fa-f]{3,8})`, 'i'));
    expect(scoped).not.toBeNull();
    /* `legacyRung` returns null when it finds no definition outside the scope,
       and `not.toEqual(null)` is satisfied by every string there is. So the
       moment the ramp this scope exists to differ FROM stops being in the
       resolved sheet, "differs from legacy" starts passing for the one reason
       that means nothing was compared. Asserted the way its sibling
       goldenEraTokenScope.test.ts already asserts it. */
    expect(legacyRung(css, rung)).not.toBeNull();
    expect((scoped as RegExpMatchArray)[1].toLowerCase()).not.toEqual(legacyRung(css, rung));
  });

  test('the people console carries the scope class, on the authorised console only', () => {
    expect(PAGE).toMatch(/className="ge-frontoffice[^"]*"/);
    // className attributes only -- the rule's own explanatory comment names the
    // class too, and a comment is not a surface.
    expect(PAGE.match(/className="[^"]*\bge-frontoffice\b/g) ?? []).toHaveLength(1);
  });

  /* The office keeps its register in bronze ink. #A81E22 is the safeguarding
     red -- MEDICALLY_NOT_ALLOWED, and nothing else -- and `.pap--ruled` draws
     its margin line in exactly that colour, which is the trap a ruled-paper
     restyle walks straight into. */
  test('the scope spends no safeguarding red on chrome', () => {
    for (const [, body] of scopedRules()) {
      expect(body.toUpperCase()).not.toContain('#A81E22');
      expect(body).not.toMatch(/168\s*,\s*30\s*,\s*34/);
      expect(body).not.toMatch(/var\(--(?:locked|stamp-red)[^)]*\)/);
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

  test('the tab count is unchanged', () => {
    expect(tabBlock().match(/\['/g) ?? []).toHaveLength(REAL_TABS.length);
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

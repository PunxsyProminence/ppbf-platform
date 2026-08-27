import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * GOLDEN ERA 005 — THE SCHEDULE BOARD (/schedule).
 *
 * Two separate contracts live here, and the second is the one that matters.
 *
 * 1. THE TOKEN SCOPE. `.ge-scheduler` redefines the brass ramp to aged bronze
 *    so the shared components on this route (the .mat-leather panels, the
 *    .mat-leather--raised class rows, .btn / .btn--ghost, the recessed
 *    .input/.select/.textarea, the .t-command / .t-eyebrow / .t-label voices)
 *    resolve Golden Era metal together. A property override leaks wherever it
 *    is forgotten; a token override cannot. Same seam .ge-bell, .ge-floorboard
 *    and .ge-locker use.
 *
 * 2. THE REAL CONTROL SET SURVIVES THE MOCKUP. The locked 005 reference draws a
 *    rail reading DAY / WEEK / MONTH across the top of the board, and draws
 *    nothing else at all: no create-class form, no coaching request, no
 *    attendance check-in, no parent review, no coaching-request queue. That is
 *    a picture of a schedule, not an inventory of this page.
 *
 *    Implementing it literally would do both forbidden things at once — invent
 *    a day/week/month view switch with no state, no query parameter and no
 *    server field behind it, and delete eight real actions plus thirteen real
 *    form controls that the mockup simply does not draw. A visual pass is
 *    exactly when that kind of deletion happens quietly, so it is pinned: every
 *    real action, control and role gate must still be there, and the invented
 *    view switch must NOT appear.
 *
 *    If the owner later decides /schedule really should grow a day/week/month
 *    view, that is a functional change with its own PR, its own state and its
 *    own tests — not a side effect of restyling.
 *
 * MUTATION CHECK: set a `--brass-NNN` line in the `.ge-scheduler` block back to
 * its legacy value (e.g. `--brass-500: #B8912F`), or delete the rung, or drop
 * the class from the page, or remove one scheduler action — each turns this
 * suite red.
 */

const BRASS_RUNGS = ['200', '300', '400', '500', '600', '700', '800', '900'] as const;

const css = readDesignSystemCss(DESIGN_SYSTEM_ENTRY);

const PAGE = readFileSync(
  path.resolve(__dirname, '../../app/schedule/page.tsx'),
  'utf8',
);

/** The bare `.ge-scheduler { … }` token rule, not its descendant rules. */
function scopeBody(source: string): string | null {
  const match = source.match(/^\.ge-scheduler\s*\{([^}]*)\}/m);
  return match ? match[1] : null;
}

function legacyRung(source: string, rung: string): string | null {
  const withoutScope = source.replace(/^\.ge-scheduler\s*\{[^}]*\}/m, '');
  const m = withoutScope.match(new RegExp(`--brass-${rung}\\s*:\\s*(#[0-9A-Fa-f]{3,8})`, 'i'));
  return m ? m[1].toLowerCase() : null;
}

describe('golden-era scheduler scope', () => {
  test('the bronze ramp is on the .ge-scheduler class scope, not :root', () => {
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

  test('the scheduler route carries the scope class', () => {
    expect(PAGE).toMatch(/className="[^"]*\bge-scheduler\b[^"]*"/);
  });

  /* Reserved medical red is #A81E22 / --locked / --stamp-red and is never
     decorative chrome. The scheduler block is bronze, wood, paper and patina;
     this pins that it stays that way rather than trusting a reading of it.

     COMMENTS ARE STRIPPED FIRST, and the reason is worth stating: the block's
     own header names the reserved red in order to say it is not used, so a raw
     scan of the text fails on its own documentation. The fix for that is never
     an allow-list — it is to measure the DECLARATIONS, which is what actually
     ships to a browser. Verified by watching this go red before the strip. */
  const SCHEDULER_DECLARATIONS = css
    .slice(css.indexOf('.ge-scheduler {'))
    .replace(/\/\*[\s\S]*?\*\//g, '');

  test('the scheduler block never reaches the reserved medical red', () => {
    // The slice has to have found the real block, or this asserts about "".
    expect(SCHEDULER_DECLARATIONS).toContain('--brass-500');
    expect(SCHEDULER_DECLARATIONS).not.toMatch(/#A81E22/i);
    expect(SCHEDULER_DECLARATIONS).not.toMatch(/var\(--locked/);
    expect(SCHEDULER_DECLARATIONS).not.toMatch(/var\(--stamp-red/);
  });
});

describe('the 005 mockup did not delete or invent scheduler controls', () => {
  /** Every action the route can really send to /api/pilot/scheduler. */
  const REAL_ACTIONS = [
    'register_class',
    'cover_class',
    'create_class',
    'request_coaching',
    'attendance_checkin',
    'parent_review_registration',
    'review_coaching_request',
  ] as const;

  /** The label on every button a user can really press here. */
  const REAL_BUTTONS = [
    'Register',
    'Cover Class',
    'Schedule Class',
    'Submit Request',
    'Check In',
    'Update Attendance',
    'Mark Parent Reviewed',
    'Decline',
  ] as const;

  /** The navigation destinations that really exist in the header rail. */
  const REAL_LINKS = ['/admin/attendance'] as const;

  /* Operations left this list on 2026-08-26, and it is still asserted -- one
     line down, against the component that now renders it.

     The owner decision restricting the hub to administrators means an athlete,
     a coach and a parent -- three of the four roles this page admits -- must
     not be offered it, so the rail's Operations control is <OperationsLink>
     rather than a raw <Link href="/operations">. A raw-href assertion would
     now fail for the right reason and read like a deletion, which is exactly
     the confusion this scope test exists to prevent. The control is still
     required to be here; what changed is who it renders for. */
  const OPERATIONS_RAIL_CONTROL = '<OperationsLink';

  /** The role gates that decide who sees which of the above. */
  const REAL_ROLE_GATES = [
    'roleCanManageClasses',
    'roleCanManageParents',
    'roleCanOverrideAttendance',
    'roleCanResolveCoachingRequests',
  ] as const;

  test.each(REAL_ACTIONS)('the %s action still exists', (action) => {
    expect(PAGE).toContain(`action: '${action}'`);
  });

  /* A label is asserted as a whole JSX text node or a whole string literal, not
     as a substring: `toContain('Register')` is satisfied by the word
     "Registration" in a heading, so it would stay green after the button it is
     supposed to be guarding was deleted. */
  function rendersLabel(label: string): boolean {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(>\\s*${escaped}\\s*<|'${escaped}')`).test(PAGE);
  }

  test.each(REAL_BUTTONS)('the %s button still exists', (label) => {
    expect(rendersLabel(label)).toBe(true);
  });

  test('the Approve & Assign button still exists', () => {
    // Written as a JSX entity in the source, so it is asserted on its own.
    expect(PAGE).toContain('Approve &amp; Assign');
  });

  test.each(REAL_LINKS)('the %s link still exists', (href) => {
    expect(PAGE).toContain(`href="${href}"`);
  });

  test('the Operations rail control still exists, now role-scoped', () => {
    expect(PAGE).toContain(OPERATIONS_RAIL_CONTROL);
    // And it is NOT a raw link any more: a plain href here would put the hub
    // back in front of every role this page admits.
    expect(PAGE).not.toContain('href="/operations"');
  });

  test.each(REAL_ROLE_GATES)('the %s gate still exists', (gate) => {
    expect(PAGE).toContain(`function ${gate}(`);
  });

  test('the three attendance outcomes still exist', () => {
    for (const status of ['present', 'absent', 'excused']) {
      expect(PAGE).toContain(`value="${status}"`);
    }
  });

  /* Counted, not just named. A restyle that quietly dropped one of two
     identical selects would still pass every "contains" assertion above. */
  test('the control counts are unchanged', () => {
    expect(PAGE.match(/type="button"/g) ?? []).toHaveLength(8);
    expect(PAGE.match(/<select/g) ?? []).toHaveLength(4);
    expect(PAGE.match(/<input/g) ?? []).toHaveLength(7);
    expect(PAGE.match(/<textarea/g) ?? []).toHaveLength(2);
    /* Still two navigation controls in the rail, and the count is still what
       catches a quiet deletion -- but one of them is <OperationsLink> since
       2026-08-26, so counting `<Link` alone would now read 1 and report a
       restyle that never happened. Both halves are pinned, so removing either
       control still fails. */
    expect(PAGE.match(/<Link/g) ?? []).toHaveLength(1);
    expect(PAGE.match(/<OperationsLink/g) ?? []).toHaveLength(1);
    expect(PAGE.match(/action: '/g) ?? []).toHaveLength(8);
  });

  test('no day/week/month view switch was invented from the reference image', () => {
    // Drawn across the top of both locked references, backed by nothing here:
    // there is no view state, no query parameter and no server field for it.
    expect(PAGE).not.toMatch(/\b(viewMode|setViewMode|scheduleView)\b/);
    expect(PAGE).not.toMatch(/>\s*(Day|Week|Month)\s*</);
  });

  test('exactly one element carries the scope', () => {
    // The class rides on the <main> the whole page already passes through, and
    // that single class is the entire markup change this pass made. A second
    // wrapper would be a markup change nobody authorised, and the reviewer
    // should see it here before they see it on a screen.
    expect(PAGE.match(/className="[^"]*\bge-scheduler\b/g) ?? []).toHaveLength(1);
  });
});

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
  path.resolve(__dirname, '../../app/schedule/page.tsx'),
  'utf8',
);

/* 2026-10-02 (OD-2026-10-02-004, OD-2026-10-02-007): nothing about the look
   binds, so the cases here that pinned this screen's look were removed -- the
   bronze ramp and its channel triples, the scope class, selector shape, "only
   markup this pass added", control counts and "not renamed". What remains
   guards meaning and function: the --locked token, stamps and badges, gates
   and refusals, real controls still present, nothing invented. Where the
   header above describes a removed case it is history, kept as the record of
   why the case was written. */

describe('golden-era scheduler scope', () => {

  /* --locked means a medical stop and is never decorative chrome. Red itself
     is not reserved (OD-2026-09-29-001), so the hue and --stamp-red are not
     refused here. The scheduler block is bronze, wood, paper and patina;
     this pins that it does not reach for the medical-stop token rather than
     trusting a reading of it.

     COMMENTS ARE STRIPPED FIRST, and the reason is worth stating: the block's
     own header names the locked red in order to say it is not used, so a raw
     scan of the text fails on its own documentation. The fix for that is never
     an allow-list — it is to measure the DECLARATIONS, which is what actually
     ships to a browser. Verified by watching this go red before the strip. */
  const SCHEDULER_DECLARATIONS = css
    .slice(css.indexOf('.ge-scheduler {'))
    .replace(/\/\*[\s\S]*?\*\//g, '');

  test('the scheduler block never reaches the --locked medical-stop token', () => {
    // The slice has to have found the real block, or this asserts about "".
    expect(SCHEDULER_DECLARATIONS).toContain('--brass-500');
    expect(SCHEDULER_DECLARATIONS).not.toMatch(/var\(--locked/);
    expect(MEDICAL_STOP_TOKENS)
      .toEqual(expect.arrayContaining(['--locked', '--safety-locked', '--status-critical', '--status-danger']));
    expect(medicalStopReferences(SCHEDULER_DECLARATIONS)).toEqual([]);
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

  test('no day/week/month view switch was invented from the reference image', () => {
    // Drawn across the top of both locked references, backed by nothing here:
    // there is no view state, no query parameter and no server field for it.
    expect(PAGE).not.toMatch(/\b(viewMode|setViewMode|scheduleView)\b/);
    expect(PAGE).not.toMatch(/>\s*(Day|Week|Month)\s*</);
  });

});

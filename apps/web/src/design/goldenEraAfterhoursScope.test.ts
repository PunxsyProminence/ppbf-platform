import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * GOLDEN ERA 006 — SHADOW (After Hours).
 *
 * Three contracts live here, and the last two are the ones that matter.
 *
 * 1. THE TOKEN SCOPE. `.ge-afterhours` redefines the brass ramp to aged bronze
 *    so every shared component this console renders — the .mat-leather panels,
 *    the .mat-slate console body, .btn--lever, the gauge bezel/ticks/needle/hub
 *    and the .t-eyebrow voice — resolves Golden Era metal together. A property
 *    override leaks wherever it is forgotten; a token override cannot. Same
 *    seam .ge-bell, .ge-floorboard and .ge-locker use.
 *
 * 2. THE RESERVED RED IS NOT SPENT ON THE ROOM. #A81E22 / --locked /
 *    --stamp-red is MEDICALLY_NOT_ALLOWED, and After Hours is the room where
 *    that matters most: /admin/shadow paints real refusals, review gates and
 *    safety states, so a decorative red anywhere in this scope teaches a
 *    reader's eye that the gate's red is furniture. The whole 006 identity is
 *    built from bronze, hide, wood and bone, and this pins it — every
 *    declaration under the scope, checked for the seed colour, its rgb
 *    spelling and both reserved token names.
 *
 *    Checked on COMMENT-STRIPPED css on purpose. The scoped block's own header
 *    names the reservation in prose ("NO RESERVED RED. #A81E22 / --locked /
 *    --stamp-red is MEDICALLY_NOT_ALLOWED and nothing else"), which is the
 *    sentence that keeps the next author from re-deciding it. A guard that
 *    cannot tell prose from a declaration would force the comment to stop
 *    naming the rule it exists to protect — the same reasoning typeLadder.test
 *    already applies to token names discussed in prose.
 *
 * 3. THE REAL CONTROL SET SURVIVES THE MOCKUP. The locked 006 reference draws
 *    three plaques across the top of the board — SCOUT / ARCHITECT / OMEGA
 *    MODE — and no such control exists on /admin/shadow. "Scout" is a word
 *    inside the eyebrow "AI/ML Telemetry Scout"; Omega is a ROLE in
 *    roleRoutes.ts, not a mode this console can switch; Architect appears
 *    nowhere in the app. ROOM-PURPOSE-DNA itself calls them "mode LABELS only".
 *
 *    Implementing the image literally would ship a mode switch with nothing
 *    behind it, on the one surface in the building where an invented control is
 *    worst. So it is pinned in both directions: every control that really
 *    exists is still here, and the three mockup labels must NOT arrive as
 *    controls. Pinned with them: the intake-write refusal that DISABLES the
 *    write levers for a platform-owner session. A restyle must not be able to
 *    quietly un-gate a SHADOW write, and "the CSS pass did it" is exactly how
 *    that would happen unnoticed.
 *
 * MUTATION CHECK: set a `--brass-NNN` rung on `.ge-afterhours` back to its
 * legacy value, or drop the class from the page, or delete a real control, or
 * paint one declaration in the reserved red — each turns this suite red.
 */

const BRASS_RUNGS = ['200', '300', '400', '500', '600', '700', '800', '900'] as const;

const css = readDesignSystemCss(DESIGN_SYSTEM_ENTRY);

const PAGE = readFileSync(
  path.resolve(__dirname, '../../app/admin/shadow/page.tsx'),
  'utf8',
);

/** The bare `.ge-afterhours { … }` token rule, not its descendant rules. */
function scopeBody(source: string): string | null {
  const match = source.match(/^\.ge-afterhours\s*\{([^}]*)\}/m);
  return match ? match[1] : null;
}

function legacyRung(source: string, rung: string): string | null {
  const withoutScope = source.replace(/^\.ge-afterhours\s*\{[^}]*\}/m, '');
  const m = withoutScope.match(new RegExp(`--brass-${rung}\\s*:\\s*(#[0-9A-Fa-f]{3,8})`, 'i'));
  return m ? m[1].toLowerCase() : null;
}

describe('golden-era after-hours scope', () => {
  test('the bronze ramp is on the .ge-afterhours class scope, not :root', () => {
    expect(scopeBody(css)).not.toBeNull();
    for (const block of css.match(/:root\s*\{[^}]*\}/g) ?? []) {
      expect(block).not.toContain('#E7C88A');
    }
  });

  test.each(BRASS_RUNGS)('brass rung %s is redefined on the scope and differs from legacy', (rung) => {
    const body = scopeBody(css);
    expect(body).not.toBeNull();
    const scoped = (body as string).match(new RegExp(`--brass-${rung}\\s*:\\s*(#[0-9A-Fa-f]{3,8})`, 'i'));
    expect(scoped).not.toBeNull();
    expect((scoped as RegExpMatchArray)[1].toLowerCase()).not.toEqual(legacyRung(css, rung));
  });

  test('the SHADOW admin console carries the scope class', () => {
    expect(PAGE).toMatch(/className="[^"]*\bge-afterhours\b[^"]*"/);
  });

  /* The packet's room. After Hours is `.room--night`, the shell states it from
     this prop, and a visual pass that swapped the wall would be a room change
     rather than a restyle. */
  test('the console still stands in the night room', () => {
    expect(PAGE).toContain('room="night"');
  });
});

describe('the 006 scope never spends the reserved medical red', () => {
  /** Every rule whose selector list names `.ge-afterhours`, comments removed. */
  function scopedRules(): Array<[string, string]> {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules: Array<[string, string]> = [];
    for (const rule of stripped.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      if (/\.ge-afterhours\b/.test(rule[1])) rules.push([rule[1].trim(), rule[2]]);
    }
    return rules;
  }

  /* A guard that matched nothing would report the property is held. The scope
     is one token rule, one lamp rule, three bracket rules, five material rules
     and four voice rules — well above this floor, and the floor only has to
     prove the parse works. */
  test('parses a real set of scoped rules, so the checks below are not vacuous', () => {
    expect(scopedRules().length).toBeGreaterThan(8);
  });

  test.each([
    ['the seed colour', /#A81E22/i],
    ['its rgb spelling', /168\s*,\s*30\s*,\s*34/],
    ['the --locked token', /--locked\b/],
    ['the --stamp-red token', /--stamp-red\b/],
  ])('no declaration under the scope reaches %s', (_label, pattern) => {
    const offenders = scopedRules()
      .filter(([, body]) => pattern.test(body))
      .map(([selectors]) => selectors);
    expect(offenders).toEqual([]);
  });
});

describe('the 006 mockup did not delete or invent SHADOW controls', () => {
  /** The QUICK_ADD_OPTIONS array literal only, so the same word appearing in a
   *  union type or a comment cannot satisfy or break these assertions. */
  function quickAddBlock(): string {
    const m = PAGE.match(/const QUICK_ADD_OPTIONS[^=]*=\s*\[([\s\S]*?)\n\];/);
    expect(m).not.toBeNull();
    return (m as RegExpMatchArray)[1];
  }

  const QUICK_ADD_LABELS = [
    'Workout',
    'Biometric',
    'Coach Note',
    'Video',
    'Athlete Check-In',
    'Parent Observation',
    'Board Document',
    'Policy Draft',
    'Incident Note',
    'Assessment Result',
  ] as const;

  test.each(QUICK_ADD_LABELS)('the real Quick Add option %s still exists', (label) => {
    expect(quickAddBlock()).toContain(`label: '${label}'`);
  });

  test('the Quick Add count is unchanged', () => {
    expect(quickAddBlock().match(/label: '/g) ?? []).toHaveLength(QUICK_ADD_LABELS.length);
  });

  test('the seven command hints are unchanged', () => {
    expect(PAGE).toContain(
      "const commandHints = ['merge', 'status', 'list', 'clear', 'summarize', 'approve', 'reject'];",
    );
  });

  test('the four per-item actions are unchanged', () => {
    expect(PAGE).toContain("(['VIEW', 'APPROVE', 'REJECT', 'IMPORT'] as const)");
  });

  /* One entry per labelled control the console renders outside the arrays
     above. A restyle has no business removing any of them, and a mockup that
     omits one is not a licence to. */
  const LABELLED_CONTROLS = [
    'Filter Status',
    'Sort',
    'Detected Type',
    'Suggested Destination',
    'Confidence',
    'Requires Jason Review',
    'Notes',
    'Destination Route',
    'Upload PDF',
    'Submit Command',
    'telemetry and authority streams',
    'Admin Hub',
  ] as const;

  test.each(LABELLED_CONTROLS)('the real control %s still exists', (label) => {
    expect(PAGE).toContain(label);
  });

  test('both console exits still link out', () => {
    expect(PAGE).toContain('href="/admin"');
    expect(PAGE).toContain('href="/shadow"');
  });

  /* Drawn in the locked mockup, backed by nothing here. Architect and Omega
     mode do not exist on this route at all; Scout exists only as a word inside
     one eyebrow, so it is pinned by count rather than by absence. */
  test('no mode switch was invented from the reference image', () => {
    expect(PAGE).not.toContain('Architect');
    expect(PAGE).not.toContain('Omega mode');
    const scout = (PAGE.match(/Scout/g) ?? []).length;
    const eyebrow = (PAGE.match(/AI\/ML Telemetry Scout/g) ?? []).length;
    expect(eyebrow).toBe(1);
    expect(scout).toBe(eyebrow);
  });

  /* THE RESTYLE MAY NOT UN-GATE A SHADOW WRITE. Upload, case review-action,
     document review and feedback promotion are refused for a platform-owner
     session by the routes behind them, and this console states that on the
     control instead of letting a 403 arrive looking like a bug. */
  test('the intake-write refusal still gates the write levers', () => {
    expect(PAGE).toContain("const intakeWriteRefusal = pilotSession.role === 'platform_owner'");
    expect(PAGE).toContain("action !== 'VIEW' && Boolean(intakeWriteRefusal)");
    expect(PAGE).toContain("action === 'IMPORT' && item.status !== 'Approved'");
  });
});

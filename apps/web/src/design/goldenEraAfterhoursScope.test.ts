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
 * 2. THE --locked TOKEN IS NOT SPENT ON THE ROOM. --locked means
 *    MEDICALLY_NOT_ALLOWED, and After Hours is the room where that matters
 *    most: /admin/shadow paints real refusals, review gates and safety states,
 *    so decorating this scope with the medical-stop token teaches a reader's
 *    eye that the gate is furniture. Every declaration under the scope is
 *    checked for the token name.
 *
 *    Red itself is not reserved (OD-2026-09-29-001), so the seed colour, its
 *    rgb spelling and --stamp-red are no longer refused here.
 *
 *    Checked on COMMENT-STRIPPED css on purpose. The scoped block's own header
 *    names the rule in prose ("NO LOCKED RED. --locked (#A81E22, also
 *    --stamp-red) means MEDICALLY_NOT_ALLOWED"), which is the
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
 * paint one declaration with var(--locked) — each turns this suite red.
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
  path.resolve(__dirname, '../../app/admin/shadow/page.tsx'),
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

describe('the 006 scope never spends the --locked medical-stop token', () => {
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
    ['the --locked token', /--locked\b/],
  ])('no declaration under the scope reaches %s', (_label, pattern) => {
    const offenders = scopedRules()
      .filter(([, body]) => pattern.test(body))
      .map(([selectors]) => selectors);
    expect(offenders).toEqual([]);
  });

  test('no declaration under the scope reaches an alias of --locked', () => {
    expect(MEDICAL_STOP_TOKENS)
      .toEqual(expect.arrayContaining(['--locked', '--safety-locked', '--status-critical', '--status-danger']));
    const offenders = scopedRules()
      .map(([selectors, body]) => [selectors, medicalStopReferences(body)] as const)
      .filter(([, names]) => names.length > 0)
      .map(([selectors, names]) => `${selectors}: ${names.join(', ')}`);
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

import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * THE GYM-FLOOR TYPE FLOOR, AND WHY IT NEEDS A GUARD OF ITS OWN.
 *
 * Law 5 names `--t-md` (19.1px) the kiosk minimum and FRONTEND_STYLE_CONTRACT
 * repeats it. The TARGET half of that floor -- 55px controls -- has been
 * enforced since the sweep that found a session-duration field at 36px, and
 * `kioskTapFloor.test.ts` holds it. The TYPE half was never written, and it
 * was invisible for a reason a reader of the stylesheet would not guess: the
 * semantic voices are declared with a `font:` SHORTHAND, so their size is
 * welded to their family and weight and no token override reaches it.
 * Measured in Chromium on the athlete dashboard before this file existed:
 * .t-eyebrow 11px, .t-label 11px, .badge 11px, .t-muted 12.5px, .t-data 13px,
 * .t-body 14px -- desk sizes, on the tablet a child reads at arm's length.
 *
 * THREE WAYS THIS FLOOR DIES SILENTLY, and one assertion each:
 *
 *   1. THE RULE IS DELETED OR RETUNED. A size named as a hex or a bare px
 *      passes a reading that only looks for the selector, so each voice is
 *      checked against the RUNG it owes, not against a number.
 *   2. THE RULE IS WRAPPED IN A LAYER. Every voice it corrects is declared in
 *      an unlayered sheet, and an unlayered rule beats any layered one however
 *      specific. Wrapped in `@layer`, this floor would still read correctly in
 *      the file and apply to nothing -- the same failure that put every
 *      athlete button at 44px while its class string asked for var(--tap).
 *   3. A LATER RULE QUIETLY WINS. These are (0,2,0). A later rule of equal or
 *      greater weight that sets a font-size on the same voice takes the floor
 *      back, and nothing anywhere goes red. The sweep below walks every rule
 *      AFTER the floor in the resolved sheet and fails on any that could reach
 *      a voice inside a kiosk subtree.
 *
 * AND ONE WAY IT COULD DO HARM: by reaching a surface it is not for. The
 * desktop and admin ladders are dense on purpose -- a coach at a desk reading
 * a roster is not a child in gloves -- so the last assertion holds that every
 * declaration here is scoped to `[data-surface="kiosk"]` and that the base
 * voices still carry the sizes they always had.
 *
 * MUTATION CHECK, four mutations actually applied to the sheet and run, each
 * reverted after: dropping the `.t-data--xl` restatement -> 1 failed (the
 * floor would pull a 30.9px figure DOWN to 24.3px); changing the eyebrow's
 * `var(--t-md)` to `var(--t-sm)` -> 1 failed; wrapping the whole block in
 * `@layer base` -> 2 failed (the layering assertion, and the first voice with
 * it, since the rule no longer starts where a rule can start); adding
 * `.ge-locker .t-body { font-size: 14px; }` after the floor -> 1 failed.
 */

const CSS = readDesignSystemCss(DESIGN_SYSTEM_ENTRY);

/** Every voice the ruling moves, with the rung it owes. */
const FLOOR: ReadonlyArray<{ readonly voice: string; readonly rung: string; readonly why: string }> = [
  { voice: '.t-eyebrow', rung: '--t-md', why: 'the label over a count, a flag or a reported pain' },
  { voice: '.t-label', rung: '--t-md', why: 'the field legends on a self-report' },
  { voice: '.t-body', rung: '--t-md', why: 'the prose an athlete is asked to act on' },
  { voice: '.t-muted', rung: '--t-md', why: 'the caveat that says a number is not what it looks like' },
  { voice: '.badge', rung: '--t-md', why: 'a state -- cleared, monitor, restricted, locked' },
  { voice: '.badge i', rung: '--t-md', why: "the badge's non-colour channel, which Law 3 requires" },
  { voice: '.t-data', rung: '--t-lg', why: 'the figure itself' },
  { voice: '.t-data--lg', rung: '--t-lg', why: 'a sanctioned larger figure, held at its own rung' },
  { voice: '.t-data--xl', rung: '--t-xl', why: 'the largest sanctioned figure, held at its own rung' },
];

/** The scoped selector for a voice, exactly as the sheet must spell it. */
const scoped = (voice: string) => `[data-surface="kiosk"] ${voice}`;

/** The body of the LAST rule with this exact selector, or null. */
function ruleBody(selector: string): string | null {
  /* Anchored on what can precede a rule -- start of sheet, the close of the
     previous rule, or the close of a comment -- so looking for `.t-body` does
     not quietly match the tail of `.ge-scripts article .t-body`. The comment
     case is not hypothetical: every rule of this floor is introduced by one. */
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...CSS.matchAll(new RegExp(`(?:^|\\}|\\*/)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  return matches.length ? matches[matches.length - 1][1] : null;
}

describe('the gym-floor type floor', () => {
  it('reads a real sheet, so nothing below passes on an empty string', () => {
    expect(CSS.length).toBeGreaterThan(10_000);
    expect(CSS).toContain('--t-md:  19.1px');
    expect(CSS).toContain('--tap: 55px');
  });

  it.each(FLOOR)('raises $voice to $rung on a kiosk surface — $why', ({ voice, rung }) => {
    const body = ruleBody(scoped(voice));

    expect(
      body === null
        ? `no rule for \`${scoped(voice)}\` in the resolved design system. Law 5 makes `
          + `${rung} the floor for this voice on a gym-floor surface.`
        : body,
    ).toContain(`var(${rung})`);
  });

  it('states the floor UNLAYERED, where it can actually win', () => {
    /* The voices are declared in an unlayered sheet. A layered rule loses to an
       unlayered one at any specificity, so a floor inside `@layer` reads
       correctly and applies to nothing. */
    expect(CSS).not.toMatch(/@layer[^{]*\{[\s\S]{0,4000}?\[data-surface="kiosk"\]\s+\.t-eyebrow/);
  });

  it('is not taken back by a later rule that reaches the same voice', () => {
    const floorAt = CSS.indexOf(scoped('.t-eyebrow'));
    expect(floorAt).toBeGreaterThan(-1);

    /* Everything after the floor, rule by rule. The floor is (0,2,0), and the
       voices it corrects are (0,1,0) declared in an UNLAYERED sheet that the
       foundation is imported before -- so the bare `.t-eyebrow { font: 650
       11px }` further down the resolved stream is later AND weaker, and loses.
       Only a rule that also reaches (0,2,0) can take the floor back, so that is
       what this looks for. Anything weaker is noise, and a guard that reports
       noise is a guard somebody deletes. */
    const weight = (selector: string): number => {
      const bare = selector.replace(/\/\*[\s\S]*?\*\//g, '');
      const ids = (bare.match(/#[\w-]+/g) ?? []).length;
      const classes = (bare.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
      return ids * 100 + classes * 10;
    };

    /* One exemption, and it is not a size change: the sign-in board raises its
       own body copy to the SAME rung this floor uses. It is recorded rather
       than pattern-matched away, so if it ever moves off --t-md it comes back
       here as a decision. */
    const EXEMPT = new Map([['.ge-bell header .t-body', '--t-md, the same rung: raises, never lowers']]);

    const after = CSS.slice(floorAt);
    const voices = FLOOR.map((entry) => entry.voice.split(' ')[0]);
    const offenders: string[] = [];

    for (const match of after.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
      const body = match[2];
      if (!/font-size\s*:|font\s*:/.test(body)) continue;
      if (selector.includes('[data-surface="kiosk"]')) continue;
      if (EXEMPT.has(selector)) continue;
      if (!voices.some((voice) => new RegExp(`\\${voice}\\b`).test(selector))) continue;
      if (weight(selector) < 20) continue;
      offenders.push(`${selector.slice(0, 90)} { ${body.trim().slice(0, 60)} }`);
    }

    expect(
      offenders.length === 0
        ? true
        : 'these rules come AFTER the kiosk type floor, reach (0,2,0) or better, and set a size '
          + 'on a voice it holds -- so they win and the floor is gone on any surface they reach. '
          + 'Either scope them under [data-surface="kiosk"] too, or record them in EXEMPT with '
          + `the reason:\n  ${offenders.join('\n  ')}`,
    ).toBe(true);
  });

  it('changes nothing off a gym-floor surface', () => {
    /* Every declaration of this floor is inside the kiosk scope, and the base
       voices still carry the sizes the desk ladder was built on. A coach
       reading a roster at a desk is not a child in gloves. */
    for (const { voice, rung } of FLOOR) {
      const unscoped = ruleBody(voice);
      if (unscoped === null) continue;
      expect(
        unscoped.includes(`var(${rung})`) && rung === '--t-md'
          ? `the BASE ${voice} now carries ${rung}: the kiosk floor has been applied to every `
            + 'surface, not to the gym floor.'
          : true,
      ).toBe(true);
    }

    expect(CSS).toMatch(/\.t-eyebrow\s*\{[^}]*font:\s*650\s+11px/);
    expect(CSS).toMatch(/\.t-body\s*\{[^}]*font-size:\s*14px/);
    expect(CSS).toMatch(/\.t-data\s*\{[^}]*font:\s*650\s+13px/);
  });
});

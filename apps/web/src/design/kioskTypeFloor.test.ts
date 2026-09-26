import { readDesignSystemCss, DESIGN_SYSTEM_ENTRY } from './readDesignSystemCss';

/**
 * THE GYM-FLOOR TYPE FLOOR, AND WHY IT NEEDS A GUARD OF ITS OWN.
 *
 * Law 5 names `--t-md` (19.1px) the kiosk minimum and FRONTEND_STYLE_CONTRACT
 * repeats it. The TARGET half of that floor -- 55px controls -- has been
 * enforced since the sweep that found a session-duration field at 36px, and
 * `kioskTapFloor.test.ts` holds it. The TYPE half was never written, and it
 * was invisible for a reason a reader of the stylesheet would not guess: every
 * one of these voices pins a LITERAL px size, so there is no `var()` in any of
 * them for a token, a ramp or a scope override to point somewhere else. Four
 * of the six do it through a `font:` SHORTHAND, which additionally welds the
 * size to the family and the weight; two do not. Checked against origin/main
 * `design-system/legacy/ppbf-leather-brass.css`:
 *
 *   .t-eyebrow  :675  `font: 650 11px/1 var(--font-data)`     shorthand
 *   .t-label    :682  `font: 650 11px/1 var(--font-data)`     shorthand
 *   .t-data     :685  `font: 650 13px/1.5 var(--font-data)`   shorthand
 *   .badge      :807  `font: 700 11px/1 var(--font-ui)`       shorthand
 *   .t-body     :679  `font-size: 14px`                       ordinary
 *   .t-muted    :680  `font-size: 12.5px`                     ordinary
 *
 * An earlier version of this docblock said the shorthand explained all six. It
 * explains four. The literal explains six, and the literal is what the rules
 * under guard here actually correct.
 *
 * WHAT WAS MEASURED, AND WHAT WAS ONLY READ. Measured in Chromium on the
 * athlete dashboard at 412x915, every element of the voice counted:
 * .t-eyebrow 3 at 11px, .t-label 25 at 11px, .t-muted 7 at 12.5px, .t-body 4
 * of 6 at 14px. NOT measured, and not claimed as measured: .badge at 11px and
 * .t-data at 13px are the values their rules DECLARE, read off the stylesheet
 * at the two lines above. The distinction is not pedantry -- an earlier
 * version of this file and of safetyCriticalSuites.json said "measured 11px
 * badges" while the PR's own BLIND SPOTS said badges never rendered on the
 * route, and both statements cannot be true. The badge does render there:
 * every goal card prints one (components/AthleteWorkspace.tsx:2691, through
 * getGoalStatusBadge at :424). It was simply never counted.
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
 *      in the resolved sheet and fails on any that could reach a voice inside
 *      a kiosk subtree.
 *
 * THE HOLE IN WAY 3, AND THE REPAIR. The first version of that sweep compared
 * SELECTOR WEIGHT only and discarded anything under (0,2,0). The cascade does
 * not work that way: it compares IMPORTANCE before it compares weight, so
 * `.t-body { font-size: 14px !important; }` -- (0,1,0), weaker than this floor
 * by a whole component, and therefore silently skipped -- takes the gym floor
 * straight back to a desk size with the suite green. Importance is now checked
 * first and across the WHOLE sheet rather than only after the floor, because
 * an important declaration beats a normal one wherever it sits. Weight is only
 * consulted for normal declarations, where source order still decides.
 *
 * AND ONE WAY IT COULD DO HARM: by reaching a surface it is not for. The
 * desktop and admin ladders are dense on purpose -- a coach at a desk reading
 * a roster is not a child in gloves -- so the last assertions hold that every
 * declaration here is scoped to `[data-surface="kiosk"]` and that all six base
 * voices still carry the sizes the desk ladder was built on. All six: pinning
 * three of them, which is what this file used to do, left .t-label, .t-muted
 * and .badge free to drift with the suite green, and a drifted base makes the
 * floor above correct a size that is no longer there.
 *
 * THE CONTROLS ARE HALF OF LAW 5 TOO. 19.1px is a property of the SURFACE, not
 * of six class names, and a button label wears none of them. The floor in
 * `ppbf-foundation.css` therefore also states a rung for the control set, and
 * this file holds that rule selector by selector -- deleting one line of a
 * nine-selector list is exactly the kind of edit no reviewer catches.
 *
 * MUTATION CHECK, five mutations actually applied to the sheet and run, each
 * reverted after: dropping the `.t-data--xl` restatement -> 1 failed (the
 * floor would pull a 30.9px figure DOWN to 24.3px); changing the eyebrow's
 * `var(--t-md)` to `var(--t-sm)` -> 1 failed; wrapping the whole block in
 * `@layer base` -> 2 failed (the layering assertion, and the first voice with
 * it, since the rule no longer starts where a rule can start); adding
 * `.ge-locker .t-body { font-size: 14px; }` after the floor -> 1 failed; and
 * the one this file was reopened for, `.t-body { font-size: 14px !important; }`
 * after the floor -> 1 failed, where before the repair it was 0.
 */

const CSS = readDesignSystemCss(DESIGN_SYSTEM_ENTRY);

/* The same sheet with comments removed. Every structural reading below --
   which rule is which, what nests inside what -- is done against this rather
   than the raw text, because this repository's comments are long and quote CSS
   and JSX at each other: `style={{ fontSize }}` inside a comment puts braces
   into a brace-counting parser, and a parser that has been fooled reports a
   clean sheet rather than an error. Verified once against the resolved sheet:
   stripping removes 16 braces, all of them from comments, and leaves the
   brace depth balanced at 0 -- which the layering assertion re-checks on
   every run rather than trusting. */
const SHEET = CSS.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** Every voice the ruling moves, with the rung it owes. */
const FLOOR: ReadonlyArray<{ readonly voice: string; readonly rung: string; readonly why: string }> = [
  { voice: '.t-eyebrow', rung: '--t-md', why: 'the label over a count, a flag or a reported pain' },
  { voice: '.t-label', rung: '--t-md', why: 'the field legends on a self-report' },
  { voice: '.t-body', rung: '--t-md', why: 'the prose an athlete is asked to act on' },
  { voice: '.t-muted', rung: '--t-md', why: 'the caveat that says a number is not what it looks like' },
  { voice: '.badge', rung: '--t-md', why: 'a state -- cleared, monitor, restricted, locked' },
  { voice: '.badge i', rung: '--t-md', why: "the badge's non-colour channel, which Law 3 requires" },
  { voice: '.t-data', rung: '--t-lg', why: 'the figure itself' },
  { voice: '.t-data--xl', rung: '--t-xl', why: 'the largest sanctioned figure, held at its own rung' },
];

/**
 * The control set the same floor raises, selector by selector, with the size
 * each one was found at. `.t-data--lg` is deliberately absent from FLOOR above
 * for the mirror-image reason: it resolves --t-lg already and the kiosk
 * `.t-data` rule resolves --t-lg too, so a restatement would have defended
 * nothing and existed only to satisfy this list. These nine do defend
 * something, and the numbers are what they defend it from.
 */
const CONTROL_FLOOR: ReadonlyArray<{ readonly selector: string; readonly why: string }> = [
  { selector: '.btn', why: 'the button component, 15px at legacy/ppbf-leather-brass.css:828' },
  { selector: '.input', why: 'a text field, 15px at :907' },
  { selector: '.select', why: 'a dropdown, 15px at :907' },
  { selector: '.textarea', why: 'a free-text field, 15px at :907' },
  { selector: 'button', why: 'a bare button, which is what /schedule review controls are' },
  { selector: '[role="button"]', why: 'an element that ARIA has made a control' },
  { selector: 'input', why: 'a bare input carrying no component class' },
  { selector: 'select', why: 'a bare select carrying no component class' },
  { selector: 'textarea', why: 'a bare textarea carrying no component class' },
];

/**
 * The desk ladder, voice by voice, as origin/main declares it. The floor above
 * says it raises an 11px eyebrow to 19.1px; if the base drifts to 16px that
 * sentence is fiction, the size delta on the gym floor is not what the PR
 * measured, and nothing else in the suite notices.
 */
const BASE: ReadonlyArray<{
  readonly voice: string;
  readonly declared: string;
  readonly at: string;
  readonly size: RegExp;
}> = [
  { voice: '.t-eyebrow', declared: '11px, through the `font:` shorthand', at: 'legacy/ppbf-leather-brass.css:675', size: /\.t-eyebrow\s*\{[^}]*font:\s*650\s+11px/ },
  { voice: '.t-label', declared: '11px, through the `font:` shorthand', at: 'legacy/ppbf-leather-brass.css:682', size: /\.t-label\s*\{[^}]*font:\s*650\s+11px/ },
  { voice: '.t-body', declared: '14px', at: 'legacy/ppbf-leather-brass.css:679', size: /\.t-body\s*\{[^}]*font-size:\s*14px/ },
  { voice: '.t-muted', declared: '12.5px', at: 'legacy/ppbf-leather-brass.css:680', size: /\.t-muted\s*\{[^}]*font-size:\s*12\.5px/ },
  { voice: '.badge', declared: '11px, through the `font:` shorthand', at: 'legacy/ppbf-leather-brass.css:807', size: /\.badge\s*\{[^}]*font:\s*700\s+11px/ },
  { voice: '.t-data', declared: '13px, through the `font:` shorthand', at: 'legacy/ppbf-leather-brass.css:685', size: /\.t-data\s*\{[^}]*font:\s*650\s+13px/ },
];

/** The scoped selector for a voice, exactly as the sheet must spell it. */
const scoped = (voice: string) => `[data-surface="kiosk"] ${voice}`;

type Rule = { readonly selectors: readonly string[]; readonly body: string; readonly at: number };

/**
 * Every rule in the resolved sheet, in source order, with its selector list
 * split. Splitting matters: the control floor is one rule carrying nine
 * selectors, and a lookup that compares the whole selector TEXT would not find
 * any of them -- nor would it read `.input, .select, .textarea` as three
 * (0,1,0) selectors, which is what the cascade reads it as.
 *
 * At-rule preludes (`@media ...`) never match a `{` followed by a body with no
 * braces, so what this yields from inside a media block is the block's own
 * rules, which is what the cascade sees.
 */
const RULES: readonly Rule[] = [...SHEET.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selectors: match[1].trim().split(',').map((part) => part.trim().replace(/\s+/g, ' ')).filter(Boolean),
  body: match[2],
  at: match.index ?? 0,
}));

/** The declarations in `body` that set a size, as written. */
function sizeDeclarations(body: string): readonly string[] {
  return body.split(';').filter((declaration) => /^\s*(?:font-size|font)\s*:/i.test(declaration));
}

/**
 * The body of the last rule with this selector THAT SETS A SIZE, which is the
 * one the cascade resolves a font-size from when every candidate carries the
 * same weight. "The last rule with this selector" is not the same question and
 * gives the wrong answer here: `[data-surface="kiosk"] .btn` is written twice
 * in the resolved sheet, once by the TAP floor for `min-height` and once by
 * the type floor for `font-size`, and the tap rule is the later of the two.
 * Reading it as the answer about size reported the type floor missing when it
 * was three thousand lines above and winning.
 */
function ruleBody(selector: string): string | null {
  const wanted = selector.replace(/\s+/g, ' ');
  const matches = RULES.filter(
    (rule) => rule.selectors.includes(wanted) && sizeDeclarations(rule.body).length > 0,
  );
  return matches.length ? matches[matches.length - 1].body : null;
}

/**
 * True when `selector` names `token`.
 *
 * THE TWO SIDES ARE NOT SYMMETRICAL, and closing both of them cost real
 * coverage for a day.
 *
 * A BARE TYPE token has no left boundary of its own, so `button` must not be
 * found inside `.icon-button`: it needs a guard on both sides. That half is
 * why this function was written.
 *
 * A CLASS or ATTRIBUTE token already carries its own left boundary (`.`, `#`,
 * `[`) and must deliberately KEEP matching a longer name that extends it,
 * because in this sheet a modifier is a takeback route. `.badge` is floored
 * here; `.badge--monitor` and its four siblings at
 * design-system/legacy/ppbf-leather-brass.css:814-821 are later rules that can
 * set a size on the very element `.badge` just floored, and so can
 * `.t-data--lg` at :690. Measured: appending
 * `.ge-locker .badge--monitor { font-size: 12px; }` to the legacy sheet failed
 * this suite while the right-hand guard was absent, and passed silently once
 * `(?![\w-])` was added to the class branch. A guard that goes quiet on the
 * exact families in use is the failure this file exists to prevent, so the
 * class branch is open on the right on purpose.
 */
function reaches(selector: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = /^[.#[]/.test(token)
    ? new RegExp(escaped)
    : new RegExp(`(?<![\\w.#-])${escaped}(?![\\w-])`);
  return pattern.test(selector);
}

/**
 * Specificity weight of a selector LIST: the weight of its heaviest member,
 * because that is the one that can take the floor back. Counting the whole
 * list as one selector reads `.input, .select, .textarea` as (0,3,0) when the
 * cascade reads three separate (0,1,0)s, which is a false alarm -- and a guard
 * that reports false alarms is a guard somebody deletes.
 */
function weight(selectorList: readonly string[]): number {
  return Math.max(
    0,
    ...selectorList.map((selector) => {
      const ids = (selector.match(/#[\w-]+/g) ?? []).length;
      const classes = (selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
      /* TYPE SELECTORS COUNT, and leaving them out is what let a later rule
         tie the control floor unseen. Strip the class-level parts first so
         `button` is counted once and the `button` inside `[type="button"]`
         is not counted at all. One point each, which is what the cascade
         gives them. */
      const types = (
        selector
          .replace(/\[[^\]]*\]/g, ' ')
          .replace(/[.#][\w-]+/g, ' ')
          .replace(/::?[\w-]+(\([^)]*\))?/g, ' ')
          .match(/\b[a-z][a-z0-9]*\b/gi) ?? []
      ).length;
      return ids * 100 + classes * 10 + types;
    }),
  );
}

describe('the gym-floor type floor', () => {
  it('reads a real sheet, so nothing below passes on an empty string', () => {
    expect(CSS.length).toBeGreaterThan(10_000);
    expect(CSS).toContain('--t-md:  19.1px');
    expect(CSS).toContain('--tap: 55px');
    expect(RULES.length).toBeGreaterThan(500);
  });

  it.each(FLOOR)('raises $voice to $rung on a kiosk surface — $why', ({ voice, rung }) => {
    const body = ruleBody(scoped(voice));

    expect(
      body === null
        ? `no rule for \`${scoped(voice)}\` sets a size in the resolved design system. Law 5 makes `
          + `${rung} the floor for this voice on a gym-floor surface.`
        : body,
    ).toContain(`var(${rung})`);
  });

  it.each(CONTROL_FLOOR)('raises $selector to --t-md on a kiosk surface — $why', ({ selector }) => {
    const body = ruleBody(scoped(selector));

    expect(
      body === null
        ? `no rule for \`${scoped(selector)}\` sets a size in the resolved design system. Law 5's 19.1px is `
          + 'a property of the surface, and a control label wears none of the six voice classes, '
          + 'so this selector is the only thing standing between it and a desk size.'
        : body,
    ).toContain('var(--t-md)');
  });

  it('floors the controls WITHOUT !important, which the lane refused', () => {
    /* The hammer would work and is forbidden, for a reason worth keeping in
       front of whoever reaches for it next: it would also pull the legitimately
       LARGER inline pins on these surfaces -- 10 at --t-lg, 7 at --t-xl, 1 at
       --t-2xl -- down to 19.1px. A floor that lowers a heading is not a floor. */
    for (const { selector } of CONTROL_FLOOR) {
      const body = ruleBody(scoped(selector)) ?? '';
      expect(`${scoped(selector)} { ${body.trim()} }`).not.toMatch(/!\s*important/i);
    }
  });

  it('states the floor UNLAYERED, where it can actually win', () => {
    /* The voices are declared in an unlayered sheet. A layered rule loses to an
       unlayered one at any specificity, so a floor inside `@layer` reads
       correctly and applies to nothing.

       Counted rather than pattern-matched. The previous version looked for an
       `@layer` within 4,000 characters before the floor, which was true when
       the docblock above the rule was 40 lines and quietly stopped being true
       when it grew: a `not.toMatch` that has drifted out of range passes. This
       walks the brace depth instead and asks whether ANY block still open at
       the floor was opened by an `@layer`, at any distance and however nested. */
    const floorAt = SHEET.indexOf(scoped('.t-eyebrow'));
    expect(floorAt).toBeGreaterThan(-1);

    const open: boolean[] = [];
    let prelude = '';
    let depthAtFloor: readonly boolean[] = [];
    for (let i = 0; i < SHEET.length; i += 1) {
      if (i === floorAt) {
        depthAtFloor = [...open];
      }
      const character = SHEET[i];
      if (character === '{') {
        open.push(/@layer\b/i.test(prelude));
        prelude = '';
      } else if (character === '}') {
        open.pop();
        prelude = '';
      } else {
        prelude += character;
      }
    }

    /* If the sheet does not close every block it opens, this walk was fooled
       and every answer it gave above is worthless. Say so rather than pass. */
    expect(open.length).toBe(0);
    expect(depthAtFloor.filter(Boolean).length).toBe(0);
  });

  it('is not taken back by a later rule, or by an !important one anywhere', () => {
    const floorAt = SHEET.indexOf(scoped('.t-eyebrow'));
    expect(floorAt).toBeGreaterThan(-1);

    /* Two different ways to lose, and they are not the same test.

       ORDER AND WEIGHT. The floor is (0,2,0) on the voices and (0,1,1) at its
       weakest on the bare control selectors, and the declarations it corrects
       are (0,1,0) in an UNLAYERED sheet that the foundation is imported before
       -- so the bare `.t-eyebrow { font: 650 11px }` further down the resolved
       stream is later AND weaker, and loses. Only a rule that is later and
       also reaches (0,2,0) can take the floor back by these means.

       IMPORTANCE. An `!important` declaration beats a normal one whatever the
       weight and whatever the order, so `.t-body { font-size: 14px !important }`
       at (0,1,0) -- which the weight test above discards as noise -- wins.
       That is the hole this sweep was reopened for. Importance is therefore
       checked on every rule in the sheet, not only on the ones that come
       after, and it is checked BEFORE weight, in the order the cascade uses. */

    /* EXEMPTIONS ARE CONDITIONAL, NOT BLANKET, and the difference is the whole
       value of the list.

       Both entries below tie or beat this floor by weight and order, and both
       set a size that is AT OR ABOVE the rung the floor sets. That is why they
       are allowed: they raise, they never lower.

       The earlier version of this list skipped a named selector outright. That
       meant an exemption granted for `--t-md` would go on being honoured if the
       rule were later changed to 12px -- the guard would stay green on exactly
       the regression it was written to catch, and the comment promising it
       "comes back here as a decision" was not true. So the name only buys a
       rule the RIGHT to be checked against the floor's own rung; if it ever
       drops below it, it is an offender again with no further edit here. */
    const EXEMPT = new Map([
      ['.ge-bell header .t-body', 'the sign-in board raises its own body copy to --t-md, the same rung'],
      ['.catalog-field input', 'the catalog search field is already 19.1px: legacy/ppbf-leather-brass.css:2528 sets `font: 400 var(--t-md)/1.4 var(--font-ui)`'],
    ]);

    /* At or above --t-md. The ladder is ordered, so anything from --t-md up is
       a raise; --t-sm and --t-xs are the two rungs below it and are not. */
    const AT_OR_ABOVE_FLOOR = /var\(\s*--t-(md|lg|xl|2xl|3xl|4xl|5xl)\s*\)/;

    /* EVERY TOKEN CARRIES THE WEIGHT OF THE RULE THAT FLOORS IT, because the
       two halves of this floor do not weigh the same and a single threshold
       silences one of them.

       The voice half is `[data-surface="kiosk"] .t-eyebrow` -- an attribute
       plus a class, (0,2,0). The control half is `[data-surface="kiosk"]
       button` -- an attribute plus a TYPE, (0,1,1). A flat "must reach 20"
       test asks both to clear the voice bar, so a later rule that ties the
       control half is thrown away as noise. Measured: appending
       `.ge-panel button { font-size: 12px; }` to the legacy sheet -- later in
       the resolved stream, tying at (0,1,1), therefore winning -- left this
       suite fully green. The control floor was guarded only against being
       DELETED, never against being beaten.

       So each token is compared against its own floor, and `weight` counts
       type selectors, which it previously ignored entirely. */
    const FLOOR_WEIGHT = new Map<string, number>();
    for (const entry of FLOOR) FLOOR_WEIGHT.set(entry.voice.split(' ')[0], 20);
    for (const entry of CONTROL_FLOOR) FLOOR_WEIGHT.set(entry.selector, 11);
    const tokens = [...FLOOR_WEIGHT.keys()];
    const offenders: string[] = [];

    for (const rule of RULES) {
      const declarations = sizeDeclarations(rule.body);
      if (declarations.length === 0) continue;

      const selectorText = rule.selectors.join(', ');
      if (selectorText.includes('[data-surface="kiosk"]')) continue;
      /* Named AND still raising. Losing either half makes it an offender. */
      if (
        rule.selectors.every((selector) => EXEMPT.has(selector))
        && declarations.every((declaration) => AT_OR_ABOVE_FLOOR.test(declaration))
      ) continue;

      const reaching = rule.selectors.filter((selector) => tokens.some((token) => reaches(selector, token)));
      if (reaching.length === 0) continue;

      /* The lowest bar any token this rule reaches sets for itself. A rule
         that ties or beats that bar and comes later takes the floor back. */
      const bar = Math.min(
        ...reaching.map((selector) => Math.min(
          ...tokens.filter((token) => reaches(selector, token)).map((token) => FLOOR_WEIGHT.get(token) ?? 20),
        )),
      );

      const important = declarations.some((declaration) => /!\s*important/i.test(declaration));
      if (!important && (rule.at < floorAt || weight(reaching) < bar)) continue;

      offenders.push(
        `${important ? '!important  ' : `(${weight(reaching) / 10} class-level)  `}`
        + `${selectorText.slice(0, 90)} { ${rule.body.trim().slice(0, 60)} }`,
      );
    }

    expect(
      offenders.length === 0
        ? true
        : 'these rules beat the kiosk type floor and set a size on something it holds, so the '
          + 'floor is gone on any surface they reach. An !important one wins from anywhere in '
          + 'the sheet; a normal one wins by coming later at (0,2,0) or better. Either scope '
          + 'them under [data-surface="kiosk"] too, or record them in EXEMPT with the reason:'
          + `\n  ${offenders.join('\n  ')}`,
    ).toBe(true);
  });

  it('changes nothing off a gym-floor surface', () => {
    /* Every declaration of this floor is inside the kiosk scope. A coach
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

    for (const { selector } of CONTROL_FLOOR) {
      const unscoped = ruleBody(selector);
      if (unscoped === null) continue;
      expect(
        unscoped.includes('var(--t-md)')
          ? `the BASE ${selector} now carries --t-md: the kiosk CONTROL floor has been applied `
            + 'to every surface, and the dense desk ladders have moved with it.'
          : true,
      ).toBe(true);
    }
  });

  it.each(BASE)('leaves the desk ladder $voice at $declared — $at', ({ voice, declared, at, size }) => {
    expect(
      size.test(CSS)
        ? true
        : `the base ${voice} no longer declares ${declared} at ${at}. The kiosk floor above is `
          + 'written and commented as a correction of that exact value, so either the floor is '
          + 'now correcting something else or it is correcting nothing.',
    ).toBe(true);
  });
});

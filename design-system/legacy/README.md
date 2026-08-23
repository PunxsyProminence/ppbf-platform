# LEGACY VISUAL REFERENCE ONLY

## NOT CURRENT PPBF DESIGN AUTHORITY. DO NOT USE FOR NEW UI.

`ppbf-leather-brass.css` is the "Leather & Brass" design system as it stood on
**2026-08-23**, the day the owner retired it as PPBF's visual authority.

It is kept **whole and verbatim** so it can be read, compared against and
recovered from. It is not kept so it can be extended.

## What this is

The golden-era aesthetic: leather grounds, a brass chassis, cork, chalkboard,
aged paper, stains and patina, stained-oak surrounds, brick-and-mortar walls,
hanging practical lights, wood-type display faces, room walls with their own
materials, decorative stamps, creases and aging.

## Why it is still loaded

It is: `design-system/current/ppbf-theme.css` imports it today. Retiring an
aesthetic and replacing it are separate jobs, and Phase 1 of the visual reset
did only the first — it made the aesthetic **replaceable** rather than welded
into the same sheet as the spacing scale and the type ladder.

That makes Phase 1 a deliberate visual no-op: the same rules load in the same
order, so nothing looks different. What changed is that there is now exactly
one line to replace when the new system is authored.

## The one difference from the original file

`@import "./fonts.css"` became `@import "../fonts.css"`. The file moved one
directory down; the import had to climb to reach its sibling. Nothing else was
altered — not a value, not a comment, not a line of whitespace.
`foundationMatchesLegacy.test.ts` pins the token values that were copied out of
it.

`fonts.css` itself deliberately stayed at `design-system/fonts.css`. Moving it
would break `build-manifest.mjs` and `manifest.json`, and whether the four
shipped display faces — Alfa Slab One, Oswald, Special Elite, Caveat — retire
along with the aesthetic is an owner decision that Phase 1 does not settle.

## What you may take from here

**Mechanics, not looks.** If you find something in this file that is really
structure, accessibility or responsive behaviour rather than appearance, it
belongs in `design-system/foundation/` — move it there rather than importing
this sheet to get at it.

Anything that is genuinely a look — a colour, a material, a texture, a
typeface personality, a page ground — is superseded. Read it to understand what
a screen used to do, and to check a regression against. Do not copy it into new
work; `legacyVisualVocabulary.test.ts` fails on newly introduced use of it.

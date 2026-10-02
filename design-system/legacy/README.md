# LEGACY VISUAL REFERENCE ONLY

## The retired Leather & Brass look. Not the current look.

`ppbf-leather-brass.css` is the "Leather & Brass" design system the owner
retired as PPBF's visual authority on **2026-08-23**. The look is now Golden Era:
`docs/GOLDEN-ERA-V1-CONTRACT.md`. `legacy-fonts.css` holds the `@font-face` rules
for its five typefaces (Alfa Slab One, Oswald, Special Elite, Caveat,
UnifrakturCook), retired the same day; the `.woff2` files stay in
`design-system/fonts/`.

## What this is

The golden-era aesthetic: leather grounds, a brass chassis, cork, chalkboard,
aged paper, stains and patina, stained-oak surrounds, brick-and-mortar walls,
hanging practical lights, wood-type display faces, room walls with their own
materials, decorative stamps, creases and aging.

## It is still loaded, and it is not verbatim

`design-system/current/ppbf-theme.css` imports `current/ppbf-golden-era.css`,
and that sheet imports this one for continuity and applies its overrides on top
(its header, "IMPLEMENTATION NOTE"). So this file is still the live base of
most tokens, materials and components on every screen, it still loads
`legacy-fonts.css`, and where it and `foundation/` both define a scale token its
copy lands second and wins (`foundationMatchesLegacy.test.ts` pins the two
together).

Room plates and their variants are still declared in its PLATES block
(`:3560-3680`); `current/ppbf-golden-era.css` overrides some of them (the gym
floor's `--plate: none`, The Bell's own plate). `apps/web/public/plates/README.md`
says how to add a variant.

It is not a frozen copy. It has been edited since the retirement -- #641,
#646, #677 and `92fdcbef` (2026-08-25 to 2026-09-24) -- and its font import is
`./legacy-fonts.css`, which moved here from `design-system/fonts.css` in #574.

## What you may take from here

**Mechanics, not looks.** If you find something in this file that is really
structure, accessibility or responsive behaviour rather than appearance, it
belongs in `design-system/foundation/` — move it there rather than importing
this sheet to get at it.

Anything that is genuinely a look — a colour, a material, a texture, a
typeface personality, a page ground — is the old look. Read it to understand what
a screen used to do, and to check a regression against. Nothing in the UI is tied
down (OD-2026-10-02-004), so a design may borrow from it where Jason and the lane
want that; `legacyVisualVocabulary.test.ts` currently fails on newly introduced
use of its named classes, and is a look pin that yields to such a decision.

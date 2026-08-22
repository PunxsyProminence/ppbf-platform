# Mockup → Repo Map

Working doc for turning the reference mockups into real pages.

## Division of labor

**Superseded in part, 2026-08-22.** The Claude-engineers / Grok-decorates split
below was retired by owner decision — Grok now owns visual design *and* visual
implementation, per `docs/GROK-VISUAL-LANE.md` and the lanes in
`AGENT_KERNEL.md`. What survives is everything about how to read a mockup
against real code, which is the useful half of this document.

- **The mockups are layout references.** They establish where things sit and what
  objects a screen is built from — not a pixel spec to be traced.
- **Layout and decoration are one lane now (Grok):** structure, hierarchy,
  presentation of real routes and real fields, the design-system classes that
  already exist, and the visual treatment on top — textures, imagery,
  atmosphere.
- **Claude reviews rather than engineers** the presentation layer: that no
  function, gate, boundary or safety rule moved, and that nothing was invented.

Layout still comes before decoration, and that ordering did not change with the
lane: a page that is well laid out and undecorated is finishable; a decorated
page with the wrong layout is not.

---

## The headline finding

The twelve mockups are not a new design direction. They are `design-system/ppbf.css`
("Leather & Brass", 3,282 lines) rendered as photographs. Every motif in them already
exists as a token or a class:

| In the mockups | Already in the design system |
|---|---|
| Brass plaques on a rail (Organizations) | `.plaque`, `.mat-brass`, `.mat-brass--patina` |
| Hanging key tags, EXPIRED (PIN Management) | `.keytag`, `.keytag--expired` |
| Oversight Ledger table | `.ledger`, `.ledger-id`, `.ledger-val` |
| Green banker's lamp (Sports Medicine) | `.lamp--green`, `.lamp--caged` |
| Corkboard + push pins (Knowledge Graph, SHADOW) | `.mat-cork`, `.pin`, `.pin--brass` |
| Newspaper clippings | `.clipping`, `.clipping-head`, `.clipping-body` |
| Framed photo wall (People) | `.photo`, `.frame`, `.frame--patina` |
| CLEARED / RESTRICTED / ESCALATED stamps | `.stamp`, `.stamp--press`, `.badge--cleared` … |
| Wooden sign board (Sign In) | `.signboard`, `.mat-wood` |
| Aged, deckle-edged paper | `.aged`, `.aged--deckle`, `.age-0`…`.age-3` |

The fonts match too. Law 4 names six voices, and the mockups use them correctly —
**Alfa Slab One** for the slab headlines, **Special Elite** for the typewriter key logs
and the SHADOW teletype, **UnifrakturCook** gothic for the Sports Medicine masthead
(Law 4: *"gothic mastheads the clinic"*), **Caveat** for handwritten annotations.

So the job is not "invent a look." It is **close the gap between pages and the system
the repo already ships.**

---

## Mockup → route

All twelve map to routes that already exist. 125 routes total.

| # | Mockup | Route(s) |
|---|---|---|
| 1 | Organizations | `/admin/organizations` |
| 2 | Knowledge Graph / SHADOW Links | `/knowledge-graph` |
| 3 | Video Analysis | `/athlete/video-analysis`, `/coach/video-analysis` |
| 4 | Sports Medicine | `/coach/sports-medicine` |
| 5 | Guardian Portal | `/guardian`, `/guardian/dashboard` |
| 6 | PIN Management | `/admin/pin`, `/change-pin` |
| 7 | People | `/admin/people` |
| 8 | SHADOW | `/shadow`, `/admin/shadow`, `/shadow/scout` |
| 9 | Board Governance Hub | `/board/dashboard` + eight `/board/*` seats |
| 10 | Sign In | `/login`, `/public` popover, `/athlete/sign-in` |
| 11 | Compliance Center | `/admin/compliance-center` |
| 12 | Progression Intelligence | `/athlete/progression-intelligence`, `/coach/progression-intelligence` |

## Where the app drifted — RESOLVED, kept as a record

**This table described the state on 2026-08-20 and every row of it has since
been fixed. Do not use it as a work list.** It is kept because the measurement
method is worth reusing, not because the targets are still there.

The table read, at the time: `/shadow` 178 off-system colour utilities against
2 design-system hits — "the single worst offender", 31×`zinc-700`,
26×`slate-300`, `bg-[#09090b] font-mono text-slate-300` — with
`/board/dashboard` at 2, `/coach/operations`, `/admin/macro-analytics`,
`/admin/curriculum` and `/admin/communications` at 2 each, and
`/admin/retro-lab` at 1.

Re-measured 2026-08-22, same method:

```
grep -oE "slate-[0-9]+|zinc-[0-9]+|gray-[0-9]+|bg-\[#[0-9a-fA-F]+\]" \
  apps/web/app/shadow/page.tsx | wc -l          →  0
grep -rhoE "slate-[0-9]+|zinc-[0-9]+|gray-[0-9]+" \
  apps/web/app --include=page.tsx | wc -l        →  0
```

**Zero, on `/shadow` and across every route file in the app.** The Room DNA
passes cleaned it. The only surviving cold-palette code is
`apps/web/src/components/core/PunxsyEcosystemCore.tsx`, mounted only on
`/admin/retro-lab` — a lab prototype (no fetch), not an operational route.
The grep above is scoped to `app/**/page.tsx` and therefore does not see it.

The method is still the right one for catching this class of defect, and
running it before a visual batch is cheap. The verdict column is history.

---

## The Grok prompt (decoration)

For generating **decorative treatment** over a layout that has already been engineered.
Reusable for any page, not just the twelve. Paste the block below, then fill the three
`<<< >>>` slots at the bottom.

Grok is not deciding what goes on the page — the slots tell it what is already there.
It is deciding how that reads as a physical object under a warm lamp.

> **Why the slots matter.** A previous external design pass produced three mockups and two
> of them invented UI that does not exist here — an "Archive" section, and pathway
> categories that did not match `VISITOR_TYPES` and would have bounced the intake form.
> Only the direction notes were usable. Filling the slots with the page's *real* fields is
> what keeps the output buildable.

```
You are designing one screen for the PPBF platform (Punxsutawney Prominence Boxing
Foundation) — a nonprofit youth boxing program. Render it as a photorealistic 16:9
image of a PHYSICAL PLACE, not a web page.

THE CORE CONCEIT
The platform is a building. Every screen is a ROOM in it. The room supplies the wall,
the light and the shadow; every panel standing in that room is a REAL OBJECT — oiled
leather, cast brass, slate chalkboard, cork, stamped paper, stained wood, brick.
If a surface is not one of those materials, it does not belong in the picture.
Period: an American working-class boxing gym office, 1938–1953.

THE EIGHT LAWS (binding)
1. Brass is the chassis, never the message. Brass frames, rails, bezels and plaques
   hold content; brass is never used to say something.
2. Saturated colour means safety or status, nothing else. A red stamp means a real
   state (RESTRICTED, LOCKED). Never use saturated colour for decoration.
3. Colour is never the only channel — every status carries a glyph AND an uppercase
   label, so it reads in monochrome.
4. Six voices, each with a job:
     - Alfa Slab One (heavy slab display) — commands, page mastheads
     - Oswald (condensed) — UI labels, table headers
     - Inter — body copy
     - Special Elite (typewriter) — records, logs, teletype, ledgers
     - Caveat (handwriting) — annotations a human added by hand
     - UnifrakturCook (blackletter) — ONLY the clinic/medical masthead
5. Kiosk-first sizing. Touch targets read as ~55px, body type ~19px. This is used on a
   cold tablet on a gym floor, by kids and volunteers. Nothing dainty.
6. Every screen is a room; every panel in it is a real object.
7. Refusal is a STAMP, not an error toast. Rejections are rubber-stamped in red ink,
   slightly off-angle, partly overlapping the form beneath.
8. Proportion descends from the golden ratio. Nothing is sized by eye.

EXACT PALETTE (use these values, do not substitute)
  Leather ground   #14100D #1E1712 #2A1F18 #3B2C21 #4A3728 #5C4632
  Brass chassis    #4A340B #6B4E12 #8C6B1F #A98126 #B8912F #D4AF4A #E8CE7A
  Bone / paper     #F7F1E1 #EFE6D0 #DCCFB2 #B5A688  paper #F4EBD4  warm canvas #EFE4C8
  Printed ink      #241C11   muted ink #6B5B44
  Wood surround    #1F1409 #2E1D0E #422A15 #5A3A1E #7A5029 #9C6B3A
  Slate + chalk    board #1C2420  chalk #E6E3D6
  Cork             #C08E4E  dark #96682F
  Brick + mortar   #2A1712 #4A251C #6B3A2A  mortar #5C5246
  Lamp light       #FFE9B8  hot #FFF6DF
  STATUS ONLY —  cleared #3F7D4E · monitor #2E6E96 · restricted #C05A1E · locked #A81E22

LIGHT
One practical source — a hanging caged fixture or a gooseneck desk lamp — warm, pooled,
falling off fast into shadow. Never flat ambient fill. Pick the room and light it:
  office (raking side light) · floor (top-down) · board (even, formal) ·
  file (hard, long shadows) · clinic (soft, diffuse, green banker's lamp) ·
  night (very soft, dim)

OBJECT VOCABULARY — build the screen from these
  brass plaques on a rail · hanging key tags on rings · a ruled ledger book ·
  stamped paper forms with rubber-stamp marks · corkboard with brass push pins and
  twine connecting cards · framed photographs on a wall · newspaper clippings ·
  a wooden sign board · leather-bound passbooks · index cards · manila folders ·
  a typewriter-typed log sheet · chalk on slate

HARD CONSTRAINTS
- Show ONLY the fields and data listed in the slots below. Invent no sections, no
  navigation, no features. If it is not listed, it does not appear.
- All text must be legible and correctly spelled. No lorem ipsum, no garbled letters.
- 16:9. No modern UI chrome — no rounded rectangles, no flat material icons, no
  drop-shadow cards, no gradients that read as "app".
- Youth program: any people shown are teenagers or adult coaches, fully clothed in
  period gym wear, never posed as injured.

<<< PAGE NAME >>>
<<< WHO USES IT AND WHAT THEY DO HERE (one sentence) >>>
<<< THE REAL FIELDS / COLUMNS / STATUSES ON THIS PAGE — copy them from the code >>>
```

### Worked example — filling the slots for `/shadow`

```
PAGE NAME: SHADOW — Evidence-Based Training Companion

WHO USES IT: A coach asks SHADOW a training question and gets an answer that cites
the evidence it came from; every claim is tied to a source tier.

REAL FIELDS: a teletype conversation between COACH and SHADOW; evidence tier labels
from EVIDENCE_TIER_ORDER with their meanings from EVIDENCE_TIER_MEANINGS; a session
list (rename / delete); citations pinned as source cards — fight report, medical file,
training log excerpt, safety bulletin.
```

### How to use the output

Treat the render as **direction, not specification**. Before building from it:
1. Check every element against real code — does that field exist? does that status exist?
2. Discard anything invented.
3. Build with the existing classes above, not new CSS. The system already has them.

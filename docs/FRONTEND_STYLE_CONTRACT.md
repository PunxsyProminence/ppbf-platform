# Frontend style guide (PPBF)

> **What this is (OD-2026-10-02-004):** how the frontend is put together today and what tends to work. Nothing in the UI is tied down; what binds UI work is the short list in `AGENT_KERNEL.md` "UI and visual work". Where this guide says "use" or "prefer", it is describing the easy path, not forbidding another one.

## Purpose
Help a builder make a screen that works, reads well and fits the rest of the app, without having to rediscover how the sheets are wired.

## Source of Truth
- **`design-system/ppbf.css`** — the entry point for tokens, materials, and
  components; it imports `foundation/` and the `current/` theme, which is where
  the rules live (`design-system/README.md`, "Source of truth"). Read
  `design-system/README.md` for the checks that bind and the reasoning; the previews under
  `design-system/` render against this exact file, so a value cannot drift
  between the showroom and the app.
- `apps/web/app/globals.css` — imports the sheet above and aliases the app's
  legacy variable names onto it. The aliases exist to carry the pages that
  predate the design system, and
  `legacyVisualVocabulary.test.ts` caps 18 of them by name (`ALIAS_CEILINGS`,
  `legacyVisualVocabulary.test.ts:64-83`, counting .tsx under `app/` and
  `components/` only); the rest are uncapped. New work is usually easier to write
  **against the foundation's mechanics** (`--t-*`, `--s*`, `--r-*`, `--tap`)
  **and the current theme's own tokens** (`globals.css:28-33`).
- `apps/web/components/uiStyles.ts` — pre-design-system helper, still consumed
  by unconverted pages. Not a second vocabulary.

## Visual Language

Today the look is Golden Era: skeuomorphic materials sitting on the real gym
(`docs/GOLDEN-ERA-V1-CONTRACT.md` §4). That is a description of the current
look, not a limit on the next one (OD-2026-10-02-004). Of the items this file
used to single out, 3 still binds, and 2 no longer binds as a rule about
colour (OD-2026-10-02-007); the rest are history:

1. **Brass is the chassis, never the message** (Law 1, retired OD-2026-09-28-009). Frames, rivets, rope,
   button faces, the "on" state of a control. Brass never reports a status.
2. **Saturated colour means safety or status, and nothing else** (Law 2) no
   longer binds as a colour rule (Jason 2026-10-02: *"Nothing binding  visually
   look will be less conflict than anything binding at this point"*,
   OD-2026-10-02-007). Green, blue and orange are what a participant's safety
   state and a queue outcome are painted in today. INFERRED, not ratified by Jason:
   a new use of them should not read as one of those states. Red is not reserved
   (OD-2026-09-29-001, 2026-09-29): it
   is the club's colour and may be used anywhere. The token is not free:
   `--safety-locked` aliases to `--locked`, which still means a medical stop,
   so it must not paint tabs, panel borders, links, or emphasis. (Chrome
   accents used brass under Law 1, retired OD-2026-09-28-009.)
3. **Colour is never the only channel** (Law 3). Every state carries a glyph
   (`✓ ◉ ▲ ✕`) and an uppercase label, so it survives greyscale board packets
   and every form of colour blindness. Use `.badge`, not an emoji.
4. **Nothing is sized by eye** (Law 8, retired OD-2026-09-28-009). Type climbs by √φ (`--t-xs`…`--t-4xl`),
   space and radius follow Fibonacci (`--s1`…`--s8`, `--r-sm`…`--r-xl`),
   layout splits at `--split-minor` / `--split-major`.

### Two grounds, one system (was Law 6, retired OD-2026-09-28-009; the two grounds still ship in the CSS)

| Ground | Where | How |
|---|---|---|
| Ink leather | Staff consoles — admin, coach, board, operations | default `ppbf.css` components |
| Warm canvas | Family-facing — public homepage, login, guardian, onboarding, kiosk | wrap in `.on-canvas` |

`.on-canvas` paints a ground of its own, so put it on the full-bleed wrapper,
not as a scoping hook on children. It restates every component that was tuned
against leather; if you find one it has missed, the fix that lasts is a restatement in the
design-system sheets (`current/` for the look), because a colour patched in one page leaves the next page broken.

## Components and Patterns

What the sheet already ships (a new component is fine when none of these does the job):

- Surfaces — `.mat-leather`, `.mat-paper`, `.mat-slate`, `.mat-cork`, plus
  `.frame` + `.rivet` for a riveted brass frame around a panel.
- Controls — `.btn`, `.btn--ghost`, `.btn--danger`, `.btn--kiosk`,
  `.field` + `.t-label` + `.input`.
- Status — `.badge` with its four rungs; `.stamp` for a governance refusal
  (Law 7, which binds: a refusal stays on screen and cannot be dismissed; how
  the mark looks may change); `.redacted` for k-anonymity withholding.
- Type — four voices (Law 4, retired OD-2026-09-28-009; the classes still ship): `.t-command` orders, `.t-body` informs, `.chalk`
  schedules, `.t-data` records anything auditable.

Tailwind v4 cannot tell whether `text-[var(--x)]` is a size or a colour and
silently emits neither. Use `text-[length:var(--x)]` / `text-[color:var(--x)]`.

## Ergonomics

- Anything an athlete touches on the gym floor: `--tap` (55px) targets and
  `--t-md` (19.1px) type minimum (Law 5). Desks may go smaller; the floor may
  not. `.btn--kiosk` and `.input--kiosk` do this for you.
- Keyboard focus is `var(--focus)` and must be visible against the ground it
  sits on.
- Every screen must survive a 412px viewport with no horizontal overflow.

## Things that have caused trouble

None of these is a ban (OD-2026-10-02-004); each is a habit that has cost time.

1. Hardcoded hex values in `apps/web/app` or `apps/web/components` do not
   follow a theme change, so a token is usually the better choice.
   As of the SHADOW-console pass: **281 hex values and 783 legacy cream tokens
   across 58 page files**. Measure before
   claiming progress — an earlier version of this file quoted a count taken
   only across the files being worked on, which read as far more finished than
   the app was.
2. There is one look today and no `[data-theme]` toggle; ground is a per-surface
   material choice. Stray slate/emerald/cyan fragments are leftovers from before
   the design system, not a second palette.
3. (Law 8, retired OD-2026-09-28-009.) Radii mostly come off the Fibonacci scale.
4. The `design-system/screens/*.html` previews show how the sheets are meant to
   be used; a neighbouring page may itself be unconverted, so check before
   copying one.

## Scope Notes

1. Legacy files under `apps/web/src` are out-of-band and say nothing about the
   current look.
2. Active surfaces live under `apps/web/app` and `apps/web/components`.
3. **The migration is not complete.** `FeatureSurface` — the old cream
   scaffold shell — is deleted, and most of the app speaks the design system,
   but as of 2026-08-17, 7 of the app's 126 route pages still mount a raw
   Tailwind dark-mode shell (`bg-[#09090b] font-mono text-slate-*`) instead of
   `ppbf.css` materials and tokens: `shadow`, `coach/operations`,
   `board/dashboard`, `admin/macro-analytics`, `admin/curriculum`,
   `admin/communications`, and `admin/retro-lab` (whose mounted
   `PunxsyEcosystemCore.tsx` repeats the same pattern). These pages are a
   poor starting point for new work — see the legacy-token count above.
4. **`--red-primary` chrome misuse is purged.** The token is now named
   `--safety-locked` (`apps/web/app/globals.css`); it aliases to
   `--locked` — the safety gate's red — and it no longer paints tabs, borders,
   eyebrows, banners, or "planned" markers anywhere. Planned/not-implemented
   markers are `.stamp--brass`. Any new use of `--safety-locked` / `--locked`
   must be the safety gate speaking; red itself is not reserved
   (OD-2026-09-29-001). This one is a floor item and binds.

## Checking your work

`npm run sweep` (from `apps/web`, against a running dev server) reads every
route it is given and reports text that cannot be read against what is behind
it. It exists because the unit suite cannot see this class of fault: several
regressions have shipped past 2,600 green tests while being invisible on
screen — a brass button repainted by a link rule that outranked it, a trigger
inheriting the body's dark colour onto leather, whole pages rendering
bone-on-cream after adopting the ink type voices.

A count on its own is not a verdict. Plenty of low-contrast text predates any
given change, so sweep the same routes against a baseline ref and diff before
acting — otherwise you will spend an afternoon fixing something you did not
break. It never fails a build; it reports, and a person decides.

This matters beyond legibility. A participant's safety state is shown in
colour, with a glyph and a label so it survives greyscale (Law 3), which makes
a contrast regression on one of those marks a safety regression rather than a
cosmetic one.

## Done criteria for UI work

These are the list in `AGENT_KERNEL.md` "UI and visual work" applied to a
screen. Nothing about which materials, colours, sizes or layout a screen uses is a
done criterion (OD-2026-10-02-004).

1. `--locked` appears only for a medical stop (OD-2026-09-29-001).
2. Every state carries a glyph and a label, not colour alone (Law 3).
3. Gym-floor targets clear `--tap` and `--t-md` (Law 5).
4. Keyboard focus states are visible.
5. No horizontal overflow at 412px.
6. `npm run sweep` shows no new low-contrast nodes against the base branch.
7. Every control does something real, and any action the change moved, merged,
   renamed or removed is named in the PR.

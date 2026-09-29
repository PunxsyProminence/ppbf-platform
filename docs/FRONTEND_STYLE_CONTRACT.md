# Frontend Style Contract (PPBF)

> **Look (2026-09-28):** Golden Era, `docs/GOLDEN-ERA-V1-CONTRACT.md`. Of the eight laws cited below, 2, 3, 5 and 7 still bind; 1, 4, 6 and 8 are retired (OD-2026-09-28-009).

## Purpose
Lock visual consistency for all current and upcoming frontend work.

## Source of Truth
- **`design-system/ppbf.css`** — the entry point for tokens, materials, and
  components; it imports `foundation/` and the `current/` theme, which is where
  the rules live (`design-system/README.md`, "Source of truth"). Read
  `design-system/README.md` for the laws and the reasoning; the previews under
  `design-system/` render against this exact file, so a value cannot drift
  between the showroom and the app.
- `apps/web/app/globals.css` — imports the sheet above and aliases the app's
  legacy variable names onto it. The aliases exist to carry the pages that
  predate the design system; they are a closed vocabulary, and
  `legacyVisualVocabulary.test.ts` caps 18 of them by name (`ALIAS_CEILINGS`,
  `legacyVisualVocabulary.test.ts:64-83`, counting .tsx under `app/` and
  `components/` only); the rest are uncapped, so do not extend them. **Write new work
  against the foundation's mechanics** (`--t-*`, `--s*`, `--r-*`, `--tap`)
  **and the current theme's own tokens** (`globals.css:28-33`).
- `apps/web/components/uiStyles.ts` — pre-design-system helper, still consumed
  by unconverted pages. Not a second vocabulary; do not extend it.

## Visual Language

Skeuomorphic, not flat. The look is Golden Era: its materials sit on the real
gym (`docs/GOLDEN-ERA-V1-CONTRACT.md` §4). Of the Eight Laws in the
design-system README, 2, 3, 5 and 7 are the contract; 1, 4, 6 and 8 are
retired (OD-2026-09-28-009). The four this file used to single out, retired
ones marked:

1. **Brass is the chassis, never the message** (Law 1, retired OD-2026-09-28-009). Frames, rivets, rope,
   button faces, the "on" state of a control. Brass never reports a status.
2. **Saturated colour means safety or status, and nothing else** (Law 2),
   red excepted. Green, blue and orange belong to a participant's safety state
   or a queue outcome. Red is not reserved (OD-2026-09-29-001, 2026-09-29): it
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
against leather; if you find one it has missed, **add the restatement to the
design-system sheets** (`current/` for the look) rather than patching the colour in the page.

## Components and Patterns

Use what the sheet already ships before inventing anything:

- Surfaces — `.mat-leather`, `.mat-paper`, `.mat-slate`, `.mat-cork`, plus
  `.frame` + `.rivet` for a riveted brass frame around a panel.
- Controls — `.btn`, `.btn--ghost`, `.btn--danger`, `.btn--kiosk`,
  `.field` + `.t-label` + `.input`.
- Status — `.badge` with its four rungs; `.stamp` for a governance refusal
  (Law 7 — refusal is a stamp, never a dismissible toast); `.redacted` for
  k-anonymity withholding.
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

## Drift Guardrails

1. No new hardcoded hex values in `apps/web/app` or `apps/web/components`.
   As of the SHADOW-console pass: **281 hex values and 783 legacy cream tokens
   across 58 page files**. Those numbers go down, never up. Measure before
   claiming progress — an earlier version of this file quoted a count taken
   only across the files being worked on, which read as far more finished than
   the app was.
2. No slate/emerald/cyan fragments, and no second palette — there is one look,
   and no `[data-theme]` toggle. Ground is a per-surface material choice.
3. (Law 8, retired OD-2026-09-28-009.) Radii come off the Fibonacci scale; arbitrary values like `rounded-[28px]`
   are drift.
4. Before styling a new route, open the nearest `design-system/screens/*.html`
   preview and build from that, rather than copying a neighbouring page that
   may itself be unconverted.

## Scope Notes

1. Legacy files under `apps/web/src` are out-of-band and must not drive visual
   decisions.
2. Active surfaces live under `apps/web/app` and `apps/web/components`.
3. **The migration is not complete.** `FeatureSurface` — the old cream
   scaffold shell — is deleted, and most of the app speaks the design system,
   but as of 2026-08-17, 7 of the app's 126 route pages still mount a raw
   Tailwind dark-mode shell (`bg-[#09090b] font-mono text-slate-*`) instead of
   `ppbf.css` materials and tokens: `shadow`, `coach/operations`,
   `board/dashboard`, `admin/macro-analytics`, `admin/curriculum`,
   `admin/communications`, and `admin/retro-lab` (whose mounted
   `PunxsyEcosystemCore.tsx` repeats the same pattern). Do not copy these
   pages as a starting point for new work — see Drift Guardrails below for
   the broader legacy-token count. New work starts from the contract, not
   from git archaeology.
4. **`--red-primary` chrome misuse is purged.** The token is now named
   `--safety-locked` (`apps/web/app/globals.css`); it aliases to
   `--locked` — the safety gate's red — and it no longer paints tabs, borders,
   eyebrows, banners, or "planned" markers anywhere. Planned/not-implemented
   markers are `.stamp--brass`. Any new use of `--safety-locked` / `--locked`
   must be the safety gate speaking; red itself is not reserved
   (OD-2026-09-29-001). Regressions here are the highest-priority drift.

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

This matters beyond legibility. Law 2 spends saturated colour on a
participant's safety state and Law 3 requires a glyph and a label so the
ladder survives greyscale, which makes a contrast regression a governance
regression rather than a cosmetic one.

## Done Criteria for New UI Work

1. Every surface is one of Golden Era's materials
   (`docs/GOLDEN-ERA-V1-CONTRACT.md` §4: seven core materials plus dark glass,
   owner-approved 2026-09-28, OD-2026-09-28-014), which replaced the old
   five-material rule (OD-2026-09-28-009).
2. Saturated colour appears only for safety state or queue outcome (Law 2),
   except red, which is not reserved (OD-2026-09-29-001); `--locked` still
   appears only for a medical stop.
   (The "chrome accents are brass" half was Law 1, retired OD-2026-09-28-009.)
3. Every state carries a glyph and an uppercase label, not colour alone (Law 3).
4. RETIRED with Law 8 (OD-2026-09-28-009): sizes from the √φ type ladder and
   the Fibonacci space/radius scales. No longer a done criterion.
5. Gym-floor targets clear `--tap` and `--t-md` (Law 5).
6. Keyboard focus states are visible and consistent.
7. No horizontal overflow at 412px.
8. `npm run sweep` shows no new low-contrast nodes against the base branch.
9. A design-system gap is fixed in the design-system sheets (`current/` for the look,
   `foundation/` for mechanics), not worked around in the page.

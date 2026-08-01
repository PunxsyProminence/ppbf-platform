# Frontend Style Contract (PPBF)

## Purpose
Lock visual consistency across the app's ~61 routes. This document describes
conventions and pointers only — it holds no colour values of its own, because a
second copy of the palette is a second source of truth.

## Source of Truth
- **[design-system/ppbf.css](../design-system/ppbf.css)** — every token, material,
  and component class. The single source of truth.
- [apps/web/app/globals.css](../apps/web/app/globals.css) — `@import`s ppbf.css at
  line 15, then defines the **legacy alias layer** (see below). Also holds app-only
  components (`.tactical-*`, `.paper-ticket`, `.ledger-tape`, `.mechanical-lock`,
  `.brass-plate`, `.leather-tag`, `.gym-locker-tile`).
- [apps/web/components/uiStyles.ts](../apps/web/components/uiStyles.ts) — a small
  registry of repeated Tailwind class strings (tabs, mode buttons, panel shells,
  status badges). A convenience layer over the aliases, **not** a source of values.
- [design-system/README.md](../design-system/README.md) — the direction and the
  Eight Laws. Read it before designing anything new.
- [apps/web/src/design/PAGE_MAP.md](../apps/web/src/design/PAGE_MAP.md) — which of
  three shapes each route takes, and which ground it sits on.

## Visual Language
1. Theme direction: **"Leather & Brass"** — the back office of a boxing gym run
   properly for forty years. Skeuomorphic, governance-forward, safety-first.
2. Palette: **do not restate colour values in code or docs.** Read the tokens.
   `--hide-*` (leather) · `--brass-*` (chassis) · `--patina-*` / `--rust-*` (grit)
   · `--bone-*` / `--paper` / `--canvas-warm` (type and paper) · `--chalk` ·
   `--cork` · and the status ladder `--cleared` / `--monitor` / `--restricted` /
   `--locked`.
3. **Two grounds, and the choice is a real decision (Law 6).** Ink
   (`--hide-950`) for staff and tactical surfaces; warm canvas (`--canvas-warm`,
   via `.on-canvas`) for family and public ones — Guardian Portal, Public
   Onboarding. Getting this wrong is the most visible possible error, so
   `PAGE_MAP.md` records it per route. There is one theme and no `[data-theme]`
   toggle; ground is a per-surface material choice, not a user preference.
4. Shape language: hard-edge by default. 2–3px borders, hard-offset shadows,
   radius only where a real object would have it (`--r-sm` … `--r-xl`, Fibonacci).
5. Proportion comes from the tokens, never from eye (Law 8). Type `--t-*` (√φ
   ladder), space `--s1`…`--s8` (Fibonacci), splits `--split-minor` /
   `--split-major`. No raw px for size or spacing.
6. Four voices (Law 4): `.t-command` / stencil commands · `.t-body` informs ·
   `.chalk` / `.t-hand` schedules · `.t-data` records anything auditable.

## The alias layer
`globals.css`'s `:root` block is **aliases only** — legacy names
(`--canvas-tan`, `--red-primary`, `--text-sm`, `--space-4`) pointed at
design-system values. It exists so the pages written before the design system
re-theme without being edited.

1. **New work uses ppbf tokens directly** — `var(--hide-800)`, `var(--t-md)`,
   `var(--s5)`, `var(--brass-500)`. The aliases are not a second vocabulary to
   write in.
2. Do not add new aliases. If a page needs a value, it needs a ppbf token.
3. `--font-stencil` and `--font-body` are deliberately re-pointed in `globals.css`
   at the `next/font` faces, which are really loaded where the design system's
   fallback chain is not. That override is intentional — leave it.

## Components and Patterns
1. **ppbf.css ships real components. Use them instead of rebuilding a panel out
   of utilities:** `.frame`, `.tile`, `.badge`, `.btn`, `.plaque`, `.gauge`,
   `.rivet`, `.rope`, `.note-torn`, `.pin`, `.tag`, `.field`, `.input`, and the
   `.mat-*` materials.
2. Use `uiStyles.ts` for the repeated shells it already covers rather than
   copy-pasting class strings; prefer shared primitives over new ones.
3. **`.stamp` is defined twice and the collision is deliberate.** ppbf.css's
   `.stamp` is a *static ink mark* (Law 7); globals.css's `.stamp` is a
   *clickable button*, and it wins because it is imported later. Do not mix them.
   For a static refusal or redaction mark, use `.stamp--static` / `.redacted`.
4. Kiosk-first sizing (Law 5): anything an athlete touches on the gym floor is at
   least `--tap` (55px) with `--t-md` type — `.btn--kiosk`, `.input--kiosk`.
   Desks may go smaller; the floor may not.
5. Keep focus behaviour consistent: `globals.css` sets a global `:focus-visible`
   outline in `--red-primary`, and `uiStyles.ts` rings match it. Do not introduce
   a third focus treatment.

## Drift Guardrails
1. **Law 1 — brass is the chassis, never the message.** Frames, rivets, bezels,
   button faces. The moment gold means a status, every frame on the page starts
   lying. Most load-bearing hardware is `--patina-*`; `--brass-*` is reserved for
   what would actually see a polishing rag.
2. **Law 2 — saturated colour means safety or status, nothing else.** The status
   ladder is the entire colour budget. `--rust-*` is atmosphere and must never
   read as the ladder.
3. **Law 3 — colour is never the only channel.** Every state carries a glyph
   (`✓ ◉ ▲ ✕`) and an uppercase label, so it survives greyscale board-packet
   printing and every form of colour blindness.
4. **Law 7 — refusal is a stamp, not a toast.** Layer 20 refusals and Layer 17
   k-anonymity withholding are ink on the page (`RESEARCH NEEDED`, `REDACTED`),
   not something dismissible by accident.
5. No slate/emerald/cyan fragments, and no hex literals on active surfaces —
   a raw hex is by definition off-system.
6. No inline style blocks for visual treatment unless the value is dynamic.
7. Any new route reads `PAGE_MAP.md` for its shape and ground, and references an
   existing styled route of that shape, before adding classes.

## Scope Notes
1. Active app surfaces live under `apps/web/app` and `apps/web/components`.
2. Legacy files under `apps/web/src` are out-of-band and should not drive visual
   decisions — `apps/web/src/design/PAGE_MAP.md` is the exception and is current.
3. The previews under `design-system/` render against the same `ppbf.css` the app
   ships, so a value cannot drift between preview and product. Edit the design
   system there, not by patching a page.

## Done Criteria for New UI Work
1. Uses ppbf tokens directly; no new aliases and no hex literals.
2. Sits on the ground `PAGE_MAP.md` assigns it.
3. Uses ppbf component classes and `uiStyles.ts` patterns rather than rebuilt ones.
4. Every state carries glyph + label, not colour alone.
5. Gym-floor surfaces clear `--tap` and `--t-md`.
6. Keyboard focus is visible and matches the global treatment.
7. Sizes and spacing come from `--t-*` / `--s*`, not from eye.

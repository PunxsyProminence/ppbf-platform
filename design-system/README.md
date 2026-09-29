# PPBF Design System

**The look is Golden Era: `docs/GOLDEN-ERA-V1-CONTRACT.md`**, the active visual
authority since 2026-08-24. "Leather & Brass" is retired and kept in `legacy/`. Of
the eight laws below, 2, 3, 5 and 7 still bind; 1, 4, 6 and 8 are retired
(OD-2026-09-28-009). The visual build order is `docs/ROOM-MAP.md`.

This folder holds the CSS the app loads, the previews, and the laws with the checks
that enforce them.

## Source of truth

**[`ppbf.css`](ppbf.css)** is the entry point: `apps/web` imports it via `globals.css`,
and every preview in this folder consumes it. It is two imports, in this order:

1. `foundation/ppbf-foundation.css` — structure, accessibility and the scales
   (`--t-*`, `--s*`, `--r-*`, `--tap`, motion). No look.
2. `current/ppbf-theme.css` — the seam. It imports `current/ppbf-golden-era.css`,
   which imports the retired `legacy/ppbf-leather-brass.css` for continuity and
   overrides on top of it. Most tokens, materials and components, and the PLATES
   block (`legacy/ppbf-leather-brass.css:3560-3680`), therefore still live in the
   legacy sheet.

None of it is in a cascade layer. **The current CSS is the implementation authority**;
this README states the laws and points to the checks — it does not restate what the
sheets already say.

| What | Where |
|---|---|
| Tokens (`--t-*`, `--s1..s8`, `--tap`, motion; `--hide-*`, `--brass-*`, …) | `:root` blocks of `foundation/ppbf-foundation.css` and `legacy/ppbf-leather-brass.css`; Golden Era overrides in `current/ppbf-golden-era.css` |
| Self-hosted faces (SIL OFL 1.1, 5 woff2, no CDN) — retired 2026-08-23 | `legacy/legacy-fonts.css` + `fonts/` |
| Room photo plates (JPEG, `--plate` per room) | `apps/web/public/plates/` |
| Synthesized sound (Web Audio, classic script, `window.PPBFSound`) | `ppbf-sound.js` |
| Machine-readable index — **generated, never hand-edited** | `manifest.json` (`npm run design:manifest`) |
| Previews (mockups, not the app) | `index.html`, `foundations/`, `components/`, `screens/` |

Raw fetch for tools: `https://raw.githubusercontent.com/PunxsyProminence/ppbf-platform/main/design-system/manifest.json`

**Token count, regenerated 2026-09-29: 152.** `build-manifest.mjs` follows the
import chain from `ppbf.css` in load order (foundation, legacy fonts, Leather & Brass,
Golden Era, theme) and reads each sheet's top-level `:root` blocks, splitting
declarations on semicolons. A token declared in more than one sheet has the value of
the last one, as in the browser, and print overrides are not recorded. `manifest.json`
lists the sheets under `stylesheets`, the retired ones with role `legacy`. Per sheet:
foundation 41, Leather & Brass 144, Golden Era 12. The manifest committed before this
said 117: it predated the 8 `--brass-*-rgb` tokens, missed 19 declarations packed
onto a shared line (`--s2`…`--s8` except `--s5`, `--r-md`, `--r-lg`, `--r-xl`,
`--r-pill`, the five `*-ink` pairs, `--sy`, `--sh-len`, `--sh-blur`, `--sh-op`),
never read the Golden Era sheet (8 tokens declared only there), and recorded the print
override of `--cleared`, `--monitor` and `--restricted` as their values. The manifest
is generated and must not be hand-edited: change the generator, then re-run
`npm run design:manifest`.

## The eight laws — four bind, four are retired

Laws 1, 4, 6 and 8 are **retired** (OD-2026-09-28-009): they described the Leather &
Brass look. Their text is kept below, marked, so the checks that still carry their
names can be read; a retired law's check still runs until someone removes it. Each
law names the executable check that enforces it, where one exists. Paths are relative
to `apps/web/`.

1. **RETIRED.** *Brass is the chassis, never the message.* Frames, rivets, bezels,
   button faces. Brass never reports a status. *(Review + contrast sweep; no dedicated
   test.)*
2. **Saturated colour means safety or status — nothing else, red excepted.**
   Green/blue/orange belong to the safety ladder and queue outcomes only. Red is not
   reserved (OD-2026-09-29-001, 2026-09-29): it is the club's colour (black, red and
   white) and may be used anywhere. `--safety-locked` aliases `--locked`, which still
   means a medical stop; it never paints chrome. → `src/design/cornerColor.test.ts`
   (a member's red/blue corner tint can never be mistaken for a safety state).
3. **Colour is never the only channel.** Every state carries a glyph (`✓ ◉ ▲ ✕`) and an
   uppercase label; the ladder survives greyscale and colour blindness. A bare spinner is
   colour-and-motion-only and therefore banned — pair `.skeleton`/`aria-busy` with `.working` text.
4. **RETIRED.** *Voices, each with a job.* Display (Alfa Slab One) commands, bone sans
   informs, chalk schedules, hand annotates, gothic is the clinic masthead only, typed
   is back-office prose, mono records anything auditable. `--font-stencil` is a legacy
   alias. The five faces were retired 2026-08-23; what renders today is in
   `docs/GOLDEN-ERA-V1-CONTRACT.md` §8.
5. **Kiosk-first sizing.** Anything an athlete touches on the floor: `--tap` (55px)
   targets, `--t-md` (19.1px) type. → `src/design/kioskTapFloor.test.tsx` (targets),
   `src/design/kioskTypeFloor.test.ts` (type).
6. **RETIRED** — Golden Era's materials (`docs/GOLDEN-ERA-V1-CONTRACT.md` §4: seven core
   materials, plus dark glass approved by OD-2026-09-28-014) replace it. *Every screen is a room; every panel is a real material.* A room supplies wall,
   light, and floor shadow (`.room` + `.room--office/floor/board/file/clinic/night` —
   both classes, always); a ground (`.on-canvas` or default ink) decides the ink. Family
   surfaces stay on the warm ground and take no room. →
   `components/roomBaseClass.test.ts`, `components/buildingMapRooms.test.ts`,
   `components/familyPlateGround.test.ts`, `src/design/darkPanelMaterials.test.ts`,
   `src/design/lightGroundVoices.test.ts`, and `components/designSystemClasses.test.ts`
   (every class the app references must exist in `ppbf.css`).
7. **Refusal is a stamp, not an error toast** — `RESEARCH NEEDED`, `REDACTED`:
   permanent, attributable, not dismissible. → `components/refusalStamp.test.tsx`.
8. **RETIRED.** *Proportion descends from φ; nothing is sized by eye.* Type climbs by √φ from 15px;
   space and radius are Fibonacci; layout splits 38.2/61.8; motion durations are
   Fibonacci milliseconds through the `--m-*`/`--e-*` tokens. →
   `src/design/typeLadder.test.ts`.

## Accessibility floor

- Glyph + label with every colour state (Law 3); print/greyscale parity per room.
- 55px/19.1px kiosk minimums clear WCAG by construction (Law 5).
- One global `:focus-visible` ring (`--focus`) on everything focusable.
- `prefers-reduced-motion` kills all motion, including discoverables; discoverables are
  keyboard-reachable via `:focus-within`.
- Pending state is `aria-busy="true"` driven, so the accessibility tree and pixels agree.
- Sound is off by default, opt-in, never the only channel, state changes only
  (`apps/web/components/useGymSound.ts` is the single seam).
- No horizontal overflow at 412px; `npm run sweep` (from `apps/web`, dev server running)
  reports low-contrast text — diff against a baseline before acting.

## Consuming from apps/web

Read **`docs/FRONTEND_STYLE_CONTRACT.md`** — the binding contract for app code (done
criteria, drift guardrails, Tailwind `text-[length:var(--x)]` gotcha). Short version:
write new work against the ppbf tokens directly; use the components the sheets ship
before inventing anything; fix gaps in the design-system sheets (`current/` for the
look, `foundation/` for mechanics), not in the page. `RoleStandaloneView`
takes a `room` prop (ignored on the family branch by design); pages with their own
`<main>` carry `room room--*` directly. Because `ppbf.css` is unlayered it beats
Tailwind's layered utilities on any shared property — `scripts/css-layer-collisions.mjs`
finds utilities that never apply.

**Keyboard shortcuts** render only from the registry (`components/shortcuts.ts`), so the
help card cannot list an unbound key → `components/commandsOverlay.test.tsx`. Share
`isTypingTarget()` for any bare printable-key binding.

## Asset rules (these prevented real failures)

- **Plates:** the plate laws and the delivery rule are stated once, in `AGENT_KERNEL.md`
  "Binary assets (plates)", and `src/design/plateBinaries.test.ts` enforces them on the
  bytes. `apps/web/public/plates/README.md` has the record of the rounds that produced
  them and how to add a variant.
- **Fonts are self-hosted woff2 only** (offline kiosk). No CDN links. The five Leather &
  Brass faces were retired 2026-08-23 (`src/design/legacyVisualVocabulary.test.ts`);
  `docs/GOLDEN-ERA-V1-CONTRACT.md` §8 records what renders today.
- **No audio files.** Sound is synthesized in `ppbf-sound.js`, a classic script (ES
  modules break under `file://`, which is how previews are browsed).
- Previews are portable: every reference is relative; the folder works from disk, a
  static server, or copied wholesale.

## Seeing the real app

The previews here are hand-authored mockups and drift from the app quietly. To see what
actually shipped: `npm run shots` (repo root) photographs every route per room into
`apps/web/page-shots/gallery.html`. Prints are for a person to judge — pixel assertions
were removed on purpose (see `apps/web/e2e/public-homepage.spec.ts` header). Output is
gitignored.

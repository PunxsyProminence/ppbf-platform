# PPBF Design System — "Leather & Brass"

Visual foundation for the PPBF Platform. The platform looks like a boxing gym that has
been run properly for forty years — leather, brass, slate, cork, paper, stained wood,
brick. That solves a real problem: one spectrum of users, from a nine-year-old at a
floor kiosk to a grant officer reading impact. Physical objects give each surface an
obvious identity and weight — a chalkboard is today and gets erased; a stamped paper is
a decision and does not.

## Source of truth

**[`ppbf.css`](ppbf.css)** — tokens, materials, type, rooms, and components in one
unlayered sheet. Every preview in this folder consumes it, and `apps/web` imports it via
`globals.css`. **The current CSS is the implementation authority**; this README states
the laws and points to the checks — it does not restate what the sheet already says.

| What | Where |
|---|---|
| Tokens (93: `--hide-*`, `--brass-*`, `--t-*`, `--s1..s8`, …) | top of `ppbf.css` |
| Self-hosted faces (SIL OFL 1.1, 5 woff2, no CDN) | `fonts.css` + `fonts/` |
| Room photo plates (JPEG, `--plate` per room) | `apps/web/public/plates/` |
| Synthesized sound (Web Audio, classic script, `window.PPBFSound`) | `ppbf-sound.js` |
| Machine-readable index — **generated, never hand-edited** | `manifest.json` (`npm run design:manifest`) |
| Previews (mockups, not the app) | `index.html`, `foundations/`, `components/`, `screens/` |

Raw fetch for tools: `https://raw.githubusercontent.com/PunxsyProminence/ppbf-platform/main/design-system/manifest.json`

## The eight laws

Each law names the executable check that enforces it, where one exists. Paths are
relative to `apps/web/`.

1. **Brass is the chassis, never the message.** Frames, rivets, bezels, button faces.
   Brass never reports a status. *(Review + contrast sweep; no dedicated test.)*
2. **Saturated colour means safety or status — nothing else.** Green/blue/orange/red
   belong to the safety ladder and queue outcomes only. `--red-primary` aliases
   `--locked`; it never paints chrome. → `src/design/cornerColor.test.ts` (a member's
   red/blue corner tint can never be mistaken for a safety state).
3. **Colour is never the only channel.** Every state carries a glyph (`✓ ◉ ▲ ✕`) and an
   uppercase label; the ladder survives greyscale and colour blindness. A bare spinner is
   colour-and-motion-only and therefore banned — pair `.skeleton`/`aria-busy` with `.working` text.
4. **Voices, each with a job.** Display (Alfa Slab One) commands, bone sans informs,
   chalk schedules, hand annotates, gothic is the clinic masthead only, typed is
   back-office prose, mono records anything auditable. `--font-stencil` is a legacy alias.
5. **Kiosk-first sizing.** Anything an athlete touches on the floor: `--tap` (55px)
   targets, `--t-md` (19.1px) type. → `src/design/kioskTapFloor.test.tsx`.
6. **Every screen is a room; every panel is a real material.** A room supplies wall,
   light, and floor shadow (`.room` + `.room--office/floor/board/file/clinic/night` —
   both classes, always); a ground (`.on-canvas` or default ink) decides the ink. Family
   surfaces stay on the warm ground and take no room. →
   `components/roomBaseClass.test.ts`, `components/buildingMapRooms.test.ts`,
   `components/familyPlateGround.test.ts`, `src/design/darkPanelMaterials.test.ts`,
   `src/design/lightGroundVoices.test.ts`, and `components/designSystemClasses.test.ts`
   (every class the app references must exist in `ppbf.css`).
7. **Refusal is a stamp, not an error toast** — `RESEARCH NEEDED`, `REDACTED`:
   permanent, attributable, not dismissible. → `components/refusalStamp.test.tsx`.
8. **Proportion descends from φ; nothing is sized by eye.** Type climbs by √φ from 15px;
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
write new work against the ppbf tokens directly; use the components the sheet ships
before inventing anything; fix gaps in `ppbf.css`, not in the page. `RoleStandaloneView`
takes a `room` prop (ignored on the family branch by design); pages with their own
`<main>` carry `room room--*` directly. Because `ppbf.css` is unlayered it beats
Tailwind's layered utilities on any shared property — `scripts/css-layer-collisions.mjs`
finds utilities that never apply.

**Keyboard shortcuts** render only from the registry (`components/shortcuts.ts`), so the
help card cannot list an unbound key → `components/commandsOverlay.test.tsx`. Share
`isTypingTarget()` for any bare printable-key binding.

## Asset rules (these prevented real failures)

- **Plates are gated on the bytes.** `src/design/plateBinaries.test.ts` opens each JPEG
  in `apps/web/public/plates/`: real EOI trailer, dimensions per spec, ≤400KB. Never
  relay image binaries through chat/base64 sidecars — truncated files pass every check
  short of reading the last two bytes.
- **Fonts are self-hosted woff2 only** (offline kiosk); swapping the display voice is one
  token in `ppbf.css`. No CDN links.
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

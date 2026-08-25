# PPBF 005 — THE SCHEDULE BOARD · IMPLEMENTATION BRIEF FOR GROK

**From:** Jason (owner) · **To:** Grok · **Date:** 2026-08-25
**Surface:** `/schedule` · **Scope class:** `.ge-scheduler` · **Existing PR:** **#638** (open, CI green)
**Reference:** the approved DAY/WEEK/MONTH board — wood frame, brass corner brackets, brass tab
plaques, parchment session cards on a dark slate field, brass COACH nameplate under each card.

You own this implementation. Below is everything Claude verified by reading the code, so you are
not guessing at the data or the gates.

---

## 1. BUILD ON #638 — DO NOT START A NEW SCOPE

`.ge-scheduler` already exists in `design-system/current/ppbf-golden-era.css` on branch
`claude/golden-era-visual-005-scheduler`, with the wood board, brass corner brackets, rivet
strips, engraved tab buttons and `.mat-leather--raised` cards already styled. **Extend that
branch.** Starting a second scope for the same surface will collide on the seam.

---

## 2. THE DATA CONTRACT — VERIFIED, NOT ASSUMED

`apps/web/app/schedule/page.tsx` defines the row you are dressing:

```ts
type SchedulerClass = {
  class_id: string;
  title: string;
  start_at: string;
  end_at: string;
  location: string;
  capacity: number;
  coach_account_id: string;
  covering_coach_account_id?: string;
  status: 'open' | 'full' | 'cancelled';
  registered_count?: number;
};
```

Map the reference to that, element by element:

| Reference element | Reality | Verdict |
|---|---|---|
| `06:00 AM` | `start_at`, via `formatGymTimeOfDay` | ✅ real — use it |
| `REG: 12` | `registered_count` | ✅ real — use it |
| `COACH: SAM` | `coach_account_id` — an **account id** (`acct-coach`), not a first name | ⚠️ render the id, or ask Jason to authorise a name lookup |
| `ATTENDANCE: 10` | **no such field exists anywhere on a class** | ❌ **DO NOT RENDER** |
| `DAY` / `WEEK` / `MONTH` | **no view control exists on this page at all** | ❌ **DO NOT RENDER as live tabs** |

Also available and not in the reference, worth placing: `title`, `location`, `capacity`,
`status`, and `covering_coach_account_id` (the cover coach — the board is exactly where a cover
should be visible).

### Why ATTENDANCE and DAY/WEEK/MONTH are refusals, not omissions

This application has just merged five PRs whose entire purpose was deleting exactly this: a
check-in card that asked for a duration nothing recorded (#615), buttons promising an activation
code nothing minted (#616), a summary reporting a message count no feed measured (#619), a
sparring log claiming a coach read it (#612), a track-assignment save that failed silently (#618).

A coach reading `ATTENDANCE: 10` off a brass-framed board would be reading a decoration. Three
brass tabs that filter nothing are three lies in the most prominent position on the surface. On a
safety-adjacent screen an empty slot is far better than a confident wrong number.

**Note the reference's own values are filler** — every card reads `REG: 12 / ATTENDANCE: 10` and
`06:00 AM` appears three times. Treat it as a look-and-feel reference, not a data spec.

If you believe the board needs DAY/WEEK/MONTH or attendance to work, say so to Jason and it
becomes its own functional ticket. Do not resolve it in a stylesheet.

---

## 3. WHAT TO BUILD (all of this is CSS/layout over fields that already render)

Classes currently render as a flat vertical list of `.mat-leather--raised` rows. Turn that into
the reference's board:

- **Card grid** — the reference's 2×4 arrangement, responsive; not a list.
- **Parchment card faces** — deckled/torn edge, aged paper ground, brass rivets at the corners.
  `.mat-paper` is the existing paper material; see §5 for the voice rule that governs it.
- **Brass nameplate slung under each card** carrying the coach value — `.plaque` already exists.
- **Dark slate field behind the cards**, inside the existing wood frame and brass brackets.
- **The three tab plaques may be rendered as the board's HEADING furniture** (engraved brass,
  inert, no `role="tab"`, no click target, not focusable) **only if it is visually unmistakable
  that they are a title and not a control.** If that cannot be made obvious, leave them out.

`FUNCTIONAL_CHANGES: NONE.` Touch no `.ts`/`.tsx` logic, no API, no data model.

---

## 4. THE GATE THAT IS NEW TODAY — YOU WILL FAIL CI WITHOUT THIS

**`apps/web/src/design/brassAlphaChannel.test.ts`** landed today (PR #641). It closed a real leak:
the legacy sheet spelled brass as LITERALS like `rgba(212,175,74,.42)`, and a literal has no token
in it, so no scope override could reach it — legacy gold painted *inside* golden-era scopes. It was
caught live on `.ge-frontoffice`, whose buttons resolved a `rgba(212, 175, 74, 0.42)` border while
the same element correctly resolved `--brass-500` as bronze.

Two rules now bind every scope:

**(a) Never spell a brass colour as a literal.** Each rung ships an unpacked channel triple; use it:

```css
/* WRONG — unreachable by any scope */   border: 1px solid rgba(212,175,74,.28);
/* RIGHT — follows the scope */          border: 1px solid rgb(var(--brass-400-rgb) / .28);
```

**(b) A scope that redefines a rung MUST redefine its triple beside it.** `.ge-scheduler` already
declares all sixteen on #638 — keep them together if you touch them:

```css
--brass-900: #392910;  --brass-900-rgb:  57  41  16;
--brass-800: #533D18;  --brass-800-rgb:  83  61  24;
--brass-700: #6E5220;  --brass-700-rgb: 110  82  32;
--brass-600: #896628;  --brass-600-rgb: 137 102  40;
--brass-500: #9F7A30;  --brass-500-rgb: 159 122  48;
--brass-400: #BE9440;  --brass-400-rgb: 190 148  64;
--brass-300: #D6B063;  --brass-300-rgb: 214 176  99;
--brass-200: #E7C88A;  --brass-200-rgb: 231 200 138;
```

The guard also fails a triple that disagrees with the hex beside it, so keep them in sync.

---

## 5. THE OTHER GUARDS THAT WILL BITE

Every one of these has failed a real change before. **Never weaken, skip or edit a test to go
green — if a guard fails, the CSS is wrong.**

- **`lightGroundVoices.test.ts`** — a paper ground may never be answered with an ink-ground rung.
  A previous `.mat-paper` brass tint was removed rather than the guard relaxed. Parchment cards
  are exactly where this bites.
- **`safeguardingRedReservation.test.ts`** — `#A81E22` / `--locked` / `--stamp-red` is reserved for
  `MEDICALLY_NOT_ALLOWED`. **Never decorative. Never on this board.** Status colours for
  `cancelled`/`full` must come from another rung.
- **`cornerColor.test.ts`**, **`darkPanelMaterials.test.ts`**, **`typeLadder.test.ts`** — corner,
  panel-material and type-step contracts.
- **`plateBinaries.test.ts`** — if you ship any plate: complete JPEG (SOI **and** EOI), > 8 KB,
  **≤ 400 KB**, **4:4:4 no chroma subsampling**, geometry exactly `1280×720` / `2560×1440`
  landscape or `405×720` / `810×1440` portrait, orientation matching the filename.
- Contrast: the reference's engraved-brass-on-brass lettering is the risky part. Keep readable
  contrast on every plaque and card.

---

## 6. HOW TO SHIP IT

1. Work on `claude/golden-era-visual-005-scheduler` (or a branch off it).
2. Upload any binaries **directly to your own feature branch** — never relayed through a chat
   channel. That relay is what produced three rounds of 11- and 24-byte stubs.
3. Run before pushing, from `apps/web`: `npx tsc --noEmit` and `npx jest src/design components`.
   Both must be clean.
4. Push, and note it on **#638**.
5. Claude reviews function/security boundaries. Jason is the only visual authority, on the
   deployed URL — nobody self-certifies the look.

---

## 7. THE ONE-LINE SUMMARY

Build the board — grid, parchment, plaques, slate, brass — over **time, REG, coach, location,
status** which are all real. **Leave `ATTENDANCE` and live `DAY/WEEK/MONTH` out**, because nothing
behind them exists yet, and this app has just finished removing every other place it made a promise
it could not keep.

# Handoff → Visuals account

**Repo:** `PunxsyProminence/ppbf-platform` · **Read first:** `AGENT_KERNEL.md`, then `design-system/ppbf.css` and `design-system/README.md`.

You own the visual layer of a nonprofit youth boxing platform (Punxsutawney
Prominence Boxing Foundation). The design system is **"Leather & Brass"** — a
skeuomorphic system where the platform is a building and every screen is a
*room* in it: oiled leather panels, cast brass hardware, stamped paper, cork,
stained wood. Zero external assets — textures are generated from SVG
`feTurbulence` data URIs so the gym's kiosk renders on a cold tablet with no
network. Do not introduce a webfont CDN, a raw hex, or a Tailwind
`slate-*`/`zinc-*`/`gray-*` utility; everything comes from the tokens.

**The eight laws are in `ppbf.css`'s header. Two govern almost everything below:**
- **Law 2** — saturated colour means safety or status. Nothing else may use it.
- **Law 7** — **refusal is a stamp, not an error toast.**

A repo-wide pass recently took off-system colour utilities across all 125 route
files from 191 → 0. Please keep that at 0.

---

## Job 1 — Refusal states for six new safety gates (highest priority)

Six gates are being installed across the platform right now (separate PRs, all
server-side logic + tests). Each one *refuses* something, and under Law 7 every
refusal needs to render as a **stamp** — not a red alert box, not a toast. Right
now they will fall back to whatever generic error surface each page has, which
is exactly the wrong treatment.

Design the refusal state for each. They are not interchangeable — the tone and
weight should differ because the stakes differ:

| Gate | What gets refused | Notes on tone |
|---|---|---|
| Training hold blocks competition entry | A coach tries to enter a child into a wrestling match or external competition while that child is under an active medical/contact hold | The most serious. This is a child's body. Should read as immovable, not as an error the coach can retry around. |
| Travel waiver missing | Same two surfaces — no signed `travel` waiver on file for taking a minor off-site | A missing legal consent document. Should point at *how to resolve it*, not just refuse. |
| Coach not scoped to athlete | A coach acts on an athlete they are not coach-of-record for and hold no active coverage on | Not a scolding — most often an honest mistake. Quiet, factual. |
| Portrait approve before viewing | An admin tries to approve a child's photo they have not actually looked at | See Job 2 — this one is part of a larger screen. |
| Rejected Film Study proposal cited as evidence | Someone tries to cite an AI observation a coach explicitly rejected as evidence an intervention worked | Rare, technical, admin-facing. |
| Revenue centre fabricated figures | Not a refusal — a standing disclaimer. See Job 3. |

**Precedent to follow, not reinvent:** the existing `.stamp` / `.stamp--brass` /
`.stamp--flat` classes, and the `.badge--cleared` / locked-state treatments
already in `ppbf.css`. Several prototype consoles already carry a brass
"Planned — Not Yet Implemented" stamp; find those and stay in that family.
If the system genuinely lacks a variant one of these six needs, propose it as a
new class *in* `ppbf.css` with the same reasoning-in-comments style the file
already uses — do not one-off it inline in a component.

---

## Job 2 — The portrait-review console (a real screen, currently broken)

`apps/web/app/admin/portrait-review/page.tsx` lets an admin **approve or reject
a child's photograph without ever displaying the photograph.** The reviewer is
attesting to the appropriateness of an image of a minor while looking at
metadata only. A PR is adding the image display and a "you have not viewed
this" gate; it needs a real layout designed, not a bare `<img>` bolted on.

Constraints that are non-negotiable and already documented in the code:
- The portrait is served from a **session-scoped** route
  (`app/api/pilot/profile/photo/[accountId]/`) and must use a bare `<img>`, not
  the Next image optimizer — the optimizer's shared cache must never hold a
  minor's session-scoped portrait. There is a comment explaining this; respect it.
- `profileVisibility.ts` encodes who may see a minor's face at all. Read it
  before designing anything that displays one.
- Precedent for the interaction: `apps/web/app/admin/video-review/page.tsx` was
  recently changed so an admin cannot approve a quarantined video without
  having watched it. Mirror that shape — show the real thing, require explicit
  confirmation, refuse what wasn't looked at.

---

## Job 3 — The six unstyled "Capability Console" pages (largest visual debt)

These six render on the platform today and are **not styled to the design
system at all** — default fonts, flat black panels, empty chart placeholders:

`/admin/macro-analytics` · `/board/dashboard` · `/admin/communications` ·
`/admin/curriculum` · `/coach/operations` · `/admin/retro-lab`

Their outer shells were mapped onto leather/bone tokens in an earlier pass, but
the *contents* — a subsystem numbered L04–L40, tagged `[V-COACH]`/`[V-STAFF]`/
`[V-BOARD-PUBLIC]` — were not. All six now carry a "Planned — Not Yet
Implemented" stamp and a "every figure below is fabricated sample data"
disclaimer, so the honesty problem is handled; **this is purely a visual-quality
job.** Whether this subsystem should be fully styled or is deliberately out of
scope is an open product question — please raise it before doing all six, and
start with one as a proposal.

`RevenueFundingCenter.tsx` (Job 1's last row) is a seventh case: its Grants /
Scholarships / Memberships tabs show hardcoded fictional rows while the real
records exist one click away at `/admin/grants` and `/admin/memberships`. A PR
is adding the disclaimer + links to the real surfaces. Design that pairing so
"these numbers are invented" and "your real numbers are here" read as one
coherent message rather than two stacked warnings.

---

## Job 4 — Locker gear icons (self-contained, 7 assets)

`design-system/screens/floor-card.html` is the reference screen for module 202,
an athlete's personal Floor Card: a locker and bench where earned gear hangs on
a brass hook rail. Seven pieces of kit are currently **placeholder geometry** —
a rectangle standing in for hand wraps, a blob for gloves. They need real art.

Spec, identical for all seven, taken from the live file:
- `viewBox="0 0 100 100"`, drop-in for the existing wrapper:
  `<svg viewBox="0 0 100 100" fill="none" stroke="var(--bone-300)" stroke-width="3">`
- **Line art only** — no fill, no gradient, no shading. Stroke `#DCCFB2`
  (`--bone-300`), width 3 on that grid, rounded joins.
- Transparent ground; these sit on `--hide-950` (`#14100D`) leather, so they
  must read on near-black.
- Style: worn, hand-etched — a 1940s gym-equipment catalogue plate or a woodcut.
  Not a modern flat icon. Legible at 58–72px.
- All seven must read as **one family**: same weight, same hand, same detail
  level. No rarity/loot treatment — this is equipment, and nothing should
  visually outrank anything else. (The screen deliberately calls unearned items
  *unearned*, never *locked* — Law 2 reserves "locked" for the Layer 11 safety
  state. Keep that distinction in any state art.)

The seven: **hand wraps** (rolled cloth bandage) · **gloves** · **jump rope**
(coiled, with handles) · **headgear** · **mouthpiece case** (small hinged box) ·
**corner tin** (round lidded tin) · **corner stool** (folding).

---

## Job 5 — Gym building illustrations (optional polish, already functional)

Six scenes exist as hand-coded SVG placeholders and work correctly — this is
"make them better," not "fix a gap." Skip unless Jobs 1–4 are done.

Non-negotiable rules, straight from `apps/web/src/shared/gymPhotos.ts`'s own
header:
- **No people. Not even drawn ones.** Building only — never a face, never a
  figure, not even a silhouette.
- No stock photography, no fake-photorealism.
- Every image must keep a visible **"PLACEHOLDER ILLUSTRATION"** label baked
  into the frame. These are stand-ins until the gym owner takes real
  photographs, and the label must survive so nobody mistakes one for the real
  thing.

Scenes: the front door (220 N Jefferson St) · the floor on an ordinary night ·
the ring · the bags · the wraps bench · the notice wall. Landscape, ~1220×754.

---

## Working agreement

- Branch per job, draft PR, and **do not mark ready for review** — the owner
  wants visual work checked page-by-page.
- `npm run lint` must stay at 0 errors, and
  `components/designSystemClasses.test.ts` must stay green: it fails on invented
  CSS classes, which is the guardrail against drifting out of the system.
- If you add a token or class, add it to `ppbf.css` with the reasoning comment,
  not inline in a component.

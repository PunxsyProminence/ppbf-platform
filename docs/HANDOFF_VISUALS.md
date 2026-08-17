# Handoff: visual layer

A standing brief for an agent that owns this platform's visual layer. Sibling of
`docs/EXTERNAL_AUDIT_PROMPTS.md` — that file is for a model with no repository
access, pasted code, and no stake in believing us. This one assumes the opposite:
you can read the tree, run the checks, and open a PR.

Read `AGENT_KERNEL.md` first, then `docs/AI_COLLABORATION.md` for collision
control, then `design-system/ppbf.css` and `design-system/README.md`.

## Before you start

Private repository, nonprofit serving minors. Never commit or paste
`apps/web/.env.local`, any connection string, any `AZURE_*` value,
`PPBF_MS_CLIENT_SECRET`, `PPBF_PILOT_BOOTSTRAP_KEY`, any real athlete or
guardian name, any real PIN or account id, or anything from `scripts/data/`.

**Check `docs/current/ACTIVE_WORK.md` and the open PRs before editing.** Several
files named below are being changed right now on other branches; where that is
true it is called out inline.

## The system

"Leather & Brass" — skeuomorphic: the platform is a building and every screen is
a *room* in it. Oiled leather panels, cast brass hardware, stamped paper, cork,
stained wood, brick. **Zero external assets** — textures come from SVG
`feTurbulence` data URIs and layered gradients so the gym's kiosk renders on a
cold tablet with no network. Do not add a font CDN, a raw hex, or a Tailwind
`slate-*` / `zinc-*` / `gray-*` utility. Everything comes from tokens.

The eight laws are in `ppbf.css`'s header. Two govern nearly all the work below:

- **Law 2** — saturated colour means safety or status. Nothing else may use it.
- **Law 7** — **refusal is a stamp, not an error toast.**

A repo-wide pass took off-system colour utilities across all 125 route files
from 191 to 0. Keep it at 0.

---

## Job 1 — Refusal states for six new safety gates

Six gates are being added across the platform (server-side logic and tests, one
branch each). Every one *refuses* something, and under Law 7 each refusal must
render as a stamp. Without design work they fall back to whatever generic error
surface each page happens to have, which is the wrong treatment for all six.

They are not interchangeable — tone should track the stakes.

| Gate | What is refused | Tone |
|---|---|---|
| Training hold blocks competition entry | Entering a child into a wrestling match or external competition while they are under an active medical or contact hold | The most serious. A child's body. Should read as immovable, not as an error to retry around. |
| Travel waiver missing | Same two surfaces, no signed `travel` waiver on file for taking a minor off-site | A missing legal consent document. Must point at how to resolve it, not merely refuse. |
| Coach not scoped to athlete | A coach acts on an athlete they are not coach-of-record for and hold no active coverage on | Usually an honest mistake. Quiet and factual. |
| Portrait approve before viewing | An admin approves a child's photo they have not looked at | Part of Job 2's screen. |
| Rejected Film Study proposal cited as evidence | Citing an AI observation a coach explicitly rejected as evidence an intervention worked | Rare, technical, admin-facing. |
| Revenue centre fabricated figures | Not a refusal — a standing disclaimer. See Job 3. |

**Follow the existing family, do not invent one:** the `.stamp` /
`.stamp--brass` / `.stamp--flat` classes, and the `.badge--cleared` and
locked-state treatments already in `ppbf.css`. Several prototype consoles carry
a brass "Planned — Not Yet Implemented" stamp; stay in that family. If the
system genuinely lacks a variant one of these six needs, add it *to* `ppbf.css`
with the reasoning-in-comments style that file already uses — never a one-off
inline in a component.

## Job 2 — The portrait-review console

`apps/web/app/admin/portrait-review/page.tsx` approves or rejects a child's
photograph **without ever displaying the photograph.** The reviewer attests to
the appropriateness of an image of a minor while looking at metadata only. A PR
is adding the image and a "you have not viewed this" gate; the screen needs a
real layout, not a bare `<img>` bolted on.

Non-negotiable, and already documented in the code:

- The portrait is served from a **session-scoped** route
  (`apps/web/app/api/pilot/profile/photo/[accountId]/`) and must use a bare
  `<img>`, never the Next image optimizer — the optimizer's shared cache must
  not hold a minor's session-scoped portrait. Find that comment and respect it.
- `apps/web/src/server/pilot/profileVisibility.ts` encodes who may see a minor's
  face at all. Read it before designing anything that displays one.
- Interaction precedent: `apps/web/app/admin/video-review/page.tsx` — an admin
  cannot approve a quarantined video without having watched it. Mirror that
  shape. **Note:** that watch-gate lands via an open PR; on `main` you will see
  the ungated version. Read the PR branch to see the pattern you are matching.

## Job 3 — The unstyled Capability Console pages

Six pages render today and are not styled to the design system — default fonts,
flat black panels, empty chart placeholders:

`/admin/macro-analytics` · `/board/dashboard` · `/admin/communications` ·
`/admin/curriculum` · `/coach/operations` · `/admin/retro-lab`

Their outer shells were mapped onto leather and bone tokens in an earlier pass;
the *contents* — a subsystem numbered L04–L40, tagged `[V-COACH]` /
`[V-STAFF]` / `[V-BOARD-PUBLIC]` — were not. All six now carry a "Planned — Not
Yet Implemented" stamp and a "every figure below is fabricated sample data"
disclaimer, so the honesty problem is handled. **This is purely visual quality.**

Whether this subsystem should be fully styled or is deliberately out of scope is
an open product question. Raise it before doing all six; start with one as a
proposal.

`apps/web/components/RevenueFundingCenter.tsx` is a seventh case: its Grants,
Scholarships and Memberships tabs show hardcoded fictional rows while the real
records sit one click away at `/admin/grants` and `/admin/memberships`. A PR is
adding the disclaimer plus links to the real surfaces. Design that pairing so
"these numbers are invented" and "your real numbers are here" read as one
message, not two stacked warnings.

## Job 4 — Locker gear icons (7 assets)

`design-system/screens/floor-card.html` is the reference screen for module 202,
an athlete's Floor Card: a locker and bench where earned gear hangs on a brass
hook rail. Seven pieces of kit are **placeholder geometry** — a rectangle
standing in for hand wraps, a blob for gloves.

> **This file is not on `main`.** It arrives with the `feat/public-login-merge`
> branch. Work from that branch, or wait for it to merge.

Spec, identical for all seven, taken from the live file:

- `viewBox="0 0 100 100"`, drop-in for the existing wrapper
  `<svg viewBox="0 0 100 100" fill="none" stroke="var(--bone-300)" stroke-width="3">`
- **Line art only.** No fill, no gradient, no shading. Stroke `#DCCFB2`
  (`--bone-300`), width 3 on that grid, rounded joins.
- Transparent ground — these sit on `--hide-950` (`#14100D`) leather and must
  read on near-black.
- Worn, hand-etched: a 1940s gym-equipment catalogue plate or a woodcut, not a
  modern flat icon. Legible at 58–72px.
- All seven must read as **one family** — same weight, same hand, same detail
  level. No rarity or loot treatment: this is equipment, and nothing should
  visually outrank anything else.
- The screen deliberately calls unearned items *unearned*, never *locked* — Law 2
  reserves "locked" for the Layer 11 safety state. Keep that distinction in any
  state art.

The seven: hand wraps (rolled cloth bandage) · gloves · jump rope (coiled, with
handles) · headgear · mouthpiece case (small hinged box) · corner tin (round,
lidded) · corner stool (folding).

## Job 5 — Gym building illustrations (optional)

Six scenes exist as hand-coded SVG placeholders and work correctly. This is
"make them better", not "fix a gap" — skip unless Jobs 1–4 are done.

Rules, from `apps/web/src/shared/gymPhotos.ts`'s own header:

- **No people. Not even drawn ones.** Building only — never a face, never a
  figure, not even a silhouette.
- No stock photography, no fake photorealism.
- Every image keeps a visible **"PLACEHOLDER ILLUSTRATION"** label baked into
  the frame. These stand in until the gym owner takes real photographs; the
  label must survive so nobody mistakes one for the real thing.

Scenes: the front door (220 N Jefferson St) · the floor on an ordinary night ·
the ring · the bags · the wraps bench · the notice wall. Landscape, ~1220×754.

## Working agreement

- One concern per branch, draft PR, and **do not mark ready for review** — the
  owner checks visual work page by page.
- `npm run lint` stays at 0 errors, and
  `apps/web/components/designSystemClasses.test.ts` stays green: it fails on
  invented CSS classes and is the guardrail against drifting out of the system.
- New token or class goes in `ppbf.css` with its reasoning comment, not inline.

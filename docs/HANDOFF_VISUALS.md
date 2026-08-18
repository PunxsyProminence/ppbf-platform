# Handoff: visual layer

A standing brief for an agent that owns this platform's visual layer. Sibling of
`docs/EXTERNAL_AUDIT_PROMPTS.md` — that file is for a model with no repository
access, pasted code, and no stake in believing us. This one assumes the opposite:
you can read the tree, run the checks, and open a PR.

Read `AGENT_KERNEL.md` first, then `docs/capabilities/NETWORK_STATUS.md` (what
has already merged, what is in flight, and what is parked — it points you at the
open PR list for whose files are spoken for rather than copying it), then
`docs/AI_COLLABORATION.md` for collision control, then `design-system/ppbf.css`
and `design-system/README.md`.

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

## Job 3 — Do NOT style the Capability Console pages

Six pages render today unstyled — default fonts, flat black panels, empty chart
placeholders:

`/admin/macro-analytics` · `/board/dashboard` · `/admin/communications` ·
`/admin/curriculum` · `/coach/operations` · `/admin/retro-lab`

An earlier version of this brief asked for them to be brought onto the design
system, starting with one as a proposal. **Owner decision, 2026-08-17:
don't.** The instruction is *"skip styling; the bigger problem is that these
are mockups — prioritise connecting real data to the ones where it exists."*

That is the right call and worth understanding rather than just obeying,
because it changes what "finished" means for this subsystem. All six already
carry a brass "Planned — Not Yet Implemented" stamp and a "every figure below
is fabricated sample data" disclaimer, so the **honest** problem is solved: no
admin can mistake an invented SafeSport clearance or board figure for a real
one. Styling them would make fabricated data look *more* authoritative while
changing nothing about whether it is true. A page that reads as unfinished,
and says it is unfinished, is doing its job.

So this job is now: **leave them alone.** If you have appetite for this area,
the useful work is wiring real data, and that is engineering rather than
visual work — raise it rather than starting it here.

**The one exception is `apps/web/components/RevenueFundingCenter.tsx`,** and it
is the exception precisely because it is the case the owner's instruction
points at. Its Grants, Scholarships and Memberships tabs render hardcoded
fictional rows **while real, table-backed records for all three already
exist**, one click away at `/admin/grants` and `/admin/memberships`. An
in-flight PR adds the disclaimer plus links to those real surfaces, which is
the right immediate honesty fix — but per the decision above, the intended
end state is those tabs reading the real records, not a permanent disclaimer.
Treat the disclaimer as a stopgap with a known replacement, not as the fix.

If you do design anything here, design that pairing — "these numbers are
invented" and "your real numbers are here" as one message, not two stacked
warnings — and expect it to be deleted when the data lands.

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

## The shared drive folder, and which side is canonical

UI/UX and flow work happens with a partner tool outside this repository, using
a shared drive folder to hold templates, button treatments and component
studies. That is a good way to move assets. It is also the exact shape of the
defect that broke `main` three times in one day — a vocabulary maintained in
two places drifts, and the copy that drifts is the one nobody tests.

So the boundary is one-directional, and it is not negotiable:

| Thing | Canonical home | Moves how |
|---|---|---|
| Tokens, classes, the eight laws | `design-system/ppbf.css` **in this repo** | Repo → drive. Export a snapshot to work against; never edit the drive copy and expect it to matter. |
| Rendered assets: SVG icons, illustrations, photography | the drive folder, until committed | Drive → repo, by a person who looked at the file. Committing it is the release decision. |
| Layout studies, flow diagrams, button explorations | the drive folder | Stay there. They are studies, not sources. |

Two rules follow, and both have already bitten this codebase:

1. **A class that is not in `ppbf.css` does not exist**, however finished it
   looks in the drive folder. `apps/web/components/designSystemClasses.test.ts`
   fails the build on invented CSS classes — that test is the guard, and it only
   reads the repo. If a study needs a new class, add it to `ppbf.css` with its
   reasoning comment in the same PR that uses it.
2. **An asset is not "delivered" until it is committed.** The design/visuals
   lane in `docs/current/ACTIVE_WORK.md` says work "blocked on owner-supplied
   assets stays blocked; do not substitute invented assets." A file sitting in
   the drive folder is still blocked. Move it, or say it is blocked — do not
   approximate it in code.

If the drive folder and `ppbf.css` disagree about a colour, a radius, or a type
scale, **`ppbf.css` is right by definition** and the drive copy is stale. Fix
the drive copy; do not "reconcile" them by editing the repo to match a study.

## Working agreement

- One concern per branch, draft PR, and **do not mark ready for review** — the
  owner checks visual work page by page.
- `npm run lint` stays at 0 errors, and
  `apps/web/components/designSystemClasses.test.ts` stays green: it fails on
  invented CSS classes and is the guardrail against drifting out of the system.
- New token or class goes in `ppbf.css` with its reasoning comment, not inline.

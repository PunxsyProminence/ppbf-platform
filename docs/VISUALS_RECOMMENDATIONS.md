# PPBF Visuals: Ease of Use, Engagement, and Flow Recommendations

Grounded in the current codebase (post golden-era overhaul, commit `15bf902`) — the design system, the achievement/notice logic, and the actual page structure. Not guesses about a generic app; specific to what this platform already does and deliberately does not do.

## The one constraint that shapes everything below

`achievementPaths.ts` and `gymNotices.ts` both carry unusually explicit reasoning in their own comments: this platform runs a safety gate that locks athletes out for medical reasons, in a contact sport, often involving children. Any progress mechanic that can express a window, a streak, a deadline, or a ranking creates a direct incentive to hide an injury rather than report it. That rule is enforced by tests, not just convention (`achievementPaths.test.ts` fails on "the vocabulary of streaks").

Practical effect: none of the recommendations below introduce streaks, leaderboards, countdowns, or comparative ranking. Where "engagement" is the goal, the lever is *noticing and presence*, not *pressure and competition*. This is a real constraint, not an aesthetic preference — violating it would be reintroducing a documented safety problem.

---

## Ease of use

**1. Add a neutral (fifth) badge rung.**
The four-rung badge system (cleared / monitor / restricted / locked) is doing real work — every status pairs a glyph with a label so it survives greyscale and colorblindness. But at least five separate conversion batches (admin-consoles, admin-tables, board, coach) independently noted the same gap: administrative states that aren't safety states — Deactivated, Unfilled, Archived, Unknown readiness, draft/idle — currently either misuse one of the four saturated rungs or get a one-off hand-rolled neutral chip. Two different files (`CoachWorkspace.tsx`, `decision-loop/page.tsx`) already invented the *same* neutral chip independently because the sheet doesn't provide one.
Fix: one `.badge--neutral` rung in `ppbf.css` (bone-on-dark, `◌` glyph per the pattern already used twice). This isn't cosmetic — it's the difference between color reliably meaning "pay attention" everywhere, versus color sometimes meaning that and sometimes just meaning "administrative."

**2. Extend the step-dial pattern to other long forms.**
`admin/organizations/page.tsx`'s onboarding wizard has a real step dial (done = brass fill, current = brass ring) so a person always knows where they are and how much is left. Other multi-field flows in the app — the athlete-review form in `CoachWorkspace.tsx`, the correction/deactivate forms in `admin/athletes` — are long single-scroll forms with no progress indication. Where a form has genuinely sequential stages (not just many fields), the step dial is a proven, existing pattern — reuse it rather than leaving those flows as one long unbroken scroll.

**3. Ship the small-button and KPI-tile components that keep getting hand-rolled.**
Both gaps are logged independently across three+ batch reports: row-level actions want something more compact than full `.btn` size (currently improvised locally as `.btn-sm`), and every dashboard rebuilds the same "label + big figure + note" tile from raw materials rather than a shared `.stat` component. Low-risk, high-leverage: these are pure additions to the sheet, no page rewrites required, and they stop the next ten pages from each inventing a slightly different version.

**4. Let type voices resize through utility classes instead of inline styles.**
`.t-data` and `.stamp` are pinned to fixed sizes via unlayered CSS, so anyone needing a bigger or smaller version is currently forced into inline `style={{ fontSize }}` — noted as a workaround in the admin-consoles, board, and coach batch reports independently. Adding sized rungs (`.t-data--lg`, `.stamp--sm`) removes three separate already-existing workarounds and prevents the next one.

---

## Engagement

**5. Extend the "gym noticing" voice beyond the one anniversary case.**
`gymNotices.ts` already has a genuinely distinctive, well-reasoned tone: dry, one line, no exclamation marks, no confetti, additive only, never comparing one person to another, never subtracting attendance. Right now it's scoped narrowly (the "before dawn" / anniversary remarks). That voice is a real asset — most platforms default to exclamation-point congratulation copy, and this one deliberately doesn't, for a stated reason ("a coach glances at the clock and says something short," not "the app congratulating"). Worth asking whether more moments in the product could carry that same restrained, specific noticing rather than generic "Great job!" copy — a milestone reached, a first session in a new track, a corner assignment — written in the same voice, always additive, never time-windowed.

**6. Treat the wall display as the primary engagement surface, not an afterthought.**
`WallDisplay.tsx` is architecturally unusual in the codebase — it deliberately breaks the standard page shell (no session bar, no hover states, type sized for fifteen feet away, hard-capped lists so a busy night can't overflow a TV). That's the one screen in the whole app that's ambient and *public* inside the physical gym rather than something one person privately opens on their phone. A milestone or recognition that shows up there carries social weight a private in-app notification can't. Worth reviewing what currently surfaces on the wall versus what's locked inside individual dashboards — if recognition-worthy achievements aren't reaching that screen, that's a bigger engagement gap than anything achievable through UI polish on private pages.

**7. Make the "family" translation layer visible to the person it's for, not just present in the data.**
`achievementPaths.ts` already carries a `family` string alongside every technical achievement description specifically so a parent gets an answer to what they actually asked ("is my kid showing up, sticking with it, getting stronger") rather than untranslated RPE jargon. That's a strong, deliberate design decision. Worth confirming it's surfaced prominently wherever parents actually look (ParentHub, guardian portal) rather than being available-but-buried behind the athlete-facing version — the value of a translation layer depends entirely on whether the audience it's for actually sees it.

---

## Flow

**8. Walk the activation → PIN flow end-to-end as one journey.**
`activate/page.tsx` already enforces real sequence (code stage before PIN stage, explicit inline comment: "you cannot choose a PIN before..."), which is good — but this is the one flow a brand-new family experiences with zero familiarity with the rest of the app's conventions. First impressions here compound into how much friction the rest of the product feels like it has. Worth an actual click-through review (not a file read) rather than trusting that each individual page's UX is fine in isolation — sequence bugs and friction rarely show up file-by-file, only end-to-end.

**9. Move floor-side and desk-side actions inline where currently a full navigation.**
Coaches and admins under time pressure — mid-session on the gym floor, mid-intake at a desk — are the people flow costs hit hardest. Anything gated behind "click into a full page, do the thing, click back" that could instead happen inline (marking a milestone, updating a readiness flag, approving a queue row) saves real friction at exactly the moments where friction is most expensive. `CoachWorkspace.tsx` already has real-time patterns (readiness dots, task status); worth auditing for actions that still force a full page round-trip that a modal or inline control could handle instead.

**10. Give kiosk-mode athletes the same tap-target and type-size guarantees consistently.**
The style contract already mandates 55px tap targets and larger type minimums specifically for anything an athlete touches on the gym floor (`--tap`, `.btn--kiosk`, `.input--kiosk`) — a real, correct recognition that floor conditions (gloves, motion, distance) are different from a desk. Worth auditing kiosk-adjacent surfaces (photo review, passbook-check, athlete self-service points) to confirm every interactive element on those specific routes actually uses the kiosk-sized components rather than the desk-sized defaults, since it's an easy thing to miss on a page-by-page conversion.

---

## More: physical artifacts, help, and quality process

**11. Treat the print room as a second physical engagement surface, alongside the wall.**
`PrintRoom.tsx` produces two real, physical artifacts — a membership card and a certificate for an earned milestone (`PrintableCertificate`, `PrintableFightCard`, both pulling from the same `achievementPaths` catalogue as the digital badges). A printed certificate a kid takes home is a fundamentally different kind of recognition than something that lives inside a login only the athlete sees — it's shareable, showable to a parent or sibling who never opens the app. Worth asking the same question as the wall display: is everything worth printing actually easy to get to the print room from wherever the milestone is first shown, or does a person have to already know this feature exists?

**12. Extend the existing help/authoring system (rabbit holes) to cover more of the app's own conventions.**
There's already a real, built-out lesson-authoring system (`rabbit-holes`) with audiences, anchor types, and publish/retire status — infrastructure most apps don't bother building. That's worth leaning on for exactly the kind of thing this doc keeps surfacing: explaining *why* the badge ladder works the way it does, or what the gym-noticing remarks mean, to a new coach or admin encountering the conventions for the first time. A well-designed system that nobody's told the meaning of reads as arbitrary; the authoring tool to fix that already exists in the codebase.

**13. Make announcements feel like the gym talking, not the software.**
`AnnouncementBanner` is already wired into `AthleteWorkspace` and used elsewhere in the app. Worth a pass to confirm its copy and presentation match the same restrained, specific voice as `gymNotices.ts` rather than reading as generic system-notification copy — the two are adjacent surfaces (both are "the app tells you something unprompted") and a mismatch in tone between them would be more noticeable than either alone.

**14. Operationalize the contrast sweep instead of leaving it batch-by-batch.**
`npm run sweep` (`scripts/contrast-sweep.mjs`) already exists and does real work — it catches invisible-text regressions the unit suite structurally cannot see, which is exactly the class of bug the pass notes flag as having shipped past 2,600 green tests before (a brass button repainted by an outranking link rule, bone-on-cream text after a type-voice change). Nearly every batch report in this release explicitly says sweep wasn't run because it needs a live dev server and a baseline ref, which the batch didn't have. Rather than relying on each future batch to remember and set that up individually, this is worth wiring into CI (or at minimum a documented pre-merge step) with a checked-in baseline — turning a repeatedly-skipped manual step into something that can't quietly stay skipped.

---

## More: the AI surface, multi-child families, and the front door

**15. Resolve the SHADOW chat handoff gap.**
`ShadowChatButton` is wired into the athlete workspace, coach workspace, ParentHub, and even the public page — a real, deliberately consistent AI assistant surface across the whole app. But `AthleteWorkspace.tsx` has explicit copy admitting a seam: "this workspace does not answer questions inline... You cannot chat with SHADOW from this screen yet. Open the full SHADOW chat..." That's an honest label on a real flow break — a person asks a question, gets told to go somewhere else to actually ask it. Worth treating as a flow item on its own: either bring a lightweight inline answer capability to the workspace, or at minimum make the handoff itself frictionless (opens the chat pre-loaded with the question already asked, rather than a blank chat the person restates themselves into).

**16. Design explicitly for the multi-child family, not just retrofit it.**
`ParentHub.tsx` already has real infrastructure for a parent with more than one athlete — `activeChildId`, per-child filtering of attendance and progress milestones, a child switcher. That's the harder and more common real-world case (siblings training together) and it's already functionally there. Worth a dedicated pass asking whether the *visual* design treats child-switching as a first-class action (obvious, fast, unambiguous about which child's data is currently showing) rather than something that works but reads like a single-child screen with an extra control bolted on. A parent glancing at their phone between errands should never have to double-check which kid's readiness flag they're looking at.

**17. Give the public-facing front door its own scrutiny, separate from the logged-in app.**
`public/page.tsx` is the one screen a stranger sees before they're anyone in the system yet — it already segments visitor type (athlete, parent, volunteer, coach, donor, board, general) and carries its own SHADOW chat entry point. This page does more work than any other single route: it has to convert a stranger into someone who trusts the gym enough to hand over a kid. It's also the one page that's genuinely `.on-canvas` from the very first pixel, no login context to lean on. Worth reviewing on its own terms — not as "one more converted page" but as the actual front door, held to marketing/conversion scrutiny in addition to the design-system consistency the rest of this doc focuses on.

---

## Suggested priority if only tackling a few

Highest ratio of impact to effort: **#1 (neutral badge rung)** and **#3 (small-button + KPI tile components)** — pure sheet additions, no page rewrites, remove several already-duplicated workarounds at once. Highest ratio of *meaning* to effort: **#5/#6/#11 (extending the gym-noticing voice, wall display, and print room)** — this platform already has a genuinely distinctive engagement philosophy that most of its competitors don't; the cheapest win is applying more of it, not inventing something new. Worth doing as real user-facing review rather than a file read: **#8 (activation flow walkthrough)**, since it's the one journey where a brand-new family's first impression is set. Worth doing before the *next* visuals pass rather than after: **#14 (operationalize the contrast sweep)** — every other recommendation here risks the same invisible-text regression class that's already shipped once if this stays a manually-remembered step. Worth flagging as its own conversation rather than a visuals-pass line item: **#15 (the SHADOW handoff gap)** — the codebase itself admits the seam in its own comments, which is usually the strongest signal that something is worth fixing rather than living with.

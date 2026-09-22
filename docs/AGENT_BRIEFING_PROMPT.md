# The briefing prompt

Paste this whole file to any agent joining the build -- Claude, Grok, or
anything else. Fill in the one blank at the bottom. Everything above the blank
is identical for every agent on purpose: they all need the same picture of who
else is working and what will collide. Re-paste it when an agent's context
resets.

The 2026-08-28 version, with the incident narratives, is kept verbatim in
`docs/archive/2026-09-21_AGENT_BRIEFING_PROMPT_before_condense.md`.

---

## COPY FROM HERE

You are joining an existing build. Read this whole brief before you touch
anything, including the parts about other agents' work: the failures this
project has actually had were collisions, not bad code.

### What you are working on

A nonprofit youth boxing gym platform. It holds real records for real minors:
guardian consent, medical clearance, training holds, photographs and video of
children. Nothing here is a demo.

One rule governs almost every decision: **invented authority is worse than an
admitted gap.** A formula coded and deliberately unwired, labelled "unproven,
must not clear, restrict, or prescribe training", is the codebase working as
intended. A page that says "every figure below is fabricated sample data" is
finished, not broken. If you cannot establish something, say so -- do not
supply a plausible value. Code gets built on plausible values.

### Never transmit

Never paste, commit, or send outside the repository: `apps/web/.env.local`, any
connection string, any `AZURE_*` value, `PPBF_MS_CLIENT_SECRET`,
`PPBF_PILOT_BOOTSTRAP_KEY`, any real athlete or guardian name, any real PIN or
account id, or anything under `scripts/data/`. Naming a variable is fine; its
value never leaves.

### Read these first, in this order

If you have repository access:

1. `AGENT_KERNEL.md` -- the single execution contract, including who does what
   (lanes) and who merges. Everything else is subordinate to it.
2. `docs/current/ACTIVE_WORK.md` -- work lanes, blocked and parked work, and
   standing owner directions.
3. `docs/AI_COLLABORATION.md` -- collision control.
4. `docs/current/OWNER_DECISIONS.md` before you write any test, gate or
   migration that asserts who may do what.
5. Then your role's brief, named at the bottom of this file.

If you do not have repository access, your role block tells you what you get
instead and where your output goes.

### How we divide work: by lane, not by role

Your **role** is your job -- researching, designing, wiring, integrating. Your
**lane** is your territory -- the set of files you are allowed to change.
Coordinating by role does not prevent collisions: a researcher, a designer and
a wirer can all edit the same file on the same afternoon, each doing their own
job correctly. Role sequencing (Architect → Implementer → Reviewer → QA) was
tried and retired; `docs/MULTI_AI_EXECUTION_PLAN.md` is SUPERSEDED and says not
to reconstruct it.

So: staffed by role, coordinated by lane. The standing work lanes are in
`docs/current/ACTIVE_WORK.md`. Pick one lane and work one bounded branch at a
time inside it. **Do not drive-by fix another lane's surface** -- if you spot
something broken outside your lane, write it down and hand it over.

Research writes only to `docs/research/`, and auditing only reads, so neither
can collide with anyone.

### Claim your work in GitHub, not in a document

Open a **draft PR early**, before the work is finished. The PR is the claim --
visible to everyone, and unlike a markdown table it cannot go stale. Do not
record claims in `NETWORK_STATUS.md` or any other doc; a stale list of which
files are spoken for reads as authoritative and is worse than none.

To find what is in flight before you start:

```
gh pr list --state open
git diff --name-only origin/main...origin/<branch>
```

### Merging

Who may merge, and what production needs, is in `AGENT_KERNEL.md` under
**Lane model** -- read it there, not in any older note. Per-PR review and
per-PR CI cannot see a defect that exists only in the combination of two green
PRs (on one day three PRs each added a member to an exhaustive union, and
`main` broke three times). Two habits follow, for everyone:

- Before you add a **reader** of a shared register or table, ask **who else
  writes it.**
- Before you add a **member to a union type**, grep every exhaustive consumer
  of it.

### The shared drive folder

UI/UX and flow work happens partly outside this repository in a shared drive
folder holding templates, button treatments and component studies. A
vocabulary kept in two places drifts, and the copy that drifts is the one
nobody tests, so the boundary is one-directional:

| Thing | Canonical home | Direction |
|---|---|---|
| Tokens, classes, the eight design laws | `design-system/ppbf.css`, in the repo | repo → drive. Snapshot it to work against; editing the drive copy changes nothing. |
| Rendered assets: SVG icons, illustrations, photography | the drive folder, until committed | drive → repo, by a person who looked at the file. Committing is the release decision. |
| Layout studies, flow diagrams, button explorations | the drive folder | they stay there. Studies, not sources. |

1. **A class that is not in `ppbf.css` does not exist**, however finished it
   looks in the drive. `apps/web/components/designSystemClasses.test.ts` fails
   the build on invented CSS classes, and it only reads the repo.
2. **An asset is not delivered until it is committed.** A file sitting in the
   drive folder is still blocked. Move it, or report it as blocked -- never
   approximate it in code.

If the drive and `ppbf.css` disagree about a colour, a radius or a type scale,
`ppbf.css` is right by definition. Fix the drive copy.

### What needs a human, not a commit

Stop and ask the owner -- do not implement, however obviously right it looks:

- Anything that **narrows a role gate**, changing what a coach or guardian is
  allowed to do. These break daily workflows for real staff.
- Anything that **reverses a recorded owner decision.** Several things here are
  parked deliberately.
- Anything touching **production, migrations against real environments, or
  releases.**
- Any finding you believe means **a child is currently unsafe.** Raise that
  immediately and separately, not at the end of your work.

### How to report

Report what happened, not what you hoped. If tests fail, say so and paste the
output. If you skipped part of the scope, say which part and why. If a finding
turns out to be wrong after you wrote it up, correct it in place and say you
corrected it. Do not describe work as done when it is green-in-theory. Run the
checks.

### YOUR ROLE

**You are: ________________________**

Find yourself below.

**Research.** Your brief is `docs/HANDOFF_RESEARCH.md` -- read it in full; it
names six items and their priority order (corrected there on 2026-08-24). You
write only to
`docs/research/` (create it). You change no application code, no migrations, no
coefficients, no thresholds. You recommend; you do not implement. Carry
citations inline. "We could not establish this" is a complete and valuable
answer -- an uncited plausible answer is worse than nothing, because code gets
built on it.

**UI / UX and flow (design & visuals lane).** Grok's contract,
`docs/GROK-VISUAL-LANE.md`, governs this lane; your brief is
`docs/HANDOFF_VISUALS.md`. The design system is "Leather & Brass" -- read
`design-system/ppbf.css`'s header for the eight laws; Law 2 (saturated colour
means safety or status, nothing else) and Law 7 (**refusal is a stamp, not an
error toast**) govern most of the work. Zero external assets: no font CDN, no
raw hex, no Tailwind `slate-*`/`zinc-*`/`gray-*`; off-system colour utilities
stand at 0 across the route files -- keep it there. Draft PRs only, and **do
not mark them ready for review** -- the owner checks visual work page by page.
One job in your brief is "do not do
this": the six unstyled Capability Console pages stay unstyled by owner
decision, because they show fabricated data and styling them would make
invented figures look more authoritative without making them true.

**Wiring (product build lane).** Application code, routes, server domain
modules under `apps/web/src/server/pilot/`, migrations.
`docs/capabilities/NETWORK_STATUS.md` lists what is unclaimed and what is
blocked on someone else's output -- start from "Unclaimed", and check the
blocked items are still blocked before assuming. One concern per branch. Your
PR is your claim; open it as a draft on your first commit. Merge only as the
kernel's Lane model allows. Keep the two habits above -- they are the two
defect classes that have actually hurt this project.

**Auditing.** Read-only and collision-free: you can read any lane. Findings go
into `docs/capabilities/NETWORK_STATUS.md` -- record the **shape** of what you
found, not just that you fixed it. **Auditing carries no merge rights**: no
branches, commits, pushes, merges, deploys or migrations. If you find something
broken outside the lane you are reading, write it up and route it; do not fix
it in passing.

## COPY TO HERE

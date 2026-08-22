# Grok visual lane

**Agreed 20 Aug 2026. Substantially amended 22 Aug 2026 by owner decision.**
Originally authored by Grok, amended once by Claude on a point Grok could not
check from outside the sandbox. Live contract — if the repo and this document
disagree, the repo wins and this document is wrong.

**What changed on 22 Aug, and why.** The original contract put Grok outside
the repository: it made image files, Claude implemented everything, and
"writing is what stays gated" was the organising idea. That cost fidelity at
every handoff — the implementer re-derived intent from a picture, and the
designer never saw what shipped. **Grok now designs and implements its own
visual work**, reading current source first and building only what the owner
approved. The gate did not disappear; it moved onto the PR, where an
independent reviewer belongs.

Everything below concerning **plate binaries** — 4:4:4, the drop, the byte
gate, the composition laws — is unchanged and still binds. What changed is who
writes the code around them.

## The lanes

| Lane | Owns | Never touches |
|---|---|---|
| **ChatGPT** | SharePoint, OneDrive, Google Drive taxonomy; independent audit of diffs, CI, scope | the repository (read-only), image generation |
| **Grok** | visual design **and** visual implementation: image files, JSX presentation structure, design-system usage, CSS, responsive layout, typography, visual tests | functional/security code (see the two lists below), drive reorganisation |
| **Claude** | functional and security engineering, migrations, release engineering; **independent review of Grok's visual PRs** | drive taxonomy, image generation, redesigning approved visual work |

Nobody pushes to `main`. Everything lands by PR with green CI, including
Claude's own work and Grok's. This is not a hierarchy — it is the rule in
`AGENT_KERNEL.md`, and it exists because nine direct-to-main pushes from a
secondary channel destroyed `apps/web/package.json` on 19 Aug and left `main`
unable to build, test, or migrate.

## What Grok may and may not change

Grok reads the current page, its components and its tests **before** designing.
Current source is the functional authority; the owner-approved design is the
visual authority. Where a design conflicts with real behaviour, **the design
changes** — working behaviour is not altered to make a picture fit.

**May change:** JSX visual structure and presentation hierarchy;
design-system classes; CSS; responsive layout; typography; visual assets
within the image lane; accessibility markup belonging to its own layout; the
visual and component tests covering all of it.

**May not change without a separate owner-approved functional task:** database
schema; migrations; API behaviour; authentication; authorization; organization
scoping; guardian/athlete access rules; safeguarding policy; medical or hold
semantics; role vocabulary; business logic; SHADOW algorithms; progression
algorithms; data models; audit semantics; server security boundaries.

**Invents nothing.** Not roles, athlete data, metrics, readiness scores,
statuses, navigation destinations, medical information, security claims,
SHADOW capabilities, or buttons with no backing behaviour. If an approved
concept contains an element with no real behaviour behind it, omit it and
report it rather than building a shell.

## What Grok produces

Two kinds of output, and they travel by different routes.

**Visual implementation** — the presentation layer of real pages, in code, on
a feature branch, by PR. This is the bulk of the work under the 2026-08-22
model.

**Real JPEG wall plates**, **layer 0 only**: the photographed wall a room
stands in. Real UI composites on top in code. Plates are binaries and still
enter through the drop described below, never through a chat channel.

Grok re-reads these two files before every plate order, and reads the current
page, components and tests before every visual design, rather than working
from a summary of either:

1. `design-system/ppbf.css` — rooms, materials, lamp laws, colour tokens, the
   PLATES block
2. `apps/web/public/plates/README.md` — format, quiet centre, layer-0 rule,
   the delivery failures, variant rules

### Two modes (owner correction 2026-08-20, extended 2026-08-22)

An earlier version of this contract said "one order = one file" as an absolute
law. That was wrong, and it was Claude's error: it wrote a **delivery gate**
as though it governed the whole lane, which would have forbidden Grok from
showing options at all. Exploration and delivery are different activities and
only one of them needs a gate.

**Mode A — design. The work.** Grok reads the current implementation, names
the real fields, actions and states it has to serve, says what is wrong with
the screen today, and produces alternatives. Jason photographs the real gym;
Grok treats those photographs as primary reference. Multiple references,
multiple outputs, iterate freely, show options, critique the existing design.
**None of the delivery rules below apply in Mode A.** No filename discipline,
no inbox, no PR, no branch. This is where the design actually happens and it
should be loose. It ends when Jason approves one direction — not before.

**Mode B — implementation. The gate.** Grok builds the direction Jason
approved, and only that direction. For a **plate**: one file, the exact
ordered filename, 4:4:4, into `Grok-Plates-Inbox`. For **code**: a feature
branch off current `main`, the approved design implemented against current
source, visual tests added or updated to match, and a PR. Never a direct push
to `main`. Then Claude reviews function and security, ChatGPT audits the diff
against the claims, CI must be green on the exact head, and Jason reviews the
result live.

The one-file rule for plates exists so a plate entering the repository is
unambiguous — so `plate-01-office-02.jpg` means one specific image and the
byte gate can refuse a bad one by name. It was never meant to limit how many
pictures get made, and it does not govern code PRs.

**One screen, or one coherent small set, at a time.** Concept to
implementation is not a race; a large visual PR is harder to review for
functional drift, which is the thing most likely to slip through.

### Photographing the gym

Jason shooting the real place solves two problems at once, and they are worth
keeping distinct:

1. **Reference for wall plates.** Real brick, mortar, plank, lamps, light and
   wear, so a generated wall looks like *this* building rather than stock. The
   plate that ships may be generated from those references; that is Mode A
   into Mode B.
2. **The twelve photograph slots** in `docs/visual-inventory/03-glyphs-and-photos.md`
   are a different job. Six frames of the building and the coach's portrait
   are **the photographs themselves**, not references for generation.
   `gymPhotos.ts` forbids fake-photorealistic imagery in those slots. A camera
   fills them; a model must not.

**Reference shots should be of empty walls and rooms.** No athletes, no
children, no faces. A wall plate carries no person, and a reference photograph
containing a minor creates a consent question that a wall does not need to
raise.

**A design consequence worth naming.** Six rooms photographed inside one real
building makes "no two rooms feel alike" harder, not easier -- the brick is the
same brick. The distinction has to come from framing, light, material choice
and what is on the wall, rather than from six different buildings. That is a
constraint on Mode A, not an argument against it: a real place that reads as
six rooms is worth more than six stock rooms that read as nowhere.

**Page DNA, not only room DNA.** Pages inside the same room should not feel
identical either. This is why the office needs more than one wall across its
40 routes, and it is a Mode A question before it is a delivery one.

### Freedom of traverse (owner decision, 2026-08-20)

Grok reads whatever it needs. The repository is public; nothing in it is
off limits to reading, and a lane that can only see two files scopes its work
from a keyhole.

Two files remain **required** reading before an order, because they are the
law rather than context: `design-system/ppbf.css` and
`apps/web/public/plates/README.md`. Everything else is open, and these are
worth the time:

- `docs/visual-inventory/00-GROK-ORDER-BRIEF.md` -- the compiled order list,
  ranked, with counts measured rather than estimated
- `docs/visual-inventory/01-image-files.md` -- every committed image, its real
  bytes, and which are in this lane
- `docs/visual-inventory/02-css-drawn.md` -- the 110 constructs the sheet draws
  itself, split into leave-alone / photography-better / needs-art
- `docs/visual-inventory/03-glyphs-and-photos.md` -- the glyph set, and the
  twelve photograph slots that need a camera
- `docs/visual-inventory/04-room-coverage.md` -- routes per room, ranked
- `docs/shadow-ui/ROOM-PURPOSE-DNA.md` -- what each room is for

**Grok proposes work, it does not only fill orders.** If reading turns up a
defect or an opportunity the brief missed, say so. The 02a/02b mismatch below
was found by an audit, not by an order, and it is the most useful thing anyone
learned about these plates.

What does not loosen, and all of it is Mode B: a shipped **plate** is one file
carrying the exact ordered name; a shipped **change** is a feature branch and a
PR, never a direct push to `main`; and Grok never touches a drive outside its
own inbox.

Mode A carries none of that. Grok explores and mocks up freely, without waiting
to be handed a filename, because that is the whole point of Mode A. What stays
gated is not *writing* — that gate moved on 2026-08-22 — but **shipping without
owner approval and independent review**.

### Composition laws

- **Quiet centre.** Low detail where UI panels land; visual interest in the
  outer thirds and the top edge. A busy centre fights every panel edge placed
  on it.
- **Zero lettering.** No text, numbers, watermarks, UI chrome or stamps. A
  plate sits behind real text, cannot be translated, and is invisible to a
  screen reader.
- **One room's material only.** No mash-ups.
- **A set, not six prompts.** Variants come from a shared root reference so
  six images look like one building on one day.

### What Grok does not do

- push directly to `main` — nobody does; branch and PR
- change anything on the "may not change" list above without a separate
  owner-approved functional task
- implement a design Jason has not approved
- reorganise any drive — that is ChatGPT's lane
- reintroduce a `plates-v1g.css` override sheet — plate URLs are declared once,
  in the PLATES section of `ppbf.css`
- deliver base64, data URIs, or "copy the bytes out of chat"
- freestyle "improve all rooms" **when shipping** — a Mode B plate order is one
  file or one named set, and a Mode B code PR is one screen or one coherent
  small set. Mode A is deliberately unconstrained
- weaken a test to make a redesign fit

**On review timing.** The old contract said "Jason reviews on the live URL
only" and forbade mid-loop mock reviews. That was right when Grok could not
see code and a mockup review had nothing to check against. Under the 2026-08-22
model Jason approves a *design* before implementation begins, and still reviews
the *result* on the deployed page. Both, in that order — the approval gate is
what keeps Grok from building the wrong thing, and the live review is still the
only real visual verification that exists.

## The amendment: 4:4:4

Grok stated honestly that it **cannot guarantee 4:4:4** output, and assigned
Claude a re-encode step (`cjpeg -sample 1x1` or equivalent) to close the gap.

**Claude cannot do that either.** This sandbox has no `cjpeg`, no `djpeg`, no
`jpegtran`, no ImageMagick, no `ffmpeg` and no Pillow. Checked, not assumed.
A contract clause that depends on a tool nobody has is worse than no clause,
because both sides believe it is handled.

So the clause is replaced by one that works with what exists:

> **Claude verifies and refuses. Claude does not re-encode.**

**Grok accepted this on 20 Aug** and took 4:4:4 onto its own side: it
re-encodes in its own pipeline before the drop, and verifies SOI/EOI and
dimensions there. Settled before the first order rather than discovered
during one.

`apps/web/src/design/plateBinaries.test.ts` parses the SOF segment of every
committed plate in pure Node — no dependency — and fails the build on any
plate whose colour components are not all `1x1`. A subsampled plate is
rejected at the PR gate and sent back to whoever produced it, named for the
law it broke.

That is the better arrangement regardless of tooling: silently correcting a
bad input hides the fact that the producer's pipeline is wrong, and the next
file has the same problem. All 8 plates currently on `main` were measured
against this and are genuinely 4:4:4.

If a 4:2:0 file is ever the only thing available, converting it is Jason's
call and happens outside this repo, on a machine with the tools.

## The delivery paths

**Visual implementation (the 2026-08-22 model):**

```
Grok reads current source: page, components, tests
  → Grok names the real fields, actions and states
  → Mode A: alternatives, critique, iteration
  → Jason approves ONE direction
  → Grok branches, implements that direction, updates visual tests
  → Grok opens a PR — never a direct push to main
  → Claude reviews function and security; ChatGPT audits diff vs. claims
  → green CI on the exact head → merge → staging
  → Jason reviews on the live URL → release decision
```

**Plate binaries — the part that failed twice.** Unchanged, because the
failure modes were about bytes, not about lanes:

```
Jason orders one image (filename + room + size/variant note)
  → Grok generates
  → Grok re-encodes to 4:4:4, verifies SOI/EOI and dimensions
  → real .jpg binary lands in the agreed drop
  → picked up and PR'd — no re-encode, no chroma work
  → if a new variant name: one line in the PLATES section of ppbf.css
  → green CI → merge → staging → production
  → Jason reviews on the live URL
```

### The drop

```
OneDrive (admin@punxsyprominence.org)
  Documents / PPBF-AI-Lanes / Grok-Plates-Inbox /
```

Created and round-trip verified on 20 Aug: Claude can write to it, list it,
and read from it **by path**, so the folder can be polled by name on a
schedule rather than by tracking item ids. It carries its own
`READ-ME-FIRST.md` stating the laws, so the rules are legible to anyone who
opens the folder without having read this file.

One order, one file, named exactly as ordered. Nothing else belongs there --
no drafts, no variations to pick between, no notes. Anything else found in it
is reported rather than guessed at.

`PPBF-AI-Lanes/` is the parent for every lane hand-off, so the ChatGPT drive
lane gets a sibling folder rather than a second convention.

**Note for the drive reorganisation:** this folder is machine-read at a fixed
path. It can be moved, but moving it silently breaks the pickup, so it is a
coordinated change and not a tidy-up.

### Claude's gate refuses

A file is sent back, named for the law it broke, if it is:

- not 4:4:4
- truncated, or missing its end-of-image marker
- the wrong size or orientation for the name it arrived under
- base64, a data URI, or otherwise encoded through a chat channel

All four are enforced by `apps/web/src/design/plateBinaries.test.ts`, which
runs on every PR. The third is held to the **filename**, since that is the
only part of an order a test can read: a `-portrait-` name must be portrait,
every other plate must be landscape, and neither may be square -- square is
what an image model returns when an aspect instruction gets dropped.

**Never base64. Never a data URI. Never bytes pasted into a chat channel.**
If Grok cannot hand over a real file, Grok stops and says so, and a different
route is used. Two attempts have already failed this way: 11–41 byte stubs
from a relayed sidecar, and one file with a valid header, no end-of-image
marker, and the wrong dimensions.

Variant selection must be **deterministic** — derived from the route — never
random. A screen that changes appearance between loads breaks screenshot
comparison, print reproducibility, and a coach's sense that they are on the
page they were on a moment ago.

**This is built, as of #541.** `apps/web/components/plateVariant.ts` hashes the
pathname and emits a token list (`2of2 1of3 4of4 …`);
`apps/web/components/PlateVariantGround.tsx` writes it onto a `display:contents`
ancestor in the root layout so every room can read it. The sheet states how
many plates a room has; the hash picks the slot. `plateVariant.test.ts` fails
the build if `Math.random`, `Date`, a counter or a session id ever appears in
that path. Earlier revisions of this contract and of
`docs/visual-inventory/` said no such mechanism existed — that was true when
written and is now false.

**The limit of what #541 provides, stated so nobody overclaims it.** It gives
deterministic route → *slot* selection. It does **not** give route →
*specifically named plate* assignment. The attribute carries slot tokens only
and no route identity, so a rule can say "whichever office doors land in slot
2-of-2 take `plate-01-office-02.jpg`" and cannot say "`/coach/session-scripts`
takes the chalkboard wall." Which plate a route receives is decided by the
hash, not by intent — deliberately: `plateVariant.ts` states that nothing in
it "changes, ever, for art."

So a brief asking for a **named** wall on a **named** route needs either a new
mechanism or a room reassignment. Establish which before ordering the plate;
neither is a one-line change, and discovering it after the file arrives wastes
the order.

## Current state, so nothing finished gets redone

- 8 real plates on `main` at 1280×720 landscape / 405×720 portrait, all
  verified 4:4:4
- the PLATES block in `ppbf.css` already points at `.jpg`
- base `.room` + `::before` (light) + `::after` (plate) already correct — the
  defect where a page carried only the modifier was fixed in #498
- the zero-asset fallback is correct and load-bearing: a room renders from
  gradients alone with no network
- every room sits at variant `-01`; the `-0N` slot is open and unused

**Grok stays parked until Jason issues a specific image order.**

Tagline: **OBSERVE. DECIDE. EXECUTE. REPEAT.**

# Grok visual lane

**Agreed 20 Aug 2026.** Authored by Grok, amended once by Claude on a point
Grok could not check from outside the sandbox. Live contract — if the repo and
this document disagree, the repo wins and this document is wrong.

## The three lanes

| Lane | Owns | Never touches |
|---|---|---|
| **ChatGPT** | SharePoint, OneDrive, Google Drive taxonomy | the repository, image generation |
| **Grok** | image files | the repository, drive reorganisation |
| **Claude** | code, wiring, PR, staging, production dispatch | drive taxonomy, image generation |

Nobody pushes to `main`. Everything lands by PR with green CI, including
Claude's own work. This is not a hierarchy — it is the rule in
`AGENT_KERNEL.md`, and it exists because nine direct-to-main pushes from a
secondary channel destroyed `apps/web/package.json` on 19 Aug and left `main`
unable to build, test, or migrate.

## What Grok produces

Real JPEG wall plates, **layer 0 only**: the photographed wall a room stands
in. Real UI composites on top in code.

Grok re-reads these two files before every order rather than working from a
summary of them:

1. `design-system/ppbf.css` — rooms, materials, lamp laws, colour tokens, the
   PLATES block
2. `apps/web/public/plates/README.md` — format, quiet centre, layer-0 rule,
   the delivery failures, variant rules

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

**Grok may now propose orders, not only fill them.** If reading turns up a
defect or an opportunity the brief missed, say so. The 02a/02b mismatch below
was found by an audit, not by an order, and it is the most useful thing anyone
learned about these plates.

What does not loosen: Grok still delivers one file per order, still never
pushes, still never touches a drive outside its inbox, and still waits for
Jason to name an order before generating. Reading widely is not authority to
act widely.

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

- push to GitHub — nobody does
- reorganise any drive — that is ChatGPT's lane
- reintroduce a `plates-v1g.css` override sheet — plate URLs are declared once,
  in the PLATES section of `ppbf.css`
- deliver base64, data URIs, or "copy the bytes out of chat"
- freestyle "improve all rooms" — one order is one file, or one named set
- ask for mid-loop mock reviews — Jason reviews on the live URL only

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

## The delivery path — the part that failed twice

```
Jason orders one image (filename + room + size/variant note)
  → Grok generates
  → Grok re-encodes to 4:4:4, verifies SOI/EOI and dimensions
  → real .jpg binary lands in the agreed drop
  → Claude verifies and PRs -- no re-encode, no chroma work
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

Variant selection, when more than one plate per room is ever wired, must be
**deterministic** — derived from the route — never random. A screen that
changes appearance between loads breaks screenshot comparison, print
reproducibility, and a coach's sense that they are on the page they were on a
moment ago.

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

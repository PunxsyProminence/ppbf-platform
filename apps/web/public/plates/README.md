# Background plates

Layer 0 only: the photographed wall a room stands in. Real UI composites on
top in code; no plate carries lettering or substitutes for a stamp, ticket, or
passbook content. A plate is a `background-image` layer on `.room::after` /
`.on-canvas::after` — never an `<img>`. Missing files are safe by design: with
this directory empty, the gradient wall in `design-system/ppbf.css` renders
every room with no network.

## Installed set — declared, and therefore live

Every row below is a plate the sheet actually points at. `plateBinaries.test.ts`
requires each of these to exist on disk; it does **not** require the reverse, so
the second table is legal and simply unpainted.

| File | Applied to | Dimensions | Bytes |
|---|---|---|---|
| `plate-01-office-01.jpg` | `.room--office` | 1280×720 | 148,739 |
| `plate-02a-floor-landscape-01.jpg` | `.room--floor` | 1280×720 | 129,817 |
| `plate-02b-floor-portrait-01.jpg` | `.room--floor`, `@media (orientation: portrait)` | 405×720 | 43,945 |
| `plate-03-clinic-01.jpg` | `.room--clinic` | 1280×720 | 52,209 |
| `plate-04-board-01.jpg` | `.room--board` | 1280×720 | 72,943 |
| `plate-05-file-01.jpg` | `.room--file` | 1280×720 | 78,933 |
| `plate-06-night-01.jpg` | `.room--night` | 1280×720 | 46,687 |
| `plate-07-warm-ground-01.jpg` | `.on-canvas` (family surfaces only — T7) | 1280×720 | 39,150 |
| `plate-08-bell-gym-landscape-01.jpg` | `.ge-bell.on-canvas::after` (The Bell, /login) | 1280×720 | 189,771 |
| `plate-08-bell-gym-portrait-01.jpg` | `.ge-bell.on-canvas::after`, `@media (orientation: portrait)` | 810×1440 | 99,891 |

## Landed but not declared — inert until an owner picks one

These passed the byte gate and sit on disk. No CSS points at any of them, so no
route paints them and nothing 404s. Wiring one is a variant/room decision, and
it is one declaration in the PLATES block of `design-system/ppbf.css` — a
portrait variant goes inside the orientation block, per "Adding a variant" below.

| File | Dimensions | Bytes | What it would replace or add |
|---|---|---|---|
| `plate-01-office-portrait-01.jpg` | 810×1440 | 186,248 | a portrait crop the office room does not have today |
| `plate-02b-floor-portrait-02.jpg` | 810×1440 | 189,337 | a second portrait floor plate |
| `plate-02b-floor-portrait-ring-01.jpg` | 810×1440 | 82,185 | a ring-side portrait floor alternative |
| `plate-03-clinic-portrait-01.jpg` | 810×1440 | 119,124 | a portrait crop the clinic does not have today |
| `plate-04-board-portrait-01.jpg` | 810×1440 | 104,274 | a portrait crop the board room does not have today |
| `plate-05-file-portrait-01.jpg` | 810×1440 | 222,851 | a portrait crop the file room does not have today |
| `plate-06-night-02.jpg` | 1280×720 | 86,167 | a **second landscape** night plate — wiring it changes a merged, reviewed room |
| `plate-06-night-portrait-01.jpg` | 810×1440 | 80,048 | a portrait crop the night room does not have today |

## Requirements — enforced by `apps/web/src/design/plateBinaries.test.ts`

- Complete JPEG: start-of-image **and** end-of-image markers, and > 8 KB.
  (Truncated files and relay stubs pass header-only checks; this one doesn't.)
- **≤ 400 KB** per plate. The budget is per-plate: each route fetches only its
  own plate and it caches.
- **No chroma subsampling (4:4:4).** Dark leather and ink wells band under 4:2:0.
- Geometry is one of **1280×720 / 2560×1440** (landscape) or **405×720 /
  810×1440** (portrait); orientation must match the filename (`-portrait-` in
  the name means taller than wide; never square).
- Every `/plates/` URL declared in `design-system/ppbf.css` exists here.

Binary assets enter this repository **by a real `git add` of the actual file on
a feature branch, never re-encoded through a chat channel** (`AGENT_KERNEL.md`,
"Working channel"; `docs/GROK-VISUAL-LANE.md`).

## What counts as a delivery

One thing, and it is worth stating flatly because several rounds have now been
spent on things that resemble it: **a plate is delivered when its bytes are in
a commit on a branch.** `git show <sha>:apps/web/public/plates/<name>.jpg | wc
-c` prints a photograph's worth of bytes, or nothing was delivered.

None of these is a delivery, whatever the covering note says:

- a README, a manifest, or a table naming files that live somewhere else;
- a link, a folder path, or a zip in a drive;
- a base64 block, a data URI, or bytes pasted into a chat channel;
- a `.jpg`-named placeholder standing in for the real file.

The distinction is not pedantry and it is not a filing preference. Each of
those arrives looking like progress, closes a round, and leaves this directory
exactly as it was. The reason the byte gate above reads as fussy is that every
line of it was written after one of them got past a weaker check.

## Who ships the real JPEG (owner decision 2026-08-24, amended 2026-08-25)

**Grok owns the complete approved visual implementation path, including the
real JPEG wall-plate binaries.**

```
Jason approves plate/design
  → Grok generates the exact ordered asset
  → Grok prepares/verifies the actual JPEG
  → Grok uploads the REAL JPEG directly to its own feature branch
    under apps/web/public/plates/
  → Grok makes only the required approved visual/CSS/test changes
  → Grok opens the PR
  → Claude independently reviews function/security boundaries
  → ChatGPT independently audits PR scope, binary evidence, claims, SHA, CI
  → required CI green on the exact PR head
  → merge → staging
  → Jason live visual review
  → separate release decision
```

### Amendment, 2026-08-25 — the courier ban is lifted; the capability limit is not

Owner ruling, verbatim: *“the document that gets it live, accept the binary, is
correct.”* The blanket prohibition recorded below is therefore **superseded as
policy**. Where Jason directs it, Claude may accept a plate binary and land it
on a branch like any other file, and nobody has to argue about whose job it is.

**Policy was never what failed, though, and this is the part no document
recorded until now: Claude cannot retrieve bytes out of SharePoint or OneDrive
in this environment.** The Microsoft 365 connector *renders* an image for
viewing; it does not return file contents. There is no download action, no
unzip capability, and `downloadUrl` comes back null. A zip is not slow or
awkward from here — it is completely inaccessible.

That is a capability fact, checked rather than preferred, and it is written
down because leaving it unwritten is what allowed round after round of handoffs
to be authored against it. “Claude downloads the package from OneDrive and
commits it” is not a permission to grant or withhold. It cannot be executed, so
a handoff resting on it is not a slow route — it is a scheduled failure. Anyone
can still write that instruction; it will not run.

The routes that do exist:

- **Grok pushes the bytes** onto its own feature branch — the path above.
- **Jason pushes the bytes** — drag-and-drop onto the branch in the GitHub web
  UI, or a local `git add`. Two minutes, and it is the only route that has
  never failed.
- **Claude lands bytes it can actually read** — a file already in the working
  tree, in a commit, on a branch, or otherwise reachable from this sandbox.
  Directed by the owner, that is ordinary work and needs no ceremony.

**Superseded 2026-08-24 text, kept for provenance:** *“Retired: Grok → OneDrive
Grok-Plates-Inbox → Claude picks up / relays / commits the binary. Claude is
not the binary courier. Do not ask Claude to retrieve, reconstruct, re-encode,
or commit plate binaries on Grok's behalf.”*

Two clauses in that sentence outlived the ruling, for reasons that have nothing
to do with who carries a file. **Re-encode:** this sandbox has no `cjpeg`, no
`jpegtran`, no ImageMagick and no Pillow, so a subsampled or malformed plate is
refused and named for the law it broke rather than quietly corrected on the way
in — silently fixing a bad input hides that the producer's pipeline is wrong,
and the next file has the same fault. **Reconstruct:** an image rebuilt from a
rendering is a new picture, not the producer's approved file, and it would sail
through the byte gate while being the wrong plate.

The OneDrive folder `Documents / PPBF-AI-Lanes / Grok-Plates-Inbox /` may remain
for provenance/archive. It is not a shipping step, and it could never have been
one from this side.

## Why the byte gate reads the way it does — the delivery record

Recorded factually, because each requirement above is the fossil of a specific
failure and none of them makes sense without the thing it caught.

| What arrived | Under what name | What caught it |
|---|---|---|
| Three chat-channel relays of a base64 sidecar | correct plate filenames | sizes of **11, 24 and 41 bytes**. A stub carries a filename perfectly; only the size floor sees it. |
| One relay that looked plausible | correct plate filename | **2.3 KB**, a valid JPEG start-of-image marker, **no end-of-image trailer**, and the wrong dimensions. Every check short of reading the last two bytes said it was fine. |
| PR #643, `grok/plates-full-ship`, 2026-08-25 | — | **no binaries at all.** One Markdown manifest naming twelve JPEGs held in OneDrive, plus `_smoke_binary_test.jpg`: ten bytes reading `REPLACE_ME`. |

PR #643 is the one worth dwelling on, because it is not sloppy in the way the
earlier rounds were. Its manifest is accurate, its filenames are right, its
covering note is clear, and its `FUNCTIONAL_CHANGES: NONE` is true. It simply
contains no plates, and its “land command” asks Claude to download a package
this sandbox cannot reach. Both locations it names are dead ends:
`02_READY_FOR_CLAUDE/REPO-PLATES-SHIP/` is an empty folder (0 bytes), and the
only real package beside it, `REPO-PLATES-SHIP.zip` (1,569,483 bytes), is a zip
— unreadable from here whatever the policy says. A person following those
instructions by hand finds the empty folder too.

Its `_smoke_binary_test.jpg` also demonstrates why the gate globs *every*
`*.jpg` in this directory rather than a curated list: a ten-byte file named
like a plate is refused at the start-of-image check, which is exactly what
should happen to it.

## Adding a variant

The `-01` suffix is the variant slot. Selection is deterministic from the
route: `apps/web/components/PlateVariantGround.tsx` (one `display: contents`
marker in the root layout) hashes the route and writes
`data-plate-variant="2of2 1of3 …"`; the PLATES section of
`design-system/ppbf.css` states how many plates a room has. To add a second
office plate, drop `plate-01-office-02.jpg` here on a Grok feature branch and
add one rule to the route-derived variants block:

```css
:where([data-plate-variant~="2of2"]) .room--office {
  --plate: url("/plates/plate-01-office-02.jpg");
}
```

No TypeScript is edited. `apps/web/components/plateVariant.test.ts` fails a
variant rule that drops `:where()` (it must stay at specificity (0,1,0) so the
portrait override still wins) or that lands after the orientation block. A
portrait variant goes *inside* the orientation block, after its generic rule.

## Authoritative locations

- Plate URLs and all plate styling: **PLATES section of
  `design-system/ppbf.css`** — the single source of truth; no override sheets.
- Byte gate: `apps/web/src/design/plateBinaries.test.ts` (do not weaken)
- Variant-rule gate: `apps/web/components/plateVariant.test.ts`
- T7 (family surfaces take the warm plate or none):
  `apps/web/components/familyPlateGround.test.ts`
- Producer contract: `docs/GROK-VISUAL-LANE.md`

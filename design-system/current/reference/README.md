# The approved coach floor board, and what is actually built

`coach-floor-board-approved-options-a-b.webp` is the approved visual pair, kept
here because for two days it existed only as an image in a chat thread. That is
the whole reason this folder exists: the code was built from somebody's reading
of a picture nobody could open from the repo, it drifted four separate ways, and
every one of those drifts was caught by the owner looking at a screenshot rather
than by anything in this project.

The image is a capture of the approving conversation, browser chrome and all. It
is deliberately not cropped: the crop would be a new artifact nobody approved.

## What was approved

Two compositions, both hanging on a **matte black chalkboard-painted wall**.
The owner's words: *"our gym has black chalk board paint walls, can we make it
so that the coach can toggle between the two"*, and then, after an earlier pass
spread chalkboard across the whole interface, the correction that narrowed it:
*"I only wanted th backround wall black like a chalk board."*

**The wall is the chalkboard. The interface is not.**

- **OPTION A — one board.** A rough timber-framed control board mounted on that
  wall, carrying the instruments as mounted enamel plates.
- **OPTION B — the room is the interface.** No enclosing frame. The objects hang
  on the wall in their own right.

`BOARD` and `ROOM` in the layout toggle are these two.

## The object inventory

The useful test, and it is better than any "no rectangles" law: **strip the
label off — would a coach still recognise what physical object this is?** A
clipboard may be rectangular, because a real one is. What it may not be is a
third of a dashboard row wearing the word "clipboard".

| Object | State | Note |
|---|---|---|
| Wall | built | Block-built, running bond, matte black. Generated tile, `apps/web/public/textures/`. |
| Layout toggle | built | BOARD / ROOM. |
| Nameplate | built | Enamel sign: name, painted red rule, motto on the same plate. |
| Wall clock | built | Cream dial, dark rim and figures. Four states; UNKNOWN never renders as "no session". |
| Attendance sign | built | Light board, dark header band, four painted tags hanging on a rail. |
| Clipboards ×3 | built | Hardboard backing, paper, protruding steel clip. Shadow queue is a thicker stack. Three widths, three heights — never three equal shares of a row. |
| Next up plate | built | Reads the scheduler. Three states, because the read has three. |
| PROMINENCE plate | **not built** | Pure styling. No blocker. |
| ADAPT AND OVERCOME banner | **not built** | Pure styling. No blocker. The motto already exists as copy. |
| Bell + `BELL IN` | **not built** | **Blocked on data.** `CoachLiveRun` carries no round, interval or block. A countdown drawn from nothing is a lie with a timer on it. |
| `ROUND n of m` | **not built** | **Blocked on data.** Same reason. |
| TODAY'S SESSION whiteboard | **not built** | **Blocked twice.** `workoutBlocks` is a hardcoded template keyed to session mode, not today's scheduled session, and there is no current-block marker. It was also deliberately deleted once — see `CoachWorkspace.tsx`, "the board's instrument already states the session". Rebuilding it is an owner decision, not a correction. |
| Stretching poster | **not built** | Would mean inventing a stretching chart. |

## What this reference does NOT license

The image is a photograph of a physical wall, with perspective, real lighting and
the surrounding room. A browser page can match its **composition, materials,
colour, hierarchy and object language**. It cannot become the photograph, and
chasing that is how time gets spent without the screen improving.

## The drifts this file exists to prevent

All four shipped, all four were caught by eye:

- **A** — the backdrop was `plate-09`, a photograph of the gym floor. With the
  objects placed on it, a peg board sat on a photograph of a peg board.
- **B** — the chalkboard treatment migrated into the interface: slate face,
  chalk dust, a "chalk underline drawn with the side of the stick".
- **C** — ROOM rendered inside OPTION A's frame, so it was never Option B at
  all; it was the board with different things inside it.
- **D** — the room's objects carried physical names and panel geometry: a
  four-column grid of cards called a peg board, an auto-fit column grid called
  clipboards.

Nothing here is enforced. `apps/web/e2e/coach-room-ink.spec.ts` measures contrast
and catches unreadable ink; **no check catches "this does not look like the
approved design"**, which is why the owner had to catch all four.

# REAL GYM REFERENCE LOCK
**Status:** LOCKED 2026-08-24 · Owner: Jason Neale · Lane: Grok visual  
**Purpose:** Prevent environmental drift. Every Golden Era plate, mockup, and page must derive from **this gym**, not a stock boxing gym.

> If a future session cannot see conversation history, this file + the owner-supplied photos are the environmental authority.

**AMENDED 2026-09-26 by owner decision ("let's fix it").** Jason supplied ten
photographs of the building for the first time, and they disprove several rows of
the 2026-08-24 DNA table. Those rows are corrected below and the correction is
marked `[PHOTO 2026-09-26]`. Rows the photographs confirm are marked
`[CONFIRMED 2026-09-26]` — including the ring canvas, which had been called stale
in a Claude session earlier the same day and was not.

The amendment exists because the correction had been written into a generator
script instead of into this file, which would have left the repository holding two
different descriptions of the same gym. That was caught in ChatGPT's standards
review of PR #982. The environmental authority is this document; tooling follows
it and does not supersede it privately.

---

## 1. The place

**Punxsy Prominence Boxing & Fitness**  
Real address / building already known to the owner.  
Working name in DNA: **Iron City** (ring canvas branding: **IRON CITY BREWERY**).

This is a lived-in, rustic, nonprofit training space — **not** a polished commercial boxing club, not a grey-brick stock gym, not a cinematic set.

---

## 2. Locked visual DNA (must appear in plates & backgrounds)

| Element | Required character |
|---------|--------------------|
| **Ring canvas** | Teal / pale blue-green with a faded **red-and-white circular brewery roundel** printed across it; teal apron skirt. `[CONFIRMED 2026-09-26]` |
| **Ring corners** | **Red and blue corner posts**, each with a plain **white pad hanging across the front** of it. Dark ropes lashed to the posts with **red cord**. `[PHOTO 2026-09-26 — new row]` |
| **Ceiling** | **LOW and PALE**: white-painted plank, and a **white coffered drop ceiling with square recessed light panels**; surface-mounted fluorescent battens below. Rough timber beams where the structure shows. `[PHOTO 2026-09-26 — supersedes "blue foam insulation pads / gray plywood with white X"]` |
| **Floors** | **PAINTED AND ZONED**, and the single most distinctive thing about the place: **red** at the ring, **blue** with pale tape grid lines on the mat floor, **grey** with white floor markings at the cardio end, **green carpet** in the locker area. `[PHOTO 2026-09-26 — new row; the 2026-08-24 table had no floor row at all]` |
| **Structure** | Rough sawn timber posts and beams. The bags hang from **things somebody built**: a heavy pressure-treated **timber post-and-beam frame** standing on the floor with steel brackets, and a **black steel scaffold-pipe rail** braced to the wall with timber. `[PHOTO 2026-09-26 — expanded; bags do not hang from ceiling chains]` |
| **Bags** | A **mixed set, not a matching one**: black Everlast and PowerCore, a **white canvas** one, a **navy blue** Everlast with white hexagons, black-and-red Ringside and Everlast. Worn, taped, scuffed. Speed bags, a teardrop bag. `[PHOTO 2026-09-26 — supersedes "red heavy bag" as the named example; see OPEN below]` |
| **Walls** | **Honey-coloured reclaimed wood plank** over most of the building; **BLACKBOARD-PAINT walls** — the wall itself is the chalkboard, written on directly, including a black painted band at chest height carrying chalked combination numbers; pale grey painted block; **red painted accent walls** and red trim posts; wood-framed mirrors, some carrying small handwritten notes. `[PHOTO 2026-09-26]` |
| **Light** | Fluorescent battens doing all the work — flat, uneven, slightly green — plus daylight from shuttered windows. Never cinematic. `[PHOTO 2026-09-26. The 2026-08-24 "red LED accents" are NOT visible in this photo set; not deleted, marked UNCONFIRMED.]` |
| **Extras** | 3rd Infantry Division banner, fight posters (De La Hoya vs Mayweather), framed coaching certificates and medals, American flag on plank, **grey lockers with one bank of red ones**, wire shelving of mixed-colour gloves with sticky-note size labels, whiteboards of handwritten sessions, water cooler with blue jugs, exercise balls stored on top of the lockers, treadmills and an elliptical, a big floor fan, an old patterned armchair. `[PHOTO 2026-09-26]` |
| **Atmosphere** | Lived-in, slightly chaotic, functional, nonprofit gym energy. `[CONFIRMED 2026-09-26]` |

**OPEN — the blue bag.** On 2026-09-26 Jason instructed "take the blue heavy bag
out". Photographs 01 and 02, supplied later the same day, both show a navy blue
Everlast bag hanging in the row. The instruction and the photographs disagree and
the question was put to him and not yet answered. The table records what the
photographs show. Resolve before treating either as settled.

**Forbidden (causes drift):**
- Generic grey-brown brick + caged industrial lamps as the default wall
- Stock polished commercial boxing gym
- Fictional logos, trophies, or athletes
- Clean empty white studio walls
- Pure leather-and-brass set with no Iron City DNA

---

## 3. How Grok (and any future session) must use this

### Mode A (design / mockups)
1. Always pass **at least 2–4 of the owner reference photos** into the image model when generating page mockups or new plate concepts. **The photographs live at `C:\Users\jason\PPBF-Gym-Reference\` on Jason's machine** (owner decision 2026-09-26: "where is it at now use it"). Ten frames, named for what they show. They are deliberately NOT committed — faces and minors — and that has not changed.
2. Prompt must name the DNA in section 2 above: the brewery-roundel ring with red and blue posts and white pads, honey plank and blackboard-paint walls, the painted red / blue / grey floor zones, the homemade timber and pipe bag frames, flat fluorescent light.
3. Quiet centre for UI; real gym interest only in outer thirds / edges.
4. Zero lettering on the plate itself (UI text lives in code).

### Mode B (shipped plates)
1. Plates are layer-0 only (the wall the room stands in).
2. One building, one day — variants share a root reference derived from these photos.
3. Real JPEG binaries only; 4:4:4; complete SOI **and** EOI; >8 KB and ≤400 KB; 1280×720 / 2560×1440 landscape or 405×720 / 810×1440 portrait; quiet centre; orientation matches filename. `apps/web/src/design/plateBinaries.test.ts` enforces all of it on the bytes.
4. **Anyone may produce a plate; the plate is judged, not its author.** Owner decision 2026-09-26, asked who owns plate production now: *"anyone that makes a good one"*. This supersedes the 2026-08-24 arrangement in which Grok alone generated and uploaded. The producer places the binaries on their own feature branch, and **a delivery is a real `git add` of the actual file** — never base64, never a link or manifest, never a zip in a drive.

   Two things are unchanged by that decision, because they are what "a good one" means: the plate passes `plateBinaries.test.ts` on its bytes, AND somebody has **opened the image and looked at it** against section 2. The byte gate cannot tell whether the room is this gym. On 2026-09-26 two plates were bound to a room by filename without being opened; both turned out to be the generic brick wall this document forbids.
5. **If Grok's tooling cannot push a binary, Jason drag-drops the JPEGs onto the branch.** Owner ruling 2026-08-25 lifted the ban on Claude carrying a binary — it may accept and land one where directed — but Claude **cannot retrieve bytes from SharePoint or OneDrive** at all: the connector renders an image rather than returning file contents, `downloadUrl` is null, and a zip is inaccessible. That is a capability limit, not a rule, so a handoff that depends on it fails by construction. Superseded wording, kept for provenance: the 2026-08-24 line read *“No base64, no Claude/Copilot courier.”*

### Code / theme
1. `design-system/current/ppbf-theme.css` is the seam; Golden Era materials (paper/brass/leather) sit **on** the real-gym plate.
2. Never reintroduce stock-gym gradients or fake brick as the rendered authority.

---

## 4. Owner photo archive (source of truth)

Photos live with the owner and in Grok conversation assets (UUIDs below are the 2026-08-24 lock set).  
**Do not commit the full-resolution personal photos into the public repo** (faces, minors risk, size).  
**Do** keep a short inventory here so any session knows what “the real gym” means.

### Primary lock set (2026-08-24)

| Asset / filename | What it locks |
|------------------|---------------|
| `1551b986-…` / ring low-angle | Teal IRON CITY BREWERY canvas, ropes, gloves hanging |
| `b8a40254-…` / bags upward | Blue foam ceiling, Everlast/Powercore bags, fluorescent |
| `a8a19b05-…` / mirror wall | Wood-framed mirror, heavy bag, American flag, gloves |
| `dca611e2-…` / red bag + kitchenette | Red bag, blue foam, handwritten signs, lived-in |
| `7f806b26-…` / inverted ring | KO NATION mat, wood beams, lockers |
| `fda088cd-…` / glove shelves | Gear density, sticky notes, red LED, wood |
| `3ad15fdd-…` / Sting gloves | White gloves, Everlast bags, pallet, storage |
| `eef09352-…` / chalkboard gym | Chalkboard logs, power rack, low gray ceiling |
| `f44ff562-…` / 3rd Infantry banner | Banner + certificates wall |
| `41d9ebde-…` / inverted pull-up | Ceiling X, red platform, workout signs |
| `fe39f443-…` / lockers overhead | Metal lockers, green carpet, lived-in gear |
| `5dd2a321-…` / Rocky + speed bag | Rocky poster, Everlast speed bag, fight poster |

When Jason re-uploads or adds photos, append to this table; do not delete the lock set.

**Optional archive (never a shipping dependency):**  
OneDrive `Documents/PPBF-AI-Lanes/Grok-Plates-Inbox/` and/or a Drive folder owned by Jason for full-resolution masters. A master parked in a drive is an archive copy of a delivery; the delivery is the commit on the branch, and no AI lane here can pull those bytes back out of the drive.

---

## 5. Room mapping (how DNA is framed, not invented)

| Room | Framing of the *same* gym |
|------|---------------------------|
| **Floor** | Open bags + ring edge + fluorescent, high energy |
| **Office** | Quieter wood wall / mirror / certificates corner, desk-lamp feel |
| **Board** | Formal quiet — chalkboard / certificates wall, lower chrome |
| **File** | Gear shelves / sticky-note tagged storage density |
| **Clinic** | Cleaner corner, cooler light, less bag drama |
| **Night** | Darker, low lamp, bags as silhouettes, telemetry quiet |

Same building. Different framing and light. That is Page DNA + Room DNA.

---

## 6. Drift test (run before any Mode B ship)

Ask of every plate / mockup:
1. Would Jason recognise this as *his* gym?
2. Is the Iron City / blue-foam / rough-wood / bag DNA visible in the outer thirds?
3. Did we accidentally re-introduce stock grey brick or polished commercial gym?
4. Are faces / minors absent from the plate layer?

If any answer is wrong → regenerate from the lock-set photos before shipping.

---

## 7. Change control

- This file is amended only by owner decision or Grok visual PR.
- Claude does not re-interpret the gym look.
- ChatGPT audits that new visual PRs still cite this lock.

**Tagline:** OBSERVE. DECIDE. EXECUTE. REPEAT.  
**Environmental rule:** The real gym is the plate. Golden Era is the furniture on top of it.

— Grok visual lane, 2026-08-24

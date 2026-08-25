# REAL GYM REFERENCE LOCK
**Status:** LOCKED 2026-08-24 · Owner: Jason Neale · Lane: Grok visual  
**Purpose:** Prevent environmental drift. Every Golden Era plate, mockup, and page must derive from **this gym**, not a stock boxing gym.

> If a future Grok session cannot see conversation history, this file + the owner-supplied photos are the environmental authority.

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
| **Ring canvas** | Teal / blue-green mat with **IRON CITY BREWERY** red-and-white circular logo; KO NATION / related lettering on mat |
| **Ceiling** | Blue foam insulation pads and/or gray plywood with white X; low, functional |
| **Structure** | Rough wood beams, posts, A-frames, wooden platforms, exposed framing |
| **Bags** | Everlast, Powercore, red heavy bag, black heavy bags, speed bags, white Sting gloves |
| **Walls** | Gray concrete / painted, wood paneling, wood-framed mirrors, chalkboards with handwritten workout notes |
| **Light** | Fluorescent tubes + red LED accents + natural window light — harsh/uneven, real |
| **Extras** | 3rd Infantry Division banner, Rocky poster, fight posters (De La Hoya vs Mayweather era), American flag, metal lockers, handwritten signs ("5 Squats…"), gear shelves with sticky-note tagged gloves |
| **Atmosphere** | Lived-in, slightly chaotic, functional, nonprofit gym energy |

**Forbidden (causes drift):**
- Generic grey-brown brick + caged industrial lamps as the default wall
- Stock polished commercial boxing gym
- Fictional logos, trophies, or athletes
- Clean empty white studio walls
- Pure leather-and-brass set with no Iron City DNA

---

## 3. How Grok (and any future session) must use this

### Mode A (design / mockups)
1. Always pass **at least 2–4 of the owner reference photos** into `imagine_reference_to_image` (or equivalent) when generating page mockups or new plate concepts.
2. Prompt must name: Iron City Brewery ring DNA, blue foam ceiling, rough wood, hanging bags, lived-in light.
3. Quiet centre for UI; real gym interest only in outer thirds / edges.
4. Zero lettering on the plate itself (UI text lives in code).

### Mode B (shipped plates)
1. Plates are layer-0 only (the wall the room stands in).
2. One building, one day — variants share a root reference derived from these photos.
3. Real JPEG binaries only; 4:4:4; complete SOI **and** EOI; >8 KB and ≤400 KB; 1280×720 / 2560×1440 landscape or 405×720 / 810×1440 portrait; quiet centre; orientation matches filename. `apps/web/src/design/plateBinaries.test.ts` enforces all of it on the bytes.
4. Grok places the binaries on its own feature branch. **A delivery is a real `git add` of the actual file** — never base64, never a link or manifest, never a zip in a drive.
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

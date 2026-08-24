# GOLDEN ERA V1 — Real-Gym Visual Contract
**Version:** 1.1 · **Date:** 2026-08-24 · **Author:** Grok (visual lane) · **Owner:** Jason Neale  
**Status:** Active authority for the usable-app visual release.  
**Sibling law:** `docs/GROK-VISUAL-LANE.md` (process) · this file (look & feel) · `docs/REAL-GYM-REFERENCE-LOCK.md` (environmental DNA)

> This document is the durable visual authority.  
> A future Grok session must be able to reproduce the approved direction from this file alone.  
> Conversation history is not required and must not be the source of truth.

---

## 1. Identity statement

When Jason opens the app it must be unmistakably:

1. **Punxsy Prominence** (the real nonprofit)
2. **The real Punxsy Prominence gym** (220 N Jefferson St reference material already supplied)
3. **Golden Era interface** (the approved paper / brass / leather / iron-city feel)
4. **Real current PPBF functions** (no invented buttons, roles, or data)

It must **not** look like:
- generic SaaS
- the retired Leather & Brass sheet as the dominant rendered authority
- an AI mockup or design-board gallery
- a fictional boxing gym
- a partially converted prototype

---

## 2. Authority order (non-negotiable)

| Rank | Authority | Source |
|------|-----------|--------|
| 1 | Functional | Current `main` source + real APIs |
| 2 | Visual | This contract + Jason-approved Golden Era |
| 3 | Environmental | **`docs/REAL-GYM-REFERENCE-LOCK.md`** + owner photos |
| 4 | Owner | Jason’s explicit choices override earlier mockups |

If a design board shows something with no real backend: **omit it**, adapt the composition around the real function, or report it as a future functional requirement. Never fake it.

---

## 3. Real-gym environmental truth

**Full lock:** `docs/REAL-GYM-REFERENCE-LOCK.md`  
That file is the permanent environmental authority. Summary only below.

The actual gym is the reference, not a stock template.

**Locked DNA (must appear):**
- Iron City Brewery teal ring canvas + red/white circular logo
- Blue foam ceiling pads / gray plywood
- Rough wood beams, posts, A-frames
- Everlast / Powercore / red bags / speed bags / Sting gloves
- Wood-framed mirrors, chalkboards, handwritten workout signs
- 3rd Infantry banner, Rocky + fight posters, American flag, lockers
- Fluorescent + red LED + natural light — lived-in, rustic, nonprofit

**Forbidden (causes drift):**
- Generic grey-brown brick + caged industrial lamps as default
- Stock polished commercial boxing gym
- Fictional logos, trophies, athletes, faces of minors

**Use for:** spatial character, material roughness, lighting, signage, photographic texture.  
**Do not fabricate** rooms, equipment, architecture, or claims that do not exist.

Stylization is allowed. Fabrication of real-world facts is not.  
The interface does not need to literally recreate every physical wall; it must feel *derived from this gym*.

**Drift test before every Mode B ship:** Would Jason recognise this as *his* gym? Is Iron City / blue-foam / rough-wood / bag DNA visible in the outer thirds?

---

## 4. Golden Era material & surface hierarchy

Golden Era is the **rendered visual authority**. The old Leather & Brass sheet is retired as the look. The theme seam (`design-system/current/ppbf-theme.css`) is the single place the look is swapped; foundation stays intact.

### Core materials (in priority order of presence)
1. **Paper** — primary working surface (forms, cards, lists, notices). Warm bone / cream, slight grain, torn-note edges allowed only as deliberate chrome.
2. **Brass** — accents, rivets, stamp edges, primary action metal, status rings. Never pure chrome; always aged/warm.
3. **Leather** — secondary cards, coach notebooks, binding, empty-state pads. Dark brown / oxblood, not black patent.
4. **Iron / industrial** — structural frames, kiosk rails, night telemetry. Matte, worn.
5. **Wood / plank** — office and board wainscot / desk feel (not over-used).
6. **Cork / file** — file-room only.
7. **Varnished cabinetry + cooler green tint** — clinic only.

### Surface rules
- Cards and panels sit *on* the room (paper/leather on the wall plate), never fight the plate.
- Quiet centre of every plate; UI panels land in the quiet zone.
- Text over photographs or textured grounds must remain readable (overlay or material treatment required). Jason has already caught unreadable text that tests missed — treat contrast as first-class.
- No skeuomorphic “room-*” classes beyond the six declared rooms. No new invented materials without owner approval.

---

## 5. Page DNA (locked 2026-08-24)

**Every page has its own feel.**  
It still **flows** from the previous page (same building, same day, same Golden Era chassis, same Iron City DNA).  
But it is **distinct** — different framing of the wall, different light temperature, different density of material interest, different chrome density, different voice of the cards, different quiet/active balance.

Same room ≠ same atmosphere.  
A coach floor-group page and a session-script delivery page both sit in `.room--floor`, yet one can feel like the open gym floor under bags while the other feels like the corner desk with a chalkboard edge and tighter light.

**Rule of thumb when designing any screen:**  
1. Which room does it belong to?  
2. What makes *this specific page* feel different from its siblings in that room?  
3. How does it still belong to the continuous building story?

---

## 6. Room Purpose DNA (summary — full law in `docs/shadow-ui/ROOM-PURPOSE-DNA.md`)

| Room | Purpose feel | Allowed chrome | Forbidden |
|------|--------------|----------------|-----------|
| **Office** | Quieter wood / mirror / certificates corner, desk-lamp | Notices, chalk, roster badges | Clinic green, night telemetry, floor drama |
| **Floor** | Open bags + ring edge + fluorescent, high energy | Chalk, WordsOnTheWall, CLEARED badges | Board tables, file cork, clinic red theater |
| **Board** | Formal quiet — chalkboard / certificates wall | Count tiles, PLANNED tabs | Chat, athlete detail, eggs |
| **File** | Gear shelves / sticky-note tagged storage density | Queues, Observation→Lesson columns | Hype, eggs |
| **Clinic** | Cleaner corner, cooler light, less bag drama | Brass Training Hold, red only for critical medical/safety | Wall sayings, “tough it out” eggs |
| **Night** | Darker, low lamp, bags as silhouettes | Mode labels only (Scout / Architect / Omega) | Board chrome on deny, Master Mode toggle |

Easter eggs: primary home is Floor. Never on Board, File, Clinic, Night (deny).

---

## 7. Safety colour contract (hard owner decision)

| Token / colour | Meaning | Never use for |
|----------------|---------|---------------|
| `#A81E22` / `--locked` | **MEDICALLY_NOT_ALLOWED only** | Ordinary network failures, loading, empty, form rejection, generic overdue, normal validation, ordinary destructive buttons, generic unavailable |
| Restricted | Visually distinct from Locked | — |
| Destructive action | Separate destructive semantic treatment | Medical locked red |

If you encounter `--stamp-restricted: var(--locked)`, treat it as existing semantic debt, not design authority. Do not reinterpret medical/safeguarding logic. (Claude’s safeguarding-red-guard owns the CI enforcement; Grok does not touch those three reserved files.)

---

## 8. Typography hierarchy

Keep the six established voices (do not invent new families without owner approval):

- **Alfa Slab One** — command / page title (sparingly)
- **Oswald** — section / rail / tab labels
- **Inter** — body, supporting copy, forms
- **Special Elite** — data / numeric / ledger
- **Caveat** — chalk / informal wall notes (Floor only)
- **UnifrakturCook** — rare seal / formal marks only

Data and numeric values use Special Elite so they never look like marketing copy.  
Unknown / missing values must look **unknown**, never zero or “normal complete”.

---

## 9. Photographic / plate rules

- Layer 0 only (the wall the room stands in). Real UI composites on top in code.
- Quiet centre, outer-thirds interest, zero lettering, 4:4:4, complete SOI/EOI, declared geometry, orientation matches filename.
- Variants from a shared root reference (one building, one day) derived from the Real Gym Reference Lock.
- Grok owns placing the real JPEG binaries directly on its feature branch. No base64, materializer, Claude/Copilot relay.
- `plateBinaries.test.ts` is the hard gate. Do not weaken it.

Exact producer set for the current Type B ship (leave office-01 and board-01 untouched unless separately ordered):

| File | Bytes | SHA-256 |
|------|------:|---------|
| plate-02a-floor-landscape-01.jpg | 128611 | 410022d6e7ddccfdd231ffbffc8b66de7df8001bc047253665070a35fd024c68 |
| plate-02b-floor-portrait-01.jpg | 44121 | b3828428a637f1b506f787f3ca1da290c4ed3f3bc3e045bc77a616d845aa2c65 |
| plate-03-clinic-01.jpg | 82644 | e2b4564a8f6a7c8f0ae0dbc3a57189ce58bb7465da017627cfb3ce08a3653cdb |
| plate-05-file-01.jpg | 178682 | 4cd52259c0a4ea4c8b468e28ad30211795fc4f10d43430d04bd0a86507ef465e |
| plate-06-night-01.jpg | 153920 | 9fe30999c4f13629700fc3674c02ffdbe6aaf497feec69df149959579976f448 |
| plate-07-warm-ground-01.jpg | 111648 | 44cf1db174f1a9045ae3da496e185f2b83636642e7d8ac21105a454a3d57d3b3 |

---

## 10. Responsive & accessibility principles

- **Phone** ~360–430 px · **Tablet** ~768–1024 px · **Desktop** ~1280 px+
- Do not merely shrink desktop. Re-order information hierarchy for the device.
- Touch targets respect foundation floors (44 px minimum, kiosk 55 px where Law 5 applies).
- Focus visible, keyboard complete, reduced-motion respected.
- Text over gym photos or textured grounds must remain AA readable. Overlay or material treatment is required when needed.
- Golden Era must never trade usability for atmosphere.

---

## 11. Common states (must be visually distinguishable)

LOADING · EMPTY · ERROR · SUCCESS · DISABLED · RESTRICTED · LOCKED · UNKNOWN · NOT AVAILABLE

- Do not make every state red.
- UNKNOWN / missing must never look complete or zero.
- LOCKED is only medical/not-allowed.
- RESTRICTED is distinct from LOCKED.

---

## 12. What not to invent today

Do not expand into: R19 measurement registry, coach-observation research, Research Archive → SHADOW bridge, CRM, donor, finance, new membership architecture, facility system, communications pipeline, competition integration, computer-vision scoring, Bell system, TV wall, voice notes, alumni wall, new achievement engine, major copywriting campaign, AI orchestration, automation control plane.

Today is: **real app + real gym + Golden Era + usable core workflows**.

---

## 13. Theme seam & foundation

```
design-system/
  foundation/     ← do not casually rewrite (spacing, focus, tap, reduced-motion, form geometry, print, SR helpers)
  current/
    ppbf-theme.css   ← THE SEAM. Currently still imports retired Leather & Brass.
                       Replace that import with the real Golden Era sheet.
  legacy/
    ppbf-leather-brass.css  ← retired as visual authority; may remain for alias mapping only
```

Where legacy token names still appear in markup, map them into Golden Era meaning rather than leaving old visual meaning active. Rendered truth matters more than a mechanical rename of every call site for this release.

---

## 14. Core journeys that must be usable today

- Sign-in / entry (no fake roles, no fictional branding)
- Public / family entry (trustworthy, real PPBF identity)
- Athlete workspace (truthful missing/unknown states; readiness ≠ session RPE)
- Coach workspace (glanceable, sweaty-hands, high information density)
- Coach → athlete detail (real permissions, provenance, safety semantics)
- Drill library (fast location, clear structure)
- Session scripts / running (sequence, blocks, start/continue/finish where real)
- Pain / safety presentation (no control that records nothing; pain never routed through readiness/RPE)
- SHADOW (first-class PPBF tool; no invented omniscience)
- High-use admin (people, organizations, PIN — real role vocabulary only)

---

## 15. Success standard (owner gate)

When Jason opens staging:

1. Is this clearly his actual PPBF product?
2. Does it visibly derive from his real gym?
3. Is Golden Era clearly the active interface?
4. Is Leather & Brass no longer the rendered visual authority?
5. Can he use the core gym workflows without visual confusion?
6. Are safety states honest?
7. Are unknown/missing states honest?
8. Is core text readable?
9. Does it work on the devices he will actually use?
10. Is remaining work polish rather than a reason he cannot begin using it?

If YES → ship the staging candidate for Jason’s live review.

---

## 16. Asset & plate manifest (pointer only)

- **Real-gym environmental lock:** `docs/REAL-GYM-REFERENCE-LOCK.md` (asset UUIDs + DNA table). Owner photos stay with Jason / conversation assets — full-res personal photos are not committed to the public repo.
- Shipped plates: `apps/web/public/plates/` (see §9 for exact producer set).
- Do not place binary images inside this Markdown or any JSON.
- Optional archive: OneDrive `Documents/PPBF-AI-Lanes/Grok-Plates-Inbox/` (provenance only, not a shipping dependency).

---

## 17. Change control

- This contract is amended only by owner decision or by a Grok PR that updates it as part of a visual release.
- Claude does not redesign this document’s visual decisions.
- ChatGPT audits claims against this contract and the actual PR diff.

Tagline remains: **OBSERVE. DECIDE. EXECUTE. REPEAT.**

— Grok visual lane, 2026-08-24 (v1.1 — real-gym lock linked)

# GOLDEN ERA V1 — the look as built (a description, not a limit)
**Version:** 1.1 · **Date:** 2026-08-24 · **Author:** Grok · **Owner:** Jason Neale  
**Status (OD-2026-10-02-004):** describes the look the app has today and why. It does not limit what the UI may become: nothing in the UI is tied down, and what binds UI work is the short list in `AGENT_KERNEL.md` "UI and visual work". Sections 7, 10 and 11 below restate items on that list; section 9 is the plate rule.  
**Amended 2026-09-28** (OD-2026-09-28-001, OD-2026-09-28-009): owner-first authority order (§2); §3 points to the lock; §8 records the fonts as built; §9 points to the plates README; §13 shows the seam as built; Claude places plate binaries. Later the same day, by owner decision: §4 adds dark glass as a panel material (OD-2026-09-28-014); §9 lets the ring canvas keep its IRON CITY lettering (OD-2026-09-28-013). **Amended 2026-09-29** (OD-2026-09-29-001): §6 and §7, red is not reserved; `--locked` still means a medical stop.  
**Related:** this file (look & feel) · `docs/REAL-GYM-REFERENCE-LOCK.md` (environmental DNA) · `docs/ROOM-MAP.md` (the planned rooms) · `design-system/README.md` (the checks that still bind) · `apps/web/public/plates/README.md` (plates)

> This document records the Golden Era direction so a future session can see what was built and why without the conversation history.  
> It is a starting point. A screen may depart from it whenever that makes the screen easier to use, better looking or more functional (OD-2026-10-02-004).

---

## 1. Identity statement

When Jason opens the app the aim is that it is unmistakably:

1. **Punxsy Prominence** (the real nonprofit)
2. **The real Punxsy Prominence gym** (220 N Jefferson St reference material already supplied)
3. **Golden Era interface** (the paper / brass / leather / iron-city feel, as it stands today)
4. **Real current PPBF functions** (no invented buttons, roles, or data)

It should not look like:
- generic SaaS
- the retired Leather & Brass sheet as the dominant rendered authority
- an AI mockup or design-board gallery
- a fictional boxing gym
- a partially converted prototype

---

## 2. Order of sources

| Rank | Authority | Source |
|------|-----------|--------|
| 1 | Owner | Jason’s decisions (`docs/current/OWNER_DECISIONS.md`) and explicit choices; they override this contract and earlier mockups |
| 2 | Functional | Current `main` source + real APIs |
| 3 | Visual | What Jason and the lane doing the work decide for the screen in hand; this document is the description of where the look started |
| 4 | Environmental | **`docs/REAL-GYM-REFERENCE-LOCK.md`** + owner photos |

If a design board shows something with no real backend: **omit it**, adapt the composition around the real function, or report it as a future functional requirement. Never fake it.

---

## 3. Real-gym environmental truth

**The lock:** `docs/REAL-GYM-REFERENCE-LOCK.md` is the environmental authority: its DNA, its forbidden list and its drift test are not restated here. (They were, and the copy drifted: this section still named blue foam ceiling pads after the owner's 2026-09-26 photographs replaced them.) Its DNA applies to training rooms; other rooms follow `docs/ROOM-MAP.md` (OD-2026-09-28-009).

The actual gym is the reference, not a stock template.

**Do not fabricate** rooms, equipment, architecture, or claims that do not exist.

Stylization is allowed. Fabrication of real-world facts is not.  
The interface does not need to literally recreate every physical wall; it must feel *derived from this gym*.

---

## 4. Golden Era material & surface hierarchy

Golden Era is the look the app renders today. The old Leather & Brass sheet is retired as the look. The theme seam (`design-system/current/ppbf-theme.css`) is the single place the look is swapped; foundation stays intact.

### Core materials (in priority order of presence)
1. **Paper** — primary working surface (forms, cards, lists, notices). Warm bone / cream, slight grain, torn-note edges allowed only as deliberate chrome.
2. **Brass** — accents, rivets, stamp edges, primary action metal, status rings. Never pure chrome; always aged/warm.
3. **Leather** — secondary cards, coach notebooks, binding, empty-state pads. Dark brown / oxblood, not black patent.
4. **Iron / industrial** — structural frames, kiosk rails, night telemetry. Matte, worn.
5. **Wood / plank** — office and board wainscot / desk feel (not over-used).
6. **Cork / file** — file-room only.
7. **Varnished cabinetry + cooler green tint** — clinic only.

### Dark glass (owner-approved 2026-09-28, OD-2026-09-28-014)
**Dark glass** — the dark translucent dashboard panels over the real gym in Jason's Grok board. Jason's words: *"its can use all types where appropriate"* (OD-2026-09-28-014): a panel may be aged paper, dark glass, or both, each where it fits. The core list above is otherwise unchanged; the answer did not rank the materials. Not built yet: no glass material exists in the `design-system/` sheets or `apps/web/app/globals.css` at `10da14c9`.

### How surfaces are built today
- Cards and panels sit *on* the room (aged paper, leather or dark glass on the wall plate).
- Plates keep a quiet centre and UI panels usually land there.
- Text over photographs or textured grounds must remain readable (overlay or material treatment required). Jason has already caught unreadable text that tests missed — treat contrast as first-class.
- Six rooms are declared in the CSS today, and the materials above are the ones built. A new room or material is a design choice for Jason and the lane, like any other UI change (OD-2026-10-02-004).

---

## 5. Page DNA (the idea, from 2026-08-24)

**Every page has its own feel.**  
It still **flows** from the previous page (same building, same day, same Golden Era chassis, same Iron City DNA).  
But it is **distinct** — different framing of the wall, different light temperature, different density of material interest, different chrome density, different voice of the cards, different quiet/active balance.

Same room ≠ same atmosphere.  
A coach floor-group page and a session-script delivery page both sit in `.room--floor`, yet one can feel like the open gym floor under bags while the other feels like the corner desk with a chalkboard edge and tighter light.

**Questions worth asking when designing a screen:**  
1. Which room does it belong to?  
2. What makes *this specific page* feel different from its siblings in that room?  
3. How does it still belong to the continuous building story?

---

## 6. Room Purpose DNA (summary of today's six rooms — the fuller description is `docs/shadow-ui/ROOM-PURPOSE-DNA.md`; the target rooms are `docs/ROOM-MAP.md`)

The last two columns are how each room was first drawn, not a limit (OD-2026-10-02-004). Two entries are floor items and do bind: the board room shows aggregates and no athlete detail, and `--locked` means a medical stop.

| Room | Purpose feel | Chrome it was drawn with | Kept out when first drawn |
|------|--------------|----------------|-----------|
| **Office** | Quieter wood / mirror / certificates corner, desk-lamp | Notices, chalk, roster badges | Clinic green, night telemetry, floor drama |
| **Floor** | Open bags + ring edge + fluorescent, high energy | Chalk, WordsOnTheWall, CLEARED badges | Board tables, file cork, clinic red theater |
| **Board** | Formal quiet — chalkboard / certificates wall | Count tiles, PLANNED tabs | Chat, athlete detail, eggs |
| **File** | Gear shelves / sticky-note tagged storage density | Queues, Observation→Lesson columns | Hype, eggs |
| **Clinic** | Cleaner corner, cooler light, less bag drama | Brass Training Hold, `--locked` only for critical medical/safety | Wall sayings, “tough it out” eggs |
| **Night** | Darker, low lamp, bags as silhouettes | Mode labels only (Scout / Architect / Omega) | Board chrome on deny, Master Mode toggle |

Easter eggs: primary home is Floor. As drawn, none on Board, File, Clinic or Night (deny); a joke never sits beside a medical hold or a refusal.

---

## 7. Safety colour contract (hard owner decision)

| Token / colour | Meaning | Never use for |
|----------------|---------|---------------|
| `--locked` (resolves to `#A81E22`) | **MEDICALLY_NOT_ALLOWED only** | Ordinary network failures, loading, empty, form rejection, generic overdue, normal validation, ordinary destructive buttons, generic unavailable |
| Restricted | Visually distinct from Locked | — |
| Destructive action | Separate destructive semantic treatment | The `--locked` medical-stop treatment |

**Red itself is not reserved** (OD-2026-09-29-001, 2026-09-29). The club's colours are black, red and white, so red, `#A81E22` included, may be used anywhere. What the table above keeps is the state: `--locked` means a medical stop and nothing else. The 2026-08-19 reservation of the hue is superseded (OD-2026-09-29-001), and its test (`apps/web/src/design/safeguardingRedReservation.test.ts`) is deleted. Within the refusal-stamp family, red stays MEDICALLY_NOT_ALLOWED's mark only (`apps/web/components/RefusalStamp.tsx:10-17`, enforced by `apps/web/components/refusalStamp.test.tsx`); whether OD-2026-09-29-001 frees that family too is open for Jason.

If you encounter `--stamp-restricted: var(--locked)`, treat it as existing semantic debt, not design authority. Do not reinterpret medical/safeguarding logic.

---

## 8. Typography hierarchy

**Corrected 2026-09-28 to what is built** (OD-2026-09-28-009). The six-voice list this section carried (Alfa Slab One, Oswald, Inter, Special Elite, Caveat, UnifrakturCook) did not match what the app renders, and five of its faces had been retired the day before it was written.

- **Retired 2026-08-23 by owner decision:** Alfa Slab One, Oswald, Special Elite, Caveat and UnifrakturCook, the Leather & Brass personality faces. `apps/web/src/design/legacyVisualVocabulary.test.ts` used to fail if app source (`.tsx` under `app/` and `components/`) named one; it was removed 2026-10-02 (OD-2026-10-02-004). Their `.woff2` files stay in `design-system/fonts/`; their `@font-face` rules are in `design-system/legacy/legacy-fonts.css`.
- **Body:** Roboto Condensed, and **data / numeric / ledger:** Geist Mono — both self-hosted through `next/font` in `apps/web/app/layout.tsx` and read by `--font-body` and `--font-data` in `apps/web/app/globals.css`. Inter is not shipped by this repository.
- **Still rendering where existing CSS asks for them:** the retired faces. `design-system/current/ppbf-golden-era.css` imports the legacy sheet, which loads `legacy-fonts.css`, and `globals.css` still names Alfa Slab One, Oswald and Caveat in `--font-stencil`, `--font-ui` and `--font-hand`. Oswald is also loaded once through `next/font` as `--font-tactical-display` — the one live binding the owner kept on 2026-08-23 until the new system supplies its display typography and the replacement can be verified (pinned by the same test).

A typeface change is a design choice for Jason and the lane (OD-2026-10-02-004).  
Unknown / missing values must look **unknown**, never zero or “normal complete”.

---

## 9. Photographic / plate rules

- Layer 0 only (the wall the room stands in). Real UI composites on top in code.
- Quiet centre, outer-thirds interest, and no INVENTED lettering. Amended 2026-10-02 (OD-2026-10-02-001): real marks on real EQUIPMENT are allowed — a maker's name on a bag, glove, headguard or turnbuckle pad, and the IRON CITY lettering on the ring canvas which was already permitted (owner, 2026-09-28: *"no i like that you can leave it"*; OD-2026-09-28-013; `docs/REAL-GYM-REFERENCE-LOCK.md` Mode A item 4). **There is no general poster permission**: the `GOLDEN GLOVES` poster in `plate-20-coachdesk` is allowed because the owner named that plate (*"sub 6 the poster is fine"*), and a future poster needs its own decision. Invented brands, garbled approximations and any invented crest or club logo remain forbidden.
- Variants from a shared root reference (one building, one day) derived from the Real Gym Reference Lock.
- The byte laws, the delivery rule and who places images are stated once, in `AGENT_KERNEL.md` "Binary assets (plates)"; `apps/web/src/design/plateBinaries.test.ts` enforces them on the bytes and is the hard gate. Do not weaken it. The delivery record (PR #643, 2026-08-25, is the worked example) is in `apps/web/public/plates/README.md`.

Which plates are committed, and which the stylesheet actually paints, is the tables in `apps/web/public/plates/README.md`. (This section used to carry an "exact producer set" of six files with byte counts and SHA-256 hashes; none of them matched the committed plates.)

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
  foundation/     ← carries the tap, type and focus minimums; change with care (spacing, focus, tap, reduced-motion, form geometry, print, SR helpers)
  current/
    ppbf-theme.css        ← THE SEAM. Imports ppbf-golden-era.css.
    ppbf-golden-era.css   ← the Golden Era sheet. Imports the legacy sheet for
                            continuity, then overrides on top of it.
  legacy/
    ppbf-leather-brass.css  ← retired as visual authority, but still the live base
                              of most tokens, materials, components and the PLATES block
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
- Shipped plates: `apps/web/public/plates/` (its README's tables list what is committed and what is painted).
- Do not place binary images inside this Markdown or any JSON.
- A copy of a plate in a drive folder is an archive of a delivery, never the delivery and never a shipping dependency.

---

## 17. Keeping this description true

- The UI changes first; this document follows. A PR that changes the look updates the passage here that describes it, or deletes the passage (OD-2026-10-02-004).
- What a screen looks like and how it flows is decided by Jason with the lane doing the work. An earlier approval recorded here is where the look started, not a reason to refuse or flag a change.
- ChatGPT, as reviewer (OD-2026-09-28-001 #2), reviews UI PRs against the list in `AGENT_KERNEL.md` "UI and visual work" and the actual PR diff, not against this description.

Tagline remains: **OBSERVE. DECIDE. EXECUTE. REPEAT.**

— Grok, 2026-08-24 (v1.1 — real-gym lock linked)

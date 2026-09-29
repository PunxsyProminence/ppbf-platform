# GOLDEN ERA V1 — Real-Gym Visual Contract
**Version:** 1.1 · **Date:** 2026-08-24 · **Author:** Grok · **Owner:** Jason Neale  
**Status:** Active authority for the usable-app visual release.  
**Amended 2026-09-28** (OD-2026-09-28-001, OD-2026-09-28-009): owner-first authority order (§2); §3 points to the lock; §8 records the fonts as built; §9 points to the plates README; §13 shows the seam as built; Claude places plate binaries. Later the same day, by owner decision: §4 adds dark glass as a panel material (OD-2026-09-28-014); §9 lets the ring canvas keep its IRON CITY lettering (OD-2026-09-28-013). **Amended 2026-09-29** (OD-2026-09-29-001): §6 and §7, red is not reserved; `--locked` still means a medical stop.  
**Related:** this file (look & feel) · `docs/REAL-GYM-REFERENCE-LOCK.md` (environmental DNA) · `docs/ROOM-MAP.md` (the visual build order) · `design-system/README.md` (the laws that still bind) · `apps/web/public/plates/README.md` (plates)

> This document is the durable visual authority.  
> A future session must be able to reproduce the approved direction from this file alone.  
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

## 2. Authority order

| Rank | Authority | Source |
|------|-----------|--------|
| 1 | Owner | Jason’s decisions (`docs/current/OWNER_DECISIONS.md`) and explicit choices; they override this contract and earlier mockups |
| 2 | Functional | Current `main` source + real APIs |
| 3 | Visual | This contract + Jason-approved Golden Era |
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

Golden Era is the **rendered visual authority**. The old Leather & Brass sheet is retired as the look. The theme seam (`design-system/current/ppbf-theme.css`) is the single place the look is swapped; foundation stays intact.

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

### Surface rules
- Cards and panels sit *on* the room (aged paper, leather or dark glass on the wall plate), never fight the plate.
- Quiet centre of every plate; UI panels land in the quiet zone.
- Text over photographs or textured grounds must remain readable (overlay or material treatment required). Jason has already caught unreadable text that tests missed — treat contrast as first-class.
- No skeuomorphic “room-*” classes beyond the six declared rooms. No new invented materials without owner approval (dark glass has it, above).

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

## 6. Room Purpose DNA (summary of today's six rooms — full law in `docs/shadow-ui/ROOM-PURPOSE-DNA.md`; the target rooms are `docs/ROOM-MAP.md`)

| Room | Purpose feel | Allowed chrome | Forbidden |
|------|--------------|----------------|-----------|
| **Office** | Quieter wood / mirror / certificates corner, desk-lamp | Notices, chalk, roster badges | Clinic green, night telemetry, floor drama |
| **Floor** | Open bags + ring edge + fluorescent, high energy | Chalk, WordsOnTheWall, CLEARED badges | Board tables, file cork, clinic red theater |
| **Board** | Formal quiet — chalkboard / certificates wall | Count tiles, PLANNED tabs | Chat, athlete detail, eggs |
| **File** | Gear shelves / sticky-note tagged storage density | Queues, Observation→Lesson columns | Hype, eggs |
| **Clinic** | Cleaner corner, cooler light, less bag drama | Brass Training Hold, `--locked` only for critical medical/safety | Wall sayings, “tough it out” eggs |
| **Night** | Darker, low lamp, bags as silhouettes | Mode labels only (Scout / Architect / Omega) | Board chrome on deny, Master Mode toggle |

Easter eggs: primary home is Floor. Never on Board, File, Clinic, Night (deny).

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

- **Retired 2026-08-23 by owner decision:** Alfa Slab One, Oswald, Special Elite, Caveat and UnifrakturCook, the Leather & Brass personality faces. `apps/web/src/design/legacyVisualVocabulary.test.ts` fails if app source (`.tsx` under `app/` and `components/`) names one. Their `.woff2` files stay in `design-system/fonts/`; their `@font-face` rules are in `design-system/legacy/legacy-fonts.css`.
- **Body:** Roboto Condensed, and **data / numeric / ledger:** Geist Mono — both self-hosted through `next/font` in `apps/web/app/layout.tsx` and read by `--font-body` and `--font-data` in `apps/web/app/globals.css`. Inter is not shipped by this repository.
- **Still rendering where existing CSS asks for them:** the retired faces. `design-system/current/ppbf-golden-era.css` imports the legacy sheet, which loads `legacy-fonts.css`, and `globals.css` still names Alfa Slab One, Oswald and Caveat in `--font-stencil`, `--font-ui` and `--font-hand`. Oswald is also loaded once through `next/font` as `--font-tactical-display` — the one live binding the owner kept on 2026-08-23 until the new system supplies its display typography and the replacement can be verified (pinned by the same test).

Do not add a family without owner approval.  
Unknown / missing values must look **unknown**, never zero or “normal complete”.

---

## 9. Photographic / plate rules

- Layer 0 only (the wall the room stands in). Real UI composites on top in code.
- Quiet centre, outer-thirds interest, zero lettering — except the IRON CITY lettering on the ring canvas, which stays when the ring is in frame (owner, 2026-09-28: *"no i like that you can leave it"*; OD-2026-09-28-013; `docs/REAL-GYM-REFERENCE-LOCK.md` Mode A item 4).
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
  foundation/     ← do not casually rewrite (spacing, focus, tap, reduced-motion, form geometry, print, SR helpers)
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

## 17. Change control

- This contract is amended by owner decision, or by Claude in a visual PR that updates it as part of a visual release (OD-2026-09-26-001 as narrowed by OD-2026-09-28-001).
- Nobody rewrites an approved visual decision out of preference (OD-2026-09-26-001). Anyone may propose a change, and the owner decides.
- ChatGPT, as reviewer once its instructions are set up (OD-2026-09-28-001 #2), checks claims against this contract and the actual PR diff.

Tagline remains: **OBSERVE. DECIDE. EXECUTE. REPEAT.**

— Grok, 2026-08-24 (v1.1 — real-gym lock linked)

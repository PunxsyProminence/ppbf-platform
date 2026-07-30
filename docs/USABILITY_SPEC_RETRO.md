# PPBF Retro Interface — Usability Spec + Floor-Use Spec

**Version:** 1.0  
**Status:** P0  
**Depends on:** `RETRO_DESIGN_SYSTEM.md`

---

## Part A — Usability Spec

### A1. Core Principles
1. Physical first — every control maps to a real gym object.
2. Status is never subtle — large rubber stamps or brass tags only.
3. Permanent over temporary — ledgers and scoreboards always visible.
4. One language for all roles — density changes, language does not.
5. Accessibility is non-negotiable — aesthetic never overrides WCAG AA, keyboard, or touch targets.

### A2. Interaction Language (summary)
| Object            | Purpose                     | Min size / rules                  |
|-------------------|-----------------------------|-----------------------------------|
| Rubber Stamp      | Primary action + status     | ≥ 48 px (floor ≥ 56 px)           |
| Brass Plate       | Secondary action / label    | ≥ 44 px height                    |
| Paper Ticket      | Content unit                | Full readable text                |
| Leather Tag       | Navigation                  | ≥ 44 px                           |
| Brass Scoreboard  | System health / KPIs        | Always top, high contrast         |
| Ledger Tape       | Audit / activity / chat     | Mono, append-only                 |
| Mechanical Lock   | PIN entry                   | Keys ≥ 56 px                      |

### A3. Global Layout Rules
- **Desktop:** Left leather-tag rail + top brass scoreboard + main board + optional right ledger.
- **Mobile:** Bottom brass tab bar + full-width tickets + large bottom-sheet stamps.
- No hamburger menus.
- Breadcrumb = fight-card ticket strip under header.
- Empty states = blank gym form / empty passbook (never cute illustrations).

### A4. Status & Feedback
- Success → olive stamp CLEARED / DONE (permanent).
- Caution → amber stamp HOLD.
- Danger → crimson stamp RESTRICTED / ESCALATE + ▲ badge.
- Loading → intensified paper grain + typewriter cursor (no modern spinner).
- Hover → card lifts (shadow +2 px). Pressed → shadow reverses.
- Focus ring → 2 px solid crimson, always visible for keyboard.

### A5. Accessibility Checklist (must pass before ship)
- [ ] Text contrast ≥ 4.5:1 (body), 3:1 (large) on aged paper.
- [ ] Touch / click targets ≥ 44×44 px (48–64 px for stamps on floor).
- [ ] Full keyboard navigation + visible focus.
- [ ] ARIA labels on every stamp, tag, and ticket.
- [ ] `prefers-reduced-motion` disables stamp press animation.
- [ ] Screen reader announces stamp changes and ledger updates.
- [ ] PIN entry never relies on color alone.
- [ ] Color is never the only status indicator (stamp text always present).

### A6. Role Density Matrix
| Role     | Density     | Special rules                              |
|----------|-------------|--------------------------------------------|
| Athlete  | Low         | Large passbook, max 3–4 actions            |
| Parent   | Low–Medium  | Clearance + next session dominant          |
| Coach    | High        | Open-cases filter default, bulk stamp OK   |
| Admin    | High        | Capability grid + live ledger always on    |
| Board    | Low         | Aggregate only, zero individual PII        |
| SHADOW   | Medium      | Teletype chat + pinned evidence cards      |

### A7. Critical Flows (must be ≤ 3 taps for expert)
1. Coach reviews case → opens ticket → stamps CLEARED/HOLD.
2. Admin restricts PIN → stamps RESTRICTED → ledger records it.
3. Parent checks clearance → sees big stamp + next session.
4. Athlete logs sparring → fills simple card → stamps SUBMITTED.
5. Board views compliance → only aggregate brass scoreboards.

### A8. Acceptance Tests
1. Non-technical coach completes happy path in < 10 s after one demo.
2. Every status is a stamp or brass tag.
3. Mobile keeps ≥ 48 px stamps.
4. Keyboard-only navigation works end-to-end.
5. Screen still feels like a 1950s gym desk.

---

## Part B — Floor-Use Spec

### B1. Floor Reality Constraints
| Condition              | Design Response                                      |
|------------------------|------------------------------------------------------|
| Gloves / sweaty hands  | Targets 56–64 px, no tiny icons                      |
| One-handed use         | Thumb-zone bottom stamps, no precise gestures        |
| Loud / short attention | Instant visual + optional haptic/sound on stamp      |
| Poor lighting / glare  | Forced high-contrast ink + large type                |
| Constant movement      | Offline-first; sync when back in range               |
| Chaos / kids nearby    | Auto-lock after 30 s idle; quick mechanical PIN      |
| No desk                | Portrait phone or landscape tablet only              |

### B2. Floor-Optimized Screens
- **Sparring Log** (highest frequency) — see `FLOOR_FLOWS_SPARRING_ATTENDANCE.md`
- **Live Attendance / Passbook Check** — one stamp PRESENT / LATE
- **Quick Sports-Med Observation** — floating NOTE stamp → mini passbook
- **Review Queue** — still usable standing (large tickets + bottom stamps)

### B3. Floor Interaction Rules
1. Stamps are the only primary action on the floor.
2. No multi-step wizards (max two steps).
3. Brass scoreboard remains visible even on mobile.
4. Every floor action immediately writes a ledger event (or offline queue entry).
5. Haptic + optional short “thud” on stamp (user can mute).
6. Offline queue shows brass plate “PENDING SYNC”; original timestamp preserved.

### B4. Device Strategy
| Device              | Use case                          | Layout                          |
|---------------------|-----------------------------------|---------------------------------|
| Phone (portrait)    | Walking coach, sparring, quick notes | Bottom stamps, full-width tickets |
| Tablet (landscape)  | Bench / ring-side review          | Two-column tickets + ledger     |
| Shared gym tablet   | Check-in kiosk                    | Kiosk mode, big PIN, auto-lock  |
| Desktop             | Back office only                  | Full leather rail + dual panels |

### B5. Floor-Specific Risks & Mitigations
| Risk                            | Mitigation                                              |
|---------------------------------|---------------------------------------------------------|
| Accidental stamp with gloves    | 300 ms press-and-hold or slide-to-confirm for destructive stamps |
| Glare / dim screen              | High-contrast mode + larger text preference             |
| Coach forgets to log            | Optional round-reminder haptic while timer running      |
| Multiple coaches same athlete   | Ticket locks after first stamp; shows who stamped it    |
| Sweat on screen                 | Large targets only; no precise swipe gestures           |
| Battery / connectivity          | Offline-first + visible SYNCED / PENDING brass plate    |

### B6. Floor Acceptance Tests
1. Coach with gloves can start/end a round and stamp in < 20 s total.
2. Attendance stamp works one-handed in portrait.
3. Offline stamp appears correctly on ledger after reconnect (original time kept).
4. Shared tablet auto-locks and requires mechanical PIN to unlock.
5. Stamps remain readable at 3 m distance under gym lighting.

---

**P0 complete when:** this document is reviewed by at least one coach and one non-technical parent, and the checklist items are tracked as issues.

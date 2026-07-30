# Floor Flows — Live Sparring Log & Attendance

**Version:** 1.0  
**Status:** P0  
**Depends on:** `RETRO_DESIGN_SYSTEM.md`, `USABILITY_SPEC_RETRO.md`, `STAMP_AND_LEDGER_SCHEMA.md`  
**Primary devices:** Phone (portrait) and tablet (landscape)

These two flows are the highest-frequency actions on the gym floor. They must be completable with gloves on, one-handed, in under 20 seconds for a full sparring round entry.

---

## Flow 1 — Live Sparring Log

**Route (suggested):** `/athlete/dashboard/sparring` or `/coach/sparring-log`  
**Actors:** Coach (primary), Athlete (view own history)

### Goal
Record a live sparring round with opponent, stance, punch counts, and optional note, then stamp it into the ledger and the athlete’s progression card.

### Happy Path (Coach, phone, gloves on)

1. **Open Sparring Log** (1 tap from home or leather rail)  
   - Screen shows brass scoreboard at top: `ACTIVE ROUND: — | TODAY: 4`  
   - Large brass plate: **NEW ROUND**

2. **Select athletes** (2 taps)  
   - Two big paper tickets: “Athlete” and “Opponent”  
   - Tap each → searchable list of today’s present athletes (or recent)  
   - Selected names appear as brass nameplates.

3. **Set stance** (1 tap)  
   - Two large brass plates side-by-side: **ORTHODOX** | **SOUTHPAW** (for the athlete; opponent can be separate if needed).  
   - Default last-used stance.

4. **Start round** (1 tap)  
   - Large brass plate **START ROUND**  
   - Emits `START_ROUND` stamp event.  
   - Timer starts (visible large mono numbers).  
   - Punch counter pad appears: big mechanical keys for **JAB · CROSS · HOOK · UPPERCUT · BODY · OTHER**.

5. **During round** (one-handed)  
   - Coach taps counters with thumb. Each tap increments and can optionally emit a lightweight local event (not yet stamped).  
   - Optional haptic on every 10th punch.

6. **End round** (1 tap)  
   - Large brass plate **END ROUND** (or auto after configured minutes).  
   - Emits `END_ROUND` stamp with payload:  
     ```json
     {
       "durationSec": 180,
       "punches": { "jab": 42, "cross": 28, "hook": 15, "uppercut": 4, "body": 9, "other": 2 },
       "athleteId": "…",
       "opponentId": "…",
       "stance": "Orthodox"
     }
     ```
   - Short optional typewriter note field (max 140 chars) appears for 5 seconds.  
   - Coach taps **SAVE** (or it auto-saves after timeout).

7. **Confirmation**  
   - Olive stamp **SUBMITTED** appears on the ticket.  
   - Ledger tape appends:  
     `14:37  COACH M.  END ROUND  J. Rivera vs K. Lee  3:00  J42 C28 …`  
   - Athlete’s progression card updates (sparring count +1).

### Edge Cases
| Case                        | Behavior |
|-----------------------------|----------|
| Network lost mid-round      | Timer and counters stay local; END ROUND goes to offline queue with original `occurredAt`. |
| Accidental START            | “CANCEL ROUND” brass plate available for first 10 s (no ledger write). |
| Same pair already logged    | Allow it; history shows both. |
| Athlete not on present list | “Add walk-in” → creates temporary ticket, later linked. |
| Gloves fat-finger           | Counters require deliberate tap (no multi-touch zoom). Destructive actions use press-and-hold. |

### Mobile Layout (portrait)
```
┌─────────────────────────┐
│ brass-scoreboard        │
├─────────────────────────┤
│ Athlete     Opponent    │  ← two tickets
│ ORTHODOX  SOUTHPAW      │  ← stance plates
├─────────────────────────┤
│      02:47              │  ← big timer
│ JAB 42  CROSS 28  …     │  ← counters
├─────────────────────────┤
│ [START/END ROUND]       │  ← full-width brass
│ [SAVE / note]           │
└─────────────────────────┘
```

### Success Metrics
- Expert coach: full round entry ≤ 20 s active time.
- First-time coach after one demo: ≤ 45 s.
- Zero data loss on offline end-round.

---

## Flow 2 — Live Attendance / Passbook Check

**Route (suggested):** `/coach/attendance` or kiosk mode on shared tablet  
**Actors:** Coach, Volunteer, Front-desk

### Goal
Mark athletes PRESENT / LATE / ABSENT in seconds, update the daily roster, and write the ledger.

### Happy Path (Coach or Volunteer, phone or kiosk)

1. **Open Attendance**  
   - Brass scoreboard: `EXPECTED: 28 | PRESENT: 19 | LATE: 2`  
   - Default filter: “Not yet marked”.

2. **Scan or tap athlete**  
   - List of paper tickets (name + age group + last stamp).  
   - Optional: barcode / QR / name search (typewriter bar).  
   - Tap ticket → expands or opens bottom sheet.

3. **Stamp**  
   - Three large stamps fixed in thumb zone:  
     **PRESENT** (olive) · **LATE** (amber) · **ABSENT** (neutral)  
   - One tap → immediate stamp event + ledger line:  
     `16:02  COACH M.  STAMPED PRESENT  J. Rivera`  
   - Ticket moves to “Marked” pile or updates in place with big stamp.

4. **Bulk (optional)**  
   - “Mark remaining PRESENT” brass plate for the last few kids (with confirmation).

### Kiosk Mode (shared gym tablet)
- Full-screen, no leather rail.  
- Large mechanical PIN to unlock.  
- Auto-lock after 30 s idle.  
- Only PRESENT / LATE / ABSENT stamps enabled.  
- Big “WHO IS HERE” view for parents walking in.

### Edge Cases
| Case                     | Behavior |
|--------------------------|----------|
| Already stamped today    | Show existing stamp; allow override with new stamp + ledger note “corrected”. |
| Offline                  | Queue stamps; show PENDING SYNC brass plate. |
| Wrong athlete            | Undo via new compensating stamp within 60 s (or ledger correction later). |
| Visitor / parent         | Separate “Guest” ticket type, no progression impact. |

### Success Metrics
- Single athlete mark ≤ 3 s.  
- Full class of 20 kids ≤ 90 s by one volunteer.  
- Kiosk usable by non-technical front-desk after 30 s training.

---

## Shared Floor Rules (both flows)

1. All stamps write a `StampEvent` with `offline: true|false` and original `occurredAt`.
2. Brass scoreboard updates optimistically, then reconciles on sync.
3. Destructive or corrective actions use press-and-hold or explicit confirmation plate.
4. Haptic feedback on every successful stamp (user setting).
5. Screen never navigates away after a stamp — coach stays in the flow.
6. Ledger tape (if visible) appends instantly so the coach sees the permanent record.

---

## Implementation Checklist (P0)

- [ ] Routes exist and are role-gated.
- [ ] `START_ROUND` / `END_ROUND` / `PRESENT` / `LATE` / `ABSENT` codes in vocabulary.
- [ ] Payload shape for punch counts and duration validated.
- [ ] Offline queue handles both flows.
- [ ] Mobile layouts match the wireframes above (bottom stamps, large timers).
- [ ] Kiosk mode flag + auto-lock + mechanical PIN.
- [ ] Unit + integration tests for offline end-round and attendance stamp.
- [ ] One real coach floor test completed and signed off.

---

**P0 complete when:** a coach can run a live sparring round and mark attendance on a phone with gloves on, offline, and every action appears correctly on the Continuity Ledger after reconnect.

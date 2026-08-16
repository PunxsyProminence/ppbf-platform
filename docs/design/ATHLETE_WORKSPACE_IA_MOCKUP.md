# Athlete workspace — IA mockup (for owner approval)

Status: **PROPOSAL — no code written yet.** Approve or amend the IA below before any
component work starts.

Target IA: `Today → Development → Learn → Schedule → Messages → SHADOW`.
Today's workspace is 11 flat tabs in one 2,596-line component.

## The mapping

| Group | Absorbs (current tab) | Why it groups here |
|---|---|---|
| **Today** | Dashboard, Bio Check-In, Floor | The three things an athlete does on arrival, in the order they do them |
| **Development** | Goals, Tracks, Assessments | Their own record over time — the "how am I changing" question |
| **Learn** | Drills, Rabbit Holes | Coach-authored study material, not personal data |
| **Schedule** | Schedule Session | Unchanged (see placeholder note) |
| **Messages** | Message Coach | Renamed — see the Messages section |
| **SHADOW** | SHADOW Intel | Unchanged |

11 destinations become 6. Nothing is deleted; four surfaces move one level down
behind a group that states what it holds.

---

## Today

The landing screen. An athlete arriving at the gym should finish here without
navigating.

```
TODAY                                    Thursday, 16 Aug

┌─ Check in ──────────────────────────────────┐
│  You have not checked in today.             │
│  [ Start check-in ]                         │
└─────────────────────────────────────────────┘

┌─ On the floor ──────────────────────────────┐
│  3 assignments from Coach <name>            │
│  ○ <assignment>                             │
│  ○ <assignment>                             │
│  ○ <assignment>                             │
│  [ Open the floor ]                         │
└─────────────────────────────────────────────┘

┌─ Your goals ────────────────────────────────┐
│  2 active · last updated <date>             │
│  [ Open goals ]                             │
└─────────────────────────────────────────────┘
```

Progressive disclosure: Today shows **state and one action per card**, never the
full surface. Bio Check-In and Floor open as full screens from here; they are not
inlined.

State rules on this screen:
- Not checked in → the check-in card is first and is the only emphasised action.
- Already checked in → that card collapses to a one-line confirmation with the
  time, and Floor becomes the emphasised card.
- No assignments recorded → the card reads **"No assignments recorded for today"**,
  not "0 assignments" and not an empty list. Absence of a record and a record of
  zero are different facts.
- The training-attempts and intervention APIs are merged but not yet deployed, so
  a 404 from them renders as **"Not available yet"** — an honest absent state, never
  an empty success state.

## Development

The athlete's own record. This is where "pride in your own record" lives, and the
only place engagement mechanics may appear at all.

```
DEVELOPMENT

[ Goals ]  [ Tracks ]  [ Assessments ]      ← sub-nav, Goals default

┌─ Your edge, found ──────────────────────────┐
│  <date> — you beat a target you had         │
│  missed before on <recorded item>.          │
│  From your own record. No comparison.       │
└─────────────────────────────────────────────┘
```

Hard rules on this screen, carried from the engagement direction:
- Every number traces to a real recorded event. No XP, no levels, no points, no
  composite index.
- No leaderboard, no cohort, no percentile, no "athletes like you" — cross-athlete
  comparison is forbidden in every form, including anonymised ones.
- A missed target is badged honestly and may be framed as **"your edge, found"** —
  never as success, and never with shame.
- Streaks display as history. No streak-breaking warnings, no countdowns, no nags.
- Anything a coach has not confirmed does not appear here at all. Athlete-visible
  plans come only through the existing coach-confirmation gate.

Assessments carries a caveat surfaced by the engine review: every
`assessment_protocols` row currently defaults to `reliability_status =
'UNVALIDATED - PPBF MUST ESTABLISH'` and `evidence_class = 'INSUFFICIENT
EVIDENCE'`. Whether unvalidated protocol results should be shown to an athlete at
all is an open owner question, flagged here rather than assumed.

## Learn

Coach-authored study material. No personal data, so no gating beyond role.

```
LEARN

[ Drills ]  [ Rabbit Holes ]

Everything here is this gym's own coaching, written by a
coach and published under their name. It is not research
and it is not SHADOW evidence.
```

That provenance line already exists on Rabbit Holes and is correct. It moves up to
cover the whole group.

## Schedule

Unchanged in this pass. Its own help text currently says it is *"a placeholder until
it can read the gym's classes."* That is an honest placeholder and it stays honest —
it is logged for the placeholder inventory rather than quietly redesigned into
looking functional.

## Messages

Renamed to **Ask SHADOW**. The stored behaviour is unchanged; only the naming stops
implying something the code does not do.

```
MESSAGES

┌─ Ask SHADOW ────────────────────────────────┐
│  Write a question. It is recorded in your   │
│  own SHADOW conversation and answered by    │
│  SHADOW. It is not delivered to a coach.    │
└─────────────────────────────────────────────┘

▲ SafeSport: what you send here is kept, but your parent
  is not automatically copied and no coach is notified.
  Tell a coach or a trusted adult in person about anything
  urgent or unsafe.

  Your question
  [                                          ]
  [ Ask SHADOW ]
```

Changes: panel title, form heading (`Send Message to Coach` → `Ask SHADOW`), submit
button, and help copy. The nav label stays **Messages**. The SafeSport alert stays
exactly as written.

**The coach picker and the guardian copy are NOT in this pass.** Both need backend
work in directories this session is fenced out of — see the blocker note below. The
picker's two hardcoded names (`Coach Jason`, `Coach Danielle`) are invented data and
need a decision; nothing here changes them yet.

## SHADOW

Unchanged. Its existing copy is already accurate: *"Open the real SHADOW chat to get
a response — this workspace does not answer questions inline."*

AI output stays visibly distinct from human decisions throughout: SHADOW surfaces
keep their own visual treatment and are never styled as a coach's words.

---

## Blocker: the parent-CC decision cannot be built from this lane

The owner decided (2026-08-16) that for youth, **guardians receive a copy** of
athlete messages, and that the coach picker should list **real coaches**. Both are
recorded. Neither is buildable here:

| Half of the decision | What it needs | Why it is blocked |
|---|---|---|
| Real coach list | A new athlete-scoped coach roster endpoint | The athlete API surface is exactly `chat` and `check-in`. A new route lives in `app/api/**`. |
| Guardian copy | A write path that fans a copy to guardians | `/api/pilot/parent/messages` is deliberately **read-only** — one-directional coach/admin → parent, no POST by design. Adding one touches `src/server/pilot/**`. |

Until the backend half exists, the SafeSport warning must keep saying parent copy is
**not** in force. Claiming a safeguard that does not run is worse than stating its
absence — that is why the existing code comment says this surface "cannot claim
parent CC is in force."

---

## Drift found against the coordinating prompt

| Claim in the prompt | Reality | Impact |
|---|---|---|
| Design tokens live "in globals.css and existing pages" | Canonical source is `design-system/ppbf.css`, imported at `globals.css:15`. `t-command` and `t-label` are defined **only** in ppbf.css | Codification must point at ppbf.css |
| Write a new `DESIGN_SYSTEM_PPBF.md` | `design-system/README.md` (477 lines) and `docs/BRAND_DESIGN_BRIEF.md` already exist | A new file would be the third design doc; consolidation decided instead |
| Consult `TEST_PIN_MAP.md` before renaming | Does not exist — never committed on any branch | Test pins for this component are in `athleteWorkspace.test.tsx` (741 lines) and must be migrated in the same PR |
| Stay "one build behind the primary session" | No open PRs from the primary session; branch is level with `origin/main` | Nothing is off-limits for cadence right now |
| Message Coach copy needs the SafeSport warning kept | Already present and correct | Keep verbatim |

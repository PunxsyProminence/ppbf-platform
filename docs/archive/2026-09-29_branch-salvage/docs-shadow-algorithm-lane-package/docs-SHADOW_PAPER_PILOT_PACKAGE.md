# SHADOW PAPER PILOT PACKAGE

## 1. Control State
- **Main:** e2a55705a2767a1ae8b7e87606eacde7cf6aa1da (merge of #337) — owner-attested
- **#337:** MERGED / live in main
- **#358:** OPEN — Phase A inference (head 8d62eb53…)
- **#355:** OPEN — single-case design, stacked on #358
- **#357:** OPEN — observer reliability, stacked on #355
- **Drift:** none observable. Ordered re-fetch was attempted again this session and this surface still cannot reach GitHub (unauthenticated, rate-limited). State adopted as owner-attested under authority precedence #1; #354 remains closed/superseded. First repo-capable lane confirms before pilot results feed any cross-review.

## 2. Pilot Purpose
- **Measurement question:** can PPBF coaches produce valid, consistent, analyzable observations — including the six-way state distinction — with tolerable burden, on paper, for one week?
- **Algorithms supported (as future consumers, not validators):** #337 pattern formation, #358 recurrence/attribution/drift, #355 single-case intervention analysis, #357 observer reliability, future retention/transfer.
- **What this pilot does NOT validate:** Beta/Binomial recurrence, SPRT, Tau-U for PPBF, Fleiss' kappa for PPBF, any threshold, any behavior as organizational methodology, any intervention as effective. It tests forms and coaches' ability to use them. Nothing more.

## 3. Vocabulary Freeze
- **Source version:** SHADOW OBSERVATION-CAPTURE VOCABULARY SPEC v0 — FROZEN input.
- **Changes made to vocabulary:** none. The six selectable states on the forms are v0's five polarities plus v0's existing UNKNOWN (`?`) mark made an explicit selectable rather than a margin convention.
- **Revision candidates discovered (recorded, not applied):**
  - `VOCABULARY REVISION CANDIDATE — RC-1:` promote UNKNOWN from a notation rule to a first-class sixth polarity state in v0.1.
  - `VOCABULARY REVISION CANDIDATE — RC-2:` this order requires **intended outcome direction** on the intervention record. v0 barred captured "outcome direction" as hindsight opinion; a pre-declared *intended* direction (written before any outcome exists) is a different object and is needed by #355 for directional hypotheses. v0.1 should adopt the distinction explicitly: INTENDED direction = capturable at start; ACTUAL direction = computed only.

## 4. Printable Session Sheet

```
=====================================================================
PPBF SHADOW — SESSION OBSERVATION SHEET          Sheet ID: ____-____-__
=====================================================================
Date ______  Session ______  Type:  TRAIN / COMP   Minutes ____
Observer (coach) ____________   Source:  H (live) / V (video)
Athletes present (codes): ___________________________________________

>>> RECORD WHAT YOU SAW — NOT WHY IT HAPPENED. <<<
Interpretations go on the BACK, referencing row #.

STATES — mark exactly one per row:
  ✓   OCCURRED ............. target behavior happened
  ✗C  COUNTEREXAMPLE ....... real chance + athlete did the RIGHT thing
                             (only when you actually saw it)
  ○OP OPPORTUNITY, NOT DONE . chance existed, behavior didn't happen
                             (FOCUS ROUND ONLY)
  N.O. NOT OBSERVABLE ....... you couldn't see/judge it
  N.A. NO OPPORTUNITY ....... no meaningful chance arose
  ?    UNKNOWN .............. you don't know / weren't watching
A BLANK CELL ASSERTS NOTHING. Blank is never "didn't happen."

CONTEXT (one letter):  I isolated drill · P partner drill ·
C constrained live · L open live · S sparring · X competition
                       [pilot-provisional set — v0 candidates]

FOCUS ROUND today:  Rnd ____  Behavior code ____
(During that round only: actively log ○OP and ✗C for that behavior.)

---------------------------------------------------------------------
 # | Rnd | Athlete | Behavior | STATE          | Ctx | Partner | Note
   |     |  code   |   code   | ✓ ✗C ○OP N.O.  | I P |  code   |
   |     |         |          |    N.A. ?      | C L |  or –   |
---------------------------------------------------------------------
 1 |     |         |          |                |     |         |
 2 |     |         |          |                |     |         |
 3 |     |         |          |                |     |         |
   |  …repeat rows to fill page…
---------------------------------------------------------------------
ONE EPISODE = ONE ROW. Only start a new row for a clearly separate
chance, not the same breakdown continuing.

CORRECTIONS: single line through the error, write beside it, initial.
Never erase. Never overwrite.

END OF SESSION — ask each athlete:
"How hard was today? 0 = nothing at all, 10 = hardest ever."
                                        [pilot wording]
Athlete ____ RPE __   Athlete ____ RPE __   Athlete ____ RPE __
Athlete ____ RPE __   Athlete ____ RPE __   Athlete ____ RPE __
=====================================================================
```

## 5. Printable Intervention Half-Sheet

```
=====================================================================
PPBF SHADOW — INTERVENTION RECORD (one per intervention)
=====================================================================
Intervention ID: ____-____   (athlete code + start date)
Athlete code ______   Target behavior code ______
Coach delivering ____________   Start date/session ______________
Cue / action (one line): ____________________________________________

INTENDED direction (circle ONE, written at START, before outcomes):
   LESS of target behavior      /      MORE of counterexample
This states the aim. It is not a claim that it worked.

EXPOSURE LOG
 Session date | Applied (tally) | Fidelity: delivered as intended?
 _____________|________________|   Y   /   P (partial)   /   N
 _____________|________________|   Y   /   P   /   N
 _____________|________________|   Y   /   P   /   N
 _____________|________________|   Y   /   P   /   N

RETENTION CHECK — scheduled session: ______________
RULE: do NOT coach this cue that session. Observe normally.

TRANSFER: no field. Computed later from context letters of post
observations. Do not hand-tag "transfer."

OUTCOMES: none recorded here. Outcomes = later rows on session
sheets. List Sheet IDs where post observations appear:
_____________________________________________________________________
There is deliberately NO "it worked" box, NO effectiveness %,
NO approval line on this form.
=====================================================================
```

## 6. Co-Rating Card

```
=====================================================================
PPBF SHADOW — CO-RATING CARD        Co-rating Group ID: ______________
                     (date + round + athlete + behavior — SAME ID on
                      both coaches' cards)
=====================================================================
Date ____  Session ____  Round ____  Athlete code ____
Behavior code ____  — BEFORE the round, both coaches read the
registry definition of this behavior ALOUD. Same words, same target.

Rate independently on YOUR card using ALL SIX states, including
○OP (opportunity, not done):

 Episode | STATE:  ✓  ✗C  ○OP  N.O.  N.A.  ?   | Note (optional)
 --------|------------------------------------|------------------
    1    |                                    |
    2    |                                    |
    3    |                                    |

INDEPENDENCE: no talking, no glancing, no comparing until BOTH
cards are handed in. Editing after seeing the other card VOIDS
the unit.
DISAGREEMENT: hand in as-is. Disagreement is data. Do not
reconcile, average, or argue it away.
MISSED IT: mark ? — never copy the other coach.
VIDEO: if rating later from video, mark Source = V. Video ratings
are logged but kept OUT of live human-agreement comparison.
Source:  H  /  V        Observer (coach) ____________
=====================================================================
```

## 7. Coach Instructions

```
=====================================================================
HOW TO RECORD A SHADOW OBSERVATION
=====================================================================
1. RECORD WHAT YOU SAW, NOT WHY IT HAPPENED.
   "Rear hand dropped on the exit" — yes.
   "He got lazy because he was tired" — no. That's a theory, and
   theories go on the back of the sheet, not in the rows.

2. USE THE REGISTRY DEFINITION. If the moment doesn't match the
   card's definition of that behavior code, it isn't that code.

3. CONTEXT IS ITS OWN COLUMN. The round, the context letter, the
   partner — write them down; don't fold them into the note.

4. COUNTEREXAMPLE (✗C) ONLY WHEN YOU SAW IT. The athlete had a
   real chance and did the right thing instead — witnessed, not
   assumed.

5. SILENCE IS NOT SUCCESS. If you didn't write it down, the sheet
   says nothing about it. Never read a blank as "he stopped doing
   it."

6. USE THE HONEST STATES. Couldn't see it → N.O. No real chance →
   N.A. Don't know → ?. These marks are good data, not admissions
   of failure.

7. INTERVENTIONS GET THEIR OWN SHEET. The cue you coached lives on
   the intervention half-sheet. The session sheet stays what-you-saw.

8. NEVER REWRITE THE PAST. What happened later doesn't change what
   you observed earlier. Corrections are for writing errors only —
   strike through, note, initial.

9. NO DIAGNOSES, NO PERSONALITY LABELS, NO MEDICAL OR PSYCHOLOGICAL
   GUESSES — not in codes, not in notes. Behavior only.

10. WHEN UNCERTAIN, PRESERVE THE UNCERTAINTY. A truthful ? beats a
    confident guess every single time.
=====================================================================
```

## 8. Seven-Day Pilot Protocol
- **Setup (Day 0, ~30 min, before any capture):** coaches draft the starter **Behavior Registry Card** — up to 10 codes, each with an observable one-line definition that passes "two coaches, same round, usually the same call"; no "because," no mental states. Jason initials the registry card and the context-letter set — **pilot-scoped approval only, not organizational ratification.** Run the 5-minute A–E calibration drill (§9, Defect 1). Print the pack; assign Sheet IDs (date-session-coach initials).
- **Daily capture:** every normal training session in the pilot program gets one session sheet per observing coach. One **focus round** per session (announced before it starts). Sessions should span at least two context modes across the week so the letters get exercised. `PILOT OPERATING TARGET — NOT ALGORITHM THRESHOLD:` 2 coaches, roughly 4–8 athletes tracked.
- **Co-rating:** `PILOT OPERATING TARGET — NOT ALGORITHM THRESHOLD:` 2–3 co-rated rounds across the week, scheduled in advance, run per the card.
- **Intervention capture:** half-sheets ONLY for interventions coaches were already going to run — `PILOT OPERATING TARGET:` at most 1–2 this week. Do not invent an intervention to test the form.
- **Storage:** sheets use athlete codes, never names; the code→name key lives separately with Jason. Completed sheets go into one envelope/folder in the locked office daily. No photographing sheets to personal phones. Transcription on-site or by Jason only.
- **End-of-week review:** each coach completes the §14 form; sheets + forms return to Jason for the defect review before anything is digitized.

## 9. Five Measurement Defect Probes
- **Defect 1 — SILENCE ≠ COUNTEREVIDENCE.**
  *Pilot scenario:* Day-0 calibration — Jason reads five mini-scenarios (A behavior occurs; B successful contrary behavior; C opportunity, not done; D not observable; E no meaningful opportunity) while both coaches independently mark one row each; plus every focus round exercises ○OP/✗C live.
  *What to observe:* do ○OP, N.A., N.O., and ? actually get used; are ○OP and ✗C confused; do blanks appear where a state belongs.
  *Failure signal:* zero ○OP/N.A. usage all week, coaches reporting the distinction unclear, or transcription finding blank-means-no patterns.
- **Defect 2 — non-independent repeat ticks.** *Scenario:* the printed one-episode-one-row rule. *Observe:* rows-per-round bursts of identical entries. *Failure:* one breakdown episode producing tick storms.
- **Defect 3 — observer pooling/source.** *Scenario:* observer + source on every sheet; if video exists, one V-marked rating attempt. *Observe:* completeness of observer fields; V kept out of live-agreement comparison. *Failure:* anonymous rows or mixed sources.
- **Defect 4 — free text replacing canonical fields.** *Scenario:* notes column audited at transcription. *Observe:* rows where canonical cells are blank but the note carries the observation. *Failure:* the sheet turning back into diary entries.
- **Defect 5 — session-RPE granularity.** *Scenario:* RPE asked once per athlete at session end only. *Observe:* any per-round RPE or "he was fatigued" causal notes. *Failure:* RPE treated as a within-round fatigue fact.

## 10. #358 Input Compatibility Probe
- **Trial/opportunity:** a genuine chance per the behavior's registry definition — explicitly logged ONLY in focus and co-rated rounds (○OP / ✗C). Outside those rounds, denominators are not captured.
- **Occurrence:** a ✓ row. **Counterexample:** a ✗C row (opportunity + successful contrary execution, witnessed).
- **Excluded states:** N.O., N.A., ?, and all unmarked silence are excluded from any denominator. **UNKNOWN in denominator: NO. NOT OBSERVABLE: NO. NO OPPORTUNITY: NO.**
- **Current compatibility (design-side answer; repo unverified from this seat):** the paper protocol yields two stream classes — dense occurrence-only rows most of the time, and sparse opportunity-complete windows in focus/co-rated rounds. If #358 models sessions as uniform Bernoulli trial sets, or lets absence enter as zeros, that is a mismatch.
- **Cross-review concern (flag, do not fix here):** #358 must consume the two stream classes distinctly (or normalize by exposure), and must never impute silence. This is the standing Defect-1 review probe, now with the pilot's exact state semantics attached.

## 11. #355 Input Compatibility Probe
- **Required inputs:** baseline observations, intervention start, exposure, fidelity, post observations, retention, transfer, outcome direction.
- **Capturable:** all of the above via ordinary rows + the half-sheet: baseline = pre-start rows; start = dated event; exposure = tally; fidelity = Y/P/N; post = later rows (phase derived); retention = scheduled flagged session with the no-recue rule; transfer = derived from context letters; INTENDED direction = declared at start (RC-2).
- **Missing / cannot realistically be produced:** fixed, evenly spaced measurement occasions and opportunity-complete baselines. Coaching reality gives irregular schedules and opportunity-sparse phases.
- **Concern:** #355 must tolerate irregular observation schedules and sparse denominators, and must have no field to ingest hindsight "it worked" judgments — the paper protocol deliberately produces none. No SCD thresholds selected here.

## 12. #357 Input Compatibility Probe
- **Required inputs:** same unit, independent human ratings, common behavior definition, common opportunity definition, linked ratings, explicit missing/not-observable states.
- **Capturable:** all six, via the co-rating card (group ID, read-aloud definition, ○OP marking, independence rule, ?/N.O. states).
- **Missing:** volume. 2–3 co-rated rounds/week yields very few units; multi-rater agreement statistics on that volume are unstable.
- **Concern:** sparse co-rating must resolve to **"measurement design insufficient (yet)"** — an abstention — and NEVER to "athlete evidence is weak." Reliability sample size is a property of the protocol, not of the athlete. #357 should abstain by design below adequate unit counts; the mechanism is design, the number is policy and is not set here.

## 13. Coach Burden Review
- **Time burden to track:** rough seconds per row (target feel: 10–15s — `PILOT OPERATING TARGET`), and whether capture competed with coaching attention.
- **Confusion signals:** states mixed up (esp. ✗C vs ○OP), context letters disputed, behavior definitions argued mid-session.
- **Free-text overuse signal:** notes carrying observations that belong in canonical cells (Defect 4).
- **Abandonment signal:** rows/sheets that simply stop mid-session, fields habitually skipped, coaches reverting to memory-based end-of-session summaries.

## 14. End-of-Week Review Form
1. Which fields were unclear? (name them)
2. Which fields were unnecessary?
3. Which distinctions were difficult in the moment? (✓/✗C/○OP/N.O./N.A./? — circle the pairs you mixed up)
4. Which behavior definitions produced disagreement between coaches?
5. When did "no opportunity" (N.A.) actually occur? Give one example.
6. When did free text feel necessary? What couldn't the columns hold?
7. What slowed capture the most?
8. What did you stop recording because it was too burdensome?
9. What did you wish you could record but couldn't?
10. Did the focus round change how you watched? Better or worse?
11. If we ran this every week, what one change would you demand first?

## 15. Spreadsheet Transcription Contract

| Column | Source on paper | Controlled/free | Unknown semantics | Notes |
|---|---|---|---|---|
| sheet_id | Sheet header | controlled | — | Preserves paper linkage |
| date / session_id / session_type / minutes | Header | controlled | blank→BLANK | Session-level |
| observer | Header | controlled | never blank | Defect 3 |
| source | Header (H/V) | controlled | never blank | V excluded from live-agreement stats |
| row_num | Row # | controlled | — | Original order preserved |
| round | Rnd | controlled | `?` preserved | orderingKey |
| athlete_code | Row | controlled | never blank | Codes, not names |
| behavior_code | Row | controlled | never blank | Registry card v-pilot |
| state | Row STATE | controlled: OCCURRED / COUNTEREXAMPLE / OPP_NO_OCCURRENCE / NOT_OBSERVABLE / NO_OPPORTUNITY / UNKNOWN | UNKNOWN is a value; a truly blank cell transcribes as BLANK, never as UNKNOWN, never as zero | The six-state spine |
| context_letter | Ctx | controlled | `?` preserved | Pilot-provisional set |
| partner_code | Row | controlled | `–`→NOT_APPLICABLE | Minors: codes only |
| note_verbatim | Row note | free | — | Never converted to tags |
| corating_group_id | Card | controlled | blank→BLANK | Both raters' rows kept; disagreement never cleaned away |
| correction_flag | Strike-throughs | controlled | — | Original text also transcribed |
| intervention_id / exposure_tally / fidelity | Half-sheet | controlled | blank→BLANK | Separate tab mirrors half-sheet |
| intended_direction | Half-sheet | controlled | — | RC-2; never an outcome claim |
| rpe / rpe_athlete | Footer | controlled 0–10 | `?` preserved | Session-level tab, one row per athlete |

Raw paper is retained after transcription. Nothing is cleaned, merged, reconciled, or inferred during entry.

## 16. Pilot Decision Rules
- **KEEP:** coaches used the states and letters as defined, burden was sustainable, and transcription found the records interpretable without guessing. Adopt the protocol for continued capture (still pilot-scoped semantics until v0 §15 ratifications).
- **REVISE:** specific, repeated ambiguity or burden localized to identifiable fields, states, or definitions — cut v0.1 candidates and pilot again on the changed parts.
- **BLOCK:** coaches could not reliably distinguish occurrence / opportunity / counterexample even after Day-0 calibration and a mid-week refresh — downstream inference would rest on indistinguishable inputs; stop and redesign measurement before any digitization.
- **INSUFFICIENT PILOT EVIDENCE:** too few sessions, sheets, or co-rated units actually happened to judge the protocol. Re-run; draw no conclusion.
These dispositions judge the protocol. They are never athlete scores and never algorithm validation.

## 17. Owner Decisions Required
1. Initial the Behavior Registry Card (≤10 coach-drafted codes) and the context-letter set — **pilot-scoped approval**.
2. Choose which already-planned intervention(s), if any, get half-sheeted this week (0–2).
3. Schedule the 2–3 co-rated rounds.
4. Confirm storage location and custody of the athlete code→name key.
5. Approve the session-RPE wording for youth use (pilot-scoped).
6. Name the transcriber (Jason or a designated coach).

## 18. Cross-Review Triggers
- **#358:** silence handling; dual stream classes (occurrence-only vs opportunity-complete); exposure normalization; no imputation of blanks (§10).
- **#355:** irregular schedules; opportunity-sparse baselines; absence of any hindsight-outcome input to consume; INTENDED-direction as the only directional capture (§11, RC-2).
- **#357:** sparse-unit abstention ("insufficient reliability data" ≠ weak athlete evidence); video-source exclusion from live human agreement (§12).
- **Vocabulary v0:** RC-1 (UNKNOWN as first-class state) and RC-2 (intended vs actual outcome direction) for v0.1 consideration — no silent modification made.

## 19. Smallest Useful Next Action
Hold the **Day-0 setup meeting**: coaches draft the ≤10-code Behavior Registry Card, Jason initials it and the context-letter set (pilot-scoped), run the 5-minute A–E calibration drill, print the pack — capture starts at the next session.

# STATE DELTA

**Changed:** paper pilot package produced as an operational layer over frozen vocabulary v0 — four print-ready instruments, seven-day protocol, five defect probes, three PR input-compatibility probes, transcription contract, decision rules. Two VOCABULARY REVISION CANDIDATEs recorded (RC-1 UNKNOWN as first-class state; RC-2 intended vs actual outcome direction).
**Superseded:** the bare "printable sheets" offer from the prior turn — absorbed into this full package. Nothing in v0 modified.
**Current algorithm stack:** unchanged, owner-attested — main (#337 merged, e2a5570) → #358 Phase A inference → #355 SCD → #357 observer reliability; #354 closed. Independent re-fetch failed again this session; repo-capable lane confirms.
**Next:** Day-0 setup meeting per §19 → one week of capture → sheets and review forms back for defect review before digitization. #358's diff + deliverable report remains the standing cross-review trigger, now carrying §10's exact state semantics as the Defect-1 probe.
**Package/spec gate:** vocabulary v0 FROZEN and untouched; pilot package DRAFT awaiting the six §17 pilot-scoped approvals; repo-canonical Stack v1.1 still NOT VERIFIED from this seat.
**Research/calibration gate:** the pilot validates no statistic and ratifies no threshold; every number in it is labeled PILOT OPERATING TARGET — NOT ALGORITHM THRESHOLD; #345 boundary intact.
**Safety/D10:** unchanged — separate safety workstream. Sheets carry athlete codes only, key held separately; no diagnoses, clearance status, personality typing, mental-health inference, or protected-characteristic fields anywhere in the package.

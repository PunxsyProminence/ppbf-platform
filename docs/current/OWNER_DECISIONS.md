# Owner Decisions

The record of decisions Jason has actually made, in his own words, with the
evidence each was made on.

This file exists because a decision that lives only in a chat log is not a
decision any session can check. On 2026-08-27 the drill/cue read policy was
ratified and written down nowhere. #754 merged the next day as `81e27e72`
carrying test expectations that asserted the opposite -- `board` admitted to
the drill library -- and `main` shipped code contradicting a ruling that had
already been made. Establishing *when* the ruling happened later took an hour
of forensics across PR bodies and commit timestamps, and produced only a
one-hour bracket, because the sole trace was an undated code comment on an
unmerged branch. That is the cost this file is here to stop paying.

## What belongs here

A decision the owner made that governs code, schema, policy, or how AI work is
done, where a session could otherwise build the opposite in good faith.
Jason's decisions are recorded only here, by Claude, quoting him
(OD-2026-09-28-003). That includes release decisions -- what was frozen,
refused, or abandoned. Until 2026-09-21 those were recorded in
`docs/current/AI_RELEASE_CONTROL.md`; that record is now in
`docs/archive/2026-09-21_AI_RELEASE_CONTROL_before_condense.md`. Release
procedure is `docs/AI_DELIVERY_PIPELINE.md`.

Not here: work assignments, scope for a single ticket, or anything a session
may decide for itself. `docs/current/ACTIVE_WORK.md` holds blocked and parked
work.

## How to use it

**Before writing a test, gate, or migration that asserts a policy, read this
file.** If the policy is here, or in a source listed under "Decisions recorded
elsewhere" below, build to it. If it is in neither and you need it
decided, say so and stop -- `AGENT_KERNEL.md` classifies that as
**OWNER DECISION REQUIRED**, and inventing the answer is the failure mode this
file was written after.

If code you are reading contradicts an entry here, that is a finding. Report
it. Do not assume the entry is stale.

## Decisions recorded elsewhere

Owner rulings that predate this file, or were written where the work happened,
still live in these places (index added 2026-09-28 from the documentation
review, finding F29). The source is the record; this list only says where to
look. When one of them governs new work, record it here as a new entry quoting
the source.

- `docs/current/ACTIVE_WORK.md`, "Standing owner directions (2026-08-15/16)" --
  not yet entries here.
- `docs/PLATFORM_AUDIT_2026-07-31_DECISIONS_MADE.md` -- the 2026-07-31 audit
  decisions, as made.
- `docs/VISUAL-RESET-PHASE-1-PLAN.md`, section 11 "Owner decisions -- ANSWERED
  2026-08-23". Its decision 1 (rooms retired as a visual concept) is superseded
  by the room map approved 2026-09-26 (`docs/ROOM-MAP.md`) and
  OD-2026-09-28-009 item 3.
- `docs/ROOM-MAP.md` -- the room map and build order, approved in shape
  2026-09-26.
- `apps/web/public/plates/README.md` -- owner instructions on plates
  (2026-09-26).
- `docs/PLATFORM_AUDIT_2026-08-28_ROUTE_REACHABILITY.md` -- "Owner decision,
  2026-08-29: portrait review stays admin-only".
- `docs/design/CHECKIN_API_CONTRACT.md` -- resting heart rate, HRV and blood
  pressure deferred, not dropped.
- `AGENT_KERNEL.md`, "Authority doctrine (owner decision, 2026-08-20)" -- the
  coach decides inside clearance and policy, and may not override a medical
  hold, consent, safeguarding, law or an authorization boundary.
- `docs/SHADOW_ML_ARCHITECTURE_SPEC.md` -- §2.3 "SUPERSEDED IN PART --
  2026-08-23. Owner decision." (learning styles and personality scores
  withdrawn), and the Heavy Bag cap being per user, not per organization
  (owner decision, 2026-08-01).
- `docs/capabilities/modules/036-periodization-block-planning-engine.md`,
  audit log -- two owner decisions of 2026-08-28 (nutrition_body_composition
  admitted; "Admin and coaches" author blocks and objectives).
- `docs/capabilities/proposals/engine-unlock/036a-plan-vs-actual-execution-design.md`,
  §5 -- "ANSWERED -- owner, 2026-08-28".
- Module audit logs, for example `docs/capabilities/modules/008-coach-review-system.md`
  and `130-evidence-quality-engine.md` -- the one blanket manual-verification
  sign-off of 2026-08-28 (not 47 separate inspections).
- `docs/archive/2026-10-02_HANDOFF_VISUALS.md` (moved from `docs/HANDOFF_VISUALS.md` on 2026-10-02), "Job 3" (owner decision, 2026-08-17), restated in
  `docs/AGENT_BRIEFING_PROMPT.md` -- the six Capability Console pages stay
  unstyled, because they show fabricated data.
- `apps/web/app/api/pilot/progression/assignments/cancel/route.ts`, header
  comment -- owner decisions of 2026-09-22 on cancelling assigned work: cancel
  only (no edit, no delete, no undo or reopen), open work only, and "Coaches
  with access" may cancel. See the Status line on OD-2026-09-19-002.
- Test headers that carry the ruling they enforce:
  `apps/web/src/design/legacyVisualVocabulary.test.ts` (2026-08-23, Leather &
  Brass retired as the look, with its type voices). The 2026-08-19 safety-red
  reservation was stated in the header of the now-deleted
  `apps/web/src/design/safeguardingRedReservation.test.ts` and restated in the
  code and docs that OD-2026-09-29-001 lists; that entry supersedes it. The
  refusal stamps' own form of it (MEDICALLY_NOT_ALLOWED is their one red mark,
  `apps/web/components/RefusalStamp.tsx:10-17`) was not changed.
- `docs/archive/2026-09-28_CROSS_SESSION_NOTES.md` -- rulings resolved in the
  old running log (history).
- The old OneDrive ledger, `PPBF-AI-Lanes/PPBF_DECISION_HANDOFF_LEDGER.md`
  (history since 2026-09-28, OD-2026-09-28-003): LEDGER-0015 to -0019 record
  owner decisions for the A-FIN slices; LEDGER-0004's recommendation
  directions G1-G6 are parked and were never promoted.

## Honesty rules for entries

These follow "Report the check, not the conclusion" in `AGENT_KERNEL.md`.

- **Quote the owner verbatim.** A paraphrase is an interpretation, and the
  interpretation is the thing that goes wrong. Where the words alone do not
  carry the decision -- "go with A" -- record what A was, as it was put to
  him, so the choice can be read without the surrounding conversation.
- **Mark provenance.** `PRIMARY` means the owner's own words are recorded
  here. `RECONSTRUCTED` means the text was recovered from an artifact written
  by someone else, and it says which artifact and what is uncertain.
- **Name the evidence the decision rested on**, with the run, PR or SHA that
  proves it. A decision made on a measurement that later changes is worth
  re-opening; one made on nothing is worth knowing about.
- **Record it at ratification, not at merge.** The gap between the two is
  exactly where #754 went wrong.
- **Do not edit a decision.** Supersede it with a new entry that says what it
  replaces and why. When later facts change what an entry reports, append a
  dated `Status (YYYY-MM-DD):` line under it; the decision text stays as
  written.
- **One id, once.** Before adding an entry, grep `## OD-<date>-` for the next
  free number. `scripts/check-owner-decision-ids.mjs` fails if a heading id
  repeats or is malformed; CI runs it on every change, docs-only included
  (`.github/workflows/ci.yml`, "Check owner decision ids are unique").

Newest first.

## A pattern this file exists to shorten

Twice on 2026-08-28, `main` carried a test suite asserting the opposite of a
ruling the owner had already made, and in both cases an open PR was the
correction:

| ruling | `main` asserted the opposite in | corrected by | window |
|---|---|---|---|
| OD-2026-08-27-001 (board denied) | #754, merged `81e27e72` | #755, merged `61b20e9d` | ~75 minutes |
| OD-2026-08-28-005 (content class) | #811, merged `948f6d18` | #817 | open at time of writing |

Status (2026-09-28): #817 merged 2026-08-28 as `d08ca4dd`.

The two are not the same failure and should not be filed as one.

#754 is the one this file was written after. Its expectations were already
wrong when it merged, and nothing in the repository recorded the ruling that
made them wrong, so no session could have known.

#811 is the honest version. It was written BEFORE the ruling, its body said in
terms that the posture was open and unsettled, and its tests pinned the current
behaviour precisely so a change could not happen silently. Then the ruling
came, and the pin did exactly what a pin is for: it made the correction
explicit and reviewable instead of invisible.

**So a characterization test that merges and is then inverted is not a defect.**
The defect is a test that asserts a posture while claiming, in a comment, to
pin a decision it cannot detect a change to -- which is what #811 was itself
written to fix in two other files.

What this file can shorten is only the first shape: a session about to assert a
policy can now check whether one has been ruled. It cannot prevent the second,
and should not try to.

---

## OD-2026-10-04-007 -- Jump test and coach skill ratings: 1-5 rating wording draft approved; jump test choice not settled

**Provenance: PRIMARY (typed reply, not an AskUserQuestion).** Jason's reply in
the jump test lane (`~/.claude/projects/C--Dev/f3dd76eb-6f71-49ab-8543-9d9537c3520e.jsonl`,
user message uuid `ff343985-bf7c-4c7b-a7e3-82c048334a27`, 2026-10-04T03:19:12Z).
It answers the lane's assistant message of 2026-10-04T02:59:57Z, which posed two
numbered questions with lettered options. New; edits no earlier entry.

The reply, verbatim: *"Q1 can it be both or either Q2 A"*.

**Q2, rating wording.** The lane asked: "What should each 1-5 skill rating say?"
with option "A. Use this draft and edit it if you want (recommended)" (the
draft: 1 Learning, 2 Developing, 3 Solid, 4 Applies, 5 Sharp, each with the
one-line description in that message) and option "B. You give me your own
wording". Jason answered "A". **Ruling: the 1-5 skill rating draft in that
message is the starting wording (Jason did not supply edits in the reply).**

**Q1, jump test.** The lane asked: "Which jump test should the app record?" with
options A (countermovement jump height in cm, best of 3), B (standing broad jump
distance in cm, best of 3) and C (something else). Jason's words "can it be both
or either" are a question about whether more than one test may be offered, not a
choice of A, B or C. **No ruling is recorded for Q1.** Recorded only so no
session reads "both" or "either" as decided.

---

## OD-2026-10-04-006 -- Body mass at check-in: everyone may log it, youth entries limited; flag a change of more than 5% in 7 days; the organization admin keeps access

**Provenance: PRIMARY.** Jason's answers to two AskUserQuestions in the body
mass lane (`~/.claude/projects/C--Dev/d5d94cf1-c5b0-4b8a-9150-9c395d0126a7.jsonl`).
First: tool use `toolu_017vDyJwmgGXyzwf6tVGyPjh`, asked 2026-10-04T02:58:47Z,
answered 03:20:23Z. Second: tool use `toolu_015q5JApQJ2TTawHfyh2n3x7`, asked
03:23:07Z, answered 03:28:20Z. Read by script from that transcript (records pass, 2026-10-04). New; edits
no earlier entry.

**Population.** Asked: "Body mass at check-in - which population may enter it?
(A) adults only; (B) everyone, with youth entries visible only to the athlete's
coach and parents; (C) skip this item." Jason chose *"B everyone, youth limited
(Recommended)"*, option text "All athletes can log; youth weight visible only to
their coach + parents." **Ruling: all athletes may log body mass at check-in;
a youth athlete's body mass is limited to their coach and parents (see the
organization admin ruling below).** The other options were "A adults only" and
"C skip".

**Fast-change flag.** Asked: "Fast-change flag rule shown to coaches - window and
threshold?" Jason chose *">5% in 7 days (Recommended)"*, option text "Flag when
weight changes more than 5% within 7 days." **Ruling: the coach sees a flag when
body mass changes by more than 5% within 7 days; the flag is a prompt to talk to
the athlete, not a diagnosis.** The other options were ">3% in 7 days" and ">2%
in 7 days".

**Organization admin.** Asked: "For a youth athlete's body mass and fast-change
flag, the existing athlete-record gate (assertActorCanAccessAthlete) admits: the
athlete, their assigned/covering coach, linked parents, AND the organization
admin (ppbf@). Keep the organization admin in?" Jason chose *"Yes, keep org
admin (Recommended)"*, option text "Youth weight: athlete, assigned/covering
coach, linked parents, org admin." **Ruling: a youth athlete's body mass and
fast-change flag are readable by the athlete, the assigned or covering coach,
linked parents and the organization admin, via the existing gate unchanged.**
The other option was "No, coach + parents only".

---

## OD-2026-10-04-005 -- Technique order on the athlete pathway: the 00_MASTER_SKILL_REGISTRY.xlsx Skill_Index prerequisites are the source, and the registry order wins

**Provenance: PRIMARY.** Jason's answers to an AskUserQuestion in the technique
order lane (`~/.claude/projects/C--Dev/02f100a2-4872-4eda-be5c-861a42b54a1e.jsonl`,
tool use `toolu_01TeR4XjvwoTctQzfcc3SxKR`; asked 2026-10-04T03:04:52Z,
answered 03:11:05Z). Read by script from that transcript (records pass, 2026-10-04). New; edits no
earlier entry.

**Prerequisite source.** Asked: "Is the Skill_Index sheet in SharePoint Club
Ops .../LEGACY_PRO_BOXING_REFERENCE_ONLY/00_MASTER_SKILL_REGISTRY.xlsx the
prerequisite source your decision D1-A (2026-09-11) promoted?" with its listed
prerequisite values (Jab needs Stance; Rear-hand needs Stance+Jab; Hook needs
Stance; Uppercut needs Stance+Rear-hand+Hook; Defense-to-Counter needs Stance;
Footwork needs Stance+Jab; Perception needs Stance+Jab; Feints need
Jab+Perception; Body needs Stance through Uppercut). Jason chose *"Yes, use it
(Recommended)"*, option text "Those prerequisites go into the app as the
official family order data." **Ruling: the Skill_Index prerequisites in
00_MASTER_SKILL_REGISTRY.xlsx, as listed in that question, are the source for
the technique family order.** The other options were "No, different source" and
"Use it, with edits".

**Footwork versus the coach-consensus order.** Asked: "The coach-consensus order
puts Footwork 2nd, before straight punches. The registry makes Footwork/Ringcraft
(SKILL-07) require Jab (SKILL-02). Which order should the athlete page follow?"
Jason chose *"A: Registry wins (Recommended)"*, option text "Order comes from
the prerequisites. Coach-consensus only breaks ties between families on the same
level. Combos/distance/style aren't families, so they aren't shown." **Ruling:
the athlete page follows the registry prerequisites; Footwork comes after Jab;
coach-consensus order only breaks ties between families on the same level.**
The other options were "B: Coach-consensus wins" and "C: Show both".

---

## OD-2026-10-04-004 -- Sparring over a coach-set cap: warn only, record the entry, the coach decides

**Provenance: PRIMARY.** Jason's answer to an AskUserQuestion in the sparring
caps lane (`~/.claude/projects/C--Dev/42a7f511-6af8-4339-828d-fed4471df7fe.jsonl`,
tool use `toolu_014w9EE5pWkcd36VufJPRznn`; asked 2026-10-04T03:01:10Z,
answered 03:14:32Z). Read by script from that transcript (records pass, 2026-10-04). New; edits no
earlier entry.

Asked: "When a sparring entry goes over an athlete's coach-set cap (a contact
stage above their highest allowed stage, or more hard/open sessions this week
than their max), should the app: (A) Warn only (Recommended) ... (B) Block ...
(C) Block for minors, warn for adults?" Jason chose *"Warn only
(Recommended)"*, option text "Entry saves with a visible warning and the cap
shown. The record stays true to what happened on the floor; coach decides.
Matches 'coach decides, no auto-block'." **Ruling: a sparring entry over an
athlete's cap is saved with a visible warning and the cap shown; it is never
blocked, for minors or adults.** The other options were "Block until cap
raised" and "Block minors, warn adults".

Built in #1178 (coach-set caps) and #1182 (ladder stage and cap check).

---

## OD-2026-10-04-003 -- Tagged sparring/bout clips: staff only, any consent block blocks the whole clip, a coach may review if any athlete is theirs, a coach may untag unless consent blocks

**Provenance: PRIMARY.** Jason's answers to two AskUserQuestions in the video
tagging lane (`~/.claude/projects/C--Dev/adc36815-821b-4839-a202-abd4f0051cea.jsonl`).
First: tool use `toolu_019HMoxXXKaszndBkWMAofV1`, asked 2026-10-04T03:02:08Z,
answered 03:14:16Z. Second: tool use `toolu_01EogGTUiYL1d9WHh1bdc5hE`, asked
04:56:32Z, answered 04:57:59Z. Read by script from that transcript (records pass, 2026-10-04). New; edits
no earlier entry.

**Who may view.** Asked: "Which roles may view a sparring/bout clip tagged to
an athlete?" Jason chose *"Staff only (Recommended)"*, option text "Plain: only
coaches and the gym admin can watch tagged clips. Athletes and parents don't
see them in the app yet. Safest start; we can open it later." **Ruling: only
coaches and the organization admin may watch tagged clips; athletes and parents
may not yet.** The other options were "Staff + tagged athlete/parents" and
"Staff + athletes, not parents".

**Multi-athlete consent.** Asked: "When a clip shows several athletes, does a
withdrawn or photo-only media consent for ANY one of them block playback of the
whole clip?" Jason chose *"Any block blocks all (Recommended)"*, option text
"Plain: if one kid's parent said no to video, nobody can play that clip,
including coaches, until it's fixed or that kid is untagged." **Ruling: one
athlete's withdrawn or photo-only media consent blocks playback of the whole
clip for everyone.** The other option was "Block only that athlete's view".

**Coach scope.** Asked: "May a coach review a tagged clip if ANY athlete in it
is on their roster/coverage, or only if ALL are?" Jason chose *"Any of theirs
(Recommended)"*, option text "Plain: a coach can watch a sparring clip of their
kid even if the partner belongs to another coach." **Ruling: a coach may review
a tagged clip if any athlete in it is theirs, subject to the consent rule
above.** The other option was "All must be theirs".

**Tag removal.** Asked: "A coach can remove an athlete's tag from a clip. If
that athlete's parent has withdrawn video consent, removing the tag lifts the
block even though the child is still in the footage. Who may remove a clip
tag?" Jason chose *"Coach, unless consent blocks"* (not marked Recommended; the
recommended option was "Admin only"), option text "Plain: a coach can fix their
own tagging mistakes, but can't remove a tag from a kid whose parent has
withdrawn or limited video consent. That case needs the admin." **Ruling: a
coach may remove a tag, except from an athlete whose parent has withdrawn or
limited video consent; that case needs the admin.** The other options were
"Admin only (Recommended)" and "Any coach of that athlete".

Built in #1176 (schema and consent gates) and #1184 (tag, untag and clip-list
routes).

---

## OD-2026-10-04-002 -- Adult pathway stages: coach-set, named Foundation / Intermediate / Advanced / Elite, checkpoint goals and caveat wording approved

**Provenance: PRIMARY.** Jason's answers to an AskUserQuestion in the adult
pathway lane (`~/.claude/projects/C--Dev/d32d7163-448d-4f65-a425-7b2496e44dcc.jsonl`,
tool use `toolu_01RJoAZySuHLDMN81f4ue51p`; asked 2026-10-04T03:02:45Z,
answered 03:13:13Z). Read by script from that transcript (records pass, 2026-10-04). New; edits no
earlier entry.

**Stage source.** Asked: "should an adult athlete's pathway stage be
COACH-SET (stored, with history and who set it), DERIVED (computed from
training hours/competence), or DISPLAY-ONLY (stages shown as reference,
nothing stored per athlete)?" Jason chose *"Coach-set (Recommended)"*, option
text "Coach picks the stage; app keeps history; goals ticked off by a coach.
Needs a database change (separate PR, extra review). Matches 'never automatic
promotion'." **Ruling: an adult athlete's pathway stage is set by a coach and
stored with history; it is never derived or promoted automatically.** The
other options offered were "Display-only" and "Derived".

**Stage names.** Asked: "use the synthesis names Foundation / Intermediate /
Advanced / Elite?" Jason chose *"Use as-is (Recommended)"*, option text
"Foundation, Intermediate, Advanced, Elite." **Ruling: the four stages are
named Foundation, Intermediate, Advanced and Elite.** The other option was
"I'll give other names".

**Goals and caveat wording.** Asked: "approve these checkpoint goals (each
ticked only by a coach)?" followed by the full goal text for the four stages
and the caveat line "These time ranges are rough estimates, not
research-backed. Everyone moves at their own pace; a coach decides when a stage
is reached." Jason chose *"Approve (Recommended)"*, option text "Use the
wording above." **Ruling: the checkpoint goals and the caveat line, as worded
in that question in the transcript, are the approved text; each goal is ticked
only by a coach.** The other option was "Edit wording".

Built as far as the reference page in #1173 (PR-A).

---

## OD-2026-10-04-001 -- Injury records: athletes and linked guardians read their own, staff notes hidden; the coach injury log is its own page, the Sports Medicine board's 2026-08-15 rule stays

**Provenance: PRIMARY.** Jason's answers to an AskUserQuestion in the injury
record lane (`~/.claude/projects/C--Dev/9863d78a-dd0d-44c7-a482-ca1eaaf334d6.jsonl`,
tool use `toolu_01Cu6GHiqETzbH5woYPWVhJC`; asked 2026-10-04T03:02:53Z,
answered 03:12:19Z). Read by overwatch in that transcript. New; edits no
earlier entry.

**Visibility.** Asked: "should athletes and their linked guardians get a
read-only view of their OWN injury records (date, body area, type, return
date — no staff notes)?" Jason chose *"Yes, read-only own (Recommended)"*,
whose option text was "Athlete + linked guardians see their own records' basic
fields; staff notes hidden." **Ruling: an athlete and that athlete's linked
guardians may read the athlete's own injury records, read-only, basic fields
only; staff notes are never sent to them.** The other options offered were
"No, staff only" and "Guardians only".

**Placement.** Asked: "Put the injury log on a separate coach page linked from
that board, keeping the rule?" (the Sports Medicine board's 2026-08-15 rule
that it shows clearance and holds only, never diagnoses or clinical detail).
Jason chose *"Separate page (Recommended)"*, option text "New /coach/injuries
page, linked from Sports Medicine; your 2026-08-15 rule stays untouched."
**Ruling: injuries live on their own coach page, /coach/injuries; the Sports
Medicine board gains only a link and its 2026-08-15 rule is unchanged.**

Built in #1175 (storage), #1180 (coach route), #1181 (coach page) and #1183
(athlete and guardian read view). The work came from Jason's elite-boxing
direction in the overwatch thread, 2026-10-04: *"If we need to add
capabilities we will"*.

---

## OD-2026-10-03-018 -- Lanes put their questions to Jason in their own lane

**Provenance: PRIMARY.** Typed by Jason on 2026-10-03 (US Eastern; times UTC)
in the overwatch thread
(`~/.claude/projects/C--Dev/c2e29ade-d3b8-4a8a-bf98-07b855ff2047.jsonl`). It
was typed while overwatch's turn was running, so the transcript holds it as a
queued message of human origin (`attachment` of type `queued_command`,
`origin.kind: "human"`, enqueued 10:35:00.291Z). Read by the records lane in
that transcript. New; edits no earlier entry.

It answers no question. Overwatch had just relayed two lanes' questions to him
(10:33:03Z, the "neutral" stance question from BIOMECH-01a; 10:33:39Z, the
tablet hand-over's H1-H8). Jason, whole message (10:35:00.291Z): *"i will
answer the lanes questions in thier lane"*. **Ruling: a lane asks Jason its
questions in its own session, not through overwatch.** Overwatch read it so
(10:38:44Z): "from now on each lane asks you its questions directly. I've
moved the two open ones to their lanes". The rest of the OVERWATCH rule in L2
(overwatch answers technical, how-to and scope questions) is not changed by
this entry.

---

## OD-2026-10-03-017 -- Pain reports: critical pain no longer wears the medical-stop colour either; "no restriction on building because of the red color" (PR #1119)

**Provenance: PRIMARY.** Typed by Jason on 2026-10-03 (US Eastern; times UTC)
in the pain-tone lane's thread
(`~/.claude/projects/C--Dev/86de01b8-5d71-4b41-b7d7-7c0df7fa4fed.jsonl`, a
user message of human origin) and read by the records lane in that
transcript. Built by PR #1119 (merge
`1fcfc8c200ed7ede6ecf53df34a908dba028f9e6`, 2026-10-03T17:04:26Z), whose body
quotes his answer as its scope. New; edits no earlier entry. It applies
OD-2026-09-29-001 (red is not reserved; `--locked` still means a medical
stop) and does not change it.

The lane's question (15:30:31Z), after it had moved **high** pain from
`locked` to `restricted`: "**Critical pain colour.** Should a critical pain
report keep the medical-stop red (`locked`)? - **A (recommended):** yes, keep
it red. - **B:** move it down a step too, since a pain report is not itself a
medical stop." with the plain line "the rule says red means "a medical
professional said this athlete can't train." So the question is whether a
critical pain report should look like that, or only like a serious warning."
Jason, whole message (15:37:15.583Z): *"B there should me no restriction on
building because of the red color"*. **Ruling: B, over the lane's
recommendation. A pain report is not a medical stop at any severity; critical
pain takes the `restricted` tone, like high and moderate; low stays
`monitor`.** Recorder's reading, not his words: the second half restates
OD-2026-09-29-001, that red being reserved is no reason to hold back a build.

Built (PR #1119's body, read): `painSeverityTone` in
`apps/web/components/CoachWorkspace.tsx` maps critical, high and moderate to
`restricted` and low to `monitor`; no pain severity renders `locked`. Not in
that PR: the pain-report and escalation card frames still use the locked
colour at every severity (its "Out of scope"). Not checked by a person on
screen.

---

## OD-2026-10-03-016 -- Jason can start chips through a remote desktop app; new work goes up as chips again

**Provenance: PRIMARY.** Typed by Jason on 2026-10-03 (US Eastern; times UTC)
in the overwatch thread
(`~/.claude/projects/C--Dev/c2e29ade-d3b8-4a8a-bf98-07b855ff2047.jsonl`, a
user message of human origin) and read by the records lane in that
transcript. New; edits no earlier entry.

Earlier that day overwatch had told him (18:28:49Z) "**Remote (phone or
claude.ai):** chips generally can't be clicked from there" and offered "**A
(recommended while you're away):** reply **"start them"** and I'll run both
waiting jobs ... as background agents inside this thread"; he wrote *"Im
remote"* and overwatch ran them that way (OD-2026-10-03-007 section 4). Jason,
whole message (19:36:17.652Z): *"If you pull chips up I can access the
desktop through a remote ap"*. It answers no question put at that moment.
**Ruling: when he is away, overwatch still offers new work as chips; he starts
them through a remote desktop app.** Overwatch read it so (19:36:21Z): "chips
it is from now on; you'll click them through your remote desktop app. The jobs
already running as background agents carry on here; new work goes up as
chips." This replaces, for new work, the background-agent route of 18:29Z.

---

## OD-2026-10-03-015 -- The chalkboard and the gym TV show boxing quotes too; a lane gathers attributed quotes for his approval; an in-app quotes library to add, edit and pull quotes from

**Provenance: PRIMARY.** Typed by Jason on 2026-10-03 (US Eastern; times UTC)
in the overwatch thread
(`~/.claude/projects/C--Dev/c2e29ade-d3b8-4a8a-bf98-07b855ff2047.jsonl`, user
messages of human origin) and read by the records lane in that transcript.
New. It **settles the open point in OD-2026-10-03-010 section 3** (whether
boxing quotes should also appear) and edits no other entry.

### 1. Boxing quotes too

Overwatch's re-asked set (19:29:11Z), Q3: "**Q3. Chalkboard and gym TV text**
- **A:** gym sayings only, as built. - **B:** boxing quotes too." with the
plain line "you mentioned "or boxing quote" in that lane; A keeps just the
gym's own sayings." (no recommendation). His first reply (19:30:42.167Z,
recorded in OD-2026-10-03-014) named "Q3" without a letter; overwatch asked
again (19:31:06Z): "For the chalkboard and gym TV text, is it **A** gym
sayings only, or **B** boxing quotes too?" Jason, whole message
(19:32:09.293Z): *"Q3 B"*. **Ruling: B. When there is nothing real to show,
the chalkboard and the gym TV may show boxing quotes as well as the gym's
sayings.** PR #1144's test that forbids stock boxing quotes (its body) was
written to the earlier build and changes with this.

### 2. Where the quotes come from, and a place to keep them

Overwatch (19:32:19Z): "**Question (official):** Where should the boxing
quotes come from? - **A (recommended):** a lane gathers well-known,
attributed boxing quotes from published sources, about 20-30, each with who
said it and where. You approve the list before it goes on screen. - **B:**
you supply the quotes yourself." Jason, whole message (19:33:52.681Z): *"A
and motivational sayings like embrace the suck, be there first, hold fast ect
we should have a place if posture to update add and pull quotes from it"*.
**Ruling: A, with two additions of his own.** (1) A lane gathers real,
attributed boxing quotes with their sources, and he approves the list before
anything goes on screen. (2) Motivational sayings such as "Embrace the suck",
"Be there first" and "Hold fast" go in alongside. (3) **The app gets a quotes
library**: a place in the app to add, update and pull quotes from, which the
chalkboard and the gym TV read. Recorder's reading, not his words: "a place
if posture" read as "a place in the app" ("posture" not otherwise
explained), and "ect" as "etc."; overwatch read it the same way (19:34:02Z):
"A quotes library in the app: a place where you (and coaches, if you want)
add, edit and remove sayings and quotes. The chalkboard and gym TV pull from
it."

State (OBSERVED on GitHub 2026-10-03): the starting list was gathered and sent
to him for approval (REPORTED by overwatch, 19:38:24Z); PR #1159 (quotes
library part 1a, storage and seed) is open. Overwatch split the rest: part 1b
the admin screen; part 2 switches the chalkboard and gym TV to the library
after he approves the starting list. **Open for Jason:** whether coaches may
add quotes too, or only the gym admin (overwatch, 19:38:37Z; built
admin-only for now); and the starting list itself.

---

## OD-2026-10-03-014 -- Overwatch assigns Fable's work through GitHub issues labelled "fable"; Fable builds and opens PRs and stops merging (supersedes the merging half of OD-2026-10-03-004); speed bar 100 ms; guardian move kept as built; "not visible" learned from each point's own location

**Provenance: PRIMARY.** Typed by Jason on 2026-10-03 (US Eastern; times UTC)
in the overwatch thread
(`~/.claude/projects/C--Dev/c2e29ade-d3b8-4a8a-bf98-07b855ff2047.jsonl`, user
messages of human origin) and read by the records lane in that transcript.
New. It **supersedes the first ruling of OD-2026-10-03-004** (the Fable
thread "merges its own PRs") as stated in section 1, and **settles the open
points of OD-2026-10-03-007 section 2** (the number) **and OD-2026-10-03-009
section 2** (the guardian re-ask). OD-2026-10-03-012 (overwatch assigns
lanes, the Fable session writes the code) is consistent with it and unchanged.

### 1. The question set

Overwatch had offered (18:53:25Z) "**A (recommended):** Fable plans as
`work-order` issues; my lanes build and I merge. **B:** Fable codes draft PRs;
my lanes check and I merge. **C:** keep today's setup: Fable builds and merges
in its own area." Jason, whole message (19:28:59.687Z): *"Ok so your gonna
assign work to it through gir hub ask the questions again"* ("gir hub" read
as "GitHub"). Overwatch re-asked (19:29:11Z), in part:

- "**Q1. How Fable and overwatch split work** - **A (recommended):** I assign
  Fable work through GitHub issues labelled `fable`, each with goal, files and
  "done when". Fable builds it and opens a PR; I scope-check and merge; Fable
  stops merging on its own. - **B:** same, but Fable keeps merging its own
  PRs. - **C:** Fable plans, my lanes build."
- "**Q2. Speed number for the tablet AI** - **A (recommended):** 100 ms per
  frame. - **B:** another number."
- "**Q3. Chalkboard and gym TV text** - **A:** gym sayings only, as built. -
  **B:** boxing quotes too." (no recommendation; see OD-2026-10-03-015)
- "**Q4. Guardian move, the re-asked option 2** - **A (recommended):** keep
  what was built in #1151. - **B:** tell me what you meant."
- "**Q5. How the pose AI learns "not visible"** - **A (recommended):** each
  point's visibility is read from its own spot, and your rule stays. - **B:**
  train hidden points as "nothing here", which changes your rule."

ending "Reply like **"1A 2A 3A 4A 5A"**, or "all recommended" (Q3 has no
recommendation, so name A or B)." Jason, whole message (19:30:42.167Z):
*"Q3 AND AGREE WITH THE REST OF QS RECOMENDATIONS"*. **Ruling: Q1 A, Q2 A,
Q4 A, Q5 A.** Q3 was settled by his next message, *"Q3 B"* (19:32:09.293Z;
OD-2026-10-03-015).

### 2. What each answer decides

- **Q1 A.** Overwatch assigns the Fable session's work as GitHub issues
  labelled `fable` in `PunxsyProminence/ppbf-platform`, each with the goal,
  the files allowed and "done when". Fable builds it and opens one PR;
  overwatch scope-checks and merges. **Fable no longer merges its own PRs.**
  This supersedes OD-2026-10-03-004's ruling B (*"let it merge on it own"*),
  and the L2 rule that only overwatch merges lane PRs applies to Fable again.
  OD-2026-10-03-004's second ruling (when Fable's usage runs out its lanes
  return to overwatch) is unchanged. Done (REPORTED by overwatch's write log,
  19:31:06Z): the label `fable` was created, and overwatch gave Jason a text
  to paste into the Fable thread.
- **Q2 A.** The tablet speed bar is **under 100 ms per frame**. Jason's "B"
  in OD-2026-10-03-007 section 2 named no number; this gives it.
- **Q4 A.** The guardian move stays as PR #1151 built it (the move takes the
  new email and creates the login in the same step). The unrecoverable wording
  of the re-ask in OD-2026-10-03-009 section 2 no longer matters to the build.
- **Q5 A.** The pose model learns whether a point is visible from each point's
  own location on the image; the rule as overwatch stated it (18:55:46Z), "not-visible points never teach a position", is unchanged. Recorder's
  reading: this governs the GPU lane's training work, not the app.

---

## OD-2026-10-03-013 -- SHADOW's coach chat gets the stricter Library search too

**Provenance: PRIMARY.** Typed by Jason on 2026-10-03 (US Eastern; times UTC)
in the overwatch thread
(`~/.claude/projects/C--Dev/c2e29ade-d3b8-4a8a-bf98-07b855ff2047.jsonl`, a
user message of human origin) and read by the records lane in that
transcript. New; edits no earlier entry. It extends OD-2026-10-03-005 (the
Library chat's fix) to SHADOW.

Overwatch (19:14:54Z), after the Library fix (PR #1154) was built: "**Question
(official):** The same search also feeds the **SHADOW coach chat**. With this
fix, SHADOW no longer uses weak matches as evidence, so it may cite fewer
sources. Should SHADOW get the stricter search too? - **A (recommended):**
yes. SHADOW is safer when it isn't built on weak matches. - **B:** no. Keep
SHADOW on the old search; that's an extra follow-up change." Jason, whole
message (19:24:10.422Z): *"A"*. **Ruling: A.** Overwatch took it as the answer
to that question (19:24:30Z: "Taking your **"A"** as the answer to my last
question: SHADOW gets the stricter search too ... If you meant "A" for a
different question, say which."); he did not correct it.

Done: PR #1154 merged as `7fc735d1ce06d780f3608e697d9a3746ad19ccb9`
(2026-10-03T19:44:17Z; OBSERVED on GitHub): whole-word matching, a minimum
relevance, a confidence level on every answer, a research request on a gap,
and SHADOW on the same search with its version raised from 3 to 4 (REPORTED
by overwatch, 19:44:34Z). On `main`, not yet in production (release 7).

---

## OD-2026-10-03-011 -- Release 6 to production: "Reply production" started the release; production moved to revision 0000164 (run 37139084060); the word "Green" came after the run had finished

**Provenance: PRIMARY.** Typed by Jason on 2026-10-03 (US Eastern; times UTC)
in the overwatch thread
(`~/.claude/projects/C--Dev/c2e29ade-d3b8-4a8a-bf98-07b855ff2047.jsonl`, user
messages of human origin) and read by the records lane in that transcript.
Both are single-word messages in the overwatch thread; "Reply production"
answers overwatch's ask, "Green" answers nothing. This entry records what
each was and what the repository and GitHub show happened. It is new and edits no earlier entry.

### 1. "Reply production" -- start release 6

The release was staged for his go. Overwatch's message (2026-10-03T16:28:27Z,
answering his "Give link", 16:28:20Z): "**Staging, to look first:**
https://app-ppbf-staging.purpledesert-3a75d580.eastus.azurecontainerapps.io -
**Production approval link:** that only exists once I start the production
deploy. Reply **"deploy production"** and I'll start it and send the approval
link right away." (Earlier, 16:04:18Z: "Release 6 is ready whenever you say
**"deploy production"**.", when release 6 was staged at main `ffa918f0`; main moved
and it was re-staged at `59877f04` before dispatch.) Jason, whole message (16:29:02Z): *"Reply
production"*. **Ruling: start the production release of release 6.** The
words differ from the phrase asked for ("deploy production"); overwatch read
them as the go and started the chain at once (its write log: "Authorizing
words: "Reply production""). Recorder's reading, not his words: that "Reply
production" meant "deploy production".

What ran (OBSERVED with `gh run view 37139084060` on 2026-10-03):
`deploy-production` run 37139084060, head
`59877f042cd88994a1e5d181e5543542cfa4ccb8` (main when dispatched; the staged
image came from staging run 37138614789), created 17:02:55Z. Job `guard`
succeeded 17:02:59Z-17:03:05Z. Job `build-and-deploy` ran 18:19:55Z-18:22:07Z
and succeeded; the run was completed at 18:22:08Z. Its log names production
revisions `app-ppbf-production--0000163` (before) and `--0000164` (after).
Overwatch's check of `www.punxsyprominence.org` at 18:28Z returned HTTP 200
(REPORTED by overwatch; not re-run here).

### 2. "Green"

Jason, whole message (2026-10-03T18:28:13.989Z): *"Green"*. It answers no
question: overwatch's previous message to him (18:23:23Z) said the release was
"still waiting for your approval". **It is not the approval.** The
`build-and-deploy` job began at 18:19:55Z and the run finished at 18:22:08Z,
six minutes before he typed it; GitHub lists one approval on the run, state
`approved`, made by the account `PunxsyProminence` (the approvals endpoint
gives no time). Overwatch wrote "Approved by Jason ("Green")" in its handoff
and "Production approval was Jason's" in its log; the first half is not
supported by the timing. The approval stays as L2 describes it: Jason's
per-run click in GitHub. His "Green" is recorded as what he said once the
release was live, not as the authorization for it.

Release 6 carried the coach floor board, My Corner, the failed-read batches
3, 4, 6 and 7, and the deleted-athlete and sign-in fixes. Whatever merged
after dispatch is release 7.


---

## OD-2026-10-03-012 -- Between the two Claude Code accounts: overwatch assigns lanes, the Fable session writes the code; briefs are lane assignments, not designs

**Provenance: PRIMARY.** Typed by Jason on 2026-10-03 in the Fable session
(`claude.ai/code/session_01PkrS65eqZon2LYsVt8tJAd`), after that session had
merged the intake audit's build items (#1121-#1124, #1126, #1142, #1146,
#1147, #1152). This entry is new and edits no earlier entry. It narrows
nothing in OD-2026-09-28-001 (Claude Code is the only builder); it says how
the two Claude Code accounts split the building.

### 1. The question

Jason, verbatim: *"Would it better for you to write PRs and have the other
account execute or PRs with code and the other lane execute"*, then *"So
should it write PRs and let you code"*. The session's recommendation, as put
to him: the Fable session writes the code PRs (investigation, tests, evidence
record) because that is the expensive, verification-heavy step and Fable is
the account with budget; the other account (overwatch) hands out lanes rather
than designs, because a lane assignment -- surface, allowed files, what it
waits on or conflicts with, done condition -- is the one thing that prevents
the collisions seen that day (#1130 duplicating B3; #1125 and #1147 on one
file), and a design brief is not evidence and gets re-investigated anyway. For
the intake audit's remaining items no brief is needed: the audit and
OD-2026-10-03-002 are the spec. Briefs with SQL go the other way only for
what the Fable container cannot do (production reads and mutations, a
coach's drill writing, a visual check, the #941 plate choice).

### 2. The answer

Jason, verbatim: *"Ok can you communicate that to it"*. **Ruling: adopted as
the working split.** Overwatch assigns lanes (three lines: the surface and the
files that may be touched; what it waits on or conflicts with; the done
condition) and keeps the queue and `ACTIVE_WORK.md`. The build session does
the investigation, the code, the tests and the evidence record, and checks
`main` and the open PRs before each item. One writer per surface. Recorded in
`docs/AI_COLLABORATION.md` under "Lane assignment between accounts" so the
other account reads it on its next item.

---

## OD-2026-10-03-010 -- The chalkboard and the gym TV: when there is nothing real to show, a quote with a status line under it (batch 8, PR #1144)

**Provenance: PRIMARY.** Typed by Jason on 2026-10-03 (US Eastern; times UTC)
in the batch-8 lane's thread (`lane/failed-read-batch8`; "Lane 14 batch 8")
and read by the records lane in that transcript
(`~/.claude/projects/C--Dev/bd94c88d-7d81-4dc3-8127-22cd2d1a4c58.jsonl`,
user messages of human origin). Built by PR #1144 (merge
`3b34131d778384a631d02058e4fc74367e63cea1`, 2026-10-03T18:40Z), whose body
quotes the second answer as its scope. This entry is new and edits no earlier
one.

### 1. The two questions

Put by the lane (11:05:47Z): "**Q1, the chalkboard (`components/Chalkboard.tsx`).**
If the board's message can't be loaded, the board shows "Nothing on the
board." on purpose. ... **A (recommended):** when it can't load, the board
shows a quiet "Board can't be read right now." instead. No banner, no error
codes, and writing still works. **B:** the board itself stays blank when it
can't load, but the writing screen warns before posting if the last load
failed. **C:** keep it as is." and "**Q2, the gym TV (`components/WallDisplay.tsx`).**
Before the TV has loaded once, the middle says "The board is coming up" but
the bottom line still says "Nothing posted today." ... **A (recommended):**
show "Nothing posted today." only after the TV has actually loaded. Until
then that line stays blank. **B:** keep it as is." Asked again at 13:49:04Z
together with a mutation-proof question ("**A (recommended):** yes. ... **B:**
a different way, which you name. **C:** skip the mutation proofs ..."), ending:
"Your Q1 (chalkboard) and Q2 (gym TV) answers are still open too."

### 2. His answers

Jason, whole message (15:28:59.782Z): *"Q1. Q2 should show an Easter egg
saying or boxing quote  and on the final choice A"*. The lane read "the
final choice A" as A on the mutation-proof question and ran the proofs
(15:29:07Z, "Running the mutation proofs (your A)."): the lane's reading, not
his words.

Jason, whole message (15:40:56.398Z): *"Q1 and Q2 quotes when nothing useful
is on screen when loading it should have a quote and a loading  .... under
the quote these can be gym quotes as well"*.

**Ruling (his words, in the lane's reading at 15:41:12Z: "whenever there's
nothing real to show (still loading, or the read failed), show a gym saying
with a status line under it"):** on the chalkboard and the gym TV, when there
is nothing useful to show, the screen shows a quote with a status line
("Loading...") under it; the quotes may be gym quotes. This replaces the
lane's A and B proposals for Q1 and Q2 with his own design.

### 3. What was built, and one open point

PR #1144 (REPORTED from its body; read, not re-run): the chalkboard shows a
gym saying with "Loading..." under it while the read is open, and with "Can't
read the board right now." after a failed read; "Nothing on the board." only
after a read that answered empty. The gym TV shows a saying above "The board
is coming up..." or "reconnecting..." with no board, and "Nothing posted
today." only once a board was read. Sayings come only from the
owner-approved `GYM_SAYINGS` (2026-08-19); no stock boxing quotes, "an
existing test forbids them" (PR body).

**Open for Jason.** His first message said "an Easter egg saying or boxing
quote" and his second "these can be gym quotes as well". The build used gym
sayings only. Whether boxing quotes should also appear is not decided; this
entry does not decide it.

---

## OD-2026-10-03-009 -- Moving a guardian to a new email's login (OD-2026-09-29-004 R4): organization admins only, the new login is made in the same step, the old login is switched off when it is empty, the contact email follows, nothing is sent (PR #1151)

**Provenance: PRIMARY for his words; the second question's text is not
recoverable.** Typed by Jason on 2026-10-03 (US Eastern; times UTC) in the
guardian-login-move lane's thread
(`~/.claude/projects/C--Dev/5cb1d110-40e6-4546-a550-3a41c0df479c.jsonl`, user
messages of human origin) and read by the records lane in that transcript.
Built by PR #1151 (merge `5b139d50ff364a611022948722ecc52a77688fa4`,
2026-10-03T18:40:48Z). It carries out OD-2026-09-29-004 R4 ("add a
deliberate "move guardian to a new login" admin action", answer A) and adds
the four product questions that ruling left open. New; edits no earlier entry.

### 1. Q1-Q4

Put by the lane (10:47:10Z): "**Q1. Who may perform the move?** A
(recommended): organization admins only (ppbf@), Microsoft sign-in required.
B: organization admins and the platform owner (Admin@). **Q2. What must the
new login be?** A (recommended): a parent login that already exists in the
gym, created first with the usual "invite parent" step. The guardian record's
contact email also changes to the new login's email. B: the move action
creates the new login from an email address itself. **Q3. What happens to the
old login after the move?** A (recommended): it's switched off in the same
action, unless it still holds another guardian record (another family it's
attached to), in which case it stays on. B: it always stays on. C: the admin
picks each time. **Q4. What is the parent told?** A (recommended): nothing
automatic. The admin tells the family, and the move is recorded in the audit
log. B: the app emails the new address saying the gym moved the children to
it." (the lane's plain-English lines under each question are left out) and "You can answer like "all recommended" or "Q1 A, Q2 B..."."

Jason, whole message (11:05:27.875Z): *"go"*. The lane asked (11:05:33Z):
"Does "go" mean "all recommended" for Q1-Q4? **A (recommended):** yes, all
recommended. ... **B:** no, here are my answers per question." Jason, whole
message (11:09:19.552Z): *"go"*. **Ruling: Q1 A, Q3 A, Q4 A (all
recommended); Q2 A as first worded, then re-asked (section 2).** The lane
took "go" as A at 11:09:29Z.

### 2. Q2 re-asked, and his answer

At 11:11:48Z the lane reported to overwatch that its own Q2 framing was wrong:
a reviewer found that "invite the new email first, then move" leaves the
target login holding two guardian records for the same child (consent stuck,
one person answering for both), because every parent invite creates its own
guardian record. It said it was re-asking Jason Q2 in the lane. **The text
of that re-ask is not in the transcript as a visible message (the session
crashed about 11:27Z; the only trace is the lane's reasoning note, "move
action creates the new parent login directly, refusing if it already guards
these children", and its 16:10:40Z line "**Still needed from you:** Q2 above.
Pick A (recommended), B or C."). UNVERIFIED: the wording of options A, B and
C.** Jason, whole message (16:29:25.955Z): *"Go"*. The lane took it as Q2 A
(16:29:32Z): "the move takes the new email and creates the login in the same
step". Recorder's reading, not his words: "Go" accepted the recommended A of
that re-ask; PR #1151's body says the same ("on the Q2 re-ask "Go" (taken as
A)"). The options are not in this record in writing; if A was not what he
meant, the move action changes in a later PR.

### 3. What PR #1151 built (its body, read)

`moveGuardianToLogin`: one transaction re-points the guardian record to the
login for the new email, making a parent login if none exists (Q2 as
re-asked); refuses any move that would give one login two guardian places for
a child, a PIN or platform-owner target, a deleted or switched-off target, a
login in another gym, and a record that is no longer on the login the screen
showed; switches the old login and its sessions off when it backs no guardian
record left (Q3); sets the record's contact email to the new login's (Q2);
writes one audit row on the same transaction and sends nothing (Q4).
`POST /api/pilot/admin/guardian-login` is `organization_admin` only (Q1). One
"Move ... To New Email" control per guardian record on `/admin/people`.
Not checked by a person: the screen has not been used signed in.

---

## OD-2026-10-03-008 -- Intake promotion: merge #1143 as it is and put the rest of the writes in one transaction in a new lane (OD-2026-10-03-002 section 5, option A)

**Provenance: PRIMARY.** Typed by Jason on 2026-10-03 (US Eastern; times UTC)
in the intake deleted-login lane's thread
(`lane/intake-deleted-login-lock`;
`~/.claude/projects/C--Dev/cbbe2508-df02-4de5-b634-44741e36de09.jsonl`, user
messages of human origin) and read by the records lane in that transcript. It
carries out OD-2026-10-03-002 section 5 ("one transaction around intake's
writes") and is new; it edits no earlier entry.

His request to the lane (18:21:22.247Z), whole message: *"Look at the repo  and make recommendation"*. The lane's question (18:22:23Z): "How should the
remainder of OD-2026-10-03-002 §5 be delivered? **A. (Recommended)**
Merge #1143; correct `ACTIVE_WORK.md:213` so the row stays open; open a new
high-risk lane to put the athlete login write, guardian provisioning and the
remaining intake writes in the same transaction, with `auth.ts` and
`staffProvisioning.ts` in its file list. **B.** Extend #1143 to also move the
athlete login write inside the transaction (about 15 lines in `auth.ts` plus
one more test case); the guardian and other writes stay for later. **C.**
Merge #1143 and stop; accept half-done promotions as they are today." Jason,
whole message (18:35:04.122Z): *"A"*. **Ruling: A.**

What followed (REPORTED by overwatch's log, 18:40Z, and checked on GitHub):
#1143 merged as `c11c05b35dbe0549c2a0d79c455395aa84d669e2` (2026-10-03T18:35Z);
overwatch started a new high-risk lane (Opus, two reviewers) for the
remaining writes. The build-list row "One transaction around intake
promotion's writes" stays open until that lane's PR merges.

---

## OD-2026-10-03-007 -- The GPU: this PC is set up for ML work; the tablet speed bar is the tighter one (live speed); gate 3 readiness is built on fake data

**Provenance: PRIMARY.** Typed by Jason on 2026-10-03 (US Eastern; times UTC)
in the overwatch thread
(`~/.claude/projects/C--Dev/c2e29ade-d3b8-4a8a-bf98-07b855ff2047.jsonl`) and
in the gate-2 GPU lane's thread
(`~/.claude/projects/C--Dev/7c226384-0a0c-4e47-8199-c316cd81257a.jsonl`),
user messages of human origin, read by the records lane in those transcripts.
New; edits no earlier entry. The speed bar's figure of 100 ms is overwatch's
option text, not his number (section 2).

### 1. Setting up the GPU

Jason (11:32:58.932Z): *"i want to set it ups so you can use my gpu on this
computer"*. Overwatch (11:33:51Z): "**Question (official):** May I download
and install this? **A (recommended):** yes. PyTorch with CUDA, about 2.5 GB,
plus Python 3.12 (about 30 MB) only if 3.14 isn't supported, then the smoke
test. **B:** check what's needed first, install nothing yet." Jason, whole
message (11:36:18.779Z): *"this is in the terminal claude desktop app, go
ahead and set up what ever work we can do in the gpu, i give you permeission
to access the local terminal to do it"*. **Ruling: set up the GPU work this
PC allows, through the local terminal.** It authorizes the setup and the
GPU work on this PC; the later GPU lanes ran under it. Done (OBSERVED by
overwatch in its transcript; not re-run here): an environment at
`C:\Dev\ml\.venv` with CUDA PyTorch on the RTX 2060 (6 GB).

### 2. The tablet speed bar

The gate-2 speed test found every candidate model 4 to 30 times faster than
the draft's bar (tablet WebGPU 31-57 ms per frame; REPORTED in the lane's
report, `TEACH-BIOMECH-gate2-speed-2026-10-03.md`). Overwatch (16:31Z):
"**Question (official):** Set the tablet speed bar for marking? **A
(recommended):** "under 1 second per frame". All sizes pass, so model size
gets chosen on accuracy once training starts. **B:** a tighter bar, e.g. live
speed (under 100 ms per frame)." He asked *"Pros cons"* (16:32:55Z) and was
given them. Jason, whole message (16:35:29.031Z): *"B and check lanes allow
auto fix"*. **Ruling: B, the tighter bar, live speed.** Overwatch took the
figure as under 100 ms per frame, the example in the option as put; Jason did
not name a number.

In the gate-2 lane the same hour he wrote *"We chose the faster"*
(16:36:26.174Z); asked which of three meanings (A the fastest network; B the
graphics-chip path, the lane's recommendation; C a stricter speed limit than
1 second), he wrote *"Let over watch update you on that"* (16:38:07.791Z) and
then *"C is what it recommends"* (16:39:51.176Z). The lane recorded C, a
stricter bar. These words fit the "B" above (a tighter bar) and do not match
either recommendation by its letter: overwatch's recommendation was A, the
lane's was B. The binding answer is the "B" to overwatch's question; the lane
messages add no number.

### 3. "allow auto fix"

The second half of that same message, *"check lanes allow auto fix"*, was a
standing instruction, not an answer. Overwatch's reading (16:35:41Z, to every
lane with an open PR): "Jason asked lanes to allow auto-fix", meaning each
lane turns on the desktop app's PR monitor with auto-fix and comment handling
and auto-archive on close; a lane fixes only within its file list, in new
commits, with no force-push, and tells overwatch; overwatch still merges.
INFERRED: the auto-archive part is overwatch's addition (he said earlier,
15:41:23Z, *"Check lanes archive those that met scope"*).

### 4. Gate 3 readiness on fake data

Overwatch (18:22:06Z): "**Question (official):** Start the next GPU lane?
**A (recommended):** gate 3 readiness, on fake data only. No footage and no
app changes. **B:** speech to text. **C:** wait until marking starts."
Jason, whole message (18:23:00.232Z): *"A"*. **Ruling: build the training
pipeline for the pose model on fake data only, on this PC's GPU; no footage,
no app changes, no PRs.** Started as a background agent from the overwatch
thread after he wrote *"Im remote"* and *"Start thrm"* (18:29Z-18:33Z).
Not built yet: real training, which waits on coach-marked frames.

---

## OD-2026-10-03-006 -- Body points belong to the person whose own event it is (supersedes the opponent marking of OD-2026-10-02-008 9A); a new "received punch" event class is wanted; the stance label "neutral" is confirmed

**Provenance: PRIMARY.** Typed by Jason on 2026-10-03 (US Eastern; times UTC),
in two lane threads, and read by the records lane in those transcripts. The
body-point storage lane (TEACH-BIOMECH-01-b, PR #1150):
`~/.claude/projects/C--Dev/2930c45b-5e84-4f32-83cc-179a586ee7de.jsonl`. His
answers there arrived as answers to the lane's question prompts (tool results
of the `AskUserQuestion` tool, not plain user messages). The ontology lane
(TEACH-BIOMECH-01-a, PR #1116):
`~/.claude/projects/C--Dev/6daef632-69f0-459a-a97b-ed06666e0474.jsonl`, plain
user messages of human origin. New; edits no earlier entry, but **supersedes
section 3 item 9A of OD-2026-10-02-008** as stated in section 1.

### 1. Who is marked

OD-2026-10-02-008 section 3 recorded **9A:** "Only the person throwing the
punch or making the defence is marked; the other person only when the event
is contact against them."

The lane asked (prompt sent 14:32:39Z): "OFFICIAL: OD-2026-10-02-008 9A says
the other person is marked "only when the event is contact against them".
Build reading (D-e): opponent body points are recorded only on a PUNCH event
that has a contact time (clean, glancing, guard or non-target contact) and
names the opponent; never on a defence (including a block or parry that
touches the other boxer's glove), and never on a missed punch. Confirm?
PLAIN: When your boxer's punch lands (even on the gloves or arms), the coach
also taps the 24 points on the boxer who got hit. ..." with options "Yes, as
written (Recommended)", "Also on defences with contact", "Only clean or
glancing hits". Jason's answer (15:32:12.595Z) was free text:
*"It should be on the individuals action,  so one would get the punch thrown and the other would ge"*. The text ends there as the transcript has it; the
lane noted it "was cut off".

The lane asked again (15:32:25Z): "OFFICIAL: Your answer read "It should be on
the individuals action, so one would get the punch thrown and the other would
ge" and was cut off. I read it as: body points are always tied to a person's
OWN event. The puncher is marked on the punch event, and the other boxer is
marked on THEIR OWN event (their defence, or a new 'received the punch'
event). There is no 'opponent' marking inside the puncher's event. Which
completion is right? ..." Options: "On their own defence event"; "On a 'got
hit' moment in the punch"; "New 'received punch' event" ("Add a new event
type for the person hit, recorded separately. Needs a vocabulary change (a
later item), so this PR would remove 'opponent' for now."). Jason's answer
(15:37:51.030Z): *"1 and 3"*.

**Ruling: body points belong to the actor of their own event.** There is no
"opponent" marking inside the puncher's event. The other boxer is marked on
their own defence event (option 1), and later through a new "received punch"
event class (option 3). This replaces the second half of 9A (the other person
marked "when the event is contact against them"); its first half stands.
Recorder's reading, not his words: "1 and 3" means both options together, as
overwatch and the lane read it. Acted on: PR #1150 (merge
`66b625a4710840627baa435463aa418ccc996766`) drops the `subject` column and
the opponent rule and removes `BODY_SUBJECTS` from `ontology.ts`.
**Not built:** the "received punch" event class. It changes the shared
labelling vocabulary and needs its own item (build-list row added).

### 2. "neutral" (the 01-a lane)

The lane had been told that his 2026-10-02 reply to the neutral question
("No the stance was correct but you did bring up a good point on guard", in
OD-2026-10-02-008 section 3b) left the record's definition of "neutral" in
doubt. It asked (10:38:43Z): "**Official:** What does the lead-side label
**`neutral`** mean in boxing-ontology-0.2? **A (recommended, and what
OD-2026-10-02-011 3b records):** "a square stance, feet level, neither side
leading." **B:** something else. Give the definition in your words."
Jason, whole message (10:52:48.078Z): *"we decided left and right sides"*.
The lane answered that points are left and right (settled) and asked
(10:52:58Z): "**Official:** When a coach records the stance at a marked
moment, do the choices stay as orthodox, southpaw, neutral, transition and
unknown, with **neutral = feet level, neither side forward**? **A
(recommended):** yes, as written. **B:** neutral means something else. Say
what. **C:** drop neutral, because left and right points already cover it."
Jason, whole message (10:59:32.966Z): *"A"*. **Ruling: A. The stance choices
stay orthodox, southpaw, neutral, transition and unknown; neutral is a square
stance, feet level, neither side leading** (as OD-2026-10-02-011 3b records).
The `LEAD_SIDES` list stands as built in PR #1116; no code change.

---

## OD-2026-10-03-005 -- The Library chat: when nothing relevant is found, show the closest passages with a confidence level and file a research request for the gap (not yet built)

**Provenance: PRIMARY.** Typed by Jason on 2026-10-03 (US Eastern; times UTC)
in the build-list reconcile lane's thread (PR #1125;
`~/.claude/projects/C--Dev/7c17ea86-f0d3-4820-888e-116254ece9d5.jsonl`, a
user message of human origin) and read by the records lane in that
transcript. The lane put the question after its report, and sent his answer
to overwatch the same hour. New; edits no earlier entry.

The question (lane, 12:30:55Z): "**Official:** When a Library question has no
relevant approved evidence, should the chat (a) answer "No approved evidence
found" and log a research need (recommended), or (b) show the closest
passages labelled low-confidence?" with the plain-English line "When someone
asks the Library something it has nothing on, should it say "I don't have
anything on that" and note the gap for research, or show its best guess with a
warning?". Jason, whole message (15:29:46.439Z): *"B display confidence leve and submit research request to fill gap"*. **Ruling: B, with a research
request added.** The chat shows the closest passages with a confidence level
(his "confidence leve" read as "level"), and also files a research request to
fill the gap; option (a)'s "No approved evidence found" is not the behaviour.
The recommended (a) logged a research need and (b) as put did not; the
request is his addition.

State: the cause is on the build list (the search matches any three-letter
fragment, with no minimum relevance: `shadowLibrary.ts` `tokenizeQuery`,
the keyword fall-back below `SEMANTIC_SCORE_FLOOR`). A fix is in progress as
a background agent from the overwatch thread (started 18:33Z); not merged.
Not built until its PR merges. Whether it reads well on screen is Jason's
walk.

---

## OD-2026-10-03-004 -- The Fable thread merges its own PRs; when its usage runs out its lanes return to overwatch

**Provenance: PRIMARY.** Typed by Jason on 2026-10-03 (US Eastern; times UTC)
in the overwatch thread
(`~/.claude/projects/C--Dev/c2e29ade-d3b8-4a8a-bf98-07b855ff2047.jsonl`). The
first message is a plain user message of human origin; the second was typed
while overwatch's turn was running and the transcript holds it as a queued
message of human origin (`attachment` of type `queued_command`,
`origin.kind: "human"`, enqueued 15:53:06.409Z). Read by the records lane in
that transcript. New; edits no earlier entry.

**Context.** At 15:17Z-15:18Z the "Fable" thread (a separate Claude session
under his GitHub account, working research, data and intake) merged five of
its PRs (#1126, #1121, #1122, #1123, #1124), which moved main under a release
overwatch had staged. Overwatch's question (15:25:07Z): "**Questions
(official):** 1. **The Fable thread:** **A (recommended):** it stops merging;
only overwatch merges. **B:** it may merge its own PRs." Jason, whole
message (15:50:09.933Z): *"Fable is running in a separate account using up
remaining usage, on research data work intake, let it merge on it own, and go
with your recommendation on ui"*. **Ruling: B, over overwatch's
recommendation. The Fable thread owns research, data and intake work and
merges its own PRs.** (The tail, "go with your recommendation on ui", is
recorded in OD-2026-10-03-003.) This is an exception to the L2 rule that
only overwatch merges lane PRs (OVERWATCH, MERGES); the L2 rule is not
edited by this entry. Overwatch's stated consequences (15:50:23Z): it will not
merge or close that thread's PRs; before any production release it
re-stages at main's latest commit; before giving a lane research, data or
intake work it checks that thread's open PRs for duplicates.

Jason, whole message (15:53:06.409Z): *"When its usage runs out those lanes
will return here check in with lanes"*. **Ruling: when the Fable thread's
usage runs out, the lanes it was running come back to overwatch, and
overwatch checks in with them.** Recorder's reading, not his words: "its"
is the Fable thread's, "those lanes" are its research, data and intake lanes.

---

## OD-2026-10-03-003 -- UI problems are logged as found and a UI lane fixes one screen at a time after that file's other work merges; release 6 shipped the coach page as it was

**Provenance: PRIMARY.** Typed by Jason on 2026-10-03 (US Eastern; times UTC)
in the overwatch thread
(`~/.claude/projects/C--Dev/c2e29ade-d3b8-4a8a-bf98-07b855ff2047.jsonl`) and
read by the records lane in that transcript. "Agreed on ui" was typed while
overwatch's turn was running, so the transcript holds it as a queued message
of human origin (`attachment` of type `queued_command`, `origin.kind:
"human"`, enqueued 15:25:17.998Z); the other message is a plain user message
of human origin. New; edits no earlier entry. OD-2026-10-02-004 (nothing in
the UI is tied down) is unchanged.

### 1. The standing rule

Jason asked (15:23:28Z), whole message: *"Should we fix UI like this as we
run across it,, does it not affect wiring"*. Overwatch answered that
removing a duplicate can touch wiring (actions that live only in the old
section, data loading, tests that pin it, safety lists that must stay
complete) and put (15:23:43Z): "**Question (official):** Adopt that rule?
**A (recommended):** yes: log as found, one screen per UI lane, after that
file's other work merges. **B:** fix each one immediately when found.
*Plain:* A avoids two Claudes editing the same screen at once and breaking
each other's work. B is faster per fix but causes clashes like the two
duplicate PRs today." Jason, whole message (15:25:17.998Z): *"Agreed on ui"*.
**Ruling: A.** UI problems anyone spots go on the build list as they are
found; a UI lane takes them one screen at a time, after the lane that owns
that file has merged. Overwatch read it the same way (15:25:30Z).

### 2. Release 6 and the coach page

Overwatch (15:21:18Z) described the coach page after release 6's #1110: the
new Floor board on top and the old dashboard unchanged below it, with
Roster, Needs You Now and Run the Room repeated below as Athlete Roster,
Safety Escalations and Pain Reports, and Today's Session. It asked: "**Question
(official):** Ship release 6 with the overlap, or trim it first? **A
(recommended):** ship as is; the UI lane removes the duplicated old sections
in a follow-up. **B:** trim first, then ship." The rule above was answered
first; this question was still open when Jason, whole message (15:50:09.933Z,
the message also recorded in OD-2026-10-03-004), wrote the tail *"go with
your recommendation on ui"*. **Ruling: A. Release 6 ships the coach page as
it is; the trim follows as its own UI lane after the coach-file PRs (batch 3
#1140, pain colour #1119) merge.** Recorder's reading, not his words: the
open "ui" recommendation was this question (overwatch read it so at 15:50:23Z:
"release 6 ships the coach page as is, and the duplicate-dashboard trim
follows as its own UI lane"). Release 6 went to production (OD-2026-10-03-011);
the trim is not built (build-list row added).

---

## OD-2026-10-03-002 -- The intake audit's owner questions: old research-requirement rows deleted; licensed excerpts loaded by the screen and by a workflow from a private location; four rights values; a coach issues a template in one action; a coach sets the competence level; one transaction around intake's writes; the AI prompt's drill list stays as built; the duplicate drill copy not in use is deleted; document-ingest and the laptop seeder retired; callerless routes parked, not deleted

**Provenance: PRIMARY.** Typed by Jason on 2026-10-03 (US Eastern; times UTC)
in the Claude Code session that wrote the intake audit
(`https://claude.ai/code/session_01PkrS65eqZon2LYsVt8tJAd`), answering
question prompts the session put to him, and read directly by that same
session, which also records them here. The answers arrived between the
session's 12:33Z check-in and 14:02Z; the prompts did not stamp each one. The
questions are Q1-Q12 of `docs/current/INTAKE_RESEARCH_WORKOUT_PROGRAM_AUDIT_2026-10-03.md`
(PR #1121; findings measured at `03f5c649`), each put with options and a
recommendation marked "(Recommended)". Q8, the universal stop-rule wording,
was not put: it is text for him to write, not a choice. **Q12 was answered
twice**; the later answer stands (section 12). Nothing in this entry is
built; the sections say what each answer waits on.

This entry is new and edits no earlier one. It settles the open point of
OD-2026-10-02-012 (section 7) and adds to OD-2026-10-02-013 answer 1B
(section 2). Where the audit's recommendation differs from his answer, his
answer governs and the difference is named.

Asked whether these were his decisions as owner, to be recorded here --
"**Yes, I am Jason; record them**" or "**No, treat them as proposals for
Jason**" -- Jason, whole message: *"1 and delete anything that conflicts
with it"*. **Ruling: these are his decisions.** "Delete anything that
conflicts" is carried out as this file's rules allow: an earlier decision is
superseded by this entry, never edited or removed; the audit's overruled
recommendations are rewritten to his answers; a document or row that now
contradicts an answer is corrected in its own PR.

### 1. Q1 -- the research-requirement rows past intake uploads wrote

As put: "Past intake uploads each wrote a research-requirement row with the
uploaded file's name in it (visible on /research to every role). B1 stops
new ones. What should happen to the rows already written?" Options: "Count
first, then decide (Recommended)"; "Delete them all"; "Leave them". Jason:
*"Delete them all"*. **Ruling: delete every such row.** Over the audit's
recommendation. A production data change: a read-only count first, then his
word for the run (OD-2026-09-28-010 item 8; "Merging and releasing" in
`AGENT_KERNEL.md`). PR #1122 (B1) stops new rows and touches none.

### 2. Q2 -- who loads licensed excerpts, and from where

As put: "New licensed research excerpts are stored privately in the
database (your ruling 2A) and the platform owner adds them in the app (1B).
Who may load them, and from where?" Options: "In-app platform-shelf screen
only (Recommended)"; "Screen, plus an operator workflow reading a private
location"; "Operator workflow only". Jason: *"Screen, plus an operator
workflow reading a private location"*. **Ruling: both the in-app platform
shelf screen and an operator workflow that reads a private location.** Over
the audit's recommendation. Adds to OD-2026-10-02-013 answer 1B, which
stands. Not built: the private location and its secret do not exist
(OD-2026-10-02-015 D5 names the same gap for the archive); the migration of
section 3 comes first.

### 3. Q3 -- the rights values a source carries

As put: "To check 'full text only for PPBF-owned or open-licence material',
a source needs a rights marker. Which values should a source carry?"
Options: "ppbf_owned / open_licence / licensed_excerpt_only / unknown
(Recommended)"; "Just owned vs. not owned"; "Free-text licence note, no
fixed values". Jason: *"ppbf_owned / open_licence / licensed_excerpt_only /
unknown (Recommended)"*. **Ruling: those four values; `unknown` refuses full
text.** Needs a migration and a classification of the existing sources
(1,001 rows in the 2026-08-07 seed, measured at `03f5c649`).

### 4. Q4 -- a workout template becoming athlete work

As put: "Today a workout template or session script is only a read-only
catalog and a live-run script. Nothing turns one into athlete assignments.
Should it?" Options: "No, stays a catalog for now (Recommended)"; "Yes, a
coach issues a template to an athlete or program in one action"; "Yes,
automatically on a schedule". Jason: *"Yes, a coach issues a template to an
athlete or program in one action"*. **Ruling: a coach issues a template to
an athlete or a program in one action; the coach stays the decision-maker.**
Over the audit's recommendation. Not built. Open for him, not decided here:
what happens to a step whose drill the gym has not adopted (template steps
reference the reference library, assignments need an active adopted drill,
OD-2026-09-18-001); the audit recommends refusing and naming the drill.

### 5. Q5 -- the race between intake promotion and the account cleanup

As put: "Intake promotion can still race the account cleanup (the cleanup
retires a login while a promotion is mid-write). B2 closed the sequential
case; how should the concurrent case be closed?" Options: "One transaction
around intake's writes (Recommended)"; "Shared advisory lock (cleanup
exclusive, intake shared)"; "Leave it as is". Jason: *"One transaction
around intake's writes (Recommended)"*. **Ruling: one transaction around
intake promotion's writes; no advisory lock.** Settles part (ii) of the Build
List row "Intake can leave a live athlete whose login is marked deleted"
(part (i) is PR #1123). The reason intake writes in separate steps
(`apps/web/src/server/pilot/intake.ts:1653-1657` at `03f5c649`) is to be
read before the change.

Status (2026-10-03): PR #1143 (another session) builds this as one transaction
around the withdrawn check, the deleted-login check and the athlete write, with a
per-athlete `pg_advisory_xact_lock` taken inside that transaction on both the
intake and the cleanup side. Put to Jason in the session as a question (a
transaction alone does not close the race the row names; the lock in #1143 is
not the rejected "shared advisory lock" design) with the recommendation to
accept it. Jason, 2026-10-03: *"Go with what you recommend"*. So the ruling's
"no advisory lock" is superseded: the transaction is the decision, and #1143's
lock inside it satisfies it. #1143 was open at `18c3faa5` when this was recorded;
its merge is its own lane's.

### 6. Q6 -- how an athlete's competence level is recorded

As put: "Competence levels and cohorts are imported, but nothing records an
athlete's level, so no cohort can place anyone. How should a level be
recorded?" Options: "A coach sets it by hand (Recommended)"; "Derived from
completions, coach confirms"; "Both: coach sets it, system suggests". Jason:
*"A coach sets it by hand (Recommended)"*. **Ruling: a coach sets it by
hand.** Consistent with OD-2026-09-21-001 (minors' limits are coach-set
data). Not built: `pilot.athlete_competence` has no writer outside tests
(measured at `03f5c649`), and the screen does not exist.

### 7. Q7 -- which drills the AI workout prompt carries

As put: "The AI workout-intake prompt sends your drill list to whatever AI
you paste it into. Which drills should be in that list?" Options: "All
current reference drills (as built) (Recommended)"; "Only drills this gym has
adopted"; "Both, marked which is which". Jason, first: *"Explain,"*. The
session explained the two drill tables (reference `pilot.drill_library`,
which template steps link to; operational `pilot.drills`, which assignments
use) and what each option would cost. Jason, whole message: *"Match but
those drills need audited  alot are too simplistic and dont really do
anything"*. **Recorder's reading, not his words: "Match" is option A, the
list as built -- the current reference heads (`active and superseded_at is
null`, `drillLibraryV3.ts:304-306`).** This settles the point
OD-2026-10-02-012 left open ("which drill states count as the gym's list is
not settled"). His addition is a new item, not a ruling on content: the
reference drills are to be audited; he finds many too simplistic. Asked
whether that can wait until the Fable items are done, Jason: *"Can it be
done later after fable finish its work"*. **Parked**, with a re-open
condition, in `docs/current/ACTIVE_WORK.md` (its own PR). Measured for that
row at `93bc76d` from `apps/web/seed-data/drill-library/*.csv`: 119 drills;
`execution` median 21 words, 105 of 119 under 30; `purpose` median 5;
`standard_setup` median 2; `common_errors` empty on 114; 34 drills with no
cue; every drill has exactly 3 scale levels (not checked for substance).
Whether a drill "does anything" is coaching judgement and was not measured.
Drill content is his or a coach's to write, never invented.

### 8. Q9 -- the 119 reference drills held twice in production

As put: "The 119 reference drills exist twice in production, once under
ppbf-default-org and once under punxsy_prominence (census 2026-09-30). Which
is the gym's set?" Options: "punxsy_prominence is the gym's; leave the other
alone for now (Recommended)"; "Keep punxsy_prominence, delete the
ppbf-default-org copy"; "Leave both as they are". Jason, whole message:
*"Confirm witch one is in use delete the other"*. **Ruling: establish which
copy is in use, then delete the other.** Over the audit's recommendation.
Two production acts, each on his word for the run: a read-only check of
what reads each copy (adopted drills, assignments, the policy-shelf move),
then the delete. Which copy is in use is **not** assumed here.

### 9. Q10 -- `/api/document-ingest`

As put: "/api/document-ingest parses a PDF and files it in Dataverse,
SharePoint and Google Drive. No page calls it, it never reaches the Library,
and it likely fails on every PDF in production until #1109's bundling fix
lands. Once #1109 (the PDF reader on /research) is live, keep it?" Options:
"Retire it (Recommended)"; "Keep it, but give it a page"; "Keep it as is,
unreachable". Jason: *"Retire it (Recommended)"*. **Ruling: retire the
route once #1109 is live.** Consistent with OD-2026-10-02-015 D4. The
repository is searched for callers first; flows outside it cannot be seen
from a session.

### 10. Q11 -- `scripts/seed-data.ts` and `SEED_GUIDE.md`

As put: "scripts/seed-data.ts seeds athletes, parents, goals and sessions
straight from a laptop with upserts that overwrite, no actor check, and
SEED_GUIDE.md documents only that path. Keep it?" Options: "Retire it and
the guide (Recommended)"; "Keep it, restricted to non-production databases";
"Keep it as is". Jason: *"Retire it and the guide (Recommended)"*. **Ruling:
retire the script, its `seed:data` entries and the guide.** This is the
athlete/session seeder, not the content-import seed path of
OD-2026-09-29-005 R1, which stands.

### 11. Q12 (first answer) -- routes and a table with no caller

As put: "Several routes and one table have no caller anywhere in the app
(research search, capability-coverage reads, retraction checks, drill
proposals and lineage, floor-plans, gap-justification,
drill_version_outcomes). What should happen to them?" Options: "Park each
with a re-open condition (Recommended)"; "Delete the ones with no tests or
owner now"; "Decide route by route". Jason: *"Delete the ones with no tests
or owner now"*. Superseded by section 12.

### 12. Q12 (second answer) -- the UI is not finished

Jason, whole message, after the first answer: *"Ok not all of the ui is done
yet"*. The session put back that "no page calls it" cannot be read as
"unused" while screens are still being built, and proposed that Q12 become
"park each with a re-open condition, delete only what is clearly obsolete".
Jason, whole message: *"Confirm"*. **Ruling: park each callerless route and
table with a re-open condition; delete only what is clearly obsolete, never
a route that may be waiting for its screen.** The list is measured first
(tests, callers, scripts) and each item marked parked, planned UI, or
obsolete, before anything is deleted. The audit's "no UI" findings are
reworded "no page yet" (PR #1121).

---

## OD-2026-10-03-001 -- Tablet hand-over for labelling (TEACH-LABELLER-HANDOFF-01): H1-H4 A; full app access needs the coach's own sign-in; H6 A plus an email reset; 60 minutes; no durable failed-PIN record

**Provenance: PRIMARY.** Typed by Jason on 2026-10-03 (US Eastern; times UTC)
in the relay lane's thread ("Get tablet hand-over decisions ready for Jason")
and read by the records lane in that transcript
(`~/.claude/projects/C--Dev/2643cede-813a-4815-8178-c4d1f7cf92b6.jsonl`, a
user message of human origin). The questions are the owner decisions of
ChatGPT's draft work order TEACH-LABELLER-HANDOFF-01 (assistant reply
2026-10-02T21:51:59Z in the ChatGPT project "PPBF — App Build Review"; copy at
`Documents/PPBF-overwatch/lane-inbox/TEACH-LABELLER-HANDOFF-01-chatgpt-draft-2026-10-03.md`),
a draft that is not approved as a whole and is not app source. This entry
records only his answers to H1-H8. It follows OD-2026-10-02-010 section 2
item 4, which settled the shape (pick your name, then a short PIN; the screen
clears between labellers), and is new and edits no earlier one. Nothing in it
is built.

The relay lane put the eight questions (10:38:48Z), each with the line
"Each recommendation is ChatGPT's; none are mine.", and ended: "Reply on one
line, for example `H1 A H2 A H3 A H4 A H5 A H6 A H7 60 H8 A`, or just "all
recommended"." Jason, whole message (10:56:37Z): *"1 A 2 A 3 A 4A 5 It should
be in the app so they would already be there if it is a differenent coach that
is using pinn they would have to sign in to there account seperate to get thier
app acess 6 A and a reset option to there email on file 60 min 8 b"*.

**H1.** As put: "**H1. Who may appear in the labeller picker?** - **A
(recommended):** the existing annotator roles, coach and organization admin.
- **B:** coaches only." His answer: *"1 A"*. **Ruling: A. The picker shows
coaches and organization admins (the existing annotator roles).**

**H2.** As put: "**H2. What name does the picker show?** - **A
(recommended):** each labeller types a display name when they set their PIN.
... - **B:** their login email. - **C:** build a staff-name profile first."
His answer: *"2 A"*. **Ruling: A. Each labeller types the display name the
picker shows when they set their PIN.**

**H3.** As put: "**H3. Who sets the 4-digit labelling PIN?** - **A
(recommended):** each coach sets their own while signed in normally. An org
admin can clear it but can never see or choose it. ... - **B:** the org admin
assigns and resets PINs." His answer: *"3 A"*. **Ruling: A. Each coach sets
their own PIN while signed in normally; an org admin can clear it and can
never see or choose it.**

**H4.** As put: "**H4. What can the PIN open?** - **A (recommended):** only
the locked-down labelling mode on the tablet. - **B:** the person's full PPBF
sign-in." His answer: *"4A"*. **Ruling: A. The PIN opens only the locked-down
labelling mode.**

**H5.** As put: "**H5. How does the tablet get back to the full app?** - **A
(recommended):** a normal sign-in. - **B:** the 4-digit PIN of the person who
opened it. ChatGPT's warning: anyone with the tablet and those four digits
would get that coach's whole account." His answer, free text: *"5 It should be
in the app so they would already be there if it is a differenent coach that is
using pinn they would have to sign in to there account seperate to get thier
app acess"*. **Recorder's reading, not his words: a coach on the PIN gets
labelling only; full app access needs that coach's own separate sign-in
(closest to A).** He gave no letter; B (the PIN unlocking the full app) is not
what he said.

**H6.** As put: "**H6. What happens after wrong PINs?** - **A
(recommended):** reuse the existing slowdown. Each wrong try waits longer,
counted per labeller and per device, with no permanent lockout. - You also
choose whether the existing timings are enough, or whether this PIN gets a
stronger temporary lock." His answer: *"6 A and a reset option to there email
on file"*. **Ruling: A (the existing slowdown, per labeller and per device, no
permanent lockout), plus his addition: "a reset option to there email on
file".** He did not ask for a stronger temporary lock. What the reset resets
and how it works are not in his words; the architect specifies them.

**H7.** As put: "**H7. How long does labelling mode last?** - ChatGPT
proposes 60 minutes, counted from when labelling mode starts. Switching
labellers doesn't reset the clock, and it never renews by itself. - Give the
number of minutes you want." His answer: *"60 min"* (unnumbered; it is the
only number of minutes in his message and falls between his 6 and 8). **Ruling:
60 minutes, counted from when labelling mode starts.**

**H8.** As put: "**H8. Are failed PIN attempts recorded?** - **A
(recommended):** keep a permanent record of each failed attempt ... The PIN
itself is never recorded. ... - **B:** keep only short-term logs." His answer:
*"8 b"*. **Ruling: B. No durable record of failed PIN attempts; only
short-term logs.** This is his choice over ChatGPT's recommendation.

---

## OD-2026-10-02-019 -- The Label Agreement screen: the "Still to do" line is left as is; its readability is to be fixed before production (release 5 then shipped without the fix, on his later word)

**Provenance: PRIMARY.** Typed by Jason on 2026-10-02 (US Eastern; the times
below are UTC) in two threads, and read by the records lane in those
transcripts: the agreement-report lane
(`~/.claude/projects/C--Dev/07cd0b14-cb11-403c-871d-01b351819222.jsonl`) and
overwatch (`~/.claude/projects/C--Dev/5b2fe0c3-80bd-4765-873d-9a0be7fc987d.jsonl`).
This entry is new and edits no earlier one.

### 1. "Leave it": the "Still to do" wording stays

The agreement-report lane put (22:47:28Z), after Grok's stand-in review of
#1096: "Official: change the "Still to do" line from "not yet labelled by two
coaches" to "not yet finished by two coaches"? Options: A keep as is
(recommended); B change. Plain: same meaning either way. B is slightly more
precise, but it adds one more change that ChatGPT would need to re-review."
Jason, whole message (23:01:59Z): *"Leave it"*.

**A: the line stays "not yet labelled by two coaches".** #1096 was not changed
for it.

### 2. "Agree": fix the screen's readability before production

Overwatch put (23:51:39Z), after checking the screen on staging (its heading
measured 1.12 to 1 and its empty-state sentence 1.03 to 1 on the cream wall):
"*Official:* Fix the Label Agreement readability before production? A
(recommended): yes, a small fix lane to put the page on the same readable
ground as the other teach pages, then a quick re-check on staging. B: ship as
is and fix after." Jason, whole message (23:58:41Z): *"Agree do we have stuff
to deploy"*.

**A: the readability is to be fixed in a small lane.** Overwatch created the
chip "Make the Label Agreement screen readable" and said: "If you'd rather
ship tonight without the Label Agreement fix, say so". His next message was
*"Yes migrate anddeploy"* (OD-2026-10-02-002, release 5), and release 5 went
to production without the fix; overwatch stated before his approval click
that the screen ships as it is. The fix merged afterwards as #1108 and is on
staging, not in production, as of this entry (REPORTED by the overwatch
handoff of 2026-10-03; not re-checked here).

---

## OD-2026-10-02-018 -- The floor screens' layout: away from columns; the words he gave the UI lane on the look

**Provenance: PRIMARY.** Typed by Jason on 2026-10-02 (US Eastern; times UTC)
in the UI lane's thread and read by the records lane in that transcript
(`~/.claude/projects/C--Dev/a84862b0-abd8-495f-bf7a-ade6114cc50c.jsonl`).
Messages marked "sent mid-turn" were typed while the lane was working and are
recorded in the transcript with the time they were delivered. This entry is
new and edits no earlier one.

**What this entry is.** A record of his words on the look of the coach floor
screen and athlete My Corner, so the UI lane and any later builder can read
them. Under OD-2026-10-02-004 and -007 nothing about the UI's look binds;
these words direct the UI lane's work and are not a rule against changing the
look later. Mid-turn: *"Nothing binding  visually look will be less conflict
than anything binding at this point"* (19:31:51Z) and *"Remember nothing should
restrict"* (02:06:58Z).

**His words, in order.**

- On the mock-ups, whole message (23:28:20Z): *"We want to get away from
  columns"*. Mid-turn (23:28:48Z): *"If we need to we can go screen by screen
  at the laptop"*. The lane redrew the coach screen as A (full-width strips)
  and B (one thing at a time).
- (23:55:56Z): *"B, do a trial mock up for me"*. The lane took this as coach
  layout B, one thing at a time, and built a clickable trial on its mock-up
  canvas.
- (00:47:04Z): *"Try a mock up inspired by grok and canva the early mock
  ups"*; then (00:51:46Z): *"Those are still columns and blocks, what's
  directing you to do that"*; to the lane's composition question that
  followed (A the room is the screen, B one line at a time, C free-placed),
  (00:56:33Z): *"Those are the wrong ones then look at just can va"*.
- After the lane built from his Canva folder "PPBF LOOKS AND FEELS"
  (01:48:54Z): *"Those good go a head and execute those style you can ask
  canva to help bases off the early blood oxididization time frame see if you
  can find the descripts"*.
- Mid-turn (02:11:42Z): *"Look like we are shifting back to columns"*.
- The lane put (02:18:21Z): "Which layout should the coach screen use? - **A
  (recommended):** the Grok 002 chalkboard layout. Today's Floor roster on
  the left, "needs you now" in the middle, brass action plates on the right
  ... finished in the Canva oxidised-blood look. - **B:** the Canva Command
  Center or Ring Operations Hub panel layout, with gauges along the top and
  three columns below. - **C:** keep the single centred column I built and
  borrow only the materials from these pictures." Jason, whole message
  (02:20:13Z): *"B"*.
- Mid-turn: *"We are back on coloumns"* (02:28:57Z); *"Look into canva again
  for one that has cotton old brown leather cartoonist gages and buttons"*
  (02:30:05Z); *"Check in canva projects"* (02:32:50Z); *"Ppf landing
  platform has stuff in it"* (02:46:58Z).

**What was picked.** For the coach floor screen, B of the 02:18Z question: the
Canva Command Center / Ring Operations Hub panel layout with gauges along the
top. Its look words: Canva's early "blood oxidization" look, and old brown
leather with cartoon gauges and buttons. "We want to get away from columns"
and "We are back on coloumns", read together with the B he picked, is not
reconciled here; what layout he wants next is his to say to the UI lane.

---

## OD-2026-10-02-017 -- A stand-in architect while ChatGPT is out of usage: a Claude design session drafts the teach-AI plans; the two waiting jobs start

**Provenance: PRIMARY.** Typed by Jason on 2026-10-02 (US Eastern; times UTC)
in the teach-AI lane's thread and read by the records lane in that transcript
(`~/.claude/projects/C--Dev/346c32ec-ec56-4fad-817d-8da2643fb879.jsonl`). This
entry is new and edits no earlier one.

Jason, whole message (01:45:52Z): *"Check with overwatch and ask for
substitue"*. The lane put overwatch's options to him (01:46:19Z), official
then plain; option A read: "**Option A (overwatch's recommendation and mine):
a Claude design session drafts it tonight.** - Pros: moves now. ChatGPT's
earlier design is the starting point, so little is lost. Grok checks it
tonight and ChatGPT reviews it after the reset. Nothing is built or spent
until you approve each plan." B was wait for ChatGPT's reset, C Grok writes
it, D add ChatGPT credits now. It ended "Which one: A, B, C or D?". Jason,
whole message (01:49:30Z): *"Yes"*.

**A, read by the lane as the recommended option and relayed so:** a Claude
design session drafts the label-set plan and the pose-tool feasibility plan;
Grok gives a second opinion; ChatGPT reviews after its reset. Plans only; no
app change and no spend until he approves each plan. The architect role
(OD-2026-09-28-001) is not changed: this is a stand-in for one piece of work.

The lane then asked (01:57:04Z) whether overwatch should also start the two
other waiting jobs, the Label Agreement fix and Research intake part 2:
"Start them now, or leave them? "Both", "one" (say which), or "leave them"."
Jason, whole message (02:06:00Z): *"Start"*. **Read as both and relayed so;
both started from overwatch's session.**

---

## OD-2026-10-02-016 -- Teach-AI: the seven open items go with the recommendations (D2 A, D3 A, T4 A, T5 A, T6 A, T7 A, T8 B); stop raising safety and legal items already covered

**Provenance: PRIMARY.** Typed by Jason on 2026-10-02 (US Eastern; times UTC)
in the teach-AI lane's thread and read by the records lane in that transcript
(`~/.claude/projects/C--Dev/346c32ec-ec56-4fad-817d-8da2643fb879.jsonl`). This
entry is new and edits no earlier one. Nothing in it is built.

### 1. The stop

When the lane listed items it called new, Jason, whole message (02:21:21Z):
*"Those have already been decided, and you keep bringing them back up"*.
Overwatch then cut the list to seven, and the lane put them (02:24:14Z). Before
any answer to them, Jason, whole message (02:25:26Z): *"We have covered it in
another lane, stop you are drifting into safety and legal not function"*.

**Do not raise unrequested safety, legal or privacy questions, and do not
re-ask decided items.** Overwatch confirmed to the lane (relayed 02:25:48Z)
that nothing more from those drafts comes to him: the design questions are
the architect's calls with the recommended defaults, and the privacy and legal
items are marked as covered elsewhere.

### 2. The seven items

As put (02:24:14Z), each with its recommendation:

- "**D2. A punch where the coach can't tell if it landed.** A (recommended):
  frozen at full extension. B: frozen at the coach's best guess of contact."
- "**D3. A "can't tell" option for lead side.** A (recommended): yes, for
  when the feet are out of frame. B: no, the coach must pick one."
- "**T4. Where the trained tool is kept.** A (recommended): behind sign-in
  only, never public. B: public."
- "**T5. Footage withdrawn after training.** A (recommended): the next
  version is retrained without it and the old version is retired. B: the
  trained tool stands as it is."
- "**T6. Pass mark.** A (recommended): each point passes when the tool is
  about as accurate as two of your coaches are with each other. B: a fixed
  figure you set."
- "**T7. Camera angle.** A (recommended): coaches pick the camera angle from
  a fixed list (front, side, 45°, overhead and so on). B: keep free text."
- "**T8. Body size or gender on teaching footage.** A: record it, coarse and
  coach-entered. B (recommended): not until a trained tool exists and its test
  shows a need."

It ended: "Reply like **D2 A D3 A T4 A T5 A T6 A T7 A T8 B**, or just
"recommendations"." After the stop above and overwatch's reply, Jason, whole
message (02:26:49Z): *"Go with recommendation"*.

**All seven go with the recommendation, as the lane read and relayed it:**
D2 A (a punch whose landing can't be told is frozen at full extension); D3 A
(lead side has a "can't tell" option); T4 A (the trained tool is kept behind
sign-in, never public); T5 A (withdrawn footage means the next version is
retrained without it and the old version retired); T6 A (a point passes when
the tool agrees about as well as two coaches agree with each other); T7 A
(camera angle from a fixed list); T8 B (no body size or gender recorded on
teaching footage until a trained tool exists and its test shows a need).

---

## OD-2026-10-02-015 -- Research intake part 2: the platform shelf is worked from the existing pages; Admin@ stops writing the gym shelf; admin uploads are not linked to the Library; archive wiring later; a submission still never resolves a requirement

**Provenance: PRIMARY.** Typed by Jason in the overwatch thread on 2026-10-02
(his evening; 2026-10-03 UTC) and read in that transcript
(`~/.claude/projects/C--Dev/5b2fe0c3-80bd-4765-873d-9a0be7fc987d.jsonl`). This
entry is new and edits no earlier one. It follows OD-2026-10-02-013. Nothing
in it is built.

A read-only planning step (overwatch's background agent; plan file
`Documents\PPBF-overwatch\lane-inbox\RINT-part2-plan-DRAFT.md`) found what the
next pieces need. Overwatch put them to him, recommendation on each, ending
'Reply like "D2 A D3 A D4 A D5 later D6 A", or tell me which to skip':

- "D2: Admin@ works the platform shelf from the existing research and
  evidence pages, not a separate new page. Recommend yes."
- "D3: today Admin@ can also write to the gym's shelf from the research page.
  I'd remove that so it matches your "platform for platform, gym for gym".
  Recommend yes."
- "D4: linking admin uploads to the library, as you picked it, would pull
  athlete intake files into research. Every upload type on that admin page
  today is athlete intake: medical forms, waivers and the like. That clashes
  with keeping whole PDFs in SharePoint. Recommend: let the PDF reader being
  built now cover it instead, and drop that item."
- "D5: wiring research originals into the SharePoint archive needs a
  database change, a new production secret, and proof the app may write to
  that library. Recommend: later, as its own item."
- "D6: keep the rule that "a submission never resolves a requirement"
  (recorded, binding). Recommend keep."

Jason, whole message (02:19:19Z): *"Agree with recomendtions"*.

- **D2.** The platform owner (Admin@) works the platform shelf
  (`__platform__`) from the existing `/research` and `/evidence` pages, not a
  new page (carries out OD-2026-10-02-013 answer 1B).
- **D3.** Admin@ no longer writes to a gym's shelf from `/research`
  (`apps/web/src/server/pilot/shadowRoleSets.ts:112-116`, as the plan read
  it), matching his "platform for platform gym for gym".
- **D4.** RINT-03 (linking `/admin/shadow` uploads to a Library source) is
  dropped; the PDF reader of RINT-02 covers research PDFs. Athlete intake
  files stay out of research.
- **D5.** RINT-04 (wiring research originals into the SharePoint Research
  Archive) waits, as its own item; it needs a migration, a production secret
  and proof of write access to that library.
- **D6.** The rule that a research submission never resolves a requirement
  stands; RINT-06 is not built.

---

## OD-2026-10-02-014 -- Named stance types are labelled too, once per event, by sanctioning body

**Provenance: PRIMARY.** Typed by Jason in the teach-data lane's thread on
2026-10-02 and read in that transcript
(`~/.claude/projects/C--Dev/346c32ec-ec56-4fad-817d-8da2643fb879.jsonl`). This
entry is new and edits no earlier one. It adds to OD-2026-10-02-011 section 3b.
Nothing in it is built.

After "Well put all in" (guards, OD-2026-10-02-011 section 3b), the lane noted
that some of AIBA's entries are stance positions that overlap the stance
field. Jason, whole message (23:29:49Z): *"We can add stance as well"*. The
lane then set out three separate fields (lead side; stance type, "the body's
named stance"; guard type) and asked (23:30:03Z): "Stance-type sampling. A:
tagged at each of the three marked moments, like guard. B: tagged once per
punch or defence." (B recommended). Jason, whole message (2026-10-03T01:43:51Z):
*"B"*.

**Each event also carries a stance-type label, tagged once per punch or
defence**, from the sanctioning bodies' named stances kept separate by body,
each with that manual's definition, purpose and page, plus other and unknown;
never good or bad. As read so far (lane's source file
`Documents\PPBF-overwatch\lane-inbox\TEACH-BIOMECH-guard-sources-2026-10-02.md`):
AIBA's up-right, crouching, frontal, frontal with closed arms, weight to lead
leg, weight to rear leg, and long, medium and short-distance stances; USA
Boxing's basic stance; USIBA's on-guard position. AIBA's stance entries move
out of the guard list into this one.

Unchanged: lead side (orthodox, southpaw, neutral/square, switching) and guard
type are still recorded at each of the three marked moments
(OD-2026-10-02-011 section 3b).

---

## OD-2026-10-02-013 -- Research intake: the platform owner writes the platform shelf in the app; licensed excerpts stay private; platform material on the platform shelf, gym material on the gym shelf; curator-chosen excerpts only; approval as today

**Provenance: PRIMARY.** Typed by Jason in the overwatch thread on 2026-10-02
(his evening; 2026-10-03 UTC) and read in that transcript
(`~/.claude/projects/C--Dev/5b2fe0c3-80bd-4765-873d-9a0be7fc987d.jsonl`). This
entry is new and edits no earlier one. It answers the research-intake lane's
open owner questions 1 to 5 (`ACTIVE_WORK.md` rows on platform library writes,
licensed excerpts and research placement); question 6 was answered in
OD-2026-10-02-006 section 2. Nothing in it is built.

From overwatch's list of what is left to build, Jason, whole message
(00:50:37Z): *"Let do 8"*, item 8 being the research-intake follow-ons (PDF
text extraction, linking admin uploads to the Library, platform-library
writes), which wait on five questions. Overwatch put them (A recommended in
each):

"1. Who may write to the platform-wide library (shared research every gym
reads)? A: only the operator-run import workflow, for now. B: the platform
owner, through an in-app screen. C: gym admins propose and the platform owner
promotes."

"2. Licensed excerpts (copyrighted text): where are they stored? A: private,
in the database only, never in the public code repository. B: in the public
repository, like the existing 1,193."

"3. Which shelf does research go on? A: published papers go to the platform
shelf and PPBF's own documents to the gym shelf. Until question 1 allows
platform writes, papers sit on the gym shelf, marked for later promotion. B:
everything on the gym shelf."

"4. Uploaded PDFs: how much text does the app keep? A: only excerpts a curator
picks, with citation and page; whole PDFs stay in your SharePoint Research
Archive; full text only for PPBF-owned or open-licence material. B: the full
text of anything uploaded."

"5. Who approves a source before SHADOW may cite it? A: as today, an org
admin, admin or platform owner, and the same person who entered it may approve
it, for the pilot. B: the approver must be a different person from whoever
entered it. C: coaches can approve too."

Jason, whole message (00:55:32Z): *"1 b 2a 3  platform for platform gym for
gym 4 A 5  a"*.

1. **B.** The platform owner writes platform-library (`__platform__`) rows
   through an in-app screen. Not built; who is the platform owner is
   OD-2026-08-29-001 (Admin@).
2. **A.** New licensed excerpts are stored privately, in the database only,
   never committed to the public repository.
3. **Platform material on the platform shelf, gym material on the gym shelf**
   (his words). Read with 1B, the interim of option A (papers waiting on the
   gym shelf until platform writes exist) does not apply once the in-app
   platform screen is built; until it is, papers have no in-app route to the
   platform shelf. **INFERRED.**
4. **A.** The app keeps only excerpts a curator chooses, with citation and
   page; whole PDFs stay in the SharePoint Research Archive; full text only
   for PPBF-owned or open-licence material.
5. **A.** Approval stays as today for the pilot: an organization admin, admin
   or platform owner approves on `/evidence`, and the person who entered a
   source may approve it.

---

## OD-2026-10-02-012 -- Workout intake: the AI prompt is to link steps to the gym's own drills (a second item, after #1103)

**Provenance: PRIMARY.** Typed by Jason in the workout-upload lane's thread on
2026-10-02 and read by overwatch in that transcript
(`~/.claude/projects/C--Dev/08ba83a5-20e8-4531-ad03-384557eec256.jsonl`). This
entry is new and edits no earlier one. Nothing in it is built.

His definition of the work: *"this should be done in a way that when i drop a
prompt into  another Ai it can structure the document in way that seasy
intake"* (19:02:44Z); to the lane's option A for the first item (a
workout-only prompt with a "Copy AI prompt" control on the content import
screen, the files uploaded on the existing screen): *"Q1 will this hinder
anything content wise, the content should be able to change as needed if so
yes"* (21:48:10Z). Asked then whether the lane should build from its own
draft or wait for the architect: *"Check in with overwatch"* (22:18:19Z), on
which overwatch ruled build now (item 1, PR #1103, words only).

Then *"Can it do both, drills will eventually expand with links connecting
skills in it"* (23:00:18Z). The lane put (23:00:37Z): "Approve item 2,
"drill-linked workout prompt", as a new lane after #1103 merges? ... A
(recommended): The prompt carries the gym's drill list. Steps link to a drill
when it clearly matches, use words otherwise, and the AI asks when unsure.
Your drill names go to the AI you use. No athlete data. B: Same as A, but only
drills you have approved for use. C: Stay with words only for now." Jason,
whole message (23:08:52Z): *"A"*.

**Item 2 is approved as a new lane after #1103:** the prompt carries the
gym's drill list; a step links to a drill on a clear match, is written in
words otherwise, and the AI asks when unsure. The gym's drill names go to
whatever AI the admin pastes the prompt into; no athlete data does. Not
limited to approved drills (he chose A over B). Which drill states count as
the gym's list is not settled.

Status (2026-10-03): which drill states count is settled by OD-2026-10-03-002
section 7: the current reference heads, as built.

---

## OD-2026-10-02-011 -- PPBF builds its own pose model from nothing; coaches hand-mark every point until it exists (replaces pick 8A); it runs inside the app on the gym's own devices; all 24 points at three moments on every event (replaces the click range). The agreement screen's opening sentence

**Provenance: PRIMARY.** Typed by Jason in the teach-data lane's thread and
the agreement-report lane's thread on 2026-10-02, and read by overwatch in
each transcript (`~/.claude/projects/C--Dev/346c32ec-ec56-4fad-817d-8da2643fb879.jsonl`
and `~/.claude/projects/C--Dev/07cd0b14-cb11-403c-871d-01b351819222.jsonl`).
This entry is new and edits no earlier one. **Section 2 replaces pick 8A,
and section 3a replaces the click range, of OD-2026-10-02-008**; that entry's
text is not edited. Nothing in sections 1 to 3a is built, designed or costed.

### 1. Where the pose tool runs

To the architect's question of tablet or server he said: *"It needs to be part
of the app"* (21:33:17Z); then *"Tablet is not the only hardware available"*
(21:40:58Z); asked which hardware, *"The pc this tablet galaxy s10  phones and
android if possible"* (21:45:22Z); asked whether "galaxy s10" was the tablet or
the phones, *"Tablet"* (21:51:12Z).

**The pose tool is part of the app and runs on the gym's own devices:** this
Windows PC, a Samsung Galaxy Tab S10, phones, and Android generally if
possible. No server was chosen. Phone models and the exact tablet variant are
not stated.

### 2. Build our own, from nothing

He asked for the remaining decisions one at a time: *"Ask each individual pros
cons and options"* (22:05:58Z). To the first (run a read-and-test proof of an
existing pose tool) he replied: *"1 Can we build our own"* (22:14:42Z). The
lane answered (22:14:56Z) with two options:

"Option D: build a pose tool from nothing. Training from scratch: teaching a
blank model to find body points using only your own labelled footage." Its
stated cons: "it needs a very large amount of labelled footage before it works
at all ... You have close to none yet. It also needs paid graphics-card
computing time and machine-learning work that is currently parked. Until it
works, coaches hand-mark every point with no help." and "Whether it produces a
usable tool from the footage you'll have is NOT SURE".

"Option E (recommended): start from an existing tool, and turn it into yours.
Fine-tuning: taking a tool that already finds bodies and continuing its
training on your footage."

Jason, whole message (22:15:39Z): *"D"*.

**D.** PPBF builds its own pose model from nothing, trained only on its own
labelled footage. No third-party pose model is its base.

The lane then asked what coaches use until that model exists (22:16:01Z): "A:
fully manual landmark annotation. B: an existing pose tool as a temporary
pre-fill aid only, replaced by the PPBF model when it passes its acceptance
test." (B was its recommendation.) Jason, whole message (22:24:53Z): *"The
coach's are the one helping build the tool they won't use anything until we
develop  it"*.

**A.** Coaches hand-mark every point. No borrowed pose tool is used, not as a
temporary helper either, until PPBF's own is developed. This replaces pick 8A
of OD-2026-10-02-008 (a pose tool pre-fills points for coaches now).

### 3. What section 2 does not decide

- **Training is chosen as the direction and nothing more.** How the model is
  trained, how labelled footage is exported, what computing it needs and
  costs, and the test for accepting a trained model are not designed and not
  approved. The lane told him the computing cost comes back to him for a yes
  before anything is spent. No spending is approved by this entry.
- The architect's decisions about machine proposals (provenance of a
  proposed point, derived points, what "corrected" means) have nothing to
  apply to while there are no proposals. **INFERRED** by the lane; the
  architect's to confirm.
- (Answered in section 3a: all 24 points are required, chin included.)
- Scoring an athlete from video stays parked (OD-2026-09-28-006).

### 3a. Every point at three moments: the click range is replaced

The lane asked which points a coach must mark every time (22:26:29Z): "A:
13 required (ChatGPT's 12 plus chin), up to 39 clicks per punch. B
(recommended): 9 required (chin, shoulders, elbows, gloves, hips), up to 27
clicks per punch, the rest optional. C: all 24 required, up to 72 clicks per
punch." Jason, whole message (22:28:22Z): *"C"*.

It then asked how many moments are required (22:28:39Z), A contact required
with start and end optional (recommended), B all three required, C start and
end required with contact when there is one. Jason (22:32:42Z): *"B/c which
one gives the most data  ....and smaller number of videos with more clicks
will be faster in the end if done with patience in my opinion"*. The lane
answered that B gives the most and put (22:32:55Z): "B, with a rule for
misses: every punch is marked at three moments, start, contact, end, and
when there's no contact, the middle moment is full extension (the glove at
its furthest point from the body). ... 72 taps each, no lighter option. ...
"Glove at its furthest point" is my suggested wording; change it if you'd put
it differently. ... Is it B with full extension for misses? A "yes" settles
it." Jason, whole message (22:42:11Z): *"B yes"*.

**All 24 points are required, at three moments on every punch and every
defence: start, contact, end.** Each point is placed or marked not visible;
there are no optional points and no lighter option. When there is no contact
the middle moment is **full extension**, worded by the lane as "the glove at
its furthest point from the body" and accepted by his "B yes" without
rewording. His reason, in his words above: depth per clip over number of
clips. **This replaces, for the first build, the click range of
OD-2026-10-02-008** (his 19:38:26Z words and the required-core-plus-optional
shape); "not visible" is now the only variation. It also brings a third,
written middle moment back where -008 left "peak" out.

Not decided: the middle-moment rule for a defence with no contact (a slip, a
block, a parry): full extension is written for punches. The architect's.

### 3b. Left and right, a neutral stance, and guard labels

After the lane summarised his body-point decisions (22:42:25Z) he wrote
*"Correct and we need left right or lead rear netral"* (22:52:03Z). Asked to
choose (A: points named left/right, the stance recorded at each marked moment
with neutral added, lead/rear worked out from the stance; B: points named
lead/rear directly), Jason, whole message (22:56:15Z): *"Left and right"*.
Asked whether "neutral" meant "a square stance, feet level with neither side
leading" (22:56:24Z): *"No the stance was correct but you did bring up a good
point on guard"* (23:03:46Z).

**Points are marked left or right; lead and rear are worked out from the
stance, never clicked.** The stance is recorded at each marked moment, and
the stance list gains **neutral: a square stance, feet level, neither side
leading.** Points on the midline (nose, chin, neck, mid-hip) carry no side.

Guard was then put to him (23:04:15Z): "A: a guard-type label at each marked
moment, from a fixed vocabulary you ratify, with "other" and "unknown", and no
quality judgement. B: no guard label ... C: guard as its own event class,
labelled between punches." Jason, whole message (23:07:44Z): *"A"*.

The lane read four coaching manuals and first reported that two bodies'
guard names described the same position. Jason (23:14:10Z): *"No there are
differences  for each of those guards, each of those bodies are different
sanction bodies so different reason for each of the named guards"*. The
lane withdrew that reading and put (23:14:29Z): "A: each sanctioning body's
named guards kept as separate labels, each tagged with its body and carrying
that manual's definition and stated purpose. B: one body's guard list only.
C: PPBF's own plain descriptive labels." Jason (23:16:47Z): *"A"*. Asked which
bodies go in (a table of USA Boxing, AIBA, Boxing Australia and USIBA and the
guards each names, with the lane's note that some AIBA entries are stance
positions as much as guards and "would come in only where they describe the
arms"), Jason, whole message (23:26:44Z): *"Well put all in"*.

**A guard label is recorded at each of the three moments.** The vocabulary is
each sanctioning body's named guards kept as **separate labels**, each tagged
with its body and carrying that manual's definition, stated purpose and page,
plus other and unknown; never good or bad (the closed vocabulary rule of
ontology 0.1 stands). **All four bodies, every named guard or position:** USA
Boxing, AIBA (now IBA), Boxing Australia and USIBA, as read in
`Documents\PPBF-overwatch\lane-inbox\TEACH-BIOMECH-guard-sources-2026-10-02.md`.
That AIBA's stance-like entries are included too is **INFERRED** from "all";
some overlap the separate stance field, for the architect. Whether USA Boxing
is PPBF's own sanctioning body was not checked.

### 4. The agreement screen's opening sentence

ChatGPT's review of PR #1096 found that "Top disagreements" ranked kinds of
disagreement that are not on one scale. Asked for a replacement, he first
wrote *"Remember we are teaching the AI  we need room for it to learn"*
(22:13:35Z), which chose no option and which he has not said means anything
wider; then *"Explain in layman"* (22:19:32Z). The lane put it plainly: "New
version (what I recommend): "6 clips compared. The two coaches differed on:
which punch it was, the timing, the stance." It lists everything they saw
differently and doesn't claim which is worst. The exact counts are one tap
away under "Show detail"." Jason, whole message (22:22:20Z): *"Yes new
version"*.

**The opening sentence names every kind of disagreement found, with no counts
and no ranking.** This replaces the example sentence of OD-2026-10-02-010
section 2 item 1; the rest of that item stands.

---

## OD-2026-10-02-010 -- Two "Yes" answers: the look-pin tests are covered by "remove anything that will hinder this"; the Label Agreement screen, what coaches see on it, and the tablet hand-over

**Provenance: PRIMARY.** Typed by Jason in the UI lane's thread and in the
agreement-report lane's thread on 2026-10-02, and read by overwatch in each
transcript (`~/.claude/projects/C--Dev/a84862b0-abd8-495f-bf7a-ade6114cc50c.jsonl`
and `~/.claude/projects/C--Dev/07cd0b14-cb11-403c-871d-01b351819222.jsonl`).
This entry is new and edits no earlier one. Section 1 answers the reading
OD-2026-10-02-009 recorded as inferred.

### 1. The UI lane's four items

The UI lane's message (21:13:29Z) told him that two of the suites its test
PR deletes fail on this PC and pass on CI, and ended:

"Waiting on your answers (a reply like "1A 2A 3A, yes to 4" is enough):
1. "Remove anything that will hinder this" covers the look-pin tests: A yes
(recommended) / B no.
2. Corner-colour check: A keep (recommended) / B remove.
3. Remaining look-bound tests: A fix each with its screen (recommended) / B
rewrite all now.
4. /login dark panel; board/file fix what's hard to read, no new art."

Jason, whole message (21:42:10Z): *"Yes"*.

**Item 1: yes.** His "Ok remove anything that will hinder this"
(OD-2026-10-02-009) covers the tests that pin a look. They are removed now.

**Item 4: yes.** The /login readability fix is a dark panel behind the text;
the board and file screens get a fix to what is hard to read, with no new art.

**Items 2 and 3 are A-or-B questions and he answered "Yes" without a
letter.** Read as taking the recommended option in each, A and A: the
corner-colour check stays, and the remaining look-bound tests are fixed one
at a time with the screen each belongs to. **INFERRED** (the UI lane's reading
and overwatch's); both are the option that removes nothing. So the question
OD-2026-10-02-007 left open, whether "decoration must not be mistakable for a
safety state" binds, is not answered by a letter of his: the test that holds
it stays in place on this reading, and the proposition stays unratified.

### 2. The agreement-report lane's four recommendations

Earlier in that thread: *"It needs to be simpler to use,"* (19:28:35Z) and
*"Ok also make it that it does not have to be 5 separate accounts, I can hand
the tablet over to another and not have to log out"* (19:33:46Z). Then *"Ok
tell me how your recommendations work in Lyman terms"* (21:36:29Z). The lane
set out four (21:36:39Z), under these headings and with these closing words:

"1. The screen ("Label Agreement")": two coaches each label the same clip,
the screen says where they saw it differently, one sentence, more behind
"Show detail"; "it does not grade a coach or a boxer."

"2. Show coaches the "still to do" line": "a line like "3 of 10 clips still
need a second coach." ... The only thing it gives away is that another coach
has or hasn't started, never what they tapped."

"3. Below 5 clips, show counts but no percentages": "ChatGPT would rather show
nothing at all until 5. Its worry is that a third coach could peek at how the
first two differed on a clip before labelling it and be nudged by that. I
recommend keeping the counts. ... If you later add a third labeller, this is a
one-line switch."

"4. Tablet hand-over: pick your name, then a short PIN": "coach one finishes
and taps "Switch labeller"; coach two taps their own name and types a 4-digit
PIN ... The screen clears, so coach two can't see coach one's answers. ...
This is a separate piece of work from the screen, because it changes how
sign-in works."

"If those four sound right, "yes to all four" is enough and I'll pass your
exact words to overwatch."

Jason, whole message (21:38:44Z): *"Yes"*.

**1.** The screen is named Label Agreement and takes the simpler layout.
**2.** Coaches see the still-to-do line.
**3.** Below 5 compared clips coaches see counts and no percentages. This is
his choice over the architect's recommendation, made with the third-coach
point in front of him.
**4.** The tablet hand-over is wanted in that shape: a labeller switch by
name and a short PIN, the screen cleared between labellers. It is not built
and is not part of the report; it goes to the architect as its own work
order. The two-labeller study needs 2 labellers and 5 clips, not 5 accounts.

Not covered by that "Yes": the wording of the door to the screen on the Teach
Shadow page. The lane asked him separately (21:41:12Z): "Official: approve the
door wording on the Teach Shadow home page: section "Stage five: Measure",
text "See where two coaches labelled the same clip differently. It measures
the labelling, not a coach and not an athlete.", button "Label Agreement".
Options: A approve as written (recommended); B your wording." and, in plain
words, "Say "yes" or give me the words you want." Jason, whole message
(21:43:18Z): *"Yes"*. **The door wording is approved as written.**

---

## OD-2026-10-02-009 -- "Remove anything that will hinder this": read as removing now the tests that pin a look

**Provenance: PRIMARY.** Typed by Jason in the UI lane's thread on 2026-10-02
and read by overwatch in that transcript
(`~/.claude/projects/C--Dev/a84862b0-abd8-495f-bf7a-ade6114cc50c.jsonl`).
This entry is new and edits no earlier one.

No question about a test list was in front of him. The UI lane's message
before his (19:41:11Z, read by overwatch in the transcript) was a status:
"Status only, nothing for you to do: your "nothing in the UI is tied down"
ruling is now on main (OD-2026-10-02-004, via #1087). #1089 has no conflict
with the new main and is with ChatGPT; it merges after overwatch's Law 2
record (#1092)." followed by two items still open with him (the /login panel
and the board/file readability fix). Jason, whole message (19:42:53Z): *"Ok
remove anything that will hinder this"*.

**Reading, INFERRED (the UI lane's and overwatch's), his to correct:** "this"
is the ruling that status named, that nothing in the UI's look or flow is tied
down (OD-2026-10-02-004, -007); and "anything that will hinder" it includes
the tests that fail a change only because a screen's look, markup, class names
or control layout changed. On that reading those tests are removed now,
without waiting for each to be tripped. It is the item OD-2026-10-02-004
section 2 left open ("which tests are style pins and what happens to each").

Outside the reading: tests that hold his standing floor (people's safety and
safeguarding, minors' privacy, authorization, data integrity, not shipping
something false) and the readability floors (tap size, type size, contrast,
focus ring). Those stay. Whether a test that keeps decorative colour visually
apart from safety colour is a safety guard or a look pin is the open question
of OD-2026-10-02-007 and is not settled here.

Which test is which is not decided by this entry. The case-by-case list is
the UI lane's, checked by two adversarial reviewers and by ChatGPT, and lives
in that lane's pull request.

---

## OD-2026-10-02-008 -- Teaching the recognizer body points: positions clicked at set moments; a 24-point list with glove and chin; a click range; a pose tool that pre-fills; the agreement report is built now

**Provenance: PRIMARY.** Typed by Jason in the teach-data lane's thread on
2026-10-02 and read by overwatch in that transcript
(`~/.claude/projects/C--Dev/346c32ec-ec56-4fad-817d-8da2643fb879.jsonl`).
This entry is new and edits no earlier one. It carries forward the direction
recorded in OD-2026-10-02-006 section 1 item 4. Nothing in it is built.

The lane put ChatGPT's six design decisions to him. He had it ask ChatGPT and
Grok first: *"Ask chat gpt and also ask grok (navigate out of image)"*
(19:23:21Z). Grok's answer is advice he asked for on this one question; Grok
holds no standing role beyond images (OD-2026-09-28-001) and ChatGPT remains
the architect.

### 1. His shaping words, in order

- *"Before picking anything can we have a range of clicks, not every video as
  this evolves will provide the same number of clicks,"* (19:38:26Z). The lane
  answered with a small required core of points plus optional further points
  and moments, a skipped point stored as not marked. He replied: *"Good, as
  far as points go, find real sources that name the bio mechanic point that
  can be read, eventually the AI should be able to recognize punches of more
  than one bi mechanic point"* (19:42:26Z).
- After the lane's report of the standard landmark lists: *"Thats fine we are
  building from scratch,  the more points the better"* (20:03:34Z).
- *"Hands should be just be gloves, add chin show list"* (20:11:26Z).
- *"We want a pose tool in the model,  multi size people and genders would
  look different"* (20:21:33Z).
- Told that no pose tool finds a glove or a chin: *"Then we put that node in"*
  (20:25:52Z). Asked which of two readings he meant, "1. Add glove and chin as
  new points the pose tool learns to find. Coaches mark them by hand at first;
  those marks become the training data that teaches the tool the two extra
  points." or "2. Put the pose tool in as a step of the system", he answered,
  whole message: *"1"* (20:26:28Z).

### 2. The list

He asked the lane to *"Expand"* (20:28:17Z). Its write-up ended with the list
and the sentence "Saying "yes" makes this the list ChatGPT designs to. Two
placement rules come with it so coaches click the same spot: glove is the
centre of the padded knuckle area; chin is the tip of the chin." Jason, whole
message (20:32:39Z): *"Yes"*.

**The ratified list, 24 points:** head (nose, chin); trunk (neck, mid-hip);
each arm (shoulder, elbow, wrist, glove); each leg (hip, knee, ankle); each
foot (heel, big toe, small toe). Glove is the centre of the padded knuckle
area; chin is the tip of the chin. Hand points (index, pinky, thumb) are not
in it. Glove and chin have no equivalent in the standard pose lists the lane
read. The list can grow; adding a point is a new version of the label set.

### 3. The remaining picks

The lane asked whether that "Yes" also took its recommended option on the
other eight, and listed them: "1A: click positions; 2A: standard list plus
your additions; 3A: start, contact, end; 4A: old studies finish on old labels;
5B: build the disagreement screen now; 6B: leave the skill-family map open;
8A: pose tool pre-fills for coaches now; 9A: mark only the person throwing or
defending". Jason, whole message (20:48:13Z): *"Yes it does"*.

As each option was put to him in the expanded write-up:

- **1A.** A label is a position: the coach clicks where each body point is on
  the picture.
- **2A.** The list starts from the standard lists, with his boxing points
  added, and he signs it off (section 2).
- **3A.** Points are marked at set moments: start, contact, end. "Peak" is
  left out until it has a written rule.
- **4A.** Studies already under way finish on today's labels; new studies get
  body points; never mixed.
- **5B.** The agreement report is built now for today's labels, with a line on
  screen saying body points are not included yet.
- **6B.** The punch-to-skill-family map (IMP-14) stays open.
- **8A.** A pose tool places the standard points on the labelling screen and
  coaches correct them; the same tool feeds the recognizer later. Each point
  records accepted, corrected or not visible.
- **9A.** Only the person throwing the punch or making the defence is marked;
  the other person only when the event is contact against them.
- **Wrist** stays in the list (it is in the list he ratified); the lane's
  recommendation was that it be an optional point beside the glove.

### 4. What this does not decide

- **Which pose tool, its licence, and where it runs** (on the tablet, or on a
  server, which means minors' footage going to it and possibly a bill). The
  lane told him these come back to him before anything is built or spent.
- **The contents of the required core** of the click range. The lane's example
  was illustrative and is not ratified.
- **Training.** Teaching a pose tool the glove and chin points is model
  training, which is parked. His "1" states the intent; it does not un-park
  training or approve spending. The lane told him so. **INFERRED** that he
  accepted that limit: he did not object.
- Scoring an athlete from video stays parked (OD-2026-09-28-006).

8A replaces the "no pose model" line of the architect's first design; the
design is the architect's to redo, for his approval.

---

## OD-2026-10-02-007 -- Law 2's palette limit no longer binds; nothing about the look binds

**Provenance: PRIMARY.** Typed by Jason in the UI lane's thread on 2026-10-02
and read by overwatch in that transcript
(`~/.claude/projects/C--Dev/a84862b0-abd8-495f-bf7a-ade6114cc50c.jsonl`).
This entry is new. It changes OD-2026-09-28-009 as far as that entry kept
Law 2's palette limit; that entry's text is not edited.

The UI lane put this to him (19:12:30Z):

"Official: Does the palette limit in Law 2 (OD-2026-09-28-009) still bind UI
work? A (recommended): Keep only the safety half as binding: `--locked` is a
medical stop, and nothing decorative may be mistaken for a cleared, monitor or
restricted mark. The "green, blue and orange for nothing else" limit is
dropped. B: Keep Law 2 whole, as it is today."

"Plain: A lets a design use green, blue or orange for looks, as long as nobody
could confuse it with a safety status. B keeps those three colours reserved
for safety and status only, everywhere."

Jason, whole message (19:31:51Z): *"Nothing binding  visually look will be
less conflict than anything binding at this point"*.

**The palette limit is dropped.** Green, blue and orange are no longer reserved
for safety and status; a design may use them for looks. More generally, no
rule about the look itself binds UI work, which is OD-2026-10-02-004 said
again for Law 2.

He did not pick A or B by letter. What stays is not a look rule and is not
from this answer: a safety or medical state shown on a screen must not be
mistakable for decoration, and decoration must not be mistakable for a
cleared, monitor or restricted mark. Overwatch and the UI lane read that as
his standing floor (people's safety, and not shipping something false) and
not as something this answer loosened. **INFERRED**; his to correct.

---

## OD-2026-10-02-006 -- Teaching the recognizer: TEACH-DATA-01 approved; the agreement report is next and is for coaches and organization admins; labelling is to cover the body parts of the movement. Research intake stores the source's own words

**Provenance: PRIMARY.** Typed by Jason in two lane threads on 2026-10-02 and
read by overwatch in each lane's transcript
(`~/.claude/projects/C--Dev/346c32ec-ec56-4fad-817d-8da2643fb879.jsonl`, the
teach-data lane; `~/.claude/projects/C--Dev/098e018b-1b76-4cdc-a641-17d2025a72c2.jsonl`,
the research-intake lane). This entry is new and edits no earlier one.

### 1. The teach-data lane's four questions

The lane put four questions to him (18:30:42Z), each with a recommended A:

"1. Approve TEACH-DATA-01 for build? Options: A approve (recommended); B hold."

"2. Next item after that? Options: A agreement report on a screen
(recommended); B gold nominate/promote screen; C governed export of labels; D
none yet."

"3. If 2A: who sees the agreement report, and does the minimum stay at 5
compared clips? Options: A coaches and organization admins, keep 5
(recommended); B organization admins only, keep 5; C other number."

"4. IMP-14 punch-to-skill-family map (open since 2026-09-30): OK as written?
Lead straight → Jab; rear straight → Rear-Hand; hooks → Hooks; uppercuts →
Uppercuts; body target → Body Attack; defence → Defense-to-Counter. Options: A
OK (recommended, with a body jab counting for both Jab and Body Attack); B
edit."

Jason, whole message (18:58:58Z): *"go with recomendations except 4) i think
with the punch recognition we need to add more labeling while we teach the
ml/AI, to in clude but not limited to ellbow shoulder hips knees toes heel,
basicallly all the parts of the biomechanicsl of the movements in boxing"*.

**1 is A.** TEACH-DATA-01 (point the labelling screen at the teaching playback
route, with its tests and the stale comments) is approved for build.

**2 is A.** The next item is the agreement (QA) report on a screen. It is a
separate lane.

**3 is A.** Coaches and organization admins see it; below 5 compared clips the
screen shows counts and no percentages.

**4 is not answered as asked.** The punch-to-skill-family map (IMP-14) stays
open. In its place he gave a new direction: labelling for punch recognition is
to cover the body parts of the movement, the elbow, shoulder, hips, knees,
toes and heel named and the list not closed. That changes what is labelled and
is not built or designed; it goes to the architect for a work order he
approves.

### 2. Research intake: the source's own words

The research-intake lane put its question 6 to him (18:29:25Z):

"A (recommended by ChatGPT and by me): verbatim, source-faithful excerpt split
into deterministic ordered chunks. B: curator-written claim-style chunks."

Jason, whole message (18:59:55Z): *"A"*.

**A.** What the library stores from a source is the source's own words, split
into ordered chunks, and not a curator's summary. This answers question 6
only; the lane's other owner questions are open.

---

## OD-2026-10-02-005 -- The write log lists durable writes only; session scratch files are not listed

**Provenance: PRIMARY.** Typed by Jason in the visual lane's thread on
2026-10-02 and read by overwatch in that transcript
(`~/.claude/projects/C--Dev/afc03b35-5731-4ad4-ab64-43db0e62ea6a.jsonl`).
This entry is new and edits no earlier one. It narrows what the write log
covers; OD-2026-10-01-008 section 6 is unchanged.

ChatGPT's review of PR #1086 asked that two enlarged crops of a reference
photograph and some patch scripts, all in a session scratch folder, either
carry his authorizing words or be marked as write defects. The visual lane put
this to him (18:53:31Z):

"Official: should session scratch files be dropped from the WRITES table
entirely, leaving it to cover durable writes only — repo, GitHub,
OneDrive/SharePoint, database, production?

Plain: should I stop logging the temporary junk files I make while working,
and only log things that actually persist somewhere? I think yes. If you
agree, this class of finding stops happening."

Jason, whole message (19:00:23Z): *"yes"*.

**From that answer forward** the WRITES list in a report, handoff or PR body
covers durable writes: the repository, GitHub, SharePoint, OneDrive, Google
Drive, a database, staging, production. Temporary files in a session's scratch
folder are not listed. Everything else about the write log stands: each
durable write carries what, where, its id or SHA and his exact authorizing
words; a durable write without such words is a defect; "WRITES: NONE" is
still stated when there are none.

Not changed by this entry: his own rules file still words the rule as "each
write made"; that file is his to edit. ChatGPT's project instruction carries
the same wording and is his to edit or authorize.

---

## OD-2026-10-02-004 -- Nothing in the UI is tied down: the old look-and-flow standards stop binding, and their wording is changed, not labelled as history

**Provenance: PRIMARY.** Typed by Jason in the UI lane's thread on 2026-10-02
and read by overwatch in that transcript
(`~/.claude/projects/C--Dev/a84862b0-abd8-495f-bf7a-ade6114cc50c.jsonl`).
This entry is new and edits no earlier one.

### 1. The ruling

Jason, whole message (18:06:09Z): *"ok i want to you check in with chat gpt
like the other lanes do, to be clear nothing in the UI is tied down we can
change things to make itmore user friendly visually appealy functional ect, i
dont want any laws, setting or verbage in docs hindering that, so before we
start building anything i want to make sure we are set up in such a way that
we dont start drift because of old standards"*.

**Nothing in the UI's look or flow is fixed.** No law, setting or wording in a
document is a ground to refuse a UI change that makes the app more usable,
better looking or more functional, or to raise a review finding against one.

What still binds a UI change, by his standing rules and not by this entry:
people's safety and safeguarding, minors' privacy, authorization, data
integrity, and not shipping something false. The readability floors (tap
size, type size, contrast, focus ring) stay; the UI lane and ChatGPT both read
them as function.

One test needs saying plainly. `foundationMatchesLegacy` names the tap-size
and type-size tokens, and it also requires every other token the foundation
shares with the retired sheet (spacing, radius, proportion, motion) to equal
the retired sheet's value
(`apps/web/src/design/foundationMatchesLegacy.test.ts`, OBSERVED on main
`aefa8361`). So today it enforces much more than the two floors and can fail a
look change for no functional reason. The two floors remain; whether that test
is narrowed or replaced belongs to the look-pin list of section 2 and is not
decided here.

### 2. How the old standards are treated

The UI lane put the setup to him (18:16:35Z):

"A (recommended): 1. Overwatch records your ruling as an owner decision. 2. I
open one small PR adding a dated line to the five places above: reference and
history for look and flow, not a ground to refuse a change or raise a review
finding. 3. Floor and readability guards stay. 4. A style-pin test that a UI
change trips is updated or deleted in that same PR; `legacyVisualVocabulary`
and `brassAlphaChannel` come off the safety-critical list so that list means
safety.

B: A plus a clean sweep now: rewrite or archive the old visual docs and delete
all style-pin tests up front.

C: Record the ruling only; leave docs and tests as they are."

Jason, whole message (19:01:30Z): *"no i want the binding changed we mark
them historical before and the kept leaking in"*.

**None of A, B or C as written.** A line marking the old documents as history
is rejected: that was done before and the old rules kept coming back. The
binding wording itself is to be changed, so that nothing a builder or reviewer
reads still states a rule against changing the UI's look or flow.

Not decided here: which tests are style pins and what happens to each. The UI
lane brings that list to him and to ChatGPT before changing any test.

Who decides UI design and flow is unchanged from his same-day instruction to
the visual lane, relayed to overwatch and read in that lane's transcript
(`afc03b35-…`): *"ok update overwatch what we are doing, same rules apply for
new thread where overwatch gets what the thread builds into the app not direct
the  uI design and flow"*.

---

## OD-2026-10-02-003 — The ring canvas reads IRON CITY BEER, the second sponsor is KO NATION, and the ring corners are steel I-beams

**Provenance: PRIMARY.** Jason, in the visuals lane, 2026-10-02, answering three
questions put to him after his own reference photograph `07-the-ring-red-floor.jpg`
was enlarged and read.

> *"1 but it need sto stay associated with the canvas that it sponsored"*
>
> *"Its KO Nation it needs to stay tied to the canvas tho"*
>
> *"the navy bule is semantics  the corners of the ring are vetical steel I-beams
> red and blue opposite each other with whit  for the neutral colorsthe timber
> post is part of the building structure that the gym is in"*

**THE QUESTION THOSE ANSWERS WERE GIVEN TO, VERBATIM.** His first answer is the
single character "1", which means nothing on its own, so the question and its
options belong in the record beside it. Put to him through the structured
question tool, 2026-10-02:

> **Q.** *"Your ring canvas photographs as IRON CITY BEER.
> `docs/REAL-GYM-REFERENCE-LOCK.md` §2 records it as IRON CITY BREWERY, marked
> [CONFIRMED 2026-09-26] by you, and `scripts/make-plate.mjs` line 250 hardcodes
> that string into every ring prompt. How should I resolve it?"*
>
> 1. *"Correct both to IRON CITY BEER (Recommended)"*
> 2. *"Drop the brand from the prompt entirely"*
> 3. *"Keep BREWERY — I know something the photo doesn't show"*

**So "1" is him approving the exact words IRON CITY BEER**, not merely agreeing
that something was wrong. That distinction is load-bearing:
**OD-2026-10-02-001** permits a generator to be asked for specific words only
where the owner supplied or approved them, and `scripts/make-plate.mjs` now asks
for these words by name. He approved them by choosing the option that spelled
them out.

His other two answers were typed in his own words rather than chosen from the
options, and are quoted above exactly as he typed them.

**Why it was asked.** The lock said the canvas roundel reads **IRON CITY
BREWERY**, marked `[CONFIRMED 2026-09-26]`. The photograph, enlarged, reads
**IRON CITY BEER**. That is a conflict between the owner's stated state and
direct observation, so the work stopped and he was asked rather than the row
being edited.

**It was not a cosmetic error.** `scripts/make-plate.mjs` hard-coded the string
into the prompt of every training-room plate: *"the sponsor lettering printed on
the boxing ring canvas itself, which reads IRON CITY BREWERY at the centre"*. So
the generator had been instructing the image model to paint a word **that is not
in this gym** — made-up text originating from our own prompt rather than from the
model's invention. That is exactly what OD-2026-10-02-001 forbids, written the
same morning. The rule caught a defect in the tooling that wrote the rule.

**What is now recorded.**

- The roundel reads **IRON CITY BEER**. It sits at the centre of the canvas.
- The second sponsor is **KO NATION**, not ALT NATION.
- **Both marks stay tied to the canvas they sponsored.** They are permitted
  lettering *on that canvas*, and nowhere else.
- The ring corners are **vertical steel I-beams**, **red and blue opposite each
  other**, with **white for the two neutral corners**. "Navy versus blue" is, in
  his word, semantics.
- The **bare timber upright beside the ring is part of the building**, not part
  of the ring. A generated ring that grows a corner out of it, or leaves a post
  standing free of the ropes, has drawn the building instead of the ring — one of
  the faults that got a generated ring corner rejected on 2026-10-01.

**HIS EARLIER WORDS ARE LEFT EXACTLY AS HE SAID THEM.** On 2026-09-30 he said
*"alt nation was another sponsor for the same figh on the canvas"*, and that
quote stays in the lock unaltered. This is **him correcting himself**, not a
transcription being tidied, and the two are not the same thing. The lock now
carries both, with the later one governing.

**Corroboration, found inside the lock itself.** Its reference inventory already
recorded *"KO NATION mat"* from a different photograph of the same ring. The
correction runs the right way round, and the lock had been contradicting itself
in two places for days without anyone noticing.

**One sentence stops being an inference.** The lock's Mode A item 4 carried
`[INFERRED, not owner-stated]` on the reasoning that the canvas exception cannot
apply where the ring is out of frame, because there is then no canvas to carry
the mark. His *"it need sto stay associated with the canvas that it sponsored"*
says it directly, so that sentence is now marked `[OWNER 2026-10-02]`.

**Scope.** Facts about the building, and the generator strings that restate them.
It does not change the lettering rule itself (OD-2026-10-02-001), the no-people
rule, or anything about which plate is bound where.

## OD-2026-10-02-002 -- Releases 3, 4 and 5 to production; lane close-outs, and overwatch does not archive the visual lane; overwatch lands UI work but does not direct its design; a stand-in reviewer is fine; ChatGPT does not hold anything up

**Provenance: PRIMARY.** This id was reserved on 2026-10-02 and is written
on 2026-10-03 by the records lane. Typed by Jason between the evening of
2026-10-01 and the evening of 2026-10-02 (US Eastern; times below are UTC),
and read by the records lane in these transcripts under
`~/.claude/projects/C--Dev/`: overwatch
(`5b2fe0c3-80bd-4765-873d-9a0be7fc987d.jsonl`), Lane A
(`621541d7-de10-407e-8fb4-67468f9758b5.jsonl`), the set-a-password lane
(`6dba14c8-9b80-48a2-8354-e2d79efc946e.jsonl`) and the visual lane
(`afc03b35-5731-4ad4-ab64-43db0e62ea6a.jsonl`). Messages marked "sent
mid-turn" were typed while the thread was working and are recorded with the
time they were delivered. Run outcomes and SHAs were OBSERVED with `gh run
view` on 2026-10-03. This entry is new and edits no earlier one.

### 1. Release 3

Staging was started on *"Stage release 3"* (OD-2026-10-01-007, section 2). In
Lane A's thread, whole messages: *"approve give link"* (03:36:28Z) and *"now
deploy to production"* (03:44:15Z). In overwatch's thread, whole message
(03:45:39Z): *"aprove"*; mid-turn (03:47:37Z): *"give link"*. Overwatch
dispatched `deploy-production` run 36961995001 for main `e35cb406`, with the
image staging ran, and Jason approved it in GitHub; in Lane A's thread,
mid-turn (04:06:32Z): *"i deployed check lanes"*. Run 36961995001: success
(OBSERVED). Overwatch reported production revision 0000161 on that image.

### 2. Release 4

Overwatch asked for "apply the parent-password migration to production"
("It must be applied before the code goes live. It adds columns only;
existing rows are untouched; it applied cleanly on staging."). Jason replied
to that quote (17:03:08Z): *"yes"*. `apply-migrations` run 37038098145
(`parent-password`) at `1b00360e`: success (OBSERVED).

After his question *"whats next then"* (18:06:51Z) and overwatch's answer that release 4
waited on his word, Jason, whole message (18:09:25Z): *"approve open link for
my click"*. Overwatch dispatched `deploy-production` run 37045558260 for main
`1b00360e` with the staging digest and opened it in the in-app browser
without clicking. Jason, in part (18:12:43Z): *"i made the click"*. Run
37045558260: success (OBSERVED). Overwatch reported production revision
0000162.

### 3. Release 5

Jason, whole message (23:47:59Z): *"Give link if I need to click anything "*;
then (23:50:15Z): *"Sign in page is good you check the other two"*; then
(23:58:41Z): *"Agree do we have stuff to deploy"* (the "Agree" is recorded in
OD-2026-10-02-019). Overwatch listed what release 5 carried (no migrations)
and said: "If you'd rather ship tonight without the Label Agreement fix, say
so: everything else is on staging now and checked." Jason, mid-turn
(00:02:46Z): *"Yes migrate anddeploy"*.

Overwatch merged #1100 (records), deployed staging (run 37080375345) and
dispatched `deploy-production` run 37080965153 for main `70696794`; no
migration was needed, so none was run. It stated before his click that the
Label Agreement page and the untried parent password path ship as they are.
Jason, mid-turn (00:17:47Z): *"It's green "*. Run 37080965153: success
(OBSERVED). Overwatch reported production revision
`app-ppbf-production--0000163`, image `sha256:b8e41c49…9adc`.

### 4. Lane close-outs; the visual lane is not archived by overwatch

His instructions to close lanes whose scope is met, whole messages in
overwatch's thread: *"check in on lanes, scope check if scope has been met
archive"* (00:07:34Z); mid-turn, *"im back at terminal, check in with the
lanes/chips check fro drift and scop if scope is met archive id like to see if
we can close all these out before deploy to production"* (02:12:36Z); *"Yes
on the 3 prs,  my goal right now is to get the remaining plans closed out and
through to production except visual where we will send what ever is avaible
from it when we ship the othe lanes work"* (15:12:35Z; the three were #1080,
#1076 and #1048); *"Lane check, close out and archive"* (15:59:34Z).

Then, whole message (16:01:17Z): *"Ok visuals does not get archived by
you"*. **Overwatch never archives the visual lane, now or when its PRs
merge.** Closing it is Jason's. Other lanes are archived by overwatch once
their scope is met and their PR is merged.

### 5. Overwatch lands UI work; it does not direct UI design and flow

In the visual lane's thread, whole message (17:51:29Z): *"ok update overwatch
what we are doing, same rules apply for new thread where overwatch gets what
the thread builds into the app not direct the  uI design and flow"*. (Also
quoted in OD-2026-10-02-004.)

**UI and visual design, flow and wording are Jason's and the UI or visual
lane's.** Overwatch checks scope (files against the allowlist), CI and
review, and lands the work in the app; it does not direct the design.

### 6. A stand-in reviewer is fine

Overwatch put (23:03:28Z): "*Official:* Stand in for ChatGPT on #1102
tonight? A (recommended): no; wait for the reset, then merge, deploy staging,
and you check. B: tonight Grok reviews #1102 in your Chrome window, I merge on
a clean answer and deploy staging, and ChatGPT reviews afterward." In the
set-a-password lane's thread, whole message (23:27:26Z): *"Stand in is
fine"*.

**B.** Grok reviewed #1102 as a stand-in; overwatch merged it on that review
and deployed staging.

### 7. ChatGPT does not hold anything up

Jason, whole message (23:42:23Z), not in answer to a question: *"Don't let
chat gpt hold anything up, everything is reviewed and approved"*.

**Merges no longer wait for ChatGPT's review.** Overwatch merges a lane PR on
the lane's own reviewers, its scope check (files against the allowlist),
green CI and no live review threads. On these words overwatch merged #1096,
#1097, #1099, #1101 and #1103 the same night, and #1100 before release 5.
ChatGPT remains the architect (OD-2026-09-28-001); this changes only what a
merge waits for.

---

## OD-2026-10-02-001 — Real marks on real equipment are allowed in a plate; invented or garbled lettering is not

**Provenance: PRIMARY.** Jason, typed in the visuals lane, 2026-10-02, answering
a report that three plates had been rejected for carrying lettering:

> *"sub 6 the poster is fine, names on the equiptment is fin long as its real"*

**What changes.** The plate rule was "NO LETTERING OF ANY KIND", with one
exception for the ring canvas. It is now:

- **Real marks on real EQUIPMENT are ALLOWED** — a maker's name on a bag, a
  glove, a headguard or a turnbuckle pad, and the sponsor marks on the ring
  canvas. The gym is full of these and photographs of it will contain them.
- **The `GOLDEN GLOVES` poster in that one plate is allowed, because he named
  it.** His words were *"sub 6 the poster is fine"* — sub 6 being the plate he
  had just been shown. **That is NOT a general rule about posters**, and an
  earlier draft of this entry wrote it as "a real poster on a real wall", which
  generalised a specific permission into a category he was not asked about. He
  was asked nothing about posters in general; the question he answered was why
  three named plates had been rejected. Corrected in review. A future poster
  needs its own decision.
- **Invented or garbled lettering is still FORBIDDEN** — made-up brands,
  mangled approximations of real ones, invented crests, and any logo for this
  club. The club has a real mark and it is not a generator's to draw.

**This is not a reversal, it is the same instinct generalised.** On 2026-09-28
he already let the ring canvas keep its IRON CITY lettering — *"no i like that
you can leave it"* (OD-2026-09-28-013). Today extends that from one surface to
real equipment generally.

**Why it is a better rule, stated plainly because the old one was mine to
defend.** Enforcing zero lettering made the plates look *cleaner than the gym*,
and it was never the branding that looked wrong — it was the garbled text. The
failures that actually had to be thrown away all read as nonsense: a banner
spelling `3EL IN?RY GIYSE`, pads printed `HAYABUS`, an invented circular crest
on a canvas. The new line is drawn exactly where the real defect was.

**What it recovers**, judged at full size:

| Plate | Why it was rejected | Now |
|---|---|---|
| the coach's desk | a `GOLDEN GLOVES` poster | **allowed** — he named this one |
| a headgear rack | `STING` on the gear | **allowed** — real brand |
| `plate-02b-floor-portrait-ring-01` | `EVERLAST` on a turnbuckle | **allowed** — real brand |

**What it does not recover**, and the distinction is the point of the rule:
`plate-14-frontdesk-landscape-01` (invented banner and apron crest),
`plate-10-floor-landscape-01` (invented canvas crest) and the storage plate
printed `HAYABUS` all stay **do not bind**.

**THE GENERATOR MAY NEVER INVENT TEXT, AND OWNER-SUPPLIED TEXT IS A SEPARATE
CASE.** Asked whether `scripts/make-plate.mjs` should widen along with this rule,
Jason, 2026-10-02:

> *"No no made up text, if I give text thats different"*

So there are three cases, not two:

1. **Text a model invents** — forbidden, always. This is what produced
   `HAYABUS`, `3EL IN?RY GIYSE` and an invented canvas crest, and it is why the
   generator keeps asking for no lettering even though a plate may now carry a
   real mark. A generator cannot produce a real mark; asked for a brand it
   renders an approximation, and an approximation of a real brand is an invented
   one.
2. **A real mark genuinely present** in the room being photographed — allowed,
   which is what this entry widened.
3. **Text the owner supplies** — allowed. If he gives the exact words, they are
   not made up, and the generator may be asked for them. Nobody else supplies
   them on his behalf.

This replaces an inference. Before he was asked, the generator's strictness was
recorded in the reference lock as `[INFERRED, not owner-stated]` reasoning. It is
now his ruling, and the lock says so.

**SCOPE, WIDENED THE SAME DAY.** This began as a plate rule. Asked where it
should be written down, Jason, 2026-10-02:

> *"Also update where it matters, chat got grok, canvas where ever"*

So it governs **every image any generator makes for this club**, not only
plates: Grok's order brief and lane gate, the plates README, the Canva brand
brief and the Canvas context pack each state it. The external case is the
sharper one. A background plate sits behind real interface text, but a poster,
flyer or grant-packet cover carrying an invented club name, slogan, award,
accreditation or statistic is a false claim about a real nonprofit, put in front
of families, schools and grant reviewers. The Canva prompt in
`docs/BRAND_DESIGN_BRIEF.md` §8 had been asking for a seal with "curved rim
text" and supplying no words, which is an invitation to invent them; it now
requires the words.

ChatGPT's copy of this rule lives in its own project instructions, which only
Jason can save — reported to him with paste-ready wording. It reads these
repository documents through its GitHub connector in the meantime, so the rule
reaches it either way.

It still says nothing about lettering drawn by the app itself in code, and
nothing about the no-people rule, which does not move.

## OD-2026-10-01-008 -- Recorded write defects accepted for merge, and from now a disclosed, recorded write defect does not block a merge; when the act-now line appears; who a SHADOW safety alert reaches; the act-now sentence; no humour in an acute answer

**Provenance: PRIMARY.** Typed by Jason in the overwatch thread (transcript as
in OD-2026-09-30-007). **Date:** 2026-10-01 (his evening). This entry is new
and edits no earlier one.

He asked: *"whats your recomendations on whats for me"*. Overwatch listed four
numbered items, each with its recommendation, and ended "Reply 'A to all' and I
record them and move." Jason, whole message: *"agree with the recomendation\"*.

Overwatch reads that as taking the recommendation on every item in that list.
The items, as put to him:

### 1. PR #1048: the two recorded write defects are accepted

"Accept the two paperwork defects on #1048 — say 'A'. The code and evidence
passed review. The only block is two past writes already logged as mistakes: a
note file written before you approved working files, and an abandoned second
worktree. Accepting them lets it merge unchanged, before the release freeze."

**Accepted.** ChatGPT's review of #1048 at `814beb26` passed the code and the
evidence and held the merge only for this. The two writes stay recorded in
that PR as HISTORICAL DEFECT; his acceptance lets the PR merge and does not
authorize them backwards.

### 2. When the emergency act-now line appears

"Act-now line: 'A'. The emergency line appears when a message says a real
emergency happened to a specific person, even without 'I' or 'my'. Unclear
wording counts as an emergency too. A general question does not. SHADOW still
answers and a human review is still written either way; this only decides when
the emergency line shows."

**A**, in ChatGPT's wording of the option: a message that says a real acute
event happened to a specific person is treated as acute even if it never says
"I", "my" or "now"; a purely general or hypothetical question is not acute; if
it is genuinely unclear whether a real event happened, treat it as acute. This
closes the first open item of OD-2026-10-01-006 section 1.

### 3. Who a SHADOW safety alert reaches

"Who 'the coach' is: 'A'. A SHADOW safety alert goes to the athlete's coach of
record and any coach covering them, plus admins, on the existing in-app alert.
No athlete in the chat means admin review only. No email, text or push."

**A.** For an athlete-scoped high-risk SHADOW message: the athlete's coach of
record and any coach actively covering that athlete at the time, through the
existing in-app safety escalation; admins see it too; if no athlete is in
scope no coach is guessed and the admin SHADOW review stands alone; no email,
text or push. This closes the second open item of OD-2026-10-01-006 section 1.
It is not built; it is piece 2 of the replacement sequence and needs a
migration.

### 4. The act-now sentence, and humour in an acute answer

"The act-now sentence itself: reuse the existing emergency sentence. Humour in
the teaching part of an emergency answer: none."

**A on both.** The server-owned act-now line reuses the existing emergency
sentence. An acute answer carries no dark or sarcastic humour anywhere, in the
fixed line or in the generated education that follows it. Ordinary injury,
head-knock and pain answers keep the humour register of OD-2026-10-01-002.

### 5. Recorded write defects on #1076 and #1077, and two production migration dispatches, accepted for merge

ChatGPT's reviews passed the code of PRs #1076 and #1077 and held both, and
this record, on writes made before his words existed. Overwatch put two
questions to him together, each with A recommended:

"Official: accept, for the purpose of merging, the already-recorded historical
write defects on #1076 and #1077, and my two production migration dispatches.
A (recommended): accept them; each stays logged as a defect. B: keep them
blocking."

and

"A standing rule, if you want this to stop recurring (your rule, your call).
A (recommended): a write defect that is already disclosed and recorded does
not block a merge; it is reported to you and stays in the log. New undisclosed
ones still block. B: keep the rule as it is, and accept defects PR by PR."

He replied *"your recomendations"*, which overwatch did not treat as an answer
and said so, restating both picks as A and A. Jason, whole message: *"AA"*.

**A on the first.** Accepted for the purpose of merging, each staying recorded
as a defect and none authorized backwards:

- PR #1076: the two coach-facing sentences written before he approved them
  (commit `fce1e7a8`, approved later by "Go off recommendation",
  OD-2026-10-01-003 section 5; commit `7f6b07b8`, approved later by "A",
  OD-2026-10-01-007 section 3).
- PR #1077: the write defects that PR's own WRITES table records as
  historical at the time it merges.
- The two production migration dispatches of OD-2026-10-01-007 section 2
  (`apply-migrations` runs 36953729159 and 36953731757).

### 6. Standing rule: a disclosed, recorded write defect does not block a merge

**A on the second.** From this answer forward: a write made without his prior
words that is already disclosed and recorded as a defect (in the PR's WRITES
table or in this file) does not block that PR's merge. It is reported to him
and stays in the log as a defect; recording or accepting it never authorizes
it backwards. A write defect that is new, undisclosed or unrecorded still
blocks until it is disclosed and recorded. This is his decision on how the
write-log rule ("a write without matching words is a blocker") is to be
handled in review. The reviewer works from its own project instruction, which
still states the old rule when this is written; that instruction has to be
updated separately before the reviewer can apply this. The decision does not
change the rule that every write is logged with his exact words or marked as
a defect, and it does not widen any authorization.

---

## OD-2026-10-01-007 -- Parent passwords: a board seat does not block one; a person on both sides uses two emails; a stored password is cleared when its holder becomes ineligible. Release 3 started. The hold-placement sentence and the lapsed-clearance wording approved

**Provenance: PRIMARY.** Section 1's two messages were typed by Jason in the
Lane P thread and read by overwatch in that thread's transcript
(`C--Dev-ppbf-platform--claude-worktrees-quizzical-jennings-7f224a/16d05dfd-59be-4b72-978f-c24b105b90d7.jsonl`),
times UTC. Section 3's answer was typed in the Lane H thread and section 4's
in the Lane M thread; each was read in that thread's transcript. The other quotes were typed in the overwatch thread
(transcript as in OD-2026-09-30-007). **Date:** 2026-10-01 (his evening; the UTC times run
past midnight). This entry is new and edits no earlier one.

### 1. Parent passwords and board seats

PR #1074 (parent passwords, part 1) was built refusing a password to any
parent account that holds a board seat in any organization. That rule was
overwatch's call and then the lane's design, never his words; ChatGPT's review
made it an owner decision. Lane P's last message to him before he answered
ended with two numbered questions (2026-10-02T01:31:24Z):

"1. Does a board seat in any gym block a parent password, or only a seat in the
gym they signed into? 2. When a parent later becomes ineligible, is the stored
password cleared or left dormant?"

Jason, two messages:

- 2026-10-02T02:19:50Z: *"1 NO IT SHOULD NOT BLOCK STANDS A CHANCE THAT IN SMALLER GYMS THEY MAY BE PART OF GYM ON BOTH SIDES"*
- 2026-10-02T02:20:06Z: *"2 CLEARED"*

His first answer was neither option offered. Overwatch put the two readings to
him (a seat never blocks; or only a seat at another gym is ignored) and
reported what Lane P had read in the code: one login has exactly one role, so
a person who is both a parent and a board member on one email is a `board`
account, sees no parent screens, and is refused a parent password by the
parents-only rule whatever the seat rule says. Jason, in the overwatch thread,
whole message: *"simple is that the person would need two emails per user account"*.

**Decided:**

1. **A board seat does not block a parent password.** The seat check comes out
   of parent-password setup. His words answer the question as asked ("NO IT
   SHOULD NOT BLOCK"); that this means a seat never blocks, in any
   organization, is overwatch's reading (INFERRED) and was told to him.
2. **A person on both sides uses two emails, one account each.** One login
   keeps one role. Nothing is to be built to let one login hold both a parent
   and a board role.
3. **A stored password is cleared when its holder becomes ineligible**, not
   left dormant. If they become eligible again they set a new one through a
   fresh emailed link (his rule 6 in OD-2026-10-01-002 section 3). This is
   work for the later parts of the parent-password build, not part 1; part 1
   makes no claim that a stored password is cleared.

What stays as it was: passwords are for parent-role accounts only
(OD-2026-10-01-002 section 3 item 2). With decision 1, holding a board seat is
no longer something that makes a parent ineligible; ineligible means deleted,
deactivated or no longer a parent.

REPORTED by Lane P from reading the code at its head `4765ec78` (not re-read
by overwatch): board screens and APIs are gated on the role `board`, not on
holding a seat and not on the sign-in method, so a parent's password session
reaches no board material; a parent-role account holds a seat only as a
leftover (re-roled after being seated, or a `board` membership in another
organization).

### 2. Release 3 started; the production migration dispatches were not authorized when made

Jason, whole message: *"Stage release 3"*. Overwatch had recommended staging
once PR #1077 (the floor and the new plates) merged, so that it is in the
release; staging waits for that merge.

On that message overwatch dispatched the two production migrations the release
needs: `apply-migrations` run 36953729159
(`one-percent-nomination-athlete-cascade`) and run 36953731757
(`calibration-adjudication-revisions`). **Those two dispatches are
UNAUTHORIZED WRITES / HISTORICAL DEFECTS.** `docs/AI_DELIVERY_PIPELINE.md`
says production migrations are dispatched only on Jason's explicit word, as a
separate instruction; "Stage release 3" was the only instruction that predated
them and it does not name a production migration. Found by ChatGPT's review of
this record.

Separately, and not curing that: both runs then received the protected
production approval, which overwatch did not click (GitHub attributes it to
the shared account; he was at his terminal), and both completed with success.
Before that he had approved two read-only production checks:
`check-database` run 36936700286 (`calibration-adjudication-ties`: 0
adjudications, 0 ties) and `run-checks` run 36936798184
(`membership-orphans`: "retention purge history: 0 run(s), 0 account(s) ever
purged"). No production deploy had been dispatched when written.

### 3. The sentence shown when a hold placement is not confirmed

PR #1076 added one coach-facing sentence on the clearance board before he was
asked; ChatGPT's review held the merge for his answer. In the Lane H thread he
first asked what the question was; Lane H put it as: 'When a coach presses
"Place hold" and the server's answer is not a proper confirmation, and a
re-read finds no hold for that athlete, the row shows the existing "Hold Not
Placed" stamp with: A (recommended): "The gym's server did not confirm this
hold. Check again before relying on it; if no hold shows, place it again." B:
your own wording. C: no sentence; the row only says "Training hold could not
be read just now…".' Jason, whole message, 2026-10-02T02:40:57Z (read by
overwatch in the Lane H transcript,
`C--Dev-ppbf-platform--claude-worktrees-competent-leavitt-60cdcd/6bf8483c-6957-4b13-9add-f1c636a5584d.jsonl`):
*"A"*.

**A.** The sentence stays as built in PR #1076 at `7f6b07b8`. The source
string uses a typographic apostrophe in "gym’s"; the question as typed used a
straight one; the wording is otherwise the same. The commit that added the
sentence was made before this approval and remains an unauthorized write in
that PR's own record; the approval does not authorize it backwards.

### 4. What a coach sees when a medical clearance has lapsed

Both coach screens print the stored status, so a clearance past its end date
still reads "cleared" while the server gates already treat it as expired
(REPORTED by Lane M at `main` `c5d5c260`; no screen lets a coach enter an end
date today, so this is latent). Lane M put four questions to him in its
thread, each with A recommended: Q1 the badge label for a lapsed clearance,
(A) "clearance expired", (B) "expired", (C) "lapsed"; Q2 the badge rung, (A)
the amber restricted rung, same as pending and no record, with red kept for
not cleared, (B) the red locked rung; Q3 the sentence under the badge, (A)
"This clearance passed its end date, so it no longer counts. The medical gate
blocks recommendations until a new clearance is recorded.", (B) reuse the
server's existing sentence, (C) no sentence; Q4 the date on the clearance
board beside a lapsed badge, (A) "expired <date>" in place of "since <date>",
(B) keep "since <date>", (C) no date. Jason, whole message,
2026-10-02T02:43:59Z (read by overwatch in the Lane M transcript,
`C--Dev/deb77dfa-aa05-430d-900f-5ba3583fedc4.jsonl`):
*"go with recomendations"*.

**A on all four.** Label "clearance expired"; amber rung; that sentence;
"expired <date>". Lane M builds it after PR #1076 is on `main`.

---

## OD-2026-10-01-006 -- SHADOW: educate, do not restrict; coach notification is part of the intended safety handling; emergency reviews get a separate hourly allowance; the #1036 replacement re-cut

**Provenance: PRIMARY.** Section 1's three messages were typed by Jason in the
Lane A thread and read by overwatch in that thread's transcript
(`C--Dev/621541d7-de10-407e-8fb4-67468f9758b5.jsonl`), times UTC. Section 2's
answer was typed in the overwatch thread (transcript as in OD-2026-09-30-007).
**Date:** 2026-10-01 (his evening; the UTC times in section 1 run past
midnight). This entry is new. The same PR adds one dated status update
to OD-2026-09-30-006's Status paragraph and changes nothing else in any
earlier entry. OD-2026-10-01-004 is on `main` via PR #1068; OD-2026-10-01-005
is reserved by the visual lane's open PR #1077.

### 1. Educate, not restrict; notifying a coach is part of it

Lane A had put two questions to him in its thread, each with A recommended:
whether a message that states an acute event happened to a specific person,
with no "I", "my" or "now", is a report; and whether wording that could be read
either way is treated as a report, at the measured cost that 4 of 40 general
questions in its test set would then be refused, two of them with the emergency
text. His three messages, in order:

- 2026-10-01T23:46:40Z: *"Recommendation "*
- 2026-10-02T00:08:22Z: *"explain"*. Lane A then explained the two questions in
  plain terms and restated that cost.
- 2026-10-02T00:27:39Z: *"that is where my educate not restrict comes into play, part of that education would be to notify the coach,  thats what we have been fighting over with the saftey piece all through the app"*

"Recommendation" is NOT recorded as an A/B selection: he asked for an
explanation next and then answered in his own terms. The third message
governs. ChatGPT, as architect, read it the same way.

**Decided:**

1. Uncertain safety wording is not a reason to replace an answer with a
   refusal.
2. SHADOW educates rather than restricts.
3. Telling a coach is part of the intended handling of a safety case.

**Still open, and not to be inferred from those words:**

1. When the emergency act-now line appears for an asserted or unclear event
   (put to him as A/B/C; not answered when written).
2. Which coach or coaches "notify the coach" means, and what happens when no
   athlete is in scope (put to him as A/B/C; not answered when written).
3. No email, text or push is authorized by these words.

What the app does today (REPORTED by Lane A at main `c5d5c260`, and traced
independently by ChatGPT): a SHADOW review row is read only by admins on one
admin page; it carries no athlete id; no coach reads it; nothing is pushed. So
the existing review queue does not notify a coach. Not his words, and not
recorded as his: "nobody is refused", "ambiguous means notify", "the review
queue notifies the coach", "coach of record plus covering coach".

### 2. Emergency reviews get their own hourly allowance

OD-2026-09-30-005 gave the human-review write a limit of 3 per hour per
account. OD-2026-09-30-006 selection 5 gave every high-risk message a human
review. Built together (Lane A, unpushed), three ordinary review records could
use the hour, so a later emergency report kept its emergency reply but left no
review row. `main` had no review-queue quota on that path, so quota exhaustion
could not suppress the critical write; in Lane A's measured `main` sequence the
row was written (REPORTED). ChatGPT ruled the choice his. Asked:

"Official: you chose 3 SHADOW human-review records per hour per account. With
every high-risk question now adding a record, three ordinary ones can use up
the hour, so a later "I can't breathe" gets its emergency reply but no review
record. A (recommended, ChatGPT's pick too): one 3-per-hour allowance for
emergency reports only, and a separate 3-per-hour allowance for everything
else. B: keep one shared allowance and accept that gap. C: emergency reports
always write a record, with no limit."

Jason, whole message: *"A"*.

**A.** Two buckets, each 3 per hour per account:

1. **Critical (emergency) request review writes** only.
2. **All other SHADOW human-review writes.** That is "everything else", as the
   option he chose says, and includes as applicable: non-critical high-risk
   request reviews; generated-answer safety reviews written by the chat route;
   generated-answer safety reviews written by the background worker; and the
   existing operational or filter review rows, such as the row written when
   the Library is empty.

A fourth critical review write in the hour is suppressed; the emergency
response is not. The limit is on persisting the review row, never on the reply
(OD-2026-09-30-005: exhaustion suppresses the write only). This narrows what
OD-2026-09-30-005's single `safety_review` bucket covers; it does not change
the number he chose.

Other questions were open with him at the time (a hold sentence, the act-now
threshold, the coach recipient and others). Overwatch reads "A" as the answer
to the one new question in the message it replied to, and to no other; those
stay open.

### 3. The #1036 replacement is re-cut so no step adds refusals

On section 1, ChatGPT replaced the earlier five-piece order. The classifier
correction no longer lands first, because alone it would have turned about 30
of Lane A's 36 test reports into refusals until later pieces landed. New order,
one lane and one PR each: (1) every high-risk message leaves a bounded
human-review record; (2) a coach-facing in-app escalation, only if he confirms
the recipient; (3) education instead of refusal for non-acute high-risk; (4)
acute gets the act-now line plus education; (5) the acute-report classifier
correction; (6) contractions without apostrophes. Pieces 3, 4 and 5 go to
production together. PR #1036 closes as superseded when piece 1's PR opens.
This is the architect's sequencing, recorded so later lanes can find it; it is
not an owner decision.

---
## OD-2026-10-01-005 -- The floor takes photographs again, and the two it used to carry were the wrong building

**Provenance: PRIMARY.** Jason, typed in the visuals lane, 2026-10-01:

> *"my decision if im was clear is to edit change rewrite what ever we need to
> do to get these plate varieties remove my decision about the floor"*

That rescinds OD-2026-09-22's ruling, recorded in `ppbf-golden-era.css` as *"im
not tied down to actual gym pictures"*, under which `.room--floor` carried
`--plate: none`. The floor is 40 of 129 doors and **35 of those are coach or
athlete** -- the room the gym actually works in, and the only one painting
nothing.

**The material ground stays and is now worth more.** It is the element
background and the plate paints over it, so it is what a coach sees on a 404,
offline, or under `prefers-reduced-data`: a designed black-and-grain floor
rather than the generic gradient wall. The zero-asset guarantee improved.

**The two plates it used to declare are NOT restored.** Opened at full size on
2026-10-01, `plate-02a-floor-landscape-01` and `plate-02b-floor-portrait-01` are
a generic dark red brick wall -- not this building, which is honey plank, pale
block and matte black chalkboard. They are replaced. Two further floor
candidates were rejected the same day: `plate-02b-floor-portrait-02` (a chalk
wall covered in invented words) and `plate-02b-floor-portrait-ring-01`
(`EVERLAST` on a turnbuckle). Of eight floor candidates, five failed.

**What he also asked for, applied here and continuing:**

> *"it can feel like a boxing gym in it so rings bags speed bags timer bell, you
> can be more creative with the plates withoput losing the gym identity"*

and, when this lane began writing a long brief instead of producing plates:

> *"i feel like you starting to over complicate these plates, i just need a
> variety of plates with the gym feel made and given a home"*

So: generate, check, bind. Not document.

## OD-2026-10-01-004 -- The visuals lane: plate variety comes from doors, not new rooms; a declared format conversion is allowed and the original must be kept; board and file get light plates behind a new contrast guard

**Provenance: PRIMARY.** Jason typed in the visuals/UI lane and selected from
options put to him there. **Date:** 2026-10-01. Each question was put in
official form, then in plain English, with the trade-offs on both sides at his
instruction: *"Ask me the question s with the pros and cons"*. This entry is new
and edits no earlier one.

### 1. Plate variety comes from doors, and the room work was drift

His correction, mid-build, in full:

> *"Drift check we talked about doors allowing variety of each room"*

He was right and it cancelled the work in progress. `plateVariant.ts` selects a
plate by hashing the route, so one existing room class already carries up to six
different walls across its doors -- same door, same wall, every load. Measured
from `buildingMap.ts` (129 doors): **34 distinct walls are reachable with zero
new room classes**, and only ten were bound. Variety is a stylesheet question,
not a room question.

What a new room class buys, and the only thing it buys: pinning a NAMED image to
a NAMED screen. The slot is a hash, so the drill-cabinet wall cannot be aimed at
`/coach/drills`.

Asked whether he wants named rooms anyway: "A, not now, doors are enough
(recommended); B, yes, one room at a time; C, revive #941 first; D, close #941."
**A.** So no lane opens room classes for art, `buildingMap.ts` is not touched for
this purpose, and **PR #941 stays exactly as he left it on "Hold it, decide
later"** -- A is not an instruction to close it.

Delivered under this ruling: PR #1068, office to **five** walls, clinic to
four, night to three. It was six until `plate-14-frontdesk-landscape-01.jpg` was
opened at full size, found to carry a banner of invented lettering and an
invented crest, and unbound within the same PR.

### 2. A declared format conversion is allowed; the original must be kept

Raised by ChatGPT reviewing #1068. Two rules could not both hold:
`apps/web/public/plates/README.md` said a delivered image is *"committed as
received -- never re-encoded"*, and `design-system/plate-contract.json` requires
chroma `4:4:4`, while the 2026-10-01 Grok batch arrived `4:2:0`. So those images
committed as received would fail the byte gate, and the ones that passed it were
re-encoded locally by this lane without that being declared anywhere — the two
in #1064 then staged for production among them.

**An earlier draft of this entry said "every Grok-sourced plate in the
repository" had gone through that step. That was false and is corrected here
before it could be relied on.** ChatGPT raised it in review; the committed bytes
settle it. Measured 2026-10-01: every plate predating the 2026-10-01 batch is
baseline (`SOF0`) and already `4:4:4`, while all seven of that batch are
progressive (`SOF2`) with metadata stripped, which is the fingerprint of the
local sharp step. The two sets separate cleanly with no overlap. So the earlier
plates were prepared under the older arrangement recorded in
`docs/GROK-VISUAL-LANE.md` — Grok re-encoding to `4:4:4` in its own pipeline
before shipping — and the local conversion applies to the 2026-10-01 batch and
to nothing before it.

Asked: "A, amend the rule, record the conversion, and keep the originals
(recommended); B, amend the rule only; C, keep 'as received' and drop Grok as a
plate source; D, hold until staging." **A.**

**Checked against the visual-lane transcript, 2026-10-01** (run read-only by
overwatch at this entry's request, because the entry turns on what he knew when
he chose).

What the transcript shows, and no more than this. At 21:10Z, **before** he
answered, this lane's message to him said *"The originals are gone. For these
five plates the pre-conversion Grok files no longer exist on disk"*. At 22:19Z
he selected "Amend rule, keep originals (Recommended)" -- an option whose own
text read that a later comparison *"is exactly what nobody can do for the five
in this PR"*. So the selection was made with the gap disclosed twice, once in
the message and once in the option itself.

The two halves are not the same kind of claim, and are labelled accordingly:

- **PRIMARY** -- the prospective requirement. From his selection: originals are
  kept from now on, which is condition 3 above.
- **INFERRED** -- that the five already-converted plates stay, as the disclosed
  pre-rule exception. This follows from an informed selection; it is not
  something he said. **He was never asked, in so many words, whether that batch
  is grandfathered, and he never used the word.** If he says otherwise, the
  inference is what gives way, not the record of it.

No further owner decision was sought for the five, and the conversion table
records them as unprovable rather than as approved.

This closes the item **OD-2026-10-01-003 section 3 records as still open**
("Open with him in the visual lane, not decided here"). That entry was written
before he answered; it is correct as of when it was written and is not edited
here. He answered in the visual lane, which is where it says the answer would
come from.

So, binding on every lane that places a plate:

1. A conversion may change **format only, never content** -- geometry at the
   same aspect ratio so nothing is cropped out, chroma, encoding, metadata. No
   reframing, retouching, grading or regeneration. A source whose aspect ratio
   does not match a contract geometry goes back to the generator; it is not
   cropped to fit.
2. The parameters are **recorded** with the plate.
3. The **original is kept** for comparison, beside the converted file in the
   owner's reference folder and outside the repository, because a `4:2:0`
   original cannot pass the byte gate.

Recorded honestly in that README: for the 2026-10-01 Grok batch the originals
were **not** retained, so the conversion is stated from the JPEG markers of the
committed files and cannot be shown by comparison. Condition 3 exists so that no
later batch reads the same way.

### 3. Board and file take light plates, behind a contrast guard that does not exist yet

`.room--board` and `.room--file` set `color: var(--hide-900)` -- dark ink on a
light wall -- and no test in the suite measures text against a room ground. They
hold 8 of the 34 reachable slots and were deliberately left untouched in #1068.

Asked: "A, light plates and build the guard (recommended); B, re-ink the two
rooms dark so they can take the dark plates we already have; C, leave them on
one plate." **A.** The paper look of those two rooms stays; the art comes to
them, and the guard lands with it.

### 4. NOT decided: how the gym tablet physically sits

Asked where the next Grok batch should go, given that the orientation block
carries a portrait plate for `.room--floor` only and every other room's
landscape plate is cover-cropped into portrait. Options were: confirm the tablet
first; portraits 5-6 per room; one portrait per room; more landscape. **He chose
"confirm the tablet first", and the confirmation has not yet been given.**

The claim that the tablet stands upright appears only as an assertion in a code
comment (`ppbf-leather-brass.css`, the orientation block). **No evidence for it
exists anywhere else in the repository** -- searched; the e2e suite tests a
narrow phone viewport and nothing about an upright tablet. Until he answers, no
lane should spend a generation batch on portrait plates, and no lane should add
a generic portrait override to a room that carries landscape variants: doing so
collapses every one of that room's walls back to one on an upright screen.
## OD-2026-10-01-003 -- His later answers of 2026-10-01 (afternoon): the coach-board control and failure line approved; working files; plates and who owns the visual lane; observation ids; the knockout cases; release 3 staged then cancelled

**Provenance: PRIMARY** where Jason's words were typed in the overwatch thread
(transcript as in OD-2026-09-30-007); **REPORTED** where a lane relayed them
(each marked). **Date:** 2026-10-01. This entry is new and edits no earlier
one; where it changes what an earlier entry reports, it says so.

### 1. Three approvals in one message

Three questions were put together, each official then plain, each with A marked
recommended. Jason, whole message: *"Approve the 3 recommendations  to the 3
questions"*.

1. **Working files under `Documents\PPBF-overwatch`.** Asked: "Working files
   under `Documents\PPBF-overwatch` (relay notes to lanes, review relays,
   images shown to you): A, overwatch may write them without asking each time
   (recommended); B, ask each time." **A, from this answer forward.** Files
   written there before it (lane relay notes by overwatch and by lanes; two
   plate image copies) had no words of his at the time and stay recorded as
   unauthorized writes; section 7 lists them.
2. **The "Check again" control on the coach board is his.** Asked: 'The "Check
   again" button beside a disabled "Place a training hold" on the coach's
   board: A, keep it (recommended, also by ChatGPT); B, remove it.' **A.** This
   changes what OD-2026-10-01-002 section 2 item 3 reports: there the control
   was overwatch's decision, told to him and not his ruling. It is now
   owner-approved. Within PR #1063, the "Check again" addition in commit
   `8a459c61` and its guard-label addition in `c4329503` were unauthorized
   writes at the time (those commits also carry authorized work: the
   athlete's line, the disabled Place control, the one-control-two-states
   change); he later approved keeping the behaviour.
3. **The line shown when a submission for the previous athlete fails late is
   his.** Asked: "When something a coach submitted for the previous athlete
   fails after they've switched to another athlete, the screen shows: A,
   'Something you submitted for the athlete you were on before did not go
   through. Go back to them and check.' (recommended, also by ChatGPT); B, your
   own wording; C, nothing." **A.** The sentence was added in commit `ca66674a` of PR #1063,
   which also carries authorized review fixes; that one addition was an
   unauthorized write at the time, and he later approved keeping the wording.

### 2. The visual lane is his and the lane's; overwatch lands what they build

Overwatch had set an order of work for the visual lane, held its Drill Cabinet
room pending an answer on PR #941, and put two visual questions to him. Jason:
*"Ok member back that the visual was me and it that your job was just to get
what we build into the app"*, and then *"Correct your extra comments are just
reverting us back to previous decisions"*.

So: what the visual lane builds, in what order and how it is split is between
him and that lane. Overwatch's part is to get its PRs into the app: CI, the
reviewer's findings relayed without additions of its own, merge, staging
deploy, and production when he approves. Where a review cites an older visual
decision against something he has since changed, overwatch brings it to him as
a conflict and does not relay it to the lane as a requirement. The order of
work, the hold and the two questions were withdrawn the same hour.

### 3. Plates

- **The two plates in PR #1064 accepted.** He was shown the exact committed
  bytes of `plate-01-office-02.jpg` and `plate-03-clinic-02.jpg` and asked for
  "plates ok" as item 1 of two things then waiting on him (item 2 was moving
  one decision record to `main` ahead of PR #1036). Jason, whole message:
  *"Yes to 1 and 2"*. Before that he had written *"Grok original 15  works well
  too if you remove the extras"*, which overwatch did not treat as acceptance
  of those two files.
- **He names the plates that do not work; he does not approve each by name.**
  Jason: *"I'll identify one that dont work in the visual lane not approve by
  name"*. In the visual lane's thread, as relayed (REPORTED): *"Im reviewing we
  will do the opposite ill tell you wich ones dont work 90 is alot to approve
  by name everything looks good"*. ChatGPT's review of PR #1068 accepted this
  as a valid human review under the reference lock, provided the look covers
  the file that ships.
- **Open with him in the visual lane, not decided here:** Grok's output is not
  in the colour format the plate contract requires, so every Grok plate that
  passes the byte gate has been resized and re-encoded locally, while the
  delivery rule says a plate is committed as received. Which rule gives way is
  his; the lane has put it to him.
- Relayed by the visual lane from its thread (REPORTED), on why its plates go
  into existing rooms and not new ones: *"Ok let's get them homes and get them
  in the app"*, then *"Drift check we talked about doors allowing variety of
  each room"*.

### 4. Two answers in one message, and one more

Two questions were open, each with a recommendation. Jason, whole message:
*"Go with both recommendations"*.

1. **Observation ids on a decision outcome may name either kind.** Asked: 'On
   the coach's "decision outcome" form, the "Observation IDs" box may
   reference: A, formula observations only (the app's computed metrics); B,
   coach observations only (notes a coach wrote); C, either (recommended, and
   what's built).' **C**, as long as each id belongs to the decision's athlete
   and organization. Built by PR #1065.
2. **Release 3, start now.** Asked whether to release what was on `main`
   (plate variants, the humour registers, the deleted-login refusals): A, stage
   it and start (recommended); B, wait for the phone-apostrophe fix and the
   coach-screen fixes. **A.** Section 6 records what happened.

Earlier the same afternoon, on whether an admin may create a new login for an
athlete record that has been withdrawn (A, allowed, as production behaves
today, recommended for now; B, refused), Jason: *"yes to thw question"*.
Overwatch read that as A (INFERRED); the code already behaves that way and no
work followed.

### 5. Six plain questions, one answer

He asked for the open questions plainly: *"Ask me the questions  plainly"*. Six
were put, each with overwatch's pick marked. Jason, whole message: *"Go off
recommendation"*.

1. **Release 3 later, not now.** The pick: cancel it, merge the finished PRs
   held behind it, and do one bigger release when he has time to look.
2. **Odd apostrophes in "ko'd".** A general knockout question typed with a
   normal apostrophe already gets a model answer and no flag to a human; typed
   with one of eleven rare look-alike characters it got a stock line and a
   flag. The phone-apostrophe fix (PR #1049) makes the rare ones behave like
   the normal one. The pick: accept that, stated and pinned by tests.
3. **A first-hand knockout report with no "I" or "my" gets no human review
   today**, in every spelling, because the classifier reads it as a general
   question. The pick: fix it in PR #1036, as a named requirement of that
   work.
4. **When the app cannot tell whether a coach's write was saved**, the screen
   says: "The server did not confirm this. It may or may not have gone
   through: check before sending it again."
5. **A lapsed medical clearance can still read "cleared" on the coach's
   screen** (REPORTED by Lane H's reviewer; not checked by overwatch). The
   pick: start a lane for it. It starts when he clicks its task chip.
6. **Dependency-update PRs opened by GitHub's Dependabot** (#1069 to #1073):
   overwatch checks them, sends them to ChatGPT and merges what it clears.

### 6. Release 3: staged, then cancelled

On his "Go with both recommendations", overwatch deployed staging at
`2ace4c671c06969f4246ae8401321446b69695ee` (`deploy-staging` run 36918896986,
digest `sha256:d10080b4808a8f1bab078d5a6bb4e553f45c17a53c230cbc8011313fc4d47b2b`
from that run's artifact) and dispatched the production migration
`one-percent-nomination-athlete-cascade` (`apply-migrations` run 36918902244),
which waited for his approval. Merges were frozen. Neither his approval nor his
signed-in look on staging came; five reviewed PRs queued behind the freeze. On
his "Go off recommendation" (section 5 item 1) overwatch requested cancellation
of run 36918902244 and lifted the freeze. Release 3 made no production change:
the migration run ended cancelled with no step executed, and no
`deploy-production` was dispatched for it. Read from Azure by overwatch at
2026-10-01T22:18Z: container app `app-ppbf-production`, latest ready revision
`app-ppbf-production--0000160`, image digest
`sha256:596ec36920558ebf41de35a3ac283e9a6aa5e4553e4e6238960b299cdd2d1878`,
the revision and digest release 2 deployed (OD-2026-10-01-001 section 6).

### 7. Writes that had no words of his at the time

Each was reported to him when found; ChatGPT's reviews classed them. Later
approvals do not authorize them backwards.

- A re-run of a CI job on PR #1061 (run 36903135578). He authorized re-running
  FAILED jobs on open PRs. That job was CANCELLED, not failed. The re-run was
  therefore an UNAUTHORIZED WRITE / HISTORICAL DEFECT.
- Two plate image copies written to `Documents\PPBF-overwatch\plates-1064`, and
  the relay notes written under `Documents\PPBF-overwatch\lane-inbox` by
  overwatch and by lanes, before his working-files answer (section 1 item 1).
- The permission mode of the Lane H thread, changed with Lane Q's when his
  words named only Q (OD-2026-10-01-002 section 4).
- In PR #1063, three additions made before section 1 items 2 and 3: "Check
  again" in `8a459c61`, its guard label in `c4329503`, and the
  previous-athlete failure sentence in `ca66674a`. Only those additions; the
  rest of each commit was authorized work.

### 8. A fact he stated (REPORTED by Lane L2)

In the Lane L2 thread, as relayed: *"dont make tghings up the app has never
been live"*. ChatGPT's review of PR #1048 did not accept that as proof that no
retention purge ever ran on these databases and asked for a read-only count.
Staging, read by overwatch from the run log: "Retention purge events: 0"
(`check-database`, `deletion-preflight`, run 36922408382). The production run
of the same check (36922416115) was waiting on his approval when written.

---

## OD-2026-10-01-002 -- His later answers of 2026-10-01: what "pair" means; records and read-only checks and staging migrations without asking; the hold screens; the parent password starts; the Lane S rulings confirmed; the cross-athlete draft bug

**Provenance: PRIMARY** where Jason's words were typed in the overwatch thread
(transcript as in OD-2026-09-30-007); **REPORTED** where a lane relayed them
(each marked, with what was checked). **Date:** 2026-10-01. Each question was
put in official form, then in plain English. This entry is new and edits no
earlier one; where it clarifies an earlier entry it says so.

### 1. Five answers in one message

Five questions were put together, four with A marked recommended and one a
yes-or-change confirmation with no option marked. Jason, whole message: *"ye go
with the recomendations"*.

1. **A guardian may still be linked to a withdrawn athlete's record.** Asked:
   "Guardian link to a WITHDRAWN athlete's record: A, allow as today
   (recommended); B, refuse." **A.** PR #1055 had added a refusal; ChatGPT's
   review ruled it a minors'-privacy product rule he had not been asked about.
   It was removed from that PR and no lane is opened for it.
2. **The Lane S rulings, confirmed to overwatch.** Asked: "Confirm your Lane S
   rulings to overwatch: dark humour for everyone including athletes and
   parents; safe weight-cut education from real sources; teach-first; stay on
   the free models. Yes / change." No option was marked recommended; overwatch
   read "ye" as yes (INFERRED) and Lane S reported that this matches what he
   told it directly. ChatGPT's review of PR #1058 ruled the answer sufficient
   for teach-first, and that the trailing "go with the recomendations" must not
   be used to widen it beyond the items listed. Section 6 records later wording
   on the humour item only; it is not evidence for the other three items.
3. **A calibration revision is scoped to the pair of MARKS.** Asked: 'Confirm
   Lane 12 "pair" = A, the pair of MARKS in disagreement (recommended). Yes /
   B.' **A.** This clarifies what "pair" means for OD-2026-08-29-005 and its
   migration (PR #1059): the clip, both annotation sets and the two marked
   events. One clip can hold several separate disagreements, and only a second
   decision about the same two marks is a revision. OD-2026-08-29-004's "What
   was asked" paragraph, which speaks of a clip's pair of annotation sets, is
   left as written; this entry is the later clarification.
4. **Overwatch writes records without asking each time.** Asked: "Authorize
   overwatch to commit, push and open records PRs for `OWNER_DECISIONS.md` and
   `ACTIVE_WORK.md` without asking each time: A, yes (recommended); B, ask
   each time." **A, standing, from this answer forward.** The records writes
   made before it (PR #1056's first three commits, their pushes and its early
   body edits) had no words of his naming those action types; that PR's body
   records them as a historical defect and nothing here authorizes them
   backwards.
5. **Overwatch runs read-only check workflows on `main` without asking each
   time.** Asked: "Authorize overwatch to run read-only check workflows
   (migration list-check, database check) on main: A, yes (recommended); B, ask
   each time." **A.** An earlier list-check dispatched from a lane's unmerged
   branch (run 36883139484) was ruled an unauthorized write by ChatGPT and is
   not covered by this answer.

### 2. Four answers in one message

Jason, whole message: *"1 yes 2 Talk to your Coach about todays training 3 B 4
A bud update chat gpt of the design change"*.

1. **Merged migrations are applied to staging without asking each time.**
   Asked: "Apply the 1% Club migration (#1057, merged) to the STAGING database,
   and may overwatch apply merged migrations to staging without asking each
   time: A, yes (recommended); B, ask each time." **Yes.** Production is
   unchanged: every production migration run takes his approval click.
2. **What an athlete sees when the training-hold check fails: his own
   wording.** Asked: A, "We could not check your training status just now. Ask
   your coach before you train." (recommended); B, nothing, as today; C, his
   own wording. **C.** The line is "Talk to your coach about today's training."
   and it is the whole line. Overwatch normalised two things from his typing
   ("Coach" to "coach", "todays" to "today's") and told him so.
3. **The coach board's "Place a training hold" control when the hold check is
   unavailable.** Asked: A, kept (recommended); B, disabled until a reload
   succeeds; C, hidden. **B**, against the recommendation. Lane H added a
   per-athlete "Check again" control so a coach can retry without reloading the
   whole board; that control is overwatch's decision, told to him, not his
   ruling.
4. **The parent password lane starts building now.** Asked: "Lane P (parent
   password) start: A, build part 1 now on the lane's own technical design,
   ChatGPT reviews the PR (recommended); B, hold until ChatGPT's design verdict
   is read." **A, and ChatGPT is told of the change of sequence** (done the
   same hour). ChatGPT's design verdict had been written but overwatch could
   not read it; it still governs, through the PR review.

### 3. The parent password questions (asked and answered in the Lane P thread)

Relayed by Lane P, and then read by overwatch in that thread's own transcript
on 2026-10-01. The lane's message immediately before his reply listed seven
questions, each official then plain, each with A marked recommended, and ended
'reply "go with recommendations" to take the recommended option on each'. His
reply, whole message, 16:00Z: *"agree with recomendations"*. So A on each:

1. the password prompt on the emailed link is offered with "Not now", not
   mandatory before the dashboard;
2. parents only, not coaches, staff or volunteers;
3. minimum 10 characters, no forced symbols or capitals;
4. on `/login`, a password box under the email box with two buttons, "Sign In"
   and "Email Me A Link Instead";
5. the same slow-down the athlete PIN has, with no hard lockout;
6. a password is changed only through a fresh emailed link;
7. an organization admin gets "Clear Password" on the People page, which signs
   the parent out and sends them back to the email link.

These answer the four points OD-2026-10-01-001 section 4 listed as not decided.
A second message of his in that thread, *"go with you recomendations"* (17:10Z),
followed a status line with no question open; it is read as deciding nothing
new.

### 4. Other instructions the same day

- *"stay on the parents its a fresh thread"*: read as "stay", this thread
  remains overwatch. The second half was not understood and nothing was done
  on it.
- *"open git hub when we have stuff read to deploy to productions"*: overwatch
  opens GitHub for him when a release is staged and ready for his approval.
- *"fix q permission mode"*: overwatch set the Lane Q thread's permission mode
  to match its own so that held lane messages deliver. It did the same for the
  Lane H thread, which had the same fault and which his words do not name;
  reported to him.

### 5. The cross-athlete draft bug

Lane H's reviewer reproduced a defect that is live in production (REPORTED by
the lane; not checked by overwatch): on the coach's decision screen, a draft
written about one athlete stays in its box when the coach switches to another
athlete, and one click sends it to the second athlete. Described to him, Jason:
*"we need to fix this"*. Asked beforehand whether Lane H should take it as a
second PR (recommended) or a new lane, he did not choose; overwatch gave it to
Lane H as a second PR. The lane's reading of the screen found the same defect
in seven actions: Message Home, the behaviour note, an incident report, a
recorded decision, a near-miss flag, the medical status with its source
reference, and a decision outcome.

### 6. Lane S: the humour wording (asked and answered in the Lane S thread)

Relayed by Lane S. For each quote below except the one marked, overwatch read
that thread's own transcript on 2026-10-01 and names the lane message his reply
followed. Section 1 item 2 is the direct confirmation of the high-level ruling;
this section is the detailed wording that PR #1061 builds.

- **Which audiences.** The lane's message asked Q2, which audiences get dark
  humour: staff only (its recommendation), staff and parents, or everyone,
  athletes included. His reply (15:30Z) begins *"Q2 dark humor for everyone
  that part of the gym identity"*.
- **The register text.** The lane's message (its Q10) showed the proposed
  athlete and parent text and offered A, as written, including the line "aim
  it at the mistake, not at the kid"; B, without that line; C, his rewording.
  His reply, whole message, 17:20Z: *"A but it should not take responsibility
  away from the kid or make excuses for them"*. Built as: "Hold them to it. Do
  not make excuses for them or take the responsibility off them".
- **Four reviewer points.** The lane's message listed Q11 (say that being
  hurt, in pain or treated badly is not a mistake or an excuse), Q12 (jokes
  never target body, weight, ability, family or an injury), Q13 (keep
  "Respectful" for parents) and Q14 (is sarcasm included for athletes), with
  overwatch's and the lane's recommendation to add Q11 and Q12. His reply
  (17:40Z) ends: *"Q11 ill agree with treated badly Hurt and pain go with
  boxing,  q12  leave not at the kid  specifics leave holes  q13 yes"*. Built
  as: the athlete text says being treated badly by someone else is not a
  mistake and not an excuse, and does not say that of being hurt or in pain
  (narrower than recommended; his call); no list of what a joke may never
  target, "not at the kid" stays the whole rule; the parent text keeps
  "Respectful" and aims humour at the situation, never at the parent or their
  child. The same reply opens by saying dark humour may also be applied to
  four fixed fallback answers; nothing is built for that, and PR #1036 removes
  those answers.
- **Sarcasm.** The lane's message left Q14 open as "A yes / B no". His reply,
  whole message, 17:52Z: *"q14 A"*. The athlete text now opens "The gym's dry,
  dark, sarcastic humor is part of how this place talks."; the parent text is
  unchanged.
- **Humour inside injury answers: confirmed to overwatch.** Lane S relayed
  *"Q8 B"* as his answer that humour is not kept out of injury, head-knock,
  pain and emergency answers. Overwatch did not find that reply as a typed
  message in the thread's transcript, so it asked him directly: 'Confirm to
  overwatch your Lane S answer "Q8 B": SHADOW's humour is NOT kept out of
  ordinary injury, head-knock and pain answers. Yes / no.', with the plain
  line that the fixed emergency replies stay humour-free either way. His
  reply, whole message: *"yes i said NOT in the s lane"*. So: the humour
  register also governs model-written answers to ordinary injury, head-knock
  and pain questions. This matters to PR #1061, which is not neutral on it:
  it edits no classifier and no fixed reply, but by replacing the athlete
  register's blanket "No dark or sarcastic humor" it lets the new register
  reach model-written educational answers that no fixed fallback intercepts
  (for example an allowed `head_trauma` question). His confirmation is the
  authority for that effect. What it does not cover: the fixed urgent and
  emergency replies, which carry no humour and which no PR changes.

Until PR #1061 merges, today's registers stand as OD-2026-10-01-001 section 7
quotes them. The fixed emergency replies carry no humour and no PR changes
them.

---

## OD-2026-10-01-001 -- Lanes finish and close; closed lanes are archived; the safety fix lanes; parents get a password; a second approver login, timing his; release 2

**Provenance: PRIMARY** where Jason's words were typed in the overwatch thread
(transcript as in OD-2026-09-30-007); **REPORTED** where a lane relayed them
(each marked). **Date:** 2026-10-01. Questions were put in official form, then
in plain English.

### 1. Lanes finish and close; an add-on only if it closes the lane

Jason: *"ok lets get the lanes finished and closed, we will edit the add to
rule to only inculd if the add on is need to close the lane"*.

This replaces G6 of OD-2026-09-30-003 ("continue it, and continue only with a
next item in the same area and files"). The rule now, as written the same day
into the overwatch section of his L2 rule file
(`~/.claude/rules/ppbf-workspace.md`, outside this repository; read at
writing): overwatch closes a lane when its scope is complete; a lane takes on
added work only when that add-on is needed to close its own item (a review
finding on its PR, a fix its PR depends on); any other next item goes to a new
lane. "No parking" stands.

Two calls overwatch made under it, told to Jason the same hour and not his
rulings: add-ons already BUILT when the rule changed were let finish (the L1
lane's deleted-login refusals, PR #1055; the cleanup lane's PR #1050); add-ons
not yet started were cancelled and become new lanes (the remaining
deleted-athlete screens; the calibration stale-view fix).

### 2. Closed lanes are archived

Asked whether overwatch may archive a lane thread once its scope is finished
(A, yes, standing; B, ask each time), after his *"are you able to archive the
lanes when thierscope is finished"* and *"can i give you permission based on
when thier scope is met to archive on your own"*, Jason: *"go with your
recomendations and archive closed lanes that dont have follow on work"*.

Overwatch archives a lane's thread when the lane is closed and has no follow-on
work in it: its PR merged or its report delivered, its `node_modules` junctions
unlinked, the shared install confirmed. It tells him each time. It does not
archive a lane with an open PR, and not the lanes he drives himself (the visual
lane, Lane S). Archiving is reversible; nothing is deleted.

### 3. The safety fix lanes start now; the rest wait

Lane 14 (read-only) reported 49 confirmed places where a screen renders
"nothing here" when the read that fills it FAILED (the #991 class;
`ACTIVE_WORK.md`'s lead row), grouped into eight fix batches. Fixing them is
already decided (OD-2026-09-29-002 item 4: live bugs go on the build list).
Put to Jason: when do the fix lanes start? A, the two safety batches now
(recommended); B, after the day's lanes close; C, all eight at once. His
answer, in the same sentence as section 2: *"go with your recomendations"*.
**A.**

- Lane H: a failed training-hold read must not look like "no hold" (the
  athlete's hold banner, the coach's sports-medicine board), and a failed
  athlete switch must not leave the previous child's medical status on the
  coach's decision screen. One question inside it is his and is not yet
  answered: what an athlete sees when the hold check could not be read.
- Lane Q: the admin safety queues and counts (quarantined videos, escalation
  tiles, the SHADOW intake, feedback-review and flags panels) must not read
  zero on a failed load.

Batches 3 to 8 are on the build list in `ACTIVE_WORK.md`.

### 4. Parents sign in with a password

Jason, having never seen the parent side signed in: *"do parents not get an
easier way to sign in with a password"*. Told that parents sign in only by an
emailed link, and asked whether they should get a second way (A, keep the link
only; B, an account ID and PIN as athletes have; C, a password), he answered:
*"yes they will need away to sign in with a password, open a lane to do that,
the parent open in chrome browser i dont think the magic link will let it open
in in app browser, the magic link should prompt them to make a password"*.

What it decides: parents get a password sign-in, and the emailed sign-in link
prompts them to create it. Lane P designs it first; the design goes to the
architect and the owner questions to him. NOT decided by this entry: whether it
is parents only or every email-link role, whether the link stays as the way
back in when a password is forgotten, the password rules, and what an admin
may do to a parent's password.

### 5. A second approver login for production: yes, and the timing is his

On GitHub's production environment "prevent self-review" is off, and the
required reviewer is the account the Claude sessions act through (REPORTED by
Lane 13 from a read of the environment settings, 2026-10-01). Put to Jason: A,
leave it (his click is the control; a session never approves without his
instruction for that run); B, turn on "prevent self-review" and approve from a
second GitHub account that only he uses. He asked *"what do you recommend"*;
overwatch recommended B, set up before the one-approval release workflow's
first real run. Jason: *"B but i decide if we need to do it or keep pushing
forward"*.

**B, when he says.** Nothing is set up, and nothing is made to wait on it.
Overwatch raises it once when the one-approval workflow is ready for first use,
and he decides then. Until he says so, production approval works as it does
today.

### 6. Release 2 (2026-10-01)

Jason: *"check in with lanes and update do we have anything to deploy"*. `main`
was twelve commits ahead of production (`f597a4a5` to `51ada37f`, counted
with `git rev-list`) with no migration among them.

- Staged at `51ada37f220b7b02988893fbd2a9b5cc85cd60dc`: `deploy-staging` run
  36868958454, digest
  `sha256:596ec36920558ebf41de35a3ac283e9a6aa5e4553e4e6238960b299cdd2d1878`
  from that run's artifact. (An earlier staging run that morning, 36863295775
  at `4067e30e`, was superseded when the records PR #1053 merged.)
- The signed-in staging check (OD-2026-09-30-007 section 7, Q4 A). Jason:
  *"use the extensions to navigate and verify staging"*, then *"all are logged
  in"*. Walked by overwatch through his signed-in browser windows; he entered
  every credential. OBSERVED: as gym admin, the People page lists its 12
  people, the Add Athlete ID box offers the next free id after a mode switch
  and back (nothing submitted), the escalations page and feedback queue load;
  as coach, the drill library and Passbook gaps load; as the test athlete, the
  dashboard loads, his own Passbook opens, another athlete's is refused.
- The parent side had never been walked. Jason: *"i dont think we actually
  have ever logged into the parent side, can you run a test parent in the in
  app browser"*. He created a test parent on staging and signed it in himself.
  OBSERVED as that parent: the Parent Hub shows the linked athlete; the
  Passbook returns only the athlete's id, name and a count of completed
  sessions, with no dated rows (the change in this release, OD-2026-09-30-004
  d3); another athlete's Passbook is refused; the coach's gap queue is refused;
  the admin People page sends the parent back to the Parent Hub.
- NOT walked, resting on tests and review: the intake refusals, and what a
  deleted athlete's screens show.
- Production: `deploy-production` run 36872957122 at the same commit and
  digest. Jason: *"i approved production"*, then *"producting green"*. Live as
  revision `app-ppbf-production--0000160` on that digest (read from Azure after
  the run). No signed-in check was made in production.

What shipped: deletion scope B (#1027), the two door fixes (#1041, #1042), the
People page ID box (#1045), the cleanup skipping gate fixtures (#1044), the
parent Passbook (#1046), the intake login rules (#1047), a deleted athlete's
Passbook unreadable (#1051), the CI build fix (#1052), and three records
commits.

### 7. Rulings he gave in other lanes, as relayed (REPORTED, NOT YET CONFIRMED)

Each was relayed to overwatch by the lane named. **This section is evidence of
what was relayed. It supersedes no existing decision and authorizes no build.**
A ruling here becomes a decision of record when Jason confirms it to overwatch
or the lane's readback to him is answered, and it is then recorded in its own
entry. What was checked on 2026-10-01: a text search of each lane's transcript
finds the quoted words in it. That shows the words are in the lane's thread;
it does not establish, for each, the question they answered. Every sentence
below that interprets his words is the lane's reading, not his ruling.

- Visual lane: the visual work restarts from scratch, *"we are building this
  from scratch and only using the previous work and yesterdays photos as
  refrence"*; *"we will work the plates in grok, then use canva to do the UI
  ux"*. So `docs/ROOM-MAP.md`'s build order is reference while the room layout
  is open, and no lane is scheduled against it. PR #941 (the drill cabinet):
  *"Hold it, decide later"*; it stays open and unmerged. The ring corner pads:
  *"Worn and indistinct"*; the lock's row stands, marked disputed, until he
  settles it.
- Lane S (SHADOW's model and personality), first answers: *"Q1 those are two
  different parts, one is chat the other is the AI/ML that supports the chats
  responses  Q2 us the dark humor Q3 A  Q4 A i am also not tied to a single
  engine, if there is better that is covered bu the azure grant we can use it,
  things may have changed since the first design"*. Later the same day, to
  three questions (Q2, which audiences get dark humour: A staff only,
  recommended; B staff and parents; C everyone, athletes included. Q6, an
  athlete asks how to cut weight: A teach how it works and how to do it as
  safely as possible, age-tuned, the coach decides; B risks only; C as it is.
  Q7, build the teach-first prompt change as a PR now): *"Q2 dark humor for
  everyone that part of the gym identity, i want the weight cutting in usa
  boxing has classes and recomendations for it, we can educate it in a safe
  way,  Q6 A we will go off of research from real sources, yes the app should
  rarely say dont Q7 yes, as far as the model goes we should stick with the
  free models, the pay for does not give a good enough increase in
  capabilities"*. The lane's reading, NOT CONFIRMED and changing nothing
  until it is: dark humour for every audience, athletes and parents included;
  SHADOW teaches weight cutting safely from real sources; the prompt is
  rewritten to teach first; SHADOW stays on the models already deployed. Until
  he confirms, today's registers stand (`buildRegisterPrompt`,
  `apps/web/src/server/pilot/shadowChat.ts`, read on main at `c2c4df67`): the
  athlete register's "No dark or sarcastic humor." and the parent register's
  "Measured and respectful. No gym slang or insider humor without a
  plain-language explanation beside it."; and so do the request
  gate and response filter on weight cutting. Nothing of this is built when
  written.
- Lane 12 (the calibration revision migration, OD-2026-08-29-005): asked
  which "pair" a revision is scoped to (A, the pair of MARKS in disagreement:
  the clip, both annotation sets and the two marked events, recommended; B, the
  clip's pair of annotation SETS), Jason: *"go with recomendations"*. The
  lane reads that as A. NOT CONFIRMED: it does not correct or supersede
  OD-2026-08-29-004, whose "What was asked" reads "a clip's pair of annotation
  sets" (his own quoted words there say only that the newer adjudication
  supersedes the older and name a unique index on (pair, revision)). The
  lane's reason for A: one clip can hold several separate disagreements, and
  only a second decision about the same two marks is a revision. Its
  migration does not merge until he confirms A to overwatch.

### 8. He asked overwatch to check itself

*"also to keep you on track scope and drift check yourself"*. Overwatch's
check of that hour found, beyond the two defects already in OD-2026-09-30-007:
it told three lanes they had skipped sending plans when those messages had been
held on its own side (retracted); and it merged the records PR #1053 while
release 2 was staged, which moved `main` and cost a second staging run.

---

## OD-2026-09-30-007 -- What Jason authorized overwatch to do (lane questions, spending, the staging app) and his 2026-09-30 / 10-01 answers

**Provenance: PRIMARY** where Jason's words were typed in the overwatch thread;
**REPORTED** where a lane relayed them (each marked). **Date:** 2026-09-30 and
2026-10-01. The overwatch thread is the session that took over from the
housekeeping thread on 2026-09-30 (OD-2026-09-30-003); its transcript,
`~/.claude/projects/C--Dev/5b2fe0c3-80bd-4765-873d-9a0be7fc987d.jsonl`, is
outside this repository. Ids -005 and -006 are taken by open PR #1036 and are
not on `main` when this is written. Questions were put in official form, then
in plain English, each with one option marked recommended.

### 1. What Jason authorized overwatch to do

1. **Lane questions.** After several lanes' plan messages expired waiting for
   his approval, Jason: *"You can answer the lanes questions"*. Overwatch
   answers the lanes' technical, how-to and scope questions without routing
   them to him. This restates G8 (OD-2026-09-30-003); it does not move product
   intent, design, safety or minors' privacy away from him. ChatGPT, reviewing
   PR #1050 on 2026-10-01, held overwatch to that line: removing an operator
   override on a minor's login was not a lane question (item 4 below).
2. **Spending.** Jason: *"Spend is ok as long as its not a new product"*.
   Overwatch's reading, told to him at once and not corrected: more usage or
   capacity on things PPBF already pays for is overwatch's to approve; a new
   subscription, vendor, paid service or product line goes to him first. This
   narrows G8's "spending goes to Jason".
3. **One answer for the questions then open.** Jason, when the same questions
   had been put to him more than once: *"go with your recomendation i feel like
   i have answered that a million times"*. It selected the recommended option
   on the questions already put to him and still open at that moment; they are
   listed in section 2 and it reaches no further. It is not a standing
   authorization to act on later recommendations without asking. Overwatch
   told him it would from then on act on its recommendation and report
   afterwards, and he did not answer; silence is not a grant, so a later
   question is still put to him, once, with a recommendation. If he gives
   standing authority of that kind, it is recorded from his own words.
4. **The staging app.** Jason, signed in on staging: *"ok im logged into the
   org ppbf@   you have my permision top do what ever you need to do in the app
   there are no real people or sensitive info in them"*. Overwatch may act
   inside the staging application. It does not cover production, and it does
   not cover credentials: he enters those.
5. **Overnight.** *"im going to bed make sure you keep check in and updating
   lanes, do you have any nore that needs starting"* and *"can you chek on the
   lanes every 15 mins"*: overwatch checks the lanes on a 15-minute schedule
   while its session is open, merges what is green, in scope and cleared by
   review, and never dispatches production.
6. **One approval click, on his words.** Three read-only production runs were
   waiting for the environment approval; overwatch listed them and Jason
   answered *"approve reviews"*. Overwatch clicked the approval for one (run
   36806464883, the research-repair dry run) in his signed-in browser; the
   app's permission check refused the second click, and Jason approved the
   other two himself. This is the per-run, contemporaneous instruction
   OD-2026-09-30-001 item 3 describes; it is not standing production approval.

### 2. Answers taken as recommended

Under *"go with your recommendations, A for both, and find me what lanes are
left"* (2026-09-30):

- **Lanes L1, L2, L3 start.** L1 intake logins (d1, e1 and the intake 500 bug),
  L2 deleted athletes off the admin safety screens (#1027 Q1-B), L3 the parent
  Passbook (d3); each with one PR, a file allowlist, one "done when" sentence
  and "update overwatch before each step".
- **One approval for migrate-and-deploy: commissioned.** As put: one GitHub run
  that builds staging, applies migrations and deploys production behind a
  single approval click; A, yes, as its own Opus lane after the next release
  (recommended); B, not now. **A.** Jason had asked for it the same day: *"can
  i have multiple lanes migrate and then deploy under the same deployment"*.

Under *"A for 6 and 7 and drift check we have a staging already"*: lanes 6
(d4, the cleanup skips `gate_*` ids) and 7 (the People page athlete-ID box)
start; and overwatch checks staging for drift (section 3).

Under *"go with your recomendation i feel like i have answered that a million
times"*, read as bounded to the questions below, which were the ones already
put to him and open when he said it; each as put, and the recommended option
taken:

- **Failing safety gates of a deleted athlete.** A, hide them from the safety
  review page at once (their open holds, escalations and violations still stay
  until resolved); B, leave them until the retention purge and correct the
  document; C, build a dismiss action. **A.** This changes option B of "#1027
  Q1" (OD-2026-09-30-004) for failing gates only: a failing gate is a standing
  state with no action once the athlete is gone, and nothing in the app can
  produce the passing evaluation that would clear it. Built in PR #1048.
- **V1, the `room--` class ceiling.** A, replace the count ceiling in
  `legacyVisualVocabulary.test.ts` with a check against the approved-room list;
  B, keep the count. **A.** Built in PR #941.
- **PR #1026 (the look board).** Close it or keep it; the visual lane
  recommended against merging it, because it proposes a Floor look that
  competes with the one approved on `local/coach-floor-board`. **Closed**
  2026-10-01; the branch `local/look-board` is kept.
- **C1, two rules relayed through lanes, confirmed.** (a) For this phase the
  visual and UI work is Jason's and the visual lane's, and only overwatch and
  the visual lane use ChatGPT, each in its own chat. His words as the visual
  lane relayed them (REPORTED): *"it can help you mapp things out  but you and
  i will build the visual and UI, we will keep house keeping updated so that
  other lanes can fix anything that needs done to make it work"*, and *"i may
  change that later after we get everything mapped and figured out UI and
  design wise"*. He later widened it himself: Lane S may read ChatGPT (section
  4). (b) A lane updates overwatch before acting on each new step.
- **S3.** Derive `SHADOW_CONTEXT_CONTRACT_VERSION` from the code instead of
  bumping it by hand; A, a small lane later (recommended); B, leave it manual.
  **A.** Not built.
- **W1.** Reword the production-approval clause of Jason's L2 rule file so it
  protects his per-run instruction, not who opened the page (the ACTIVE_WORK
  build row); A, reword; B, keep. **A.** Not yet done: the wording goes to him
  first, because it is a rule about authorization.
- **U1, lane models.** Sign-in, permissions, migrations, minors' data and
  safety lanes on Opus at high effort; other lanes on Sonnet at medium effort.
  **Applied.** It follows his usage direction, relayed by the housekeeping
  thread (REPORTED): *"add a conserve usage to what we are doing dont overkill
  models and effort, but at the same time the model and effort has to fit the
  task"*.
- **The policy-shelf move, production dry run.** A, run it read-only to count
  the citing evidence items; B, first build a way to move them. **A**; result
  in section 3.

Relayed answers, recorded as REPORTED: through the housekeeping thread, *"i
approve 2  1 doesnt matter"* (2 = send ChatGPT the PR #1036 review request; 1 =
paste the updated instruction texts into ChatGPT, skipped); through the AI/ML
lane, *"that also is an overwatch task"* (the signed-in SHADOW check on staging
after PR #1036 is overwatch's; he still enters every credential). The second
narrows G3's "Jason's own signed-in check on staging" for that check.

### 3. Staging has the gym organization; the policy-shelf move is blocked by citations

Put to Jason: create the `punxsy_prominence` organization on staging so staging
matches production; A, he creates it signed in as Admin@ (recommended); B, a
lane builds a provisioning step; C, leave it. **Jason:** *"A, open the staging
admin page"*, then the permission in section 1 item 4. Overwatch created it
through the app's setup wizard on 2026-09-30 from his Admin@ session, id
`punxsy_prominence`, name "Punxsy Prominence Boxing and Fitness"
(`check-database` seed-identity on staging, run 36760731887, lists three
organizations). The wizard's "add gym admin" step was skipped: the app refuses
to add `ppbf@` to a second organization, so on staging `ppbf@` stays in
`ppbf-default-org`.

The move tool's dry runs then found what blocks it: saved SHADOW evidence items
cite the rows that would move, by a composite key that includes the owning
organization, and the tool refuses to move rows out from under them
(`EVIDENCE_ITEMS_CITE_ROWS`). Staging, run 36760879516: 25 sources, 10
documents, 60 chunks, 853 citing items. Production, run 36806469377
(2026-10-01, read-only, approved by Jason): 22 sources, 7 documents, 49 chunks,
**2** citing items. Nothing was moved. What to do with the two is not decided.

The other two read-only production checks of 2026-10-01: the research-repair
confirming dry run reads REPAIRED with nothing pending (run 36806464883), and
`library-scope` reads 981 live sources plus 213 retired under `__platform__`
(run 36806467005). Of the checks OD-2026-09-29-006 owed, one remains: a
signed-in SHADOW question in production, with Jason entering the credentials.

### 4. Lane S: SHADOW's model and personality, owner-driven

Jason's words, in order: *"Create a lane to talk about the LLM for shadow and
its personality let it preference chat gpt"*; *"Reference chat gpt and the
drives once to get a feel"*; *"You do it for reference and open that lane have
it do the same thing and I will answer questions and work with it until we get
the direction and anything fixed thats broken then I will hand it back to
you"*; and, with the first word read as "update", *"First date the lanes Aks
chat gpt to look for shadow personality and check the repo"*.

What it decides: a lane works with Jason directly on which model SHADOW runs on
and how it sounds; it and overwatch each read ChatGPT and the drives once for
context; it hands back to overwatch when the direction is set. Nothing about
SHADOW's voice is decided by this entry. What the passes found is evidence for
that lane, not a ruling: the persona is `SHADOW_SYSTEM_PROMPT`
(`apps/web/src/server/pilot/shadowChat.ts:959`) with audience registers at
`:1086`; no document found defines the voice; ChatGPT found no record of Jason
choosing its "tough but caring mentor", dark-humour layer; and the lane found
his 2026-08-25 visual approval of "AMPLECTERE MISERIAM (Embrace the suck)" as a
gym saying (REPORTED).

### 5. Decided by overwatch under item 1, for Jason to reverse if he wants

These are not Jason's rulings. They are listed so a later session does not
mistake them for his.

- **The phone-apostrophe fix is split out of PR #1036** into PR #1049, to ship
  without waiting for #1036's review rounds: on `main` and in production the
  SHADOW urgent patterns matched "can't breathe" only with a straight
  apostrophe. Jason's rulings to the AI/ML lane on the content, as that lane
  relayed them (REPORTED): *"Normalise input + patch"* and *"Fix all blocking,
  then re-review"*.
- **A live athlete whose login the cleanup deleted** gets one refusal from
  intake (`ATHLETE_RECORD_HELD_BY_DELETED_LOGIN`, PR #1047; fixed by hand as in
  e3 B) until the cleanup stops retiring such logins (PR #1050).
- **PR #1050 also stops the cleanup retiring a NAMED login whose athlete record
  is live.** ChatGPT ruled this needs Jason. It was put to him and he answered
  on 2026-10-01 (section 7): never. That half is now his ruling, not
  overwatch's.
- **e2's scope** (the L1 lane's next PR): admin actions on a deleted login
  refuse in both directions (status and membership included); assign-admin,
  transfer-admin and master SHADOW access are included; redeeming an activation
  code for a deleted login writes nothing and gives the same generic answer.

### 6. A defect in this record's own period

On 2026-10-01 overwatch re-ran one failed CI job (run 36809463596, on PR #941)
with no words of Jason's naming that action. ChatGPT's WRITES audit found it.
It changed no code and deployed nothing. Jason was then asked for standing
authorization to re-run failed CI jobs on open PRs, and gave it on 2026-10-01
(section 7). The re-run of 36809463596 itself stays a defect: it came first.

### 7. Answers of 2026-10-01

Three questions were put to Jason together, in official form then plain
English; two carried a recommendation. His answer, verbatim: *"agree with
recomendations"*. It answers the two that had one.

- **A named login whose athlete record is live.** As put: may the account
  cleanup ever retire a specifically named login while that athlete's record
  is still live in the same gym? A, no, never (recommended); B, yes, if an
  operator names it. **A: never.** The login is turned off in the app, or the
  athlete is deleted first. PR #1050 already builds this.
- **Re-running failed CI jobs.** As put: may overwatch re-run failed CI jobs on
  open PRs without asking each time? A, yes (recommended); B, ask each time.
  **A.** It covers re-running a failed job on an open pull request. It does not
  cover dispatching a workflow, a deploy, or anything in production.
- **Standing authority to act on recommendations.** As put: A, yes, for
  decisions that are reversible and are not production, a new product, or
  minors' safety or privacy; B, no, ask each time. Overwatch gave no
  recommendation, so *"agree with recomendations"* does not answer it. **Not
  answered**; section 1 item 3 stands, and each new decision is put to him.

The same morning, on finishing the staging check before a production release
(A, bring the three signed-in browser windows forward and overwatch walks the
changed screens, recommended; B, he checks them himself; C, release on tests
alone), Jason: *"sych permissions  abd Q4 A ... i can not see the other 3
questions"*. **A**; and "sych permissions" is his instruction to give the lane
sessions the same permission mode as the overwatch session, so messages between
them are delivered. Done for lanes 11 to 14.

---

## OD-2026-09-30-006 -- High-risk chat questions get education, not a refusal; acute reports get education plus an act-now line

**Status, 2026-10-01:** recorded on `main` by a records PR ahead of PR #1036, which builds it and is not merged; Jason, asked whether to move this record so PR #1058 need not wait on #1036: *"Yes to 1 and 2"*. The text below was PORTED from PR #1036's branch at `9208457a` and is not identical to it: on the way to `main` it gained this paragraph and the next, "four selections" became "five" in two places, and the chest-pain attribution was corrected. Nothing in it is built on `main` until #1036 lands. **Status update, 2026-10-02:** #1036 is being superseded by the replacement sequence in OD-2026-10-01-006 section 3. PR #1058 has already landed the teach-first prompt portion; the remaining route and classifier behaviour is being built through that replacement sequence.

**Checked against the transcript, 2026-10-01** (the closed AI/ML lane's thread; a
read-only pass that read each reply with the message or option set it answered).
His sentence and each of the five selections match the transcript, options and
all. Three things a reader should know: two of the option labels he selected
carried "(Recommended)" in the prompt ("Refund on failure (Recommended)",
"Education + act-now line (Recommended)") and are quoted here without it; his
governing sentence was typed while a question about the guard was open, so it
was unprompted only in that no question asked for it; and two statements in
this entry were corrected on the way to `main`: "four selections" was five, and
chest pain was called the owner's own example when it was the question's
wording.

**Provenance: PRIMARY** for the owner's words and for the options exactly as
they were put to him. The governing sentence is his own free text, not a
selection. The five selections that follow it are reproduced with their full
option sets, because a chosen label does not carry a decision on its own.

**Date:** 2026-09-30. **Governs:** what the SHADOW chat route does with a
message the doctrine classifier marks high-risk.
**Supersedes** the refusal behaviour built by #972 and everything downstream of
it, including the shape of the guard published as PR #1036.

### The decision

Put to him as a question about how narrowly to scope a guard. He answered a
different and larger question, verbatim and unprompted:

> well they are supposed to get education not refusal

That sentence governs this entry. It is not new policy: the standing rule has
said since it was written that education creates safety, and that unrequested
refusals and gates are not to be added. The code had drifted from it, and this
is the owner restating it against the code rather than deciding something new.

### What the code was actually doing

Established by running the real classifier, not by reading it:

| message | classification | emergency wording |
|---|---|---|
| "I have chest pain right now" | `personal_health_concern` | no |
| "My shoulder is sore after sparring" | `personal_health_concern` | no |
| "I cannot breathe after that hit" | `urgent_personal_symptom` | yes |
| "I passed out during training" | `loss_of_consciousness` | yes |

Chest pain -- the example in the question he answered when he first ruled on
this (OD-2026-09-30-005; "someone reporting chest pain" is that question's
wording, not his) -- was filed in the same bucket as a sore shoulder. And the response body for any
of them was `requestValidation.error` and nothing else: one sentence,
`success: false`, the model never called. A sore shoulder received, in full,
"Personal pain, injury, and treatment questions require evaluation by a
qualified medical professional. SHADOW can only provide general educational
information." It claims it can educate and then does not.

The system prompt already contained a worked example doing exactly what the
owner asked for -- decline to diagnose, then offer to walk the athlete through
what to watch for. The doctrine forbids diagnosing, prescribing and clearing.
It has never said refuse. The gate was not implementing the doctrine; it was
preventing it.

### The five selections

**1. What counts against the review-queue quota**, after it was found that the
limiter increments before the write, so failed inserts consume the hour.
Options as put: "Refund on failure *(recommended)*" . "Leave it -- count
attempts" . "Count rows only". He chose:

> Refund on failure

**2. The scope of the #1036 guard.** First put as a two-way choice between
urgent-only and any-invalid-request; he replied "explain in layman terms", and
on the corrected options -- which established that narrowing to the code's own
"urgent" flag would have dropped chest pain -- the set was "Keep it wide
*(recommended)*" . "Narrow it anyway" . "Narrow it and fix the classifier".
He chose:

> Narrow it and fix the classifier

This is the owner overriding a recommendation. The recommendation was to keep
the wide guard and record why; he chose the more expensive and more correct
option.

**3. When the classifier gets fixed.** Options: "Record it, fix next lane
*(recommended)*" . "Fix it now before deploy" . "Leave it alone". He chose:

> Fix it now before deploy

Also an override. It reopens a lane that was closing and holds a release that
was ready to dispatch.

**4. What the acute cases get.** Options: "Education + act-now line
*(recommended)*" . "Act-now line only" . "Education only, same as the rest".
He chose:

> Education + act-now line

**5. Who is flagged for a human.** Options: "Acute cases only *(recommended)*"
. "Everything high-risk, as now" . "Nothing -- drop the flag". He chose:

> Everything high-risk, as now

A third departure from the recommendation, in the conservative direction: the
queue keeps its current breadth.

### What that means

1. A high-risk message is no longer refused. It reaches the model, which
   answers it under the existing doctrine -- never diagnosing, prescribing or
   granting clearance, and deferring to a medical professional where that is
   the real answer.
2. The acute set -- chest pain, loss of consciousness, fainting, and the
   urgent-symptom list -- additionally receives a canned act-now line. Canned
   because it must still be delivered when the model is unavailable.
3. The classifier is corrected so the acute set actually contains chest pain.
4. The human-review write continues for **every** high-risk message, unchanged
   in breadth, and keeps the `safety_review` bound from OD-2026-09-30-005 --
   now with the slot refunded when the insert fails.
5. The guard from OD-2026-09-30-005, which let a refusal past runtime readiness
   and the global limits, narrows to the acute set only. For everything else
   the reasoning inverts: an educational answer needs the model, so it needs
   readiness and it should count against the limits like any other answer.

### What it costs, stated because the options did not say so

More high-risk traffic now reaches the model, so more of it consumes quota and
depends on the worker being up. The refusal was, incidentally, a cheap and
always-available path; education is neither. Answer quality for these questions
is now a live question rather than a fixed string, and nothing in the test
suite can establish it -- that needs a signed-in human journey, and the owner
enters all credentials.

### The evidence it rested on

- The branch table above, produced by executing `validateShadowRequest` under
  jest against the real module.
- `route.ts`, safety-boundary responder: body is `requestValidation.error`,
  `success: false`, `state: 'filtered'`, model not called.
- `shadowChat.ts`, `SHADOW_SYSTEM_PROMPT`: doctrine items 1-3 forbid
  diagnosis, prescription and clearance; the diagnosis-request example
  demonstrates declining and then offering education.
- Blast radius measured before the decision, not estimated after:
  `shadow/chat/route.test.ts` (22 references / 67 tests) and
  `shadowChat.test.ts` (17 / 68) carry the behaviour; seven other suites hold
  one or two incidental references each.
- No environment, database or log was read. The platform holds no real athlete
  or user data (owner, 2026-09-29), so no real person was affected either way.

## OD-2026-09-30-005 -- Safety outranks runtime readiness and the global chat limits; the review-queue write gets its own bound

**Status, 2026-10-01:** recorded on `main` by the same records PR, ahead of PR #1036, which builds it and is not merged. PORTED from that branch at `9208457a` and not identical to it: on the way to `main` it gained this paragraph and the "Checked against the transcript" paragraph, the three authorization options were restored to the prompt's own wording, and the aside about an earlier PR under "Recorded late" was qualified.

**Renumbered twice.** Published first as OD-2026-09-30-001, then -003, now
-005. `main` took -001 for the release/migration decision, and overwatch's
records PR took -003 and -004; both collisions surfaced only when the branches
met. Ids are allocated by whoever writes first and reconciled at merge, so a
lane holding an id for any length of time will keep losing it. Recorded rather
than silently corrected, because the code comments citing this entry moved with
it and a reader tracing an old id needs to land somewhere.


**Checked against the transcript, 2026-10-01** (same pass). The question, his
answer "a", the authorization follow-up and "3 per hour" match the transcript.
Three things a reader should know: his "a" was his whole reply to a message
carrying three questions that said to reply like "1a 2a 3a"; the three
authorization options below are now given in the prompt's own wording (this
entry first wrote " -- " for the prompt's em dash and "the second reviewer's
argument" for "The second Claude's argument."); and the aside under "Recorded
late" about an earlier PR was NOT verified and is now qualified where it
stands.

**Provenance: PRIMARY** for the owner's answers and for the options exactly as
they were put to him. The options were drafted by Claude, and his input in each
case was a selection rather than free text, so the options are reproduced here
in full -- the word alone does not carry the decision.

**Date:** 2026-09-26 (answered); recorded 2026-09-30, late, which is noted below
rather than hidden. **Governs:** the order in which the SHADOW chat route may
refuse a request, and what bounds the human-review queue write.
**Supersedes** the classification recorded by #972, which argued the opposite
in writing and pinned it in executable tests.

### The decision

Put to him as question 2 of three, verbatim as asked:

> **2. Rate limit / readiness vs safety** -- a throttled or mid-migration
> deployment answers "too many requests" to someone reporting chest pain.
> -> **(a)** safety wins, with its own bounded throttle *(my recommendation)* .
> **(b)** leave as is . **(c)** readiness only

His answer, verbatim:

> a

Two follow-ups the same day fixed the boundary and the number. On whether the
safeguarding response should also outrank athlete and conversation
authorization, the options were "No — auth stays above safety" (ChatGPT's
ruling), "Yes — safety wins there too" (the second Claude's argument), and
"Split it". He chose, verbatim:

> No — auth stays above safety

On the size of the new throttle, offered 5, 3 or 10 per hour or delegation to
Claude, he chose, verbatim:

> 3 per hour

### What that means

1. The safeguarding response outranks **core SHADOW runtime readiness** and the
   global **`chat`** and **`chat_daily`** limits. A throttled or unmigrated
   deployment must not answer an urgent personal symptom with "too many
   requests" or "temporarily unavailable".
2. It does **not** outrank authentication, structural request validation, or
   **athlete and conversation authorization**. A guessed athlete or
   conversation id must not become reachable by typing a symptom. This half is
   his explicit choice between two reviewers who disagreed, not a default.
3. The human-review queue write -- which the global limits were incidentally
   bounding -- gets its own bucket, `safety_review`, at **3 per hour per
   account**. Exceeding it suppresses the WRITE ONLY and never the response.
4. **Exhaustion and failure are different events.** A `safety_review` limiter
   that errors for any reason other than exhaustion must not be treated as
   exhausted: the write is attempted anyway. Treating "bucket storage
   unavailable" as "quota used up" would discard safeguarding work at the
   moment the database is already unwell. (Shape ruled by ChatGPT, 2026-09-30,
   as architect; the owner ruled the precedence and the number.)

### What it costs, stated because the options did not say so

Two gates that previously refused an urgent request no longer do. If core
readiness is failing, an urgent request now receives the safeguarding copy
rather than a 503 naming the missing tables -- which is the intent, but it also
means the 503 no longer surfaces on that path. And a suppressed queue write is
a log line only: the response still reports `requiresHumanReview: true`, which
means a human is needed, not that a row was persisted.

### Recorded late, and why that matters

This entry was written on 2026-09-30, after the implementation was built and
published as PR #1036. `AGENT_KERNEL.md` requires the decision to be in this
file BEFORE code or tests assert it, and the same omission had been caught once
before on an earlier PR and corrected then. (Which PR and when is NOT verified:
this entry first said "on #975 four days earlier by Codex"; the lane's own
message of 2026-09-26 says "Codex caught the same omission on #973 a day ago".)
It was not carried forward to
this slice; the architect review caught it at merge. The ruling itself was
never in doubt -- the record was, twice.

### The evidence it rested on

- The chokepoint comment in `apps/web/app/api/pilot/shadow/chat/route.ts`
  stated in terms that safety did NOT outrank core readiness or the global
  limits, with #972's reasoning: a throttle an urgent word could unlock is a
  bypass, and the safety path still writes to the review queue.
- `enforceShadowRateLimit` writes `pilot.shadow_rate_limit_buckets`, a table on
  the runtime-readiness list, and throws both on a missing table and on limit
  exceeded -- which is why the new throttle had to separate those cases.
- No environment, database or log was read. The platform holds no real athlete
  or user data (owner, 2026-09-29), so no real person was affected either way.

## OD-2026-09-30-004 -- Answers to the housekeeping question batch (2026-09-30)

**Provenance: PRIMARY.** **Date:** 2026-09-30. Between 12:08Z and 13:58Z the
housekeeping session (overwatch, OD-2026-09-30-003) put these questions to
Jason, each with options and one marked recommended; what each asked is as that
session put it (its transcript,
`~/.claude/projects/C--Dev/8bdb1aff-9439-4499-a828-5f3351394dcc.jsonl`, is
outside this repository). **Jason's answer, verbatim** (14:30Z): *"G4 it can
deploy more than once a day as many times as we need to  G8 also check with
chat gpt incase the answer is already there ( i will be working there outside
here) go with you recomendations, also we need to update the instructions and
settings with the other Ai"*. Its G4 and G8 parts are recorded in
OD-2026-09-30-003.

**How "go with you recomendations" is read (INFERRED).** As picking the
recommended option in every question then open in that session. The session
told Jason so at 14:30Z, naming the questions (all those below, M2 as part of
P4), and asked him to correct it if he meant less; none of his messages up to
15:05Z did. Not answered by it, because withdrawn before it: the release choice
b (moot once the migration reached staging, 13:24Z); R1 and R2 (folded into P1
and P2); and L1-L8 (replaced by G1-G10, OD-2026-09-30-003). Not answered by it
either: the plate branch `wip/plate-library-edits-2026-09-28`. The session
recommended parking it at 12:08Z, handed it to the visual lane at 12:46Z, and
put it in none of the later question lists or the 14:30Z read-back; where it
stands is in `docs/current/ACTIVE_WORK.md`.

- **a. Production deletion preflight.** As put: dispatch `check-database` with
  `check=deletion-preflight` against production, read-only, counts only: how
  many accounts marked deleted could still get in, which is how many the
  release's sign-in rule (OD-2026-09-29-003 item 9) locks out. Recommended
  yes. **Yes.** Run 2026-09-30 as run 36729671808 (14:38Z): 0 deleted accounts
  still active, 0 unrevoked sessions on deleted accounts (its log, "DELETION
  PREFLIGHT: NOTHING EVER DELETED.").
- **c. Two lines in Jason's L2 rule file.** As put: add that
  `magicLinkRedemption.pg.test.ts` hangs on Windows to the known issues, and
  correct the checkouts line (`C:\Dev\ppbf-platform` was on
  `local/teach-shadow-clip-cutter`, not `main`). Recommended yes to both.
  **Yes.** Done 2026-09-30 outside this repository
  (`~/.claude/rules/ppbf-workspace.md`, both lines read at writing).
- **d1. A guardian login an admin deactivated.** As put: when intake promotion
  names a guardian login with `active_flag` false and `deleted_at` null: A,
  refuse with a message; B, reactivate it, as it does today. Recommended A.
  **A**: refuse with a clear message; the admin reactivates the login on
  purpose. Build item.
- **d2. Blocking a duplicate athlete.** As put: A, block adding an athlete when
  name AND birth date match someone on the roster; B, keep today's name-only
  warning. Recommended B: matching birth dates would put every child's birth
  date in the directory the page reads. **B.** Nothing to build.
- **d3. The parent Passbook.** As put: A, narrow `GET /api/pilot/passbook` for
  guardians to match `ParentDigest` (no dated session rows); B, widen the
  ParentDigest decision to allow them. Recommended A. **A.** Build item.
- **d4. A deploy-gate fixture marked deleted by the account cleanup.** As put:
  A, the cleanup skips `gate_*` ids; B, provision new ids; C, clear
  `deleted_at`. Recommended A. **A.** Build item.
- **e1. A withdrawn athlete re-enrolled through intake.** As put: A, give them
  a new `account_id`; B, restore the old login by clearing `deleted_at`.
  Recommended A. **A**: a new login; the deleted one stays deleted. Build item.
- **e2. An admin acting on a login marked deleted** (a new activation code, a
  PIN reset, a staff re-invite, the platform owner's status and membership
  routes). As put: A, refuse with a clear message, like intake's 409; B, warn
  and continue; C, leave it. Recommended A. **A.** Build item.
- **e3. Undoing a mistaken deletion.** As put: A, build a restore action; B, a
  production database fix Jason approves each time. Recommended B for now.
  **B**; a restore action is built only if mistaken deletions start happening.
  Nothing to build.
- **#1027 Q1. Admin safety screens for a deleted athlete** (from the deletion
  scope B session). As put: A, hide the athlete's safety records at once; B,
  hide them once they are resolved. That session recommended B. **B.** Build
  item, after #1027.
- **#1027 Q2. Teaching footage a deleted athlete appears in.** As put: A, leave
  it; B, hide it too. Recommended A. **A**: leave it. Nothing to build.
- **H1. The content-intake session's close-out records.** As put: A, take them
  into housekeeping in full -- OD-2026-09-29-005 and -006, two build-list rows,
  the open-question rows, and the protected-doc edits after their PRs merge; B,
  the decision records and build rows only; C, decline. Recommended A. **A**,
  except the module 007 edit, which that session made itself in #1038
  (`f597a4a5`). Done in the change that records this entry.
- **H2. Who loads gym content.** As put: the code in #1031 already enforces it
  -- gym content is loaded only by an organization admin of
  `punxsy_prominence` (`ppbf@`), never by the platform owner (`Admin@`); only
  the platform owner loads into `__platform__`. A, confirm it as Jason's
  ruling; B, change it. Recommended A. **A**: it is Jason's ruling. Enforced in
  `assertImportActor` (`apps/web/src/server/pilot/contentImport/actor.ts:56-126`
  at `f597a4a5`): into `__platform__` only a platform owner (:90-98); into a gym
  never a platform owner (:100-105), only role `organization_admin` or `admin`
  (:39, :106-111), with an active membership in that gym (:113-124). This
  settles OD-2026-09-29-005 item 9.
- **M1. Merge PR #1027 (deletion scope B) once CI passes.** As put:
  squash-merge #1027 at `23f76e0a` once `validate` is green, while it is still
  mergeable and no new review finding has appeared; it has no migration and
  merging deploys nothing. Recommended yes. **Yes**, held until the production
  deploy of the 2026-09-30 release is dispatched (the release window,
  OD-2026-09-30-003). Merged 2026-09-30 14:41Z as `fee441eb`, after
  `deploy-production` run 36730895578 was dispatched (14:40Z).
- **M2. The storage lifecycle policy.** As put (13:29Z): a read-only check of
  the production storage account's lifecycle policy, to learn whether anything
  ever erases stored files of deleted records; A, run it (recommended); B,
  leave it. At 13:46Z the session folded it into production queue P4, and the
  read-back named it only there. **A**, as part of P4.
- **F1. `local/coach-floor-board`** (21 commits, 56 files, never in a PR; it
  split from `main` 105 commits back and conflicts in 6 files; its policy half
  landed through #998 and #1009). As put: A, drop it (it stays in the
  2026-09-29 backup bundle); B, rebuild its screen work fresh on `main` as a
  visual-lane thread; C, keep it parked. Recommended C for now, then B when
  Jason restarts the visual pass. **C**: parked, and rebuilt fresh as a visual
  lane when the visual pass restarts. Not merged, not deleted.
- **T1. The provisional research tiers.** As put: keep the tiers the lanes set
  provisionally -- the IOC safeguarding paper 1, the ocular paper 3,
  `src_b6292c09e6883927` 3, `src_360144ca30330cbd` 4 -- since changing one
  after the production repair means a new PR and a second production run.
  Recommended keep. **Keep.** This settles what OD-2026-09-29-006 item 3 left
  for Jason.
- **The production queue, P0-P4.** As put, in order: P0 the deletion count
  (item a); P1 the content-import migration (production run 36720671791); P2
  release `main` (deploy staging at `main`'s head, take that run's image
  digest, dispatch `deploy-production`); P3 the research baseline repair -- a
  production dry run that must read PRE_REPAIR with 221 repoint, 213 retire, 65
  retier, 706 metadata and 0 blockers or stop, then the apply with that dry
  run's fingerprint, then verification; P4 the read-only reference-content
  census (#1022) and the storage lifecycle check (M2). Each production step
  needs Jason's approval click in GitHub. Recommended all, in that order.
  **Yes.** State when written (GitHub, 14:52Z): P1 had already succeeded (run
  36720671791, 13:53Z); P0 succeeded (item a); P2's staging deploy succeeded at
  `f597a4a5` (run 36729726639), and `deploy-production` run 36730895578,
  dispatched at `f597a4a5`, was waiting for approval; the P3 production dry run
  succeeded (run 36729679951: PRE_REPAIR, 221, 213, 65 and 706 pending, no
  blockers, the same plan fingerprint as staging's), and its apply was not yet
  dispatched; the P4 census succeeded (run 36729675728), and the storage check
  had not run.

---

## OD-2026-09-30-003 -- The housekeeping thread is overwatch: general contractor, ChatGPT liaison, deployment lead

**Provenance: PRIMARY.** **Date:** 2026-09-30. **Governs:** how the Claude
threads are organised. Jason's words are verbatim; the questions are as the
housekeeping session put them (transcript as in OD-2026-09-30-004). Times UTC.

**Jason's words, verbatim.** In the housekeeping thread, 13:24Z:

> i want this house keep thread to be the leader here in the claude code
> desktop app, i am working on closing out the other threads, your job is to
> keep things tidy, identify new threads to execute the build, when you make
> new threads we need drift guards and scope completeion guards to prevent
> drift and over extensions of thier job, you can recommend what tools and
> connectors to use, when we can we can save usage by giveing a playbutton to
> run the code with a play button in pwershell, what questions do you have

In the content-intake thread, 13:45Z (transcript as in OD-2026-09-29-006,
checked before that session was deleted):

> ok i still need to update it but house keeping will be in charge of
> recommending production because i will have multi lane working

In the housekeeping thread, 13:57Z:

> ok now lets get you set up as over watch, to add on to what i told you
> before, you will be in charge of the actual deployment, when staging is
> ready we can deploy to production, your job will be to identify builds, i
> would venture to guess smaller is better when fighting drife and breaking
> scope but you can educate me on it, chat gpt is still the archetect, this
> thread is the liason so if i need to go and help chat gpt design you let me
> know, this thread is alson the general contarctor in the claude enviroment,
> we will build lanes from here they will update or ask you questions when they
> need guidance, they will inform you when thier scope is complete, you will
> then decide on wheter they will close or continue scope only those two
> options no parking, what questions do you have

The session then put ten questions, G1-G10, each with a recommended option;
they replaced its earlier L1-L8 (13:25Z), which Jason never answered and which
this entry does not decide. **Jason's answer** (14:30Z) changed G4, added to
G8, and took the rest as recommended: *"G4 it can deploy more than once a day
as many times as we need to  G8 also check with chat gpt incase the answer is
already there ( i will be working there outside here) go with you
recomendations"* (the whole message is quoted in OD-2026-09-30-004).

**What this decides.**

1. **The housekeeping thread is overwatch**: it keeps things tidy, identifies
   builds and starts the build threads (lanes) with drift and
   scope-completion guards; it is the general contractor of the Claude
   threads, the liaison to ChatGPT, in charge of deployment, and it recommends
   production. ChatGPT is still the architect.
2. **G1 Production approval.** As put: A, it stays Jason's click in GitHub; B,
   Claude clicks it after Jason opens the approval page in Claude's in-app
   browser and tells it to approve that run; C, remove the required reviewer.
   Recommended A, with B when he is at the desk; not C. **A with B**: Jason's
   click in GitHub stays; Claude clicks only under the in-app-browser rule of
   Jason's L2 rule file, per run, on his instruction at the time. The required
   reviewer stays.
3. **G2 Staging deploys.** Overwatch deploys staging whenever merged work is
   ready, without asking.
4. **G3 "Staging is ready"**, before overwatch recommends production: the
   staging deploy succeeded, the schema check passed, the read-only checks are
   clean (health, sign-in page, SHADOW queue), and every migration the release
   needs is applied in production. Changes to screens for sign-in, minors'
   data or safety also need Jason's own signed-in check on staging.
5. **G4 How often to release.** As put: A, whenever staging is ready and
   something worthwhile is waiting, at most once a day (recommended); B, after
   every merge. **Jason changed it**: *"as many times as we need to"* -- A
   without the daily cap.
6. **G5 Lane size.** One lane = one work item = one PR, with a file allowlist
   and one "done when" sentence; about 400 changed lines or fewer, not
   counting tests, and anything bigger is split before it starts. Lanes
   touching sign-in, permissions, migrations or minors' data run on Opus,
   others on Sonnet.
7. **G6 Close or continue.** When a lane reports its scope complete, overwatch
   decides one of two things -- *"only those two options no parking"*: close
   it, or continue it, and continue only with a next item in the same area and
   files.
8. **G7 Merging.** Only overwatch merges lane PRs, after CI passes and its
   scope check (a script that flags any file outside the lane's allowlist).
9. **G8 Questions from lanes.** As put: overwatch answers technical, how-to and
   scope questions; product intent, design, safety, minors' privacy and
   spending go to Jason. **Jason added**: *"also check with chat gpt incase the
   answer is already there ( i will be working there outside here)"* --
   overwatch first checks ChatGPT for an existing answer.
10. **G9 ChatGPT.** Overwatch relays design questions to ChatGPT through its
    in-app browser when Jason is signed in (the standing relay yes in his L1
    rules), brings the answers back as questions for him, and tells him when a
    design choice needs him: *"this thread is the liason so if i need to go and
    help chat gpt design you let me know"*.
11. **G10 Recording it.** This entry, plus an overwatch section in Jason's L2
    rule file so every lane reads it at start. Written 2026-09-30, outside this
    repository (`~/.claude/rules/ppbf-workspace.md`, "OVERWATCH", read at
    writing). G10 as put named this entry OD-2026-09-30-001; #1039 (merged
    2026-09-30 14:46Z as `7d7992f0`) had already used -001 and -002 for other
    decisions, so this entry is -003 and the answer batch is -004.

**How questions are put to Jason.** Housekeeping thread, 13:08Z: *"explain in
layman terms, in the future i want claude to ask the questions in the official
way then give me layman terms so i can learn as we go"*. Every question to
Jason is written in its official form first, then in plain English. Recorded in
Jason's L1 rule file the same day (`~/.claude/CLAUDE.md`, "QUESTIONS, OFFICIAL
THEN PLAIN", read at writing).

**A fact learned the same day, not a ruling: the release window.**
`deploy-production` accepts only a `confirm_sha` equal to the commit it checked
out, which is `main`'s head when it is dispatched
(`.github/workflows/deploy-production.yml:100`), and only an image built from
that exact commit (:263). So from the staging deploy until production is
dispatched, overwatch asks lanes to hold their merges to `main`. Related ruling:
OD-2026-09-30-001 section 1, a release freezes one SHA and later merges ride the
next one.

**Relation to OD-2026-09-28-001.** Unchanged: Claude Code is the only builder,
ChatGPT the architect and reviewer, Jason owner and final authority. This entry
adds how the Claude threads are organised among themselves.

---

## OD-2026-09-30-002 -- Teaching footage is withdrawn, never deleted; a withdrawal says why; and the teaching loop must be walkable by a coach

**Provenance: PRIMARY.** **Date:** decisions taken 2026-09-28 to 2026-09-30,
recorded 2026-09-30. Quoting Jason directly. Recorded late, and that is the
defect this file exists to stop: until now these three lived only in PR text
(#990, #992, #1018), which is exactly how the drill/cue read policy was lost.

### 1. Unwanted footage is ARCHIVED, not deleted

Jason, on four test videos filmed at a desk: **"delete the test footage"**.
There was no delete path at all -- no DELETE route, `archived` in the status
CHECK constraint with nothing writing it, and no retention job covering
`video_sessions`. Three options were put up; Jason chose: **"1"** -- build an
archive action.

**The rule that came out of it.** Archiving withdraws footage: it stops being
playable, clippable, labellable and countable, and every existing gate already
honoured the status. It is NOT deletion. The row stays, the audit trail stays,
and **the media stays in Azure blob storage**. It is reversible from the same
screen.

Deleting the bytes is a different action with a different risk and was
deliberately not built. Jason was told plainly that the four files are still in
storage; he has not asked for them to be removed. A later session must not read
"archive" as "delete", or quietly add a purge to finish the job.

The four were archived on production through the button on 2026-09-28, not by
SQL, so each carries an audit row and a `video.archived` event.

### 2. A withdrawal records why

Jason, after using it: **"add the reason field"**. Shipped in #992: clicking
Archive opens a reason box on that row, the answer lands on the footage and
shows to whoever later wonders where the take went.

**Optional, deliberately.** A required field on a reversible housekeeping
action is answered with "x" within a week, and the column fills with noise
shaped like data. Blank sends no reason at all rather than an empty string,
because absent and blank are different facts about whether a withdrawal was
ever explained. Restore stays one click -- an undo needs no justification.

The four already archived keep their empty reason. Backfilling would be
inventing a record of a decision as it was not made.

### 3. The teaching loop must be walkable by a coach

Jason: **"build the clip cutter do all if you can or focus on that"**, then
**"build it"** once told what building it would uncover.

**The rule.** Every stage of the loop the Teach Shadow home page describes --
film it, cut it, label it, measure, go again -- has a screen a coach can use. A
stage that exists only as an operator script run by hand against a production
connection string does not count as built. Cutting was that stage until #1018.

What building it uncovered, recorded here because it is the reason the ruling
matters: the labelling screen could not play ANY clip it was allowed to show.
`assertVideoClippable` began requiring a capture take on 2026-09-24
(`95f106e0`); `GET /api/pilot/video/[videoId]` began refusing one on 2026-09-25
(`4982943d`). Each was right and each had a passing suite; neither suite could
see the other, and it shipped to production. Two stages of the loop had
screens and the path between them was broken for four days with everything
green.

## OD-2026-09-30-001 -- Migrate before deploying, and Claude may click the MIGRATION gate on a named run

**Provenance: PRIMARY.** **Date:** 2026-09-30. Taken from the release session
as it happened, quoting Jason directly.

**The release this was decided during.** `main` had not reached production
since `87fe8209` on 2026-09-28, leaving 46 commits undeployed -- including the
archive reason field Jason had asked for on the 28th. Two earlier attempts died
on `main` moving between the staging build and the production dispatch, which
the guard correctly refused both times.

### 1. A release freezes one SHA; later merges ride the next one

Asked as part of a written release workflow, because waiting for `main` to stop
moving was how the backlog reached 46. Jason: **"start"**.

The rule the workflow states, now ratified by use: the release takes `main` as
it stands the moment it begins, and anything merged after that waits for the
next release. Not a compromise -- the alternative is that a release never
leaves.

### 2. Migrations are applied before the deploy that carries them, not attested around

The frozen SHA carried two migration files. `waiver-status-check` was already
applied to both environments (2026-09-29, runs 36619831865 and 36619971360).
`content-import` (#1023) had never been applied anywhere.

Claude refused to type `migrations_complete: CONFIRMED` while that was true,
and put two options to Jason: **A**, apply it to staging and production first,
two extra approvals, attestation then trivially true; **B**, deploy without it
on the ground that no runtime code reads the two tables it creates
(`pilot.reference_content_revisions`, `pilot.universal_stop_rules` -- verified
by search: no `select`/`insert` against either anywhere in `app/`, `src/` or
`scripts/`, because #1023 shipped the schema ahead of the loaders in #1031 and
#1033).

Jason: **"go with you recomendation"** -- option A.

**The rule.** A release does not attest around an unapplied migration, even one
nothing depends on yet. The attestation is a plain fact or it is not made. An
argument that a deploy is *safe* is not the same as the statement
`migrations_complete` actually makes, and the next person to read the release
record should not have to reconstruct the reasoning.

Applied under this decision: staging run 36720503273 (`PILOT CONTENT IMPORT
MIGRATION PASS`, `ppbf-pg-staging-7k4m2q`/`ppbf_staging`), then production run
36720671791 (same PASS line, `ppbf-pg-195892`/`postgres`). Both environments
hold it.

### 3. Claude may perform the reviewer click on a NAMED migration run

Jason: **"i give you permission to click in the git hub to migrate"**, with
production migration run 36720671791 open in Claude's in-app browser and
waiting at the `production` environment gate.

**What this permits.** The reviewer approval on that one run, that one
environment, for the migration named in it. Claude approved it through the
pending-deployments API as `PunxsyProminence` -- the same account and the same
recorded action as the browser click -- with the authorizing quote in the
approval comment.

**What it does NOT permit, and this is the whole point of writing it down:**

- It is not standing production approval. The next migration needs Jason
  again.
- It does not extend to the DEPLOY gate. Jason said *"to migrate"*, and the
  deploy is a separate run with a separate click that stayed his.
- It does not survive this run. A later session reading this must treat it as
  history, not as a permission it holds.

**One deviation from the standing rule, recorded rather than smoothed over.**
`~/.claude/rules/ppbf-workspace.md` conditions this on Jason having
*personally opened* the approval page. Claude opened it, on Jason's
instruction, in Jason's authenticated session; Jason then gave the per-run
instruction. The load-bearing condition -- a contemporaneous instruction naming
this run -- was met. The wording of that rule should be corrected to say what it
protects rather than who moved the mouse.

### 4. Not decided: one click for migrate-and-deploy

Jason asked whether the two could ride under a single approval. Claude's answer,
for the record: buildable as one workflow with ONE job (two jobs each naming a
protected environment would pause twice and gain nothing), still needing the
staging build first because `deploy-production` requires the image digest.
The cost is that the approval then happens before the migration has run, so a
half-failed migration would be met by a deploy nobody was watching.
Recommendation given: build it with the migration step failing the whole run on
anything but a clean PASS. **No decision taken.** It is on the build list.
## OD-2026-09-29-006 -- Research baseline repair: the repo patch by PR, production by a pinned tool, archive not reject, tiers by the spec

**Provenance: PRIMARY**, except item 3: text the algorithm lane wrote and Jason
pasted, recorded as relayed, not as his words. **Date:** 2026-09-29. Recorded
2026-09-30 from the content-intake session's hand-off; each quote was checked
that day against that session's transcript
(`~/.claude/projects/C--Dev/3a86c2fd-c456-4b4d-8502-da243d4c17b1.jsonl`,
outside this repository; deleted with the session at 14:49Z). Times UTC.

1. **The hand-off.** At 17:24Z Jason attached
   `CLAUDE_CODE_HANDOFF_research_repair.md`; at 18:30Z he added the lane's SQL,
   a patch, the repair log and the tier-conflict list. The hand-off's Part 1,
   the repo patch, went in as a PR (#1008); its Part 2, production, waits for
   his yes on each run.
2. 17:38Z: *"what failed, and does it affect the research-repair branch? if it
   doesnt then auto merge"* (his message begins with a stray `"`). Decided:
   auto-merge the research-repair PR if the failure did not affect it. #1008
   merged at 18:49Z as `929f9c62`.
3. **Relayed**, written by the algorithm lane and pasted by Jason at 19:01Z:
   - Q1 *"Build the production repair tool: yes. Use the repair log as the
     pinned plan exactly as you validated it"*. Built as #1030 (`f57e804d`).
   - Q2 *"Retire method: archived"* and *"Keep approval_state untouched"*.
     Duplicate sources are retired with `status = 'archived'`.
   - Q3 *"Tiers: set them by the spec"*. Tiers follow
     `apps/web/seed-data/shadow-research/2026-08-07/EVIDENCE_TIER_SPEC.md`
     section 3; shipped in #1029 (`19307001`). Left for Jason: the IOC
     safeguarding paper and the ocular paper (named in the relay);
     `apps/web/seed-data/shadow-research/2026-08-07/repairs/README.md` marks
     `src_00c5cf14f2692175`, `src_9b44730ebb92f513` and
     `src_b6292c09e6883927` provisional. Kept as set on 2026-09-30
     (OD-2026-09-30-004 T1).
   - Q4 *"Do the follow-ups: yes, but with this constraint first."* The
     constraint: confirm the tier distribution after the correction before
     pinning new counts. Q4 also claimed that runtime reads the tier from chunk
     metadata; the lane withdrew that in a correction pasted at 19:06Z:
     runtime reads the source row.
4. 19:27Z, Jason's own words: *"1 and 2 are ok"*, approving the two points of
   the session's 19:06:24Z message. (1) The original SQL failed on
   `shadow_library_sources_review_pair_check`
   (`infra/azure/pilot_slice_postgres_shadow_evidence_migration.sql:51-66`),
   which refuses a row that is not approved but keeps its approval and
   verification stamps -- not on the allowed-values rule. The answer stays
   `archived`. (2) `verify-evidence-tier-corpus` grades each claim on its
   source row's tier, as runtime does, and new counts are pinned only after
   the corrected distribution is confirmed.

Status (2026-09-30): staging is repaired -- dry run 36721260945 (PRE_REPAIR;
221, 213, 65 and 706 pending; no blockers), apply 36722378826, confirming dry
run 36722550670 (REPAIRED). Production dry run 36729679951 (2026-09-30 14:40Z):
PRE_REPAIR, the same four counts, no blockers, and the same plan fingerprint as
staging's. The production apply had not been dispatched when this was written.

---

## OD-2026-09-29-005 -- Content intake: how gym material comes in, how revisions load, stop rules, scope, merging

**Provenance: PRIMARY.** **Date:** 2026-09-29. Recorded 2026-09-30 from the
content-intake session's hand-off; each quote was checked against that
session's transcript (as in OD-2026-09-29-006). R1-R4 were one question box,
asked 15:27Z and answered 15:38Z; the options are as put, and Jason typed his
own answer to each. Times UTC.

1. **Where it started** (a work request, not a ruling), 14:17Z: *"i want you
   to find all artifacts atifacts, we need to check our seeds for redudebtcey
   dubluicates and boiler plate issues"*.
2. 15:26Z: *"ok i will work on the material i.e. seed data research ect in
   another account, lets fix the infrastucture for it and build/fix a propper
   place to brining it into, ask questions if you need more guidance"*.
   Decided: Jason writes the material elsewhere; Claude builds the intake and
   the place it loads into.
3. **R1.** Asked: *"How should the material from your other account get into
   the app's pipeline?"* Options: 1, a drop folder Claude brings it in from
   (recommended); 2, an in-app upload screen; 3, hand files to Claude in chat.
   **Jason:** *"for seeding it will be 3 for future work it will be 2"*.
   Decided: seeding now means files handed to Claude in a session, validated,
   merged by PR and loaded by the `seed-reference-data` workflow; later loads
   go through an in-app upload screen. The drop folder was not chosen. Built:
   #1024; the upload screen in #1031 (`07010d65`); the seed path in #1038
   (`f597a4a5`), which replaced #1033 (closed unmerged).
4. **R2.** Asked: *"When improved content arrives for a drill or template
   that's already loaded, what should happen?"* Options: 1, new version, old
   kept (recommended); 2, overwrite in place; 3, replace the whole library; 4,
   skip (today's behaviour). **Jason:** *"1 an d new stuff gets added if there
   is nothing to update"*. Decided: a revision becomes a new version and the
   old one is kept as history; material with nothing to update is added as
   new. R2 did NOT decide this: #1031 updates disciplines, competence levels
   and cohort definitions in place, keeping the before and after rows in
   `pilot.reference_content_revisions`. Jason was not asked (an open question
   in `docs/current/ACTIVE_WORK.md`).
5. **R3.** Asked: *"The universal 'stop when…' rules are currently copied onto
   every drill (658 of 674 rows). How should they be stored?"* Options: 1,
   store once, apply to all (recommended); 2, keep them per drill. **Jason:**
   *"every drill is different so the rules would vary,  obviously injury of
   some sort would require stoppage universally"*. Decided (INFERRED; he
   answered in his own words rather than picking an option): each drill
   carries its own stop rules, and an injury stop applies to every drill.
   Built: `pilot.universal_stop_rules` (#1023) holds rules stored once, and the
   copied legacy lines show as each drill's own rules (#1032). Not yet
   supplied: the wording of the universal rule; no file is committed
   (`.github/workflows/seed-reference-data.yml:65` at `f597a4a5`).
6. **R4** (several could be picked). Asked: *"Which material should the new
   intake cover in this build?"* Options: drills and workout templates;
   session scripts, cohorts, disciplines; the research corpus (Shadow
   library); transfer claims. **Jason:** *"all, types, in another thread we
   were woking the teaching the punch recognition to the AI/ML (machine not
   ethlete human)  these would all end up working togethere in the end"*.
   Decided: all four types, and they must end up working with the
   punch-recognition work. Delivered: drills, templates, scripts, disciplines,
   competence levels, cohorts and universal stop rules (#1031, #1038). Not
   delivered: the research corpus (IMP-11/16/17, parked); transfer claims,
   which the import core refuses by name (`datasetsFor`,
   `apps/web/src/server/pilot/contentImport/cli.ts:244-260`); and assessment
   protocols, which have a spec and no loader
   (`apps/web/src/server/pilot/contentImport/datasets/index.ts:16-18`). That
   is a gap against R4; Jason has not approved narrowing it.
7. 16:00Z: *"go ahead and build it when the plan is ready"*. Decided: build
   without waiting for plan approval. The session's reply at 16:00:15Z set the
   limit: merging, migrations and staging or production seeding each still
   wait for his word.
8. Offered at 16:57Z (say "merge when green" and each PR merges once CI
   passes); 17:29Z: *"merge when green"*. Decided: that session's PRs merge by
   GitHub auto-merge (squash) once the required checks, `validate` and
   `declaration`, pass. A merge applies no migration and touches no
   environment.
9. **The seeder rule.** Stated in that session's task brief (14:02Z), not in
   Jason's words there: *"Gym content is seeded as an organization_admin of
   punxsy_prominence (ppbf@punxsyprominence.org), never the platform_owner
   Admin@ account"*. The brief cited OD-2026-09-28-005 and -007; neither says
   it. #1031 enforces it (`assertImportActor`,
   `apps/web/src/server/pilot/contentImport/actor.ts`). **Jason confirmed it as
   his ruling on 2026-09-30** (OD-2026-09-30-004 H2).

Not decisions: the defaults and the questions in the session's 16:57Z report.
Jason has not answered them; they are open questions in
`docs/current/ACTIVE_WORK.md`.

---

## OD-2026-09-29-004 -- Second "all recommended" and the P answers: research coverage, gap tickets, seat counts, guardian logins, the stale deploy, coaches and birth dates, guardian waivers, the waiver rule

**Provenance: PRIMARY.** **Date:** 2026-09-29. Two sets of questions from the
Claude session, each with options and one marked recommended; what each asked
is as that session summarized it. **Jason's answers, verbatim:** to R1-R5,
*"all recommended"*; to P1-P4, *"P2 B the rest your recomendation"*.

- **R1 Research coverage and the shared shelf.** Coverage counted only
  servable evidence from the gym's own shelf, while search also serves the
  shared platform shelf. A, count the shared shelf too (recommended); B, the
  gym's own shelf only. **A.**
- **R2 Gap tickets.** Should the coverage check close its own gap tickets once
  a topic becomes covered? A, yes (recommended); B, a person closes them. **A.**
- **R3 Seat counts.** Families see the true number of seats taken (a number
  only, no names). A, keep the number (recommended); B, only Open or Full.
  **A.**
- **R4 A parent changing their email.** Intake now refuses to move a guardian
  record to another login. A, add a deliberate "move guardian to a new login"
  admin action to the build list (recommended); B, never allow it. **A**
  (build list; not built).
- **R5 Accidental role change.** If the intake form names an existing coach or
  staff account as a guardian, intake turned that account into a parent
  account. A, intake refuses it (recommended); B, leave it. **A.**
- **P1 A production deploy waiting since 2026-09-28** (run 36437627933, commit
  `45e27881`, older than that day's work). A, reject it and prepare a fresh
  release (recommended); B, leave it waiting. **A**: the run was cancelled on
  2026-09-29.
- **P2 Coaches and birth dates.** Coaches, including a covering coach, can
  change a child's birth date through the server; no coach screen offers it.
  A, coaches cannot, only admins (recommended); B, coaches keep it. **B**:
  coaches keep it. Only the athlete's own change is refused (item 2 of
  OD-2026-09-29-003).
- **P3 Guardian waivers on the parent page.** In production every waiver row
  is `program_consent`, which the page does not list, so every child reads
  Missing on the four tracked waivers. A, show them with a line saying what
  Missing means (recommended); B, hide the section until real waivers exist.
  **A.**
- **P4 The waiver status rule** (a database CHECK). A, go ahead: staging
  first, then production with Jason's approval in GitHub (recommended); B,
  hold it. **A.**

Also recorded here, answered earlier the same day and not yet in this file:

- **Install the new ChatGPT instructions** (the "More about you" workspace
  facts and the "PPBF — App Build Review" project's architect and reviewer
  instructions). **Jason:** *"A and yes turn on auto fix"*. Installed: Jason
  saved both in ChatGPT, and later the WRITES-audit line (OD-2026-09-29-003
  item 8); each was read back after a reload. The texts live outside this
  repository.
- **Make `declaration` a required check on `main`** (decided in
  OD-2026-09-28-010 item 11). **Jason:** *"A also ask me the rest of the
  questions, I am on a remote tablet so after I answer the questions you will
  execute the tasks that dont require a physical click from me"*. Done
  2026-09-29: required checks on `main` are `validate` and `declaration`;
  admin enforcement stays off.

---

## OD-2026-09-29-003 -- "all recommended": the missing documents, athletes' birth dates, the waiver CHECK, guardian waiver statuses, the 20% floor, school grades, the Floor Card, the WRITES audit, deleted accounts at sign-in

**Provenance: PRIMARY.** **Date:** 2026-09-29. The Claude session put nine
questions to Jason, each with options and one marked recommended. **Jason's
answer, verbatim:** *"all recommended"*. That picks the recommended option in
every question. What each asked, and which option was recommended, is as that
session summarized it (the full question text is not in this repository).
Line numbers are at `108938f4`.

1. **The two missing 2026-08-22 owner documents** (OD-2026-09-29-002 item
   9b). As put: A, check Jason's ChatGPT history (recommended); B, call them
   lost; C, A then B. **A**: Jason's ChatGPT history is searched next; the
   documents are not declared lost.
2. **Athletes changing their own record.** As put: athletes can change their
   own birth date, name and weight class through the server (no screen offers
   it); a birth date change matters because a 14-year-old who sets an adult
   date switches off the minor photo rules. A, lock birth date for athletes,
   admins keep it (recommended); B, lock all three for athletes; C, leave as
   is. **A**: the server refuses an athlete's change to their own date of
   birth; organization admins can still change it; athletes can still change
   name and weight class. Build item. Coaches can change it today
   (`apps/web/app/api/pilot/athletes/update/route.ts:43`;
   `apps/web/src/server/pilot/access.ts:590-592` refuses a coach only a
   `coach_id` change), including a coach covering on a temporary grant
   (:117-130); the question did not cover them. Whether coaches keep it is an
   open owner question in `docs/current/ACTIVE_WORK.md`, to be answered
   before this build ships.
3. **A CHECK on waiver statuses** (OD-2026-08-29-008). As put: all 11
   production waivers are clean; A, add the strict database rule now, a small
   change (recommended); B, leave it. **A**: add a CHECK constraint on
   `pilot.waivers.status`. Build item. Its migration is applied only through
   the `apply-migrations` workflow, production with Jason's approval. "Clean"
   covers status values only: all 11 rows are type `program_consent`
   (OD-2026-09-29-002 item 8a), which in this repository only the gate script
   writes (`apps/web/scripts/pilot-shadow-intake-gate.mjs:698`, signer "Gate
   Guardian"), so they are likely gate-test rows, not real guardians'
   signatures (INFERRED).
4. **Guardian waiver statuses.** As put: guardian waiver statuses already
   reach the parent safety page's data but are not shown. A, show them
   (recommended); B, leave hidden. **A**: the parent safety page shows them.
   Build item. Not raised in the question: the page's data carries only the
   four tracked types (`apps/web/src/server/pilot/waiverCompliance.ts:20`;
   `apps/web/app/api/pilot/parent/safety/route.ts:91-102`), read by exact
   type (`waiverCompliance.ts:134-145`), and production's rows are all
   `program_consent`, which nothing maps to them. Shown as it comes back
   today, every child would read missing on all four (INFERRED). The build
   asks Jason how `program_consent` maps, or what guardians should see, and
   shows him the page's wording before it ships.
5. **The 20% floor.** As put: should "covered" require at least 20%
   boxing-specific evidence? A, yes, enforce; B, no, count sources as now
   (recommended for now). **B**: no floor is enforced; "covered" keeps
   counting sources as it does today. Nothing to build. "For now" was part of
   the recommendation, so the question may come back.
6. **School grades.** As put: should school grades ever block training? An
   old description claims the app does this; nothing enforces it. A, no, and
   delete that claim (recommended); B, yes, build it. **A**: school grades do
   not block training, and the claim goes. Done in the change that records
   this entry. The Collegiate Track's description
   (`apps/web/components/trackAssignments.ts:72`, *"Enforces academic passing
   standards as a requirement for on-floor training access"*) now says the
   track reads no grades and gates nothing: a track is a label an admin puts
   on an athlete profile at `/admin`, saved per organization in
   `pilot.admin_track_assignments`, and its description is shown nowhere.
   Three athlete help lines that assumed an academic status or hold were
   copies of the same claim and are removed: *"Assuming academic status is
   still current"*, *"Check your academic status first"* and *"Booking while
   on academic hold"* (`apps/web/components/AthleteWorkspace.tsx:2291`,
   :3364, :3376). No other file claims grades gate training (`git grep -i
   academic`, 2026-09-29): the other hits are the goal category "Academics",
   homepage copy about mentoring, research citations in seed data, and one
   item in the Collegiate Track's focus workout, which nothing renders
   (*"Mandatory 30-minute academic study or homework block"*, :77); it does
   not gate training and is unchanged.
7. **The Floor Card idea** (OD-2026-09-29-002 item 4, QB). As put: a
   personal space per user; extras unlock by real accomplishments, no points
   or rankings; saved in `docs/archive/2026-09-29_branch-salvage/`. A, add it
   to the build list as an idea (recommended); B, archive only. **A**: an
   Ideas row in `docs/current/ACTIVE_WORK.md`. The name needs a decision
   later: `PRODUCT_CAPABILITIES.json` already uses "Individual Floor Card"
   for the card that puts a training plan on the floor (CAP-Q-017, :9200-9201;
   *"Floor Cards should operationalize the plan"*, :832).
8. **The WRITES audit.** As put: add the WRITES audit back to ChatGPT's
   project instructions. **A**: add it. That change is made in ChatGPT by the
   Claude session, outside this repository; it is not verified here.
9. **Deleted accounts at sign-in.** As put: after a deletion an admin can
   still reopen the login. A, one central rule: sign-in refuses any account
   marked deleted (recommended); B, block each path; C, leave. **A**. Build
   item, built separately after the auth bug fixes in progress on 2026-09-29
   land. The paths that reopen a deleted login are listed in
   `docs/DATA_RETENTION.md`, "Open gap" (:141-149): a new activation code, an
   athlete PIN reset or account creation (`apps/web/src/server/pilot/activation.ts`),
   re-inviting a deleted guardian's email (`createOrUpdateMicrosoftStaffAccount`,
   `apps/web/src/server/pilot/staffProvisioning.ts`), and the platform
   owner's `setAccountActiveStatus` and `upsertOrganizationMembership`
   (`apps/web/src/server/pilot/auth.ts:1170`, :1199); none of those files
   reads `deleted_at` (`git grep`, 2026-09-29). The `/admin/data-deletion`
   screen (#1000) cancels outstanding activation codes when it deletes
   (`apps/web/src/server/pilot/dataDeletion.ts:61`); it does not close those
   paths.

---

## OD-2026-09-29-002 -- The other answers of 2026-09-29: branches, PR #941, two production checks, untried modules, the roster door, athlete deletion, the tracker check

**Provenance: PRIMARY.** **Date:** 2026-09-29. Jason answered a numbered list
of questions from the Claude session in short replies. His words are verbatim;
what each item asked is as that session summarized it (the full question text
is not in this repository). His messages, verbatim, in order: *"3 A 4 A 5 A
6 B7A8A 9 explain this one better 10 C 11  explain more"*; *"9a. B 9b. B 9c.
B9d. B 11A"*; *"1A 2A 3B"*; *"QA A, QB A i have 45 mins before weekly reset
dont worry about usage get as much done as possible"*. Line numbers cited
below are at `91de82ca`.

3. **Dependabot PR #965** (`tsx` 4.23.13 to 4.23.15). *"3 A"*: merge it. Done:
   merged as `91de82ca`.
4. **Leftover GitHub branches.** *"4 A"*: compare each with `main`, delete the
   ones whose changes are already in `main`, keep the `archive/` and `rescue/`
   branches, and list for Jason any with real unique work. In progress. All 95
   remote refs (`main` included) were first backed up to a local git bundle,
   `Documents/PPBF-local-backups/github-branches-2026-09-29/all-remote-branches.bundle`
   (`git bundle list-heads` lists 95). How many are deleted is not recorded
   here; read it live (`git ls-remote --heads origin`).
   Follow-up answers, *"QA A, QB A"*: QA -- delete the branches the audit
   judged replaced or abandoned (all are in the bundle); QB -- for the ones
   holding real unmerged work, check each against `main`, put live bugs on
   the build list, save ideas and docs (the SHADOW design package to the
   archive, the "Floor Card" idea as a row), then delete those branches.
5. **PR #941** (the coach drill library redone as a drill cabinet). *"5 A"*:
   check it against `main`; close it if `main` already has what it adds,
   otherwise tell Jason what is missing. In progress.
6. **Red.** *"6 B"*: see OD-2026-09-29-001.
7. **Stale lines in Jason's rule files.** *"7A"*: fix them. Done, as reported
   by the session that asked; those files are outside this repository.
8. **Two read-only production checks.** *"8A"*: run them. Run 2026-09-29;
   reported by the session that ran them, output not reproduced here.
   - (a) Waiver statuses (`npm run pilot:check-waiver-statuses`,
     OD-2026-08-29-008): `pilot.waivers` holds 11 rows, every one exactly
     `signed` (waiver type `program_consent`); a byte-exact CHECK over
     `signed`, `declined`, `withdrawn` and `missing` (the script's
     `WAIVER_STATUSES`, `apps/web/scripts/pilot-check-waiver-statuses.mjs:119`)
     would refuse 0 rows; no CHECK constraint exists. Whether to add one now
     is a new owner question.
   - (b) The Shadow library: the only `doctrine_kind` in production is
     `shadow-authority-model` (1 source, tier 1, under `ppbf-default-org`,
     "SHADOW Canonical Authority Model"). `shadow-event-model` is not there, so
     editing `docs/SHADOW_EVENT_MODEL.md` re-approves no stored copy: the next
     seed registers it as `pending_review`, and it is approved at `/evidence`
     before SHADOW reads it (`apps/web/scripts/shadow-library-seed-manifest.json:2`,
     :19-20). Library totals: `__platform__` 1,194 sources;
     `ppbf-default-org` 22 `internal_policy` sources (1 tier 1, 21 tier 3).
9. Four open questions from `docs/current/ACTIVE_WORK.md`.
   - (a) **DONE modules nobody has tried.** As put: list the 36 DONE modules
     that *"have no ManualVerification record and rest only on the blanket
     2026-08-28 sign-off"*, each with a one-line "how to try it", so Jason or a
     coach can check it on the tablet; until checked, each is labelled "built,
     not yet tried by a person". *"9a. B"*: do that.
     Two parts of that were wrong. These modules carry no sign-off at all: the
     blanket sign-off covered only modules that then carried
     `PENDING_SIGN_OFF` (`docs/current/SIGN_OFF_GUIDE.md:8-10`; module 003's
     audit log, 2026-09-28). And 36 is the count inside that guide. DONE with
     no ManualVerification row matched 47 module files at `91de82ca`: the 36
     plus 3, 11, 53, 75, 76, 121, 123, 125, 127, 128 and 129, which the guide
     does not cover. Module 084 joined them when it was marked DONE under
     item 11. The list written on 2026-09-29,
     `docs/capabilities/SIGN_OFF_WALKTHROUGH.md`, covers all 48. Taking in the
     12 beyond the 36 was Claude's call; Jason has not been asked.
   - (b) **The two missing 2026-08-22 owner documents**
     (`PPBF_OWNER_DECISION_IDENTITY_ACCESS_GOVERNANCE_MULTI_ORG_2026-08-22.md`,
     `PPBF_OWNER_PRODUCT_DIRECTION_v2_2026-08-22.md`). *"9b. B"*: search every
     OneDrive, Google Drive and SharePoint folder for them, read-only. In
     progress.
   - (c) **The button-size collision**
     (`apps/web/scripts/css-layer-collisions.mjs` reports 101 collisions;
     `.btn` in 23 places may render at 44px instead of 55px, unconfirmed).
     *"9c. B"*: parked until the look-board redesign (OD-2026-09-28-012).
   - (d) **The `/admin/import` door.** *"9d. B"*: organization admins and
     coaches get the door, which also means opening the import page and its
     API to coaches. Today both admit organization admins only
     (`apps/web/app/api/pilot/admin/roster-import/route.ts:39`;
     `apps/web/app/admin/import/page.tsx:249-253`). Build item.
     Asked next: when a coach loads a roster, whose athletes are they? A, the
     coach's own; B, any active coach in the same gym, checked against that
     gym, like an admin. *"3B"*: B.
10. **When a gym deletes an athlete.** *"10 C"*: A now -- the athlete's record
    is marked deleted, their login stops and their signed-in sessions end;
    videos, photos and notes stay on file -- then B right after: everything
    tied to the athlete is marked deleted at the same moment. (Correction
    given to Jason the same day: the question said the nightly cleanup removes
    the record after 2 years. It does not: the scheduled cleanup is a dry run,
    permanent removal happens only when someone dispatches retention-cleanup
    with APPLY, the window is 2 years for athlete rows and 1 year for guardian
    accounts, and whether stored video and photo files are erased is
    UNVERIFIED -- `docs/DATA_RETENTION.md:71-81`,
    `.github/workflows/retention-cleanup.yml`.) Asked next: deleting someone
    already deleted restarts their clock -- A, the server refuses it; B, ship
    as is; and should the result count the sessions ended -- A, no count; B,
    add it. *"1A 2A"*: the server refuses a second deletion; no count. Build items; they set the scope of the
    `/admin/data-deletion` screen (OD-2026-09-28-008, OD-2026-09-28-011 item
    11).
11. **The capability tracker check.** *"11A"*: remove the check that compares
    the module files with the old index, `expanded-200-index.json` (history
    under OD-2026-09-28-010 item 17) -- the tracker-disagreement ceiling,
    `apps/web/src/docs/capabilityEvidence.test.ts:180-199` -- and keep the
    checks that DONE modules cite code. Module 084 (guardian safety report;
    tested by `apps/web/app/api/pilot/parent/safety/route.test.ts` and
    `apps/web/app/parent/safety/page.test.tsx`) may then be marked DONE.
    Module 094 stays DRAFT: it has no behaviour test.

Status (2026-09-29): answered further by OD-2026-09-29-003 (*"all
recommended"*). Item 8a's new question: add the CHECK now (Q3 A; a build row).
Item 9b: Jason's ChatGPT history is searched next, and the documents are not
declared lost (Q1 A). Item 4, QB: the Floor Card idea is an Ideas row in
`docs/current/ACTIVE_WORK.md` (Q7 A). Item 10: sign-in is to refuse any
account marked deleted, one central rule, built after the auth bug fixes land
(Q9 A; a build row).

---

## OD-2026-09-29-001 -- Red is not reserved; `--locked` still means a medical stop

**Provenance: PRIMARY.** **Date:** 2026-09-29. Jason's words are verbatim; the
question is as the Claude session summarized it (its full wording is not in
this repository).

**Asked.** Whether red stays reserved. As put, in part: *"Red means danger.
Right now only safety warnings may use red"*; option B, *"Red is free to use.
The test goes and the rule changes."* **Jason's answer, verbatim:** *"6 B"*.

This confirms what he said on 2026-09-24, *"delete red no need for it to be
excluded"*, quoted in commit `d2621ddb` (branch `local/coach-floor-board`) and
never recorded here.

**What this decides.** Red, `#A81E22` included, is free to use. What changed:
`apps/web/src/design/safeguardingRedReservation.test.ts` is deleted, and its
entries leave `apps/web/src/testing/safetyCriticalSuites.json` and
`apps/web/src/testing/suiteAttendance.test.ts` (commit `d2621ddb`,
cherry-picked 2026-09-29). What did not: `--locked` still exists, still
resolves to `#A81E22` (`design-system/current/ppbf-golden-era.css:76` at
`91de82ca`), and still means a medical stop (MEDICALLY_NOT_ALLOWED). The
refusal stamps still draw MEDICALLY_NOT_ALLOWED as their one red mark
(`apps/web/components/RefusalStamp.tsx:10-17`), and
`apps/web/components/refusalStamp.test.tsx` ("MEDICALLY NOT ALLOWED is the one
red mark", :52) still checks it; `d2621ddb` touches neither.

Law 2 (OD-2026-09-28-009 item 1, saturated colour means safety or status)
still stands, except that red is no longer reserved. At `91de82ca` its text in
`design-system/README.md:60-61` still named red; the same change that records
this entry corrects it. Browser checks that still refuse the old red on some
pages (`apps/web/e2e/public-homepage.spec.ts`,
`apps/web/e2e/golden-era-scope-proofs.spec.ts`, the `goldenEra*Scope` tests)
enforce the retired hue ban and are a build row in `docs/current/ACTIVE_WORK.md`
to retire; the `--locked` token checks stay.

**Supersedes** the 2026-08-19 reservation of that red for MEDICALLY_NOT_ALLOWED
alone, and the owner's 2026-08-24 approval of its guard (*"go option 2"*).
Neither has an entry here. The 2026-08-24 approval was recorded only in the
deleted test's header (at `91de82ca`, line 17). The 2026-08-19 reservation
was stated there too (line 9), and at `91de82ca` it is also restated in
`apps/web/components/RefusalStamp.tsx:10-17`,
`apps/web/components/CoachWorkspace.tsx:790`,
`apps/web/components/SignInPanel.tsx:53` and :416,
`apps/web/components/SignInPanel.test.tsx:199`,
`apps/web/app/auth/link/page.tsx:103`,
`apps/web/src/design/readinessRungPolicy.test.ts:11`,
`apps/web/src/design/safetySemanticsSurviveTheThemeSwap.test.ts:34`,
`design-system/legacy/ppbf-leather-brass.css:1919`,
`docs/VISUAL-RESET-PHASE-1-PLAN.md:319` and `docs/GROK-APP-BUILD-MAP.md:70`
and :691. This entry does not correct those lines.

---

## OD-2026-09-28-014 -- Panels may be aged paper, dark glass, or both, each where it fits

**Provenance: PRIMARY.** **Date:** 2026-09-28. Jason's words are verbatim; the
question is as the Claude session summarized it (its exact wording is not in
this repository).

**Asked.** Which panel material the merged look (OD-2026-09-28-012) uses: aged
paper, or dark glass -- the dark translucent dashboard panels over the real gym
in Jason's Grok board. **Jason's answer, verbatim:** *"its can use all types
where appropriate"*.

**What this decides.** Panels may use aged paper, dark glass, or both, each
where it fits. This is owner approval of dark glass as a material.
`docs/GOLDEN-ERA-V1-CONTRACT.md` at `10da14c9` lists seven core materials, none
of them glass, and admits "No new invented materials without owner approval";
this entry is that approval.

---

## OD-2026-09-28-013 -- The ring canvas keeps its IRON CITY lettering in plates

**Provenance: PRIMARY.** **Date:** 2026-09-28. Jason's words are verbatim; the
question is as the Claude session summarized it.

**Asked.** Whether the IRON CITY lettering on the ring canvas (the canvas reads
IRON CITY BREWERY, `docs/REAL-GYM-REFERENCE-LOCK.md` section 1) should be kept
out of plates and backgrounds, as the zero-lettering rule requires -- the lock's
"Zero lettering on the plate itself (UI text lives in code)" and
`docs/GOLDEN-ERA-V1-CONTRACT.md` section 9, both at `10da14c9`. **Jason's
answer, verbatim:** *"no i like that you can leave it"*.

**What this decides.** The ring canvas's IRON CITY lettering stays in plates
and backgrounds. It is an exception to the zero-lettering rule for that
lettering only; UI text still lives in code. Where the lock, the Golden Era
contract, `apps/web/public/plates/README.md` or the no-text prompt in
`scripts/make-plate.mjs` say otherwise, this entry governs until they are
corrected.

---

## OD-2026-09-28-012 -- One merged look: the real gym in the early gritty style, starting with a look board built around The Floor

**Provenance: PRIMARY.** **Date:** 2026-09-28. Jason's words and the option
headings are verbatim, checked character for character against the Claude
session's transcript (2026-09-28, 18:31-18:44 UTC); the gloss after each
heading is summarized.

**The early look.** Jason's early "LOOKS AND FEELS" set -- the Canva folder
"PPBF LOOKS AND FEELS" (found through the Canva connector, 2026-09-28), with
the same images in his Grok library as the session saw it -- is a dark, gritty
style: dark iron, aged tan paper, brass, old oxidized-blood stains, gauze and
tape. Describing it, he said: *"it had blood
stains guaze the  the logos and things will need to be updated thos were kinda
mock ups"*.

**How it relates to the real gym.** Put to him: A, *"Real gym, drawn in this
look (recommended)"*; B, *"This look replaces the real-gym rules"*; C, *"Split:
screens take this look, backgrounds stay real"*. **Jason's answer, verbatim:**
*"these were early work too, yes we can work the gym look into it the UI and
these images do have some of the gym feel, i never got the two merged"*.

What this decides: the two looks merge. The real gym
(`docs/REAL-GYM-REFERENCE-LOCK.md`) is drawn in the early gritty style, for
both screens and images. The early set's logos were mock-ups, not the brand.

**Where to start.** Put to him: A, *"A look board first (recommended)"* -- one
page that fixes the merged style (colours, textures, fonts, one sample room
background drawn from the real gym, one sample panel) before any screen
changes, and every room then follows it; B, *"Pilot on The Bell (the sign-in
screen)"*; C, *"Start with The Floor"*. **Jason's answer, verbatim:** *"kinda a
cross between a and c"*.

What this decides: a look board built around The Floor. Its samples are The
Floor's own background and one Floor panel. `docs/ROOM-MAP.md` stays the
build order (OD-2026-09-28-009 item 3).

---

## OD-2026-09-28-011 -- Operations answers: the policy shelf move, the Companion check, placeholders, end-of-build items, and two admin screens

**Provenance: PRIMARY.** **Date:** 2026-09-28. Jason answered a numbered list
of follow-up questions from the documentation clean-up in one message. His
words for each item are verbatim; what each item asked is as the Claude session
summarized it (the full question text is not in this repository).

6. **Move the misfiled policy shelf.** *"6yes"*. The 22 approved
   `internal_policy` library sources (7 documents, 49 chunks) found under
   `ppbf-default-org` (OD-2026-09-28-007) move to `punxsy_prominence` in
   production. This is not the same set as the `ppbf_policy` import scope,
   which asserts 21 sources, 6 documents and 20 chunks
   (`apps/web/scripts/import-shadow-research.mjs:200-202`); the move tool
   selects the production rows, not the scope. No tool makes that move today
   (`apps/web/scripts/pilot-rescope-library-baseline.mjs` moves a corpus onto
   the platform baseline only), so one is built first, and Jason approves the
   production run in GitHub. (Claude's plan, not part of the answer: a dry run
   before any production run.)
7. **The retired Technical Companion.** *"7 yes"*, to a read-only production
   check of whether `docs/SHADOW_AI_TECHNICAL_COMPANION.md` is in the Shadow
   library (OD-2026-09-28-010 items 8 and 23). The check was run on 2026-09-28:
   it is not in the library, so there is nothing to remove. (Reported by the
   session that ran the query; the query and its output are not reproduced
   here.)
8. **Placeholder people.** *"8 those are place holder and can be removed or
   left for later"*. The 22 athletes and 15 parents under `ppbf-default-org`
   are placeholders; they may be removed, or left for later. (Counts as put
   to him; not re-counted for this entry.)
9. **PIN rotation.** *"9 we will do that after the whole app is built"*.
   `PILOT_ADMIN_PIN` and `PILOT_SHADOW_ATHLETE_PIN` are rotated at the end of
   the build (OD-2026-09-28-004).
10. **Public repository and licensed extracts.** *"10 keep as is well do that
    at the end aswell"*. The repository stays public and the licensed extracts
    stay where they are until the end of the build (OD-2026-09-28-004).
11. **Deletion screen and roster-import door.** *"11 build ask questions if you
    need to"*. Build the `/admin/data-deletion` screen (OD-2026-09-28-008,
    "c") and a building-map door for `/admin/import` (OD-2026-09-28-010 item
    26). Open questions on either go to Jason before they are built.

Status (2026-09-29): item 11's questions are answered (OD-2026-09-29-002).
Deletion scope, *"10 C"*: A now, then B right after. The `/admin/import` door
goes to organization admins and coaches, and the import page and API open to
coaches, *"9d. B"*.

---

## OD-2026-09-28-010 -- Capability tracker, SHADOW spec, and process defaults from the documentation review

**Provenance: PRIMARY.** **Date:** 2026-09-28.

**Asked.** The documentation housekeeping review of 2026-09-28 (origin/main
`87fe8209`) left owner questions that the decisions above did not already
settle. They were put to Jason as one numbered list, each with a recommended
default and a one-line reason.

**Jason's answer, verbatim:** *"all defaults"*.

The defaults, as they were put to him (visual items 1-7 are recorded in
OD-2026-09-28-009):

8. Read-only production checks: Claude may run them when Jason says so, per
   run.
9. One Claude session may merge another session's green PR.
10. When a recorded decision and a newer work order disagree, the recorded
    decision wins until Jason records a new one; a work order must name the
    decision it replaces.
11. Branch protection: the `declaration` check becomes required; admin
    enforcement stays off so the owner keeps an emergency override.
12. The calibration revision migration (OD-2026-08-29-005, designed on closed
    PR #929) stays on the build list; the "never applied" blocker is corrected.
13. The W-D3 production gate: a read-only drill count, and the result recorded.
14. `docs/current/ATHLETE_DELIVERY_LEDGER.md` and
    `docs/handoffs/CROSS_SESSION_NOTES.md` are archived as history.
15. Open questions scattered through older documents each become one row in
    `docs/current/ACTIVE_WORK.md` blocked/parked, guardian-related first.
16. B2: no change (already recorded as closed out, stricter than asked, at
    OD-2026-08-28-006).
17. Capability build status lives in the module files under
    `docs/capabilities/modules/` only; the CSV and index copies become history.
18. Modules marked DONE with no code behind them are relabelled "claimed, no
    code" until Jason walks through them.
19. The "Go-Live contract" rule is deleted: no contract was ever written under
    it.
20. The 14 engine-unlock proposals become one parked row, otherwise untouched.
21. `PRODUCT_CAPABILITIES.json` is the approved product list;
    `PPBF_CAPABILITIES.json` is labelled an old draft and kept, because three
    scripts check that it exists.
22. The 0-100 readiness and injury-risk scores and the confidence percentages
    are struck from `docs/SHADOW_ML_ARCHITECTURE_SPEC.md` (OD-2026-09-21-001:
    in-app AI never diagnoses).
23. `docs/SHADOW_AI_TECHNICAL_COMPANION.md` is taken out of SHADOW's doctrine
    set at the next seed: it describes features that do not exist.
24. The SHADOW V1 build prompt is archived; nothing carries forward unless
    Jason names it.
25. `docs/SHADOW_RESEARCH_ARCHITECTURE.md`: the verified 2026-08-24 section is
    current; the rest stays labelled PROPOSED.
26. Real roster loading (the import page has no door) goes on the build list.

**Supersedes** OD-2026-08-28-001 to the extent it says a build lane does not
dispatch `run-checks` against production (item 8).

**Evidence for item 13, recorded at ratification.** Read-only production query,
2026-09-28 (`BEGIN READ ONLY`; `current_database() = postgres`): the only
active, current operational drill for `punxsy_prominence` is "Post Contact
Reset", created 2026-09-19T03:28:36Z; no drill row for that organization
predates 2026-09-19. The W-D3 production deploy, run 35419374201 at `cedf3679`,
started 2026-09-19T03:43:47Z. The operating organization therefore had one
active operational drill when W-D3 reached production: the gate in
OD-2026-09-18-001 was met.

Status (2026-09-29): item 17 -- Jason retired the capability-evidence check
that compared the module files with the old index, `expanded-200-index.json`
(the tracker-disagreement ceiling), *"11A"* (OD-2026-09-29-002 item 11). The
checks that DONE modules cite code stay. Item 26 -- the `/admin/import` door
goes to organization admins and coaches, and the import page and API open to
coaches, *"9d. B"* (OD-2026-09-29-002 item 9d).

---

## OD-2026-09-28-009 -- Visual rules under Golden Era

**Provenance: PRIMARY.** **Date:** 2026-09-28. Same list and answer as
OD-2026-09-28-010 (*"all defaults"*). The visual defaults, as put:

1. Of the eight laws in `design-system/README.md`, keep law 2 (saturated
   colour means safety or status only), law 3 (colour is never the only
   channel), law 5 (kiosk sizing: 55px touch targets, 19.1px text) and law 7
   (refusal is a stamp). Retire law 1 (brass), law 4 (the old type voices),
   law 6 (materials; Golden Era's own list replaces it) and law 8 (phi sizing):
   they describe the retired Leather & Brass look.
2. The 2026-08-17 park of the whole visuals lane is lifted.
3. `docs/ROOM-MAP.md` (approved 2026-09-26) is the single visual build order;
   the other visual work lists become history.
4. Fonts: the 2026-08-23 retirement stands, enforced by
   `legacyVisualVocabulary.test.ts`; `docs/GOLDEN-ERA-V1-CONTRACT.md` is
   corrected to what is built.
5. The "ring and bags in every plate" DNA in
   `docs/REAL-GYM-REFERENCE-LOCK.md` applies to training rooms only; other
   rooms follow `docs/ROOM-MAP.md`.
6. The blue bag: follow Jason's instruction of 2026-09-26, *"take the blue
   heavy bag out"* -- no blue bag in plates. This resolves the lock's "OPEN --
   the blue bag" item in favour of the instruction over the photographs.
7. Golden Era's seven materials replace the old "five materials" rule;
   `docs/DESIGN_LAWS_PROPOSAL.md` is archived.

Status (2026-09-28): dark glass is approved as a panel material alongside
Golden Era's seven (OD-2026-09-28-014), and the ring canvas's IRON CITY
lettering is an exception to the plates' zero-lettering rule
(OD-2026-09-28-013).

Status (2026-09-29): law 2 still stands, but red is no longer reserved
(OD-2026-09-29-001); `--locked` still means a medical stop.

---

## OD-2026-09-28-008 -- Attendance has one system of record; retention describes what exists

**Provenance: PRIMARY.** **Date:** 2026-09-28.

**Stamp ledger.** Put to Jason: the stamp-ledger design
(`docs/STAMP_AND_LEDGER_SCHEMA.md`, `docs/FLOOR_FLOWS_SPARRING_ATTENDANCE.md`,
`docs/PASSBOOK_V1_BUILD_PROMPT_FOR_VS.md`) describes a second check-in record
and offline check-in storage, none of it built. Option A, as put: *"Retire the
old stamp-ledger design; keep the live Passbook."* **Jason's answer:** *"A"*.
Attendance stays on the athlete-day system of record in
`docs/current/ATTENDANCE_PRECEDENCE.md`; offline storage stays parked; the
live Passbook (progression-gap queue, Passbook check) is untouched.

**Data retention.** Put to Jason: `docs/DATA_RETENTION.md` walks an admin
through an `/admin/data-deletion` screen, a 1-year restore and a compliance
report; only the organization-admin API
(`apps/web/app/api/pilot/admin/data-deletion/route.ts`) exists, and no screen
calls it. Option C, as put: *"A now, B later"* -- rewrite the policy to match
what exists today, and put the deletion screen on the build list. **Jason's
answer:** *"c"*.

Status (2026-09-29): the deletion screen's scope is answered, *"10 C"*
(OD-2026-09-29-002 item 10): A now (the record is marked deleted, login stops,
signed-in sessions end), then B right after (everything tied to the athlete is
marked deleted at the same moment).

---

## OD-2026-09-28-007 -- The operating organization is `punxsy_prominence`

**Provenance: PRIMARY.** **Date:** 2026-09-28.

Put to Jason: which organization id is the gym. Option A, as put: *"The gym is
`punxsy_prominence`"* -- everything the gym owns goes there, the seed form
stops saying "leave it blank", and production is checked read-only for
misfiled content, with any move needing his per-run yes. **Jason's answer:**
*"a"*.

**Evidence at decision (read-only production query, 2026-09-28).**
`punxsy_prominence` is "Punxsy Prominence Boxing and Fitness";
`ppbf-default-org` is "PPBF Root Platform Organization". 22 approved
`internal_policy` library sources (7 documents, 49 chunks) sit under
`ppbf-default-org`. A user sees their own organization plus `__platform__`
(`apps/web/src/server/pilot/platformLibraryScope.ts:36-38`), so the gym does
not currently see those sources. Moving them is a production write and waits
for Jason's per-run approval.

Status (2026-09-28): Jason said yes to the move (OD-2026-09-28-011 item 6). The
move tool is not built yet, and its production run still needs his approval in
GitHub.

---

## OD-2026-09-28-006 -- Teach Shadow: it teaches the machine, not people

**Provenance: PRIMARY** for the purpose statement; **RECONSTRUCTED** for rulings
1-4, recovered from the PR descriptions named with each and confirmed by Jason
as a set.

**Asked.** The Teach Shadow rulings existed only in PR text. Five were put to
Jason for recording; the fifth was new wording for him to confirm.

1. Teach Shadow (footage that teaches the recognizer) and Film Study (reviewing
   an athlete's own footage) are separate and never mix; Film Study footage
   cannot enter the teaching set. (#962; design approved 2026-09-24.)
2. *"Filming for teaching the ml should never be restricted."* No consent step
   on teaching footage; teaching footage names nobody. (#976.)
3. An optional, restricted link to the person filmed stays. It is not a gate;
   it is how a safety flag in the footage reaches a real person. (#976.)
4. Film Study keeps its existing consent check. (#976.)
5. Teach Shadow teaches recognition only; it does not re-open per-skill AI
   video scoring, which stays parked for Phase 2+.

**Jason's answers, verbatim:** *"it only teaches the machine and Ai not
people"* and, on whether people viewing teaching footage is a separate
exposure, *"this overly complicated the coach would be viewing the athlete
rguardless of the film"*.

**What this decides.** All five rulings stand. Teaching footage exists to teach
the machine and the AI; it is never used to assess, coach or report on the
person in it. People labelling, screening or removing it is part of that work,
not a separate exposure.

---

## OD-2026-09-28-005 -- The platform owner never opens an individual athlete record

**Provenance: PRIMARY.** **Date:** 2026-09-28.

Put to Jason: three documents described the platform owner's access to an
organization's athlete records three ways. Option A, as put: *"Never: keep
today's rule"* -- the platform account sees de-identified, aggregate data
across gyms and never an individual athlete's file; individual records are
reached by signing in as the gym (ppbf@, organization admin). **Jason's
answer:** *"A"*.

A gym-granted, logged support pass was offered as a possible future decision if
a second gym needs it. It is not decided and not built.

**Evidence.** `assertActorCanAccessAthlete` refuses `platform_owner` first and
unconditionally (`apps/web/src/server/pilot/access.ts`), as
`ORGANIZATION_ROLE_MODEL.md` states.

---

## OD-2026-09-28-004 -- Public repository: two accepted exposures

**Provenance: PRIMARY.** **Date:** 2026-09-28.

**The two PINs.** `PILOT_ADMIN_PIN` and `PILOT_SHADOW_ATHLETE_PIN` were once
literals in `.github/workflows/deploy-staging.yml`. All seven commits carrying
them (`4422ba35`; `07df1b92`, `3e29fa93`, `909a1e4f`, `b4180e7f`, `3febdd29`,
`7d43d594`) are ancestors of `main` through the merge `86968226` (2026-07-30),
so every clone of this public repository contains them; deleting branches does
not remove them. **Jason's answer, verbatim:** *"we we change it out after we
finish app risky but i accept the risk nor real personal data is in it yet"*.
Asked whether to track the rotation as a work-list row, he chose to record the
decision only (option C). Checked at decision: no production workflow or
production secret refers to either PIN, and the staging gate now mints a fresh
PIN on every run (`deploy-staging.yml:530-542`).

**Licensed extracts.** The SHADOW research seed data carries 1,193 claim
excerpts of licensed publisher text, which
`docs/SHADOW_RESEARCH_INTAKE_IMPORT.md` called tolerable because the repository
was private. It is public. Option C, as put: *"Keep it public for now, accept
the risk, fix the false 'private' wording"*; making the repository private, or
moving the extracts out, is a later decision. **Jason's answer:** *"c"*.

Status (2026-09-28): both are scheduled for the end of the build
(OD-2026-09-28-011 items 9 and 10).

---

## OD-2026-09-28-003 -- One record of decisions; merge and check rules

**Provenance: PRIMARY.** **Date:** 2026-09-28.

**Where things are recorded.** Option A, as put: *"One record, in the repo"* --
Jason's decisions go only in this file, written by Claude with his words
quoted; ChatGPT's plans (work orders) arrive in one OneDrive inbox folder,
which Claude reads; the OneDrive decision ledger takes no new entries and stays
as history; the duplicate `Documents/PPBF-AI-Lanes` folder is archived.
**Jason's answer:** *"A"*.

**Which folder.** Option A, as put: *"Use the existing
`PPBF-AI-Lanes/ChatGPT-Handoffs`"*, with its older contents moved into a
`_before-2026-09-28` subfolder. **Jason's answer:** *"A"*.

**Merging during the 2026-09-28 cleanup.** *"lets not worru about chat gpt for
this, we will need to redo instructions for both claude and chat gpt to get on
the same page again"* -- the cleanup's PRs merge on green checks plus Claude's
own adversarial verifier, with no ChatGPT review.

**Merging another session's PR.** *"I'll pause work and you have permission to
merge other lanes if needed"*, made standing by item 9 of OD-2026-09-28-010.

**Supersedes** the storage and ledger duties given to ChatGPT in the workspace
rules and in OD-2026-09-21-001.

Status (2026-09-28): ChatGPT cannot write to `PPBF-AI-Lanes/ChatGPT-Handoffs`
itself -- tested that day, its upload failed and no file was created
(`AGENT_KERNEL.md` capability table). How an approved work order reaches the
inbox is not decided; that is Jason's call.

---

## OD-2026-09-28-002 -- Claude says what it can and cannot do before it builds

**Provenance: PRIMARY.** **Date:** 2026-09-28.

**Jason's words:** *"claude needs to be honest about what it can do"*. Option A,
as put: *"A capability check on every work order, plus one verified capability
list."* **Jason's answer:** *"A"*.

**What this decides.**

1. Before building any work order, Claude answers it step by step: **CAN**
   (with the evidence), **CAN'T** (and why), or **NOT SURE** (and the smallest
   test, run before building).
2. One list records what each AI can actually do, with the date and method of
   each check: the capability table in `AGENT_KERNEL.md`. Other documents point
   to it instead of restating it. ChatGPT plans from it and assumes nothing
   that is not on it.

**Why.** The 2026-09-28 documentation review found capability claims copied
between documents without ever being checked -- seven documents asserted that
Claude cannot fetch drive files while the kernel itself recorded "Not checked".

---

## OD-2026-09-28-001 -- Claude Code is the only builder; ChatGPT is the architect and reviewer

**Provenance: PRIMARY.** **Date:** 2026-09-28. **Governs:** agent roles.

**Jason's words, verbatim:**

> So I dont want a dedicated AI to a lane other tha. Claude Code to be the o ly
> builder unless overriden by me there's bee a mix match of expectations to
> capabilities because of overly agreeable conversations

> We can use chat gpt as the reviewer after we get proper instructions set up
> for it

> Chagpt is the architect claude the builder but claude needs to be honest
> about what it can do

On Grok, option A as put -- *"Grok makes images when you ask, and Claude puts
them in the app"* -- answered *"A WE CAN ALSO USE CANVA FOR THAT AS WELL"*,
then *"Good well use the connector for canva"*.

**What this decides.**

1. **Claude Code is the only builder** -- branches, commits, pull requests,
   merges -- unless Jason overrides that for a specific piece of work.
2. **ChatGPT is the architect** (plans, specifications, work orders, which
   Jason approves) **and the reviewer.** Its reviews begin once its
   instructions are set up; until then no merge waits on it.
3. **Grok and Canva make images when Jason asks.** Neither opens pull requests.
   Claude places approved images; plates are still judged against
   `docs/REAL-GYM-REFERENCE-LOCK.md`.
4. **No other AI holds a standing lane.** Codex has no role.
5. Jason remains owner and final authority.

**Supersedes** OD-2026-09-25-002 (the lane list) and the role items of
OD-2026-09-21-001 (ChatGPT designs and enforces standards; Grok keeps visual
design and implementation), and narrows OD-2026-09-26-001: anyone may design or
generate an image, but implementing it in this repository is Claude's.

Status (2026-09-30): OD-2026-09-30-003 adds how the Claude threads are
organised among themselves: the housekeeping thread is overwatch -- general
contractor of the other Claude threads (lanes), liaison to ChatGPT, and
deployment lead. Claude Code is still the only builder, and ChatGPT still the
architect and reviewer.

---

## OD-2026-09-26-002 -- Near-miss records are coach and organization-admin chat context only

**Provenance: PRIMARY.** The owner's answer is recorded verbatim below, and the
options are reproduced exactly as they were put to him, because the word alone
does not carry the decision.

**Date:** 2026-09-26. **Governs:** which roles receive recorded near-miss
events in SHADOW chat prompt context. **Supersedes** nothing -- no prior entry
addressed near-miss audience. It does not change `assertActorCanAccessAthlete`
or any other authorization rule.

### The decision

Put to him as question 1 of three, verbatim as asked:

> **1. Near-miss text in chat** -- athletes/parents currently get coach-written
> near-miss descriptions (free text, can name another child). The API refuses
> them the same records.
> -> **(a)** coaches/admins only *(my recommendation)* . **(b)** own record,
> names redacted . **(c)** leave as is

His answer, verbatim:

> a

**The premise of that question was overstated, and the record should say so.**
It told him athletes and parents "currently get" those descriptions. That was
a statement about what the code ALLOWED -- every role clearing the athlete
check reached the read -- not about anything observed. No conversation,
database or log had been read, and he later stated none had been sent. The
"can name another child" clause is likewise a risk model, not a reported
incident. The recommendation marked in the options was the builder's, not an
independent one. The ruling stands on the reachability alone, which is
sufficient and was verified in source; a reader should not conclude it rested
on observed leaks.

### What that means

1. Near-miss records reach SHADOW prompt context only for `DECISION_LOOP_ROLES`
   -- `coach`, `organization_admin` and legacy `admin`. That is the same set
   `GET /api/pilot/shadow/near-misses` already requires, so the decision closes
   a gap between two surfaces rather than creating a new rule.
2. Athlete and parent keep ordinary athlete-scoped CHAT PROMPT context -- this
   decision reaches that path and no other surface. They lose the
   near-miss descriptions, the evidence ids, and any signal that records exist
   or do not exist.
3. **Redaction was on the table as (b) and was not chosen.** A later lane
   should not reach for "show the athlete their own record with names removed"
   as an obvious middle path. It was offered and declined.
4. `platform_owner` and `board` do not reach this context, because
   `assertActorCanAccessAthlete` refuses them earlier. That is READ FROM
   `access.ts`, not executed in the gate's own tests, which mock the
   authorization check. The gate itself refuses every role outside
   `DECISION_LOOP_ROLES`, and its tests enumerate the whole `PilotRole` union,
   so the ruling does not depend on that reading holding.

INTERPRETATION, marked because the owner's answer did not spell it out:
"coaches/admins" was implemented as `DECISION_LOOP_ROLES`, which carries legacy
`admin` alongside `organization_admin`. That matches how every other route in
the repository reads "admin" and matches `GET /near-misses` exactly, but it is
a reading of "a", not a distinction the owner drew. If he meant
`organization_admin` only, this entry is the thing to correct.

### The already-delivered question, and the owner's answer

This entry was first drafted carrying text delivered before the gate existed as
an open question, because the conversation-history loader re-feeds recent turns
and delivered text would keep resurfacing after the gate. It was put to the
owner the same day as question A. His answer, verbatim:

> A NONE HAS BEEN SENT

So there is nothing to remediate: on the owner's statement, no near-miss text
has reached an athlete or parent conversation.

**This rests on the owner's knowledge of who has used SHADOW, not on a
measurement.** No database, environment, conversation or log was read, and none
was authorized. It is recorded here as his statement rather than as a verified
fact, because it is the kind of claim that a later data pull could contradict.
If it ever is contradicted, the remediation question re-opens and this section
is the thing to correct. Nothing here authorizes deletion, rewriting or purging
of stored conversations.

### Re-ratified 2026-09-26, after the cost was put to him

A review found that the options put to the owner never named what the rule
costs: an athlete asking about progression used to get their recorded events
plus a directive to weigh them, and a HIGH or CRITICAL event added a line
recommending the coach review before any load increase -- "used to get"
describes what the code produced for that role, not an observed delivery. After the gate the
model cannot see the event, so it gives one fixed deferral sentence instead.
The record had said he decided "knowing" the position; he had not been shown
that.

It was put to him in those terms the same day, with the options to re-ratify,
to soften the withheld line, or to re-open. He chose, verbatim:

> Re-ratify as-is

So the rule stands, now on a record that names its cost. Whether the model
actually defers on a progression question is still untested -- it needs a
model call, not a unit test.

### Stored job payloads: OUT OF SCOPE, 2026-09-26

The async Heavy Bag path persists the assembled context, near-miss block
included, into `pilot.shadow_jobs` (`shadowHeavyBag.ts`, 12,000-character
slice). Athletes and parents are not blocked from that path by role: the MANUAL
heavy-tier request is role-gated, but organic escalation by complexity score is
not (`shadowClassifier.ts`), and `preferAsync` is a client-supplied boolean.
**Stated with its preconditions, which an earlier draft omitted:** the enqueue
branch also requires `isShadowWorkerEnabled()` -- `PPBF_SHADOW_WORKER_ENABLED`
set to `true` -- and passage of the Heavy Bag rate limit (`chat/route.ts`). No
environment state was read, so whether that flag was ever on where athletes
used SHADOW is UNVERIFIED, and "near-miss text may sit in job rows" rests on
that unchecked condition. Framing a question to the owner from code paths
without their preconditions is the same error as the "currently get" premise
above, and it is recorded rather than quietly corrected.

**A stored row is not inert.** `shadowJobProcessor.ts` reads
`payload.authorizedContext` at EXECUTION time, not at enqueue, and interpolates
it into the prompt; its allowed-role set includes `athlete` and `parent`. So a
job queued before this gate and processed after it deploys would still generate
from a context containing near-miss records, and the answer is appended to that
conversation. That is a delivery path, not merely storage, and it was NOT named
in the out-of-scope question above. Put to the owner separately on 2026-09-26,
he directed that the job queue be confirmed empty before the gate reaches
production. Asked where that precondition should live so it could not be
missed, he ruled it must be ENFORCED rather than recorded, verbatim:

> Nothing is real if anything is waiting

So it is not a note anyone has to remember: `docs/current/ACTIVE_WORK.md`
carries it as a BLOCKED row against the production deploy, and a separate PR
adds an executable queue-empty check to `deploy-production.yml` that fails
the deploy while anything is pending. Recording it in prose alone was the
option he refused. The read-only count could not be run from the build machine --
production PostgreSQL refused the connection (timeout, firewalled) -- so it is
recorded as a PRODUCTION-DEPLOY PRECONDITION rather than a merge precondition.
Merging changes nothing in production: `deploy-production.yml` is manual
dispatch only. The window opens when the gate deploys, not when it merges.

This is a different question from the delivered-text one above, and the
owner's "NONE HAS BEEN SENT" does not answer it -- he can know who used
SHADOW, not what a stored prompt contained. Put to him separately with the
options to authorize a read-only count, to log it as a blocked item, or to
rule it out of scope. He chose, verbatim:

> Out of scope -- leave it

No count was run, no rows were read, and none are to be deleted or modified.
The gate stops new rows carrying this content. Existing rows are not modified
by this slice -- and, per the paragraph above, are not inert either.
UNVERIFIED throughout: whether any such row exists was never measured.

### The evidence it rested on

- `retrieveShadowContext` called `listRecentNearMisses` with no role gate for
  every role that cleared athlete authorization, injecting a whitespace-collapsed
  240-character slice of `description` with a citable `[E:<near_miss_id>]`.
  Read at `c15b9644a8a184f111974d04c2af07175ad3110c`.
- `GET /api/pilot/shadow/near-misses` requires `DECISION_LOOP_ROLES`, at the
  same SHA.
- `docs/current/ACTIVE_WORK.md` had carried the mismatch as FOR THE OWNER since
  2026-08-28 -- open for a month before it was put to him.
- No environment, database or log was read. Whether any athlete or parent has
  actually received near-miss text is UNVERIFIED, and no affected population
  was estimated.

Built to on branch `local/shadow-near-miss-audience`.

---

---

## OD-2026-09-26-001 -- Visual design is not one lane's; anyone who makes a good one owns it

**Asked.** Whether a durable, reusable plate generator could land in the
repository at all, given that `AGENT_KERNEL.md` and `docs/GROK-VISUAL-LANE.md`
both reserved visual design -- and `GROK-VISUAL-LANE.md` specifically reserved
*image generation* -- to Grok. ChatGPT's standards review of PR #982 had raised
it as a blocker: a one-off owner-directed generation is legitimate, but a
permanent non-Grok production mechanism needs the authority source to say so.

**Jason's answer, verbatim:** *"anyone the makes a good one"*.

Asked in the same exchange whether the stale reference lock should be corrected
and where his photographs should live, he answered *"let's fix it"* and *"where
is it at now use it"*.

**What this decides.** Visual design and visual implementation are not reserved
to Grok. Any lane may design, implement and generate; the work is judged on
what it is, not on who made it. Grok's lane is unchanged in what it may do --
nothing is taken away from it.

**What it does not decide.** The standard. "A good one" still means: passes its
guards, alters no function or role gate or organization boundary or safety
rule, invents nothing unsupported, removes no existing action, keeps its tests
meaningful. For a plate, it passes the byte gate AND a human has opened the
image and checked it against `docs/REAL-GYM-REFERENCE-LOCK.md`. Rewriting
another lane's approved design out of preference is still out of order; that
restriction was protecting something real and it survives.

**Supersedes** the third numbered item of OD-2026-09-21-001 ("Grok keeps visual
design and visual implementation") and its interpretation note ("Visual design
stays Grok's"), to the extent those read as an exclusive grant. Per this file's
supersession rule the earlier entry is left standing as written.

**Evidence.** Jason's answers in the build thread, 2026-09-26. The blocker that
prompted the question is recorded in ChatGPT's standards review of PR #982.
Amended the same day: `AGENT_KERNEL.md`, `docs/GROK-VISUAL-LANE.md`,
`docs/GOLDEN-ERA-V1-CONTRACT.md`, `docs/AI_COLLABORATION.md`.

**Why this is written down at all.** It was already the working practice for a
full day before it was recorded, and the drift that caused was measurable: the
agent kept reverting to preserving the existing look, because the instruction it
re-reads every session said visual work was not its to do, while the owner's
instruction to design lived only in chat. This file's own preamble names that
failure mode.

## OD-2026-09-25-003 -- Any coach or admin in the organization may read an athlete's session note

**Provenance: PRIMARY** for the owner's quoted words, as carried in the
A-FIN-08 work order and its handoff. The words were given in the owner's
session on 2026-09-25 and are quoted here; this entry was written on
2026-09-26.

**Date:** 2026-09-25. **Governs:** who may read `pilot.sessions.notes`, the
free-text an athlete writes for their coach at check-in. **Does not supersede**
OD-2026-09-21-001 or any relationship rule elsewhere.

THIS ENTRY IS LATE, AND THAT IS THE POINT. The gate was built and opened as
PR #973 before the decision was recorded here. `AGENT_KERNEL.md` says to read
this file before writing anything that asserts who may do what, and to stop as
OWNER DECISION REQUIRED when the policy is not in it. Codex caught the
omission on the pull request and ChatGPT's standards review agreed. The ruling
itself was never in doubt -- the record was.

### The decision

The owner, on who may read it:

> Any coach or admin in the organization.

And on the linked-guardian exposure:

> Close it in this slice.

### What that means

1. A coach, `organization_admin` or legacy `admin` in the athlete's OWN
   organization may read that athlete's session note for the current gym day.
2. Assignment and coverage DO NOT participate. A coach of record, an active
   covering coach, a coach whose coverage lapsed and a coach with no
   relationship at all are all treated identically, and `pilot.coach_coverage`
   is never queried on this path.
3. Athlete, parent, board and `platform_owner` are refused. Cross-organization
   and soft-deleted athletes are refused with the same indistinguishable
   message, so a refusal says nothing about whether the id names a real child.
4. Linked guardians are excluded from `sessions.notes` in the passbook. The key
   is ABSENT rather than null, because `null` would assert that no note exists,
   which is a different fact from "one does and it is not yours to read".

### What it does NOT govern

This rule covers the dedicated session-note projection and nothing else.

- It does NOT widen `/api/pilot/sessions/list`, which still carries the
  narrower coach-of-record-or-coverage gate for the whole session record.
- It does NOT widen generic `athlete_record` access or
  `assertActorCanAccessAthlete`, which is untouched and still decides every
  other athlete-scoped capability.
- It is not a precedent for any other column. It was decided about this one
  field, on the reasoning below.

### Why the wider audience

The roster a coach works from is the whole gym by design. So what decides whose
note a coach ends up reading is their deliberate selection of an athlete on
that roster, not an assignment record -- the same reasoning the owner applied
to the wellness check-in on 2026-09-22 (A-FIN-03R1), which this follows. A
child writing "my wrist hurts before we start" is of no use if the only person
permitted to read it is an assigned coach who is not in the building.

The trade, stated plainly: a coach with no connection to that child can read
what they wrote. What bounds it is organization membership, the refusal of
soft-deleted athletes, and that nothing is read until a coach deliberately
picks that athlete.

### Still open

Who may EDIT a note after an athlete creates it is NOT decided. `POST
/api/pilot/sessions` and `/sessions/update` both accept `organization_admin`
and `coach` as well as `athlete`, and the row carries no author or last-editor
column -- which is why no surface may name a writer. That is a separate owner
decision and A-FIN-08 deliberately left it open.

---

## OD-2026-09-25-002 -- LANES are agent roles; the four subject areas are WORK DOMAINS

**Provenance: PRIMARY.**

**Date:** 2026-09-25. **Governs:** terminology for agent roles and subject
areas across PPBF AI coordination. **Clarifies** OD-2026-09-21-001; it does not
change the authorities assigned there.

The owner selected:

> LANES + WORK DOMAINS, exactly as you framed it.

The framing selected was:

> LANES stays the agent-role list (Jason owner/final, Claude builder, ChatGPT
> design/specification/standards/research, Grok visual). His four subject areas
> become WORK DOMAINS: visual design, ML training, AI/ML, app build.

### What that means

1. **LANES** names agent roles and their authority boundaries.
2. **WORK DOMAINS** names subject areas: visual design, ML training, AI/ML,
   app build.
3. A work domain is not an agent role and creates no authority by itself.
4. The detailed lane responsibilities in `AGENT_KERNEL.md` remain in force
   except where a later owner decision expressly supersedes them.

Evidence at decision: `AGENT_KERNEL.md` at `c15b9644` already carried the
detailed Jason / ChatGPT / Claude / Grok agent-role model, and
`docs/AI_COLLABORATION.md` used "lanes" for that same model. The decision
resolves the separate four-subject-area vocabulary without changing those
authorities.

---

## OD-2026-09-25-001 -- A session note is retractable from the coach's view

**Provenance: PRIMARY.**

**Date:** 2026-09-25. **Governs:** whether a session note already visible to a
coach can be withdrawn by the athlete.

The owner selected:

> RETRACTABLE.

And:

> Clearing a session note withdraws it from the coach view.

The choice was put against an irreversible alternative after review found that
the athlete surface did not write an emptied notes box, so text already stored
could remain coach-visible after the athlete reconsidered and deleted it.

### What that means

1. A coach-visible session note is not irrevocable.
2. The athlete must have an intentional way to withdraw one.
3. After a successful withdrawal the coach-readable contract returns no note.
4. The implementation may distinguish an intentional withdrawal from an
   accidental empty edit. The decision requires the CAPABILITY, not a
   destructive write on every keystroke.
5. A-FIN-08 implements it using the existing session model and the existing
   no-note representation. This decision does not authorize a schema
   migration.
6. Withdrawal has to reach a coach screen that is already open. A note read
   once and never revalidated leaves withdrawn words on that screen for as
   long as it stays there, which would make the retraction true of the
   database and false of the person reading it.

---

## OD-2026-09-21-001 -- Claude builds, ChatGPT designs and enforces standards; product direction; minors' limits are coach-set data

**Provenance: PRIMARY** for the owner's quoted words and the options as put.
Lines marked RECONSTRUCTED below are interpretations, each naming its source.

**Date:** 2026-09-21. **Governs:** who designs, who builds and who reviews;
the product direction every lane builds toward; and where limits for minors
come from. **Supersedes** the 2026-08-20 decision recorded in
`AGENT_KERNEL.md` (Working channel) that the primary Claude session is the
PPBF project command thread. Made in the Claude session that set up the
account- and workspace-level AI instructions the same day. The OneDrive
decision ledger carries the same decision as LEDGER-0010.

### 1. Lanes

The owner, verbatim:

> 3 chat gpt takes over after you finish the instructions set ups, you build and chatgpt is the designer and stnadard enforcer 5 undo and the rest i agree with your recomendations

"3" answered who does storage and ledger writes. "5 undo" restored a ChatGPT
project and does not touch this repository.

Question 3 as it was put to the owner (options verbatim; the recommendation
was C):

> **3. Who does the file work on the drives**
>
> - A. I write whenever I hold the checked copy
> - B. ChatGPT writes; I write only when it fails
> - **C. Whoever holds the checked copy writes, the other verifies, and the ledger records who** (recommended)

His answer took none of them verbatim: "chat gpt takes over after you finish
the instructions set ups".

What that means for this repository:

1. ChatGPT designs and enforces standards; Claude builds (the owner's words).
   ChatGPT stays read-only here (unchanged from `AGENT_KERNEL.md`). "Jason
   approves a design before it is built" is the standing account-level rule
   that Jason decides final product and design, not a new ruling in this
   answer.
2. After the instruction setup, storage writes and the ledger are ChatGPT's
   ("chat gpt takes over"). RECONSTRUCTED: "Claude writes there only when a
   ChatGPT write fails" is option B's wording, the option closest to his answer;
   it was installed in the workspace facts the same day and he has not
   corrected it.
3. Grok keeps visual design and visual implementation. RECONSTRUCTED: see the
   interpretation note below.

Interpretation put to the owner the same day and not corrected: "designer"
means product and system design. Visual design stays Grok's, as
`AGENT_KERNEL.md` already records.

### 2. Product direction, and 3. limits for minors

Put to the owner as one question with four options:

> **1. Two app decisions went in under your blanket approval**
>
> - **App description:** "A coach-reviewed human capability platform, boxing first, with wrestling and multi-sport later. The AI teaches and drafts; coaches decide. The in-app AI never diagnoses."
> - **Limits for minors:** "Coaches set the limits for minors as data: heat time, % of body weight, contact level, supervision. The AI applies them. If a limit is missing, it asks."
>
> - **A. Keep both** (recommended) -- the limits table doesn't exist yet; until it does, the AI will ask for the limits each time.
> - B. Keep the app description, park the minors rule
> - C. Reword either one
> - D. Remove both

**Owner's choice:** A, given as "the rest i agree with your recomendations"
in the reply quoted under 1.

What that means as built:

1. The AI teaches and drafts; coaches decide. The in-app AI never
   diagnoses.
2. Coaches set the limits for minors as **data**: heat time, % of body
   weight, contact level, supervision. The AI applies them; they are not
   constants in code and not values the AI chooses.
3. If a limit is missing, the AI asks for it. It does not fill in a default.
4. No limits table exists yet. Building one is its own bounded slice and is
   not authorized by this entry.

---

## OD-2026-09-19-002 -- Open assigned work keeps its drill instruction after the gym retires the drill

**Provenance: PRIMARY.**

**Date:** 2026-09-19. **Governs:** whether an athlete can open a drill's
instruction from assigned work after the gym has retired that operational
drill. **Narrows** OD-2026-09-17-001 clause 7 for this one case, and resolves
the conflict between that clause and OD-2026-09-19-001's ASSIGNED ATHLETE
clause that W-D4B surfaced (a P1 review thread on PR #938 raised it as an
unrecorded policy choice). Everything else in both rulings stands.

The question and the two options, as they were put to the owner:

> When a gym retires a drill that an athlete still has OPEN work on (assigned / in progress), should
> the athlete still be able to open that drill's instructions from the work?
>
> - **Open work keeps it (Recommended)** -- While the work is open, the athlete can read the exact
>   pinned instructions, including safety and stop rules, even though the gym retired the drill. A
>   retracted (withdrawn) reference stays withheld, and so does completed or cancelled work. Needs a
>   small code change plus a review cycle, about 1-1.5h before merge. Reason: the athlete is still
>   expected to do the work, and the coach can cancel it if the drill is unsafe.
> - **Withhold, as built** -- Keep the current build (OD-17 clause 7 applied literally). The athlete
>   sees 'no library instructions', and the coach preview says athletes can't open it. I record your
>   ruling, resolve the Codex thread, and merge now.

**Owner's choice:** "Open work keeps it (Recommended)".

What that means as built:

1. Work that is still open -- `assigned` or `in_progress` -- opens the exact
   reference version its operational drill pinned, even after the gym retires
   the drill.
2. A retracted (inactive) reference stays withheld from every athlete read.
3. Completed, cancelled and incomplete work get no such exception. They follow the
   promoted-and-live rule, as Learn does.
4. The drill stays out of Learn (clause 2 is unchanged). This is a read keyed
   by the athlete's own open work, not a browse surface.

**Correction to the option as put, same day.** The recommended option gave as
its reason that "the coach can cancel it if the drill is unsafe". That is not
true of the product today. No code path writes `cancelled` to
`pilot.drill_assignments`; the only status writer is `touchAssignmentProgress`,
which moves work toward `completed`. The W-D4B product review found this, and it
was reported to the owner before merge.

Asked whether the ruling stands knowing that, the owner answered, verbatim:

> yes coach should be able to cancel work, also is there delete, undo, and edit available

The ruling stands. A coach cancel capability for assigned work is owner-requested
product direction. It is NOT built by W-D4B and needs its own bounded slice. The
question about delete, undo and edit was answered in the session from the code:
assigned work has none of the three today (no edit, no cancel, no delete, no
undo; completion logs have only the coach's Verify / Dispute). Any of them would
join the same follow-up slice.

Status (2026-09-28): the coach cancel is built. `POST
/api/pilot/progression/assignments/cancel` (#951, merged 2026-09-23 as
`71f98122`) writes `cancelled` through `cancelDrillAssignment`
(`apps/web/src/server/pilot/progression.ts:672`). Its route header records the
owner decisions of 2026-09-22: cancel only -- no edit, no delete, no undo or
reopen -- and only open work.

---

## OD-2026-09-19-001 -- Drills are progressive instructional objects (W-D4 product ruling)

**Provenance: PRIMARY.**

**Date:** 2026-09-19. **Governs:** how drill instruction is presented to athletes
and coaches, how assigned work reaches its drill's instruction, the
reference-derived operational drill lifecycle, and what makes a reference drill
ready for operational adoption. Given with the owner's authorization of the
sequential W-D4 execution (W-D4A drill detail, W-D4B assignment-aware drill
journey, W-D4C lifecycle, discovery and promotion quality). **Extends, does not
replace,** OD-2026-09-16-001, OD-2026-09-17-001 and OD-2026-09-18-001, except
where noted below.

Owner words, verbatim:

> PRODUCT INTENT:
>
> PPBF drills are progressive instructional objects, not flat database records.
>
> Users begin with concise context and progressively access deeper information required to understand,
> perform, coach, scale, correct or safely stop a drill.
>
> Normal pilot interaction depth:
>
> LEVEL 1 — DISCOVER
> Concise drill summary/card.
>
> LEVEL 2 — UNDERSTAND
> Complete organized drill detail.
>
> LEVEL 3 — DEEP DETAIL
> Specific execution step, correction, scale or safety detail only when additional depth is useful.
>
> Do NOT build unlimited recursive nesting.
>
> Safety-critical information must remain readily visible and must not require deep navigation.
>
> CANONICAL CONTENT:
>
> reference drill
> → operational drill
> → assignment/card
> → athlete performance/history
>
> Instructional content remains canonical on the reference drill.
>
> Operational adoption points to the exact reference identity/version.
>
> Assignments retain required historical snapshots but do not become another instructional content model.
>
> ASSIGNED ATHLETE:
>
> An athlete assigned a drill must be able to move directly from that assignment into the exact linked
> instructional drill while retaining assignment context.
>
> Reading instruction:
> - does NOT complete work;
> - does NOT log performance;
> - does NOT alter progression.
>
> COACH:
>
> Coaches must have enough instructional, safety, context, lifecycle and version information to make a
> responsible adoption or assignment decision.
>
> Consequential actions should live on an informed decision surface.
>
> Do not impose ceremonial friction such as forcing coaches to open every subsection before acting.
>
> PROMOTION QUALITY:
>
> Technical row validity alone is insufficient for operational adoption.
>
> Required instructional completeness must be context-aware.
>
> Candidate required content:
>
> Identity:
> - name
> - purpose
> - category
> - difficulty
>
> Execution:
> - usable setup
> - ordered execution
> - success/good-execution criteria
>
> Coaching:
> - useful cue/coaching guidance
> - failure/correction information where applicable
>
> Scaling:
> - regression / standard / progression guidance where applicable
>
> Safety:
> - contact level
> - authorization requirement
> - applicable stop conditions
>
> Context where applicable:
> - solo / partner / coach-led
> - equipment
> - space/environment requirements
>
> Governance:
> - active/current version
> - valid source/provenance state
> - not superseded/retracted
>
> Do NOT require meaningless fields merely to satisfy a generic checklist.
>
> LIFECYCLE:
>
> Reference-derived operational drill identity is durable:
>
> Available
> → Operational
> → Retired
> → Restore
>
> Do NOT create duplicate reference-to-operational identities because an existing operational row is retired.
>
> Promoted reference-derived drills must not be described as "Gym-authored" unless they are actually
> gym-authored.
>
> ROLE PROJECTION:
>
> Athlete and coach share one conceptual drill structure.
>
> Athlete:
> practical instruction, cues, corrections, scaling and safety.
>
> Coach:
> athlete content plus appropriate coaching decision context, lifecycle/version/provenance and internal
> information.
>
> Internal governance/provenance must remain hidden from athlete projections.

The same authorization lists, for W-D4A, what the athlete detail must deliver.
Owner words, verbatim:

> Deliver existing athlete-safe:
>    - scale levels;
>    - stop rules;
>    - cues;
>    - setup;
>    - good/bad execution;
>    - corrections where present.

**What this changes in OD-2026-09-17-001.** Clause 8 of that ruling said athlete
responses "may include only" eight fields, which excluded what good and bad
execution look like, common errors and corrections. This ruling adds those four
to the athlete DETAIL projection ("practical instruction, cues, corrections,
scaling and safety"). Everything else in clause 8 still holds. In particular,
"internal governance/provenance must remain hidden": what good and bad look like
and corrections carry inline grounding-claim tags such as `[A2-070]` in the
seeded corpus, so the athlete projection strips them (from every one of these
fields) before the text leaves the server.

**Build interpretation, flagged.** The athlete detail also carries
`equipment_needed`, read as practical instruction. In 114 of the 119 seeded
reference drills `standard_setup` holds the same equipment word, so athletes
were already reading it -- labelled "Setup". Carrying the equipment value is what
lets the screen label it truthfully, which W-D4A requires. Transfer, target
behavior, skill codes, provenance and authoring state stay off the athlete
projection.

**What it does not decide.** It sets the depth (three levels, no recursion) and
the direction for promotion quality, but not the exact required-field rule for
each drill type. Where the current model cannot tell whether a field applies to
a drill, that is a model or owner question, not something to infer from prose.

**W-D4B build interpretations, flagged.** These are how the assigned-athlete
and coach clauses above were built. None is a new ruling; each is open to the
owner's correction.

1. *Exact version, no lookup.* Assigned work opens the reference version named
   by the operational row it was assigned against
   (`assignment.drill_id` -> that row's `reference_drill_id`). Nothing follows a
   lineage to choose content. Staff are told where the lineage stands (see 6),
   but that is a status line, not a source of content.
2. *The athlete read is the Learn read, except for open work.* Opening a drill
   from an assignment uses the same promoted-and-live predicate and athlete-safe
   projection as Learn (OD-2026-09-17-001 clause 7). The one exception is set by
   OD-2026-09-19-002: open work (assigned or in progress) keeps its exact
   instruction after the gym retires the drill. A withdrawn reference, and
   completed or cancelled work on a retired drill, give the athlete the neutral
   "no library instructions to open" line. The assignment itself -- its
   snapshot wording and its completions -- is unchanged and readable (clause 4).
3. *Provenance stays on the server.* The athlete response for an assignment
   carries the instruction but not the reference drill id, which W-D2 treats as
   internal provenance. Nor does it say why there is nothing to open: a drill
   the gym wrote itself, closed work on a retired one, a withdrawn reference,
   and work that predates drill links all reach the athlete as one state and
   one neutral line, because each reason is a fact about how the library is
   assembled and governed. Staff see the reason.
4. *"Coach" in the opened assignment is a derived name.* The new read names the
   assigning coach with the display name athletes already read on recognitions
   and development blocks (`getCoachDisplayName`), never an account id, and
   falls back to "Your coach". This holds for the new read only: the existing
   assignments list (`GET /api/pilot/progression/assignments`, unchanged here)
   already sends `assigned_by_account_id` to athlete and guardian clients. That
   is a pre-existing gap, left for a separate decision.
5. *Guardians get the athlete projection from the new read.* It admits a linked
   guardian through the existing athlete-access rule and gives them the
   athlete-safe shape. There is no guardian control for it yet. This is
   narrower than `/api/pilot/drill-library`, which already gives guardians the
   full coach shape -- also pre-existing, and also left for a separate decision.
6. *Coaches preview from where they decide.* The Coach Cards form and list and
   the progression assign form and list each open the same drill detail
   `/coach/drills` shows. Before issuing, the preview reads the adopted
   reference by pointer. After issuing, it reads through the assignment, so the
   work opens at the version it was issued against. The preview says when the
   operational drill has since changed into another version (adopting a
   refinement deactivates the version it replaces, which is not retirement) or
   been retired, and nothing while it is still run. It also says which work an
   athlete can open these instructions from: any work, only open work (a
   retired drill, per OD-2026-09-19-002), or none (a withdrawn reference). That
   answer comes from running the athlete's own two reads, so a coach does not
   send an athlete to read something they cannot open.

**W-D4C build interpretations, flagged.** How the LIFECYCLE and PROMOTION
QUALITY clauses above were built, and where they could not be. None is a new
ruling; each is open to the owner's correction. The owner approved this split
(build what the data supports, report the rest) before the build started.

1. *Lifecycle is derived, never stored.* For each reference drill in a gym the
   server derives one state from durable rows on every read: **operational**
   (an active operational drill points at this exact reference version),
   **retired** (adopted, none active), **superseded** (not adopted, and a newer
   reference version exists), **withdrawn** (not adopted, reference inactive),
   and otherwise **available**. It is shown only to the roles that promote,
   retire and restore (coach, organization administrator, administrator) --
   the same roles that see retired drills elsewhere.
2. *NEEDS REVIEW is not built.* Nothing durable records that a drill was
   reviewed or floor-validated, so a "needs review" state would either be
   permanent for 114 of the 119 seeded drills or invented. VERIFIED_MODEL_GAP.
3. *Retire and Restore work on the reference-derived identity.* They appear on
   the reference drill's detail, the same decision surface as Promote. Restore
   brings back the SAME operational drill: the adopted lineage's newest
   version. The server refuses a restore of an earlier version, a restore while
   another version of the lineage is active, and a restore whose reference has
   been withdrawn. The refusal is enforced in the update itself, so a direct API
   call gets the same rule. Promoting again after a retirement stays refused,
   and the refusal now says to restore instead. Drills a gym wrote itself keep
   their existing API-only retire/restore, now under the same guard.
4. *Discovery uses durable fields only.* Search matches the drill name only.
   The filters are discipline, category, difficulty, contact level,
   coach-authorization and lifecycle. There is no solo / partner / coach-led,
   space or equipment filter: the first two have no column at all, and
   equipment is free text (37 raw values in the seed, with near-duplicates and
   "or"/"," lists) that could only be filtered by parsing it. Some category
   values name a format (partner, shadow, sparring); the Category filter
   offers them as categories, not as a solo/partner attribute.
5. *The promotion check is adoption readiness, not the context-aware quality
   gate.* The server refuses to promote a reference drill unless it is current
   (active, not superseded) and has a name, purpose, category, difficulty,
   setup, execution, a description of good execution, easier / standard / harder
   scaling with one starting level, and at least one stop rule. All 119 seeded
   drills pass. The context-aware gate the ruling asks for is a
   **VERIFIED_MODEL_GAP**. There is no durable data for: solo / partner /
   coach-led; space / environment; whether a "where applicable" requirement
   (failure/correction, scaling, drill-specific stop conditions, equipment)
   applies to a given drill; ordered execution (execution is one text column);
   or a floor-validation record.
6. *Owner decisions left open, not guessed:*
   - Should at least one coaching cue be required? That would block 34 of 119
     drills, including 23 of the 25 conditioning drills.
   - Are the 114 drafts marked REQUIRES FLOOR VALIDATION adoptable as they are?
   - Should the blank equipment on the 5 source-manual drills count as missing?
   - Should adopting a change proposal on a retired lineage be refused? Today it
     brings the drill back under a new operational id, which is a second path
     around Restore.
   - Should a coach be able to reinstate an earlier version of a drill, or only
     the newest? This build allows only the newest.
   - A newer version of a reference drill that this gym adopted (and perhaps
     retired) reads as not adopted and can be promoted as a separate
     operational drill. Should adopting a newer reference version instead go
     through the adopted drill (a coach-reviewed refinement), per
     OD-2026-09-16-001 clause 5? No reference row has ever been superseded, so
     this is latent.

---

## OD-2026-09-18-001 -- Every new assignment and Coach Card is built from an active operational drill

**Provenance: PRIMARY.**

**Date:** 2026-09-18. **Governs:** what a NEW `pilot.drill_assignments` row
may be created from, through `/api/pilot/progression/assignments`,
`/api/pilot/coach/cards`, and the writers behind them (`assignDrill`,
`issueCoachCard`, `issueCoachCardToProgram`). **Extends, does not replace,**
OD-2026-09-16-001 and OD-2026-09-17-001, which remain in force.

Owner ruling, verbatim (put to the owner after the W-D3 read-only reality
check):

> 1. NEW ASSIGNMENT IDENTITY
>
> Every new drill assignment and Coach Card must carry a real active operational
> pilot.drills drill_id.
>
> Free-text-only creation is no longer permitted.
>
> Legacy drill_id-NULL assignments remain valid historical records and remain readable.
> Do not rewrite or migrate them.
>
> 2. PRODUCTION ROLLOUT WITH ZERO OPERATIONAL DRILLS
>
> W-D3 implementation, review, merge and staging proof may proceed while
> punxsy_prominence has zero operational drills.
>
> W-D3 MUST NOT be deployed to production while the operating organization has zero
> active operational drills.
>
> Do not preserve free-text creation as a production fallback.
>
> Operational drill readiness is a separate product-data gate using the existing W-D1
> operational/promotion model and requires separate explicit authorization before any
> production data write.
>
> 3. TYPED TEXT ON ANCHORED ASSIGNMENTS
>
> For every NEW anchored assignment or Coach Card:
>
> - drill_name is snapshotted from the resolved operational drill;
> - drill_description is snapshotted from the resolved operational drill;
> - client-entered title/name/description does not override those canonical values.
>
> Historical snapshots are untouched.
>
> Do not add a replacement free-text notes/instructions field in W-D3.
>
> Structured assignment parameters such as reps, duration, frequency and due date remain
> assignment-specific.
>
> Do not change drill_difficulty semantics in W-D3 unless implementation evidence proves
> that is required.
>
> 4. ENFORCEMENT BOUNDARY
>
> Hold the new-write invariant at BOTH:
>
> - the API routes; and
> - the assignment writer functions.
>
> New-write functions must no longer accept a nullable drillId.
>
> The database drill_id column remains nullable because historical legacy rows require it.
> NO migration and NO historical rewrite.
>
> Tests that require historical drill_id-NULL rows must create them as legacy fixtures,
> not through current new-write functions.
>
> 5. REFERENCE MODEL
>
> pilot.drill_library rows remain non-assignable.
>
> Only pilot.drills operational identities may anchor new assignments.
>
> 6. PARKED
>
> Do not touch:
> - W-D1
> - W-D2
> - ATHLETE_OPERATIONAL_DTO_MINIMIZATION
> - reference supersession/name-collision workflow
> - #922
> - #929
> - final owner-wide PPBF design conformance

The implementation authorization that followed fixed two points the ruling left
open. Owner words, verbatim:

> 6. Every new assignment snapshots:
>    drill_name = resolved operational drill.name
>    drill_description = resolved operational drill.focus
>
> 7. STRICT STALE-CLIENT RULE:
>    Progression assignment request:
>    - non-empty drill_name -> 400
>    - non-empty drill_description -> 400
>
>    Coach Card request:
>    - non-empty title -> 400
>    - non-empty description -> 400
>
>    Absent or empty legacy properties may be tolerated.
>
>    Do NOT silently discard non-empty client identity text.
>    Do NOT add a replacement notes/instructions field in W-D3.
>
> 8. drill_difficulty semantics remain unchanged:
>    valid explicitly supplied difficulty may override the drill difficulty;
>    otherwise use the operational drill difficulty.
>
> 9. rep_count, duration_minutes, frequency_per_week and due_date remain assignment-specific.

**What this changed.** Before it, both write routes accepted a drill that was
only typed words: `drill_id` was optional, and when it was absent the row was
written with the coach's `drill_name`/`drill_description` and no anchor. When it
was present, the typed words were still what the row stored. Now a new row is
written FROM the drill -- one `INSERT ... SELECT` against `pilot.drills` scoped
to the caller's organization and `active` -- so an unknown, cross-org,
reference-library or retired `drill_id` selects nothing and writes nothing, and
a drill retired between the route's check and the write cannot slip through.

**Why a stale client gets a 400 rather than its text being ignored.** A client
built before this change sends the coach's typed words. Accepting the drill and
quietly dropping those words would record something different from what the
coach believes they sent, with no signal. Clause 7 makes that a visible refusal
instead.

**What it does not decide.** It does not make `pilot.drill_library` rows
assignable; a reference drill reaches an assignment only by being promoted under
OD-2026-09-16-001. It does not touch existing rows: `drill_id` stays nullable and
every legacy free-text assignment keeps reading exactly as written. It does not
authorize creating operational drills anywhere; clause 2 makes that a separate
gate, and production rollout of this change waits on it.

**Evidence.** Reality check and implementation both at `main` `fa24732182e2`.
The free-text-only path was observed in both route handlers and all three
writer INSERTs at that SHA. The zero-operational-drills premise of clause 2 is
the owner's, stated in the ruling.

Status (2026-09-28): the clause 2 gate was met when W-D3 reached production;
the evidence is recorded under OD-2026-09-28-010 item 13. #922 and #929,
parked in clause 6, were both closed unmerged on 2026-09-28; the #929 design
stays on the build list (OD-2026-09-28-010 item 12).

---

## OD-2026-09-17-001 -- Athlete active-learning visibility for reference drills

**Provenance: PRIMARY.**

**Date:** 2026-09-17. **Governs:** who may read `pilot.drill_library`
instructional content as an athlete, and when. **Extends, does not replace,**
OD-2026-09-16-001, which remains in force.

Owner words, verbatim:

> I approve the W-D2 active-learning rule as follows:
>
> 1. Current athlete Reference/Learning visibility requires BOTH:
>    - an ACTIVE operational pilot.drills row for the athlete's organization carrying reference_drill_id for that exact reference drill; and
>    - the linked pilot.drill_library reference row itself remaining ACTIVE.
> 2. If the operational promoted drill is retired, that reference is removed from the athlete's CURRENT Reference/Learning browse surface.
> 3. If the linked reference becomes inactive/retracted, it is removed from the athlete's CURRENT Reference/Learning browse surface.
> 4. Historical assignments, completions and records are not deleted, rewritten or detached by this rule.
> 5. Reference supersession never silently updates athlete-visible content. A newer reference version becomes currently visible only after explicit coach review/adoption through the operational promotion model.
> 6. Reference/Learning remains distinct from Assigned Training. Reading reference material creates no assignment, completion or progression state.
> 7. This rule applies to ALL athlete-accessible reference-content paths, including:
>    - /api/pilot/drill-library
>    - /api/pilot/coach/cue-library
>    - the athlete Learn -> Drills surface
>
>    This does NOT change COACHING_CONTENT_READER_ROLES. It requires athlete requests on those reference-content paths to receive:
>    - organization-scoped promoted-only filtering; and
>    - an athlete-safe projection.
> 8. Athlete-safe responses may include only the already-approved instructional/safety material needed for learning:
>    - purpose
>    - setup
>    - execution
>    - cues
>    - scale guidance
>    - stop rules
>    - contact level
>    - coach-authorization requirement
>
>    Do not expose athlete-facing:
>    - evidence_note
>    - source_ref
>    - field_provenance
>    - grounding_claim_ids
>    - creator identity
>    - authoring state
>    - governance/internal provenance metadata
> 9. Do not root-scope the promotion predicate with supersedes_drill_id IS NULL.
>    An active successor operational drill carrying the reference pointer remains a valid promotion.
>    Use active organization-scoped existence semantics so versioned operational lineages do not disappear from Learning.
> 10. Do not solve the future reference-supersession/name-collision coach workflow in W-D2.
>     Record it as a latent follow-up only.

**What this changed, and what it corrected.** OD-2026-09-16-001 said athletes
read reference instructional content only after their gym promotes it. That was
true of the athlete UI and FALSE of the API: `'athlete'` is the fifth entry in
`COACHING_CONTENT_READER_ROLES`, and both `/api/pilot/drill-library` and
`/api/pilot/coach/cue-library` gate on exactly that list with no promotion
filter of any kind. An athlete session could therefore enumerate the gym's
entire active reference corpus by URL -- including `source_ref`,
`grounding_claim_ids`, `field_provenance`, `content_class`,
`created_by_account_id` and `created_by_role`. That exposure PREDATES W-D1; it
was not introduced by the promotion model, only revealed while scoping W-D2.
Clause 7 closes it without touching the role list: admission is unchanged, and
the narrowing is on content.

**Why clause 9 is stated as a prohibition.** The scoping pass initially
recommended root-scoping the promoted-only predicate with
`supersedes_drill_id is null`, reasoning from
`pilot_drills_one_reference_per_org`, whose predicate carries that term.
Adopting a drill change proposal DEACTIVATES the lineage root and inserts an
ACTIVE successor carrying `supersedes_drill_id` and the same
`reference_drill_id`, so after any refinement the only live operational row is a
non-root -- and a root-scoped predicate would match nothing, silently removing
the drill from Learning the moment a coach improved it. Root scoping is what
keeps promotion UNIQUE; it is the wrong shape for asking whether a promotion is
LIVE. The owner ruled the correct semantics explicitly so the reasoning cannot
be re-derived wrongly later.

**What it does not decide.** Clause 10 leaves a known latent problem unsolved on
purpose: when a reference is superseded it goes inactive, athletes lose it under
clause 3, and the coach's remedy -- promote the newer version -- is blocked by
`pilot_drills_one_name_per_org` while the old promoted drill is still active
under the same name. No reference row has ever been superseded in any
environment (all 119 shipped rows are version 1, active, `lineage_id =
drill_id`), so this is latent rather than live. It needs its own slice.

Status (2026-09-30), on "What it does not decide": since #1031 (`07010d65`) a
revised reference drill is inserted as the next version and the old version
stays active for gyms that adopted it, so their athletes keep it. That is a
builder default put to Jason on 2026-09-29 and not answered. The coach's move
to the newer version is the open A/B question in `docs/current/ACTIVE_WORK.md`
(IMP-15); until it is answered, #1032 (`d100e6bd`) refuses the separate
promotion with 409 `NEWER_VERSION_UPDATE_NOT_BUILT`
(`apps/web/app/api/pilot/drills/promote/route.ts:150`). Both are on `main`. No
content-import load has run through the seed path in any environment (no
`seed-reference-data` run since 2026-09-16, GitHub).

**Evidence.** Source inspected at `main` `d9493536`; the exposure confirmed by
reading `coachingContentAccess.ts:93-102` and both route gates directly, and
corroborated by the field lists observed from live staging and production
`drill-library` responses during the W-D1 rollout gates.

---

## OD-2026-09-16-001 -- Hybrid reference / operational drill model

**Provenance: PRIMARY.**

Owner words, verbatim:

> I approve the hybrid drill model ruling exactly as written above and authorize one documentation-only branch, commit, and PR recording it as OD-2026-09-16-001 in docs/current/OWNER_DECISIONS.md. No other file changes.

**What was approved.** The owner's words above ratified the following proposal
exactly as written. It is PROPOSAL TEXT, not owner wording, and is reproduced
here so the decision can be read without the surrounding conversation:

> PPBF — OWNER RULING — HYBRID REFERENCE / OPERATIONAL DRILL MODEL
>
> 1. ATHLETE LEARNING ACCESS
> Athletes may read reference-drill instructional content only after that reference drill has been promoted/adopted by their gym.
> Promotion is the gym-level validation/adoption gate.
> Promotion alone does not assign the drill to any athlete and creates no completion or progression record.
>
> 2. REFERENCE VS OPERATIONAL
> pilot.drill_library remains the canonical instructional/safety source for promoted reference drills.
> pilot.drills is the gym's operational/assignment identity.
> A promoted operational drill must retain a durable pointer to the exact reference drill version from which it was promoted.
> Hand-authored operational drills may have no reference pointer.
>
> 3. REFERENCE PLANNING ARTIFACTS
> Workout templates, session scripts and transfer/reference planning artifacts may continue to reference pilot.drill_library.
> Before a drill becomes athlete-specific executable work, it must resolve to a promoted operational pilot.drills identity.
>
> 4. ATHLETE FIELD VISIBILITY
> Athletes may see instructional and safety content needed to understand a promoted reference drill, including purpose, setup, execution, cues, scale guidance, stop rules, contact level and whether coach authorization is required.
> Internal provenance, evidence, creator identity, authoring state and governance metadata are not athlete-visible.
>
> 5. SUPERSESSION
> Promotion pins to an exact reference drill version.
> Reference supersession does not silently change an existing operational drill.
> A newer reference version requires explicit coach review/adoption.
> Historical assignments remain attached to the operational drill/version used at the time.
> If the linked reference is made inactive/retracted, new assignments are blocked pending coach review; historical records remain readable.
>
> 6. ASSIGNMENTS
> New drill assignments must reference an operational pilot.drills drill_id.
> The existing free-text assignment fallback may remain readable for legacy/history but must not be used to create new drill assignments.
>
> 7. PROVENANCE FIELD
> Use a dedicated reference_drill_id-style field rather than source_ref.
> The link must remain organization-scoped, non-cascading and duplicate-protected.
>
> No third drill model.
> No automatic reference-to-operational synchronization.
> No reference browsing may be presented as assignment, completion or progression.

**Evidence this decision rested on.** Read-only architecture scoping at
`main` `7616ae098dc19a8d70d2f5d2b37c6047284ba5cf` established that
`pilot.drill_library` and `pilot.drills` are separate models; the athlete
workspace reads operational `pilot.drills`; assignment references resolve to
that operational table; workout templates, session scripts and transfer claims
reference `pilot.drill_library`; and no existing promotion/adoption link or
provenance field connects a reference drill to an operational drill. The same
scoping found that reusing the current full drill-library DTO for athletes would
expose governance/provenance fields the ruling now excludes.

**Implementation boundary.** This ruling authorizes the product/data contract,
not implementation by this documentation PR. The scoped implementation requires
a dedicated nullable `reference_drill_id`-style pointer on `pilot.drills`,
organization-scoped duplicate protection, a coach promotion path, a promoted-only
athlete projection, version/retraction handling, and tightening new assignment
creation to operational drill ids. Each implementation slice retains its normal
source, migration, review and release gates.

**MIGRATIONS: NONE.** This entry records the ratified decision only. No source,
schema, seed, workflow, runtime or production change is authorized by this PR.

---

## OD-2026-09-15-001 -- `pilot.drill_cues.source_ref` is optional authoring lineage, not a wording citation

**Provenance: PRIMARY.**

Owner words, verbatim:

> i approve

**What was approved.** Those two words were the owner's response to a bounded
correction instruction whose SEMANTIC BOUNDARY section set out the contract. That
section is reproduced below verbatim. It is PROPOSAL TEXT, not owner wording, and
is recorded here so the approval can be read without the surrounding
conversation:

> The intended ruling, once owner-authorized, establishes only these semantics:
>
> - pilot.drill_cues.source_ref is optional authoring-lineage/origin metadata
> - it is not an exact cue-wording citation
> - it is not the evidence authority for cue wording or cue class/focus
> - NULL is permitted
> - a historical artifact does not have to remain retrievable
> - recorded lineage must be truthful

The same instruction's PROHIBITED section forbade modifying `seed_drill_cues.csv`,
the seed loader, staging, production, or any `source_ref` data, so no data change
is authorized by this decision.

Everything below this line is repository analysis. It is neither owner wording nor
approved proposal text, and carries no authority of its own.

**What the contract establishes.** The field records where a cue row, authoring
batch, source library or manual originated. It makes no claim that the exact cue
wording appears in the named source, and it is not the evidence authority for the
wording or for the cue class/focus -- cue wording is coaching craft, and
class/focus evidence belongs in `evidence_note` and the grounding model. NULL is
permitted. A value need not identify a currently retrievable artifact. Recorded
lineage must be truthful.

**What it does NOT establish.** It does not forbid a CHECK, a foreign key, a
lineage registry, or validation. What it removes is an ARTIFACT RETRIEVABILITY
requirement -- not lineage-identifier validation. A future nullable registry could
require the identifier itself to be registered while the historical artifact stays
unretrievable, and would comply. Today's unconstrained column and pass-through
loader are what main happens to do, NOT policy. It also does not declare the
existing values correct, and does not overturn the separate provenance finding.

**Why it had to be settled.** A provenance investigation established that
`coach_cue_and_feedback_library.csv` -- cited by 238 of the 258 shipped cue rows
and live in both staging and production -- could not be produced from any
authoritative source investigated: not the repository, not any reachable Git
tree, and not any of the three 2026-08-08 Proposed-Migrations archives, each of
which was fetched, size-verified and fully enumerated. That is recorded
separately, and REMAINS a separate finding, as provenance classification
**D -- UNSUPPORTED SOURCE_REF**.

The obvious next step would have been to repair the 238 rows. A contract audit
found there was no contract to violate. The column is nullable with no CHECK, FK,
registry or enum; the seed loader copies the value with a trim and validates
nothing; and no test asserted anything about it.
No identified in-repo decision logic or UI rendering currently depends on the
field; external/API consumer dependency remains UNVERIFIED.
The value does cross an HTTP boundary in
`GET /api/pilot/drill-library?drill_id=…`, so a client outside this repository
could read it. The only definition of the name anywhere in the schema sits on a
sibling column, `pilot.drill_library.source_ref`, and is a three-way disjunction
-- "provenance: source manual, lineage, or registry claim" -- which cannot settle
what any individual value asserts.

**The evidence that a missing file is not, by itself, a defect.** The migration's
own comment above `pilot.drill_cues` already says cue wording is coaching craft
and that evidence attaches to the cue CLASS, "never to the exact words". Both
`evidence_note` variants in the seed data say the same. The informative case is
the 20 rows citing `Punxsy_Drill_Library_Source_v3.docx`: that artifact IS
retrievable, and those rows still say "Cue wording is coaching craft." So a
resolvable `source_ref` was not being used as a wording citation either.

**Disposition of the 238 rows: preserved, pending better evidence.** They are
classified **C -- HISTORICAL LINEAGE PLAUSIBLE BUT UNVERIFIED**. Plausible
because the authoring batch is corroborated by an artifact that is neither the
rows nor the missing file: `seed-data/research-evidence/2026-08-07/` refers to a
"cue library" as a PPBF deliverable sixteen times, and
`cross_track_conflict_ledger.csv`'s CT-01 mitigation specifies that the "Cue
library ships with focus_type tagged and a CONTESTED banner" -- which matches the
shape the 238 rows have. Unverified because no artifact bearing that filename has
been produced, and a specification for a deliverable is not proof of its name.

**Current evidence is insufficient to justify replacing, normalizing, nulling or
otherwise mutating the 238 values.** This is a statement about the evidence, not a
finding that the values are correct. Replacing them with
`Punxsy_Drill_Library_Source_v3.docx` would assert an origin that belongs to the
other 20 rows. Normalising would require inventing a canonical identifier that no
evidence supplies. Nulling would remove the current row-level lineage label
without evidence that doing so would make the record more accurate. None of those
is supported today, so none is authorized.

**Status: IN FORCE.** Recorded here, stated on `DrillCueRow.source_ref` in
`apps/web/src/server/pilot/drillLibraryV3.ts`, and checked against the effective
schema by a behavioural test in
`apps/web/src/server/pilot/fullSchemaFixture.pg.test.ts`. That test first builds
the schema from the current migration corpus with `applyFullSchema` -- every
migration in `infra/azure`, not only the one that created the table -- then shows
that `source_ref` may be omitted -- it reads back NULL -- without suppressing
`evidence_note`. So a later migration making the column NOT NULL would fail it. It
asserts no absence of constraints and does not require arbitrary values to be
accepted, so a future compatible registry, FK, CHECK or validation leaves it green.
No schema change and no data change were made; nullability was already legal, so
nothing was required of Postgres.

A sibling question is left explicitly OPEN:
`pilot.drill_library.source_ref` (119 drills) carries the same column name under
the same disjunctive comment and has NOT been ruled on. It is recorded under
Open questions rather than decided here by implication.

---

## OD-2026-08-29-008 -- `pilot.waivers.status` is measured before it is constrained

**Provenance: PRIMARY.** Put to the owner as a choice of options; he selected
one by label, recorded verbatim:

> Measure production first (Recommended)

The alternatives offered were to add a CHECK constraint over the reader
vocabulary now, and to leave the column unconstrained and close the question.

**What was asked.** Whether `pilot.waivers.status` should get a CHECK
constraint.

**What is true today, measured against the code, not the database.**

- The column is `status text not null` with **no CHECK constraint** -- checked
  across every `.sql` file in `infra/azure`, which is the whole of this
  repository's schema.
- Two of its four writers store a literal: `grantMediaConsent` writes
  `'signed'`, `withdrawMediaConsent` writes `'withdrawn'`
  (`apps/web/src/server/pilot/guardianConsent.ts`).
- The other two do not. `POST /api/pilot/intake/domain-upsert` stores
  `asString(body.payload.status, 'signed')` -- any string a caller sends --
  and `POST /api/pilot/intake/review-action` stores whatever the promoted
  intake case payload carried.
- Every reader already fails CLOSED on a value it does not understand:
  `normalizeWaiverStatus` maps an unrecognised value to `'missing'`;
  `guardianConsent` tests `=== 'signed'`; `GET /api/pilot/video/[videoId]`
  refuses with 409 on a guardian-scoped row outside `{signed, withdrawn}`.

**So what is in production is a fact about production, and nothing in this
repository records it.** That is why the question could not be answered here.

**The decision.** Measure first. No CHECK constraint is proposed until the
values production actually holds have been counted.

**What the measurement is.** `apps/web/scripts/pilot-check-waiver-statuses.mjs`
(`npm run pilot:check-waiver-statuses`). Strictly read-only -- every statement
is a SELECT inside an explicit `BEGIN TRANSACTION READ ONLY`, and a test drives
it through a recording client to prove there is no write path. It reports the
number that decides this: **the rows a byte-exact CHECK over the reader
vocabulary would refuse.** The interesting population is `' Signed '` -- a row
every reader ACCEPTS and a byte-exact constraint REFUSES. **It has not been run
against production. Until it is, the count is UNVERIFIED.**

**What a lane must NOT infer.** Not that the column is safe to constrain, and
not that it is unsafe. Not that any odd value is a live incident -- every
reader fails closed on one today, which is a different harm (a family's signed
paperwork reported as missing) and not a leak. And not what should be done
with a non-exact row once counted: normalising rows, widening the vocabulary,
admitting case and padding inside the constraint, or leaving the column
unconstrained are four different answers and **all four remain OWNER DECISION
REQUIRED.**

Status (2026-09-29): measured. Production holds 11 `pilot.waivers` rows, every
one exactly `signed`; a byte-exact CHECK would refuse 0 rows, and no CHECK
exists (`npm run pilot:check-waiver-statuses`, run 2026-09-29 and reported by
the session that ran it; OD-2026-09-29-002 item 8a). Whether to add the
constraint is a new owner question (`docs/current/ACTIVE_WORK.md`).

Status (2026-09-29): answered. Jason chose to add the strict CHECK now
(*"all recommended"*, OD-2026-09-29-003 Q3 A). It is a build row in
`docs/current/ACTIVE_WORK.md`; its migration is applied only through the
`apply-migrations` workflow, production with Jason's approval.

---

## OD-2026-08-29-007 -- A nomination is deleted with the athlete it names

**Provenance: PRIMARY.** The decision was put to the owner as a choice between
two options, and he selected one by label. The label is recorded verbatim
because the words alone are what he chose:

> Delete it with the athlete (Recommended)

The alternative offered was to keep the nomination and detach it from the
athlete, matching OD-2026-08-29-005's treatment of a barrier report.

**What was asked.** `pilot_one_percent_nominations_athlete_fk` does not
cascade from `pilot.athletes`. The retention purge hard-deletes an athlete two
years after withdrawal, and a restricting foreign key aborts that delete. The
question was what should happen to a One Percent Club nomination naming a
child whose family has fully withdrawn.

**What is true today, measured.** The retention purge was proved
non-functional and then repaired in #862 (`apps/web/scripts/pilot-cleanup-deleted-data.mjs`),
which now isolates each athlete behind a savepoint and REPORTS what blocked it
rather than failing the whole sweep. `one_percent_nominations` is named in
that report as a blocker. So this is not a hypothetical: the purge already
tells an operator this row is in the way.

**The decision.** The nomination row is deleted with the athlete. A nomination
is a claim about a child who trains here; once the family has withdrawn and
the two-year retention window has closed, there is no child for it to be about.

**What a lane must NOT infer.** This says nothing about the retention
treatment of any other One Percent Club table, and nothing about nominations
whose athlete is still enrolled.

**IMPLEMENTATION IS NOT THIS LANE'S.** `pilot.one_percent_nominations` is a
coach-facing One Percent Club table. The parent/guardian lane established the
defect while repairing the purge, put the question to the owner, and recorded
the answer here -- it did not build the migration, and deliberately did not,
because a build lane fixing an unrelated table inside its own PR is the drive-by
`AGENT_KERNEL.md` forbids. **The One Percent Club lane owns the change.** As of
this entry no migration implements it, and the purge still reports the block.

---

## OD-2026-08-29-006 -- The build lane merges its own green work and drives staging; production stays the owner's

**Provenance:** PRIMARY. Owner, 2026-08-29: **"its all on you to get to
production with me, i closed the other work flows"**, then, asked how far that
runs without asking, he chose the option reading:

> **Merge + staging freely; production needs your word** -- "I merge my own
> green PRs and dispatch staging deploys and staging migrations on my own.
> Production deploys and production migrations I prepare, verify, and then ask."

Declined: **"Everything, including production"** and **"Merge only; deploys stay
with you"**.

**What was asked.** `AGENT_KERNEL.md` assigned `main`, migrations, staging and
production to a release-control lane, and forbade the build lane from merging or
dispatching any of them. The owner has since closed the other workflows, so that
lane is not staffed; on 2026-08-29 five green pull requests sat unmergeable for
roughly three and a half hours with no build work possible behind them.

**The decision.** A build lane MAY merge its own pull requests to `main` once CI
is green and they are mergeable, and MAY dispatch `deploy-staging` and staging
migrations. `deploy-production` and production migrations stay with the owner:
prepared and verified by the lane, dispatched only on his word.

**Why the split is where it is.** An applied migration is not undone by
re-running a workflow. The calibration tables this thread built against have
never been applied in any environment -- no lane here has ever reached a
database -- so the first production apply is genuinely unproven, and its
recovery would be manual database work rather than a redeploy. Staging is where
that gets found out.

`AGENT_KERNEL.md` is amended in the same commit. Recording the ruling without
amending it would leave the kernel stating a boundary that no longer describes
practice, which is the drift this file exists to stop.

**What this does NOT settle.**

- **Whether a lane may merge ANOTHER lane's pull request.** This says "its own".
  Not asked, not answered.
- **What happens when CI is green but the change is contested.** Green CI is
  still a precondition, not an authorization to override a review.
- **Who applies the calibration migrations first.** They remain unapplied
  everywhere, and the first apply is a production question this entry routes to
  the owner rather than answers.

**Evidence this rests on.** `AGENT_KERNEL.md` lines 408-411 at `31ea99c1`; the
2026-08-29 queue, where #890, #894, #897, #900 and #901 were green and
unmergeable from roughly 06:00 to 12:29 UTC.

Status (2026-09-28): two of the open points are settled. A session may merge
another session's green pull request (OD-2026-09-28-010 item 9). The
calibration migrations have been applied: `apply-migrations` runs 33269702024
(staging) and 33280673339 (production), both 2026-08-29, as recorded in
`docs/current/ACTIVE_WORK.md`, "The calibration migrations are applied".

---

## OD-2026-08-29-005 -- A superseded adjudication is marked by a revision integer, and a collision is explained rather than dumped

**Provenance:** PRIMARY. Owner, 2026-08-29, choosing among three shapes put to
him after he asked whether the error could explain itself. The option he
selected read:

> **Revision + unique constraint + translated error** -- "Same column, no lock;
> a unique index on (pair, revision) catches the collision, and the route
> translates Postgres 23505 into a sentence like *'someone corrected this while
> you were deciding -- reload and look at their answer before replacing it.'*
> GOOD: no locking, and arguably the RIGHT message: the second person genuinely
> should see the first correction before overwriting it. BAD: it is an error
> path, so it only reads well if I write and test that translation --
> untranslated it surfaces as a raw duplicate-key dump."

Declined: **"Revision + row lock, so there is no error"** (prevents the
collision with `SELECT ... FOR UPDATE`, but a forgotten lock in a future code
path silently reopens the hole) and **"is_current boolean + partial unique
index"** (the database refuses two current answers, but a reader who forgets to
filter silently sees history as current -- a quiet wrong answer rather than a
loud one).

**This supersedes the open question in OD-2026-08-29-004**, which ruled that a
second adjudication of the same pair is a correction and left the schema shape
undecided. It does not change that ruling; it answers what -004 deferred.

**The decision.** `pilot.calibration_adjudications` gains a revision integer
scoped to the pair. The highest revision is the current answer. A unique
constraint on the pair plus revision catches two writers computing the same next
value, and the route translates that collision into a sentence naming what
happened and what to do about it.

**The translated error is part of the decision, not a nicety.** The owner asked
for it specifically. Untranslated, a 23505 reaches an administrator as a
duplicate-key dump naming a constraint. The message he accepted says a person
corrected this while you were deciding and tells them to read that correction
before replacing it -- which is the right instruction, because the second
adjudicator genuinely should see the first answer before overwriting it. **A
lane implementing this owes the translation a test**; without one the failure
mode is exactly the raw dump the choice was made to avoid.

**What this does NOT settle.**

- **Who may supersede.** Whether only the original adjudicator may correct their
  own decision, or any organization admin may, is still open.
- **What the surfaces show.** Whether an adjudicator sees only the current
  revision or the whole chain is a surface question, unasked.
- **Retention.** Nothing rules on whether superseded revisions are ever removed.

**Evidence this rests on.** `infra/azure/pilot_slice_postgres_calibration_
adjudication_migration.sql` at `31ea99c1` -- no superseding column of any kind,
primary key `(organization_id, adjudication_id)`, so a second row for one pair
already inserts cleanly and is already indistinguishable from the first.
`adjudication.ts`, which exposes `recordAdjudication` and `getAdjudication` and
no update path.

---

## OD-2026-08-29-004 -- A second adjudication of the same pair is a correction, and supersedes

**Provenance:** PRIMARY. Owner chose, 2026-08-29, from options put to him as a
question about calibration adjudication. The option he selected read:

> **A correction, superseding** -- "The newer adjudication supersedes the older;
> both are retained as history. GOOD: matches how people actually behave -- the
> second one is nearly always fixing a mistake -- and gives one unambiguous
> current answer while keeping the audit trail. BAD: needs a superseding column
> and a migration, so it is not a code-only change."

The two options declined were **"Refuse the second"** (first answer final; no
schema change, but a genuine mistake becomes permanent) and **"Two independent
answers"** (the current behaviour; loses nothing, but nothing says which is
current).

**What was asked.** An adjudication already exists for a clip's pair of
annotation sets, and someone adjudicates that same pair again. Nothing in the
schema or the code takes a position on what the second row means.

**The decision.** The newer adjudication supersedes the older. Both rows are
retained; exactly one is current.

**What this requires, stated plainly because it is not a code-only change.**
`pilot.calibration_adjudications` has no superseding column today -- no
`supersedes`, no `is_current`, no revision marker -- and its primary key is
`(organization_id, adjudication_id)`, so a second adjudication of the same pair
is *already* insertable and already indistinguishable from the first. Making
one of them current needs a migration, and that migration needs its own
decision about how the current row is identified.

**This does NOT contradict the migration's "the originals are never touched."**
That guarantee is about *annotations*: `pilot_slice_postgres_calibration_
adjudication_migration.sql` says an adjudication "is a NEW row that REFERENCES
the two source events; nothing here updates, supersedes, or soft-deletes an
annotation," because the two readings are the measurement the study exists to
collect. Superseding an *adjudication* -- a record of a reviewer's conclusion --
touches no annotation and leaves that guarantee intact. The distinction is
worth stating because the words "supersede" appear in both places meaning
different things.

**What this does NOT settle.**

- **How the current row is identified.** A nullable `superseded_by` pointing at
  the newer row, an `is_current` boolean with a partial unique index, or a
  revision integer are all consistent with this ruling and have different
  failure modes under concurrent writes. Not asked, not answered.
- **Who may supersede.** Whether only the original adjudicator may correct their
  own decision, or any organization admin may, is a separate question this
  entry does not reach.
- **Whether anything downstream must re-read.** Gold-standard nomination is not
  built yet. When it is, it has to know which adjudication is current, and that
  is a dependency this ruling creates rather than resolves.

**Evidence this rests on.** `infra/azure/pilot_slice_postgres_calibration_
adjudication_migration.sql` at `d06cb930` -- the table definition (no
superseding column; `primary key (organization_id, adjudication_id)` at line
127) and its header comment. `apps/web/src/server/pilot/calibration/
adjudication.ts`, which exposes `recordAdjudication` and `getAdjudication` and
no update path. PR #900, which flagged the question and deliberately did not
answer it.

---

## OD-2026-08-29-003 -- With three or more submitted sets, the adjudicator picks the pair

**Provenance:** PRIMARY. Owner chose, 2026-08-29, from options put to him. The
option he selected read:

> **Adjudicator picks the pair** -- "The surface lists the submitted sets and the
> adjudicator chooses which two to compare. GOOD: the only option that does not
> silently decide what a three-rater clip means for the study -- the choice is
> made by a person and recorded. BAD: the most work of the four, and it puts a
> decision in front of the adjudicator that they may not feel qualified to make."

Declined: **"Keep refusing"** (current behaviour, invents no policy but leaves a
real clip stuck), **"Compare the two earliest submitted"** (deterministic, but
lets submission order decide which readings count), and **"Compare all pairs"**
(standard for inter-rater reliability, but needs a schema change since the model
records one settlement per clip).

**What was asked.** Nothing caps annotators per clip, and
`compareAnnotationSets` takes exactly two sets. Which pair a three-rater clip
means was unanswered anywhere in the codebase.

**The decision.** The surface lists the submitted sets and the adjudicator
chooses which two to compare. The choice is a person's, and it is recorded.

**What changes.** Both calibration surfaces currently refuse this case outright.
The comparison route refuses on `sets.length !== 2` with a message naming the
count and saying the question is open; the adjudication surface does the same.
Those refusals were correct as a way of not inventing a policy, and they are now
superseded by one. `resolveAdjudicationEligibility` already admits three or more
as eligible, so the gate does not need widening -- the selection is a surface
concern, not an authorization one.

**What this does NOT settle.**

- **Whether the chosen pair is recorded as part of the adjudication.** The
  ruling says the choice is "made by a person and recorded"; the table already
  stores `annotation_set_id_a` and `annotation_set_id_b`, so the pair is
  captured by construction. Whether the *unchosen* sets should also be
  referenced -- so a later reader knows a third reading existed -- is not
  answered here.
- **Whether the adjudicator needs guidance on which pair to choose.** The option
  he accepted names this as its own downside. No rule, ordering, or
  recommendation is ratified by this entry.
- **What happens to the third reading.** It is neither discarded nor compared.
  Whether a clip with an unadjudicated third set is "done" is open.

**Evidence this rests on.** `apps/web/src/server/pilot/calibration/
comparison.ts` (`compareAnnotationSets` takes exactly two);
`resolveAdjudicationEligibility` in `blinding.ts`, which returns
`{ eligible, submittedSetCount: n }` for n >= 2; PRs #894 and #900, both of
which refuse the case explicitly and both of which flagged it as an owner
decision rather than answering it.

---

## OD-2026-08-29-002 -- An annotator may not adjudicate a clip they annotated

**Provenance:** PRIMARY. Owner chose, 2026-08-29, from options put to him. The
option he selected read:

> **Refuse it** -- "A person who produced one of the two readings cannot settle
> the disagreement between them. GOOD: protects the study's validity -- the whole
> point of two blind readings is that a third party resolves them, and a party to
> the disagreement grading their own work makes the calibration data unusable as
> evidence. BAD: a small gym where the only admin is also a coach who annotates
> would have nobody able to adjudicate, so those clips stall until a second admin
> exists."

Declined: **"Permit, but record it"** (allowed, with the overlap recorded so the
bias is visible) and **"Permit silently"** (the current behaviour, which leaves
no trace).

**The stall is a ratified consequence, not an oversight.** The option's stated
downside is that a one-admin gym whose admin also annotates will have clips that
nobody can adjudicate. That cost was on the page when the decision was made. A
lane meeting a stalled clip should not read it as a bug to route around.

**What was asked.** `ANNOTATOR_ROLES` admits `organization_admin`, so the same
person can hold both roles on one clip, and `blinding.ts` takes no view.

**The decision.** A person who produced one of the two readings may not settle
the disagreement between them.

**What changes, and where it belongs.** `AdjudicationEligibilityInput` currently
carries `actorRole` and `sets` and no actor identity, so the primitive cannot
express this rule as written. Implementing it in the primitive -- adding the
actor's account id and comparing it against each set's `annotator_account_id` --
covers the read surface (#894's comparison) and the write surface (#900's
adjudication) in one place. Implementing it only in the write route would leave
an annotator able to read the diff of their own clip while being refused the
settlement, which is a narrower fix than the ruling.

**#900 currently pins the opposite, and that is the honest shape, not a defect.**
PR #900 permits self-adjudication and has a test labelled as pinning an
unsettled posture, precisely so a change could not arrive silently. This entry
is that change arriving. Per this file's own note on #811: a characterization
test that merges and is then inverted is not the failure mode -- the failure mode
is a test that claims to pin a decision it cannot detect a change to. The
correction is now due, and it is due *visibly*.

**What this does NOT settle.**

- **What a one-admin gym does.** The stall is accepted, not solved. Whether such
  an organization should be able to nominate an external adjudicator, or whether
  the platform owner may act, is a separate decision -- and note that
  `platform_owner` is deliberately refused on this surface today
  (`resolveAdjudicationEligibility`'s docblock), so it is not an available answer
  without its own ruling.
- **Whether the refusal is visible before the work is done.** An annotator who
  reaches the surface after annotating learns they cannot adjudicate. Whether the
  door should be hidden from them earlier is a surface question, unasked.
- **Retroactivity.** Nothing says what happens to a self-adjudication already
  recorded. No such row is known to exist -- `adjudication.ts` has no non-test
  caller on `main` at `d06cb930`, so the write path has never run in production
  -- but this entry does not rule on the case.

**Evidence this rests on.** `AdjudicationEligibilityInput` and
`resolveAdjudicationEligibility` in `apps/web/src/server/pilot/calibration/
blinding.ts` at `d06cb930` (role-only, no actor identity); `ANNOTATOR_ROLES`
admitting `organization_admin`; PR #900, which reported the overlap and pinned
the permissive behaviour rather than deciding it; and the measurement that
`adjudication.ts` has zero non-test importers on `main`, so nothing has been
written through this path yet.

Status (2026-09-28): the correction landed. #903 (`7bfd1a35`, 2026-08-29)
gave the primitive the actor's account id, and
`apps/web/src/server/pilot/calibration/blinding.ts:304-305` now refuses an
adjudicator who annotated the clip (`adjudicator_annotated_this_clip`).

---

## OD-2026-08-29-001 -- `Admin@punxsyprominence.org` is the primary owner email

**Provenance:** PRIMARY. Owner's words, 2026-08-29:
**"Admin@punxsyprominence.org is primarily owner email, stripe is not
registered yet and I approve/accept"**, answering a question put to him as an
OWNER_DECISION in PR #837.

**What was asked.** `PPBF_PRIMARY_OWNER_EMAIL` is deployed by production
(`secretref:ppbf-primary-owner-email`) and is NOT set by staging, so the two
environments resolve platform ownership by different routes. The 2026-07-31
platform audit recorded this and left it open: *"Staging is missing
PPBF_PRIMARY_OWNER_EMAIL, which production sets, so staging does not validate
the owner identity production enforces"*
(`docs/PLATFORM_AUDIT_2026-07-31_OWNER_DECISIONS.md`, under findings still
awaiting a decision). W19-S1 re-verified it as still open and refused to pick a
value, on the grounds that it decides who may hold platform ownership.

**The decision.** The authoritative platform-owner identity is
`Admin@punxsyprominence.org`.

**What that resolves, and it is more than it looks.** `getPrimaryOwnerEmail()`
in `apps/web/src/server/pilot/auth.ts` reads:

    return (process.env.PPBF_PRIMARY_OWNER_EMAIL?.trim()
            || 'admin@punxsyprominence.org').toLowerCase();

The hardcoded fallback is the same address, and the whole expression is
lowercased, so the owner's capitalisation and the code's are one identity. An
environment that does not set the variable therefore resolves to the address
just ratified rather than to some other one. Staging is such an environment.
The audit finding's premise -- that staging validates a *different* identity --
is narrower than it read: staging reaches the right identity by code default
instead of by secret.

**What this does NOT settle, stated so nobody reads it as settled.**

- **Whether production's secret actually holds this address.** `ppbf-primary-
  owner-email` is a Container App secret. No lane can read it from the
  repository, and nothing here is a claim about its contents. If it holds any
  other address, bootstrap and sign-in in production pin an owner this entry
  does not name, and that is a finding to raise -- not something to correct by
  editing code.
- **Whether staging should set the variable explicitly.** Not asked, not
  answered. The argument for setting it is that staging would then exercise the
  same mechanism production uses rather than a fallback; the argument against is
  that the resolved identity is already correct. A lane wanting to change
  `deploy-staging.yml` on this point needs its own decision.

**Evidence this rests on.** `auth.ts` `getPrimaryOwnerEmail()` at the SHA this
entry merges against; the `--set-env-vars` blocks of
`.github/workflows/deploy-production.yml` (sets it) and `deploy-staging.yml`
(does not); `docs/PLATFORM_AUDIT_2026-07-31_OWNER_DECISIONS.md`; PR #837, which
raised it and deliberately left it unchanged.

**Not recorded here: the Stripe half of the same message.** *"stripe is not
registered yet"* confirms an environment state, not a decision, and
`docs/current/ACTIVE_WORK.md` already carries it in the BLOCKED table with the
three variable names and the unblocking condition. This file's own scope note
sends work-queue state there. A second copy is how the deploy-status block
drifted, and one record is the point.

---

## OD-2026-08-28-009 -- `active` stays a browse filter; the write path is not narrowed to match

**Provenance:** PRIMARY. Owner's words: **"go with your recommendation"**,
against a recommendation to leave the asymmetry and document it.

**What was asked.** Whether `pilot.disciplines.active` should block writes, so
the write path agrees with the read path it already has.

**What is true today, measured.** `active` already governs the READ, on
purpose: `/api/pilot/multidiscipline` defaults `activeOnly: true`
(`route.ts:50`) under a comment stating the intent -- "a retired discipline is
one the gym no longer runs, and it should not sit in a browse list beside live
ones". No write path consults it. A Postgres foreign key cannot carry a
predicate, so enforcing it would mean a trigger or a service-layer check.

**The decision: leave it.** `active` is a curation and browse-list signal, not
an authorization. A gym may prepare material for a lane before switching it on,
and that is a feature rather than a gap -- `bjj` is the live case: registered,
inactive, hidden from the picker, and writable since OD-2026-08-28-002.

**What this decision buys, stated so nobody re-opens it by accident.**
Enforcement would have dragged a second ruling with it that nobody has made:
what happens to content already written under a discipline someone later
deactivates -- hidden, read-only, or untouched. Declining to enforce declines
that question too.

**What a lane must NOT infer.** This is not a finding that `active` is
decorative. It governs the browse list deliberately. Do not remove the
`activeOnly` default to make the two halves agree in the other direction.

---

## OD-2026-08-28-008 -- Every route under `app/api` must declare its gate

**Provenance:** PRIMARY. Owner's words: **"go with recommendation"**, against a
recommendation to build the guard, prefaced by **"i want to build it right even
if it take a bit more work"**.

**What it governs.** Nothing polices whether a NEW route ships with an access
gate. `coachingContentAccess.test.ts` derives its subject list from a hardcoded
three-entry map and never enumerates the directory. That is why this class of
defect recurs: the tenancy property got a directory-walking convention test and
the gate-declared property never did.

**What the guard asserts, and what it deliberately does not.** It asserts that
every exported HTTP handler either reaches a gate or appears in an allowlist
with a written reason. It does NOT encode which roles may reach which route --
that is an owner decision, and several remain open.

**Measured at the time of building:** 251 route files, 370 handlers; 354 reach
a session gate, 319 an authorization gate, 16 neither. Allowlist: 52 entries.

**Implemented in:** PR #816.

---

## OD-2026-08-28-007 -- The calibration creator must be a live account, and the act must be recorded

**Provenance:** PRIMARY. Owner's words: **"go with recommendation"**, against a
recommendation of *"add liveness, and write an audit event. Not a role gate."*

**What it governs.** `assertCreatorInOrganization` checks organization
membership only -- it reads neither `active_flag` nor `deleted_at`, while both
prior operator-identity mechanisms in this repository read at least one, and
its own docblock cites one of them as its analogue.
`pilot-approve-library-baseline.mjs` states the reason: "an attestation by an
account that cannot sign in is not an attestation."

The audit event addresses the other half. `created_by_account_id` is currently
recorded, transmitted to the browser, and read by nothing -- not the UI, not
adjudication, gold promotion, blinding, comparison or the QA read model, and no
audit row is written. Its docblock claims it is "the only record of who chose
these clips", which is true in the worst way.

**NOT decided, and explicitly excluded:** any role requirement. The owner ruled
that out of scope and it stays out. Liveness takes no view on role, which is
why it is inside the ruling.

**Sequencing, and a correction.** This entry originally said the audit half
needed a migration widening the `event_type` CHECK, and was therefore sequenced
behind PR #788. **That was wrong, and it was wrong when written.** It was
reasoned from the fact that `event_type` is a closed vocabulary rather than
checked against what the audit write actually needs. Established since, by
reading:

- `event_type` IS closed -- declared in `apps/web/src/server/pilot/auditEventTypes.ts`
  and again as a CHECK in `infra/azure/pilot_slice_postgres.sql:140`, held
  together by `auditEventVocabulary.test.ts`. But **`create` is already in it.**
- `entity_type` is `text not null` (`pilot_slice_postgres.sql:144`) with no
  CHECK, no enum and no foreign key. The only `entity_type` CHECK in the tree
  is on `pilot.shadow_audit_entries`, a different table.

So calibration carries its meaning in `entity_type`, which is the convention
`annotatorGate.ts` (lines 73-95) already documents and uses for
`calibration_annotation_set` and `calibration_annotation_event`. No migration,
no registration, no contention with #788.

**Implemented in:** the liveness half, PR #822, merged as `fe5fee79`. The audit
half, PR #844, `MIGRATIONS:  NONE`.

---

## OD-2026-08-28-006 -- The three discipline foreign keys are to be validated

**Provenance:** PRIMARY. Owner's words: **"go with recommendation"**, against a
recommendation to validate them.

**What it governs.** `NOT VALID` is a permanent marker in the catalog meaning
"we never checked these rows". We did check them, twice, on 2026-08-28. The
marker is now false, and leaving a false statement in the schema because
correcting it is tedious is the thing the owner's "build it right" instruction
forbids.

**How, when it is built.** Its own migration, guarded with
`if exists (... contype = 'f' ...)` so it cannot take an `all` dispatch down on
an environment lacking the key, sequenced AFTER PR #788, which already contends
with it on four files. Validation is idempotent (measured: a repeat run is 1 ms
and takes no lock on the registry), so the `all` chain stays safe.

**This also ratifies the B2 substitution.** B2 said PRECHECK and STOP; what
merged substituted `NOT VALID`. The substitution was MORE conservative than B2
asked for -- enforcement began immediately on both sides -- and the precheck B2
wanted was performed afterwards and came back clean. That is B2 closed out, not
departed from. No primary record of B2 exists in this repository.

**Implemented in:** deferred behind PR #788.

### What was measured, and on what instrument

All three
(`drill_library`, `session_scripts`, `cohort_definitions`) are installed
`NOT VALID`, so they govern new writes and have never scanned existing rows.
Production carries all three in that state -- read from the census run's own
job log, which printed `NOT VALID -- installed, enforcing new writes` for
each.

The mechanics were measured on PostgreSQL 18.4 (the version the repository's
own `.pg.test.ts` suites run against) rather than reasoned about, because the
cost is the whole decision:

| property | measured |
|---|---|
| blocks reads on either table | NO |
| blocks writes on either table | NO |
| blocks | `ANALYZE`, `CREATE INDEX`, `ADD COLUMN`, a second validate -- on the content table only |
| duration at production size (119 rows) | 1 ms |
| duration at 5,000,000 rows | 1.48 s |
| interruptible | yes; cancels clean, `convalidated` stays false |
| on failure | clean rollback, no partial state, constraint stays enforcing |
| re-run on an already-validated constraint | 1 ms, no re-scan, no lock on the registry |

That last row is what makes it safe under the `all` chain, which re-runs every
migration on every dispatch: a repeat validate is a catalog no-op.

**A `NOT VALID` foreign key protects the REFERENCED side too, and this is
written down nowhere else.** Measured: deleting a registry row that a
never-scanned child row references is refused 23503; renaming a registry key
is refused; inserting or updating a child row to an unregistered discipline
is refused. So no legal SQL can create a violating row from either direction.
That makes the CLEAN census durable rather than perishable -- the only ways
past it are disabling triggers (zero occurrences in the tree), a
`pg_restore --disable-triggers`, or dropping the constraint.

What the safeguarding argument in the three migration headers cares about is
therefore ALREADY enforced, for everything except rows written before
2026-08-28 -- of which the census measured zero.

There is no precedent to follow: `validate constraint` appears in no
executable SQL anywhere in this repository. Whatever is decided sets the
precedent.

RESOLVED 2026-08-28 -- and the resolution was already written down, which is
the more useful half of this entry.

`docs/current/PRODUCTION_STATE.json` carries a top-level key
`production_reference_data_2026-08-24` reading "SEEDED. seed-reference-data run
32788628209 (target=production ...) completed success 2026-08-24T23:25:48Z
against ppbf-pg-195892 ... drill_library 119, disciplines 5,
cohort_definitions 6, session_scripts 3 ... every one reporting '0 already
present', i.e. a genuine first fill of an empty production catalog set". So the
119 / 3 / 6 figures are production figures, and the CLEAN census scanned real
rows rather than empty tables -- which is what makes it evidence rather than a
tautology.

A CORRECTION TO THIS ENTRY'S EARLIER TEXT, kept rather than quietly
overwritten. It previously said the same file's `known_production_gaps` entry
-- "seed-reference-data has never been run against production", drill_library
and disciplines "both count 0 rows", 2026-08-15 -- was stale by nine days and
was a release-lane defect to correct. **That framing was wrong.** The gaps
carry a sibling `known_production_gaps_note` stating they "have not been
re-checked ... and are carried as history, not as a current statement". The
file labels them as history AND records the correction elsewhere in itself.
There is no uncorrected defect, and nothing here for the release lane to fix.

How the error was made, since the shape recurs: the file was grepped rather
than read; the contradiction was then resolved the long way, from a workflow
run's job log; and the conclusion was stated wider than the search behind it.
The run-log evidence was accurate -- it was simply redundant, and the framing
built on top of it was not.

The B2 ruling that preceded the FKs said PRECHECK and STOP; what merged
substituted `NOT VALID`. That substitution has not been ratified, and no
primary record of B2 exists in this repository (searched: `git grep -i` for
`\bB2\b` and `precheck|pre-check` over all tracked files). Note the
substitution was MORE conservative than B2 asked for, not less: enforcement
began immediately on both sides, and the precheck B2 wanted was performed
afterwards and came back clean.

Status (2026-09-28): "Implemented in: deferred behind PR #788" is out of date.
#853 (`40cc66c4`, merged 2026-08-29) added the validation as its own migration,
`infra/azure/pilot_slice_postgres_discipline_fk_validation_migration.sql`;
whether it has been applied to production is not recorded here. The paragraph
just above saying the B2 substitution "has not been ratified" conflicts with
this entry's own "This also ratifies the B2 substitution". Both were written in
the same commit (`4e36547d`, #791). OD-2026-09-28-010 item 16 settles it: B2 is
closed out.

---

## OD-2026-08-28-005 -- The drill and cue read policy governs the content CLASS, not three named routes

**Provenance:** PRIMARY. Owner's words: **"go with recommendation"**, against a
recommendation that it governs the content class.

**What it governs.** OD-2026-08-27-001 named three surfaces.
`/api/pilot/session-scripts` and `/api/pilot/workout-templates` serve the same
content class through different URLs -- session-script blocks carry
`what_to_say`, `what_to_explain`, `what_to_watch`, `what_to_fix` and
`drill_id`, which is cue-shaped coaching craft by any reading. Both were
ungated: authentication alone, reachable by every role including `board`.

The ratified rationale was written about the ROLE, not the URL -- "an oversight
/ aggregate-governance role, not an operational coaching-content role" -- and
on its own terms it reaches these surfaces as directly as anything could.

**What changes.** Both now gate on `COACHING_CONTENT_READER_ROLES`. `board`
loses a direct API read it previously had. It never had a UI door: both coach
pages already gate to `['coach','admin']`.

**What does not change.** `/api/pilot/session-scripts/runs/**` was already
gated and carries per-night athlete data -- a different class, already decided.
Authoring is untouched.

**Implemented in:** PR #817.

---

## OD-2026-08-28-004 -- The schema verifier reads the real apply order

**Provenance:** PRIMARY. Owner's words: **"go with B"**.

**What B was, as put to him:** teach `apps/web/scripts/pilot-verify-schema.mjs`
the real migration order by reading the `all` list from
`.github/workflows/apply-migrations.yml`, rather than (A) renaming the
migration file so filename sort happens to come out right, or (C) adding a
hand-maintained list of retired constraints.

**What it governs.** The verifier inferred apply order from filename sort. The
real order is the `all` list, which is explicitly "Dependency order, matching
the sequence these were introduced in" and is not alphabetical. The two
diverge, and the verifier's own comment documented the failure mode before
anything hit it.

**Evidence.** CI run 33186583252 on PR #788 failed
`schemaVerification.pg.test.ts` in two cases against a correctly migrated
database, because `..._drill_library_check_drop_...sql` sorts BEFORE
`..._drill_library_v3_...sql` while applying after it. This gate runs before a
deploy, so the false failure would have blocked deploys.

**Known cost, accepted:** it changes a pre-deploy safety gate. The owner was
told that, and that a parse returning an empty list would make the gate
vacuous -- passing everything, while green -- which is why the parse must fail
loudly rather than degrade.

**Implemented in:** PR #788.

---

## OD-2026-08-28-003 -- drill-library-v3 keeps the CHECK, gated; the FK runner tripwire goes

**Provenance:** PRIMARY. Owner's words: **"go with A"**.

**What A was, as put to him:** keep both edits to already-applied migrations --
`drill_library_v3` installs `pilot_drill_library_discipline_check` only while
neither it nor `pilot_drill_library_discipline_fk` is present, and
`pre_existing_check_intact` is removed from the FK runner. The alternatives
were (B) delete the CHECK from v3 outright, and (C) leave v3 alone.

**Why it was needed.** The `all` chain re-runs every migration on every
dispatch, so an unconditional `if not exists` puts a dropped constraint
straight back. Worse, `alter table ... add constraint ... check` VALIDATES
existing rows: once any gym files a `bjj` drill -- the entire point of
OD-2026-08-28-002 -- that statement fails with 23514 and takes the whole
dispatch down. Measured, not predicted, with that exact error.

**The gate's invariant:** whichever of the two constraints is not yet
installed, the other one is. The column is never ungoverned in either
direction.

**Known cost, accepted:** `drill_library_v3` on disk no longer matches what was
originally applied to production. Under a re-run-everything model a migration
file is a description of desired state rather than a record of history, but
anyone auditing "what did we apply" needs to know that.

**Implemented in:** PR #788.

---

## OD-2026-08-28-002 -- The drill library discipline CHECK is retired; the registry governs

**Provenance:** PRIMARY. Owner's words: **"drop the check and let the registry
govern"**.

**What it governs.** `pilot.drill_library.discipline` had two gates:
`pilot_drill_library_discipline_check`, a five-literal CHECK
(`boxing, wrestling, combatives, conditioning, general`), and
`pilot_drill_library_discipline_fk`, the composite `(organization_id,
discipline)` key into `pilot.disciplines`. The CHECK is dropped. The registry
is now the sole authority.

**Evidence it was safe.** Read-only census against PRODUCTION, run
33175617223, 2026-08-28T14:17Z: `PILOT DISCIPLINE VALUE CENSUS: CLEAN` -- 0
organizations with no discipline registry, and 0 rows in `drill_library`,
`session_scripts` or `cohort_definitions` naming a discipline the registry does
not hold. Staging returned the same in run 33170182546. That is a snapshot,
not a guarantee about the future.

**Consequences, measured:**

- `bjj` was registered but refused by the CHECK (23514). It is now writable.
  This is the only value whose behaviour changes.
- `general` was refused before and is refused after, both times **23503**, by
  the foreign key. It passes the CHECK, so the CHECK was never what stopped
  it. No production row holds it.
- A gym may now write content under any discipline it registers. The
  five-literal cap applied to every gym regardless of what it had registered;
  that cap is gone. This is the substance of "let the registry govern" and it
  is a real widening, deliberately chosen.

**Not decided here, and untouched:** validating the FKs, and whether the
registry's `active` flag should block writes. See Open questions.

**Implemented in:** PR #788.

Status (2026-09-28): both questions were since decided -- validating the FKs
by OD-2026-08-28-006, and the `active` flag by OD-2026-08-28-009 (it stays a
browse filter).

---

## OD-2026-08-28-001 -- Production `run-checks` dispatch belongs to the release lane

**Provenance:** PRIMARY. Owner's words: **"there is another flow that is in
charge of getting thing to staging and production"**, and then **"cancel the
census run and let the release lane dispatch it"**.

**What it governs.** `AGENT_KERNEL.md` line 363 gives the release-control lane
ownership of "main, migrations, staging and production", but the build lane's
explicit MAY NOT list at lines 369-370 names only `apply-migrations`,
`deploy-staging` and `deploy-production`. `run-checks` is absent, and its own
header argues it is a different class of thing because it cannot write. A
build lane dispatched it against production on that reading. The ownership
sentence wins: **a build lane does not dispatch `run-checks` against
production.** Read-only is not an exemption.

**Note on the instruction itself.** The run could not be cancelled -- it had
been approved and had completed at 14:17Z, roughly forty minutes before the
instruction arrived, and GitHub returned `409 Cannot cancel a workflow run
that is completed`. The result is recorded under OD-2026-08-28-002.

Status (2026-09-28): SUPERSEDED by OD-2026-09-28-010 item 8. A Claude session
may run a read-only production check -- a query or a check run that changes
nothing -- when Jason says so, for that run. The kernel lines cited above
("line 363", "lines 369-370") are as `AGENT_KERNEL.md` stood at `4e36547d`
(#791, 2026-08-28, the commit that added this entry); the kernel has been
rewritten since, and those line numbers no longer point there.

---

## OD-2026-08-27-001 -- Drill and cue library read policy

**Provenance: RECONSTRUCTED.** No primary record of this decision exists
anywhere in the repository. The text below is quoted from PR #755's `SCOPE`
block, which was written by a lane after the ruling, not by the owner. The
owner confirmed the decision was his ("Yes, that decision was mine -- review
those four PRs against it"), but the wording is a lane's transcription.

**The decision as transcribed:**

> `board` DENY ("oversight / aggregate-governance role, not an operational
> coaching-content role"); `platform_owner` ALLOW, organization-scoped ("only
> through the organization scope carried by the authenticated principal ...
> does NOT create a cross-organization wildcard"); existing authorized
> org-member roles preserved; "Do NOT broaden direct `/api/pilot/drills`
> POST/PATCH authoring merely because `platform_owner` receives read access."

**What is uncertain.** The time. It falls between 2026-08-27T23:02:30Z (PR
#754 opened, its body still calling the question open) and 2026-08-28T00:01:33Z
(commit `de99a1ab`, quoting the decision as made). That bracket is derived from
two artifacts' timestamps, not read from any record.

**What it cost.** #754 merged as `81e27e72` at 2026-08-28T13:53:00Z carrying
pre-ratification expectations -- `it('admits board and platform_owner, ...')`
and assertions that the routes held no role gate at all. For that window both
`/api/pilot/drill-library` and `/api/pilot/coach/cue-library` on `main`
imported only `requirePrincipal`, so `board` could read gym-wide coaching
content contrary to this decision. The content carries no athlete data, so it
was a ratified access decision not in force rather than a data exposure.

**Status: IN FORCE.** #755 merged as `61b20e9d` at 2026-08-28T15:08:21Z and
closed that window. Verified on `origin/main`: both routes now call
`requireRole(principal, [...COACHING_CONTENT_READER_ROLES])` on the line
immediately after `requirePrincipal`, before any query parsing -- read from the
files, not inferred from the merge. The contradiction stood for roughly 75
minutes.

---

# Open questions -- NOT decided

A session that needs one of these answered must say so and stop. Do not resolve
them by building. Both also appear, with every other open owner question, in
`docs/current/ACTIVE_WORK.md` under "Open owner questions" and PARKED; that
list is the one kept current.

- **A real `general` row, should one ever appear.** None exists in production
  or in any seed or fixture today. `general` is refused by the foreign key, so
  one could only arrive by a write that predates the key.

- **What `pilot.drill_library.source_ref` means.** OD-2026-09-15-001 ruled on
  `pilot.drill_cues.source_ref` and deliberately did not extend to the drill
  column, which carries the same name across 119 drills under the migration's
  three-way comment -- "provenance: source manual, lineage, or registry claim".
  Until it is ruled, the same column name is documented two ways: precisely for
  cues, disjunctively for drills. Do not assume the cue ruling governs it, and do
  not change either the drill column or its comment on the strength of the cue
  ruling alone.

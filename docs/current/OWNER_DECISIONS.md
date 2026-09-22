# Owner Decisions

The record of decisions Jason has actually made, in his own words, with the
evidence each was made on.

This file exists because a decision that lives only in a chat log is not a
decision any lane can check. On 2026-08-27 the drill/cue read policy was
ratified and written down nowhere. #754 merged the next day as `81e27e72`
carrying test expectations that asserted the opposite -- `board` admitted to
the drill library -- and `main` shipped code contradicting a ruling that had
already been made. Establishing *when* the ruling happened later took an hour
of forensics across PR bodies and commit timestamps, and produced only a
one-hour bracket, because the sole trace was an undated code comment on an
unmerged branch. That is the cost this file is here to stop paying.

## What belongs here

A decision the owner made that governs code, schema, policy, or lane
behaviour, where a lane could otherwise build the opposite in good faith.

Not here: work assignments, scope for a single ticket, or anything a lane may
decide for itself. `docs/current/ACTIVE_WORK.md` is the work queue.
`docs/current/AI_RELEASE_CONTROL.md` is the record of release decisions --
what was frozen, refused, or abandoned -- and it stays there.

## How to use it

**Before writing a test, gate, or migration that asserts a policy, read this
file.** If the policy is here, build to it. If it is not here and you need it
decided, say so and stop -- `AGENT_KERNEL.md` classifies that as
**OWNER DECISION REQUIRED**, and inventing the answer is the failure mode this
file was written after.

If code you are reading contradicts an entry here, that is a finding. Report
it. Do not assume the entry is stale.

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
  replaces and why.

Newest first.

## A pattern this file exists to shorten

Twice on 2026-08-28, `main` carried a test suite asserting the opposite of a
ruling the owner had already made, and in both cases an open PR was the
correction:

| ruling | `main` asserted the opposite in | corrected by | window |
|---|---|---|---|
| OD-2026-08-27-001 (board denied) | #754, merged `81e27e72` | #755, merged `61b20e9d` | ~75 minutes |
| OD-2026-08-28-005 (content class) | #811, merged `948f6d18` | #817 | open at time of writing |

The two are not the same failure and should not be filed as one.

#754 is the one this file was written after. Its expectations were already
wrong when it merged, and nothing in the repository recorded the ruling that
made them wrong, so no lane could have known.

#811 is the honest version. It was written BEFORE the ruling, its body said in
terms that the posture was open and unsettled, and its tests pinned the current
behaviour precisely so a change could not happen silently. Then the ruling
came, and the pin did exactly what a pin is for: it made the correction
explicit and reviewable instead of invisible.

**So a characterization test that merges and is then inverted is not a defect.**
The defect is a test that asserts a posture while claiming, in a comment, to
pin a decision it cannot detect a change to -- which is what #811 was itself
written to fix in two other files.

What this file can shorten is only the first shape: a lane about to assert a
policy can now check whether one has been ruled. It cannot prevent the second,
and should not try to.

---

## OD-2026-09-21-001 -- Claude builds, ChatGPT designs and enforces standards; product direction; minors' limits are coach-set data

**Provenance: PRIMARY.**

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

What that means for this repository:

1. ChatGPT designs (product and system specs, work orders) and enforces
   standards (reviews). Jason approves a design before it is built. ChatGPT
   stays read-only here.
2. Claude builds from approved work orders. Storage writes and the ledger are
   ChatGPT's; Claude writes there only when a ChatGPT write fails.
3. Grok keeps visual design and visual implementation.

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

1. The in-app AI teaches and drafts; the coach decides. No AI output is a
   diagnosis.
2. Limits for a minor -- heat exposure, percentage of body weight, contact
   level, supervision -- are coach-set **data**. They are not constants in
   code and not values the AI chooses.
3. Where a feature needs one of those limits and none is set, the AI asks for
   it. It does not fill in a default.
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

A lane that needs one of these answered must say so and stop. Do not resolve
them by building.

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

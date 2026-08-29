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

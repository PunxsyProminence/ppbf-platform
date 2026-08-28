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

RESOLVED 2026-08-28, and it decides what the CLEAN result is worth.
`docs/current/PRODUCTION_STATE.json` states under `known_production_gaps`
that "seed-reference-data has never been run against production" and that
`pilot.drill_library` and `pilot.disciplines` "both count 0 rows",
re-observed 2026-08-15. The three migration headers record 119 / 3 / 6 rows
observed 2026-08-24, from seed-reference-data run 32788628209. Both cannot
describe one database.

The run's own job log settles it. Its "Record What Ran" step printed
`PPBF_EXPECTED_POSTGRES_HOSTNAME: ppbf-pg-195892.postgres.database.azure.com`
and `ORG_SOURCE: app-ppbf-production default org secret`, and
PRODUCTION_STATE.json names that same hostname as production. The job was
created 23:16:57Z and started 23:23:56Z -- a seven-minute wait consistent
with the production environment gate, where staging runs start in seconds.

So seed-reference-data DID run against production, on 2026-08-24, and
`PRODUCTION_STATE.json`'s gap entry is stale by nine days. The 119 / 3 / 6
figures are production figures. **The CLEAN census therefore scanned real
rows rather than empty tables**, which is what makes it evidence rather than
a tautology.

That stale entry is in a release-lane document a build lane may not edit
(`AGENT_KERNEL.md`, Lane model). It is reported here rather than corrected.

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

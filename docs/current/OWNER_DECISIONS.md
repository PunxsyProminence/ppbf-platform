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

- **Validating the three discipline foreign keys.** All three
  (`drill_library`, `session_scripts`, `cohort_definitions`) are installed
  `NOT VALID`, so they govern new writes and have never scanned existing rows.
  The census (OD-2026-08-28-002) establishes that `validate constraint` would
  currently succeed against both production and staging, so the risk that
  deferred this is measured and gone -- but the decision to run it, and who
  runs it, has not been made. The B2 ruling that preceded the FKs said
  PRECHECK and STOP; what merged substituted `NOT VALID`. That substitution
  has not been ratified.
- **Whether `pilot.disciplines.active` should block writes.** Three of the five
  seeded disciplines ship `active = false` (wrestling, bjj, combatives) --
  including `bjj`, which OD-2026-08-28-002 just made writable.

  The question is NOT whether `active` means anything. It already governs the
  READ, deliberately: `/api/pilot/multidiscipline` defaults `activeOnly: true`,
  under a comment that says "a retired discipline is one the gym no longer
  runs, and it should not sit in a browse list beside live ones"
  (`apps/web/app/api/pilot/multidiscipline/route.ts:50`). The question is
  whether the WRITE path should agree with the read path it already has. Today
  it does not: a discipline filtered out of the picker is still writable by a
  direct API call, because the foreign key checks registration and a Postgres
  foreign key cannot carry a predicate.

  OD-2026-08-28-002 sharpened this. With the literal CHECK gone, registering a
  discipline is now SUFFICIENT to write under it, so `active` is the only
  remaining distinction between "this gym registered it" and "this gym runs
  it" -- and it applies on one side only.

  Scope of that check, stated so it can be re-run: every non-test reference to
  `pilot.disciplines` in `apps/web` app code is three files --
  `multidiscipline.ts:45` (the only SELECT), `disciplineSeeds.ts:143` (the
  seeder's INSERT), and the read-only census script. No write path for
  `drill_library`, `session_scripts` or `cohort_definitions` consults it.

  Enforcing it means a trigger or a service-layer check, and it drags a second
  ruling with it: what happens to content already written under a discipline
  that is later deactivated. Leaving it is also a defensible answer -- a gym
  may want to prepare material for a lane before switching it on.
- **Actor provenance on the calibration bootstrap.** `created_by_account_id` is
  checked for organization membership only; `assertCreatorInOrganization` takes
  no view on role. The owner ruled role policy explicitly out of scope for
  PR #760. It remains open.
- **A real `general` row, should one ever appear.** None exists in production
  or in any seed or fixture today. `general` is refused by the foreign key, so
  one could only arrive by a write that predates the key.

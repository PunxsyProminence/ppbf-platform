# Intervention evidence and outcome review -- gates

Documentation only. Nothing imports this file and no page renders it.

## What this capability is

The loop-closing layer of the intervention chain (register module 026 slice 3):
DECISION -> PLANNED -> ACTUAL -> WHAT HAPPENED -> WHAT WE LEARNED.

Two records about a named child:

- **Evidence links** (`pilot.intervention_evidence_links`) -- typed citations
  attaching an existing record to one intervention execution, each with a
  semantic role (`baseline`, `immediate_post`, `retention`, `counterevidence`,
  `adverse_response`, ...). A link is a claim that *this* record is relevant to
  *that* intervention on *that* athlete.
- **Outcome reviews** (`pilot.intervention_outcome_reviews`) -- one human
  verdict per execution, split into three separate answers: what happened
  (performance), what happened to the belief (hypothesis), and what the episode
  revealed (learning). Never one score.

Surface: `app/api/pilot/coach/intervention-review/route.ts` (GET the chain,
POST `link_evidence` / `review_outcome`, PATCH `remove_evidence`).
Server module: `src/server/pilot/interventionEvidence.ts`.
Schema: `infra/azure/pilot_slice_postgres_intervention_evidence_migration.sql`.

## What it may do

- Record that a coach, organization admin or admin cites an existing record as
  evidence for or against an intervention on an athlete in their own
  organization.
- Record a human outcome verdict on a closed execution, and supersede an
  earlier verdict when the coach re-reviews.
- Stamp a link as removed with a stated reason.
- Write a `pilot_audit` event for every mutation (create link, create review,
  remove link).
- Read back the chain: execution, decision text, links, active review.

## What it may NOT do

- Compute a verdict, a score, a percentage or an information-gain number. Every
  vocabulary in the module is closed prose; there is no numeric outcome field
  anywhere in it.
- Make a causal claim. The ledger preserves provenance for later inference by
  humans; it does not infer.
- Cite a record belonging to another organization, or to a different athlete
  than the execution's.
- **Cite a Film Study observation no coach has accepted.** An AI observation
  about a child becomes admissible evidence only through a human verdict.
- Write to the decision loop, to Film Study proposals, or to any source table.
  `getDecisionTexts` is a read-only join; `EVIDENCE_SOURCES` queries are
  `select 1` existence checks.
- Delete anything. Links are stamped `removed` with a reason; reviews are
  superseded, not overwritten.

## Gates

### 1. Film Study proposals must be accepted before they are evidence

- **What it checks:** the cited proposal's `review_state` is in
  `ADMISSIBLE_FILM_STUDY_REVIEW_STATES` -- today exactly `['accepted']`. The
  list is an allow-list bound by `as const satisfies readonly
  FilmStudyProposalReviewState[]` to the union owned by
  `shadowFilmStudyProposals.ts`, and the SQL clause is generated from it, so a
  review state that is not written into that list is inadmissible. A new
  verdict kind (PR #419 is adding some, plus a revision chain) arrives
  inadmissible and stays that way until somebody deliberately classifies it.
- **Where it runs:** `src/server/pilot/interventionEvidence.ts` --
  `EVIDENCE_SOURCES.film_study` (`... and review_state in ('accepted')`),
  executed by `linkEvidence`.
- **What it refuses with:** no row from the source query -> `linkEvidence`
  returns `null` -> `route.ts` POST `link_evidence` returns `hiddenNotFound()`:
  **HTTP 404, body `{"error":"Not found"}`**, and no audit event is written.
  Deliberately the same response as "no such proposal" (see *Deliberately not
  gated*).
- **Why it exists:** a Film Study proposal is a vision model's claim about an
  identifiable minor. `shadowFilmStudyProposals.ts` exists so that claim never
  touches an athlete record until a coach attests to it (#103, owner-approved
  2026-07-31), and it keeps `rejected` always reachable so a coach can say "the
  model is wrong about this child". Before this gate, the evidence query read
  only organization and athlete: a coach could reject an observation on Monday
  and the same observation could stand on Friday as formal evidence that an
  intervention on that child worked -- and an observation nobody had reviewed
  at all was equally citable. The rejection was recorded and then ignored by
  the one query that most needed to read it.

### 2. Every cited source must belong to this organization and this athlete

- **What it checks:** each per-kind query in `EVIDENCE_SOURCES` binds `$1`
  organization and `$3` athlete (the execution's own `athlete_id`), so a
  teammate's attempt or another gym's row cannot evidence this athlete's
  execution. An `activity_log` row with no athlete cannot evidence one.
- **Where it runs:** `src/server/pilot/interventionEvidence.ts` --
  `EVIDENCE_SOURCES` (all five kinds), executed by `linkEvidence`.
- **What it refuses with:** **HTTP 404 `{"error":"Not found"}`** via
  `hiddenNotFound()`, no audit event.
- **Why it exists:** an intervention record that silently mixes two children's
  data is worse than no record: it produces a confident conclusion about a
  child from another child's performance, and cross-org leakage exposes a
  minor's training data to an unrelated gym.

### 3. Only a current execution in the caller's organization can be evidenced

- **What it checks:** `getExecution` returns a row for this organization and
  the row's `status` is not `superseded`.
- **Where it runs:** `src/server/pilot/interventionEvidence.ts` --
  `linkEvidence`.
- **What it refuses with:** **HTTP 404 `{"error":"Not found"}`**.
- **Why it exists:** evidence attached to a superseded version of an execution
  is evidence about a plan that was replaced; it would be read later as though
  it described what was actually done.

### 4. An outcome verdict requires a closed execution

- **What it checks:** the execution's `status` is `completed` or `stopped`.
- **Where it runs:** `src/server/pilot/interventionEvidence.ts` --
  `reviewOutcome`.
- **What it refuses with:** **HTTP 404 `{"error":"Not found"}`**.
- **Why it exists:** a verdict recorded mid-intervention is a guess that later
  reads as a finding, and "it worked" recorded early is exactly the claim that
  justifies pushing a child harder.

### 5. Staff-only, and not platform accounts

- **What it checks:** an authenticated principal (`requirePrincipal`, which
  also refuses an account still on its bootstrap PIN), then
  `requireRole(principal, ['coach', 'organization_admin', 'admin'])`.
  `platform_owner`, `athlete` and `parent` are all outside that list.
- **Where it runs:** `app/api/pilot/coach/intervention-review/route.ts` --
  `GET`, `POST`, `PATCH`, using `src/server/pilot/http.ts:requirePrincipal` and
  `src/server/pilot/access.ts:requireRole`.
- **What it refuses with:** **HTTP 401 `{"error":"Unauthorized"}`** with no
  session; **HTTP 403 `{"error":"Forbidden: PIN change required before using
  this account"}`** on a bootstrap PIN; **HTTP 403 `{"error":"Forbidden: role
  not allowed"}`** for any other role.
- **Why it exists:** these records are judgments about what a specific child's
  training did to them. An athlete or parent writing them would be recording a
  coaching finding as staff; a platform-level account has no coaching
  relationship with the child at all.

### 6. Closed vocabularies -- no invented role, kind or verdict

- **What it checks:** `evidenceRoleError`, `sourceKindError`,
  `performanceResultError`, `hypothesisResultError`, `learningSignalError`, and
  a non-blank `performance_notes`.
- **Where it runs:** `app/api/pilot/coach/intervention-review/route.ts` --
  `POST` (before any module call), backed by the same constants in
  `interventionEvidence.ts` and by check constraints in the migration.
- **What it refuses with:** **HTTP 400** carrying the reason, e.g.
  `{"error":"evidence_role must be one of: baseline, during_intervention, ..."}`,
  `{"error":"source_kind must be one of: ..."}`,
  `{"error":"performance_notes is required -- what happened, in human words."}`,
  `{"error":"Missing execution_id."}`, `{"error":"Missing source_id."}`,
  `{"error":"action must be 'link_evidence' or 'review_outcome'."}`. All are
  `ValidationError` (a `PilotError`), so `jsonError` discloses the message
  instead of scrubbing it.
- **Why it exists:** an invented role like `proof_it_worked`, or a `source_kind`
  of `vibes`, turns the ledger from typed provenance into free text that reads
  as proof. A percentage in `performance_result` would become a number somebody
  averages.

### 7. Removal is a stamp, not a delete

- **What it checks:** `removed_reason` is present and non-blank, and the link
  is still `active`.
- **Where it runs:** `app/api/pilot/coach/intervention-review/route.ts` --
  `PATCH` (reason required), and
  `src/server/pilot/interventionEvidence.ts:removeEvidence` (`... and status =
  'active'`). The migration also refuses `status = 'removed'` with a blank
  reason at the row level.
- **What it refuses with:** **HTTP 400 `{"error":"Removing evidence requires
  removed_reason -- links are stamped, never erased."}`**;
  **HTTP 400 `{"error":"Missing link_id."}`**;
  **HTTP 400 `{"error":"action must be 'remove_evidence'."}`** for any other
  action; **HTTP 404 `{"error":"Not found"}`** when the link is not an active
  link in this organization.
- **Why it exists:** silently unlinking evidence rewrites the history of a
  judgment about a child. The record has to show that a citation was withdrawn
  and why.

### 8. Database-level honesty rules on a verdict

- **What it checks:** a declined or unchanged performance cannot carry a
  supported or partially-supported hypothesis
  (`pilot_intervention_reviews_miss_check`); confounded or insufficient
  evidence cannot strengthen a prior belief
  (`pilot_intervention_reviews_confound_check`); one active review per
  execution (`idx_intervention_reviews_one_active`); the same source in the
  same role on the same execution cannot be linked twice
  (`idx_intervention_evidence_no_duplicates`).
- **Where it runs:** `infra/azure/pilot_slice_postgres_intervention_evidence_migration.sql`
  (check constraints and partial unique indexes), hit through
  `interventionEvidence.ts:reviewOutcome` / `linkEvidence`.
- **What it refuses with:** a Postgres error (`23514` check violation, `23505`
  unique violation). Its message matches none of `jsonError`'s recognized
  prefixes and it is not a `PilotError`, so the caller receives
  **HTTP 500 `{"error":"Internal server error"}`** with the detail logged
  server-side. The write is refused, but the reason does not reach the coach --
  a known rough edge, not fixed in this lane (scope: one concern per branch).
- **Why it exists:** "it declined but the hypothesis was supported" is how a
  failed intervention gets recorded as a success and then repeated on the next
  child.

## Deliberately not gated

- **Links recorded before this gate existed are not re-checked or backfilled.**
  A link to a rejected or unreviewed Film Study proposal created before this
  change stays `active` until a human removes it via `remove_evidence`. No
  migration and no data change were made here (this lane adds no migration by
  constraint), and `listEvidence` does not re-validate sources on read.
- **Admissibility is checked at link time only.** Today that is sound because
  settlement is one-way: `resolveFilmStudyProposal` only settles a proposal in
  `pending_review`, so an `accepted` proposal cannot later become `rejected`.
  PR #419's revision chain may create a way for an accepted proposal to be
  revised or superseded; nobody has decided what that means for an evidence
  link already citing it, and this lane did not decide it either.
- **A rejected proposal and a nonexistent one are indistinguishable to the
  caller.** Both are `404 {"error":"Not found"}`. That is the `hiddenNotFound`
  convention `http.ts` and `errors.ts` record for per-record lookups, so the
  route cannot be probed to learn that a proposal about a child exists. The
  cost is real and accepted: a coach who cites a rejected proposal sees the
  same response as a coach who mistyped an id, and the reason is documented
  here rather than returned.
- **The other four source kinds have no state or quality gate.** A training
  attempt, readiness entry, assessment or activity row is citable as soon as it
  exists for that athlete in that organization. Those are records of things
  that happened; only Film Study is a model's claim awaiting a human. Nothing
  in this capability calls `readinessMath.ts` / LEGACY-READINESS -- the
  `readiness` kind cites recorded `pilot.readiness` entries and nothing
  computes from them here.
- **Whether the role a coach chose is honest.** Nothing stops filing
  counterevidence as `immediate_post`. The role vocabulary is closed but the
  choice is a human judgment the ledger records; the server cannot verify it.
  `counterevidence` and `adverse_response` exist as first-class roles precisely
  so the honest choice is available.
- **Whether evidence supports the verdict.** A review can be recorded with no
  links at all, and the module makes no causal claim either way. Requiring
  links would invite fabricated ones.
- **Coach-to-athlete assignment.** Any coach in the organization may cite and
  review any athlete in that organization; there is no `coach_id`-of-record or
  coverage-grant check on this route, unlike some other coach surfaces.
  Unchanged by this lane and called out here because it is easy to assume
  otherwise from gate 2.

## Verified by

- `src/server/pilot/interventionEvidence.test.ts` -- the `film study: only an
  accepted proposal is evidence about a child` block pins gate 1: the allow-list
  is exactly `['accepted']`; `rejected` and `pending_review` are refused; five
  hypothetical future verdict kinds and `undefined`/`null`/`''` are all
  inadmissible; the `review_state in (...)` clause is parsed back out of the
  real query string and must equal the constant (so the two cannot drift, and a
  clause that grew a second state fails); no other source kind gained a
  `review_state` condition; `linkEvidence` on a film-study source whose query
  returns nothing returns `null`, issues exactly one query, and runs no
  `insert`; an accepted proposal still links, unmodified, on that same query.
  The same file pins the closed vocabularies of gate 6 and the org/athlete
  binding of gate 2.
- `app/api/pilot/coach/intervention-review/route.test.ts` -- gate 5 (athlete,
  parent and `platform_owner` are all refused), gate 6 (invented role and kind
  are 400s; blank `performance_notes` is a 400), gate 7 (missing
  `removed_reason` is a 400; unknown actions are 400s), and that a `null` from
  `linkEvidence` becomes a 404 with **no** audit event.
- `src/server/pilot/interventionEvidence.pg.test.ts` -- gate 8 against real
  Postgres (miss/confound checks, one-active-review index, duplicate-link
  index, removal requires a reason), and gate 2 executed against the real
  source tables for `training_attempt` and `readiness`.

Honest gap: gate 1 has **no Postgres-level proof**. The film-study proposals
migration is not among the `LAYERED_MIGRATIONS` of
`interventionEvidence.pg.test.ts`, so that suite has no
`pilot.shadow_film_study_proposals` table to query, and adding it was out of
scope for this lane (embedded-Postgres suites are not run here). Gate 1 is
therefore pinned at unit level in two independent ways -- the predicate and the
parsed SQL clause -- rather than by executing the query against a real rejected
row.

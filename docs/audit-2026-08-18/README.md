# Full-spectrum audit — 2026-08-18

**Status: RUNNING.** Started 2026-08-18. This file is written before any finding
exists, and updated as the work happens. If a section below says "not started",
that is the truth at the moment you are reading it — not a placeholder somebody
forgot to fill in.

Pinned to `origin/main` at `04dd116b` ("main is red: give the justification map
its two missing rules (#451)", 2026-08-17 18:09 -0400). Work merged after that
commit is out of scope for the *findings*; it is in scope for checking whether a
finding is already fixed.

---

## What is being audited

Everything. That is the instruction, so here is what "everything" measures on
`origin/main`, counted rather than estimated:

| Surface | Count |
|---|---|
| API endpoints (`apps/web/app/api/**/route.ts`) | 228 |
| Screens (`apps/web/app/**/page.tsx`) | 125 |
| Server domain modules (`apps/web/src/server/pilot/*.ts`) | 429 |
| — of those, unit tests | 281 |
| — of those, Postgres-backed tests | 93 |
| React components | 86 |
| SQL migrations (`infra/azure/*.sql`) | 88 |
| Capability module docs | 201 |
| TypeScript files total | 1,278 |
| Documentation files under `docs/` | 425 |

## Why another audit

Two already exist and neither is being redone:

- The **capability-network audit** (published as `docs/capabilities/NETWORK_STATUS.md`)
  mapped 34 capabilities as a read/write graph and found the cross-capability
  defects — what writes a register somebody else reads.
- The **full-spectrum audit** at `docs/PLATFORM_AUDIT_2026-08-17_FULL_SPECTRUM.md`
  (on branch `claude/app-audit-ux-ui-report-78o4cm`) covered role-by-role UX,
  route census, capability status, SHADOW, forms and governance, and its section
  13 reconciles itself against the capability-network audit.

Both are inputs here, not competitors. **A finding that either already recorded
is not re-reported** — it is cited and, where it has since been fixed or
escalated, marked as such. Anything this audit reports as new has been checked
against both first.

## The standard this audit holds itself to

Written down first, so it can be held against the output later.

1. **Every finding carries a verbatim quote** from the file it concerns, with a
   `path:line` reference. A finding without one does not get published.
2. **Every finding is re-read by a second pass** whose job is to refute it, not
   to confirm it. Confirmed means *the quote is real and says what the finding
   claims*, not *the reasoning is sound*.
3. **"Confirmed" is not "true."** The last audit run produced fifteen findings
   and zero retractions, and the first high-severity one checked by hand still
   contained a false sub-claim. Any reader should open the file.
4. **No gap-filling.** If a pass cannot establish something, it reports that it
   could not. An invented severity, an assumed line number, or a plausible-
   sounding count is a worse outcome than an admitted hole.
5. **Nothing gets fixed from inside this audit** except where a fix is bounded,
   unclaimed by an open PR, and outside the "needs a human" list below. This is
   a read-first exercise; fixes get their own branches.

### Never fixed autonomously, only escalated

Per this repository's own contributor guardrails: anything that **narrows a role
gate** (what a coach or guardian may do), anything that **reverses a recorded
owner decision**, and anything touching **production, real-environment
migrations, or releases**. These get reported with the decision spelled out —
they do not get patched because they look like bugs.

Anything indicating a **child is currently unsafe** is raised immediately and
separately, not held until the audit finishes.

---

## Passes

Each pass writes its own file in this directory. This table is the index and the
live status. It is updated when a pass changes state, not at the end.

The list started at thirteen and is now seventeen. The four added — role
journeys, data egress, the research and evidence machinery, and failure
behaviour — are not padding; each answers a question none of the original
thirteen asked. **Pass 15** asks what data about a child leaves the building and
to whom, which no per-file pass reaches because egress is a property of the whole
system. **Pass 17** asks whether a safety gate fails closed or fails open, which
matters more here than whether the gate exists: a gate that throws into a
permissive default is worse than no gate, because the screen will show it as
passed. **Pass 14** traces whole journeys rather than pieces, because the
category that keeps biting this codebase is the seam between two correct
modules. **Pass 16** audits the machinery by which a claim earns authority, in a
codebase whose stated principle is that invented authority is worse than an
admitted gap.

| # | Pass | Scope | Status | Output |
|---|---|---|---|---|
| 1 | Authentication & session | Login, magic link, PIN, bootstrap key, session issuance and invalidation, `AUTH_CONTRACT.md` conformance | **running** | `PASS-01-authentication.md` |
| 2 | Authorization & tenancy | `assertActorCanAccessAthlete` and siblings, org scoping, cross-org leakage, role gates across all 228 routes | **done** | `PASS-02-authorization.md` |
| 3 | Minors' data & consent | Waivers, guardian links, consent scope enforcement, profile visibility, photo/video exposure | not started | — |
| 4 | Safety gates | Training holds, clearances, contact exposure, escalation ladder, competition entry | **done** | `PASS-04-safety-gates.md` |
| 5 | API surface | All 228 routes: input validation, `jsonError` prefix conformance, idempotency, rate limiting, `hiddenNotFound` | **running** | `PASS-05-api-surface.md` |
| 6 | Data layer | 88 migrations vs. code, constraints, tenancy columns, policy hiding in DDL, N+1 | **running** | `PASS-06-data-layer.md` |
| 7 | Frontend & design system | 125 screens + 86 components: fabricated-data disclosure, Law 2 / Law 7 conformance, invented classes, dead ends | **running** | `PASS-07-frontend.md` |
| 8 | SHADOW subsystem | Authority model specified vs. built, event model, **what actually drives the job processor** | **running** | `PASS-08-shadow.md` |
| 9 | Formulas & thresholds | Registry status vs. callers, provenance of every constant gating a child's training | **running** | `PASS-09-formulas.md` |
| 10 | Tests & CI | What the 281 unit + 93 pg suites actually pin, tests that assert nothing, the pg teardown race, CI gates | **running** | `PASS-10-tests-ci.md` |
| 11 | Build, infra & secrets | Dockerfiles, CI/CD exposure, **secrets in tree and in git history**, `staticwebapp.config.json` | **running** | `PASS-11-infra-secrets.md` |
| 12 | Docs vs. code | 425 docs: claims contradicted by source, contract files, stale-but-unmarked | **running** | `PASS-12-docs-vs-code.md` |
| 13 | Cross-cutting synthesis | Defects visible only between passes — the class that broke `main` three times | queued, runs last | — |
| 14 | Role journeys & flow | Seven journeys traced UI → API → domain → DB: enrolment, consent withdrawal, placing a hold, competition entry, incident, guardian visibility, coach onboarding | **running** | `PASS-14-flows.md` |
| 15 | Data egress & integrations | **What data about a child leaves this system, to whom, and what stands between it and the door** — model calls, SAS URLs, email, exports, telemetry, logs | **running** | `PASS-15-egress.md` |
| 16 | Research, data library & evidence | Source lifecycle, evidence registry, Knowledge Graph, `assessment_protocols`, UI claims vs. implemented hand-offs | **running** | `PASS-16-research-library.md` |
| 17 | Resilience & failure behaviour | **Does each safety gate fail closed or fail open?** Swallowed errors, permissive defaults, non-transactional multi-step safety writes, retries that double-write | **running** | `PASS-17-resilience.md` |

## Verification

Every finding is re-read by a second pass whose job is to **refute** it. That
was rule 2 of this audit's published standard, and it is being run rather than
described.

| Pass | Verification | Status |
|---|---|---|
| 2 — Authorization | spot-checked by hand (below); full refutation pass not yet run | partial |
| 3 — Minors' data & consent | `VERIFY-03-minors-consent.md` | **done — 4 downgraded, 0 retracted** |
| 4 — Safety gates | `VERIFY-04-safety-gates.md` | **done — 2 downgraded, 1 narrowed, 1 corrected, 0 retracted** |

The refutation passes are instructed to assume each finding is wrong until the
file proves otherwise, to argue every severity *down*, and to treat a pass that
retracts nothing as having failed at its job. That instruction exists because
the previous run of this audit produced fifteen findings and zero retractions,
and the first high-severity one checked by hand still contained a false
sub-claim. Zero retractions is a result to be suspicious of, not proud of.

### Checked by hand, not by an agent

Three findings I opened the source for myself rather than relaying:

**F-20 (safety-flags, raised to CRITICAL).** Confirmed. `resolveSafetyFlag`
(`apps/web/src/server/pilot/safetyFlags.ts:190`) scopes its `update` by
`organization_id` and `flag_id` only; the route calls `requireRole` and nothing
else. The contrast is `apps/web/app/api/pilot/training-holds/route.ts:131`,
whose comment reads "no org-wide hold roster" and which calls
`assertCoachAssignedToAthlete` at three separate points. Grounds for the
severity change are written above.

**F-21 (guardian-record overwrite).** Confirmed verbatim.
`apps/web/src/server/pilot/intake.ts:719-729` is exactly:

```
on conflict (organization_id, parent_id) do update set
  account_id = excluded.account_id,
  full_name = excluded.full_name,
  phone = excluded.phone,
  email = excluded.email,
```

and the signature takes `accountId?: string`, binding `params.accountId ?? null`
— so omitting the field does not leave the existing value alone, it writes NULL
over it. Same for `phone` and `email`. The finding is right that this is a
rewrite, not only a link.

**F-01 (competition entry consults no safety record).** Confirmed at the module
level. `addCompetitionEntry`
(`apps/web/src/server/pilot/externalCompetition.ts:144-185`) performs exactly two
reads before its insert — the competition row and the athlete row — and the
code's own comment says why: *"The competition lookup doubles as the tenancy
check"*. That comment is useful evidence in itself: those two reads were written
as tenancy checks and were never intended to carry a safety meaning, so this is
a gap rather than a weakened gate. Whether a route-level guard sits upstream is
being checked by the refutation pass; I did not settle it here and am not
claiming to have.

## Findings

None yet. When findings exist they are indexed here by severity, with the pass
that produced them and whether the refutation pass confirmed or retracted.

Pass 4 has reported; passes 2, 3 and 10 are still running, so this table is
partial by definition rather than final.

| ID | Severity | Finding | Pass | Status |
|---|---|---|---|---|
| F-01 | CRITICAL | Competition entry and league roster consult no safety record at all — a child under an active `all_training` hold can be entered with one authenticated request | 4 | **Known. Fixed by PR #452, which is green and not a draft. Needs a merge, not new work.** |
| F-02 | ~~HIGH~~ **MEDIUM** | A hold does not cancel registrations that already exist; the STOP rung is checked once at registration and never again | 4 | New — **downgraded on verification, and a sub-claim of mine was false: see below** |
| F-03 | ~~MEDIUM~~ **LOW** | `/admin/safety-review` double-counts one compliance violation and every hold in its headline number | 4 | New — downgraded on verification |
| F-04 | MEDIUM | `raiseConductConcern` bypasses the incident severity floor and the #433 dedup; same route has no athlete-scope check | 4 | New |
| F-05 | LOW | `/admin/escalations` stale source-type union | 4 | Known; fixed on the PR #456 branch |
| F-06 | MEDIUM | All three hold scopes overstate enforcement, not only `conditioning_only` | 4 | Half known — this audit's own prior claim was understated and is corrected |
| F-07 | LOW | A `training_hold` gate can be recorded `blocked` but never `passed`, so a guardian sees "Not clear" permanently after one refused registration | 4 | New |
| F-08 | MEDIUM | `readinessMath.ts` has zero callers; the stored readiness score is taken raw from the request body, so the clamp and delta-RPE lock live in a module nothing calls | 4 | New mechanism behind a known finding |
| F-09 | LOW | `TrainingHoldScope` defined five times, feeding three exhaustive maps, one with no fallback | 4 | New — same shape as the drift that broke `main` three times |
| F-10 | MEDIUM | `assertShadowAuthority` is inert at **two of its three** call sites | 4 | New — **the original "all three" headline was falsified on verification; see below** |
| F-24 | MEDIUM | `automation_mode` is unvalidated at two of three SHADOW call sites with no column CHECK, so the single working denial branch is evadable by sending `"Automatic"` instead of `"automatic"` | verify-4 | **New — found by the refutation pass, not the pass it was verifying** |
| F-25 | LOW | `/coach/progression-intelligence` is a second coach-facing hold reader that pass 4 did not list | verify-4 | New — found by the refutation pass |
| F-26 | HIGH | `profile/roster` does not filter `athletes.deleted_at`, so a withdrawn child stays on the live coach roster — name, date of birth and portrait — for the whole retention window | verify-3 | **New — found by the refutation pass, not the pass it was verifying** |
| F-27 | MEDIUM | The unauthenticated gym wall was filed as sound on the premise that `wall_display_full_name` has no writer. `waiver_type` has no database constraint and `domain-upsert` writes it verbatim from the body, so a coach can mint that exact row; `signed_by_role` is self-declared text, defeating the guardian-signer check. The only real brake is an unset environment flag | verify-3 | **New — a "checked and found sound" entry that was not sound** |
| F-11 | ~~HIGH~~ **MEDIUM** | Film Study checks guardian consent at enqueue and never again, and the withdrawal sweep cancels no running job | 3 | **Overstated. I called this the most important finding of the audit and that was wrong — see below** |
| F-12 | HIGH | Consent scope is collected and presented to guardians as control but enforced by nothing, with `covers_video` defaulting `true` in three places including on every non-media waiver row | 3 | Known as an MVP cut; the default and its breadth are new |
| F-13 | HIGH | A coach can silently overwrite an existing guardian's `pilot.parents` binding, severing a real parent from their own child's consent withdrawal | 3 | New — **owner decision, narrows a role gate** |
| F-14 | ~~HIGH~~ **MEDIUM** | 60-minute unaudited SAS bearer URLs to minors' video, minted in bulk | 3 | Downgraded on verification |
| F-15 | ~~HIGH~~ **MEDIUM** | A hard-deleted athlete record silently reclassifies a surviving account from minor to staff | 3 | Chain held link-for-link; the *consequence* failed — every athlete-derived listing reads `pilot.athletes`, so the ghost account disappears from all of them |
| F-16 | MEDIUM | The waiver-status console and the media gate disagree about the same child, in the over-confident direction | 3 | New |
| F-17 | MEDIUM | `DATA_RETENTION.md` promises per-category deletion of photos, videos, medical records and waivers that no code performs; no blob byte is ever deleted | 3 | New |
| F-18 | ~~MEDIUM~~ **LOW** | A second unguarded copy of the destructive purge exists with zero callers | 3 | Downgraded on verification |
| F-19 | LOW | `deleteAthleteRecord`'s JSDoc claims it marks photos and videos for deletion; it sets one column | 3 | New |
| F-20 | **CRITICAL** | `/api/pilot/safety-flags` gives any coach the whole gym's open safety queue and lets them raise or **bypass** a flag on any child, with no athlete-scope check at the route or in `resolveSafetyFlag` | 2 | New — **severity raised from the pass's own HIGH; see below** |
| F-21 | HIGH | A coach can overwrite another family's guardian record — `upsertGuardian`'s `on conflict … do update` rewrites `account_id`, phone and email, and repointing `account_id` hands a chosen account guardian reach over every child that record carries, siblings included | 2 | New extension of the escalated `parent_id` finding |
| F-22 | MEDIUM | `multidiscipline` and `competence-cohorts` call `requireRole(principal, ['coach','admin'])`, which is exact-match, so every provisioned `organization_admin` gets a 403 on a child's grappling-exposure history. Tests miss it because they drive the legacy `'admin'` value | 2 | New |
| F-23 | MEDIUM | `DELETE /api/pilot/achievements/mentorships` authorizes only the mentor side, and does so *after* `endMentorship` has committed its UPDATE — an unauthorized coach closes the pairing and then receives the 403 | 2 | New |

### What the pass-3 refutation changed, including the finding I led with

**Four downgrades, zero retractions, and every re-extracted quote was
character-exact at its cited line.** Nothing was fabricated. What broke was
reasoning and reach — which is the more common failure and the harder one to
catch.

**The Film Study finding was overstated, and I led with it.** I called it "the
most important finding of this audit so far" and described a guardian
withdrawing consent and having frames of their child sent to an external service
afterwards. Three sub-claims fail:

1. *"The executor re-validates only the actor's role."* False.
   `shadowJobProcessor.ts:172-178` re-loads the actor from the live database and
   re-runs `assertActorCanAccessAthlete` on the subject athlete.
2. *"Could not establish what drives the queue."* **The repository answers it.**
   `instrumentation.ts:31-39` starts an in-process drain loop, and
   `.github/workflows/deploy-production.yml:437` sets
   `PPBF_SHADOW_WORKER_ENABLED=true`. I had promoted this to one of the three
   questions I most wanted answered, and it was answerable from the tree the
   whole time.
3. Consequently the race window is **~30 seconds** (`shadowJobWorker.ts:20`),
   hard-capped at 24h by `expires_at` (`pilot_slice_postgres.sql:1000`) — not the
   "enqueued in the afternoon, runs in the evening" story I told.

The core gap survives and is still worth fixing: there are zero consent
references anywhere in the job path, and the withdrawal sweep genuinely cancels
nothing — `cancelJobForActor`'s only caller is a user-driven DELETE. But a
30-second window with a live access re-check is a different animal from what I
reported. **HIGH → MEDIUM.**

**What held, and got worse in the holding.** The `covers_video` sub-claim I told
the pass to attack hardest survived: `domain-upsert/route.ts:90-100` omits
`coversVideo`, and `upsertWaiver` is the only production insert into
`pilot.waivers`. One correction, and it cuts against us — the DDL default is
unreachable at runtime, but **it backfilled every pre-existing row**. That is
worse than a live default, not better.

**The most valuable thing this pass produced was not a verdict.** It found an
entry pass 3 had filed under *"checked and found sound"* that was not sound: the
unauthenticated gym wall, cleared on the premise that `wall_display_full_name`
has no writer. `waiver_type` has no database constraint
(`pilot_slice_postgres.sql:413`) and `domain-upsert` writes it verbatim from the
request body, so a coach can mint exactly that row — and `signed_by_role` is
self-declared text, which defeats `wallDisplay.ts`'s guardian-signer check. The
only real brake is an unset environment flag. **A false "sound" is more
dangerous than a false finding**, because nobody re-reads it.

It also found that `profile/roster` does not filter `athletes.deleted_at`, so a
withdrawn child remains on the live coach roster — name, date of birth, portrait
— for the entire retention window.

### What the pass-4 refutation changed, including two things I told the owner that were wrong

The refutation pass retracted nothing but moved four of ten findings, and
**four of the ten carried a factual error in their supporting text.** That is the
result the standard was written to produce, and it lands on my own reporting
first.

**F-02 was overstated, and I repeated the false part.** The mechanism holds — no
cron, job, trigger or delete against `pilot.scheduler_registrations` exists
anywhere, so a hold genuinely does not cancel registrations already made. But
the pass wrote, and I passed on, that no coach-facing surface shows the hold at
the door. That is false. `CoachWorkspace.tsx:895` fetches
`/api/pilot/escalations?status=open` and renders `training_hold: 'Training hold'`
cards naming the athlete, and `/coach/progression-intelligence` is a second hold
reader neither the pass nor I listed. A coach is not blind to the hold. **HIGH →
MEDIUM.**

**F-10's headline was falsified.** Pass 4 claimed `assertShadowAuthority` cannot
deny at *any* of its three call sites, and that is what I wrote into
`NETWORK_STATUS.md`. The refutation pass enumerated the sites independently —
the count of three is right — and found `review-action/route.ts:86-88` computes
`lowRisk: action !== 'promote'` rather than asserting it, so `action: 'promote'`
with `automation_mode: 'automatic'` genuinely denies. The gate is inert at **two
of three** sites, not three. The substance survives: the medical and waiver
intake writes are the inert ones, which is the part that matters. But "cannot
deny anywhere" was wrong and is corrected on the shared surface too.

**F-03 downgraded MEDIUM → LOW.** **F-06 confirmed with a correction**: the
"all three scopes overstate enforcement" claim is right — and my earlier
`conditioning_only`-only record was the narrower truth — but its consequence
paragraph is contradicted twice over and its grep count was 11 against 15 actual
source hits.

**F-01 held under every attack**, which is worth saying plainly given it is the
CRITICAL. No `middleware.ts` exists in `apps/web`; `grep -rn "create trigger"
infra/` returns exactly three triggers repo-wide, none on the competition or
roster tables; the only entry constraints are two composite foreign keys and a
uniqueness index. The quotes are byte-exact at the cited lines.

The refutation pass also **found two things the pass it was checking had
missed**, which is the strongest argument for running it at all. The substantive
one is F-24: `automation_mode` is unvalidated at two of three sites with no
column CHECK, so the one denial branch that does work can be evaded by sending
`"Automatic"` instead of `"automatic"`.

### On F-20, and why I moved it

Pass 2 rated this HIGH and said in its own report that it met the CRITICAL bar,
inviting the check. I made it, by reading the route and the module rather than
taking either label on trust, and I am moving it to CRITICAL. The grounds:

- It is a **write**, not only a read. `resolveSafetyFlag`
  (`safetyFlags.ts:190`) scopes its `update` by `organization_id` and `flag_id`
  alone — there is no athlete-scope check at the route or inside the module — so
  a coach can resolve or bypass an open flag on a child they have no standing
  on. Reading another child's `concussion_rest_period` is bad; clearing it is
  the thing this platform exists to prevent.
- The codebase **already refuses exactly this next door**, which makes it a miss
  rather than a considered trade-off. `training-holds/route.ts:131` carries the
  comment "no org-wide hold roster" and calls `assertCoachAssignedToAthlete` at
  three separate points.
- Pass 2's two stated reasons for stopping at HIGH do not survive contact. "No
  UI path" is not a mitigation for an authenticated API endpoint. "A vetted
  coach in the same gym" is a real consideration, but the platform itself has
  already decided it is insufficient — that is what the sibling routes' scoping
  means.

The mitigations that **are** real, and belong in the record: an `external_rule`
flag cannot be bypassed (`safetyFlags.ts:205`, backed by a database constraint),
and every resolution writes an audit event carrying the actor's id and role. But
`flag_class` is supplied by whoever raises the flag rather than derived from the
flag code, and a coach may raise flags — so the class that protects the worst
codes is not guaranteed to be set on them.

## Log

Appended as work happens. Newest last.

- **2026-08-18** — Branch `docs/full-spectrum-audit-2026-08-18` cut from
  `origin/main` at `04dd116b`. Scope counted. Standard written. Both prior
  audits located and read for de-duplication. No findings yet; no passes
  started.
- **2026-08-18** — Passes 2, 3, 4 and 10 started, in that priority order and not
  the numeric one. The three child-safety passes go first because a defect there
  is a real child exposed or a held-out child cleared, and pass 10 goes with them
  because the question it answers — *would any test fail if one of these gates
  were deleted?* — decides how much the other three can be trusted to stay fixed.
  Each pass writes its own file here; this index is updated when a pass changes
  state, not at the end.
- **2026-08-18** — Pass 4 reported: ten findings, one CRITICAL, eight of them new.
  The CRITICAL is **not new work** — PR #452 already fixes it, is green, and is
  not a draft; what it needs is a merge. Pass 4 also confirmed three claims this
  audit inherited from `NETWORK_STATUS.md` and **corrected one of them as
  understated**: it is not only `conditioning_only` holds that fail to enforce,
  it is all three scopes. Findings written into `NETWORK_STATUS.md` so the other
  audit session does not rediscover them.
- **2026-08-18** — Coordination defect found and recorded: `NETWORK_STATUS.md`,
  the file every brief names as the shared surface, is **not on `main`**. It
  exists only on branch `docs/agent-handoff-briefs` (PR #437, draft). Any session
  told to coordinate through it that checks out `main` finds nothing. Pass 3 hit
  this independently — it followed this README's own citation of that path, found
  it did not resolve, and read the file from the remote branch instead. A
  citation that does not resolve is a defect in this audit, not only in the repo.
- **2026-08-18** — Pass 3 reported: nine findings, five HIGH, no URGENT. Nothing
  found means a child is exposed *right now*, and the pass says so plainly rather
  than reaching for a headline. Its most important finding is a consent race in
  the Film Study async path — checked at enqueue, never again — which matters
  more than its severity label suggests, because every *other* consent path in
  this codebase closes that race properly with `for share` locks and an in-
  transaction re-verify. That makes it an outlier, not a house style.
  Two of its findings are owner decisions rather than fixes, and two need
  production access this session does not have.
- **2026-08-18** — Scope widened from thirteen passes to seventeen, and the work
  split across two sessions. The split is recorded in `NETWORK_STATUS.md` rather
  than here, because that is the file both sessions read. Pass 13 (cross-cutting
  synthesis) is deliberately reserved for the *other* session and runs last: a
  synthesis written by the session that wrote the passes inherits that session's
  blind spots, and the whole purpose of a pass hunting defects visible only
  between passes is that it be a second reading.
- **2026-08-18** — Pass 2 reported: eight findings, and it was straight about its
  own reach — 228 routes classified mechanically, 31 deep-read, 22 more inspected
  at handler level, **175 not opened**. That sentence is why the pass is usable;
  a claim to have reviewed all 228 would not have been.
  It also answered the question it was sent to answer: the "one side checked,
  the other not" pattern is **the exception, not the rule** — roughly 120
  two-party link inserts traced, and all but two validate both ends, several with
  comments explaining why. That is a genuinely reassuring result and is recorded
  as such.
  One severity call was raised on review from HIGH to CRITICAL after I read the
  route and module myself; the grounds are written above rather than the label
  quietly changed.

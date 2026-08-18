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

| # | Pass | Scope | Status | Output |
|---|---|---|---|---|
| 1 | Authentication & session | Login, magic link, PIN, session issuance, role resolution, `AUTH_CONTRACT.md` conformance | not started | — |
| 2 | Authorization & tenancy | `assertActorCanAccessAthlete` and siblings, org scoping, cross-org leakage, role gates across all 228 routes | **done** | `PASS-02-authorization.md` |
| 3 | Minors' data & consent | Waivers, guardian links, consent scope enforcement, profile visibility, photo/video exposure | not started | — |
| 4 | Safety gates | Training holds, clearances, contact exposure, escalation ladder, competition entry | **done** | `PASS-04-safety-gates.md` |
| 5 | API surface | All 228 routes: input validation, error-shape conformance, idempotency, rate limiting | not started | — |
| 6 | Data layer | 88 migrations vs. code expectations, indexes, constraints, orphan/nullable risk, N+1 | not started | — |
| 7 | Frontend & design system | 125 screens: design-system conformance, fabricated-data disclosure, refusal treatment, dead ends | not started | — |
| 8 | SHADOW subsystem | Authority model, event model, evidence statistics, measurement gates | not started | — |
| 9 | Formulas & thresholds | `formulas/registry.ts`, wired vs. unwired, coefficient provenance, youth-safety constants | not started | — |
| 10 | Tests & CI | What the 281 unit + 93 pg suites actually pin, tests that assert nothing, the pg teardown race, CI gates | **running** | `PASS-10-tests-ci.md` |
| 11 | Build, infra & secrets | Dockerfiles, deploy config, env handling, secret exposure, `staticwebapp.config.json` | not started | — |
| 12 | Docs vs. code | 425 docs: claims contradicted by source, superseded files still read as current, stale runbooks | not started | — |
| 13 | Cross-cutting synthesis | Defects visible only between passes — the class that broke `main` three times | not started | — |

## Verification

Every finding is re-read by a second pass whose job is to **refute** it. That
was rule 2 of this audit's published standard, and it is being run rather than
described.

| Pass | Verification | Status |
|---|---|---|
| 2 — Authorization | spot-checked by hand (below); full refutation pass not yet run | partial |
| 3 — Minors' data & consent | `VERIFY-03-minors-consent.md` | **running** |
| 4 — Safety gates | `VERIFY-04-safety-gates.md` | **running** |

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
| F-02 | HIGH | A hold does not cancel registrations that already exist; the STOP rung is checked once at registration and never again | 4 | New |
| F-03 | MEDIUM | `/admin/safety-review` double-counts one compliance violation and every hold in its headline number | 4 | New — second instance of the Morning Read collision class |
| F-04 | MEDIUM | `raiseConductConcern` bypasses the incident severity floor and the #433 dedup; same route has no athlete-scope check | 4 | New |
| F-05 | LOW | `/admin/escalations` stale source-type union | 4 | Known; fixed on the PR #456 branch |
| F-06 | MEDIUM | All three hold scopes overstate enforcement, not only `conditioning_only` | 4 | Half known — this audit's own prior claim was understated and is corrected |
| F-07 | LOW | A `training_hold` gate can be recorded `blocked` but never `passed`, so a guardian sees "Not clear" permanently after one refused registration | 4 | New |
| F-08 | MEDIUM | `readinessMath.ts` has zero callers; the stored readiness score is taken raw from the request body, so the clamp and delta-RPE lock live in a module nothing calls | 4 | New mechanism behind a known finding |
| F-09 | LOW | `TrainingHoldScope` defined five times, feeding three exhaustive maps, one with no fallback | 4 | New — same shape as the drift that broke `main` three times |
| F-10 | MEDIUM | `assertShadowAuthority` cannot deny at any of its three call sites; it records `allowed: true` for every medical and waiver write | 4 | New |
| F-11 | HIGH | Film Study checks guardian consent at enqueue and never again; the async job re-validates only the actor's role, then reads the child's video by blob path. A guardian can withdraw consent, be truthfully told published media was retracted, and have frames of their child sent to an external vision service afterwards | 3 | New — **the most important finding of this audit so far** |
| F-12 | HIGH | Consent scope is collected and presented to guardians as control but enforced by nothing, with `covers_video` defaulting `true` in three places including on every non-media waiver row | 3 | Known as an MVP cut; the default and its breadth are new |
| F-13 | HIGH | A coach can silently overwrite an existing guardian's `pilot.parents` binding, severing a real parent from their own child's consent withdrawal | 3 | New — **owner decision, narrows a role gate** |
| F-14 | HIGH | 60-minute unaudited SAS bearer URLs to minors' video, minted in bulk | 3 | New |
| F-15 | HIGH | A hard-deleted athlete record silently reclassifies a surviving account from minor to staff, releasing the portrait to every coach and admin | 3 | New |
| F-16 | MEDIUM | The waiver-status console and the media gate disagree about the same child, in the over-confident direction | 3 | New |
| F-17 | MEDIUM | `DATA_RETENTION.md` promises per-category deletion of photos, videos, medical records and waivers that no code performs; no blob byte is ever deleted | 3 | New |
| F-18 | MEDIUM | A second unguarded copy of the destructive purge exists with zero callers | 3 | New |
| F-19 | LOW | `deleteAthleteRecord`'s JSDoc claims it marks photos and videos for deletion; it sets one column | 3 | New |
| F-20 | **CRITICAL** | `/api/pilot/safety-flags` gives any coach the whole gym's open safety queue and lets them raise or **bypass** a flag on any child, with no athlete-scope check at the route or in `resolveSafetyFlag` | 2 | New — **severity raised from the pass's own HIGH; see below** |
| F-21 | HIGH | A coach can overwrite another family's guardian record — `upsertGuardian`'s `on conflict … do update` rewrites `account_id`, phone and email, and repointing `account_id` hands a chosen account guardian reach over every child that record carries, siblings included | 2 | New extension of the escalated `parent_id` finding |
| F-22 | MEDIUM | `multidiscipline` and `competence-cohorts` call `requireRole(principal, ['coach','admin'])`, which is exact-match, so every provisioned `organization_admin` gets a 403 on a child's grappling-exposure history. Tests miss it because they drive the legacy `'admin'` value | 2 | New |
| F-23 | MEDIUM | `DELETE /api/pilot/achievements/mentorships` authorizes only the mentor side, and does so *after* `endMentorship` has committed its UPDATE — an unauthorized coach closes the pairing and then receives the 403 | 2 | New |

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

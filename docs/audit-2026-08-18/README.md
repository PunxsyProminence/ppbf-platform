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
| 2 | Authorization & tenancy | `assertActorCanAccessAthlete` and siblings, org scoping, cross-org leakage, role gates across all 228 routes | **running** | `PASS-02-authorization.md` |
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
  told to coordinate through it that checks out `main` finds nothing.

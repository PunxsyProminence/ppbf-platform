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
| 2 | Authorization & tenancy | `assertActorCanAccessAthlete` and siblings, org scoping, cross-org leakage, role gates across all 228 routes | not started | — |
| 3 | Minors' data & consent | Waivers, guardian links, consent scope enforcement, profile visibility, photo/video exposure | not started | — |
| 4 | Safety gates | Training holds, clearances, contact exposure, escalation ladder, competition entry | not started | — |
| 5 | API surface | All 228 routes: input validation, error-shape conformance, idempotency, rate limiting | not started | — |
| 6 | Data layer | 88 migrations vs. code expectations, indexes, constraints, orphan/nullable risk, N+1 | not started | — |
| 7 | Frontend & design system | 125 screens: design-system conformance, fabricated-data disclosure, refusal treatment, dead ends | not started | — |
| 8 | SHADOW subsystem | Authority model, event model, evidence statistics, measurement gates | not started | — |
| 9 | Formulas & thresholds | `formulas/registry.ts`, wired vs. unwired, coefficient provenance, youth-safety constants | not started | — |
| 10 | Tests & CI | What the 281 unit + 93 pg suites actually pin, tests that assert nothing, the pg teardown race, CI gates | not started | — |
| 11 | Build, infra & secrets | Dockerfiles, deploy config, env handling, secret exposure, `staticwebapp.config.json` | not started | — |
| 12 | Docs vs. code | 425 docs: claims contradicted by source, superseded files still read as current, stale runbooks | not started | — |
| 13 | Cross-cutting synthesis | Defects visible only between passes — the class that broke `main` three times | not started | — |

## Findings

None yet. When findings exist they are indexed here by severity, with the pass
that produced them and whether the refutation pass confirmed or retracted.

| ID | Severity | Finding | Pass | Verify | Status |
|---|---|---|---|---|---|
| — | — | *no findings recorded yet* | — | — | — |

## Log

Appended as work happens. Newest last.

- **2026-08-18** — Branch `docs/full-spectrum-audit-2026-08-18` cut from
  `origin/main` at `04dd116b`. Scope counted. Standard written. Both prior
  audits located and read for de-duplication. No findings yet; no passes
  started.

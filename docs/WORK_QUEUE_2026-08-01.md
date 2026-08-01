# Work queue — 2026-08-01

A shared queue for two agents working the same repository: **Remote** (Claude Code on the
web, ephemeral container, no Azure access) and **VS Code** (local, holds the deploy
credentials). This file is the only medium both can read, so it is the queue of record.

Built against `main` at `5cd79c4`. Every item below was checked against source before being
listed — three candidates were dropped during that check and are recorded at the bottom
rather than deleted, because knowing something was examined and cleared is worth as much as
the queue itself.

---

## How the split works

| | Remote | VS Code |
|---|---|---|
| Writes code, tests, docs | yes | yes |
| Runs lint / typecheck / jest | yes | yes |
| Opens PRs | yes | yes |
| **Merges** | only when told | yes |
| **Deploys** | no — no credentials | **yes, and only VS Code** |
| **Applies migrations** | no | **yes** |
| Verifies behavior in a real browser against a real session | no | **yes** |
| Reads Azure state, logs, secrets | no | **yes** |

The asymmetry that matters: **Remote cannot observe runtime.** Every Remote finding is
source-read. Anything whose truth depends on what production actually does is VS Code work
by nature, not by preference.

### Collision rules

1. **One branch per item**, named for the item id: `claude/wq-3-source-control-truth`.
2. **Claim before starting** — mark the item `WIP (remote)` or `WIP (vscode)` in this file
   and push that edit first. It is a one-line diff and it is the lock.
3. **Never both edit the same file in the same band.** The queue is ordered so this does not
   come up; if it does, the second agent waits rather than merging around it.
4. **VS Code merges and deploys.** Remote opens drafts and says when they are green.
5. **Rebase on `main` before asking for a merge**, not after.

---

## Band 0 — open PRs, oldest first

Four PRs are open right now. Nothing else should start until these are resolved, because
every one of them touches files later items also touch.

| Id | PR | State | Owner | Action |
|---|---|---|---|---|
| 0.1 | [#150](https://github.com/PunxsyProminence/ppbf-platform/pull/150) — reviewer video access, `blocked` administrator | **draft**, unfinished | Remote | Finish or close. It is the oldest open branch and it is not green-and-waiting, it is incomplete |
| 0.2 | [#151](https://github.com/PunxsyProminence/ppbf-platform/pull/151) — Law 5 tap floor, design laws rewrite | **ready**, clean | VS Code | Needs a human read on the *laws rewrite*, not the tap fixes. The tap fixes are verified in-browser and are a real accessibility defect (`Engage Medical Lock` rendered at 38px). The laws rewrite has had no audit and says so |
| 0.3 | [#154](https://github.com/PunxsyProminence/ppbf-platform/pull/154) — Heavy Bag cap, metrics panel error | draft, green | VS Code | Undraft → merge → **deploy**. This is the only item in the queue that changes what a user is charged for |
| 0.4 | [#153](https://github.com/PunxsyProminence/ppbf-platform/pull/153) — SHADOW surfaces/spec audit | draft, green | Either | Docs only. Merge whenever; blocks nothing |

0.3 and 0.4 are independent — either order.

---

## Band 1 — truth on screen

The owner's standing instruction from the 2026-07-31 audit: *"fake data will need to be
removed when we start taking real athletes."* Treat these as release blockers for onboarding
real families. The 07-31 sweep fixed `/audit` and Mission Control. It missed this one.

### 1.1 — The capability console invents governance rows and does not mark them `[REMOTE]`

`apps/web/app/admin/page.tsx:302-321`. `mergeSeedCapabilities()` appends every
`seedCapabilityBlueprints` entry the server did not return, straight onto the server's list,
with **no marker distinguishing invented from real**. It fabricates:

- `id: existing.length + additions.length + 1` — a client-side counter that **can collide
  with a real server id**
- `createdAt` / `updatedAt` set to `now`, so an invented row reads as freshly created

This is the governance console. An admin cannot tell which capabilities the platform
actually has a record of. It is the same defect class as the invented `/audit` events fixed
on 07-31, in a surface with equal claim to being authoritative.

**Needs checking as part of the fix:** whether editing a merged row attempts a save keyed on
the fabricated `id`, and what that hits server-side. Not yet traced.

**Not to be confused with** the same constant's *other* use at `:409`, as pre-hydration
initial state alongside a `capabilitiesHydrated` flag. That use is fine and should stay.

---

## Band 2 — schema and operations debt

### 2.1 — Four tables exist in production with no DDL anywhere `[VS CODE]`

`pilot.athlete_chat_audit`, `board_chat_audit`, `coach_chat_audit`, `individual_chat_audit`.

The 07-31 audit found their only DDL was `migrations/003_create_chat_audit_tables.sql`,
referenced by no script or workflow. **That directory is now gone entirely** — so as of
`5cd79c4` these tables have zero DDL in the repository *and* zero code references. They
exist in an environment only because the deleted DDL-over-HTTP route once ran there.

Two clean outcomes, and this needs VS Code because it needs to look at the actual database:

- If nothing reads them → **drop them**, with the drop as a migration.
- If anything does → **write the migration**, because a rebuilt environment will not have them.

Confirm which by querying production for row counts before deciding. Note `shadow_chat_audit`
(singular, SHADOW's own) is a *different, live, correctly-migrated* table — do not touch it.

### 2.2 — New organizations do not get the five default compliance rules `[REMOTE]`

Carried over from 07-31's "deliberately not decided." The `compliance-rule-seeds` migration
seeds existing gyms; gym creation does not seed new ones, so a gym set up the documented way
starts with compliance monitoring that does nothing.

*Scoping note:* I could not locate an organization-creation route in this tree — the seeding
site needs to be found before this is estimable. Possibly organizations are only created by
migration today, which would make this a non-issue and worth closing rather than building.

---

## Band 3 — SHADOW follow-ups

From the 2026-08-01 surfaces/conformance audit. All three were left open deliberately.

### 3.1 — Spec corrections `[REMOTE]` — documentation only, do this first, it is 20 minutes

`docs/SHADOW_ML_ARCHITECTURE_SPEC.md` diverges from shipped code in three places, and in all
three **the code is the better version**:

| Spec says | Code does |
|---|---|
| §3.1 — 100 requests/minute per user | 30/60s, stricter, with a comment explaining why |
| §3.1 — 10 Heavy Bag/hour **per organization** | 10/hour **per user**, admin tier exempt (owner decision, #154) |
| §3.7 — `POST /api/pilot/shadow/migrate` | Endpoint deleted; manual `apply-migrations` workflow with target confirmation |

### 3.2 — Scout Reports: build or retitle `[OWNER DECISION]`

`/shadow/scout` is linked and titled for Scout Reports. The generation pipeline
(`generateScoutReport`) was deliberately deleted — only a tombstone remains at
`shadowHeavyBag.ts:261` — and spec §3.5's `GET /shadow/scout-reports` never existed. The page
currently shows the generic job list.

Neither option is a bug fix, which is why it has sat: retitling adds no function, and
building the pipeline is a feature. **This needs the owner to pick**, and it should not be
picked by whichever agent gets there first.

### 3.3 — SHADOW response validator `[DESIGN]`

Two unsafe-advice patterns still pass `validateShadowResponse`. No code was written for this
deliberately: the two cases are **grammatically indistinguishable from six benign coaching
lines** that were tested against, so a pattern-based fix over-filters legitimate coaching.
The real path is a curated high-risk-practice list or a small classifier. Wants design, not a
regex.

---

## Band 4 — runtime verification, VS Code only

These are not defects. They are **claims that no one has checked**, and Remote structurally
cannot check them.

### 4.1 — Exercise `/admin/shadow` per role in a browser `[VS CODE]`

The 2026-08-01 audit states its own limit plainly: *"Dimension A did not exercise the console
at runtime. Findings are from source."* The per-role access table in that audit
(`organization_admin` 8/8 … `athlete` 1/8) is derived from `requireRole` lists, not observed.

Worth an hour with real sessions, because a coach at 5/8 is the case the audit reasoned
hardest about and never saw.

### 4.2 — Confirm the SHADOW runtime migration is live and the restore path works `[VS CODE]`

`evidence_tier` and `handoff` were added to the conversation-message table, and the client
falls back to `RESEARCH_NEEDED` for rows predating them. The migration was confirmed applied
via workflow run history, **not by inspecting the schema**. Verify the columns exist, then
reload a conversation older than the migration and confirm it restores without drawing a
confidence badge it has no basis for.

### 4.3 — Deploy #154 and watch the rate limiter `[VS CODE]`

New cap, first enforcement on that path. After deploy, confirm a real Heavy Bag turn is
charged, an admin is not, and a Quick Round is not. The tests assert this and were verified
to fail without the fix, but they are unit tests against a mocked bucket.

---

## Checked and dropped — do not re-file these

Recorded so the next audit does not spend the same hours.

- **`/source-control` shows sample data.** True — `sampleStateLanes` and
  `sampleVersionHistory`, zero fetches, and it is linked from six real surfaces. **But the
  page labels itself** `PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND
  REQUIRED` in five places, including the surface header. It is honest about what it is, so
  it is not the `/audit` defect class. Whether to keep shipping a placeholder is a product
  call, not a truth-on-screen violation.
- **Board seats are unimplemented.** False. Fully built: `boardSeats.ts`, `api/pilot/board/seats/`,
  `admin/board-seats/`, `BoardSeatWorkspace.tsx`, a migration, and both unit and pg tests.
  The 07-31 doc's "ships in its own change set" has shipped. What remains is 4.4 below.
- **The orphaned `migrations/` DDL file needs wiring up.** Obsolete — the directory is gone.
  The live question is 2.1, which is the opposite problem.

### 4.4 — Board seat pages have no data `[OWNER DECISION]`

Seats route correctly; roughly thirty metric tiles read "Unavailable." Per 07-31, Program &
Safety Director and Secretary are the two seats whose data already exists (compliance
escalations; the audit trail). **The Treasurer, whose duty is clearest, has the least data** —
the platform collects nothing financial until the payment slot is built. Filling these is a
project, not a queue item; listing which seats *could* be filled today is the useful first step.

---

## Also still open, unowned

Carried from 07-31 and not yet decided. Listed for completeness, not queued:

- Team-wide (athlete-less) videos cannot be published.
- Athlete goal category and progress are read by the UI and stored nowhere — confirmed:
  `pilot.goals` carries `title`, `target_date`, `metric`, `status` and no category or
  progress column (`infra/azure/pilot_slice_postgres.sql:77`).

---

## Suggested order

**Remote:** 3.1 (fast, unblocks the spec) → 1.1 (the real defect) → 0.1 (finish or close #150) → 2.2 (scope it, may close)

**VS Code:** 0.3 merge + deploy → 4.3 (watch what you just shipped) → 0.2 review → 2.1 (needs the database) → 4.1, 4.2

**Owner:** 3.2 Scout Reports, 4.4 board seat data. Both are "which product do we want," and
both stall an agent that reaches them.

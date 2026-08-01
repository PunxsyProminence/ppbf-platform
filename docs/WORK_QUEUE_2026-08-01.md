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
| 0.1 | [#150](https://github.com/PunxsyProminence/ppbf-platform/pull/150) — reviewer video access, `blocked` administrator | draft, **green, and complete** | VS Code | **Undraft and review.** My first pass called this "unfinished" from its draft flag alone, which was wrong: 851 lines across 7 files, 16 route tests, 6 pg tests, mutation-verified, CI green since 04:39. It is the oldest open branch and it is ready. It also closes a dead end — a video the content screen `blocked` had no exit anywhere in the platform |
| 0.2 | [#151](https://github.com/PunxsyProminence/ppbf-platform/pull/151) — Law 5 tap floor, design laws rewrite | **ready**, clean | VS Code | Needs a human read on the *laws rewrite*, not the tap fixes. The tap fixes are verified in-browser and are a real accessibility defect (`Engage Medical Lock` rendered at 38px). The laws rewrite has had no audit and says so |
| 0.3 | [#154](https://github.com/PunxsyProminence/ppbf-platform/pull/154) — Heavy Bag cap, metrics panel error | draft, green | VS Code | Undraft → merge → **deploy**. This is the only item in the queue that changes what a user is charged for |
| 0.4 | [#153](https://github.com/PunxsyProminence/ppbf-platform/pull/153) — SHADOW surfaces/spec audit | draft, green | Either | Docs only. Merge whenever; blocks nothing |

0.3 and 0.4 are independent — either order.

---

## Band 1 — truth on screen

The owner's standing instruction from the 2026-07-31 audit: *"fake data will need to be
removed when we start taking real athletes."* Treat these as release blockers for onboarding
real families. The 07-31 sweep fixed `/audit` and Mission Control. It missed this one.

### 1.1 — ✅ **DONE — [#158](https://github.com/PunxsyProminence/ppbf-platform/pull/158)**, and it was worse than filed

Filed as "invented rows shown unmarked." Tracing it before writing code showed the display
problem was the least of it: the save effect fires on *any* `capabilities` change once
hydrated — **including the hydration merge itself** — so the merged list was POSTed straight
back. The registry is one JSONB blob per organization replaced wholesale, so **archiving a
capability could not stick**: the removal saved, and the next page load added it back and
rewrote it, attributed to whoever merely opened the page.

Original filing kept below, because the gap between what it said and what was true is the
useful part.

---

### 1.1 (as originally filed) — The capability console invents governance rows and does not mark them `[REMOTE]`

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

### 2.1 — ✅ **CLOSED — the premise was false. They are not in production**

Checked against production on 2026-08-01 with `npm run pilot:check-orphan-chat-audit`, a
read-only script written for this and kept for the next person who wonders.

All four are **ABSENT** — not in `pilot`, and not in any other schema. The script also swept
every table matching `%chat_audit%` in the entire database and found exactly one:
`pilot.shadow_chat_audit`, SHADOW's own live table, which is correctly migrated and expected.

So there is nothing to drop and no migration to write. Both the 07-31 audit and this queue
asserted these tables "exist in production"; neither had looked. The deleted DDL file was
real, but it either never ran against this database or was reversed long ago.

Two things worth keeping from the exercise:

- **The widened sweep is the part that made it conclusive.** The first pass only checked
  `pilot.` and reported four ABSENT, which would have been a weaker claim — the deleted DDL
  ran over HTTP against whatever `search_path` that request had, so "absent from `pilot`" did
  not rule out "present somewhere else."
- **The check is now a script, not a one-off.** Staging has not been checked. If it holds
  them, that is a genuinely different finding, and the command is the same one.

---

### 2.1 (as originally filed) — Four tables exist in production with no DDL anywhere `[VS CODE]`

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

### 2.2 — ✅ **DONE — [#159](https://github.com/PunxsyProminence/ppbf-platform/pull/159)**. My hedge below was wrong: it is reachable

`POST /api/pilot/platform/organizations` creates one at runtime. My scoping grep missed it
because the `insert` lives inside `createOrganization` in a server module, not inline in the
route — so "possibly organizations are only created by migration" was false and the gap was
live. `createOrganization` now seeds inside the same transaction, guarded against drift from
the SQL by a test that matches every field of every rule.

---

### 2.2 (as originally filed) — New organizations do not get the five default compliance rules `[REMOTE]`

Carried over from 07-31's "deliberately not decided." The `compliance-rule-seeds` migration
seeds existing gyms; gym creation does not seed new ones, so a gym set up the documented way
starts with compliance monitoring that does nothing.

*Scoping note:* I could not locate an organization-creation route in this tree — the seeding
site needs to be found before this is estimable. Possibly organizations are only created by
migration today, which would make this a non-issue and worth closing rather than building.

---

## Band 3 — SHADOW follow-ups

From the 2026-08-01 surfaces/conformance audit. All three were left open deliberately.

### 3.1 — ✅ **DONE — folded into [#154](https://github.com/PunxsyProminence/ppbf-platform/pull/154)**

Put on #154's branch rather than raced off `main`: the per-user Heavy Bag claim only becomes
true when #154 lands, so shipping the doc separately would have made the spec wrong in a new
way for however long the two sat apart. §3.5 and §5.5 were additionally marked
**not-implemented** rather than resolved — that is 3.2's decision to make, not mine.

---

### 3.1 (as originally filed) — Spec corrections `[REMOTE]` — documentation only, do this first, it is 20 minutes

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

## Status — 2026-08-01, after the first Remote pass

**Every Remote item in this queue is done.** Four PRs, all green:

| Item | PR | What |
|---|---|---|
| 3.1 | #154 | Spec corrections, folded into the code change they describe |
| 1.1 | #158 | Capability console no longer resurrects archived capabilities |
| 2.2 | #159 | A gym created through the app gets its five compliance rules |
| — | #157 | This queue |

Two of the four were **mis-filed in the original queue and got worse on inspection**: 1.1 was
a display complaint that turned out to make archiving impossible, and 2.2 carried a hedge that
it might not be reachable, which was wrong. 0.1 went the other way — I called #150 unfinished
from its draft flag, and it is complete and has been green since 04:39.

That is three of my own entries corrected by checking them. Worth remembering when reading the
rest of this file: **the unchecked entries below are the ones most likely to be wrong.**

### What is left, and who it belongs to

**VS Code — everything remaining is yours, because it needs a runtime or a database:**

0.3 merge + deploy #154 → 4.3 (watch the rate limiter you just shipped) → 0.1 undraft #150 →
0.2 review #151 → merge #157, #158, #159 → **2.1** (needs the database: four tables with no
DDL) → 4.1, 4.2 (runtime verification Remote structurally cannot do).

**Owner — two decisions that stall whoever reaches them:**

- **3.2 Scout Reports** — build the deleted pipeline, or retitle `/shadow/scout`.
- **4.4 Board seat data** — ~30 tiles reading "Unavailable"; Program & Safety Director and
  Secretary are the two seats whose data already exists.

**Also unowned and not queued:** 3.3 (response validator — wants a curated list or a
classifier, not a regex), team-wide video publishing, athlete goal category and progress.

### One thing Remote cannot pick up

Seeding real data from the share drives is **not available to this agent**. Nothing is mounted
(`/mnt` holds only harness directories) and this container carries no database credentials by
design — the same asymmetry that puts Band 4 on VS Code. Any bulk seeding of real athlete or
gym data is VS Code's, and per the owner's standing instruction it should land only after the
remaining placeholder content is out.

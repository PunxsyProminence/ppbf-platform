# Pass 12 — Documentation vs. code

Read-only audit pass. Pinned to branch `docs/full-spectrum-audit-2026-08-18`,
working tree at `5cc4d7f9`. No file outside this one was modified.

The governing question for this pass was not "is the prose tidy" but **"does a
document describe a protection that a person would rely on, which the code does
not provide?"** A stale heading is a nuisance. A retention policy that promises
a guardian their child's video is deleted, when no line of code ever deletes a
video, is the failure mode this repository's own kernel exists to prevent
(`AGENT_KERNEL.md:30` — "Preserve hard safety boundaries"). Findings are
weighted that way, and severity is reserved accordingly.

---

## Method

### What was actually opened

Measured counts, not estimates.

| Category | Count |
|---|---|
| Markdown files in scope (429 under `docs/` + 11 root contract files) | 440 |
| Read **in full** (every line) | 22 |
| Read **in substantial part** (one or more whole sections, headers, or targeted line ranges) | 19 |
| Scanned **mechanically only** (link/path resolution, status-field extraction, claim-verb greps) | 440 |
| **Never opened in any form beyond a grep hit line** | 399 |

Read in full: `AGENT_KERNEL.md`, `AUTH_CONTRACT.md`, `AGENTS.md`,
`MASTER_INDEX.md`, `README.md`, `DEVELOPER_ONBOARDING.md`,
`ORGANIZATION_ROLE_MODEL.md`, `docs/DATA_RETENTION.md`,
`docs/AGENT_EXECUTION_POLICY.md`, `docs/capabilities/README.md`,
`docs/current/ACTIVE_WORK.md`, `PPBF_CAPABILITIES.json`,
`docs/capabilities/NETWORK_STATUS.md` (from `origin/docs/agent-handoff-briefs`),
and capability modules 001, 003, 034, 043, 082, 151, 164, 194, 200.

Read in part: `docs/SHADOW_AUTHORITY_MODEL.md` (§5–§9 and the 2026-07-19
alignment list), `docs/SHADOW_AI_TECHNICAL_COMPANION.md`,
`ORGANIZATION_ARCHITECTURE.md`, `docs/BOARD_SEAT_ASSIGNMENT.md`,
`docs/current/PRODUCTION_STATE.json`, `docs/current/WORK_QUEUE.md`,
`docs/CAPABILITY_BUILD_PLAN_2026-08-03.md`, `docs/golden-era-phase2-roadmap.md`,
`docs/PRODUCTION_READINESS.md`, `docs/governance-rules.md`, `docs/README.md`,
`docs/00_MASTER_BLUEPRINT.md`, `docs/AI_COLLABORATION.md`, `SEED_GUIDE.md`,
`docs/RESEARCH_EVIDENCE_REGISTRY.md`, and capability modules 139, 141, 142, 170.

**Not opened:** all 60 files in `docs/archive/`, all 87 in
`docs/capabilities/work/`, 192 of the 201 `docs/capabilities/modules/` files
beyond their status field, all 3 in `docs/design/`, and roughly 35 of the 53
top-level `docs/*.md`. The three sibling pass files in `docs/audit-2026-08-18/`
were consulted only through their citations, to de-duplicate — not re-audited.

### Code read to test the claims

Read in full: `apps/web/src/server/pilot/dataDeletion.ts` (303 lines),
`apps/web/src/server/pilot/shadowAuthority.ts` (98 lines),
`infra/azure/pilot_slice_postgres_data_retention_deletion_migration.sql`,
`apps/web/app/api/pilot/admin/data-deletion/route.ts`,
`docs/capabilities/expanded-200-backlog.csv` and `expanded-200-index.json`
(parsed programmatically).

Read in part: `apps/web/scripts/pilot-cleanup-deleted-data.mjs`,
`.github/workflows/retention-cleanup.yml`,
`apps/web/src/server/pilot/trainingHolds.ts`,
`apps/web/src/server/pilot/access.ts`, `apps/web/src/server/pilot/blob.ts`,
`apps/web/src/server/pilot/schedulerDb.ts`,
`apps/web/src/server/pilot/boardSummary.ts`,
`infra/azure/pilot_slice_postgres.sql`,
`infra/azure/pilot_slice_postgres_video_sessions_migration.sql`,
`apps/web/app/api/pilot/board/chat/route.ts`,
`apps/web/app/api/pilot/shadow/chat/route.ts`, and the three
`assertShadowAuthority` call sites.

**No code was executed.** No test was run. Every finding is static-read
evidence and should be reproduced against a running instance before anyone acts
on a severity.

### How samples were chosen

- **Protection claims** (priority 1): a claim-verb grep across the root contract
  files, `docs/*.md`, `docs/current/*.md` and `docs/capabilities/*.md` for
  `blocks|refuses|prevents|rejects|cannot|is blocked|will refuse|deletes|
  protect|gate|enforce`, then every hit read in context and traced to code. 
  `docs/DATA_RETENTION.md` was verified independently rather than inherited from
  pass 3 — the whole document was read, and each of its three deletion
  mechanisms traced separately into the schema, the server module, the CLI
  script and the workflow.
- **Capability modules** (priority 4): the sample is the **intersection of two
  filters** — status field reads `DONE` (a claim that something shipped) **and**
  the module sits in a safety, consent, privacy or governance category. That
  gave 9 files (003, 043, 082, 151, 164, 194, 200, plus 034 and 170 pulled in by
  cross-reference), which is the whole of that intersection for the categories
  named, not a random draw. Separately, all 201 modules were machine-scanned for
  status and for the scaffold sentinel string.
- **Broken references** (priority 6): two scripted sweeps over all 440 files —
  one resolving every Markdown `[](path)` link, one resolving every backticked
  string matching `^(apps|packages|infra|scripts|docs|design-system|intake|
  .github)/`, with `path:line` suffixes and globs stripped. 574 backticked path
  citations and every Markdown link were checked.

### De-duplication

Findings already recorded in `docs/capabilities/NETWORK_STATUS.md` or in passes
2/3/4 are **not re-reported as new**. Where this pass independently confirmed
one, it says so and points at the prior record. The known absence of
`docs/capabilities/NETWORK_STATUS.md` from `main` is not re-reported.

---

## Docs that claim a protection the code does not provide

This section is the headline, and it is almost entirely one document.

`docs/DATA_RETENTION.md` is the only document in scope that describes itself as
a **policy** rather than a plan, a proposal, or a doctrine paper. It carries an
effective date, names a policy owner, claims compliance scope over FERPA, COPPA
and GDPR, and closes with "Contact your organization's privacy officer". It
reads exactly like a document an organization would hand to a parent who asked
"what happens to my daughter's photographs when she leaves". Four of its
load-bearing claims are false against the code, and the falsity runs in the
direction that matters: it promises more protection than exists.

The gap has four independent parts, so they are four findings rather than one:

1. **The categories.** Photos, videos, medical records, waivers and training
   notes are each given their own retention window and deletion trigger. Two
   tables get a `deleted_at` column. No blob is ever deleted. `pilot.video_sessions`
   does not even carry a foreign key to `pilot.athletes`.
2. **The mechanism.** The named script does not exist under that name, and the
   scheduled job that does exist is hard-wired to dry-run mode on every
   scheduled firing.
3. **The console.** `/admin/data-deletion` — cited twice as the place an admin
   goes — has no page, no navigation entry, and no caller in the app.
4. **The reversal.** "Reversible for 1 year" describes a restoration path with
   no code behind it at all.

The rest of the corpus came out far better than that. The SHADOW doctrine
papers, the role model, the auth contract, the production-state ledger and the
capability-module tree are, with the exceptions listed below, careful and
self-correcting — several of them audit themselves in place and record their own
retractions. That is worth saying plainly, because it means the retention policy
is an outlier rather than the house style, and fixing it is matching an existing
standard rather than inventing one.

---

## Contract files vs. code

Verified against code: `AUTH_CONTRACT.md`, `ORGANIZATION_ROLE_MODEL.md`,
`AGENT_KERNEL.md`, `AGENTS.md`, `MASTER_INDEX.md`, `README.md`,
`DEVELOPER_ONBOARDING.md`, `SEED_GUIDE.md`, `PPBF_CAPABILITIES.json`.

**No contract file states a safety rule the code violates.** That is the
single most reassuring result of this pass, and it deserves to be stated before
the exception. `AUTH_CONTRACT.md`'s role enum, cookie flags and endpoint paths
all match. `ORGANIZATION_ROLE_MODEL.md`'s board boundary — the narrowest and
most consequential claim in the contract set — is true in code at every point
checked.

One exception, and it is procedural rather than safety-bearing:
`docs/AGENT_EXECUTION_POLICY.md` is a second, unlinked document that instructs
agents to read *it* first and declares itself binding, contradicting
`AGENT_KERNEL.md` on three points. Written up as Finding 5.

`PPBF_CAPABILITIES.json` is honest: every one of its 25 headline capabilities
carries `"status":"DRAFT"`, its `governance` block reads `{"active":false}`, and
its own version string is `2.0.0-draft-merged`. It claims nothing about shipped
behaviour and therefore contradicts nothing. Its only defect is a count
mismatch noted under "Stale but unmarked".

---

## Stale but unmarked

`docs/MULTI_AI_EXECUTION_PLAN.md` is explicitly marked SUPERSEDED, and so are
`docs/PRODUCTION_READINESS.md` (a full explanatory banner naming the Supabase
architecture it describes) and `docs/governance-rules.md`. Those are the
correct pattern.

Files that are stale in fact and carry **no** marker:

| File | What is stale | Severity |
|---|---|---|
| `docs/capabilities/README.md` | Its status table and its headline summary are wrong by 75 modules. Finding 7. | LOW |
| `docs/capabilities/expanded-200-index.json` | 198 of 200 entries say `DRAFT` while the CSV it was generated from says 94 `DONE`. Frozen at `2026-08-03T04:01:06Z`. Finding 8. | LOW |
| `docs/capabilities/modules/082-…md` | States "The #34 tracker marks Return-to-Training DONE with no code behind it" — no longer true; `createReturnToTrainingPlan` / `addReturnToTrainingStep` / `advanceReturnToTrainingStep` and `pilot.return_to_training_plans` now exist in `safetyFlags.ts`. A stale note *against* the code's favour. | LOW |
| `docs/RESEARCH_EVIDENCE_REGISTRY.md` | Points readers at two documents that have never existed. Finding 9. | LOW |
| `PPBF_CAPABILITIES.json` | `"governanceAdminNonprofit": {"count":14, …}` vs. 15 rows in that category in `expanded-200-backlog.csv`; total detailed modules 200 vs. 201 CSV rows. | LOW |

Nothing under `docs/current/` was found stale. `ACTIVE_WORK.md`,
`PRODUCTION_STATE.json` and `ATTENDANCE_PRECEDENCE.md` are all current,
dated, and consistent with `AGENT_KERNEL.md`'s source hierarchy.
`PRODUCTION_STATE.json` in particular records its own observation limits
("Read from the run log, NOT from the database — an observation of the runner,
not of the schema") and is the best-disciplined artifact in the repository.

---

## Findings

### [CRITICAL] `DATA_RETENTION.md` gives photos, videos, medical records and waivers their own deletion schedule; no code deletes any of them, and video rows are not even reachable from an athlete deletion

**The doc's claim** — `docs/DATA_RETENTION.md:26-29`:

> `| Athlete photos/videos | Until relationship ends + 2 years | Safeguarding: visual evidence of consent, condition at withdrawal | Athlete withdraws or turns 18 + 2 years |`
> `| Medical records (intake form) | Until relationship ends + 3 years | Legal: state athletic commission requirements | Athlete withdraws or turns 18 + 3 years |`
> `| Waivers and consent forms | Until relationship ends + 3 years | Legal: liability defense window | Athlete withdraws or turns 18 + 3 years |`

and `docs/DATA_RETENTION.md:103-106`:

> `Parent account deleted`
> `  → All linked athlete records marked deleted`
> `    → All athlete photos marked deleted`
> `    → All athlete videos marked deleted`
> `    → All training notes marked deleted`

**The code that contradicts it** — the entire deletion body of
`apps/web/src/server/pilot/dataDeletion.ts:208-225`:

> `    // Delete athletes soft-deleted more than 2 years ago`
> `    const athleteDelete = await client.query(`
> `      \`delete from pilot.athletes`
> `       where deleted_at is not null`
> `         and deleted_at < (now() - interval '2 years')`
> `       returning athlete_id\`,`
> `    );`
> `    totalDeleted += athleteDelete.rows.length;`
> ``
> `    // Delete accounts (parents) soft-deleted more than 1 year ago`
> `    const accountDelete = await client.query(`
> `      \`delete from pilot.accounts`
> `       where deleted_at is not null`
> `         and deleted_at < (now() - interval '1 year')`
> `         and role = 'parent'`
> `       returning account_id\`,`
> `    );`

Two tables. No photo table, no video table, no waiver table, no medical table,
no observation table, and no blob.

The migration that was supposed to build this says so itself —
`infra/azure/pilot_slice_postgres_data_retention_deletion_migration.sql:16-20`:

> `-- --- pilot.accounts: track guardian/parent deletion ---`
> `alter table pilot.accounts add column if not exists deleted_at timestamptz null;`
> ``
> `-- --- pilot.athletes: track athlete withdrawal ---`
> `alter table pilot.athletes add column if not exists deleted_at timestamptz null;`

And the video table has no relationship to an athlete that any cascade could
travel — `infra/azure/pilot_slice_postgres_video_sessions_migration.sql:65-72`:

> `create table if not exists pilot.video_sessions (`
> `  video_session_id text primary key,`
> `  organization_id text not null,`
> `  uploaded_by_account_id text not null,`
> `  athlete_id text null,`
> `  title text not null,`
> `  notes text not null default '',`
> `  blob_path text not null,`

`athlete_id text null`, no `references pilot.athletes`, no `on delete cascade`,
no `deleted_at`. A minor's footage survives every deletion path in the platform
by construction.

**Refutation attempted, and what it found.** Three attempts.

1. *Is deletion implemented under another name?* Searched all of `apps/web`,
   `packages`, `infra` and `scripts` for blob deletion. Exactly two call sites
   exist, `apps/web/src/server/pilot/blob.ts:203` (`deletePilotProfilePhoto`,
   reached only from portrait review and the profile photo route) and
   `blob.ts:280` (the gym-wall slot). Neither is reachable from athlete or
   guardian deletion, and neither touches `pilot.video_sessions`.
2. *Do foreign keys do the work the doc attributes to a cascade?* Partially, and
   this is the one place the doc understates rather than overstates — see
   Finding 4. `pilot.waivers` and `pilot.medical_intake` both carry
   `on delete cascade` to `pilot.athletes`, so they *are* removed, but only when
   the athlete row is hard-deleted, and on the athlete's 2-year clock rather
   than their own documented 3-year one. `pilot.video_sessions` has no such
   constraint. `pilot.coach_observations` survives by design and the code says
   so (`dataDeletion.ts:147-151`: "NOT a deletion count: a soft delete leaves
   the athlete row in place, so the FK cascade does not fire and nothing here is
   removed").
3. *Is there a second implementation elsewhere?* `purgeExpiredDeletedData` has
   no caller anywhere in the repository — this pass confirms the finding
   `NETWORK_STATUS.md` already records; the live path is the separate
   `apps/web/scripts/pilot-cleanup-deleted-data.mjs`, whose two `delete from`
   statements (lines 131 and 136) name the same two tables.

The claim survives all three attempts.

**Who would be misled, and how.** A guardian asks what happens to the photos and
video of their child. An organization admin reads `docs/DATA_RETENTION.md` —
which is linked from `MASTER_INDEX.md` under "Operations" alongside the backup
and migration runbooks, so it reads as an operational document rather than a
draft — and answers truthfully from it: photos and video are deleted two years
after your child leaves. Nothing deletes them. The blob container still holds
the bytes, and `pilot.video_sessions` still holds the row pointing at them, for
as long as the storage account exists. The same reading also underwrites a COPPA
or GDPR erasure response the organization cannot actually perform.

---

### [HIGH] `DATA_RETENTION.md` names a daily deleting script; the script name is wrong and the scheduled job it maps to can never delete

**The doc's claim** — `docs/DATA_RETENTION.md:59`:

> `A scheduled script (\`npm run pilot:cleanup-expired-data\`) runs daily and hard-deletes data that has reached the end of its retention window.`

**The code that contradicts it.** There is no such npm script. The nearest one
is `pilot:cleanup-deleted-data` (`apps/web/package.json:76`), and the workflow
that calls it on a schedule pins its apply flag to an input that a scheduled run
cannot supply — `.github/workflows/retention-cleanup.yml:144-152`:

> `      # A scheduled run has no inputs, so \`inputs.apply\` is empty and this`
> `      # resolves to false. Deleting can therefore only ever be a deliberate`
> `      # dispatch by a person who typed APPLY.`
> `      - name: Sweep Expired Records`
> `        env:`
> `          PPBF_RETENTION_APPLY: ${{ inputs.apply == 'APPLY' }}`
> `          PPBF_RETENTION_MAX_ROWS: ${{ inputs.max_rows || '50' }}`
> `        run: |`
> `          npm --prefix apps/web run pilot:cleanup-deleted-data | tee cleanup-result.json`

The daily `cron: '40 7 * * *'` at line 50 therefore fires a report, never a
deletion.

**Refutation attempted.** Searched `package.json`, `apps/web/package.json` and
every workflow for `cleanup-expired-data`; the only hits in the tree are
`cleanupExpiredSessions` (session tokens, an unrelated 7-day job in `auth.ts`)
and `cleanupExpiredEntries` (an in-memory rate-limit sweep). Checked whether any
other workflow sets `PPBF_RETENTION_APPLY=true` — none does. The claim stands.

Worth recording in the code's favour: the dry-run default is a **good** design
decision, argued at length in `pilot-cleanup-deleted-data.mjs`'s header ("A
destructive default would mean a mistyped command, or a copy-pasted CI step, is
unrecoverable"). The defect is that the policy document describes the opposite
posture. The right fix is almost certainly to correct the document, not the job.

**Who would be misled, and how.** Anyone verifying compliance. The document's
own "Compliance Verification" section (lines 195-215) tells a reader to run
`SELECT COUNT(*) FROM pilot.athletes WHERE deleted_at IS NOT NULL AND deleted_at
< (now() - interval '2 years')` and says it "Should return 0 rows if cleanup is
working". On a system where the scheduled job has only ever dry-run, that query
returns a growing number, and the reader has no way to tell from the document
whether they are looking at a broken job or a job that was never armed. Pass 3
already recorded that whether the purge has *ever* run in APPLY mode could not
be established from inside the repository; this finding explains why the answer
is very likely "no" and why nothing in the document would tell you.

---

### [HIGH] The admin console `DATA_RETENTION.md` routes every deletion request through does not exist, and neither does the one-year reversal it promises

**The doc's claim** — `docs/DATA_RETENTION.md:80` and `:132`:

> `1. Admin navigates to \`/admin/data-deletion\``
> `1. Admin opens \`/admin/data-deletion\``

and `docs/DATA_RETENTION.md:189`:

> `5. **Reversible for 1 year:** If a deletion was a mistake, the organization can request restoration within 1 year (admin privilege, not self-serve)`

**The code that contradicts it.** `apps/web/app/admin/` contains 38 route
directories; `data-deletion` is not among them. The only surface is an
API-only DELETE handler, and its own header says so —
`apps/web/app/api/pilot/admin/data-deletion/route.ts:8-19`:

> `/**`
> ` * DELETE /api/pilot/admin/data-deletion`
> ` *`
> ` * Deletes an athlete or guardian account and marks all linked data for deletion.`
> ` * Organization admin only.`
> ` *`
> ` * Request body:`
> ` * {`
> ` *   "entityType": "athlete" | "guardian",`
> ` *   "entityId": "ath-123" | "acct-456",`
> ` *   "reason": "Athlete withdrew" (optional)`
> ` * }`
> ` */`

A body-carrying `DELETE` is not something a browser issues from a link; it needs
a client, and there is none.

**Refutation attempted.** Four checks. (a) Searched every `.ts`/`.tsx` under
`apps/web/app`, `apps/web/components` and `apps/web/src` for the string
`data-deletion` — the only hit outside the route and its test is nothing. (b)
Searched `apps/web/components/buildingMap.ts`, the navigation registry that
other consoles register a "door" in — no deletion entry. (c) Searched for any
restore path (`restore`, `undelete`, `deleted_at = null`) across the server
modules and API routes — every hit is about retiring/restoring a *drill*, an
*announcement*, or replaying a SHADOW conversation; none clears `deleted_at` on
an account or an athlete. (d) Checked whether `getDeletionStatus`
(`dataDeletion.ts:255`), which would power the document's "Data deletion status"
compliance report, has a route — it does not; its only importer is its own test
file. All four confirm the claim.

**Who would be misled, and how.** An organization admin acting on a guardian's
erasure request. The document gives them a nine-step console workflow ending in
a confirmation message — "Deletion complete. 14 records marked for purging."
(line 89) — and a promise they can undo it for a year. In reality there is no
console to open, the deletion can only be performed by someone able to issue a
hand-built HTTP request, and if the wrong `entityId` is sent there is no code
path anywhere that puts the record back. The guardian is told a reversible,
audited, self-service process exists. It does not.

---

### [MEDIUM] The retention windows in `DATA_RETENTION.md` do not match the intervals in code, and medical records and waivers are destroyed a year earlier than documented

**The doc's claim** — `docs/DATA_RETENTION.md:25`:

> `| Athlete record (name, DOB, contact info) | Until relationship ends + 1 year | Legal/accounting; insurance claims may arise 1 year later | Athlete withdraws or turns 18 + 1 year |`

with medical records and waivers both documented at three years (lines 27, 29).

**The code that contradicts it** — `apps/web/scripts/pilot-cleanup-deleted-data.mjs:47-48`:

> `const ATHLETE_RETENTION = "interval '2 years'";`
> `const ACCOUNT_RETENTION = "interval '1 year'";`

The athlete record is kept two years, not the documented one. And because
medical records and waivers have no clock of their own — they ride the athlete
row's FK — they are destroyed at that two-year mark, not their documented three:
`infra/azure/pilot_slice_postgres.sql:406` and `:423`:

> `  constraint pilot_medical_intake_athlete_fk foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade`
> `  constraint pilot_waivers_athlete_fk foreign key (organization_id, athlete_id) references pilot.athletes(organization_id, athlete_id) on delete cascade`

**Refutation attempted.** Looked for any per-category retention configuration —
a table of windows, an env var, a policy row — that would let the documented
three-year window be applied independently. There is none: the two interval
constants above and the two hard-coded intervals in
`dataDeletion.ts:212`/`:221` are the complete set of retention arithmetic in the
repository. Also checked whether waivers or medical records carry their own
`deleted_at`; neither table has the column.

**Who would be misled, and how.** This one cuts against the organization rather
than the family, which is why it is MEDIUM rather than HIGH — but it is a real
exposure. The document tells the organization it holds waivers for three years
"Legal: liability defense window" and medical intake for three years "Legal:
state athletic commission requirements". If the purge is ever armed, both are
gone at two. Counsel relying on this document would believe a signed waiver was
still on file for a year during which it had been destroyed, with only an audit
row recording a count.

---

### [MEDIUM] `docs/AGENT_EXECUTION_POLICY.md` declares itself the first thing to read and binding on all agents, and contradicts `AGENT_KERNEL.md` on three rules

**The doc's claim** — `docs/AGENT_EXECUTION_POLICY.md:146-152` and `:180`:

> `## Session Initialization`
> ``
> `When a Claude Code session starts:`
> ``
> `1. **Read this file first** (you are reading it now)`

> `*This policy was authored as a durable system-level standard for multi-agent execution. It is binding for all AI agents working in this repository.*`

**The contract it contradicts** — `AGENT_KERNEL.md:3` and `:31`:

> `The shortest authoritative startup contract for AI work in this repository.`

> `5. **Claims need evidence.** Prefer the smallest relevant executable check while iterating; run the required final gate before claiming completion.`

Three specific conflicts, each verbatim on both sides:

| Subject | `AGENT_EXECUTION_POLICY.md` | `AGENT_KERNEL.md` / `ACTIVE_WORK.md` |
|---|---|---|
| Which file is authoritative | `:150` "**Read this file first** (you are reading it now)" | `CLAUDE.md:3` "Read `AGENT_KERNEL.md` first. It is the single default execution contract for this repository." |
| The work queue | `:59` "Reference `docs/current/WORK_QUEUE.md` as the authoritative queue — it is the single source of truth for what is open, in progress, or staged." | `AGENT_KERNEL.md:70` "`docs/current/WORK_QUEUE.md`, dated audits, archived documents, superseded plans, and old local branches are historical/provenance evidence only." and `docs/current/ACTIVE_WORK.md:5` "Do **not** preload `docs/current/WORK_QUEUE.md` for ordinary implementation." |
| Tickets and test scope | `:161` "File an audit ticket or add it to BACKLOG in the queue. Don't fix it without claiming it first." and `:111` "**Confirm no regressions** — run the full test suite, not just the new test" | `AGENT_KERNEL.md:55` "A ticket is optional for direct user/owner-requested work." and `:56` "During development, run targeted tests first. Do not repeatedly run the entire repository gate after every small edit." |

**Refutation attempted.** Asked whether this file is merely orphaned history
that nobody would reach. Two checks. (a) Grepped the whole tree — every `.md`,
`.json` and `.ts` outside `node_modules` — for the string
`AGENT_EXECUTION_POLICY`. **Zero references.** It is not in `MASTER_INDEX.md`,
not in `AGENT_KERNEL.md`'s read path, not in `AGENTS.md` or `CLAUDE.md`. (b)
Checked whether it is marked stale — it is not; it carries
`**Last updated:** 2026-08-15`, the same week as the owner decisions in
`ACTIVE_WORK.md`, and no supersession banner. So it is unreferenced *and*
undated-as-stale *and* self-declaring as binding — which is the combination that
makes it dangerous rather than harmless: nothing routes an agent to it, but
anything that lists `docs/` or greps for "policy" finds a recent, confident,
binding-sounding document.

**Who would be misled, and how.** An agent session that discovers this file
before the kernel — plausibly, since its filename is the most policy-sounding in
`docs/` — would preload `WORK_QUEUE.md` (which `ACTIVE_WORK.md` explicitly
forbids), refuse to act on a direct owner request without first filing a ticket,
and run the full repository gate after every edit. None of that endangers a
child. It does mean two documents each claim to be the single contract, which is
precisely the "two overlapping systems" failure `NETWORK_STATUS.md` records the
project as having already retired once with `MULTI_AI_EXECUTION_PLAN.md`. The
cheapest fix is a supersession banner pointing at `AGENT_KERNEL.md`, exactly as
`docs/governance-rules.md` already does.

---

### [MEDIUM] Capability module 082 describes `conditioning_only` holds as reducing permitted intensity; nothing in the codebase reads that scope

**The doc's claim** — `docs/capabilities/modules/082-stop-hold-regress-engine.md:19-20`:

> `history; **Regress** — a scope-restricted hold (\`contact_only\` /`
> `\`conditioning_only\`): training continues at reduced permitted intensity.`

The file's status field reads `| Status | **DONE** |` at line 5.

**The code that contradicts it** — the only enforcement read for a scoped hold,
`apps/web/src/server/pilot/trainingHolds.ts:455-459`:

> `      \`select hold_id, scope`
> `       from pilot.training_holds`
> `       where organization_id = $1 and athlete_id = $2`
> `         and status = 'active'`
> `         and scope in ('all_training', 'contact_only')`

`conditioning_only` is absent from that list and from every other predicate.
A repository-wide search for the literal across non-test `.ts`/`.tsx` returns
six hits: the type union and the `TRAINING_HOLD_SCOPES` array
(`trainingHolds.ts:45,52`), a route-level input validation string
(`app/api/pilot/training-holds/route.ts:165`), and three **display labels** —
`app/parent/safety/page.tsx:38`, `app/admin/safety-review/page.tsx:14`,
`app/coach/progression-intelligence/page.tsx:97`. Not one predicate, filter, or
refusal.

**Refutation attempted, and the result is partly a refutation.** The module doc's
*other* claim — the STOP rung — is **true**, and was verified rather than
assumed: `apps/web/src/server/pilot/schedulerDb.ts:215-222` calls
`findRegistrationBlockingHold` inside the registration transaction and returns
`outcome: 'training_hold'`, exactly as documented. So this is one false rung in a
module whose other rungs hold. I also checked whether "reduced permitted
intensity" is enforced somewhere outside `trainingHolds.ts` — through
`contactClearanceGate.ts`, `safetyGateMatrix.ts` or the observation route — and
found only the contact-surface *flag* path, which `trainingHolds.ts:430`
describes accurately in its own comment as "A FLAG, never a block".

**De-duplication.** `NETWORK_STATUS.md` already records the code-side fact
("`conditioning_only` holds enforce nothing … while `/parent/safety` tells a
guardian 'Conditioning is paused right now'"), and pass 4 broadened it to all
three scopes. What is new here is only that the **capability record marked DONE
says the same thing the parent-facing UI says**, so a reader who checks the
module doc to see whether the UI copy is trustworthy gets the wrong answer twice
from two independent sources. Severity is held at MEDIUM rather than HIGH for
that reason: the underlying safety gap is already on the books and owned.

**Who would be misled, and how.** A coach or admin deciding whether a
`conditioning_only` hold is sufficient for a child who should not be doing
conditioning work. The module record says training continues "at reduced
permitted intensity"; the parent screen says "Conditioning is paused right now";
the code does nothing at all. The honest sentence is in `trainingHolds.ts:365-368`
— "the scoped rungs enforce at the contact surface (contactClearanceGate) and
inform on the athlete banner instead" — and it appears in the one place a
non-engineer will never look.

---

### [LOW] `docs/capabilities/README.md` is presented as current guidance and its headline numbers are wrong by 75 modules

**The doc's claim** — `docs/capabilities/README.md:130-138`:

> `\`expanded-200-backlog.csv\` is the source of truth for status; the module stubs`
> `mirror it. As of this commit:`
> ``
> `| Status | Count |`
> `|---|---|`
> `| DRAFT | 178 |`
> `| DONE | 19 |`
> `| QUEUED | 2 |`
> `| IN_PROGRESS | 1 |`

and `:108-109`:

> `Until a human runs the checklists, the accurate summary of this backlog is`
> `**"19 modules mapped, none verified"**, not "19 modules done."`

**The data that contradicts it.** Parsing `docs/capabilities/expanded-200-backlog.csv`
today gives `Counter({'DRAFT': 101, 'DONE': 94, 'DEFERRED': 6})` over 201 rows,
with `ManualVerification` at `NOT_REQUIRED: 107, PENDING_SIGN_OFF: 89, PASSED: 5`.
Row 4 of that CSV is a direct example — the module the README's own spot-check
table does not cover:

> `"3","Safety Gate System","coreAthleteSystem","Core Athlete System","DONE","False","True","2.0.0-draft-merged","11 Safety Gate","PASSED"`

`QUEUED` and `IN_PROGRESS` no longer occur at all; `DEFERRED` is a status the
README does not mention.

**Refutation attempted.** Asked whether the README is scoped to a past commit
and therefore correct as written. It says "As of this commit", which is a
snapshot claim — but the file carries no date in its status section, no
supersession banner, and its opening frames it as live guidance on "what their
statuses actually mean". It is also the only document explaining what `DONE`
means in this tree, so a reader has no alternative to consult. Separately
checked its most important claim — "Nothing in the running application reads any
of this" — and it **remains true**: a repo-wide search for
`expanded-200-backlog`, `expanded-200-index` and `PPBF_CAPABILITIES` finds no
consumer in `apps/web`. That is why this is LOW: no user-facing surface renders
these numbers.

**Who would be misled, and how.** Any agent or reviewer trying to judge how much
of the platform is built. The README's framing — "19 modules mapped, none
verified" — is a modest, honest characterisation of a 200-row backlog. The
current reality, 94 `DONE` with 37 of those files still containing the literal
scaffold sentinel `_Scaffold only. Do not mark active until promotion review._`,
is a much weaker position that the README's own careful language would have
flagged had it been kept current. The README is right about the *risk* and stale
about the *size* of it.

---

### [LOW] `expanded-200-index.json` says 198 of 200 modules are DRAFT while the CSV beside it says 94 are DONE

**The doc's claim** — `docs/capabilities/README.md:130`:

> `\`expanded-200-backlog.csv\` is the source of truth for status; the module stubs`

**The data that contradicts it.** `docs/capabilities/expanded-200-index.json`
is generated from `PPBF_CAPABILITIES.json` and frozen — its own header reads
`"generatedAt": "2026-08-03T04:01:06.9161692Z"`. Parsed today its status
distribution is `Counter({'DRAFT': 198, 'DONE': 2})`, against the CSV's 94
`DONE`. Its entry for the very first module reads:

> `{"ModuleId": 1, "Name": "Athlete Profile System", "CategoryKey": "coreAthleteSystem", "CategoryLabel": "Core Athlete System", "Status": "DRAFT", ...}`

while `docs/capabilities/modules/001-athlete-profile-system.md:5` reads
`| Status | **DONE** (Wave 9 reconciliation) |`.

**Refutation attempted, and one claim retracted as a result.** I expected to
report `docs/capabilities/modules/200-privacy-tier-system.md`'s statement "The
index now says DONE to match" as false. It is **true** — module 200 is one of the
two `DONE` entries in the index. The finding narrowed to the general drift, and
the module-200 claim is recorded under "Checked and found accurate" instead.
Also checked whether the index is read anywhere in `apps/web` — it is not.

**Who would be misled, and how.** A reader who opens the JSON rather than the
CSV, reasonably, because a machine-readable index looks more authoritative than
a spreadsheet. They would conclude essentially nothing has been built. As with
the README, no user-facing surface consumes it, which caps the severity.

---

### [LOW] Unresolvable citations

Two scripted sweeps over all 440 Markdown files. **Markdown links:** 20 broken,
all 20 inside `docs/archive/` (dead `infra/supabase/*.sql` paths from the
pre-Azure architecture, and three retired SHADOW debug/migrate routes). Archived
material pointing at an architecture that was replaced is expected and is not
reported as a defect. Every link in `MASTER_INDEX.md`, `README.md`,
`AUTH_CONTRACT.md` and `ORGANIZATION_ROLE_MODEL.md` resolves.

**Backticked path citations:** 574 checked, 24 distinct unresolvable after
stripping `path:line` suffixes and globs. The known `docs/capabilities/NETWORK_STATUS.md`
absence is excluded as instructed. The rest fall into three groups:

*Documents that have never existed* — `docs/RESEARCH_EVIDENCE_REGISTRY.md:35-36`:

> `Both run without a database or credentials. See \`docs/CITATION_VERIFICATION.md\` and`
> `\`docs/RETRACTION_SURVEILLANCE.md\`.`

Neither file exists anywhere in the repository (`find` across the whole tree for
`CITATION_VERIFICATION*` and `RETRACTION_SURVEILLANCE*` returns nothing). The
two npm scripts named immediately above that sentence *do* exist
(`apps/web/package.json:194-195`), so the reader is correctly pointed at working
tooling and then at two non-existent manuals for it.

*Missing `apps/web/` prefix* — six citations write `scripts/…` for files that
live at `apps/web/scripts/…`: `scripts/verify-evidence-tier-corpus.mjs` and
`scripts/verify-research-citations.mjs` / `scripts/check-source-retractions.mjs`
(`docs/current/WORK_QUEUE.md:90` and `:92`), `scripts/contrast-sweep.mjs`
(`docs/VISUALS_RECOMMENDATIONS.md:68`), `scripts/lib/postgres-write-target.mjs`
(`docs/SHADOW_RESEARCH_IMPORT_RUNBOOK.md:51`), `scripts/seed-shadow-library.mjs`
(`docs/SHADOW_CHAT_FUNCTIONALITY_AUDIT_2026-07-28.md:434`). The repository has a
real top-level `scripts/` directory, so each of these resolves to a plausible
wrong place rather than to nothing — the more confusing of the two failure
modes.

*Genuinely gone* — `.github/workflows/deploy-shadow.yml`
(`docs/SHADOW_ML_ARCHITECTURE_SPEC.md:1446`),
`apps/web/app/api/pilot/admin/migrate-multiorg/route.ts`
(`docs/PLATFORM_AUDIT_2026-07-31_OWNER_DECISIONS.md:172` — a route whose removal
is itself a recorded safety improvement),
`apps/web/src/server/pilot/migrations/003_create_chat_audit_tables.sql`
(`docs/PLATFORM_AUDIT_2026-07-31_DECISIONS_MADE.md:102`),
`scripts/data/athletes.csv` (`docs/WORK_QUEUE.md:151` — the tree ships
`scripts/data/athletes.example.csv`).

`SEED_GUIDE.md:26`'s reference to `scripts/seed-data.config.ts` was flagged by
the sweep and is **not** a defect: the surrounding instruction is
`cp scripts/seed-data.config.example.ts scripts/seed-data.config.ts`, and the
example file exists. Recorded here so a future sweep does not re-flag it.

---

## Checked and found accurate

These were traced to code and hold. This list is as much the product of the pass
as the findings are — it tells the next reader what they can lean on.

| Document | What was verified, and against what |
|---|---|
| `AUTH_CONTRACT.md` | The nine-value role set at lines 10-12 matches `PilotRole` in `apps/web/src/server/pilot/contracts.ts:1-10` exactly, in the same order. The cookie contract ("`httpOnly`, `sameSite=lax`, `secure` in production") matches `apps/web/app/api/pilot/auth/login/route.ts:134-136` literally. All three "implemented" endpoints exist at the stated paths; `GET /auth/roles` is correctly marked "proposed, not built" and is indeed absent. Every one of its six source-file links resolves. |
| `ORGANIZATION_ROLE_MODEL.md` | The board boundary is true. `assertActorCanAccessAthlete` (`access.ts:292-294`) throws for `board` before any athlete lookup. `BOARD_MINIMUM_COHORT_SIZE = 5` is real at `boardSummary.ts:3` and gates at `:73`. The SHADOW-chat denial is real twice over: `app/api/pilot/shadow/chat/route.ts:500` omits `board` from its `requireRole` list, and `app/api/pilot/board/chat/route.ts:30-32` refuses the role explicitly with the reason the doc gives. **One pedantic inaccuracy, not written up as a finding:** the doc says board is denied "before any other branch", but the `platform_owner` branch precedes it at `access.ts:288`. The substantive claim — no athlete lookup is attempted — is true. |
| `AGENT_KERNEL.md` | Its read path resolves: `docs/current/ACTIVE_WORK.md`, `docs/AI_COLLABORATION.md`, `docs/AI_DELIVERY_PIPELINE.md`, `AUTH_CONTRACT.md`, `ORGANIZATION_ROLE_MODEL.md`, `design-system/README.md`, `design-system/ppbf.css` and `docs/current/WORK_QUEUE.md` all exist. No rule in it is contradicted by code. |
| `MASTER_INDEX.md` | Every Markdown link resolves, including `apps/web/src/design/PAGE_MAP.md` and `docs/current/PRODUCTION_STATE.json`. Its own currency warning is accurate and load-bearing. |
| `README.md` | `npm run gate:pilot` (`apps/web/package.json:87`) and `npm run pilot:apply-schema` both exist. The nine-role list matches `PilotRole`. The migration claim — "No HTTP route changes the schema" — is consistent with the removal of `admin/migrate-multiorg`. |
| `docs/current/ACTIVE_WORK.md` | Consistent with `AGENT_KERNEL.md`'s source hierarchy; the "Builder rule" it states is the one `DEVELOPER_ONBOARDING.md` §4 points at. Its BLOCKED and PARKED rows each carry a concrete re-open condition, as its own parking rule requires. |
| `docs/current/PRODUCTION_STATE.json` | Structurally trustworthy and self-limiting. Cannot be verified against Azure from here — and the file says so itself, distinguishing "read from the run log" from "read back from the database" at every entry, and declaring "Use null / 'not_verified' rather than guessing; a wrong value here is worse than an honest gap." |
| `docs/SHADOW_AUTHORITY_MODEL.md` | Self-audits honestly. Item 2 of its alignment list (`:1041-1043`) says `shadowAuthority.ts` "exists but only four modules import it, so it is not yet the single chokepoint this item describes" — confirmed: three call sites plus one test. Item 4's `pilot.shadow_authority_checks` exists and is written at `shadowAuthority.ts:76-93`. Its future-capability sections are labelled as such ("It does not implement pipelines"). |
| `docs/SHADOW_AI_TECHNICAL_COMPANION.md` | Its "blocks diagnosis, clearance, prescription" line sits under a heading reading `### Target State`, immediately after `### Current State`. A design proposal correctly labelled, not a false claim. |
| `docs/capabilities/modules/082-…md` | The **STOP** rung is real and enforced exactly where documented — `schedulerDb.ts:215-228`, inside the registration transaction, returning the hold's own explanation. Its "Implementation notes" honestly list what was deferred. (The REGRESS rung is Finding 6.) |
| `docs/capabilities/modules/200-privacy-tier-system.md` | Every file it names exists: `privacyTiers.ts`, `guardianAccess.ts`, `privacyTiers.test.ts`, `guardianAccess.test.ts`, `profileVisibility.ts`. Its self-correction "Record of the DONE↔DRAFT drift" is accurate, and its claim "The index now says DONE to match" is **true** — module 200 is one of only two `DONE` entries in `expanded-200-index.json`. Written expecting to refute it; it held. |
| `docs/capabilities/modules/001-athlete-profile-system.md` | Both named routes exist (`app/api/pilot/passbook/route.ts`, `…/gaps/route.ts`), as does `src/server/pilot/passbook.ts`. Its "Promotion blocker" section volunteers a live contradiction against `ParentDigest.tsx` rather than hiding it — the behaviour this pass exists to reward. |
| `docs/capabilities/README.md` §"Nothing in the running application reads any of this" | Still true. No consumer of `expanded-200-backlog`, `expanded-200-index` or `PPBF_CAPABILITIES` exists in `apps/web`. This is what caps Findings 7 and 8 at LOW. |
| `PPBF_CAPABILITIES.json` | Claims nothing it does not have. All 25 headline capabilities carry `"status":"DRAFT"`; `"governance":{"active":false,...}`. Consistent with `Active` being `False` on all 201 CSV rows. |
| `docs/PRODUCTION_READINESS.md`, `docs/governance-rules.md`, `docs/MULTI_AI_EXECUTION_PLAN.md` | All three carry explicit supersession banners naming what replaced them. The correct pattern. |
| `docs/golden-era-phase2-roadmap.md:162` | "**Consent for photos/video of minors:** yes, covered" was investigated as a possible false safety claim and **is not one**. It sits under a heading `### Answers Received`, in a file whose second line reads "*Working document — … Nothing here is locked until we move it into execution phases.*" It records an owner's answer about the gym's paper consents, not a claim about code. Recorded so the next auditor does not spend the same twenty minutes. |
| `apps/web/scripts/pilot-cleanup-deleted-data.mjs` header | Not a doc in scope, but its four documented guards (target guard, dry-run default, blast radius, one transaction) were each verified present in the script body. The code's own prose is accurate; it is `DATA_RETENTION.md` that disagrees with it. |

---

## Could not establish

Recorded as holes rather than guessed, per this repository's own standard.

1. **Whether `docs/DATA_RETENTION.md`'s claims were ever true.** The document is
   dated 2026-08-06 and the retention migration and cleanup script are from the
   same window. Whether the per-category deletion was descoped during
   implementation, or the policy was written aspirationally from the start, is
   not determinable from the working tree, and I did not read branch history to
   find out (out of scope for a read-only docs-vs-code pass, and `git log`
   archaeology on a document is weak evidence about intent). **The useful
   question for a human:** was this document reviewed by anyone outside the
   session that wrote it, and has any version of it been shown to a guardian or
   used in a grant or compliance response? If yes, the correction is more urgent
   than its severity label implies.

2. **Whether any deletion has ever actually been performed.** Establishing this
   needs GitHub Actions run history for `retention-cleanup.yml` — specifically
   whether any dispatch supplied `apply: APPLY` — which nothing in this session
   can see. This is the same hole pass 3 recorded from the other direction.
   Finding 2 narrows it: a *scheduled* run cannot have deleted anything, so the
   question reduces to whether a human ever typed APPLY into the dispatch form.

3. **The 192 capability modules not opened individually.** All 201 were scanned
   for status and for the scaffold sentinel, which is how the "37 of 94 `DONE`
   modules still contain `_Scaffold only. Do not mark active until promotion
   review._`" count was produced. But a module can be substantively wrong
   without containing that string, and the nine read in full are not a random
   sample — they were chosen for safety relevance. **A module claiming a
   hand-off or integration outside the safety categories has not been checked
   by this pass.** `NETWORK_STATUS.md` names two candidates worth starting with
   ("Scenario Simulation and Source Governance are islands with zero data edges,
   whose own copy claims hand-offs that no code implements").

4. **`docs/archive/` (60 files) and `docs/capabilities/work/` (87 files).** Not
   opened. Archive material is explicitly historical under
   `AGENT_KERNEL.md`'s source hierarchy and its 20 broken links are consistent
   with that; the `work/` files are per-module Search/Do plans that
   `docs/capabilities/README.md` itself describes as recording "the plan and not
   the finding". Neither was judged worth the budget against the priorities
   given, but neither was checked, and this pass makes no claim about them.

5. **Runtime behaviour of anything.** No test was run and no server was started.
   Every finding above is static reading. `AGENT_KERNEL.md:31` is right that
   "Code-reading alone is not runtime proof", and that applies to this document
   as much as to any other.

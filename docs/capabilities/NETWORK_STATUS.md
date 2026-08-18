# Capability network — status

What the capability audit found, and what has happened to each finding since.
Written for an agent picking up work who needs to know what is already done,
already in review, or deliberately parked — before spending an afternoon on
something that merged this morning.

## LIVE, 2026-08-18 ~16:38 UTC — two sessions are both merging right now

**If you are reading this in the next hour or so: STOP and check `gh pr list`
before merging anything.** Another session (not this one) merged #421, #416,
and #467 directly in the last few minutes while this session was mid-way
through its own pass over the same open-PR backlog. Neither session
coordinated the timing — this file is being updated after the fact, not
before, which is exactly the gap it exists to close. If you are a third
session arriving now: **do not start a new sweep of the open-PR list until
you have re-fetched it fresh** — several rows below may already be stale by
the time you read them.

**PR #447 closed as superseded, not merged.** It was a 9-commit bundle from a
capability-network audit, ~2 days stale. Checking it against current `main`
before touching anything found 8 of its 9 commits already independently
shipped via other merged PRs (#450, #439, #438, #440, #448, #443, #445,
#441) — and its video-scan escalation commit isn't just duplicated, it's
**contradicted** by the merged #439 (narrower verdict set, hard-fixed
severity vs. #439's per-verdict severity). Its `docs/handoffs/HANDOFF_*.md`
files are also near-duplicates of the `docs/HANDOFF_*.md` files #437 already
landed at the repo root. **One piece was genuinely non-redundant and is
still worth building**: a compliance-rules route plus an "Escalate to
Compliance" UI action on the Film Study review queue (commit `b65d490e` on
the now-closed branch, `claude/artifact-code-session-7piryt`, if anyone
wants to hand-port it fresh off current `main` rather than dig it out of
history). See the closing comment on #447 for the full table.

**A real branch-contamination problem, found by an agent bringing PR #415 up
to date, needs a human decision before anyone touches that branch again.**
`origin/claude/ppbf-platform-orientation-qg4j3b` (PR #415, "staff
credentials") should end at commit `bc1e6967` per the PR's own description
(which says the branch "was trimmed back to its original three
staff-credentials commits"). It does not — the live branch carries four more
commits past that point: a no-op merge of `main`, then three real,
**unrelated** commits (a research-classification taxonomy layer axis, a
SHADOW-library-to-SharePoint mirror, and a Coach Intelligence
safety-escalations digest change) that have nothing to do with staff
credentials and do not exist anywhere in `origin/main`'s history. PR #418
(the next PR stacked on #415) has its own base recorded as `bc1e6967`
exactly, confirming that's the intended tip and the three trailing commits
are stray — most likely the other concurrent session committing to this
branch by mistake instead of its own. **Do not force-push this branch to
reset it without checking whether those three commits represent real,
otherwise-unlanded work first** — they may need to be recovered onto a
different branch before #415 is cleaned up. Left untouched for now; #415,
and the #418→#419→#420 stack on top of it, are on hold until this is
resolved.

**Status as of `origin/main` at `3f961545`, 2026-08-18 09:18 UTC.** This file
carries the commit it was written against because it will go stale. Check
`git log` and the open PR list before trusting any row.

**UPDATE 2026-08-18 09:18 UTC — all eight non-draft batch fixes are now
merged to `main`, one at a time, re-verifying `mergeable_state`/CI fresh
immediately before each merge (never in parallel — see "two things this
exercise taught" below for why):** #465, #466, #468, #469, #470, #471, #472,
#473. See `git log --oneline -10 origin/main` for the squash commits.

**#473's merge needed a real conflict resolution, not just a rebase**: by
the time its Copilot-review follow-up commit was ready, the other seven had
already landed and `mergeable_state` had gone `dirty` — `#466` and `#473`
each independently appended one entry to the same `test:migrations` chain
string in `apps/web/package.json`, so both edits landed in the same
line-range. Resolved by merging `origin/main` into the PR branch and keeping
both new chain entries (`guardian-upsert` then `medical-clearance-expiry`)
plus both new script definitions — an additive, non-semantic conflict, not a
real disagreement. Re-verified after resolving: typecheck clean, lint clean
(same 11 pre-existing warnings, 0 errors), both new pg-tests green,
**full suite 504 suites / 6332 tests green**, then CI green on the merge
commit before merging. If you add a new `.pg.test.ts` migration while
another PR is also mid-flight, expect this exact shape of conflict on
`package.json` — it is mechanical, not a design collision.

**#467** (training-hold place/lift control) stays **draft** per the
visual-review convention. Do not mark ready or merge without explicit
separate instruction. It is the only one of the nine batch PRs left open.

There is a visual version of this at
`https://claude.ai/code/artifact/adc821bb-d309-485a-9ff3-db3e830d4e24`. It is
private unless the owner shares it from the page's share menu, so **this file is
the source of truth** — do not wait on the link.

## How the audit was run, so you can judge it

Eight agents each mapped one cluster of capabilities into nodes (files, tables,
roles) and edges (what reads what). A synthesis pass merged them into one graph.
A third pass hunted only for cross-cluster links the cluster-by-cluster view
structurally could not see. Later passes required every finding to carry a
**verbatim quote** from the file, and had a separate agent re-read that file to
confirm, correct, or retract.

**Treat a "confirmed" finding as _the quote is real_, not _the reasoning is
sound_.** In the last run, fifteen findings produced zero retractions — and the
first high-severity one checked by hand still contained a false sub-claim. Open
the file yourself before acting on any row below.

---

## URGENT — two credentials are still readable in this repository's git history

Actionable today, and the action is **rotation**, not a code change.

`.github/workflows/deploy-staging.yml` twice carried a PIN as a literal. Both were
fixed on `main` — but neither fix removed the credential from `origin`, because
`main`'s history was squash-rewritten while the pre-fix branch commits were left
in place. **The repository is public, so a plain `git clone` still fetches them.**

- `PILOT_ADMIN_PIN` — a 5-digit literal, introduced 2026-07-18, replaced on `main`
  by `7745489c` the same day.
- `PILOT_SHADOW_ATHLETE_PIN` — a 6-digit literal, across six commits 2026-07-29 to
  2026-07-30, replaced on `main` by `79a18771`.

Exact commit SHAs and line numbers are in
`docs/audit-2026-08-18/PASS-11-infra-secrets.md`. **The values are withheld there
and are not written anywhere in these audit files, not even partially** — the SHAs
are enough for the owner to retrieve and rotate them, and a reader without
repository access learns nothing usable.

The second one is doubly worth acting on because the fix commit's own message
already described the risk exactly: *"the gate athlete PIN was a literal in a
public repo"*, against *"a publicly reachable staging login, on an account the
provisioner writes as active with `must_change_pin=false`"*. The fix was right;
it just did not reach the history.

**What to do:** rotate both PINs, and delete or rewrite the stale remote branches
carrying those commits. Removing them from `main` has already been done and is not
sufficient.

## CORRECTED — the video content screen sends frames to a vision service with no consent check

**An earlier version of this section was headed "every child's video has already
been sent to a vision model, unconsented" and said so in the past tense. That
framing was wrong in two specific ways, and the correction matters because the
original could have prompted the gym to notify families about something this
repository cannot evidence happened.** The correction is left visible rather than
swapped in.

### What holds, and it is still worth fixing

**There is no consent check anywhere in the scan path.** This is the strongest
clause and it survived refutation without qualification. Zero consent references
across `videoScanSweep.ts`, `videoScan.ts`, `videoScanPolicy.ts`,
`videoSessions.ts`, or at upload. Inverting the search: all four
`assertGuardianMediaConsent` call sites in the repository are on
publish/compliance/Film-Study paths — none on upload, sweep, scan, policy or
release.

`videoScan.ts:131-147` downloads a minor's uploaded video, extracts up to twelve
frames, and posts them to the Azure OpenAI vision deployment. In the production
configuration, every video the sweep picks up goes through that call.

And the codebase already knows this call needs consent:
`shadow/video-analysis/route.ts` gates the equivalent Film Study call with
`assertGuardianMediaConsent`, under a comment saying that path "must not be a side
door around that gate."

### What was wrong

**1. The past tense is unsupported.** `deploy-production.yml:392-397` records the
owner enabling this gate on 2026-08-01 on an explicit stated basis:

> ```
> # Enabled on the owner's explicit instruction (2026-08-01), on the
> # stated basis that no athlete footage reaches production until the
> # platform is in live use at the gym. So this turns the gate on BEFORE
> # any minor's video exists in production, rather than applying a new
> # automated decision to footage already sitting there.
> ```

The single transmission this repository evidences is a **staging** upload. So this
is a forward-looking exposure to close before the gym goes live, **not** an event
requiring anyone to notify families. Anybody who read the earlier version of this
section should treat that as retracted.

**2. "The ONLY path to a readable video" is false.** That claim rested on a comment
at `videoScanPolicy.ts:174-175` which sits above a `promote` return inside a pure
function — it means "promote is the only *decision* that makes a video readable",
not "no other code writes `ready`". There are three writers.
`video/[videoId]/release/route.ts:96-104` lets a coach promote from `quarantined`
where `scan_state` is human-releasable:

> ```
> update pilot.video_sessions
> set status = 'ready', updated_at = now()
> where video_session_id = $1 and organization_id = $2 and status = 'quarantined'
>   and scan_state = any($3::text[])
> ```

reachable after repeated scan failures with **zero frames transmitted**. A
malware-only configuration also promotes with no vision call at all. So the claim
that Film Study's consent gate necessarily guards a door the data already went
through does not hold in general — only under the vision configuration.

**3. "External" needs restating.** The frames move to a Microsoft-operated
inference service, between Azure services this gym already uses — not to an
unrelated third party. It is still an egress whose data-handling posture this
repository cannot establish, which is why it still matters under the codebase's
own doctrine.

### RESOLVED — the medical-status write closes S-01, and refuses to invent a number: PR #473

Closes the finding that a clearance status feeding contact-decision gates had
**no authority check at all** and **no expiry** — a "cleared" recorded once
counted forever, read by bare equality with no clock involved.

**Both closed for real, not superficially.** `assertShadowAuthority` is now
called with arguments chosen so it can actually deny — `lowRisk: false`
unconditionally for an automatic actor, `reversible: false` because contact
already taken under a wrong "cleared" reading can't be undone — rather than
being wired in as a formality. `automation_mode` is validated against a closed
set at this route too, closing the exact casing evasion (`"Automatic"` vs.
`"automatic"`) an earlier pass found at the sibling sites. The expiry is
enforced through one shared helper both readers now call, so it cannot be
correct on one path and forgotten on the other — and a lapsed clearance reads
as its own state (`cleared_expired`, high severity, its own sentence to the
coach), not silently reclassified as a plain refusal.

**Refused to fabricate the one number that actually matters.** The clearance
validity window — how long a "cleared" should count for — is left as a
structural `TODO(owner)`, not a value, citing `docs/HANDOFF_RESEARCH.md`'s own
standing rule that an uncited plausible answer for a child's medical data is
worse than an admitted gap, because code gets built on it. Mechanism ships;
the number waits for the citation.

**Correctly left the authorization question alone.** Who may write a
clearance is unchanged — still any assigned coach — because narrowing that is
the escalated, parked authorization decision from earlier in this audit, not
something a bug fix should quietly resolve. Pinned as current behavior in the
new tests specifically so a future narrowing is a visible test change, not a
silent one.

Regression-proved empirically: authority check and both expiry reads
neutralized in place → exactly 13 tests go red, nothing else. Full suite
6251/6251, migration ceremony (SQL + runner + npm script + workflow +
coverage guard) complete.

**All nine fixes from this batch opened as #465–#473.** Every review comment
received so far has been addressed and its thread resolved. **All eight
non-draft PRs are now merged to `main`** (#465, #466, #468, #469, #470,
#471, #472, #473) — see the update note at the top of this file. #467 stays
draft per convention, the only one still open.

### RESOLVED — a guardian could permanently see "blocked" for a cleared child: PR #472

The competition training-hold gate recorded `outcome: 'blocked'` on a refusal
and **nothing at all** on a clearance. Both readers of that gate history show
only the most recent row — so a child held out in March, cleared in April,
and entered in every competition since **still reads `training_hold: blocked`
permanently**, because the March refusal is and remains the newest row that
will ever exist. "Always blocked, never passed" reads as "never cleared" —
a false record of the gym's own safeguarding decisions about a real child.

Fixed by routing both outcomes through one helper (same best-effort posture
the refusal branch already had) instead of leaving the pass path silent.
Recorded before the travel-waiver gate runs, deliberately: the hold question
was asked and answered, settled either way by the time gate 3 runs, and a
`'passed'` row has never meant "the whole action went ahead" elsewhere in this
codebase either.

**Caught its own predecessor's mistake in the test suite**: an existing test
asserted "a passing gate records nothing" under a comment that literally
described the bug as intended behavior. Removed, with the rest of that test
(gate lookups happen, entry proceeds) left intact. **Proved the new tests are
real regression tests**, not tautologies, by stashing the fix and re-running —
got exactly the four behavior-pinning failures expected, no others.

### RESOLVED, and found to be systemic: PR #471 (`profile/roster` deleted_at)

Closed, and **wider than reported**: the roster route had *two* `pilot.athletes`
queries missing `deleted_at is null` (own-roster and `?scope=organization`),
not the one the finding named. Both fixed, matching the house convention
(inline, alias-qualified, placed last before `order by` — same shape as
`shadowConversations.ts`/`shadowFeedback.ts`). Regression-proved: reverting
the filter fails 8 of 10 new tests.

**The finding that matters more than the fix**: grepping `deleted_at` across
`apps/web/src/server/pilot/*.ts` turns up exactly three files, all in
`shadow*`. **No non-shadow module filters `athletes.deleted_at` on read at
all** — including three more `pilot.athletes` reads in `profileDb.ts` and the
`entities.ts` reads behind `/api/pilot/athletes/list`. This is not a bug local
to one route; it looks like the retention migration added the column and the
index (`idx_athletes_active_org … where deleted_at is null`, its own comment
calling that "the active-record path, which is every read") without anyone
auditing existing readers against it. Left alone per this PR's scope and
flagged for its own ticket — likely a shared helper plus a convention test
modeled on `organizationScope.convention.test.ts`, asserting every
`pilot.athletes` read carries the predicate.

**Also landed**: two Copilot-review findings on PR #469 (safety-flags) fixed
in a follow-up commit — a whitespace-only `person_account_id` could bypass the
new coach guard (guard checked `.trim()`, write used the raw value) and reach
`raiseSafetyFlag` as a real subject; and the PATCH handler's blanket catch
around the assignment gate turned every failure, including a database outage,
into the same hidden 404 a real refusal produces. Both fixed and tested,
14/14 real-Postgres, 6216/6216 full suite.

### RESOLVED — SAS URLs are no longer cacheable: PR #470

Four routes returned a Shared Access Signature URL to a minor's video or
intake document with no `Cache-Control` header — a SAS URL **is** the access,
not a reference to it, so a copy retained by a browser or shared cache is a
second holder no audit row names and no authorization check ever saw.

**Verified the "four" precisely rather than trusting the finding** — grepped
both SAS-minting entry points in `blob.ts` and read every caller; confirmed no
fifth exists. **Matched an existing documented convention instead of
inventing one**: `apps/web/app/api/pilot/profile/README.md`'s Gate 4 already
states the exact reasoning ("a signed URL to a child's face is a bearer
capability that outlives the session … `no-store` rather than `max-age`
because a photograph whose release is revoked has to stop being served") and
several sibling routes already use it. All four now match.

Left `blob.ts` and the 60-minute expiry value untouched on purpose — that's a
separate finding from the same audit, not this PR's job. Flagged one open
question for the owner rather than deciding unilaterally: JSON responses
elsewhere use two lighter header flavours, and if the house convention should
be the lighter one instead, it's a one-word change across four lines.

### RESOLVED — the safety-flags CRITICAL: PR #469

Closes the finding that raised HIGH → CRITICAL on review: any coach could read
the gym's whole open safety queue, raise a flag against any child, and
**bypass another child's concussion-rest or medical-clearance flag**. Gates
every surface (`GET` by athlete, the coach board via per-row filtering with
`accessibleAthleteIds`, `POST`, `PATCH`/resolve) through the same
`assertCoachAssignedToAthlete` gate `training-holds` already uses — no new
authority model.

**Found and closed a second hole beyond the brief**: `pilot.safety_flags` can
be keyed by `person_account_id` instead of `athlete_id`, and athletes have
accounts too — so a coach permitted to act on an arbitrary account could have
reached any child through that column with the athlete gate never running.
Person-subject flags are now admin-only for a coach.

**Admins verified unnarrowed** — four tests exist specifically to fail if an
admin's org-wide, ungated access is ever accidentally scoped by a future
edit. 18 new tests, real-Postgres suite 14/14, full repo suite 6214/6214.
CI pending as of this note.

Four more agents still running: medical-status write authority + expiry
(S-01), `profile/roster` missing `deleted_at` filter, SAS response
`Cache-Control`, and the competition gate never recording a `'passed'`
outcome.

### Two of three background fixes landed as PRs — #467, #468

- **PR #467** (draft) — wires a real place/lift-hold control into
  `/coach/sports-medicine`. Server untouched; client calls the existing,
  already-correct route. 5 new tests, `designSystemClasses` green (0 invented
  classes). Honest cut-list in the PR body (no `expires_at` control, no
  admin-wide surface, second GET-based hold screen left read-only).
- **PR #468** — closes the contact-clearance/hold-gate coverage hole. Proved
  its own regression-test claim empirically rather than asserting it: with the
  gates neutralized in a throwaway copy, the OLD suite stayed green (7/7) and
  the NEW suite went 20/28 red. Test-only, zero application code touched.
- `fix/safety-flags-athlete-scope` (the CRITICAL bypass) had not yet pushed a
  branch as of this note — check `gh pr list` before assuming it needs
  restarting.

### Snapshot at usage reset — three fixes in flight, unmerged, do not duplicate

Written right before a session usage reset, so state is not lost. If you are
picking this up: check these before starting anything new.

**PR #465** (video consent gate) and **PR #466** (guardian overwrite fix) —
both fixed through real review rounds (Codex + Copilot on #465, Copilot on
#466), both CI pending as of this snapshot, neither merged. Do not open a
competing fix for either finding; check the PR's current state first.

**Three more fixes were dispatched to background agents, each in its own
isolated worktree, none finished as of this snapshot:**

- `fix/safety-flags-athlete-scope` — closing the any-coach safety-flag bypass
  (the CRITICAL raised on review), mirroring `training-holds`' scope check.
- `test/contact-clearance-hold-gate-coverage` — closing the test-coverage gap
  where deleting the contact-clearance/hold gates on the observations route
  leaves the whole suite green.
- `feat/training-hold-place-lift-control` — wiring a real UI control to place
  or lift a training hold, the single highest-leverage item from the unified
  ranking (nothing in the product can currently do this). Draft PR, per the
  visual-review convention.

**If you are a session picking this up after the reset:** check
`gh pr list --state open` for these three branch names before assuming any of
them needs starting from scratch — an agent may have completed and opened its
PR after this snapshot was written, or may still be running.

### RESOLVED — fixed and merged: PR #465

Gates the vision content screen on `assertGuardianMediaConsent`, mirroring
Film Study. Went through two rounds of real review (Codex and Copilot both
independently caught the same P1: an early version forced `content: 'off'` on
missing consent, which — on an environment with malware scanning also off,
which both deploy workflows are — zeroed every gate and resolved to `hold`,
a `scan_state` the claim query never reclaims. A consent-blocked video would
have stopped being scanned forever, even after the guardian later consented.
Corrected to a `skipContentScreen` flag that leaves the gate enabled and
reports "no verdict yet" instead, keeping it on the ordinary retry/backoff
path and re-checking consent on every claim. Direct regression test added
against the real `scanVideoSession` + `decideVideoScanOutcome` proving `hold`
is never reached while a gate is genuinely enabled.

## Live right now — two audits running, plus one thing that needs a merge

Written 2026-08-18. This section is the coordination surface between the
sessions currently working. If you are joining, read this first — it is the part
most likely to save you from redoing somebody's afternoon.

**This file is not on `main`.** It lives only on branch `docs/agent-handoff-briefs`
(PR #437, draft). Anyone told "coordinate through NETWORK_STATUS.md" who checks
out `main` finds nothing. Until #437 merges, the coordination instruction is
inert for every session that has not been handed the branch name explicitly.
That is the single highest-priority thing in this section, because everything
else here depends on people being able to read it.

### The two audits, and how they divide

They are not competitors and neither is redoing the other.

- **Full-spectrum audit** — `docs/PLATFORM_AUDIT_2026-08-17_FULL_SPECTRUM.md`,
  branch `claude/app-audit-ux-ui-report-78o4cm`, **PR #456** (draft). 13 sections:
  role-by-role UX, route census, capability status matrix, DB/infra, SHADOW,
  forms inventory, governance. Its section 13 already reconciles itself against
  the capability-network audit, checked open PRs before touching anything, and
  fixed three items this file had listed as unfixed (`/admin/escalations` blank
  Source cell, the login test that pinned nothing, the `coachIntelligence.ts`
  false invariant comment). Treat those three as **done, on that branch**.
- **Full-spectrum audit, second run** — `docs/audit-2026-08-18/`, branch
  `docs/full-spectrum-audit-2026-08-18`, pinned to `origin/main` at `04dd116b`.
  Thirteen enforcement-side passes, each writing its own file, indexed by
  `docs/audit-2026-08-18/README.md` with live status. It de-duplicates against
  both the above and this file before reporting anything.

If you are a third session: **do not start a third audit.** Read those two and
pick up something from "Unclaimed" below instead.

### Where the audit stands, for whoever reads this next

Sixteen passes run. **Fifteen wrote reports; pass 14 (role journeys) is being
re-run after two agent deaths** and is the one known gap. Pass 13 (cross-cutting
synthesis) is still open and still reserved for the other session.

Three refutation passes have reported or are running. The two that have reported
produced **six downgrades between them and no retractions**, and — more usefully —
found four findings whose supporting text carried a factual error, plus two
findings the passes they were checking had missed entirely. One of those was an
entry filed under *"checked and found sound"* that was not sound.

**So the operating rule for reading any of this: a "confirmed" row means the quote
is real, not that the reasoning is sound, and a "sound" row means somebody looked
once.** Open the file.

Findings already corrected downward on this page, so nobody acts on a stale
version: the Film Study consent window (HIGH → MEDIUM, and superseded entirely by
the vision-egress finding above), the claim that no coach surface shows a training
hold (false — two surfaces do), the claim that `assertShadowAuthority` cannot deny
anywhere (inert at two of three sites, not three), and this file's whole Postgres
teardown diagnosis (retracted — almost every link was wrong).

### Two sessions are working this audit. Here is the split.

**Do not both work the same pass.** The thirteen passes are indexed in
`docs/audit-2026-08-18/README.md` with live status. Six are claimed and running
on branch `docs/full-spectrum-audit-2026-08-18`; **three are deliberately left
for the other session**, chosen because they are self-contained, need no
coordination with the passes already running, and match work that session has
already done well.

| Pass | Scope | Who |
|---|---|---|
| 1 Authentication & session | Login, magic link, PIN, bootstrap key, session issuance and invalidation, `AUTH_CONTRACT.md` conformance | claimed |
| 2 Authorization & tenancy | done — findings below | claimed |
| 3 Minors' data & consent | done — findings below | claimed |
| 4 Safety gates | done — findings below | claimed |
| 5 API surface | Validation, `jsonError` prefix conformance, idempotency, rate limits, `hiddenNotFound` | claimed |
| 6 Data layer | 88 migrations vs. code, constraints, tenancy columns, policy hiding in DDL | claimed |
| **7 Frontend & design system** | **125 screens: design-system conformance, fabricated-data disclosure, refusal treatment under Law 7, dead ends** | **open — yours** |
| 8 SHADOW subsystem | Authority model as specified vs. built, event model, what drives the job processor | claimed |
| 9 Formulas & thresholds | Registry status vs. callers, provenance of every constant gating a child's training | claimed |
| 10 Tests & CI | What the suites actually pin; would any test fail if a safety gate were deleted | claimed |
| **11 Build, infra & secrets** | **Dockerfiles, deploy config, env handling, secret exposure, `staticwebapp.config.json`** | **open — yours** |
| 12 Docs vs. code | 425 docs: claims contradicted by source | claimed |
| **13 Cross-cutting synthesis** | **Defects visible only between passes — the class that broke `main` three times. Runs last, after every pass reports.** | **open — yours, and best done by whoever did not write the passes** |

Pass 13 is the one worth arguing for. A synthesis written by the session that
wrote the passes will inherit that session's blind spots; written by the other
one it is a genuine second reading. If you take nothing else, take that.

**The standard those passes are held to**, so a hand-off does not lower it:
every finding carries a verbatim quote with `path:line`; a second pass whose job
is to *refute* re-reads each one; "confirmed" means the quote is real, not that
the reasoning is sound; no gap-filling — an admitted hole beats a plausible
number; and nothing gets fixed from inside the audit if it narrows a role gate
or reverses an owner decision.

One result from running that standard, worth knowing before you start: a
severity has already been **raised** on review (safety-flags, HIGH → CRITICAL,
grounds recorded in the audit README) and this file's own prior claim about
training-hold scopes was **corrected as understated**. Both directions happen.
Verifying is not a formality here.

### RESOLVED — the competition-entry hold bypass is fixed and merged

**PR #452 merged as `951030e1`.** A child under an active `all_training` hold can
no longer be entered into an external competition or added to a league roster.
This was the audit's only CRITICAL that had a ready fix waiting, and it is closed.
The section below is kept as the record of what it was, because the *shape* of it
— two tenancy reads mistaken for safety reads — is the thing worth remembering.

### The finding, for the record — a child could be entered into a match under an active hold

Pass 4 of the second audit confirmed this on current `main`, and the fix already
exists and is already green.

`addCompetitionEntry` (`externalCompetition.ts`) and `addLeagueRosterEntry`
(`wrestlingLeague.ts`) check exactly two things — the competition or season
exists in the org, and the athlete exists in the org — and then insert. Neither
reads `pilot.training_holds`, medical status, `pilot.safety_gates`, the
clearance register, or any waiver. The athlete picker on
`operations/external-competition` lists every athlete with no badge and no
filter. So a child under an active `all_training` hold can be entered into an
external boxing competition or added to a league season roster with one
authenticated request.

**PR #452 fixes it, is not a draft, and its `validate` check is green.** No new
work is needed here and nobody should write a second fix. What is needed is a
merge, and per this repository's own rule only the session holding the merge
queue should perform it. If that is you: rebase onto current `main`, let CI
finish on the rebased head, then merge.

### Findings from pass 4 that are new — do not re-find these

Recorded here rather than left in the audit file, because the whole point of
this surface is that the next session does not rediscover them. Each was
confirmed against a verbatim quote; open the file before acting.

- **A hold does not cancel registrations that already exist.** The STOP rung is
  checked once at registration and never again; attendance check-in re-checks
  only that the registration exists. Placing a hold on a child today does
  nothing about the sessions they are already on the roster for. *Corrected on
  verification:* an earlier version of this bullet also said no coach-facing
  screen shows the hold at the door. **That was false** — `CoachWorkspace.tsx:895`
  fetches open escalations and renders `training_hold` cards naming the athlete,
  and `/coach/progression-intelligence` is a second hold reader. A coach is not
  blind to it. Downgraded HIGH → MEDIUM.
- **`/admin/safety-review` double-counts** one compliance violation twice and
  every hold twice in its headline number. This is the *second* instance of the
  collision class that was caught pre-merge on the Morning Read digest — which
  makes it a pattern, not an accident. Before adding a reader of a shared
  register, enumerate every writer.
- **`raiseConductConcern` bypasses the incident-report severity floor** and the
  30-second dedup added by #433, by filing `source_type: 'incident'` directly.
  The same route has no athlete-scope check.
- **All three hold scopes overstate enforcement**, not only `conditioning_only`
  as this file previously recorded. That row was understated and is corrected
  here rather than quietly tightened.
- **`readinessMath.ts` has zero callers** — already known — but the *mechanism*
  is new: the stored readiness score is taken raw from the request body, so the
  clamp and the delta-RPE lock exist in a module nothing calls.
- **`assertShadowAuthority` is inert at two of its three call sites** — the
  medical and waiver intake writes, which are the two that matter. *Corrected on
  verification:* this file previously said it could not deny at **any** of the
  three. That headline was falsified. `review-action/route.ts:86-88` computes
  `lowRisk: action !== 'promote'` rather than asserting it, so `action:'promote'`
  with `automation_mode:'automatic'` genuinely denies. The substance survives,
  the "anywhere" did not.
- **That one working denial branch is evadable.** `automation_mode` is
  unvalidated at two of three sites and carries no column CHECK, so sending
  `"Automatic"` instead of `"automatic"` slips past it. Found by the pass
  verifying the finding above, not by the pass that made it.
- **A covering coach can lift a `medical` hold.** Coach Coverage was already
  recorded here as granting youth-contact access with no clearance check; the
  consequence not previously drawn is that the same assertion admits coverage
  holders to the hold-*lift* path.
- **`TrainingHoldScope` is defined five times** across the codebase, feeding
  three exhaustive maps, one of which has no fallback. This is the same shape as
  the `Record<SuggestionRule, …>` drift that broke `main` three times.

### The retention policy promises deletion that cannot happen

Verified by hand, not relayed. `pilot.video_sessions` declares `athlete_id` as a
bare `text null` with **no foreign key to `pilot.athletes`**, and the table has
**no `deleted_at` column**
(`infra/azure/pilot_slice_postgres_video_sessions_migration.sql:65-80`). Other
tables reference `video_sessions`; it references nothing. So deleting an athlete
cannot reach their footage by cascade, and there is no soft-delete column to
mark it with either. A minor's video is not reachable from any deletion path
**even in principle**.

`DATA_RETENTION.md` gives photos, videos, medical records, waivers and training
notes their own deletion windows. The only deletion code touches `pilot.athletes`
and `pilot.accounts`. Three supporting failures found alongside: the named daily
script `pilot:cleanup-expired-data` does not exist; the workflow that does exist
is hard-wired so a *scheduled* run can never delete; and `/admin/data-deletion`,
cited twice as the admin's console, has no page, no nav entry and no caller,
while the promised "reversible for 1 year" restore has no code at all. One
finding cuts the other way and is worth knowing: waivers and medical records,
documented as 3 years, actually die at the athlete's 2-year clock via FK cascade
— *earlier* than promised.

This is not a documentation nit in this codebase's own terms. `DATA_RETENTION.md`
is linked from `MASTER_INDEX.md` beside the backup runbooks, carries a compliance
scope and a privacy-officer sign-off, and reads as operational policy. A guardian
asking what happens to video of their child would be given a two-year answer.

**Now the reassuring half, which decides whether this is one document to fix or a
systemic problem.** Of 440 documents in scope, **17 were verified TRUE and are
listed by name** in `docs/audit-2026-08-18/PASS-12-docs-vs-code.md` so the next
reader knows what can be trusted. Both root contract files are among them:
`AUTH_CONTRACT.md` matches on role enum, cookie flags and endpoints, and
`ORGANIZATION_ROLE_MODEL.md`'s board boundary holds at every checked point.
**No contract file states a safety rule the code violates.** Six documents are
contradicted, five of them non-safety. **The retention policy is an outlier, not
the house style.**

Two smaller ones for anyone editing docs: `docs/AGENT_EXECUTION_POLICY.md`
declares itself read-first and binding, contradicts `AGENT_KERNEL.md` on three
rules, is unmarked and is referenced by **zero** files — a second binding policy
nobody reads is exactly the overlap that got `MULTI_AI_EXECUTION_PLAN.md`
retired. And capability module 082, marked DONE, says `conditioning_only` holds
mean "reduced permitted intensity" when the scope appears in no predicate
anywhere — independent corroboration, from the docs side, of the hold-scope
finding above.

### The one that changes how much green CI is worth here

**The only route that records contact for a child carries two safety gates that
no test exercises. Deleting both calls leaves all 482 suites and 5,997 tests
green**, and neither lint nor typecheck refuses it — unused imports are warnings,
and `npm run lint` already exits 0 with eleven of them.

The route has no sibling test at all, and its sole test posts a non-contact
observation kind, so both gates short-circuit before doing anything. The route's
own comment says the ordering is load-bearing — that the check "runs BEFORE the
observation is stored, so a failure here aborts the whole request rather than
quietly persisting contact nobody was alerted to". The invariant is written down
and enforced by nothing.

The wider result is more useful than the single finding, and it is not a gloomy
one: **every gate *module* in this repository is genuinely well tested.**
`trainingHolds.pg.test.ts` runs the real scheduler function against real rows and
proves the block, the atomicity and the lift. Three of six gate families are
protected at both the logic and the call site. The gap is not the gates — it is
the two-line *wiring* that connects them to the running application.

So the honest summary for anyone reviewing a PR here: **a reviewer who trusts
green CI is right about the modules and wrong about the wiring.**

Two more from the same pass, worth knowing before you write a test:
`guardianConsent.test.ts:53-66` asserts `ok: true` for a guardian with
`covers_video: false` — so closing the consent-scope gap means editing two tests
that currently encode the gap as correct behaviour. And 70 of 228 API routes are
loaded by no test at all, including `shadow/medical-status`, which is the setter
for the status the contact gate reads.

**On CI:** `ci.yml` is one job of thirteen ordered steps with nothing advisory
and no `continue-on-error` anywhere. Typecheck runs before the tests, so a
typecheck failure means no test executes — exactly the shape of the three
broken-`main` incidents. There is **no workflow-level substitute** for "require
branches to be up to date": no `merge_group`, no CODEOWNERS, no rulesets, and
`cancel-in-progress` reacts to pushes on the PR rather than to `main` moving.
The repository setting is the only fix. Zero skipped tests, zero `.only`, zero
snapshots — genuinely clean on that axis.

### Findings from pass 2 (authorization) — a second thing needing a decision today

**`/api/pilot/safety-flags` has no athlete-scope check** — not at the route, and
not inside `resolveSafetyFlag`, which scopes its `update` by `organization_id`
and `flag_id` alone. Any coach can therefore read the whole gym's open safety
queue (the codes include `medical_clearance_missing` and
`concussion_rest_period`), raise a flag against any child, and **bypass** an open
flag on a child they hold no standing on. Clearing another child's concussion
rest flag is the thing this platform exists to prevent.

The sibling routes refuse exactly this, which is what makes it a miss rather
than a trade-off: `training-holds` carries the comment "no org-wide hold roster"
and calls `assertCoachAssignedToAthlete` at three separate points; `escalations`
scopes coaches to their own athletes. Real mitigations, for the record: an
`external_rule` flag cannot be bypassed (database-constraint backed), and every
resolution writes an audit event with the actor's id and role — but `flag_class`
is set by whoever raises the flag rather than derived from the flag code, so the
class that protects the worst codes is not guaranteed to be on them.

**A coach can overwrite another family's guardian record.**
`POST /api/pilot/intake/domain-upsert` with `entity_type: 'guardian_link'` gates
the athlete side correctly and then passes a raw body `parent_id` *and*
`account_id` into `upsertGuardian`, whose `on conflict … do update` **rewrites**
the named record: phone and email are nulled when omitted (that is the emergency
channel for a minor), and repointing `account_id` hands a chosen account the
guardian role over every child that record carries — **including siblings the
coach has no standing on**.

This matters for how the parked `parent_id` decision gets framed. Both prior
audits describe this route as a *linking* problem. It is also a *rewriting*
problem, and the rewriting half can be fixed without narrowing anything a
legitimate intake edit needs — so **it should not inherit the parked status of
the linking half.** That is the one substantive change to how this file
previously recorded the guardian-link question.


**RESOLVED — fixed, PR #466 open.** `upsertGuardian` now coalesces `account_id`/`phone`/`email` against the existing row instead of overwriting with NULL on omission; `full_name` still overwrites (required at both call sites). Does not touch the parked linking-authorization question below. New real-Postgres test pins the exact audit scenario. Owner review pending.

Two smaller ones worth not rediscovering: `multidiscipline` and
`competence-cohorts` use an exact-match `requireRole(principal, ['coach','admin'])`,
so every provisioned `organization_admin` gets a 403 on a child's
grappling-exposure history — fail-closed, but it will read as a broken page
during a safeguarding investigation, and the tests miss it because they drive
the legacy `'admin'` value. And `DELETE /api/pilot/achievements/mentorships`
authorizes only the mentor side, *after* the `UPDATE` has already committed, so
an unauthorized coach ends the pairing and then receives the 403.

**The reassuring result, which belongs here too.** Pass 2 was sent to find out
whether the "one side checked, the other not" shape behind the `parent_id`
finding repeats elsewhere. It traced roughly 120 two-party link inserts and
found **all but two validate both ends**, several with comments explaining why.
`addCompetitionEntry`, `addLeagueRosterEntry`, `assignBoardSeat`,
`grantCoachCoverage`, the mentorship `POST` and the scheduler's coaching-request
approval all check both sides. So that shape is the exception here, not the
house pattern — do not go hunting it as a systemic problem.

**What pass 2 did not do**, because it matters for how much to lean on it: of
228 routes it classified all of them mechanically, deep-read 31, inspected 22
more at handler level, and **did not open the remaining 175**. No code was run.
Reproduce findings against a live coach session before acting on any severity.

### Findings from pass 3 (minors' data and consent) — also do not re-find these

Pass 3 found **no live exposure** — nothing here means a child is exposed right
now, and it is worth saying that plainly rather than leaving it implied. What it
found is a set of gaps that need a deliberate act, a race window, or an unlikely
sequence to bite. That is a materially different thing from the pass 4 CRITICAL,
which needs one authenticated request.

- **Film Study checks guardian consent at enqueue and never again**, and the
  withdrawal sweep cancels no running job — `cancelJobForActor`'s only caller is
  a user-driven DELETE. There are zero consent references anywhere in the job
  path. That gap is real and worth closing.

  *Corrected on verification, and this file previously told you worse than the
  truth.* An earlier version said the executor "re-validates only the actor's
  role" and that a guardian could withdraw consent and have frames sent
  afterwards. Both overstated. `shadowJobProcessor.ts:172-178` re-loads the actor
  from the live database and re-runs `assertActorCanAccessAthlete` on the subject
  athlete. And the queue *is* driven — `instrumentation.ts:31-39` starts an
  in-process drain loop and the production deploy workflow sets
  `PPBF_SHADOW_WORKER_ENABLED=true` — so the race window is about **30 seconds**
  (`shadowJobWorker.ts:20`), capped at 24h by `expires_at`, not open-ended.
  **HIGH → MEDIUM.** Fix it, but do not treat it as an emergency.
- **Consent scope is enforced by nothing, and defaults to permissive.** This
  file already recorded `covers_video` and `public_use_allowed` as a documented
  MVP cut. What is new: `covers_video` defaults `true` in three places,
  *including on every non-media waiver row*, and the guardian-facing UI presents
  these as controls. Collecting a switch that does nothing is one problem;
  defaulting it to "yes" is another.
- **A coach can silently overwrite an existing guardian's `pilot.parents`
  binding**, severing a real parent from their own child's consent-withdrawal
  path. This is the same "one side checked, the other not" shape as the known
  `parent_id` finding, on the same route. **Both are owner decisions — they
  narrow a role gate coaches use daily, and they should be decided together
  rather than one at a time.** Do not implement either.
- **60-minute unaudited SAS bearer URLs to minors' video, minted in bulk.**
  Anyone holding the URL has the video for an hour, and nothing records who
  minted or used it.
- **A hard-deleted athlete record silently reclassifies a surviving account from
  minor to staff**, releasing the portrait to every coach and admin. Whether
  this has already happened depends on whether the retention purge has ever run
  in `APPLY` mode, which needs Actions run history nobody in these sessions can
  see.
- **`DATA_RETENTION.md` promises deletion that no code performs.** Per-category
  deletion of photos, videos, medical records and waivers is documented; no blob
  byte is ever deleted. A second, unguarded copy of the destructive purge exists
  with zero callers.

**One of the two questions pass 3 could not settle is now answered, from the
repository itself.** What drives the SHADOW job queue: `instrumentation.ts:31-39`
starts an in-process drain loop, enabled in production by
`PPBF_SHADOW_WORKER_ENABLED=true` in the deploy workflow. Nobody needed
production access — it was in the tree the whole time, and this audit had
promoted it to a headline open question. Recorded as a miss, not quietly closed.

**Still unestablished:** whether the retention purge has ever run in `APPLY`
mode. That decides whether the hard-delete reclassification is theoretical or
has already happened, and it needs Actions run history.

**Two new findings came from the pass that was verifying pass 3, not from pass 3:**

- **`profile/roster` does not filter `athletes.deleted_at`.** A withdrawn child
  stays on the live coach roster — name, date of birth, portrait — for the whole
  retention window.
- **The unauthenticated gym wall was cleared as sound, and is not.** Pass 3 filed
  it under "checked and found sound" because `wall_display_full_name` has no
  writer. But `waiver_type` carries no database constraint
  (`pilot_slice_postgres.sql:413`) and `domain-upsert` writes it verbatim from
  the request body, so a coach can mint exactly that row; `signed_by_role` is
  self-declared text, defeating `wallDisplay.ts`'s guardian-signer check. The
  only real brake is an unset environment flag. **A false "sound" is more
  dangerous than a false finding, because nobody re-reads it** — treat every
  "checked and found sound" entry in these audits accordingly.

### Verification is running, and it is moving things — in both directions

Every finding here is re-read by a pass whose job is to **refute** it. Both have now reported. On pass 4's ten findings: **zero retracted, two
downgraded, one narrowed, one corrected — and four of the ten carried a factual
error in their supporting text.** On pass 3's nine: **zero retracted, four
downgraded**, with every re-extracted quote character-exact at its cited line —
so nothing was fabricated; what broke was reasoning and reach.

Two of those errors had already been written into this file and are corrected
above rather than quietly edited: a coach *is* shown training holds, and
`assertShadowAuthority` is inert at two sites rather than all three. If you read
this file before now, those are the two rows that changed.

The refutation pass also found two findings the pass it was checking had missed
entirely. That is the argument for running one at all, and it is why **a
"confirmed" row here means the quote is real, not that the reasoning is sound.**
Open the file before acting on any of it.

The escalation register is now fully enumerated — eight writer call paths across
seven source types, six readers, and one declared source type
(`safety_gate_evaluation`) with no writer at all. That table is in
`docs/audit-2026-08-18/PASS-04-safety-gates.md`; consult it before adding either
a writer or a reader.

---

## Closed — 32, merged

| Gap | Closed by |
|---|---|
| `pilot.shadow_medical_administrative_status` had no authority check and no expiry, so one clearance recorded once counted forever | #473 |
| The video content screen sent frames to a vision model with no guardian consent check | #465 |
| `upsertGuardian` nulled `account_id`/`phone`/`email` on an omitted field | #466 |
| Deleting two contact safety gates from the observations route would leave the suite green (coverage gap) | #468 |
| Any coach could read the whole gym's safety queue and clear another child's concussion flag | #469 |
| Four routes returned a SAS URL (a bearer credential) with no `Cache-Control: no-store` | #470 |
| Coach roster read `pilot.athletes` without excluding soft-deleted (withdrawn) rows | #471 |
| The competition training-hold gate recorded every refusal and no clearance, ever | #472 |
| Film Study analysis ran with no guardian consent check on the footage | #438 |
| A blocked/infected video scan never filed a safety escalation | #439 |
| Competition losses stranded on their own page, never reaching progression | #442 |
| Transfer failures never became suggested progression gaps | #441 |
| Performance Analytics forbade athlete/parent, so gaps arrived unjustified | #446 |
| Research source-submission lifecycle fully built with no UI to reach it | #445 |
| No withdrawal action for competition entries or league rosters | #443 |
| Session-run link accepted by the API but unreachable from the UI | #444 |
| Volunteer roster and login access were permanently disconnected records | #448 |
| A cross-org privilege flag read at login with no way to set it | #449 |
| Shadow-job list authorization ran one query per row | #431 |
| Incident reports could be double-filed by a retry | #433 |
| **Competition entry consulted nothing about the child before writing the link** | **#452** |
| Three progression surfaces could render one child's record under another's name | #460 |
| A rejected Film Study proposal was citable as evidence | #459 |
| Portrait review approved a child's photo without displaying it | #461 |
| The revenue centre presented invented figures as the books | #462 |
| The gate inventory was undocumented | #463 |
| Remaining prototypes undeclared, and sign-in lost silently | #422 |
| Board had no aggregate view of the volunteer roster | #455 |
| Board had no visibility into league or external competition | #457 |
| Lapsed membership was invisible at class registration | #458 |
| Library Q&A knowledge gaps were unreachable from Research Intake | #453 |
| Document ingest reported "configured" without checking real destinations | #412 |

## In review — query GitHub, not this file

At the time of writing, eight of the findings below were addressed by open pull
requests. **Their live state is not copied here on purpose.**
`docs/current/ACTIVE_WORK.md` already rules that "open PR state belongs in
GitHub and should be queried live rather than copied here", and it is right: a
table of PR numbers in a markdown file is stale the moment somebody merges, and
a *stale* list of which files are spoken for is worse than no list, because it
reads as authoritative.

An earlier version of this file carried that table. It was a mistake, and
removing it is the correction.

**To find what is currently in flight and which files it owns:**

```
gh pr list --state open        # or the GitHub UI
git diff --name-only origin/main...origin/<branch>
```

Findings that had a PR open when this was written: the competition-entry
gates, the Morning Read digest's blind spot, rejected Film Study proposals as
evidence, the three child-data fetch races, portrait review, the revenue
centre's fabricated figures, the gate inventory, and lapsed-membership
flagging. Search open PRs by those descriptions rather than by a number that
may already have merged.

## Found after the map — 5, none fixed

**Guardian links accept an unvalidated `parent_id` — HIGH.** The athlete side is
gated by `assertActorCanAccessAthlete`; the parent side is not checked at all. A
coach with legitimate standing on one athlete can attach *any* guardian in the
organisation to them, and that guardian's account then reads the child's
training holds, messages and safety surfaces. Cross-org is blocked;
cross-family within an org is not. The fix narrows a role gate coaches may use
daily — **needs an owner decision, do not just implement it.**

**`/admin/escalations` renders a blank Source cell** for `video_scan`,
`compliance_violation` and `incident` — a stale local copy of
`SafetyEscalationSourceType`, on the page whose own header says a red flag
"lands here, and only here". Both new filers merged today. Clean, small fix.

**93 Postgres test suites leak their data directory — and the diagnosis this
file used to carry was wrong.** It said SIGTERM is Postgres *smart* shutdown, a
lingering client keeps the server alive, a 15-second bail-out resolves anyway,
the directory is deleted mid-write, `ENOTEMPTY` on `pg_wal`, fix with `SIGINT`
plus `fs.rm` retries. Traced end to end against the code as it stands, almost
every link fails: there is **no shared helper** (the teardown is copy-pasted into
93 files, so a one-line fix is a 93-file change); SIGTERM goes to a **Node
wrapper**, not to Postgres; `embedded-postgres` **already sends `SIGINT`**, so
the recommended fix was already the behaviour; `pg.stop()` resolved in **14 ms**
in an instrumented probe, so the 15-second bail-out is never reached; and
**`ENOTEMPTY` appears nowhere in this repository.**

The real defect: `embedded-postgres` registers `AsyncExitHook(gracefulShutdown)`,
and `async-exit-hook` claims SIGTERM for itself and calls `process.exit` on the
next tick after its hook resolves. One SIGTERM starts two shutdowns, the
library's wins, and the wrapper's own `fs.rm` of a ~200 MB tree never completes —
its `catch` never fires because there is no error, only a dead process. Measured:
a suite without a parent-side `fs.rm` left 263 MB behind after a fully *passing*
run; one with it left nothing. 69 of 94 suites leak.

The old diagnosis was specific, mechanistic, plausible and confidently written —
and it was reasoning rather than reading. Worth keeping the retraction visible as
a caution about the rest of this file.

**A comment claims an invariant the code does not hold.** `coachIntelligence.ts`
says shared constants make two attendance rules "never drift apart"; they use
different comparison operators and disagree on the exact-half case.

**A test that pins nothing.** The login route's "a durable store outage does not
lock anyone out" test never simulates an outage — it is byte-for-byte the happy
path.

## Still open from the map — 10

### Blocked on something real — 4

- **The Act 153 / SafeSport clearance register has zero callers.** Complete and
  migrated; wiring it is blocked on establishing the real clearance vocabulary,
  because its four seeded types are hand-written placeholders. See
  `HANDOFF_RESEARCH.md` item 1.
- **Coach Coverage grants youth-contact access with no clearance check** — it
  verifies only that the covering coach is an active account. Blocked on the
  register above.
- **Guardian consent scope is collected and never enforced.** `covers_video` and
  `public_use_allowed` are recorded and read by no gate. Documented as a
  deliberate MVP cut — but the UI collects the switches as though they were
  load-bearing, and `covers_video` defaults to `true`.
- **`conditioning_only` holds enforce nothing.** By design, scoped holds mean
  "training continues at reduced scope" — but `contact_only` got an enforcement
  path and `conditioning_only` got none, while `/parent/safety` tells a guardian
  "Conditioning is paused right now".

### Parked by owner decision — 3

Do not "fix" these. Each is a recorded decision, and reopening one without the
owner is how a parked question becomes an argument.

- Board governance has no path to grants, volunteers, or competition activity.
- Wrestling league has no match results, so the "a loss requires a lesson note"
  rule its sibling enforces has nothing to attach to.
- `LEGACY-READINESS` stays unwired — registered `experimental_unsupported`,
  "must not clear, restrict, or prescribe training". Sent to research framed as
  **validate or retire**, never "wire it in".

### Unclaimed — 3

The most useful place to start if you are looking for work nobody owns.

- Scenario Simulation and Source Governance are islands with zero data edges,
  whose own copy claims hand-offs that no code implements.
- Knowledge Graph's "Pattern" and "Finding" columns are permanently empty —
  nothing emits an event matching those filters.
- Volunteer records carry a free-text `background_check_status` an admin types
  by hand, competing with the structured clearance register.

---

## Two things this exercise taught, worth knowing before you add a PR

**Parallel delivery produced its own defect class.** Twenty-four PRs merged in a
day, and the two worst problems were in none of them individually:

1. `RULE_JUSTIFICATION_FIELDS` is typed `Record<SuggestionRule, …>` — exhaustive
   over a union. Three PRs added a union member without adding the entry. Each
   was green alone; the break existed only in the merge. Since `typecheck` runs
   before any test, **every open PR went red for a defect in none of them** and
   deploys blocked. Three times, on the same type.
2. Two capabilities independently began auto-filing into a register a third
   capability read, so one incident surfaced twice on one screen. The two
   collisions needed *different* fixes, because one register's coverage was
   wider than the thing it duplicated and the other's was narrower.

Neither is visible to per-PR review or per-PR CI. Before adding a reader of a
shared register, ask **who else writes it**; before adding a member to a union,
grep every exhaustive consumer.

The durable mitigation for (1) is a repository setting — "require branches to be
up to date before merging" — not code. It is **not enabled**; raise it rather
than assuming somebody has.

Until it is, the mitigation available today is **serial merging.**
`docs/current/ACTIVE_WORK.md` authorizes an "ordinary bounded PR" to be "merged
by the authoring session once every required check passes" — and that
authorization, read literally by several sessions at once, is precisely how
`main` broke. Each session was obeying it, each PR was green, and the break
lived only in the merge. The authorization is not wrong; what it lacks is an
ordering. So when more than one session is landing work in the same window,
have **one** session own the merge queue: rebase onto current `main`, let CI
finish on the rebased head, merge, then take the next one. Serial merging is
slower by minutes and it is the difference between three broken-`main` incidents
in a day and none. A session that merges its own PR while another PR is in
flight is not doing anything forbidden — it is just skipping the only check
that would have caught this class.

**Collision control lives in `AI_COLLABORATION.md`.** Check current `main`,
`docs/current/ACTIVE_WORK.md`, and the open PR list before editing. The open PR
list is what tells you which files are currently spoken for — this file does not
try to, for the reason given above.

---

## If you are another agent working alongside this one

This file is the shared surface, and it is meant to be written to, not just
read. There is no direct channel between agent sessions — no messaging, and a
published artifact is private to whoever published it — so the repository is
the only place two of us can actually coordinate. That makes this file the
handoff, and a stale one costs somebody real work.

**Claim by lane, and open the PR early.** Coordination here is by *surface*,
not by role — `docs/current/ACTIVE_WORK.md` defines the standing lanes (product
build, SHADOW/statistics, design/visuals, ops/deploy) and the rule that a
session picks one lane and "does not drive-by fix another lane's surface". Pick
a lane, open a draft PR early so the claim is visible in GitHub where it stays
current, and check open PRs for collisions before starting. Do not record your
claim in this file — see the note above about why copied PR state is worse than
none.

Note that **roles are not lanes.** A researcher, a wirer and an auditor can all
collide on one file, because a lane is a territory and a role is a job. This
repository already tried role-based sequencing (Architect → Implementer →
Reviewer → QA) and retired it — `docs/MULTI_AI_EXECUTION_PLAN.md` is marked
SUPERSEDED and says not to reconstruct it, because two overlapping systems
forced agents to reconcile role rules against lane rules. Staff by role if that
suits the humans; coordinate by lane regardless.

**Record the shape of what you found, not just that you fixed it.** Two of the
worst problems here were invisible to per-PR review — an exhaustive `Record`
three PRs each extended, and capabilities that began writing to a register a
third one read. Those are only catchable if the previous agent wrote down the
*shape*. If you find a third such class, put it in the "two things this
exercise taught" section above, with the question a future PR should ask.

**Move rows rather than deleting them.** When your PR merges, add its row to
"closed" with its number and remove it from wherever it sat before. When a
finding turns out to be wrong, move it out and say so — a retraction recorded is
more useful than a row that quietly disappears, because the next agent would
otherwise re-find it.

**Correct this file when it is wrong about you.** If a row misdescribes your
work, or claims something is parked that the owner has since unparked, fix it
here in the same PR. Two of this document's own findings were overstated when
first written and were corrected in place rather than quietly tightened; that
is the standard, not an exception.

**What needs a human, not a commit.** Anything that narrows a role gate,
reverses a recorded owner decision, or changes what a guardian or coach is
allowed to see. Those are listed as "needs a decision" above deliberately —
implementing one because it looks like a bug is how a settled question becomes
an argument.

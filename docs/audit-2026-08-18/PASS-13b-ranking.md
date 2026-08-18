# Pass 13b — Independent unified severity ranking

**Status: complete.** Written incrementally. This file's only job is to take all
157-plus findings from the sixteen passes and four verification passes and turn
them into one ranked list for an owner with limited time. I did not author any
of the underlying findings; I owe none of them the benefit of the doubt their
own author gave them, and I say plainly, with reasons, everywhere I land
somewhere different from the pass or the verification pass that touched a
finding before me.

## Method

Read, in this order: `README.md` in full (it already folds in most
verification outcomes and several hand-checks by the lead session);
`PASS-13a-collisions.md` (a parallel, in-progress synthesis draft — read as
input, not copied); the Findings section of all sixteen `PASS-*.md` files,
counted by severity-tagged header; all four `VERIFY-*.md` files, in full for
`VERIFY-03`, `VERIFY-04` and the summary/detail sections of `VERIFY-06-07-09`
and `VERIFY-15-16-17` that carry a verdict and a corrected severity.

For every finding, I used the **verified severity** where a verification pass
touched it, not the originating pass's own label. Where no verification pass
reached a finding, I say so explicitly rather than borrowing confidence a
finding was never given. I then re-ranked everything against the four stated
criteria — could this harm/expose/mislead a real child today with no further
bug; does it defeat a load-bearing safety gate; does the fix need an owner
decision or is it a clean unilateral change; is it already fixed on `main`.

For "already fixed," I read `git log --oneline origin/main -15` myself and, for
every commit above the audit's `04dd116b` baseline that looked like it might
touch a catalogued finding, ran `git show --stat`/`git show` on it rather than
trusting a commit title. Four of those checks changed my "resolved" column from
what a title alone would suggest (see the resolved-items list below); one
(`#412`, document ingest) turned out to fix a *different* half of a two-part
finding than the one that actually matters.

I did not re-derive anything myself at the source-code level beyond what the
passes and verification passes already quote — that would be re-running an
audit I was asked to synthesize, not to repeat. Where I disagree with a
severity, the disagreement is about **priority given the criteria**, not about
a fact the verification passes already settled.

## The ranked list

Severity shown is the **verified** severity where verification exists;
"(unverified)" marks a finding no refutation pass has touched, meaning its
severity is the originating pass's own unchecked judgment. "Owner decision"
means the fix narrows a role gate, reverses a recorded decision, or touches
production per this repo's own escalation rule; "clean fix" means it does not.
Some items merge two or more IDs where two passes independently found the same
underlying mechanism — merges are noted.

1. **A coach files a critical safety incident and nothing in the product can
   stop that child from training — because nothing in the product can place or
   lift a training hold at all, by any path.** `J1-A` + `J5-B` (Pass 14) —
   **HIGH per the pass, hand-verified independently by the lead session; I rank
   it #1 anyway.** Clean fix (wire the existing, well-built `trainingHolds.ts`
   module to a UI/API caller — nothing about the module itself is wrong).
   **Live.** *Why I disagree with the HIGH label:* every other safety finding
   in this audit — medical-clearance gaps, the contact-gate test blind spot,
   video-consent races, guardians never being told — assumes that if something
   goes wrong, *someone* can stop the child from training. Nobody can, by any
   route. That is the platform's core safety promise, unreachable.

2. **Every uploaded video of a child is sent to an external (Microsoft-hosted)
   vision model with no consent check anywhere on that path, as currently
   deployed to production.** `E-01` (Pass 15) — **CRITICAL, confirmed with
   correction.** Owner decision (what the video screen should do about consent,
   and what to tell a guardian who asks). **Live, per the corrected reading**:
   the "only path to a readable video" clause is **false** — a human coach can
   also release a video to `ready` with zero frames ever transmitted, and the
   claim that this has "already happened in production" is **not established**
   by this repository; the one transmission actually evidenced is a single
   17.3MB staging clip. The consent gap itself, and its live-in-prod
   configuration, both hold.

3. **The platform's "stop" mechanism has no door (see #1) while its "go"
   mechanism — medical/contact clearance — is wide open: any assigned coach can
   set a child `cleared` with no document, no expiry, and no authority check,
   on the exact population (contact/sparring) the hold system exists to
   protect.** `S-01` (Pass 8) — **HIGH per the pass; not independently
   refuted by any VERIFY pass** (flagged unverified below). Mostly a clean fix
   (add the missing `assertShadowAuthority` call and an expiry); "who besides a
   coach may clear a child" may need an owner call.

4. **Any coach can read the whole gym's open safety-flag queue and can resolve
   or bypass a flag on a child they have no assignment to, with no
   athlete-scope check anywhere in the route or the module.** `F-20` (Pass 2)
   — **CRITICAL, raised from the pass's own HIGH by the lead session; I agree
   with the raise.** Clean fix — the sibling `training-holds` route already
   implements the exact scoping check this route lacks. **Live.**

5. **The only test that touches the contact-clearance gate and the hold
   REGRESS rung posts a non-contact observation, so deleting both safety checks
   leaves all 482 suites and 5,997 tests green.** `T-01` (Pass 10) — **CRITICAL
   per the pass; not independently refuted by any VERIFY pass.** Clean fix (one
   test). **Live**, and it is the kind of gap where "live" means *a future
   refactor could delete this gate and nobody would find out.*

6. **`DATA_RETENTION.md` promises category-by-category deletion of a child's
   photos, videos, medical records and waivers; the only deletion code touches
   two tables, and video is not reachable from any deletion path even in
   principle.** `D-01` (Pass 12) — **CRITICAL, hand-verified by the lead
   session** (the `video_sessions` table has no FK to `athletes` and no
   `deleted_at` column, confirmed at the DDL). Owner decision (what to tell a
   guardian who asks what happens to their child's footage) plus a real
   engineering fix regardless of the answer. **Live.**

7. **A "deleted" child stays on the live coach roster — name, date of birth,
   portrait — for the whole two-year retention window, and a "deleted"
   guardian keeps logging in.** `X-02`/`P6-01` (Pass 6) + `F-26` (found by the
   Pass-3 verification pass, independently) — **HIGH, confirmed with
   correction**: the operator CLI already clears `active_flag` correctly; the
   **API route** (the actual right-to-be-forgotten path) does not, so 53 of 55
   reader files admit a soft-deleted record. Clean fix (filter `deleted_at`,
   or fix the route to also clear `active_flag`). **Live.**

8. **The retention hard-delete cannot succeed: 66 of 127 inbound foreign keys
   to `pilot.accounts` carry no `on delete` action** (not "two," as originally
   reported — the verification pass's own re-derived census is worse, not
   better) **— so any due parent account aborts the whole purge transaction.**
   `X-03`/`P6-02` (Pass 6) — **HIGH, confirmed with correction.** Clean fix,
   but a large one (many migrations need an explicit on-delete action). **Live.**

9. **The platform-owner bootstrap endpoint stays armed in production
   indefinitely behind one static header secret; one correct header reactivates
   any suspended organization and rewrites the `platform_owner` row.** `A-02`
   (Pass 1) — **HIGH per the pass; not independently refuted.** Production
   security posture — **owner decision** on whether this door should exist at
   all and how it is protected. **Live.**

10. **`platform/athlete-shell` creates a live, sign-in-able athlete account on
    the published starting PIN, in any organization, while its own doc comment
    and its own response both say it grants no sign-in capability.** `A-01`
    (Pass 1) — **HIGH per the pass; not independently refuted.** Touches
    account creation/auth — flagging for owner awareness even though the code
    fix itself is narrow. **Live.**

11. **Two literal credentials (a 5-digit admin PIN, a 6-digit "shadow athlete"
    PIN) remain readable today in this repository's public git history on
    `origin`, even though both were fixed on `main`** — the fix commits'
    messages describe the exact risk and the history was squash-rewritten
    around them rather than scrubbed. `X-01`/`S-01`(Pass 11) — **HIGH,
    hand-verified by the lead session.** **This is not a code change** — it is
    a today action: rotate both PINs, then delete/rewrite the stale remote
    branches. README's own "needs a human today" item #1.

12. **A coach can silently overwrite another family's guardian record**
    (`account_id`, phone, email via an `on conflict … do update`), **severing a
    real parent from their own child's consent controls — and repointing
    `account_id` hands the new account guardian reach over every child that
    record carries, siblings included.** `F-21` (Pass 2) + `F-13` (Pass 3),
    independently corroborated by two passes — **HIGH, confirmed** (verbatim,
    hand-checked by the lead session too). **Owner decision** — README
    explicitly frames this as narrowing a role gate, not a unilateral fix.
    **Live.**

13. **`POST /api/document-ingest` fans whole uploaded PDFs to three external
    destinations — Dataverse, SharePoint, and Google Drive — with no consent
    check, no athlete scoping, one global destination shared by every
    organization.** `E-03` (Pass 15) — **HIGH, confirmed with correction; held
    at HIGH rather than CRITICAL only because no deploy workflow currently sets
    the required env vars, so it fails closed today.** A related-but-different
    bug on the same pipeline (Google Drive silently uploading into the service
    account's own, unopenable Drive; no idempotency) **was fixed by `#412`** —
    but that commit does not touch consent or athlete-scoping, which is what
    this finding is actually about. **Consent/scoping gap still live.** Owner
    decision (should this fan-out require consent, and should destinations be
    per-organization).

14. **A job retried after a lease expiry re-sends a child's video frames to the
    external vision service; consent (what exists of it) is checked only at
    the original enqueue, never on retry.** Pass-17 HIGH-2 — **HIGH,
    confirmed** — the long tail behind #2. Clean fix (re-check on retry, or
    stop preserving the payload across a lease reclaim in a way that
    re-triggers egress). **Live.**

15. **A blocked video's safety escalation files exactly once; if that write
    fails, the escalation is lost forever** — no retry, no sweep, no manual
    re-file path exists anywhere, confirmed by tracing all three. Pass-17
    HIGH-1 — **HIGH, confirmed.** Clean fix (one transaction spanning settle +
    escalation, or a reconciliation sweep). **Live.**

16. **The consent-withdrawal sweep for a video is keyed to one `athlete_id`, so
    group footage of a child filed under a different child's ID stays
    published — while the confirm dialog promises "Anything already published
    … will be retracted … immediately."** `J2-A` (Pass 14) — **HIGH per the
    pass; not independently refuted, but methodologically strong** (read
    directly against current `origin/main`, not the stale audit branch). Needs
    an owner call on how multi-subject footage should be modeled, plus a clean
    fix once that's decided. **Live.**

17. **A video uploaded with no `athlete_id` at all skips the access check,
    every consent read, the withdrawal sweep, *and* the safety escalation.**
    `J2-B` (Pass 14) — **HIGH per the pass; not independently refuted.** Clean
    fix (require `athlete_id`, or make every one of those four gates handle the
    null case instead of silently passing it through). **Live.**

18. **Enrollment reads no waiver, guardian link, or clearance before a child
    can register for training; only the travel waiver — competitions only —
    gates anything.** `J4-A` (Pass 14) — **HIGH per the pass; not
    independently refuted.** #458 ("surface lapsed/ended membership …
    non-blocking") does not touch this — it adds a *non-blocking* flag, so this
    gap is unaffected. Touches what enrollment is allowed to skip — **owner
    decision** on which waivers should actually gate registration. **Live.**

19. **A guardian is never told about a safety incident involving their child**
    — `/parent/safety` excludes `safety_escalations` wholesale, on reasoning
    written entirely about a different, unrelated source type. `J5-A` (Pass
    14) — **HIGH per the pass; not independently refuted.** **Owner decision**
    — whether/how to notify guardians is a policy call, not only a bug. **Live.**

20. **The PA Act 153/15 background-clearance register — module, migration,
    view, pg test, apply script — is imported by nothing; all five exported
    functions have zero non-test callers.** `J6-A` (Pass 14), independently
    corroborating a `NETWORK_STATUS.md` inventory row — **HIGH per the pass;
    not independently refuted.** This is a state-mandated adult-clearance
    requirement for anyone working with minors — flagging above its raw
    technical severity because of the compliance angle. Clean fix (wire it in)
    once an owner confirms the intended enforcement point. **Live.**

21. **A gym admin cannot off-board a coach: deactivation requires
    `platform_owner`, and the admin's only lever — a session revoke — leaves
    `active_flag` true, so the coach signs in again.** `J6-B` (Pass 14) —
    **HIGH per the pass; not independently refuted.** **Owner decision** — this
    is a role-boundary question (should a gym admin be able to deactivate a
    coach at all), not obviously a bug. **Live.**

22. **Capability coverage counts sources nobody approved — including sources a
    reviewer explicitly rejected and sources withdrawn for retraction —**
    silently suppressing a knowledge-gap requirement that should have been
    raised. `H-3`/`X-12` (Pass 16) — **HIGH, confirmed; the verification pass
    calls it "the strongest finding in Pass 16."** Clean fix (add the same
    approval predicate the retrieval query already enforces). **Live.**

23. **Any organization member, including an athlete, can mark a research
    requirement "Resolved" with no evidence submitted or reviewed at all.**
    `H-4`/`X-13` (Pass 16) — **HIGH, confirmed.** Clean fix (tighten the role
    check on that one route). **Live.**

24. **"Approve + verify" of Library evidence is one click by one person, and
    the screen shows nothing that could actually be verified.** `H-1`/`X-10`
    (Pass 16) — **HIGH, confirmed with correction** (drop the "two
    attestations" framing the pass used; the underlying gap is real). Clean
    fix — this codebase already fixed the identical shape of bug elsewhere
    (`#461` made portrait review show the reviewer the actual photo instead of
    a name and timestamp); the evidence-review screen needs the same
    treatment. **Live.**

25. **`/simulator` renders seven invented coaching scenarios, risk-graded on the
    platform's real Layer-11 safety-ladder badge classes, reachable by anyone
    (there is no `middleware.ts` anywhere in the app and no page-level role
    gate), with no disclosure anywhere in its render tree.** `X-04`/`P7-01`
    (Pass 7) — **HIGH, confirmed, unresolved** (`git diff HEAD origin/main --
    apps/web/app/simulator` is empty — `#422` declared four *other* prototypes
    and left this one alone). Clean fix (add the same disclosure stamp five of
    six sibling consoles already carry, per `#422`). **Live.**

26. **`/operations` stamps "Signed & Active" over safety guarantees — four
    readiness/ΔRPE boundary claims and five role-isolation compliance claims —
    that two other passes of this same audit independently found unenforced,
    shown to every role in the gym.** `X-05`/`P7-02` (Pass 7) — **HIGH,
    confirmed with correction**, unresolved (`#462` fixed the *Revenue* tab's
    fabricated figures, a different screen; this stamp is untouched). Clean fix
    (stop asserting compliance the code doesn't demonstrate, or gate the panel
    to platform_owner only). **Live.**

27. **The readiness-honesty cluster, three findings from one root cause:**
    `/operations` presents LEGACY-READINESS as a signed, certified, active
    mathematical gate (`X-07`/`F-9-01`); the one readiness number that actually
    changes a child's training is a **client-side constant that defaults to
    GREEN** (`X-08`/`F-9-02`); and the value is stored in a column literally
    named `rpe` and shown to the child as "effort" (`X-09`/`F-9-03`). All three
    Pass 9, all three **HIGH, confirmed** (one with a correction) by
    `VERIFY-06-07-09`. Clean fixes individually; the GREEN-default client
    constant (`X-08`) is the one that matters most, since it means a value the
    server never actually computed silently reads as "fine" for every child by
    default. **Live.**

28. **Test-infrastructure pair: 69 of 94 Postgres suites leak a full data
    directory per run (263 MB measured for one suite), and `test:migrations` is
    a 94-link `&&` chain where one early failure hides every later suite —
    including the training-holds, safety-gate-matrix and safety-escalations
    proofs.** `T-02`/`T-03` (Pass 10) — **HIGH per the pass; not independently
    refuted by a dedicated VERIFY pass**, though the lead session separately
    re-derived and materially corrected the root-cause mechanism (an
    `async-exit-hook` race, not a missing shared helper as first published) —
    that re-derivation functions as a partial check even without a formal
    verification file. Clean fix, pure dev-infra, no policy question. **Live.**

29. **`POST /api/pilot/audit/get` returns `select *` over the whole audit-event
    table behind a coach denylist with exactly one entry** — 56 entity types
    are written, and three (`account`, `intake_case`, `parent_barrier_report`)
    carry payloads a coach should not be able to enumerate gym-wide, including
    login email, guardian-link ids, reviewers' free-text notes, and a named
    athlete's family hardship category. `P-01` (Pass 5) — **HIGH per the pass;
    not independently refuted**, and notably it appears in none of Pass 2's 175
    unopened routes, `NETWORK_STATUS.md`, or the last 40 commits — a genuinely
    new find, not a rediscovery. Clean fix (allowlist fields, or deny the three
    named entity types for coaches). **Live.**

30. **A coach can overwrite an existing guardian's `pilot.parents` binding**
    is the same mechanism as #12 above — not re-counted separately, but the
    pass-2 authorization angle on it (`F-21`) and the pass-3 consent angle
    (`F-13`) were verified independently by two different lenses, which is
    itself worth noting as the strongest corroboration in this corpus.
    *(Listed at #12; placeholder kept here only to make clear it is not being
    silently dropped from the ranking's numbering.)*

31. **60-minute, unaudited SAS bearer URLs to minors' video, minted in bulk** —
    contradicting the platform's own written stance and a sibling route that
    does audit its equivalent access. `F-14` (Pass 3) — **downgraded on
    verification, HIGH → MEDIUM.** Clean fix (shorten the window and/or log
    issuance). **Live.**

32. **`raiseConductConcern` bypasses both the incident severity floor and the
    `#433` deduplication window, and the same route has no athlete-scope
    check.** `F-04` (Pass 4) — **MEDIUM, confirmed, no downgrade.** I flag this
    above a typical MEDIUM because it shares the exact "scoping pattern applied
    inconsistently" shape as #4 and #29, on a route that can under-report a
    genuine safety incident's severity. Clean fix. **Live.**

33. **All three training-hold scopes — not only `conditioning_only` —
    overstate their real enforcement, and capability module 082 (marked DONE)
    describes `conditioning_only` as reducing permitted intensity when the
    scope appears in no predicate anywhere in the codebase.** `F-06` (Pass 4,
    confirmed with a correction to its own consequence paragraph) + `D-06`
    (Pass 12), same mechanism from two directions. **MEDIUM.** Clean fix.
    **Live.**

34. **The named daily retention-cleanup script does not exist under that name,
    and the job that does exist is wired so a scheduled run can never actually
    delete anything.** `D-02` (Pass 12) — **HIGH per the pass; not
    independently refuted**, but tightly coupled to #6/#8's mechanism (three
    passes converging on one broken deletion pipeline from complementary
    angles — schema, docs, and this scheduling defect). Clean fix. **Live.**

35. **`/admin/data-deletion` — cited twice in `DATA_RETENTION.md` as the
    operator's console — has no page, no nav entry, and no caller; the
    promised "reversible for 1 year" restore has no code at all.** `D-03`
    (Pass 12) — **HIGH per the pass; not independently refuted.** Clean fix, or
    an owner call that the feature is deliberately deferred and the doc should
    say so. **Live.**

36. **The `training_hold` gate can be recorded `blocked` but never `passed`, so
    a guardian can see "Active Training Hold — Not clear" permanently after one
    refused registration, and the same card can show a live "no pause" state
    and a stale "not clear" state at once.** `F-07` (Pass 4, LOW, confirmed) +
    `J3-A` (Pass 14, MEDIUM, same mechanism — **and `#452` added two more
    writers of the permanent `blocked` state since baseline, making the
    practical footprint larger, not smaller, after the merge that fixed #1's
    entry-point sibling finding**). I rank this above a plain LOW/MEDIUM
    because it is a guardian-facing trust defect that just got measurably
    bigger from an otherwise-good merge. Clean fix (add a `passed` writer).
    **Live.**

37. **`docs/AGENT_EXECUTION_POLICY.md` declares itself the first document to
    read and binding on all agents, and contradicts `AGENT_KERNEL.md` — the
    file this very audit and this very pass are run under — on three rules; it
    is unmarked as superseded and referenced by zero other files.** `D-05`
    (Pass 12) — **MEDIUM, confirmed.** Not a child-safety finding, but a
    process-integrity one: any future agent (including a future run of this
    audit) that opens the wrong file first inherits contradictory rules. Clean
    fix (delete it or reconcile and cross-link it). **Live.**

### Resolved during or since this audit (checked against `git log`, not assumed)

- **F-01 — competition entry consulted no safety record at all.** **RESOLVED.**
  `PR #452` merged as `951030e1` ("Competition entry now asks whether the child
  may compete at all"); Pass 14 independently re-confirmed it closed, "and
  closed better than the finding asked."
- **The capability-console fabricated-data disclosure gap (`X-06`/`P7-03`,
  `P7-04`).** **RESOLVED for 5 of 6 consoles**, `#422`. One gap remains:
  `/admin/retro-lab` still carries neither the stamp nor a disclaimer — a small
  LOW-severity follow-up, not re-ranked above given its size.
  `/admin/communications`'s twelve inputs (not eleven, per verification) still
  have no save path, but now carry the disclosure stamp `#422` added, which is
  why that finding is LOW rather than MEDIUM.
- **A rejected Film Study proposal was citable as evidence for an
  intervention.** Flagged in Pass 16 as "already-known … fixed on an open PR."
  **RESOLVED** — `#459` ("A rejected Film Study proposal is no longer citable
  as evidence") is merged, confirmed by reading the commit body.
- **`RevenueFundingCenter.tsx` rendered fabricated dollar figures and account
  names with no page-level disclosure**, flagged in Pass 7's console-disclosure
  table. **Improved/likely resolved** — `#462` ("The revenue centre stops
  presenting invented figures as the books") makes three of its tabs
  table-backed against real membership/grant data; I did not find this item
  under a distinct `F`/`X` ID elsewhere in the corpus, so I am not claiming it
  closes a catalogued finding — noted for completeness only.
- **`#454`** (subject_id added to `shadow_research_requirements`) plausibly
  bears on Pass 8's L-2 (`listShadowAuthorityChecks` skips athlete scoping) and
  Pass 16's requirement-scoping mechanics, but I did not trace it deeply enough
  to claim it closes either catalogued finding — flagged as a lead for whoever
  picks this file up next, not claimed as resolved.

## Do this week

Ordered by my judgment of what needs the owner's or a developer's attention in
the next seven days specifically, not by severity label alone.

1. **Wire a real "place/lift a training hold" control into the product.**
   (#1 above.) This week because it is a pure, unilateral engineering fix — the
   module underneath is already correct and well-tested — and every day it
   stays missing means every other safety finding in this audit terminates in
   "and then nothing happens."
2. **Get an owner decision on the video content-screen vs. consent question.**
   (#2.) This week because it is a live production configuration processing
   every new upload today, it is explicitly the one decision this audit's own
   authors said "needs a human today," and it is not something an engineer
   should decide alone.
3. **Rotate `PILOT_ADMIN_PIN` and `PILOT_SHADOW_ATHLETE_PIN`, then deal with the
   stale public branches.** (#11.) This week because the repository is public,
   a plain clone already fetches a working credential, and the fix is minutes
   of owner/ops time against an open-ended cost of waiting.
4. **Close the any-coach safety-flag bypass.** (#4.) This week because it is a
   CRITICAL with a narrow, clean, mechanical fix — copy the scoping pattern the
   sibling `training-holds` route already uses.
5. **Add the missing authority/expiry check on the medical-clearance write
   path.** (#3.) This week because, paired with item 1, it is currently true
   that clearing a child for contact requires nothing while stopping one
   requires an impossible action — fixing only one side of that leaves the
   other wide open.
6. **Add one test that exercises the contact-clearance + hold gate together.**
   (#5.) This week because it is the cheapest possible insurance against
   silently losing a CRITICAL safety gate in a future refactor, and it does not
   require any policy decision at all.
7. **Get an owner decision on the production bootstrap endpoint.** (#9.) This
   week because a standing, header-gated production backdoor that can
   reactivate a suspended organization is exactly the kind of thing that should
   not sit unresolved across a second audit cycle.
8. **Decide the intended semantics for guardian-record overwrite and fix the
   default.** (#12.) This week because the current default — a coach's write
   silently severs a real parent from consent controls, siblings included — is
   the wrong default to leave live even while the owner decides what the right
   one is.

## Total findings accounted for

**My own recount, from the source files, does not match the "157" figure named
in my brief — I am reporting the discrepancy rather than forcing my count to
match it, per this audit's own stated rule that an admitted gap beats a
plausible-sounding number.**

Counting every severity-tagged `###` finding header inside each pass file's
Findings section:

| Pass | HIGH+ | MEDIUM | LOW | Total |
|---|---|---|---|---|
| 1 — Authentication | 2 | 5 | 7 | 14 |
| 2 — Authorization | 2 | 4 | 2 | 8 |
| 3 — Minors' consent | 6 | 3 | 1 | 10 |
| 4 — Safety gates | 1 CRIT + 1 HIGH | 5 | 3 | 10 |
| 5 — API surface | 1 | 7 | 5 | 13 |
| 6 — Data layer | 2 | 4 | 7 | 13 |
| 7 — Frontend | 3 | 3 | 7 | 13 |
| 8 — SHADOW | 1 | 4 | 6 | 11 |
| 9 — Formulas | 3 | 7 | 4 | 14 |
| 10 — Tests/CI | 1 CRIT + 2 HIGH | 4 | 3 | 10 |
| 11 — Infra/secrets | 1 | 9 | 7 | 17 |
| 12 — Docs vs code | 1 CRIT + 2 HIGH | 3 | 3 | 9 |
| 14 — Flows | 9 | 6 | 3 | 18 |
| 15 — Egress | 1 CRIT + 2 HIGH | 3 | 2 | 8 |
| 16 — Research/library | 4 | 6 | 5 | 15 |
| 17 — Resilience | 2 | 6 | 3 | 11 |
| **Subtotal, 16 passes** | **34 HIGH+/CRIT** | **79** | **68** | **194** |

Plus findings the four verification passes surfaced that the pass under review
had missed (these are genuinely new, not re-labelings): **F-24** (MEDIUM,
found by `VERIFY-04`), **F-25** (LOW, found by `VERIFY-04`), **F-26** (HIGH,
found by `VERIFY-03` — this is the withdrawn-child-on-live-roster item ranked
#7 above), **F-27** (MEDIUM, found by `VERIFY-03`, the "checked and found
sound" wall-display entry that was not sound). **+4.**

**My total: 198 catalogued findings**, of which 4 CRITICAL, 34 HIGH (post
several downgrades this file applies from the verification passes — see below),
88 MEDIUM, and 72 LOW. Every LOW is accounted for in the per-pass table above
even though almost none of them appear in the ranked list; they were reviewed,
not dropped. Severity changes applied by verification passes, folded into these
totals rather than left at the originating pass's label: F-02 HIGH→MEDIUM,
F-03 MEDIUM→LOW, F-11/E-02-equivalent HIGH→MEDIUM, F-14 HIGH→MEDIUM, F-15
HIGH→MEDIUM, F-18 MEDIUM→LOW, P7-03/X-06 HIGH→LOW, P7-04 MEDIUM→LOW, H-2/X-11
HIGH→MEDIUM. Nine downgrades total across the four verification passes; **zero
retractions** in any of them.

I cannot reconcile 198 down to 157 without inventing a filter I have no
evidence the original count used, so I am not attempting to. The gap is
plausibly explained by the brief's "157" being written before Passes 14, 16 and
17 finished (they alone add 44 findings), or by some other counting convention
I was not given — either way, the honest answer is that I recounted from the
source files and got a different number, and a reader should trust the
recount over the prior figure precisely because it is traceable to specific
headers in specific files rather than to a remembered total.

## Where I disagree with a pass's own severity, and why

- **J1-A + J5-B, labelled HIGH by Pass 14, ranked #1 here.** Argued above:
  every other safety finding in this corpus assumes a working stop-mechanism
  exists. None does. I am not raising the severity label itself past what the
  pass's own HIGH-reservation rule allows (it reserves HIGH+ for journeys where
  "a child's safety state is wrong or a guardian is actively misinformed," and
  this is exactly that) — I am disagreeing with where it sits in *priority*
  relative to the audit's four CRITICALs, three of which are either already
  fixed (F-01) or narrower in practical blast radius than this one.
- **F-04 (Pass 4, MEDIUM, confirmed with no downgrade) ranked above several
  other MEDIUMs**, because it shares the identical "scoping pattern present on
  siblings, absent here" mechanism as two CRITICAL/HIGH findings (F-20, P-01)
  and can under-report a genuine incident's severity — a different failure
  direction than most MEDIUMs in this corpus, which tend to be over-reporting
  or cosmetic.
- **F-06/D-06 and F-07/J3-A ranked as merged pairs, each above where a single
  pass's label would place either half alone**, because in both cases a second
  pass reached the same mechanism independently from a different angle, and in
  the F-07/J3-A case a merge (`#452`) made the practical footprint *larger*
  since the pass ran — a fact neither Pass 4 nor Pass 14 individually had.
- **X-04 (`/simulator`, Pass 7, HIGH, confirmed) held at HIGH rather than
  downgraded**, even though the verification pass found no disclaimer anywhere
  including a location Pass 7 itself never checked (`DevelopmentPipelineBanner`)
  — I read that as the finding getting *stronger* under adversarial review, not
  weaker, and the summary table agrees (severity "stays HIGH").
- **H-2/X-11 (Pass 16, HIGH) accepted at its downgraded MEDIUM rather than
  re-raised.** The verification pass's argument is specific and, on my
  reading, correct: the displayed label ("backed by approved Library
  evidence") is literally true, and the "bypasses the codebase's own quality
  rule" framing overstates two independently-built grading systems that were
  never supposed to be the same rule. What survives — a coach cannot see that
  an answer rests on `CONTESTED PRACTICE` material — is real but is a
  disclosure gap, not a bypassed control, and I agree MEDIUM is the honest
  label.
- **T-02/T-03 (Pass 10, HIGH) kept at HIGH despite no dedicated verification
  pass**, on the strength of the lead session's own independent re-derivation
  of the root cause (documented in `README.md`'s "Postgres teardown diagnosis"
  section) rather than left as an unchecked pass-level claim like the other
  unverified HIGHs in this list — that re-derivation is a real, if informal,
  check that the mechanism is right, even though it does not carry a
  finding-by-finding verdict table the way the four formal `VERIFY-*.md` files
  do.
- **E-01's headline, as relayed to the owner in `README.md`'s URGENT section,
  needs one correction I am flagging explicitly rather than silently
  inheriting**: the "only path to a readable video" claim is false (a human
  release route exists and is live), and "already sent" in the past tense is
  not established by this repository (best evidence is one staging clip). The
  underlying CRITICAL — the deployed configuration processes every video with
  no consent check — is unaffected and I keep it ranked #2, but a reader
  relaying this finding onward should use the corrected clauses, not the
  original ones.

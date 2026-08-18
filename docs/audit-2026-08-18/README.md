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
| 1 | Authentication & session | Login, magic link, PIN, bootstrap key, session issuance and invalidation, `AUTH_CONTRACT.md` conformance | **done** | `PASS-01-authentication.md` |
| 2 | Authorization & tenancy | `assertActorCanAccessAthlete` and siblings, org scoping, cross-org leakage, role gates across all 228 routes | **done** | `PASS-02-authorization.md` |
| 3 | Minors' data & consent | Waivers, guardian links, consent scope enforcement, profile visibility, photo/video exposure | not started | — |
| 4 | Safety gates | Training holds, clearances, contact exposure, escalation ladder, competition entry | **done** | `PASS-04-safety-gates.md` |
| 5 | API surface | All 228 routes: input validation, `jsonError` prefix conformance, idempotency, rate limiting, `hiddenNotFound` | **done** | `PASS-05-api-surface.md` |
| 6 | Data layer | 88 migrations vs. code, constraints, tenancy columns, policy hiding in DDL, N+1 | **done** | `PASS-06-data-layer.md` |
| 7 | Frontend & design system | 125 screens + 86 components: fabricated-data disclosure, Law 2 / Law 7 conformance, invented classes, dead ends | **done** | `PASS-07-frontend.md` |
| 8 | SHADOW subsystem | Authority model specified vs. built, event model, **what actually drives the job processor** | **done** | `PASS-08-shadow.md` |
| 9 | Formulas & thresholds | Registry status vs. callers, provenance of every constant gating a child's training | **done** | `PASS-09-formulas.md` |
| 10 | Tests & CI | What the 281 unit + 93 pg suites actually pin, tests that assert nothing, the pg teardown race, CI gates | **done** | `PASS-10-tests-ci.md` |
| 11 | Build, infra & secrets | Dockerfiles, CI/CD exposure, **secrets in tree and in git history**, `staticwebapp.config.json` | **done** | `PASS-11-infra-secrets.md` |
| 12 | Docs vs. code | 425 docs: claims contradicted by source, contract files, stale-but-unmarked | **done** | `PASS-12-docs-vs-code.md` |
| 13a | Cross-cutting synthesis: collisions | Defects visible only between two-or-more passes together | **done — 5 of 6 directed hunts confirmed, 1 more found unprompted** | `PASS-13a-collisions.md` |
| 13b | Cross-cutting synthesis: unified ranking | One independent severity ranking across all 157 findings, owing no pass's label any loyalty | **running** | — |
| 14 | Role journeys & flow | Seven journeys traced UI → API → domain → DB | **done — all 7 of 7 traced** | `PASS-14-flows.md` |
| 15 | Data egress & integrations | **What data about a child leaves this system, to whom, and what stands between it and the door** — model calls, SAS URLs, email, exports, telemetry, logs | **done** | `PASS-15-egress.md` |
| 16 | Research, data library & evidence | Source lifecycle, evidence registry, Knowledge Graph, `assessment_protocols`, UI claims vs. implemented hand-offs | **done** | `PASS-16-research-library.md` |
| 17 | Resilience & failure behaviour | **Does each safety gate fail closed or fail open?** Swallowed errors, permissive defaults, non-transactional multi-step safety writes, retries that double-write | **done** | `PASS-17-resilience.md` |

## The sentence no single pass could write

Pass 13a read all sixteen passes and the four verification files together, hunting
specifically for defects invisible from any one report — the same *shape* of thing
that broke `main` three times, where a union grew on one branch and its exhaustive
map grew on another. It confirmed four of six directed collision hunts, ruled one
out cleanly, found one that partially holds and partially doesn't, and surfaced one
more nobody asked it to look for.

**Its own headline, verbatim, because it is better than anything I could compress
it to:**

> Before this gym opens to real children, the product has no way for a human to
> make a child's training stop, an easy and unaudited way for a coach to say a
> child is cleared to keep going, and — on the one subsystem that already runs on
> every real upload — no consent gate standing between a child's face and an
> external inference service; and the audit's own verification work confirms that
> none of this has harmed a real child yet, which is exactly why it is still
> fixable before it does.

No pass states that sentence. Pass 14 states the first clause, pass 8 the second,
pass 15 — corrected by its own refutation — the third in its true, less alarming
form. It is the one sentence in 157 findings that changes what "a lot of MEDIUMs
and one CRITICAL" means as a readiness-to-operate summary, and it is timed to the
week that matters: before the doors open, not after.

**Thirteen-plus call sites collapse to one root cause and one fix — and one that
looks the same does not, checked directly rather than assumed.** Pass 2's F-20 (the
CRITICAL I raised on review), its own eleven-route family, and pass 8's H-1 are the
same missing primitive at a thirteenth call site: a coach admitted by role with no
check that they have any standing on the named child, in a codebase that already
has the right call, already uses it correctly on four sibling routes, and already
wrote the missing sentence into a comment (`training-holds/route.ts:131`, "no
org-wide hold roster"). Pass 5's P-01 looks like the same shape and **is not** — it
is a bulk read across 56 entity types with no single athlete to scope to, defended
by an incomplete denylist rather than an absent relationship check. The pass says
so explicitly rather than folding it in for a bigger number: *"reporting them as
one collapsed root cause would overstate what the passes actually show."*

**Ruled out, and checked rather than assumed:** the platform-owner bootstrap key
does not appear anywhere in the git history that found the two exposed PINs. A
negative result recorded as plainly as a positive one.

**No deletion promise in `DATA_RETENTION.md` can currently be kept — not only the
video one.** The retention purge's own foreign-key block fires on the first real
guardian, not on video specifically.

## The finding that reframes the rest: nothing in the product can place a training hold

Pass 14 traced all seven journeys and returned nine HIGHs. This is the one that
matters most, and I verified it independently rather than relaying it.

**No screen in this platform places or lifts a training hold.**
`POST /api/pilot/training-holds` with `action: 'place'` has **zero client
callers.** Every client reference to that endpoint is a `GET`:

```
`${apiBase()}/api/pilot/training-holds?athlete_id=…&status=active`   (GET)
```

in `coach/progression-intelligence/page.tsx:342` and
`coach/sports-medicine/page.tsx:97`. The only `action: 'place'` anywhere in UI
code belongs to `coach/floor-groups/page.tsx:154`, which is a different endpoint
placing an athlete in a floor group. The pass tried four separate refutations —
no place-payload fields in any `.tsx`, no second server caller, no raw SQL
outside the module and its tests — and all four failed.

**Why this reframes much of the audit.** The training hold is the stopping
mechanism. It is enforced at class registration. It is now enforced at competition
entry too, because PR #452 merged. It is read by six surfaces. Every earlier
finding about holds — that they do not cancel existing registrations, that scopes
overstate enforcement, that a covering coach can lift one — assumed holds get
created. **Nothing in the product can create one.**

Pass 14's own summary of the worst break puts it better than a severity label
can: a coach files a critical incident, it is recorded correctly, deduplicated,
severity-floored, and lands in the admin queue — the guardian cannot be told,
and the admin has no control anywhere in the product that pauses that child's
training. Two individually correct modules, `trainingHolds.ts` and
`escalationLadder.ts`, with nothing between them and no door into either.

That is this codebase's demonstrated failure mode — the seam between two correct
modules — and it took the one pass that traced whole journeys to see it. Which is
the argument for having re-run it after two agent deaths.

**A methodological note that matters.** Pass 14 read every quote from
`origin/main` at `0485cf81` using `git grep <rev>`, because the audit branch is
based on `04dd116b` and is **73 `apps/web` files behind**. Had it read the
checked-out tree it would have reported #452 and #458 as broken. Earlier passes
did not all do this, which is a real caveat on their findings.

## All 17 passes now have output; pass 13 remains open by design

Seventeen passes were defined; sixteen have run and written reports. Pass 14
succeeded on its third attempt after two agent deaths — the fix was instructing it
to write incrementally from its first tool call rather than gather-then-write.
Pass 13 (cross-cutting synthesis) is still open and still reserved for the other
session.

Six passes lost their summarising agent to a capacity limit *after* writing their
file, so their findings were read out of the files directly rather than relayed.
That is recorded because it changes the confidence: those six have not had an
author walk me through what mattered, so their severity ordering is mine from the
text rather than theirs.

Pass 14's verdicts: **three journeys broken** (placing a hold — no entry point;
the incident *response* half; coach off-boarding), **five silently incomplete**,
and **two complete** — competition entry at the moment of entry, where it
records F-01 as *"confirmed closed, and closed better than the finding asked"*,
and the incident filing and escalation ladder, which it calls the strongest
safety code it read.

## Two things need a human today, and neither is a code change

**1. Rotate two PINs.** `deploy-staging.yml` twice carried a PIN as a literal.
Both were fixed on `main`, but neither fix removed the credential from `origin` —
`main`'s history was squash-rewritten while the pre-fix branch commits were left
in place, and **the repository is public**, so a plain `git clone` still fetches
them. `PILOT_ADMIN_PIN` (5 digits) and `PILOT_SHADOW_ATHLETE_PIN` (6 digits).
Commit SHAs and line numbers are in `PASS-11-infra-secrets.md`; **the values are
withheld there and appear nowhere in these files, not even partially.** Rotate
both, then delete or rewrite the stale remote branches. The second one is worth
acting on twice over, because the fix commit's own message already described the
risk exactly — *"the gate athlete PIN was a literal in a public repo"*, against a
publicly reachable staging login, on an account provisioned active with
`must_change_pin=false`. The fix was right; it just never reached the history.

**2. Decide what the video content screen does about consent.** See the URGENT
section below. It changes what the platform does with every upload, so it is not
a unilateral fix.

## Resolved during the audit

**PR #452 merged as `951030e1`** — the competition-entry hold bypass, this audit's
only CRITICAL with a fix already waiting. Ten other PRs merged alongside it.
Recorded here rather than quietly dropped from the findings table: F-01 is closed.

## URGENT — read this one first

**Every video uploaded of a child has already been sent to an external vision
model, with no consent check anywhere in that path, and it is live in
production.** I verified every element of this by hand rather than relaying it.

`videoScan.ts:131-147` downloads a minor's uploaded video, extracts up to twelve
frames, and posts them to the Azure OpenAI vision deployment:

```
const bytes = await downloadPilotVideoFile(blobPath);
...
const analysis = await analyzeFramesWithVision({
  frames,
  prompt: VIDEO_CONTENT_SCREEN_PROMPT,
```

Grepping `consent` across the four modules in that path —
`videoScanSweep.ts`, `videoScan.ts`, `videoScanPolicy.ts`, `videoSessions.ts` —
returns **zero hits in all four.**

It is not an optional path. `videoScanPolicy.ts:174-176` says so itself:

```
// Every enabled gate reported an affirmative pass. This is the ONLY path to
// a readable video.
```

And it is on in production: `deploy-production.yml:441` sets
`PPBF_VIDEO_CONTENT_SCAN=vision`, with the worker enabled at `:437`.

**The part that makes this more than an oversight.** The codebase already knows
this call needs guardian consent. `shadow/video-analysis/route.ts:106` calls
`assertGuardianMediaConsent`, under a comment that states the principle
exactly:

```
// Film Study opens the same footage to AI analysis and must not be a side
// door around that gate.
```

The content screen makes the *same kind of call on the same footage* with no
gate — and because it is the only route to `status='ready'`, **every video that
Film Study's consent gate is ever asked about has already been through a vision
model.** The gate guards a door the data went through first.

This reframes the Film Study finding entirely. I spent much of this audit
treating a ~30-second race on the consent re-check as the headline; the real
finding is that consent was already moot by the time that gate is reached.

**What this needs from a human, today:** a decision on whether the content screen
should run before consent, after it, or not at all — and a factual answer for any
guardian who asks where footage of their child has been. It is not a code fix
somebody should make unilaterally: it changes what the platform does with every
upload.

### Two passes returned "no CRITICAL", and that is a result

Passes 5 and 8 both came back without a CRITICAL, and both said why rather than
leaving it as an absence. Pass 5 chased two candidates that looked like gate
defeats and **both refuted** — `shadow/unlocks` activation mode is fail-closed at
`shadowUnlocks.ts:263`, and the SHADOW authority-mode question turned out to be a
record-integrity problem rather than a bypass. Pass 8's two candidates came back
HIGH after refutation partly succeeded.

That matters for reading this audit honestly. Findings are not evenly
distributed and the severity labels are not being handed out to fill a quota. Of
the passes that have reported, the CRITICALs cluster in exactly two places —
what leaves the building, and what the documentation promises about deletion.

**One number worth having: 73 unchecked casts on request bodies, across 61 of
228 routes, and zero routes use a schema validator.** The pass qualified that
properly instead of leaving it as a scary total — 155 body-cast sites exist, 52
are honest (`unknown` / `Record<string, unknown>`), 103 concrete, and 73 of those
sit in files with no runtime narrowing of any kind. Of 30 casts asserting
membership of a closed set, each was traced individually and most are caught by a
route-level guard or a database CHECK. That per-field tracing is the difference
between a usable finding and a number.

## Verification

Every finding is re-read by a second pass whose job is to **refute** it. That
was rule 2 of this audit's published standard, and it is being run rather than
described.

| Pass | Verification | Status |
|---|---|---|
| 2 — Authorization | spot-checked by hand (below); full refutation pass not yet run | partial |
| 6, 7, 9 | `VERIFY-06-07-09.md` | **done — 40 re-checked, 2 downgraded, 0 retracted, 16 corrected** |
| 15, 16, 17 | `VERIFY-15-16-17.md` | **done — 1 downgraded, 0 retracted, 5 with factual defects, 8 citations drifted** |
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
| E-01 | **CRITICAL** | Frames of **every** uploaded video of a child are sent to an external vision model with **no consent check anywhere** in that path — and it is the mandatory route to a readable video, so the Film Study consent gate guards a door the data already went through. Live in production. **Hand-verified in full** | 15 | New — **the most important finding of this audit** |
| E-03 | HIGH | `POST /api/document-ingest` fans whole uploaded PDFs to three destinations — Dataverse (full base64 body plus a 6,000-character text extract), SharePoint and **Google Drive** — on a role check alone, with one global destination shared by every organisation. Held at HIGH rather than CRITICAL because no deploy workflow sets the required env vars, so it fails closed today | 15 | New |
| E-04 | MEDIUM | `shadowFilmStudy.ts:4-10` states the opposite of what the module does — it says film_study stays UNAVAILABLE, while the processor's exclusion set is empty. This is the docstring an auditor would read to answer "does a child's face leave?" | 15 | New |
| E-05 | MEDIUM | Four SAS-bearing responses set no `Cache-Control`, while every sibling minor-data response sets `no-store` | 15 | New |
| E-06 | MEDIUM | Every athlete-scoped SHADOW turn ships that child's verbatim near-miss incident text to the model, and a minor can trigger it about themselves | 15 | New |
| J1-A | **HIGH** | **No screen in the platform places or lifts a training hold.** `action: 'place'` has zero client callers; all client references are GETs. **Hand-verified** | 14 | New — reframes every other hold finding |
| J1-B | HIGH | Attendance check-in consults no hold and raises no flag — `attendance*.ts` contains no `hold` reference at all | 14 | New |
| J2-A | HIGH | The consent-withdrawal sweep is keyed on one `athlete_id`, so group footage filed under another child stays published — while the confirm dialog promises "**Anything** already published of {childName} will be retracted … immediately" | 14 | New |
| J2-B | HIGH | A video uploaded with no `athlete_id` skips the access check, every consent read, the withdrawal sweep **and** the safety escalation | 14 | New |
| J4-A | HIGH | `registerForClassTransactionally` reads no waiver, guardian link or clearance. `general` and `medical_release` waivers gate nothing | 14 | New |
| J5-A | HIGH | A guardian is never told about an incident — `/parent/safety` excludes `safety_escalations` wholesale, on reasoning written entirely about `athlete_voice`, 1 of 9 source types | 14 | New |
| J5-B | HIGH | Filing an incident changes nothing, and the queue's three actions cannot either | 14 | New |
| J6-A | HIGH | The PA Act 153 clearance register — module, migration, view, pg test, apply script — is imported by nothing; all five exports have zero non-test callers | 14 | Corroborates a `NETWORK_STATUS` row with a full inventory |
| J6-B | HIGH | A gym admin cannot off-board a coach: deactivation requires `platform_owner`. `/admin/people:140` renders a `Deactivated` badge for a state it cannot set | 14 | New |
| X-01 | HIGH | **Two credentials remain readable in public git history** — fixed on `main`, never removed from `origin`, because `main` was squash-rewritten while the pre-fix branch commits stayed. Needs rotation, not a code change | 11 | New |
| X-02 | HIGH | Soft delete is written, indexed for, and **filtered by nothing** — a "deleted" child stays visible everywhere for two years, and a "deleted" guardian keeps logging in | 6 | New — independently reaches the same place as F-26 |
| X-03 | HIGH | The retention hard-delete **cannot succeed**: two foreign keys with no `on delete` action block both halves of the purge, in one transaction | 6 | New — explains D-01's mechanism from the schema side |
| X-04 | HIGH | `/simulator` renders invented coaching guidance graded on the Layer 11 safety ladder, ungated and undisclosed | 7 | New |
| X-05 | HIGH | `/operations` stamps "Signed & Active" over safety guarantees that two other passes of this same audit found unenforced | 7 | New |
| X-06 | HIGH | The recorded basis for the "leave the consoles alone" decision is measurably wrong — **one of six carries the stamp, not six** | 7 | New — corrects a premise I relied on when advising you |
| X-07 | HIGH | `/operations` presents LEGACY-READINESS as a signed, certified, active mathematical gate, to every role in the gym | 9 | New |
| X-08 | HIGH | The one readiness number that actually changes a child's training is a **client-side constant, defaulting to GREEN** | 9 | New |
| X-09 | HIGH | "Readiness to Train" is stored in a column named `rpe` and displayed to the child as "effort" | 9 | New |
| X-10 | HIGH | "Approve + verify" is one click by one person, and the screen shows nothing that could be verified | 16 | New |
| X-11 | HIGH | The Library grades a claim "Backed by approved Library evidence" by **counting citations**, bypassing the codebase's own quality rule, and the UI drops the quality fields | 16 | New |
| X-12 | HIGH | Capability coverage counts sources nobody approved — including sources a reviewer **rejected** and sources withdrawn for retraction | 16 | New |
| X-13 | HIGH | **Any organisation member, including an athlete**, can mark a research requirement "Resolved" with no evidence at all | 16 | New |
| X-14 | HIGH | A blocked video of a child files its safety escalation exactly once; if that write fails the escalation is **lost forever** | 17 | New |
| X-15 | HIGH | A job retried after lease expiry **re-sends a child's video frames** to the external vision service, with consent checked only at the original enqueue | 17 | New — the long tail behind E-01/F-11 |
| P-01 | HIGH | `POST /api/pilot/audit/get` returns `select *` over `pilot.audit_events` behind a **one-entry** coach denylist. 56 entity types are written; three carry payloads a coach should not enumerate gym-wide — `account` details include `login_email` and guardian link ids, `intake_case` includes reviewers' free-text notes, `parent_barrier_report` includes a named athlete's family hardship category. The narrow gate exists and this route goes around it | 5 | New — not in pass 2 (among its 175 unopened), not in `NETWORK_STATUS.md`, not in the last 40 commits |
| P-02 | MEDIUM | `intake/domain-upsert` writes the SHADOW authority record — `allowed: true`, caller-authored `action`, named child — **before** `assertActorCanAccessAthlete` runs | 5 | New; corroborates S-01's ordering point from a second direction |
| P-03 | MEDIUM | Film Study vision jobs enqueue with no dedup, so duplicate AI runs occur on the same minor's footage | 5 | New |
| P-04 | MEDIUM | `document-ingest` writes Dataverse, SharePoint and Drive with no idempotency, no compensation and no rate limit | 5 | New; pairs with E-03 |
| P-05 | LOW | `env.ts:6` reports an unset environment variable as a **400 naming the variable**, contradicting the rule `http.ts:90` states in the codebase's own words | 5 | New |
| A-01 | HIGH | `POST /api/pilot/platform/athlete-shell` creates a live, sign-in-able athlete account on the **published** starting PIN, in any organisation — while its own doc comment and its response body both state it grants no sign-in capability | 1 | New |
| A-02 | HIGH | The platform-owner bootstrap endpoint is armed in production indefinitely behind one static header secret; one correct header reactivates any suspended organisation and rewrites the `platform_owner` row | 1 | New |
| A-03 | MEDIUM | `seatRequiresMicrosoft` has zero callers, so the board-seat credential upgrade is enforced by nothing | 1 | New |
| A-04 | MEDIUM | No lockout exists anywhere on authentication — backoff caps at 60s and resets after 15 idle minutes | 1 | New |
| S-01 | HIGH | `pilot.shadow_medical_administrative_status` is read by three gates. Its sole writer is reachable by **any assigned coach**, `sourceReference` is optional free-text, there is **no expiry** (bare equality on the latest row), and there is **no `assertShadowAuthority` call at all** — on the one route whose job is clearing a child, while that check's own denylist names `clear`, `concussion` and `sparring` | 8 | New |
| S-02 | MEDIUM | `SHADOW_PHASE1_HARDENING_CHECKLIST.md:40` claims authority tests that do not exist — both route tests `jest.mock` the module to a no-op | 8 | New |
| S-03 | MEDIUM | `createShadowLibraryClaim` returns hardcoded `confidence = 0.78 / 0.46 / 0.12` derived from a row count, contradicting the doctrine's own "must not fabricate certainty" | 8 | New |
| S-04 | MEDIUM | The SHADOW spec says there is no production video-analysis backend; there is one, sending minors' frames to a vision model. A later section corrects five other rows and not this one | 8 | New |
| S-05 | LOW | 32 `shadow_mirror: false` opt-outs, only four with a stated rationale; guardian consent withdrawal never enters the SHADOW spine, contradicting the doctrine | 8 | New |
| D-01 | **CRITICAL** | `DATA_RETENTION.md` gives photos, videos, medical records, waivers and training notes their own deletion windows. The only deletion code touches `pilot.athletes` and `pilot.accounts`. **Video is not reachable from any deletion path even in principle** — verified by hand below | 12 | New |
| D-02 | HIGH | The named daily script `pilot:cleanup-expired-data` does not exist, and the job that does (`retention-cleanup.yml`) is hard-wired so a *scheduled* run can never delete | 12 | New |
| D-03 | HIGH | `/admin/data-deletion`, cited twice as the admin's console, has no page, no nav entry and no caller; the promised "reversible for 1 year" restore has no code at all | 12 | New |
| D-04 | MEDIUM | Waivers and medical records, documented as 3 years, actually die at the athlete's 2-year clock via FK cascade — **earlier** than documented | 12 | New |
| D-05 | MEDIUM | `docs/AGENT_EXECUTION_POLICY.md` declares itself read-first and binding and contradicts `AGENT_KERNEL.md` on three rules; unmarked, and referenced by zero files | 12 | New |
| D-06 | MEDIUM | Capability module 082, marked DONE, says `conditioning_only` holds mean "reduced permitted intensity"; the scope appears in no predicate anywhere, only three display labels | 12 | Corroborates F-06 from a different direction |
| T-01 | **CRITICAL** | The only path that records contact for a child carries two gates — `flagContactWithoutClearance` and `flagContactDuringHold`. The route has no sibling test, and its sole test posts a non-contact kind, so both gates short-circuit and are never exercised. **Deleting both calls leaves all 482 suites and 5,997 tests green** | 10 | New |
| T-02 | HIGH | 69 of 94 Postgres suites leak a full PGDATA per run — 263 MB measured for one suite | 10 | New |
| T-03 | HIGH | `test:migrations` is a 94-link `&&` chain; one failure skips every later suite, including the gate proofs (training-holds is entry 47, safety-gate-matrix 41, safety-escalations 42) | 10 | New |
| T-04 | MEDIUM | `dataDeletion.test.ts` is six tautologies that never call the module | 10 | New |
| T-05 | MEDIUM | The retention window is untested in the *narrowing* direction — changing `interval '2 years'` to `'2 months'` stays green | 10 | New |
| T-06 | MEDIUM | `guardianConsent.test.ts:53-66` asserts `ok: true` for a guardian with `covers_video: false`, so closing the consent-scope gap requires editing two tests that currently encode the gap as correct | 10 | New |
| T-07 | MEDIUM | 70 of 228 API routes are loaded by no test, including `shadow/medical-status` — the setter for the status the contact gate reads | 10 | New |
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

### The question I most wanted answered, answered — and my inference from it was wrong

**What drives the SHADOW job processor:** an in-process `setTimeout` loop inside
the running Next.js server, started by `apps/web/instrumentation.ts` via
`startShadowJobWorker`, gated on `PPBF_SHADOW_WORKER_ENABLED === 'true'` — which
`deploy-production.yml:437` and `deploy-staging.yml:278` both set to `true` on
the Azure Container App. Cadence is the 30-second default; neither workflow
overrides it.

I had reported "nothing in `.github/workflows/` or `apps/web` calls
`shadow/jobs/process`" as evidence that nothing drives the queue. The fact was
true and the inference was wrong: **the route was never the driver.** Its own
header says so at line 3 — *"The routine drain is the in-process worker loop (see
instrumentation.ts and shadowJobWorker.ts)"*. I had the answer one file away and
drew the opposite conclusion from an absence.

Worth recording where the belief came from, because it is a live hazard for
anyone reading this repo: `docs/SHADOW_CHAT_FUNCTIONALITY_AUDIT_2026-07-28.md:363`
states that nothing drains the queue. That was **true when written** and false
since the flag flipped on 2026-07-30. A dated audit is not wrong, it is stale —
and this one has now misled two passes of a later audit.

**On the Film Study window, this pass bounded the finding in both directions
rather than only the alarming one**, which is the behaviour the standard is for.
The common-case window shrinks from unbounded to ~30 seconds — but the 24-hour
job TTL plus three lease-expiry retries leave a long tail, with no consent
re-check on any attempt. It explicitly declined to raise the severity on the
strength of a fact that narrowed the exposure.

**`assertShadowAuthority`: pass 4's claim confirmed, with a better formulation
than either of us had.** A denial *is* reachable at `review-action`, so "cannot
deny at any of its three call sites" is literally false at one. The corrected
claim: **it cannot deny for any input the system controls** — the one reachable
denial requires the caller to volunteer a flag no shipped client sends, and doing
so would deny their own request. Two sharpenings neither earlier pass had: the
check runs *before* `assertActorCanAccessAthlete`, so the governance table
records `allowed: true` on medical writes the next line may refuse; and its
forbidden list guards exactly the risk it never sees.

**No CRITICAL from this pass, and that is a result rather than an omission** —
both candidates came back HIGH after refutation, with the reasoning stated in
each. Refutation partly succeeded on S-01: the gate is detective rather than
preventive, its own remediation text tells the reader to ask a coach, and the
write is audited in-transaction. That is why it is HIGH and not CRITICAL.

### Checked by hand: a minor's video is not reachable by any deletion path

Pass 12's CRITICAL rests on one structural claim, so I read the DDL myself
rather than relaying it. It holds.
`infra/azure/pilot_slice_postgres_video_sessions_migration.sql:65-80` declares:

```
create table if not exists pilot.video_sessions (
  video_session_id text primary key,
  organization_id text not null,
  uploaded_by_account_id text not null,
  athlete_id text null,
```

`athlete_id` is a bare `text null` with **no `references pilot.athletes`**, and
the table has **no `deleted_at` column**. Other tables reference
`video_sessions` — `publications` cascades *from* it — but `video_sessions`
itself references nothing, so deleting an athlete cannot reach the video by
cascade, and there is no soft-delete column to mark it with either.

The consequence is the part that matters for a nonprofit holding footage of
children. `DATA_RETENTION.md` is not a design sketch: it is linked from
`MASTER_INDEX.md` beside the backup runbooks, carries a compliance scope and a
privacy-officer sign-off, and reads as operational policy. A guardian asking
what happens to video of their child would be given a two-year answer. Nothing
deletes it, ever.

**The pass's most useful output is the other half of its ledger**, and it is
reassuring: 17 documents and claims verified **TRUE** and listed by name so the
next reader knows what can be trusted — including both root contract files.
`AUTH_CONTRACT.md` matches on role enum, cookie flags and endpoints;
`ORGANIZATION_ROLE_MODEL.md`'s board boundary holds at every checked point. **No
contract file states a safety rule the code violates.** Six documents are
contradicted, five of them non-safety. The retention policy is an outlier, not
the house style — which is exactly the distinction that decides whether this is
one document to fix or a systemic problem.

Method, stated because it bounds the above: 440 markdown files in scope, 22 read
in full, 19 in substantial part, 440 machine-scanned, **399 never opened** —
all of `docs/archive/`, all of `docs/capabilities/work/`, and 192 module files
beyond their status field.

### The console stamp count: I gave you two wrong numbers. Here is the checked one.

**Five of six capability consoles carry a fabricated-data disclosure on current
`origin/main`. The one that carries none is `/admin/retro-lab`.** I verified this
myself after telling the owner two different things.

The sequence is worth writing down because it is a case study in how these
mistakes happen:

1. I originally reported that **all six** carried the stamp, taking it from
   `HANDOFF_VISUALS.md`, which says so.
2. Pass 7 reported **one of six**, and I passed that on as a correction of my own
   earlier claim.
3. The refutation pass found **five of six**, and that PR #422 had added the stamp
   plus disclaimer to four of them with regression tests.
4. My own first check returned **zero of six** — because I grepped the
   `page.tsx` files, and each console page is a fourteen-to-twenty-one line shell
   that renders a component. The disclosure lives in the component.

So: pass 7 was **correct at the commit it read** (`04dd116b`); the count changed
because work merged, not because the pass erred. My "correction" to the owner was
the actual error — I treated a stale-but-honest count as a refutation of a claim
that was nearly right. And my first attempt to settle it was wrong in the other
direction because I grepped the wrong layer.

Verified per console, disclosure hits in the rendering component:
`MacroCommandCenter` 2 · `BoardViewportSwitcher` 3 · `MediaAndCommsHub` 2 ·
`CurriculumProgressionEngine` 2 · `FloorOperationsDesk` 2 ·
**`DevToolsQAConsole` 0**.

The finding is therefore downgraded HIGH → LOW, and the real remaining item is
narrow: `/admin/retro-lab` needs the disclosure its five siblings have.

### One finding contained a quotation that does not exist

The most serious defect type this audit has produced, and it is worth more
attention than any single severity label. Pass 7's P7-05 cites `errors.ts` and
quotes *"so a caller can branch on the code rather than the prose"*. **That string
does not appear in that file.** I confirmed it independently: zero hits.

Every other quote checked across three refutation passes was character-exact.
This one was invented. It is the reason rule 1 of this audit's standard exists,
and the reason a "confirmed" verdict here means *the quote is real* rather than
*the reasoning is sound* — a reader who trusted that quote would have been
reasoning from a sentence nobody wrote.

Alongside it: **eight citations whose line numbers had drifted** (every quoted
string findable, none at the printed line), and **six wrong counts** — "all four
are inside `dataDeletion.ts`" (a script also filters, and one does it correctly);
"two foreign keys" (66 of 127 account FKs lack an action); eleven inputs (twelve);
six CSS classes (seven); sixteen unsupported registry entries (seventeen); "only
non-test occurrences" (three). And one finding argues at length about what a line
says while citing a line fifteen lines away, which is prose about colour tokens.

### The Postgres teardown diagnosis I published was wrong

`NETWORK_STATUS.md` carried a confident, detailed diagnosis of the 93-suite
teardown race, written by this session: SIGTERM is Postgres *smart* shutdown, a
lingering client keeps the server alive, a 15-second bail-out resolves anyway,
the data directory is deleted mid-write, `ENOTEMPTY` on `pg_wal`, fix it with
`SIGINT` plus `fs.rm` retries. Pass 10 traced it end to end against the code as
it stands. **Almost every link is wrong:**

- There is **no shared helper.** The teardown is copy-pasted into 93 files, so a
  one-line fix is a 93-file change. The original write-up implied one helper.
- SIGTERM goes to a **Node wrapper**, not to Postgres.
- `pg.stop()` in `embedded-postgres` **already sends `SIGINT`**
  (`node_modules/embedded-postgres/dist/index.js:258`). The recommended fix was
  already the existing behaviour.
- `pg.stop()` resolved in **14 ms** in an instrumented probe. The 15-second
  bail-out is never reached.
- **`ENOTEMPTY` appears nowhere in the repository.**

The real defect is different in kind: `embedded-postgres` registers
`AsyncExitHook(gracefulShutdown)`, and `async-exit-hook` claims SIGTERM for
itself and calls `process.exit` on the next tick after its hook resolves. One
SIGTERM therefore starts two shutdowns and the library's wins — the wrapper's own
`fs.rm` of a ~200 MB tree never completes, and its `catch` never fires because
there is no error, only a dead process. Measured: a suite without a parent-side
`fs.rm` left 263 MB behind after a fully passing run; one with it left nothing.

This is the clearest example in the audit of the thing the standard was written
against. The original diagnosis was specific, mechanistic, plausible, and
delivered with confidence — and it was reasoning, not reading. It has been
corrected on the shared surface rather than quietly amended.

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

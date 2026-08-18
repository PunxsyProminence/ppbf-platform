# Pass 13a — Cross-cutting synthesis: collisions between passes

Run against `docs/full-spectrum-audit-2026-08-18`, `origin/main` at `04dd116b` (the
commit the whole audit is pinned to). Read-only: no application code was touched; this
file is the only write. Written incrementally as each pass was read, per instruction —
the working notes that produced this are visible in this file's edit history within the
session, not reproduced below.

## Method

Read `README.md` first in full. It already aggregates a great deal of cross-time
correction from the lead session (retractions, downgrades, the two "I told the owner
something wrong" sections) — that is a useful input but not a substitute for a
structured hunt, because it is one person's synthesis across sequential reads, not a
deliberate search for defects that only two passes *together* reveal. Then read all
sixteen `PASS-*.md` files and all four `VERIFY-*.md` files in full (Pass 13, this one, is
the seventeenth). For each of the six directed hunts, the two or more named passes were
re-read side by side, every quote re-verified against `path:line` in this checked-out
tree (not re-typed from the pass file), and the collision was written up only once the
quotes held. Two hunts did not survive scrutiny as originally framed and are reported as
partially or fully ruled out rather than forced. One additional collision, not on the
directed list, emerged from reading the full set and is reported after the six.

Severity is not re-litigated here — every underlying finding keeps the severity its own
pass and (where one ran) its refutation pass gave it. This file's only claim is about
what becomes visible when two or more of those findings are held at once.

---

## Collision 1: The stopping mechanism has no door, the clearing mechanism has an unlocked one, and the one test that would notice a live violation does not exist

**Passes and findings involved:** Pass 14 (J1-A, J1-B), Pass 4 (gate inventory, "Checked
and found sound"), Pass 8 (H-1), Pass 10 (T-01).

Pass 4 spent its entire "Gate inventory" section analyzing what happens *once* a
training hold exists — the STOP rung, the two REGRESS rungs, the contact-clearance gate,
competition entry. Its own confirmation that the write path is real and singular:

> "`pilot.training_holds` has exactly one writing module. Three statements, all in
> `trainingHolds.ts` (117, 180, 252)."
> — `docs/audit-2026-08-18/PASS-04-safety-gates.md` ("Checked and found sound")

Pass 14, tracing the journey rather than the module, reaches the same three lines from
the opposite direction and adds the fact pass 4's enforcement-first framing never states:
nothing calls the function that inserts them.

> "`POST /api/pilot/training-holds` with `action: 'place'` is a complete, well-guarded,
> transactional endpoint. **Nothing in the application calls it.**"
> — `docs/audit-2026-08-18/PASS-14-flows.md:67-68`

confirmed by four separate refutation attempts, all of which failed to find a caller —
no UI form field for a reason category, no second server module, no raw SQL outside
`trainingHolds.ts` and its own test, and the only other `action: 'place'` in the app
(`coach/floor-groups/page.tsx:154`) is a different endpoint entirely.

**What neither pass alone states, and what only holding them together shows:** every one
of pass 4's enforcement findings — the STOP rung stopping registration, the REGRESS
rungs flagging contact, `flagContactDuringHold`'s careful "flag never block" doctrine —
describes correct behavior conditioned on a precondition (`status = 'active'` exists in
`pilot.training_holds`) that pass 14 shows the product has no way to satisfy. Read pass 4
alone, and the safety-gate machinery reads as a working system with one missing UI
button, low severity by itself. Read pass 14 alone, and the missing button reads as an
isolated UX gap. Read together: **every hold-enforcement finding in this audit describes
enforcement of a condition nothing in the product can create.** The gate is not
weakened, misconfigured, or racy — it enforces a state that a coach or admin has no
lever to reach. `trainingHolds.ts:29-31`'s own authority comment — "coaches place and
lift holds for their own athletes; organization admins place and lift any" — describes an
authority that is implemented in the module and unreachable everywhere else.

Pass 8's H-1 adds the asymmetry that makes this worse than a symmetric gap. The
*clearance* record that gates the same population (contact/sparring) — functionally the
"go" signal to the hold's "stop" — has exactly the writer the hold lacks, and it is wide
open:

> "`pilot.shadow_medical_administrative_status` is consulted by three separate gates...
> Its single writer declares itself as such... That writer's only route is `POST
> /api/pilot/shadow/medical-status`, gated by `requireRole(principal, [...SHADOW_PHI_ROLES])`"
> and `SHADOW_PHI_ROLES` includes `coach`.
> — `docs/audit-2026-08-18/PASS-08-shadow.md` (H-1), `shadowMedicalStatus.ts:19-24`,
>   `shadowRoleSets.ts:48-52`

No `assertShadowAuthority` call on this route at all (the same module's forbidden-action
denylist names `clear`, `concussion` and `sparring` — exactly the risk this route carries
— and never runs on it), no expiry, and `sourceReference` is optional free text. Any
assigned coach can write `'cleared'` in one request, permanently, with no document.

So: the control that would make a child's training **stop** has no door any coach or
admin can walk through. The control that keeps a child **cleared to continue** has a
door with no lock, reachable by the exact role population the hold's authority comment
names. That is not visible from pass 4 (which does not go looking for the medical-status
write path — it is pass 8's table), and not visible from pass 8 (which is not asking
whether a hold can be placed — that is pass 14's question). Combining them says a sentence
none of the three passes states on its own: **the platform can effortlessly tell a coach
their clearance to keep a child in contact is on file, and has no mechanism at all for
telling anyone the opposite.**

Pass 10's T-01 closes the loop on what would actually catch a violation of this on the
floor. The one route that records contact — the route both `flagContactWithoutClearance`
and `flagContactDuringHold` are wired into — has no test that exercises it with a contact
observation:

> "`apps/web/app/api/pilot/shadow/formulas/observations/route.ts` is the single path that
> records contact for a child... The route has no sibling test file... **Deleting both
> calls leaves all 482 suites and 5,997 tests green.**"
> — `docs/audit-2026-08-18/PASS-10-tests-ci.md` (T-01)

Held against pass 14's J1-B ("Attendance check-in consults no hold and raises no flag" —
`attendance*.ts` contains no `hold` reference at all), the full picture is: there is no
UI path to place a hold; the everyday floor action that would otherwise reveal a held
child attending anyway (attendance) never checks; the one route that *would* flag contact
during a hold is real, correctly ordered, and completely unguarded by any test tying its
safety calls to anything at all, so the two calls that make it matter could be deleted by
an unrelated refactor tomorrow and no CI signal would fire. No single pass states all of
this; pass 4 calls the contact gate "sound," pass 10 calls the wiring around it
untested, pass 14 calls the door to the precondition absent, and pass 8 shows the
adjacent "go" signal is trivially settable. Four passes, one mechanism, none of them
wrong on their own terms.

**The directed sub-question — is there a manual/SQL path anyone actually uses today?**
Checked directly rather than assumed, twice, by two different passes for two different
reasons. Pass 4: `git grep "insert into pilot.training_holds" origin/main -- apps/web
infra scripts` returns six hits — five inside `trainingHolds.pg.test.ts` and the sixth
inside `placeTrainingHold` itself (`trainingHolds.ts:180`). Pass 14 independently re-ran
the same search from the journey side and reports the identical six. **No.** There is no
manual or SQL path anyone uses today; the capability is genuinely unreachable, not merely
undocumented. Neither pass would have needed the other to establish this specific
sub-question — it is one of the few places in this collision where a single pass's
answer already settles the point, and both passes reached it independently, which is
itself worth recording as corroboration rather than as a gap.

---

## Collision 2: What "safety" currently means at this gym, stated once, honestly

**Passes and findings involved:** Pass 15 (E-01, and the VERIFY-15-16-17 correction to
it), Pass 9 (F-9-01/F-9-02, indexed in the audit's shared table as X-07/X-08), Pass 14
(J1-A).

Read separately, these are three different subsystems: video content screening, the
readiness/RPE pipeline, and the training-hold journey. Read together, they answer one
question a board member would actually ask — "what happens today if a child is not okay
to train, and what happens to a child's video the moment it is uploaded?" — and the
honest combined answer is worse than any one finding states, in a way that requires all
three, with one correction that matters and must not be dropped.

**Leg one, the readiness number.** Pass 9 establishes that the only readiness threshold
in the platform that actually changes what a child is prescribed to do lives entirely on
the client, is not registered anywhere the rest of the audit's own formula inventory
looked, and defaults to the most permissive reading:

> "`getReadinessLevel(readinessToTrain: number)`... `if (readinessToTrain >= 7) return
> 'GREEN'`... has no stated basis and no server-side existence... The default is the
> most demanding option. `const [readinessToTrain, setReadinessToTrain] = useState(8);`
> `getReadinessLevel(8)` is `GREEN`. A child who taps check-in without moving the slider
> is prescribed normal-intensity technical work plus 'High-output intervals'... This is
> the exact failure mode the same codebase names and forbids elsewhere:
> `readinessBoard.ts:8-9` quotes the coach workspace's own safety comment, 'never default
> these to a reassuring value.' **The athlete's own screen defaults to the reassuring
> value.**"
> — `docs/audit-2026-08-18/PASS-09-formulas.md` (F-9-02),
>   `AthleteWorkspace.tsx:269-273,577`

Pass 9 also independently confirms (matching pass 4's F-08) that the server-side
readiness clamp and delta-RPE lock this same finding is measured against are dead code —
zero callers — and that `/operations` certifies both as active anyway under a green
"Signed & Active" stamp, to every role in the gym including athletes and parents (F-9-01,
indexed X-07 in the shared table).

**Leg two, the video content scan.** Pass 15's E-01 states that every uploaded video of a
child has its frames sent to an external vision model with no consent check anywhere in
the path, and that this is the mandatory route to a readable video. That finding is
CONFIRMED WITH CORRECTION by the refutation pass, and the correction is the one that
matters most for stating this collision honestly: the "already happened to real
children" framing in the escalation is **not supported by the repository**. The deploy
workflow itself records why the gate was turned on when it was:

> "Enabled on the owner's explicit instruction (2026-08-01), on the stated basis that no
> athlete footage reaches production until the platform is in live use at the gym. So
> this turns the gate on BEFORE any minor's video exists in production, rather than
> applying a new automated decision to footage already sitting there."
> — `.github/workflows/deploy-production.yml:392-395`, quoted in
>   `docs/audit-2026-08-18/VERIFY-15-16-17.md:258-262`

and the one transmission this repository can actually evidence is a staging upload by an
organization admin, not a documented minor. The refutation pass states the correction
plainly: "If this finding has been reported to the owner as 'already happened in
production,' that specific assertion is unsupported and should be corrected to 'will
happen on the next upload, and has happened at least once in staging.'" What survives
every refutation, unchanged, is the mechanism: frames of any video uploaded to a
production-configured deployment are extracted and posted to an inference endpoint
within roughly one worker tick, no guardian consent state is consulted at any point on
that path, and no guardian-facing surface names any recipient.

**Leg three, the stopping mechanism.** Pass 14's J1-A, already the subject of Collision
1: nothing in the product can place a training hold.

**The sentence that requires all three, and only holds with the correction kept in
place:** before this gym opens to real children, none of its three headline safety
mechanisms is what it appears to be — the training hold that would stop a child has no
button anyone can press; the readiness number that actually changes a child's prescribed
session is a client-side constant that silently defaults to the most permissive reading
the moment a slider goes untouched; and the video-screening pipeline that will run on
every real upload has no consent gate in its path, a fact the codebase already knows how
to fix because it built the identical gate one door over (Film Study) and never carried
the reasoning across. None of these has harmed a real child yet, and the audit's own
verification work establishes that plainly and should be credited for it — this is a
pre-launch finding about what "safety" currently *means* in the product, not a report of
harm already done. That distinction is itself only visible by holding pass 15's
correction next to pass 9's and pass 14's findings; read pass 15 alone with its original
framing, and a reader reasonably concludes real children were already exposed. Read all
three correctly, and the finding is arguably more useful to the owner, not less: it is a
short, specific, still-open punch list to close *before* the thing it is warning about can
happen to anyone.

---

## Collision 3: No deletion promise in this codebase can currently be kept — not just the video one

**Passes and findings involved:** Pass 6 (the two HIGH findings on soft delete and the
hard-delete FK block), Pass 12 (the CRITICAL and two HIGH findings on
`DATA_RETENTION.md`), Pass 3 (Finding 7, the retention-scope finding).

One correction to the directed hunt's own framing, checked directly rather than assumed:
**Pass 11 does not contain a retention-cannot-succeed finding.** Its scope is secrets and
infrastructure; the phrase "retention" appears in it exactly once, naming a workflow's
cron schedule (`retention-cleanup.yml`), with no analysis of foreign keys or deletion
mechanics. The FK-blocking findings are pass 6's alone. This is worth stating plainly
rather than silently substituting the right pass, because a synthesis that quietly
"corrects" its own brief without saying so is exactly the kind of unflagged drift this
audit's standard exists to catch.

With that correction made, the three passes that do combine tell a story none states
alone. Pass 12 establishes what the organization has promised in writing:

> "`docs/DATA_RETENTION.md` gives photos, videos, medical records and waivers their own
> deletion schedule; no code deletes any of them, and video rows are not even reachable
> from an athlete deletion path even in principle... linked from `MASTER_INDEX.md` under
> 'Operations' alongside the backup and migration runbooks, so it reads as an operational
> document rather than a draft."
> — `docs/audit-2026-08-18/PASS-12-docs-vs-code.md` (CRITICAL)

Pass 6 establishes, independently and from the schema rather than the document, that even
the two tables the code *does* touch (`pilot.athletes`, `pilot.accounts`) cannot actually
be purged:

> "The retention hard-delete cannot succeed: two foreign keys with no `on delete` action
> block both halves of the purge, in one transaction... Every provisioned guardian has a
> `pilot.parents` row whose `account_id` is their account
> (`staffProvisioning.ts:469-478` writes it on every guardian invite) — so `delete from
> pilot.accounts ... and role = 'parent'` raises `23503` **for any real guardian**."
> — `docs/audit-2026-08-18/PASS-06-data-layer.md` ("The retention hard-delete cannot succeed")

and separately that the soft-delete flag the whole retention scheme depends on as its
starting condition is filtered by nothing:

> "76 non-test statements reference `pilot.athletes`; 4 mention `deleted_at`, and all
> four are inside `dataDeletion.ts` itself... A 'deleted' child stays visible everywhere
> for two years, and a 'deleted' guardian keeps logging in."
> — `docs/audit-2026-08-18/PASS-06-data-layer.md` ("Soft delete is written, indexed for,
>   and filtered by nothing")

Pass 3, reading the same document from the consent side rather than the schema side,
independently reaches the video-specific version of pass 12's finding and adds the detail
neither pass 6 nor pass 12 states — that the failure mode is not merely "nothing is
deleted," it is "nothing is deleted, and the record that would have let anyone find the
undeleted bytes later is *also* gone the moment the athlete row is removed":

> "Two years later the athlete row and its cascaded medical, waiver and observation rows
> are removed — and the child's photograph and their training videos are still sitting in
> the storage account, with **no row left anywhere that says whose they are.** That is
> the worst of both: the data is retained and it is no longer attributable, so a future
> deletion request cannot even find it."
> — `docs/audit-2026-08-18/PASS-03-minors-consent.md` (Finding 7)

**What only holding all three together shows:** it is not merely that video is
undeletable (pass 12's headline CRITICAL, which the README already foregrounds). Every
category the policy names fails, by a different mechanism, and pass 6 supplies the reason
none of them can even reach the starting line for a real gym: the retention purge that
every category's clock depends on cannot execute at all once a single real guardian
exists in the organization, because the FK that would let it complete has no cascade
action. So the honest answer to "what happens to my child's data when we leave" is not
"video is the exception, everything else works as documented" (which is how pass 12's own
framing — "the retention policy is an outlier, not the house style" — could be read in
isolation, and which pass 12 states carefully and correctly as a *documentation* finding).
It is: **nothing in `DATA_RETENTION.md` can currently be executed against a real gym,
because the one mechanism every category's deadline depends on is blocked by a foreign
key that fires on the very first real family the purge would ever try to process.** Pass
12 alone would leave a reader believing four of five categories at least *could* work if
someone fixed the video FK. Pass 6 alone would leave a reader believing this is a schema
nit with no connection to the guardian-facing policy document. Together, the schema
defect *is* the reason the policy document's promise fails universally, not just for
video.

**A boundary this collision does not extend to, checked and ruled out rather than
folded in for breadth.** Pass 3's Finding 2 (Film Study checks consent at enqueue and
never again) concerns a *withdrawal* promise — whether data stops being *used* after a
guardian says no — not a *deletion* promise — whether data stops *existing*. These are
adjacent failures of the same guardian-facing trust relationship, but they are not the
same claim, they do not share a mechanism, and treating them as one collision would
overstate what the three passes above actually establish together. The Film Study gap is
already covered by Collision 2's discussion of the video pipeline and is not re-counted
here.

---

## Collision 4: A single missing primitive appears at 13+ call sites across three separately-numbered findings by three different passes — and one superficially similar finding is a genuinely different mechanism

**Passes and findings involved:** Pass 2 (F-20 and the eleven-route family), Pass 8
(H-1, again — this collision reuses it from a different angle), Pass 5 (P-01).

Pass 2's F-20, already raised to CRITICAL on the lead session's own review, is one
instance of a pattern pass 2 already names as a pattern within its own single-pass scope:
a route admits a coach by role and never checks that the coach has any standing on the
named child.

> "`listOpenSafetyFlags` filters on `organization_id` and nothing else... A training hold
> and a safety flag are the same kind of fact about the same child. One route refuses an
> org-wide roster in as many words; the other serves one."
> — `docs/audit-2026-08-18/PASS-02-authorization.md` (Finding: "Any coach can read, raise
>   and resolve safety flags for every child in the gym")

Pass 2 then finds ten more routes with the exact same shape in one MEDIUM finding —
`transfer-check`, `behavior-standards`, `floor-groups`, the three `intervention-*`
routes, `one-percent-club`, `competence-cohorts`, `multidiscipline`,
`data-collection-requests` — each one "a `coach` admitted by role and the athlete named
by the request, with no call to `assertActorCanAccessAthlete`, `assertCoachAssignedToAthlete`
or `accessibleAthleteIds` anywhere in the file," and confirms the fix already exists and
is used correctly four routes over (`coach/readiness-board`, `coach/intelligence`,
`analytics/performance`, `progression/suggestions` all call `getAthletesForCoach` first).

Pass 8's H-1 — introduced under Collision 1 for a different reason — is, mechanically,
the identical missing primitive at a twelfth call site. The medical-status setter route
is gated by `requireRole([...SHADOW_PHI_ROLES])` (which includes `coach`) and nothing
else; no `assertActorCanAccessAthlete`, no `assertCoachAssignedToAthlete`, and — the part
pass 8 emphasizes for its own reasons — no `assertShadowAuthority` either, on the one
route in the whole authority subsystem whose forbidden-action list was written for
exactly this case. Held next to pass 2's eleven-route table, this is not a new kind of
gap; it is the thirteenth-plus instance of a gap pass 2 already characterized precisely,
in a subsystem pass 2 did not read.

**So thirteen-plus call sites across two passes, three separately-labelled findings
(F-20, the pass-2 eleven-route MEDIUM, and pass 8's H-1), collapse into one root cause
and, genuinely, one fix**: call the athlete-scoping primitive this codebase already has,
already uses correctly on sibling routes, and already documents the reasoning for
(`training-holds/route.ts:131`'s "no org-wide hold roster" comment is the sentence every
one of these thirteen routes is missing). This is a case where the "one fix instead of
three" the collision-hunt asked about actually holds, and holds for more instances than
three.

**What does not hold, checked directly rather than assumed: pass 5's P-01 is a different
mechanism, not a fourteenth instance.** `audit/get` is not naturally athlete-scoped at
all — it is a bulk read across 56 distinct `entity_type` values, most of which are not
about a single child. Its defense is a denylist (`COACH_EXCLUDED_ENTITY_TYPES = new
Set(['training_hold'])`), and its own comment states the remediation pass 5 recommends:
"Extend this list... if another safety entity type ever writes audit events a coach
should not enumerate freely." That is a genuinely different fix from "call
`assertActorCanAccessAthlete`" — this route has no single athlete to scope to on most of
its paths, and the omission is an incomplete enumeration of *entity types*, not an absent
per-child *relationship check*. Both defects share a family resemblance ("a coach-facing
route under-scopes what a coach can see about a child"), and a reader could reasonably
lump them together as "the same kind of miss" — but they do not share a fix, and
reporting them as one collapsed root cause would overstate what the passes actually show.
This is the collision-hunt candidate that partially fails: two of the three named
findings (F-20 and, by extension, S-01) genuinely are one mechanism; the third (P-01)
looks the same from a distance and is not, on inspection, fixable the same way.

---

## Collision 5: Ruled out — the bootstrap key does not appear anywhere in the git history pass 11 searched

**Passes and findings involved:** Pass 1 (A-02, the bootstrap-endpoint finding), Pass 11
(S-01 and the full historical secret sweep).

Checked directly, as the brief instructed, rather than assumed. Pass 11's historical
search was not scoped to the workflow files where the two real credential leaks
(`PILOT_ADMIN_PIN`, `PILOT_SHADOW_ATHLETE_PIN`) were found — it swept **every blob in the
object database**, 6,562 blobs, 114,785,631 bytes, via `git cat-file --batch-all-objects
--batch`, matched against a pattern set that explicitly includes "literal assignment of
any identifier matching `*(KEY|SECRET|CONNECTION_STRING|PASSWORD|TOKEN|API_KEY|PIN)` to a
value of 12+ characters." `PPBF_PILOT_BOOTSTRAP_KEY` is exactly such an identifier, and it
was one of the enumerated hits:

> "`PPBF_PILOT_BOOTSTRAP_KEY=secretref:…` (65 blobs), `AZURE_AI_KEY=secretref:…` (48
> blobs), etc. | `deploy-*.yml`, all historical versions | Azure Container Apps **secret
> references**. They name a secret; they do not carry one."
> — `docs/audit-2026-08-18/PASS-11-infra-secrets.md` (secret-exposure table)

**Every one of the 65 historical appearances of the bootstrap-key variable, across the
entire commit graph, is a `secretref:` reference, never a literal value.** This is the
opposite of the two PIN findings in the same table, which were literal digit strings.
Pass 1's A-02 finding is real and stands on its own terms — the route stays armed
indefinitely in production behind one static header secret with no rotation mechanism —
but that is an architecture concern about the *comparison*, not an exposure concern about
the *value*. The two do not combine into anything worse than either states alone: the key
itself was never committed in the clear, on any branch, at any point pass 11's blob-level
sweep could reach. This directed hunt does not hold, and it is reported here as a
negative result rather than stretched into one, per the audit's own rule against
gap-filling.

---

## Collision 6: "Checked and found sound" claims re-examined against every other pass's findings

Every pass's "Checked and found sound" (or equivalent) section was compared against the
other fifteen passes' finding tables, looking specifically for a *different* pass
contradicting a claim of soundness (not the matching refutation pass re-checking the same
claim, which this audit already runs as its own mechanism and which is not what this
collision is hunting for). Two genuine near-misses were found; neither is a clean
contradiction, and both are reported as what they actually are.

**Near-miss A: two same-shaped "clearance" tables, one dead and one dangerously live, and
no single pass states both facts.** Pass 2's "Checked and found sound" section states,
correctly and not contradicted by anything: "`medical_intake.clearance_status` gates
nothing... I grepped every read of `pilot.medical_intake` in `apps/web/src`: it is
written by `intake.ts:460`, read back by `intake.ts:767` for the case aggregate, named in
three privacy-tier denylists, and read by no gate. So this is not a clearance bypass."
That is true, and pass 8 never touches this table, so there is no contradiction. The
collision is subtler than a contradiction: a reader who takes pass 2's reassurance at
face value — a coach can write anything into "clearance status" and it changes nothing —
could reasonably generalize to "no clearance-shaped field in this codebase is
live-and-writable-by-a-coach." Pass 8's H-1 shows a **differently-named, similarly-shaped**
table (`shadow_medical_administrative_status`, not `medical_intake.clearance_status`) is
exactly that: live, read by three gates, and settable by any coach with no authority
check. Two clearance-shaped facts, opposite live-ness, same population of readers (a
coach at intake), and nothing in either pass's text tells a reader both facts exist unless
they are held side by side. Not a contradiction — a trap in the naming, visible only
across two passes.

**Near-miss B: the coach-coverage mechanism pass 4 calls "a recorded owner decision" and
the coach-coverage-shaped mechanism pass 2 finds unconditionally overwritable are
different tables, and pass 2 already resolves the apparent overlap itself.** Pass 4's
"Checked and found sound" records that a covering coach can lift a medical hold "by
recorded owner decision" (`training-holds/route.ts:33-40`), which is `pilot.coach_coverage`,
a bounded, expiring, one-grant-per-pair table pass 2 independently praises as "genuinely
bounded... careful work." Pass 2 separately finds (LOW) that `POST
/api/pilot/scheduler` `action: 'cover_class'` lets any coach unconditionally overwrite
`covering_coach_account_id` on any scheduled class with no check the slot is empty. These
sound, on first read, like the same "coverage" concept colliding — a coach claiming
coverage they should not have, then using it to reach a hold. They are not: `cover_class`
writes a column on `pilot.scheduler_classes` used only for class-ownership bookkeeping and
attendance-action authorization; it has no relationship to `pilot.coach_coverage`, the
table `assertCoachAssignedToAthlete` actually reads. Pass 2 traces this itself and
confirms the LOW finding "cannot read or write any athlete row they could not already
reach" through this mechanism. Checked, and ruled out as a collision: the resemblance is
in the English word "coverage," not in any shared code path.

**No third instance was found.** The remaining "checked and found sound" sections across
all sixteen passes — the primitives in `access.ts`, the org-scoping SQL scanner in pass
2, the fail-closed authorization survey pass 17 independently re-ran and confirmed rather
than contradicted, the guardian-consent race-closing pattern pass 3 documents and pass 17
corroborates verbatim, the migration-ordering and seed-idempotency claims in pass 6, the
role-invalidation-on-every-mutation claim in pass 1 — were checked against every other
pass's finding table and none was contradicted. This is itself a result worth stating
plainly: **the majority of this codebase's self-described "sound" claims are load-bearing
and hold up against the rest of the audit, not merely against the pass that made them.**
That is a genuinely reassuring finding, and the standard's own rule against gap-filling
means it should be reported as such rather than manufactured into a sixth collision that
does not exist.

---

## An additional collision, not on the directed list: three subsystems present a shortcut computation as if it were a rigorous signal, and nobody reading one pass would see the pattern

**Passes and findings involved:** Pass 8 (M-2), Pass 9 (F-9-02, again), Pass 16 (H-1,
H-2).

Pass 8's M-2 finds that the SHADOW Library's confidence score is not derived from
anything resembling evidence quality:

> "`createShadowLibraryClaim` returns a fabricated numeric confidence, chosen from three
> literals by a row count... The number 0.78 is not derived from authority tier,
> verification state, publication date, study design, or agreement between the sources —
> only from 'two different `source_id`s came back.'"
> — `docs/audit-2026-08-18/PASS-08-shadow.md` (M-2)

Pass 9's F-9-02 (already the centerpiece of Collision 2) finds the readiness band a
child is actually prescribed under is a client-side constant with no stated basis,
defaulting to the reassuring value the codebase's own doctrine forbids defaulting to.

Pass 16, reading a third subsystem entirely — the research-evidence library's approval
workflow — independently finds the identical shape twice over:

> "Approve + verify is one click by one person, and the screen shows nothing that could
> be verified... The route derives `verified` from `approved`, one actor writes both
> attributions in one statement, and the database then records that two facts were
> independently established. Nothing automated is consulted."
> — `docs/audit-2026-08-18/PASS-16-research-library.md` (H-1)

> "The Library grades a claim 'Backed by approved Library evidence' by **counting
> citations**, bypassing the codebase's own quality rule."
> — `docs/audit-2026-08-18/PASS-16-research-library.md` (H-2)

No single one of these four findings, read alone, is more than a subsystem-specific
defect: a fabricated confidence number nobody's UI even renders (pass 8 downgrades M-2 to
MEDIUM partly for this reason); a client-side default (pass 9's F-9-02); a one-click
approval workflow and a citation-counting label (pass 16's H-1/H-2). Read across three
passes covering three unrelated subsystems built by what is presumably three different
work sessions, the same architectural habit recurs each time: **compute something cheap
that resembles a rigorous signal (a row count, a slider default, a citation tally, a
single click) and let the UI or the database present it with the vocabulary of a
verified, computed, or certified fact** ("confidence: 0.78," "Backed by approved Library
evidence," "verified," a GREEN readiness band). This is not a shared code path or a
shared root cause in the way Collision 4's authorization gap is — there is no single fix
that touches all four. It is a shared *habit*, visible only by reading all three passes,
and it is the same habit pass 7's X-05/X-06 already caught in a fourth place
(`/operations`'s "Signed & Active" stamp over dead code) and explicitly flagged as "a
cross-pass result none of the individual passes could produce" when it combined two
findings. This synthesis extends that same observation to a third and fourth subsystem
pass 7 did not cover, which is why it is reported here rather than treated as already
settled.

---

## The single most important sentence this audit could not have written from any one pass

**Before this gym opens to real children, the product has no way for a human to make a
child's training stop, an easy and unaudited way for a coach to say a child is cleared to
keep going, and — on the one subsystem that already runs on every real upload — no
consent gate standing between a child's face and an external inference service; and the
audit's own verification work confirms that none of this has harmed a real child yet,
which is exactly why it is still fixable before it does.**

No pass states this sentence. Pass 14 states the first clause; pass 8 states the second;
pass 15, corrected by its own refutation pass, states the third in its true and less
alarming form. Put together they describe not three unrelated bugs but the actual current
meaning of the word "safety" on this platform, at the moment a board member would most
want to know it: the week before the doors open. A board member does not need to
understand `assertActorCanAccessAthlete` or SQLSTATE `42P01` to understand this sentence,
and it is the one sentence in this entire 157-finding audit that changes what "we found a
lot of MEDIUMs and one CRITICAL" means as a summary of readiness to operate.

---

## Could not establish

- **Whether every "one fix instead of three" claim in Collision 4 would actually resolve
  cleanly in code review.** This pass read the thirteen-plus call sites and confirmed
  they share the identical missing function call; it did not attempt the fix, and per
  this audit's own rule 5, source reading is not runtime proof that the fix compiles,
  passes existing tests, or does not itself narrow a role gate in a way that would put it
  on the "needs a human" list. `assertCoachAssignedToAthlete` at the medical-status route
  in particular changes who may clear a child for contact, which is squarely inside this
  repository's own "never fixed autonomously" boundary — implementing any of these three
  findings' fixes is an owner decision, not a mechanical patch, even though the *diagnosis*
  collapses cleanly.
- **Whether the additional "shortcut-presented-as-rigor" collision reflects one era of
  development or a standing habit.** Four instances across four subsystems and, per pass
  7's own dating, at least two different points in the project's history (the `/operations`
  stamp predates this audit; the Library evidence page and the SHADOW confidence function
  were not independently dated). Whether this is a live, ongoing practice or four
  historical artifacts from before a later, more careful era (the kind pass 9 and pass 16
  both note exists elsewhere in the same subsystems — `painReportAlert.ts`'s honest
  window-surfacing, `shadowLibrary.ts`'s honest empty-evidence answer) is not something
  this synthesis pass can settle from source alone.
- **Whether any of the six directed collisions, or the additional one, would look
  different against a live database.** Every quote in this file traces to a specific
  `path:line` in the checked-out tree at `04dd116b`, and per every contributing pass's own
  stated limits, none of them ran code, started a server, or queried a database. This
  file inherits that limit entirely; nothing here is runtime proof, and several of the
  underlying findings (whether the SHADOW worker is enabled live, whether the retention
  purge has ever run in APPLY mode, whether any `shadow_medical_administrative_status` row
  has ever actually been set) are explicitly listed as open in their own passes' "Could
  not establish" sections and remain open here.
- **Whether other genuine collisions exist among findings this pass did not put side by
  side.** 157 findings across sixteen passes is a large combinatorial space; this pass
  followed the six directed hunts, one hunt for contradicted "sound" claims, and one
  pattern that surfaced unprompted while reading. It did not attempt an exhaustive
  pairwise comparison of all 157 findings, which would be a different and much longer
  pass. What is reported above is what was found, not a claim that it is everything there
  is to find.

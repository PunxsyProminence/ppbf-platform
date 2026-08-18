# Verification — Pass 3

Refutation pass over `docs/audit-2026-08-18/PASS-03-minors-consent.md`.
Read-only; this file is the pass's only write. No application code was modified.

Working tree at `563af5ed`. The reported pass pins itself to `04dd116b`;
`git diff --stat 04dd116b HEAD -- apps/ infra/ packages/ scripts/` is **empty**,
so every line number below resolves identically on both commits and the pin is
not a source of drift. Every quote in this document was re-extracted from the
working tree by line number, independently of the quote in the finding.

Standing rule applied throughout: the finding is wrong until the file proves it.

---

## Summary

| Finding | Original | Verdict | Corrected severity |
|---|---|---|---|
| 1. Consent scope collected, enforced by nothing; `covers_video` defaults true | HIGH | **CONFIRMED WITH CORRECTION** | HIGH (unchanged) |
| 2. Coach can overwrite an existing guardian's account binding | HIGH | **CONFIRMED WITH CORRECTION** | HIGH (unchanged) |
| 2b. Guardian links accept an unvalidated `parent_id` | HIGH (restated) | **CONFIRMED** | HIGH (unchanged) |
| 3. Film Study checks consent at enqueue only | HIGH | **OVERSTATED** | **MEDIUM** |
| 4. 60-minute SAS URLs, in bulk, unaudited | HIGH | **OVERSTATED** | **MEDIUM** |
| 5. Hard-deleted athlete reclassifies account to staff, releasing the portrait | HIGH | **OVERSTATED** | **MEDIUM** |
| 6. Waiver console and media-consent gate disagree | MEDIUM | **CONFIRMED** | MEDIUM (unchanged) |
| 7. `DATA_RETENTION.md` promises deletion the code does not perform | MEDIUM | **CONFIRMED WITH CORRECTION** | MEDIUM (unchanged) |
| 8. Second, unguarded purge implementation with zero callers | MEDIUM | **CONFIRMED** | **LOW** |
| 9. `deleteAthleteRecord` docstring claims deletion it does not do | LOW | **CONFIRMED** | LOW (unchanged) |

Retracted: **0**. Downgraded: **4** (findings 3, 4, 5, 8).
Nothing was found to be fabricated. Every quoted string in the pass that I
re-extracted was character-exact at the cited line. What failed was reasoning
and reach, not honesty — detailed per finding, and in *What the pass missed*.

---

## Per-finding

### 1. Consent scope collected, presented as control, enforced by nothing — CONFIRMED WITH CORRECTION

**What I read.** `guardianConsent.ts` in full; `intake.ts` `upsertWaiver`
(480–521); `pilot_slice_postgres_guardian_media_consent_migration.sql`;
`app/api/pilot/parent/consent/route.ts`; `app/parent/consent/page.tsx`;
the waiver branch of `domain-upsert`; `pilot_slice_postgres.sql:409–424`;
an independent repo-wide grep of the four scope identifiers.

**My own quotes.**

The gate's only predicate, in the transactional variant:

> `  const missingParentIds = guardianIds.filter((id) => current.get(id)?.status !== 'signed');`
> — `apps/web/src/server/pilot/guardianConsent.ts:180`

and in the non-transactional one, which the finding does not quote:

> `  const missingParentIds = perGuardian.filter((g) => g.status !== 'signed').map((g) => g.parentId);`
> — `apps/web/src/server/pilot/guardianConsent.ts:126`

Both read `status` and nothing else. `covers_video` and `public_use_allowed`
are selected (`:73`, `:173`) and projected into the result (`:121–122`) and
never tested.

The three default sites, all three re-read at the cited lines and all three
character-exact:

> `  add column if not exists covers_video boolean not null default true;`
> — `infra/azure/pilot_slice_postgres_guardian_media_consent_migration.sql:55`

> `      const coversVideo = body?.covers_video !== false;`
> — `apps/web/app/api/pilot/parent/consent/route.ts:147`

> `      params.coversVideo ?? true,`
> — `apps/web/src/server/pilot/intake.ts:515`

**The sub-claim I was told to attack: "including on every non-media waiver row."**
It holds. The waiver branch of `domain-upsert` passes exactly eight named
fields and `covers_video` is not among them:

> `      entityId = await upsertWaiver({`
> `        organizationId: principal.organizationId,`
> `        athleteId,`
> `        waiverType: asString(body.payload.waiver_type, 'general'),`
> — `apps/web/app/api/pilot/intake/domain-upsert/route.ts:90-93`

and `upsertWaiver` at `intake.ts:499–518` is the only non-test `insert into
pilot.waivers` in `apps/`, `infra/`, `packages/` or `scripts/` (grep returns
one production hit and four test hits). So every `general`, `medical_release`
and `travel` row written by the front desk lands with `covers_video = true`.
Sub-claim **correct**.

**Strongest refutation I could build, and why it only half-landed.**
"Three independent places" is the wrong shape. The DDL default at
`migration:55` cannot be exercised by any production INSERT, because the sole
INSERT names the column explicitly in its column list
(`intake.ts:501`) and always supplies `$12`. As a *runtime* default it is dead.
But killing it does not help the finding's target: `add column ... not null
default true` **backfills every pre-existing `pilot.waivers` row to `true` at
migration time**, which is a larger blast radius than a live default, not a
smaller one. The refutation improves the mechanism and worsens the conclusion.

Second refutation: the module admits the cut in its own header —

> ` *   - Does not match consent scope (covers_video / public_use_allowed)`
> — `apps/web/src/server/pilot/guardianConsent.ts:34`

An admission is not a mitigation. The screen still renders two labelled
controls (`app/parent/consent/page.tsx:175` and `:182`, both re-read and exact)
that describe permissions the code cannot honour.

Third refutation: is there a destination-side check? `publications/library/route.ts:11`
is `requireRole(principal, ['coach', 'admin', 'organization_admin', 'athlete'])`
— signed-in only. Confirms the pass's point that "Allow public use (website,
social media)" names a channel that does not exist.

**Verdict.** CONFIRMED WITH CORRECTION — the correction is to the *mechanism* of
the third default (backfill, not runtime default), not to the conclusion.
Severity HIGH sustained: a guardian is shown a control that no code reads.

---

### 2. A coach can overwrite an existing guardian's account binding — CONFIRMED WITH CORRECTION

**What I read.** `domain-upsert/route.ts` in full; `intake.ts` `upsertGuardian`
711–731 and `linkGuardianAthlete` 733–748; `shadowAuthority.ts` 30–98;
`guardianAccess.ts` 55–90; a search of all 88 migrations for a trigger or
constraint on `pilot.parents`.

**My own quotes.**

> `     on conflict (organization_id, parent_id) do update set`
> `       account_id = excluded.account_id,`
> — `apps/web/src/server/pilot/intake.ts:723-724`

> `    [params.organizationId, params.parentId, params.accountId ?? null, params.fullName, params.phone ?? null, params.email ?? null],`
> — `apps/web/src/server/pilot/intake.ts:729`

and the read side it breaks:

> `     where gl.organization_id = $1 and p.account_id = $2`
> — `apps/web/src/server/pilot/guardianAccess.ts:70`

**Refutations attempted.**

(a) *Does `assertShadowAuthority` refuse?* No, and I verified the decision
function rather than taking the pass's word:

> `  return { allowed: true, reason: 'Authority check passed.' };`
> — `apps/web/src/server/pilot/shadowAuthority.ts:70`

is reached whenever `restrictionConflict` is false, `withinApprovedOptions` is
true and the tier is not `INSUFFICIENT`/`CONFLICTED` — all hardcoded at
`route.ts:53-56`. The forbidden-action list (`shadowAuthority.ts:34-43`) matches
on `clear`/`concussion`/`sparring`/`weight_cut`/`medical_decision`; the action
string is `intake.domain_upsert.guardian_link`, which matches none. Even
`automation_mode: 'automatic'` from the request body passes, because `lowRisk`
and `reversible` are both hardcoded true.

(b) *A trigger or tighter constraint on `pilot.parents`?* None. The only
deletion-related trigger in the schema is
`pilot_cascade_parent_deletion_trigger`
(`infra/azure/pilot_slice_postgres_data_retention_deletion_migration.sql:74-78`),
which fires `after update on pilot.accounts` and touches only `pilot.athletes`.

(c) *Role gate?* Real but weak, and **the finding never states it**:

> `    requireRole(principal, ['organization_admin', 'coach']);`
> — `apps/web/app/api/pilot/intake/domain-upsert/route.ts:31`

so this is not open to a parent, athlete, volunteer or staff account.

**Correction 1 — a mitigation the finding omits.** The act is not silent to an
auditor. `assertShadowAuthority` writes a `pilot.shadow_authority_checks` row on
**every** call including allowed ones (`shadowAuthority.ts:76-93`), and the
route writes a second audit event with `entityId = ${parentId}:${athleteId}`
(`route.ts:154`, `:159`). "Silently overwrite" is accurate about the *guardian's*
experience and inaccurate about the record: the write is durably attributable.

**Correction 2 — the finding understates it in the other direction.** It
develops only the denial case (`account_id` omitted → binding nulled). The
worse case is `account_id` **supplied**: a coach naming another family's
`parent_id` and their *own* `account_id` repoints that parent row at themselves,
and `resolveRelationship` then answers `guardian_of_subject` for every athlete
already linked to that `parent_id` —

> `      return linked ? 'guardian_of_subject' : 'none';`
> — `apps/web/src/server/pilot/profileDb.ts:269`

which is a member of `MINOR_CIRCLE`. That is privilege escalation into other
families' children through one request, not merely the removal of a parent's
lever. It is the same door as 2b, reached from the `pilot.parents` side.

**Verdict.** CONFIRMED WITH CORRECTION. HIGH sustained; if anything the
consequence section is the part that needs rewriting upward.

---

### 2b. Guardian links accept an unvalidated `parent_id` — CONFIRMED

**What I read.** `domain-upsert/route.ts:133-153` against `:62`;
`profileDb.ts` `resolveRelationship` 237–304; `profileVisibility.ts` 125–193.

**My own quotes.** The athlete side is gated:

> `    await assertActorCanAccessAthlete(principal, athleteId);`
> — `apps/web/app/api/pilot/intake/domain-upsert/route.ts:62`

The parent side is taken from the body with no ownership check beyond
non-emptiness:

> `      const parentId = asString(body.payload.parent_id);`
> `      if (!parentId) {`
> `        throw new Error('Missing parent_id for guardian link');`
> `      }`
> — `apps/web/app/api/pilot/intake/domain-upsert/route.ts:134-137`

and the circle it writes into:

> `export const MINOR_CIRCLE: readonly ProfileRelationship[] = [`
> `  'self',`
> `  'coach_of_subject',`
> `  'guardian_of_subject',`
> `];`
> — `apps/web/src/server/pilot/profileVisibility.ts:132-136`

**Refutation attempted.** I checked whether `decidePortrait` needs more than
membership in that set for a minor. It does not:

> `      if (!MINOR_CIRCLE.includes(relationship)) {`
> `        return { show: 'plate', reason: 'minor_outside_own_circle' };`
> `      }`
> — `apps/web/src/server/pilot/profileVisibility.ts:163-165`

Falling through that guard returns `{ show: 'photo' }` at `:166-171`, subject
only to `hasPhoto` and `photoReviewState === 'released'` (`:156-157`). So the
`MINOR_CIRCLE` consequence the pass adds is real and I could not narrow it.
Same audit-trail mitigation as finding 2 applies.

**Verdict.** CONFIRMED. HIGH sustained.

---

### 3. Film Study checks consent once, at enqueue — OVERSTATED (HIGH → MEDIUM)

This is the headline finding and it is the one that came apart most.

**What I read.** `shadow/video-analysis/route.ts` 85–125;
`shadowJobProcessor.ts` 100–260 and 860–955; `shadowJobQueue.ts` 300–520;
`shadowJobWorker.ts` in full (135 lines); `apps/web/instrumentation.ts` in full;
`.github/workflows/deploy-production.yml` and `deploy-staging.yml`;
`parent/consent/route.ts` 145–250; `publication.ts` 340–410;
`shadow/film-study/proposals/route.ts`; `pilot_slice_postgres.sql:990–1005`.

**What survives, verified independently.** The enqueue gate is exact:

> `    await assertGuardianMediaConsent(principal.organizationId, video.athlete_id);`
> — `apps/web/app/api/pilot/shadow/video-analysis/route.ts:106`

and the executor's blob read is exact:

> `    const videoBytes = await downloadPilotVideoFile(context.blobPath);`
> — `apps/web/src/server/pilot/shadowJobProcessor.ts:892`

My own grep of `guardianMediaConsent|guardianConsent|checkGuardianMediaConsent|photo_media`
across `shadowJobProcessor.ts`, `shadowJobQueue.ts`, `shadowJobWorker.ts`,
`app/api/pilot/shadow/jobs/` and `app/api/pilot/shadow/film-study/` returns
**zero hits**. There is no consent re-check in the job path, and no
database-level guard: `pilot.shadow_jobs` has no consent column and no trigger.

The withdrawal sweep really does cancel nothing. `cancelJobForActor` exists —

> `export async function cancelJobForActor(jobId: string, actor: ActorIdentity): Promise<boolean> {`
> — `apps/web/src/server/pilot/shadowJobQueue.ts:500`

— and its only caller is `app/api/pilot/shadow/jobs/route.ts:42`, a user-driven
DELETE. The withdrawal branch of `parent/consent/route.ts` (`:167-250`) calls
`withdrawMediaConsent`, `auditConsentEvent` and `suppressPublishedMediaForAthlete`
and nothing else. Confirmed.

**Correction 1 — "re-validates the role and nothing else" is false.**
The pass quotes `shadowJobProcessor.ts:875-878` (exact) and concludes that role
is the whole re-validation. It is not; it is the *executor's extra* assertion on
top of the processor's. The processor re-loads the actor from the live database
and re-runs the athlete boundary:

> `    const currentActor = await loadCurrentJobActor(job);`
> `    if (currentActor.role !== job.role) {`
> `      throw new Error('SHADOW_JOB_AUTHORIZATION_CHANGED');`
> `    }`
> `    if (job.subjectId) {`
> `      await assertActorCanAccessAthlete(currentActor, job.subjectId);`
> `    }`
> — `apps/web/src/server/pilot/shadowJobProcessor.ts:172-178`

and `loadCurrentJobActor` (`:103-143`) additionally requires `active_flag = true`,
an active organization membership, and a non-suspended organization, throwing
`SHADOW_JOB_AUTHORIZATION_REVOKED` otherwise. Guardian consent is genuinely not
among these — but "role and nothing else" understates the re-validation by four
checks and misattributes the layer.

**Correction 2 — the pass's own "Could not establish" is answerable from this
repository, and answering it collapses the consequence.** The pass records:
*"What drives the SHADOW job queue in production. No workflow under
`.github/workflows/` and no page or component under `apps/web` references
`shadow/jobs/process`."* That is true and irrelevant: the queue is not driven by
that route. It is driven in-process.

> `// shadowJobWorker.ts — the drain loop that makes the job queue real.`
> — `apps/web/src/server/pilot/shadowJobWorker.ts:1`

> `export const DEFAULT_WORKER_INTERVAL_SECONDS = 30;`
> — `apps/web/src/server/pilot/shadowJobWorker.ts:20`

> `  const { processNextShadowJob } = await import('./src/server/pilot/shadowJobProcessor');`
> — `apps/web/instrumentation.ts:31`

> `  const handle = startShadowJobWorker({`
> `    processOne: () => processNextShadowJob(),`
> — `apps/web/instrumentation.ts:38-39`

gated on

> `  return env.PPBF_SHADOW_WORKER_ENABLED === 'true';`
> — `apps/web/src/server/pilot/shadowJobWorker.ts:28`

and that flag is set in the production deployment:

> `              PPBF_SHADOW_WORKER_ENABLED=true \`
> — `.github/workflows/deploy-production.yml:437`

(identically at `deploy-staging.yml:278`). So the queue **is** drained, every 30
seconds by default (clamped 5–600s, `shadowJobWorker.ts:21-22`), up to five jobs
per tick (`:23`).

**Correction 3 — the window is bounded, and by two things.** The default cadence
above, and an absolute cap:

> `  expires_at timestamptz not null default now() + interval '24 hours',`
> — `infra/azure/pilot_slice_postgres.sql:1000`

with expired pending rows auto-cancelled at claim time
(`shadowJobQueue.ts:315-327`, `WHERE status = 'pending' AND expires_at <= NOW()`).
The pass's sentence *"The window between 'consent checked' and 'frames sent to
the vision model' is therefore not bounded by anything I can see in this
repository"* is wrong on the record in this repository, and its consequence
narrative — enqueued Tuesday afternoon, withdrawn Tuesday evening, job runs
after — requires a job that failed retryably across hours within
`max_retries integer not null default 3` (`pilot_slice_postgres.sql:995`).
The realistic exposure is a **race of roughly 30 seconds**, not a queue
sitting open for an afternoon.

**What still justifies a finding.** The race is real, it is live in production
(not theoretical), and the durable output outlives the withdrawal: the proposal
row is written by `createFilmStudyProposal` (`shadowJobProcessor.ts:919-927`) and
`shadow/film-study/proposals/route.ts` gates reads on
`requireRole(principal, [...PROPOSAL_REVIEWER_ROLES])` (`:38`) and
`assertActorCanAccessAthlete` (`:50`) — never on consent. So a coach can read an
AI observation about a child generated after that child's guardian withdrew.
The publish path closes exactly this race with `for share`
(`guardianConsent.ts:161-166`); the async path does not.

**Verdict.** OVERSTATED. Mechanism confirmed, two sub-claims false, the stated
consequence unsupported. Severity **MEDIUM**: a ~30-second race, on a path whose
only output is a `pending_review` proposal, is not the same class of exposure as
the finding's narrative.

---

### 4. 60-minute SAS URLs, in bulk, unaudited — OVERSTATED (HIGH → MEDIUM)

**What I read.** `blob.ts` 45–210; `video/[videoId]/route.ts` 40–72;
`admin/video-compliance/route.ts` 1–160 and its four audit call sites;
`video/review-link/route.ts` in full; `publication.ts` `getOrganizationPublications`
479–510; `next.config.ts` 25–35.

**My own quotes.** The expiry is minutes and the default is 60:

> `  const expiresOn = new Date(startsOn.getTime() + expiryMinutes * 60 * 1000);`
> — `apps/web/src/server/pilot/blob.ts:114`

> `export function getPilotVideoSasUrl(blobPath: string, expiryMinutes = 60): string {`
> — `apps/web/src/server/pilot/blob.ts:122`

Both mint sites are exact as quoted (`video/[videoId]/route.ts:62`,
`admin/video-compliance/route.ts:130-131`). The sibling's contrast is real:

> `const LINK_EXPIRY_MINUTES = 15;`
> — `apps/web/app/api/pilot/video/review-link/route.ts:32`

> `        action: 'video_review_link_issued',`
> — `apps/web/app/api/pilot/video/review-link/route.ts:56`

**"Unaudited" — verified independently and true.** In
`admin/video-compliance/route.ts` the four `auditComplianceEvent` calls are at
`:241`, `:261`, `:337` and `:354`, all inside `POST` (which begins at `:194`).
`GET` (begins `:72`) writes nothing. `video/[videoId]/route.ts` contains no
occurrence of `audit` at all.

**"In bulk" — concretely, up to 50 per request.** The queue list is
`getOrganizationPublications(principal.organizationId, { status: 'pending_review' })`
(`route.ts:78`) with no `limit`, and

> `  params.push(filters?.limit || 50);`
> — `apps/web/src/server/pilot/publication.ts:507`

so one GET mints at most fifty one-hour bearer URLs. Note that only the
`pending_review` items carry one — the draft/published/retracted summaries
deliberately do not (`route.ts:137-139`, `summarize`). "In bulk" is fair; it is
bounded at 50 and confined to one of four lists.

**Refutation that partly succeeded, and which the finding omits.**
Every SAS is handed to a caller already authorized to watch that exact footage.
The single-video route refuses non-`ready` sessions and re-runs the athlete
boundary before minting:

> `    if (row.athlete_id) {`
> `      try {`
> `        await assertActorCanAccessAthlete(principal, row.athlete_id);`
> — `apps/web/app/api/pilot/video/[videoId]/route.ts:50-52`

and the compliance queue is `requireRole(principal, ['admin', 'organization_admin'])`
(`route.ts:75`). So this is not an access-control hole — it is a bearer-lifetime
and non-repudiation defect on top of a correct gate. The finding's title, *"Minors'
video is handed out as 60-minute bearer URLs"*, reads as the former.

I could not rescue the other two branches: the URL is returned verbatim as
`stream_url` and `next.config.ts:29` (`media-src 'self' blob: https://*.blob.core.windows.net`,
exact) means the browser fetches storage directly; and a signed URL is not
revocable by `suppressPublishedMediaForAthlete`, which updates two tables.
The pass's own correction of the `blob.ts:138-141` comment is also right:
`downloadPilotVideoFile` (`blob.ts:58-74`) is a capped buffer read and does not
"refuse to mint" anything.

**Verdict.** OVERSTATED. Every factual element checks out; the severity does not.
**MEDIUM** — inconsistent bearer lifetime and a missing audit row on an
otherwise-correctly-gated route.

---

### 5. Hard-deleted athlete reclassifies an account to staff — OVERSTATED (HIGH → MEDIUM)

**What I read.** `pilot_slice_postgres.sql:25-43` and `:409-424`;
`pilot_slice_postgres_data_retention_deletion_migration.sql` in full (84 lines);
`pilot-cleanup-deleted-data.mjs` 40–145; `.github/workflows/retention-cleanup.yml`
1–160; `profileDb.ts` 150–340; `profileVisibility.ts` 110–223;
`profile/roster/route.ts` in full; `profile/card/route.ts` 30–70;
`dataDeletion.ts` in full.

**The chain, verified link by link with my own quotes.**

No foreign key:

> `  athlete_id text null,`
> — `infra/azure/pilot_slice_postgres.sql:32`

> `  unique (organization_id, athlete_id)`
> — `infra/azure/pilot_slice_postgres.sql:42`

The asymmetric purge:

> `    const athleteDelete = await client.query(`
> `      \`delete from pilot.athletes`
> `        where deleted_at is not null and deleted_at < (now() - ${ATHLETE_RETENTION})`
> — `apps/web/scripts/pilot-cleanup-deleted-data.mjs:130-132`

> `          and role = 'parent'`
> — `apps/web/scripts/pilot-cleanup-deleted-data.mjs:138`

The fall-through:

> `  return {`
> `    accountId: account.account_id,`
> `    fullName: staffDisplayName(account.login_email, account.account_id),`
> `    athleteId: null,`
> — `apps/web/src/server/pilot/profileDb.ts:197-200`

The boundary that stops running:

> `  if (subject.athleteId) {`
> `    await assertActorCanAccessAthlete(viewer, subject.athleteId);`
> `  }`
> — `apps/web/src/server/pilot/profileDb.ts:320-322`

and the staff branch it lands in:

> `  if (relationship === 'organization_staff') return { show: 'photo', reason: 'released_to_organization_staff' };`
> — `apps/web/src/server/pilot/profileVisibility.ts:188`

reached because `toProfileSubject` derives `isAthlete: identity.athleteId !== null`
(`profileDb.ts:331`). The reclassification is **real** and the portrait gate
**does** key off it. Both halves of the claim I was asked to attack survive.

**Refutations attempted, including one the pass did not run.**

(a) *The cascade trigger.* The pass never checked it. I did, because
`dataDeletion.ts:52` advertises one. It runs the wrong way:

> `create trigger pilot_cascade_parent_deletion_trigger`
> `  after update on pilot.accounts`
> — `infra/azure/pilot_slice_postgres_data_retention_deletion_migration.sql:74-75`

accounts → athletes, soft only. It cannot save this.

(b) *Anything nulling `accounts.athlete_id` on athlete deletion.* Grep of all
`set athlete_id` / `athlete_id = null` writes returns `staffProvisioning.ts:352`
and `auth.ts:990` (both role-reassignment paths) and `entities.ts:97`/`:151`
(both assignments). Nothing in any deletion path. Refutation failed.

**Correction — the consequence is materially narrower than "every coach and
every organization admin in the gym."** Every listing surface that could hand a
viewer the ghost account's id is driven **from `pilot.athletes`**, which is the
row that just disappeared:

> `         `select a.athlete_id, acc.account_id, a.full_name, a.dob, a.coach_id`
> `           from pilot.athletes a`
> `           left join pilot.accounts acc`
> — `apps/web/app/api/pilot/profile/roster/route.ts:53-55`

and `profile/card`'s `athlete_id` → `account_id` lookup needs a live account row
carrying that `athlete_id` (`route.ts:39-43`). After the purge the ghost account
appears in no roster, no card lookup by athlete id, and no waiver console
(`waiverCompliance.ts:48`, `from pilot.athletes a`). It is reachable only by
`GET /api/pilot/profile/photo/<accountId>` or `?account_id=` from someone who
already holds the account id — a bookmark, a cached page, an earlier response.
The face is not *published* to the gym; it becomes fetchable by anyone who kept
the handle.

**Reachability, re-verified.** The pass is right about the gate:

> `          PPBF_RETENTION_APPLY: ${{ inputs.apply == 'APPLY' }}`
> — `.github/workflows/retention-cleanup.yml:149`

and the workflow header states the scheduled run is a dry run
(`:27-33`), with `PPBF_RETENTION_MAX_ROWS` defaulting to 50 (`:150`).

**Verdict.** OVERSTATED. The mechanism is fully confirmed — I could not break
any link — but the finding's stated consequence is not what the code produces,
and reachability requires a deliberate destructive dispatch. **MEDIUM**.

---

### 6. Waiver console and media-consent gate disagree — CONFIRMED

**What I read.** `waiverCompliance.ts` in full; `guardianConsent.ts` 65–130;
`admin/waiver-status/page.tsx` around `:70`; `admin/waiver-status/route.ts`;
`admin/athlete-consent/route.ts`; `admin/consent/page.tsx` header.

**My own quotes.** The rollup, with neither a `parent_id` filter nor a
per-guardian grouping:

> `     left join lateral (`
> `       select distinct on (waiver_type) waiver_type, status`
> `       from pilot.waivers`
> — `apps/web/src/server/pilot/waiverCompliance.ts:49-51`

versus the gate:

> `     where organization_id = $1 and athlete_id = $2 and waiver_type = $3 and parent_id is not null`
> — `apps/web/src/server/pilot/guardianConsent.ts:75`

Divergence (c) is exact as quoted:

> `    return { ok: false, guardianIds: [], missingParentIds: [], perGuardian: [] };`
> — `apps/web/src/server/pilot/guardianConsent.ts:112`

The role mismatch is exact on both sides:

> `    <RoleSessionGate allowedRoles={['admin']}>`
> — `apps/web/app/admin/waiver-status/page.tsx:70`

> `    requireRole(principal, ['admin', 'organization_admin']);`
> — `apps/web/app/api/pilot/admin/waiver-status/route.ts:18`

**Refutation attempted.** The correct data does exist on another screen —
`admin/athlete-consent/route.ts:22` calls `listOrganizationConsentStatus` and
emits `per_guardian` at `:32`, under the same
`requireRole(principal, ['admin', 'organization_admin'])` (`:20`). The pass
already conceded this ("the refutation half-succeeded"), which is the honest
call: a misleading summary beside a correct detail screen is still a misleading
summary. I found nothing further.

**Verdict.** CONFIRMED. MEDIUM sustained.

---

### 7. `DATA_RETENTION.md` promises deletion no code performs — CONFIRMED WITH CORRECTION

**What I read.** `docs/DATA_RETENTION.md` rows 25–53 and sections at 88–221;
`pilot-cleanup-deleted-data.mjs` in full; `dataDeletion.ts` in full; `blob.ts`
in full; an exhaustive search for blob deletion across `apps/`, `infra/`,
`scripts/`, `packages/` including `.bicep`, `.tf`, `.yml` and `.json`.

**My own quotes.** The policy really does set the windows claimed:

> `| Athlete photos/videos | Until relationship ends + 2 years | ... |`
> — `docs/DATA_RETENTION.md:26`

> `| Session tokens | 30 days after expiration/revocation | ... |`
> — `docs/DATA_RETENTION.md:52`

against two constants:

> `const ATHLETE_RETENTION = "interval '2 years'";`
> `const ACCOUNT_RETENTION = "interval '1 year'";`
> — `apps/web/scripts/pilot-cleanup-deleted-data.mjs:47-48`

**"No blob byte is deleted" — searched hard before accepting.** I grepped
`deleteIfExists`, `deleteBlob`, `BlobBatch`, `lifecycle`, `managementPolicy` and
`.delete(` across all four trees and both `infra/main.bicep` and
`infra/modules/`. There are exactly two blob deleters in the platform:

> `export async function deletePilotProfilePhoto(blobPath: string): Promise<void> {`
> — `apps/web/src/server/pilot/blob.ts:200`

> `export async function deletePilotGymWallPhoto(organizationId: string, slotKey: string): Promise<void> {`
> — `apps/web/src/server/pilot/blob.ts:277`

**There is no video-blob deleter at any severity** — no function in `blob.ts` or
anywhere else removes a byte from the video container. No storage
lifecycle-management policy exists in `infra/`. So the absolute holds for videos
outright, and for portraits it holds for the *retention path* specifically,
which is what the pass actually claimed ("Nothing in the retention path, and
nothing in `dataDeletion.ts`, deletes a single stored byte"). That phrasing is
careful and correct; I could not break it.

**Correction.** The pass says the two deleters are "both called only from
portrait review/block." There are **three** callers of `deletePilotProfilePhoto`
— `admin/portrait-review/route.ts:103`, `profile/photo/review/route.ts:81`, and
`profile/photo/route.ts:146`, which is a member deleting their **own** photo.
The third is a self-serve path, not staff review. It does not change the
conclusion (none is a retention path), but the enumeration is wrong.

**Verdict.** CONFIRMED WITH CORRECTION. MEDIUM sustained.

---

### 8. A second, unguarded purge implementation with zero callers — CONFIRMED, downgraded to LOW

**My own quote and my own grep.**

> `export async function purgeExpiredDeletedData(): Promise<{ rowsDeleted: number }> {`
> — `apps/web/src/server/pilot/dataDeletion.ts:199`

`grep -rn "purgeExpiredDeletedData" apps scripts packages` returns exactly one
line: that definition. No route, job, worker tick or script imports it. Its
deletes (`:209-225`) carry the same two intervals and none of the `.mjs`
script's guards — `assertDeclaredWriteTargetFromEnv` (`.mjs:45`),
`PPBF_RETENTION_APPLY`, `PPBF_RETENTION_MAX_ROWS`.

**Argument down, which the finding half-makes and then does not follow.**
This is dead code with no reachable path, no runtime surface and no data at risk
today. The stated harm — "if this copy is ever wired up" — requires a future
developer to write a new import, which is a code-review event and not a property
of the current system. Two of the four missing guards
(`assertDeclaredWriteTargetFromEnv`, `PPBF_RETENTION_APPLY`) are *environment*
guards that a server-side module is not the natural place for in any case.
`AGENT_KERNEL.md`'s "prefer existing primitives over parallel sources of truth"
makes deletion the right action; it does not make the duplicate a MEDIUM-severity
safety defect.

**Verdict.** CONFIRMED (the facts) but severity **LOW**. It is a
delete-this-file item, not a risk register item.

---

### 9. `deleteAthleteRecord` docstring claims deletion it does not perform — CONFIRMED

> ` * Deletes an athlete record and marks all linked data (photos, videos, observations) for deletion.`
> — `apps/web/src/server/pilot/dataDeletion.ts:114`

> `      \`update pilot.athletes`
> `       set deleted_at = now(), updated_at = now()`
> — `apps/web/src/server/pilot/dataDeletion.ts:139-140`

> `    // Observations still on file for this athlete. NOT a deletion count: a soft`
> `    // delete leaves the athlete row in place, so the FK cascade does not fire`
> `    // and nothing here is removed.`
> — `apps/web/src/server/pilot/dataDeletion.ts:147-149`

All three exact at the cited lines; the docstring and the comment twenty-five
lines below it contradict each other in the same function.

**Refutation attempted.** I checked whether "marks for deletion" could be read
charitably as covering photos and videos through some marking column. It cannot:
`account_profiles` has no `deleted_at` written here, and the function issues one
UPDATE and two SELECTs. Refutation failed.

**Verdict.** CONFIRMED. LOW sustained.

---

## What the pass missed

**1. The gym-wall consent types DO have a writer, and the pass filed the
opposite under "Checked and found sound."** The pass states: *"A repo-wide grep
for those two strings returns 13 hits: the definition, and twelve test
assertions. **No writer exists.**"* The grep is right; the inference is wrong.
`waiver_type` has no database constraint —

> `  waiver_type text not null,`
> — `infra/azure/pilot_slice_postgres.sql:413`

— and `domain-upsert` writes it straight from the body with no allowlist:

> `        waiverType: asString(body.payload.waiver_type, 'general'),`
> — `apps/web/app/api/pilot/intake/domain-upsert/route.ts:93`

So a `coach` or `organization_admin` (`route.ts:31`) can POST
`{entity_type:'waiver', payload:{waiver_type:'wall_display_full_name',
signed_by_role:'guardian', status:'signed', signed_at:<now>}}` and satisfy
`WALL_DISPLAY_CONSENT_TYPES` (`wallDisplay.ts:74-79`) exactly. Worse, the
signer-role defence is self-declared text, so the module's own promise —

> ` * publication, and neither can the gym: 'admin', 'coach' and 'staff' are`
> ` * deliberately absent, so an administrator cannot promote a kid's name onto the`
> ` * wall by signing a form on their behalf.`
> — `apps/web/src/server/pilot/wallDisplay.ts:98-100`

— is not enforced against the one API that can write the row. The remaining
brake is the operator flag: `resolveDisplayVisibility` returns `initials`
immediately unless the mode is `consent` (`wallDisplay.ts:232-233`), and
`PPBF_WALL_DISPLAY_NAMES` is unset. That flag, not the absence of a writer, is
what currently keeps a minor's full name off an **unauthenticated** page. The
pass's stated reason for calling this sound is false, and the real reason is one
environment variable. This is the most consequential thing I found.

**2. The SHADOW job queue's driver is in the repository, and the pass shipped it
as unknowable.** `apps/web/src/server/pilot/shadowJobWorker.ts` (135 lines) is
listed in neither the "read in full" nor the "read in part" inventory, and
`apps/web/instrumentation.ts` is not either. Both were reachable from the
`shadowJobProcessor.ts` the pass did read: its own line 3 says *"Extracted from
the jobs/process route so the same processing path serves..."*, and
`processNextShadowJob`'s callers are two files away. Recording
*"It may be an Azure timer, an external scheduler, or nothing at all"* against
`deploy-production.yml:437` setting `PPBF_SHADOW_WORKER_ENABLED=true` is a
research gap, not a runtime-fact gap — and it is the single input that decides
finding 3's severity in both directions.

**3. `GET /api/pilot/profile/roster` does not filter `pilot.athletes.deleted_at`.**
The pass lists this route among the eleven it read in full and parks
`deleted_at` filtering under "Could not establish ... that belongs to pass 2 or
6." But this route is in scope and the miss is visible in the query it quotes
from: `route.ts:53-58` and `:62-67` select `a.full_name, a.dob` `from
pilot.athletes a where a.organization_id = $1` with no `deleted_at` predicate,
and then hardcodes `isAthlete: true` at `:90`. A withdrawn child — one whose
guardian asked for their record to be deleted and who is now waiting out a
two-year retention clock — remains on the live coach roster with their real
name, their date of birth, and (for their coach of record) their portrait, for
the entire window. The schema anticipates otherwise: the migration builds
`idx_athletes_active_org ... where deleted_at is null` and calls that "the
active-record path, which is every read"
(`pilot_slice_postgres_data_retention_deletion_migration.sql:25-28`).

**4. The escalation direction of finding 2.** Covered above under finding 2:
supplying `account_id` rather than omitting it turns the same request from a
denial-of-lever into a write into `MINOR_CIRCLE` over another family's children.
The pass develops only the null case.

**5. The mitigating audit trail on `domain-upsert`.** Findings 2 and 2b both
describe the write as silent. `assertShadowAuthority` writes a
`pilot.shadow_authority_checks` row on every call, allowed or refused
(`shadowAuthority.ts:76-93`), and the route writes a second audit event at
`:159`. It is silent to the affected guardian and fully attributable to an
auditor. That distinction belongs in a finding about a safeguarding write.

**6. Small enumeration errors worth fixing in place.** The pass cites
`guardianConsent.ts:180` as "the predicate that decides it"; `:180` is inside
`assertGuardianMediaConsentWithClient` and the primary path's predicate is `:126`
(same conclusion, different function). `deletePilotProfilePhoto` has three
callers, not two (finding 7). Neither changes an outcome.

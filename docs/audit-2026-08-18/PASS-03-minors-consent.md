# Pass 3 — Minors' data & consent

Pinned to `origin/main` at `04dd116b`, on branch `docs/full-spectrum-audit-2026-08-18`.
Read-only. No application code was modified; this file is the pass's only write.

Nothing found in this pass means a child is **currently** exposed — see the note
at the head of *Findings* for why the closest candidate is not filed as URGENT.

---

## Method

**Read in full** (not skimmed, not grepped): `AGENT_KERNEL.md`;
`docs/DATA_RETENTION.md` (226 lines); `apps/web/src/server/pilot/waiverCompliance.ts`
(80); `profileVisibility.ts` (223); `guardianConsent.ts` (324); `profileDb.ts` (564);
`videoScanReview.ts` (135); `shadowRoleSets.ts` (90); `apps/web/src/shared/gymPhotos.ts`
(first 213 of the module, including `gymPhotoSrc`); `privacyTiers.ts` (first 120);
`apps/web/scripts/pilot-cleanup-deleted-data.mjs` (179); `apps/web/next.config.ts` (72);
and eleven route files in full — `profile/photo/[accountId]`, `profile/photo/review`,
`profile/card`, `profile/roster`, `admin/portrait-review`, `parent/consent`,
`intake/domain-upsert`, `video/[videoId]`, `video/[videoId]/release`,
`video/review-link`, `gym-photos/[slot]`, `pilot/wall`. Plus
`apps/web/components/ProfilePortrait.tsx` (100) and `profileClient.ts` (114).

**Read in part, with the surrounding function opened before quoting**:
`intake.ts` (`upsertWaiver` 480–521, `upsertGuardian` 711–731, `linkGuardianAthlete`
733–748); `publication.ts` (`suppressPublishedMediaForAthlete` 357–397);
`shadowJobProcessor.ts` (`executeFilmStudyJob` 873–943); `wallDisplay.ts` (40–320);
`auth.ts` (`resolvePrincipal` 253–313); `http.ts` (24–103); `shadowAuthority.ts`
(1–98); `dataDeletion.ts` (95–260); `blob.ts` (1–210);
`app/parent/consent/page.tsx` (100–200); `app/admin/consent/page.tsx` (1–140);
`app/api/pilot/admin/video-compliance/route.ts` (100–145);
`app/api/pilot/shadow/video-analysis/route.ts` (95–120);
`infra/azure/pilot_slice_postgres.sql` (20–140, 380–450) and the
guardian-media-consent migration.

**Read from outside this branch**: `docs/capabilities/NETWORK_STATUS.md` — it is
**not present on this branch**. `find` across the working tree returns nothing;
the file exists only on `origin/docs/agent-handoff-briefs`, and that is the copy
I read (`git show origin/docs/agent-handoff-briefs:docs/capabilities/NETWORK_STATUS.md`).
`docs/audit-2026-08-18/README.md` cites it at a path that does not resolve here.
Also read `docs/PLATFORM_AUDIT_2026-08-17_FULL_SPECTRUM.md` from
`origin/claude/app-audit-ux-ui-report-78o4cm` (340 lines), grepped for
waiver/consent/photo/portrait/video/minor/guardian/retention and the 30 matching
lines read in full.

**Grepped only, not read in full**: every reader of `pilot.waivers` across
`apps/`, `infra/`, `packages/`, `scripts/` (79 hits); every call site of
`assertGuardianMediaConsent` / `checkGuardianMediaConsent` / `coversVideo` /
`covers_video` / `publicUseAllowed` / `public_use_allowed` (48 hits); every call
site of `getPilotVideoSasUrl` / `getPilotShadowSasUrl` (10); every render site of
`ProfilePortrait` / `portraitUrl` (17); every `delete from pilot.athletes` and
`delete from pilot.accounts` (4); every FK referencing `pilot.athletes` or
`pilot.accounts` in `infra/azure/*.sql`; `next/image` across the app (1 hit, and
it is the comment saying not to use it); `wall_display_first_name` /
`wall_display_full_name` across the whole repo (13 hits, all tests or the
definition).

**Read out of `node_modules` as evidence, not as source**:
`next/dist/server/image-optimizer.js` (`fetchInternalImage`) and
`next/dist/server/lib/mock-request.js` (`createRequestResponseMocks`), to settle
whether the Next image optimizer can serve a portrait. Next is pinned at 16.3.1.

**Not reached, deliberately or otherwise**: no code was executed and no test was
run — this pass is source reading only, so per the audit's own standard nothing
below is runtime proof. I did not read the 93 Postgres suites or the 281 unit
suites except where a test was the only writer of a value (`wall_display_*`).
I did not open `/coach/*` or `/athlete/*` screens beyond the three components
that render a portrait. I did not inspect the live Azure blob container ACLs,
the live CDN, or whether Defender malware scanning is enabled on the storage
account — all three are runtime facts this pass has no access to.

---

## The consent model as built

### What is collected

`pilot.waivers` is the single table. It is append-only — a new row supersedes the
last one for the same athlete and waiver type — and it carries a freeform
`waiver_type text` with no database constraint. Four types are tracked:

> `export const TRACKED_WAIVER_TYPES = ['general', 'medical_release', 'photo_media', 'travel'] as const;`
> — `apps/web/src/server/pilot/waiverCompliance.ts:20`

Three writers exist. `POST /api/pilot/intake/domain-upsert` with
`entity_type: 'waiver'` (the admin consent desk at `/admin/consent`), and the two
guardian-facing helpers `grantMediaConsent` / `withdrawMediaConsent` behind
`POST /api/pilot/parent/consent`. A 2026-08 migration added three columns to the
table for the guardian path:

> `  add column if not exists covers_video boolean not null default true;`
> — `infra/azure/pilot_slice_postgres_guardian_media_consent_migration.sql:55`

### What is enforced

Exactly one waiver type is consulted by any gate. `photo_media`, through
`guardianConsent.ts`, at three call sites: video-publication approval
(`admin/video-compliance/route.ts:304,325`), publish-to-library
(`publications/publish/route.ts:98,108`), and Film Study analysis
(`shadow/video-analysis/route.ts:106`). The rule is "every linked guardian must
have a current row with `status = 'signed'`", and the predicate that decides it
is one line:

> `  const missingParentIds = guardianIds.filter((id) => current.get(id)?.status !== 'signed');`
> — `apps/web/src/server/pilot/guardianConsent.ts:180`

`general`, `medical_release` and `travel` are consulted by **nothing**. The only
reader of those three is the org-wide rollup `getOrganizationWaiverStatus`, which
is a pure `select` feeding one admin screen, and `/admin/consent`'s own
per-athlete list. Neither blocks anything. The consent desk says so itself, and
the honesty is worth quoting because it is the accurate description of the
system:

> ` * It also does not gate anything. Nothing here blocks training, and no code`
> ` * reads these rows to decide whether an athlete may participate.`
> — `apps/web/app/admin/consent/page.tsx:31-32`

So: a child with `medical_release: missing` is not stopped from anything by the
waiver system. Medical clearance is enforced somewhere else entirely (the
medical-status / training-holds path, pass 4's scope), and the four-type waiver
register is a paper-tracking record, not a gate.

### The gap between the two

Three things sit in the gap.

**One.** `photo_media` is the only enforced type, and the enforcing query only
sees rows that name a guardian:

> `     where organization_id = $1 and athlete_id = $2 and waiver_type = $3 and parent_id is not null`
> — `apps/web/src/server/pilot/guardianConsent.ts:75` (and again at `:175`)

The admin consent desk never sets `parent_id` — the waiver branch of
`domain-upsert` passes seven fields and `parent_id` is not among them
(`apps/web/app/api/pilot/intake/domain-upsert/route.ts:90-100`). So a
"Photo and media / signed by Parent or legal guardian" recorded at the front desk
is invisible to the gate that decides whether a video of that child may be
published. It fails **closed**, which is the right direction, but it means the
two screens disagree about the same child (see Finding 6).

**Two.** The scope switches. `covers_video` and `public_use_allowed` are written,
stored, echoed back to two read APIs, rendered to the guardian — and read by no
conditional anywhere in the codebase. The module says so in its own header:

> ` *   - Does not match consent scope (covers_video / public_use_allowed)`
> ` *     against a specific publication's media type or visibility. Recorded,`
> ` *     not yet enforced -- a documented MVP cut, not an oversight.`
> — `apps/web/src/server/pilot/guardianConsent.ts:34-36`

**Three.** A fourth vocabulary exists that neither the tracker nor the admin form
knows about. The gym-wall name gate is satisfied only by two waiver types:

> ` wall_display_first_name: 'first_name',`
> ` wall_display_full_name: 'full_name',`
> — `apps/web/src/server/pilot/wallDisplay.ts:77-78`

A repo-wide grep for those two strings returns 13 hits: the definition, and
twelve test assertions. **No writer exists.** The module states this is intended
and correct, and it is — the gate is unsatisfiable, so the wall shows initials —
but it means `TRACKED_WAIVER_TYPES`'s own claim to "mirror the exact vocabulary"
covers only part of the vocabulary the code actually consults.

---

## Exposure surfaces

Every path by which a minor's name, face, medical state or message can be
rendered, and the check each depends on. `privacyTiers.ts:103-110` names the
strictest tier `minor_circle` and points at the module that enforces it; this
table is that claim tested against the routes.

| Surface | What it renders | Check it relies on |
|---|---|---|
| `GET /api/pilot/profile/photo/[accountId]` | the portrait bytes | `requirePrincipal` → `assertViewerMayReachSubject` (→ `assertActorCanAccessAthlete`) → `resolveRelationship` → `decidePortrait`; `MINOR_CIRCLE` = self / coach-of-record / linked guardian |
| `GET /api/pilot/profile/card` | ring name, corner, coach, `photoAvailable` | same four, plus `relationship === 'none'` → 404 (`route.ts:61`) |
| `GET /api/pilot/profile/roster` | roster rows with `photo_available`, `ring_name` | `requireRole(['coach','organization_admin','admin'])`, then `decidePortrait` **per row** with relationship derived without a query (`route.ts:82-86`) |
| `ProfilePortrait` in `ParentHub`, `FightCard`, `CoachWorkspace` | `<img src=portraitUrl(...)>` | client-side only; the server 404s. `photoAvailable: false` renders the plate without ever requesting the route |
| `/admin/portrait-review` (page) | pending-portrait queue: name, athlete id, upload time — **no image** | `requireRole(['organization_admin','admin'])`. The admin approves a photograph they are structurally forbidden to see (known, #461) |
| `POST /api/pilot/profile/photo/review` | release/block one portrait | `isOrganizationAdminRole \|\| coach_of_subject \|\| self` (`route.ts:70-73`) |
| `GET /api/pilot/wall` (**unauthenticated**) | floor board, athlete names | `resolveWallNameMode` (default `initials`) → `resolveDisplayVisibility`; no `athlete_id` in the payload; IP-budgeted |
| `GET /api/pilot/gym-photos/[slot]` | building photographs | `requirePrincipal`; org from the principal only. By construction never touches `account_profiles` |
| `GET /api/pilot/video/[videoId]` | title, notes, **60-minute SAS stream URL** | `status !== 'ready'` → 404; `assertActorCanAccessAthlete`; unattributed video restricted to coach/admin |
| `POST /api/pilot/video/review-link` | **15-minute SAS**, audited | `VIDEO_REVIEW_VIEW_ROLES`, `authorizeVideoScanReview` (uploader-or-admin; `infected` refused) |
| `GET /api/pilot/admin/video-compliance` | queue of pending publications with athlete name **and a 60-minute SAS per row** | `requireRole` admin; **no audit row for the link issue** |
| `POST /api/pilot/publications/publish` | puts footage on the library shelf | `assertGuardianMediaConsent` + `assertGuardianMediaConsentWithClient` inside the claim transaction |
| `POST /api/pilot/shadow/video-analysis` | sends frames of the child to a vision model | `assertGuardianMediaConsent` **at enqueue only** |
| `GET /api/pilot/parent/safety` | child's training-hold state, athlete-facing projection | `requireRole(['parent'])` + `guardianAthleteIds` (viewer-scoped) |
| `GET /api/pilot/parent/messages` | messages about the child | same |
| `GET /api/pilot/parent/consent` | per-guardian consent rows incl. scope flags | same, plus `callerParentIdSet` membership per row |
| `GET/POST /api/pilot/shadow/medical-status` | clinical/administrative medical state | `SHADOW_PHI_ROLES` = coach / organization_admin / admin; `platform_owner` deliberately absent |
| `GET /api/pilot/admin/waiver-status` | roster × four waiver types, by child name | `requireRole(['admin','organization_admin'])` |
| `/admin/consent` | one child's full waiver history | `domain-get`, role-gated admin/coach |

Two relationships are the load-bearing ones and both are computed in a single
function, `resolveRelationship` (`profileDb.ts:237-304`). `coach_of_subject`
comes from `pilot.athletes.coach_id`; `guardian_of_subject` comes from a join
through `pilot.guardian_links` → `pilot.parents.account_id`. **Anything that can
write `pilot.parents.account_id` can put an account inside `MINOR_CIRCLE`** —
which is what makes Findings 2 and 2b matter more than their surface area
suggests.

---

## Findings

Ordered by severity. **No `## URGENT` section** — the finding closest to
"a child is exposed right now" is the guardian-link write (Finding 2b), and it is
already recorded as HIGH and escalated for owner decision by both prior audits;
it requires a deliberate act by a coach, so it is a standing risk rather than a
live exposure. I flag it here with the new consequence neither prior audit drew,
rather than re-raising it as a new emergency.

---

### [HIGH] Guardian consent scope is collected, presented to the guardian as control, and enforced by nothing — and `covers_video` defaults to `true` on every waiver row in the platform

**Previously recorded** by the capability-network audit ("Guardian consent scope
is collected and never enforced … `covers_video` defaults to `true`"). I was
asked to verify it independently rather than take it on faith. It is **confirmed
and worse than recorded**, in two respects.

*What is wrong.* The two switches a guardian sets are stored and never read by
any conditional. Grepping `covers_video`/`coversVideo`/`public_use_allowed`/
`publicUseAllowed` across `apps/`, `infra/`, `packages/`, `scripts/` returns 48
non-test hits: column definitions, `select` lists, insert parameters, TypeScript
field declarations, and two API responses that echo them to a screen. **Not one
`if`, `filter`, `&&`, or `where` clause anywhere tests either value.** The only
predicate in the enforcement path is status:

> `  const missingParentIds = guardianIds.filter((id) => current.get(id)?.status !== 'signed');`
> — `apps/web/src/server/pilot/guardianConsent.ts:180`

Meanwhile the guardian is shown two labelled controls that describe specific,
different permissions:

> `                          Include video (unchecked = photos only)`
> — `apps/web/app/parent/consent/page.tsx:175`

> `                          Allow public use (website, social media) &mdash; unchecked means internal/gym use only`
> — `apps/web/app/parent/consent/page.tsx:182`

A guardian who unchecks "Include video" is told they consented to photos only.
The publish gate that runs next reads `status`, sees `signed`, and lets the video
through.

*The default is worse than recorded.* `covers_video` defaults to true in **three**
independent places, and the third is the one nobody has written down:

> `  add column if not exists covers_video boolean not null default true;`
> — `infra/azure/pilot_slice_postgres_guardian_media_consent_migration.sql:55`

> `      const coversVideo = body?.covers_video !== false;`
> — `apps/web/app/api/pilot/parent/consent/route.ts:147`

> `      params.coversVideo ?? true,`
> — `apps/web/src/server/pilot/intake.ts:515`

That last one is inside `upsertWaiver`, which is the **single write path for every
waiver type**. `domain-upsert` never passes `coversVideo`, so every `general`,
`medical_release` and `travel` row an admin records at the front desk is stored
with `covers_video = true` — a video release flag set on rows that have nothing to
do with media, by a form that never asked. Nothing sets it false except
`withdrawMediaConsent` (`guardianConsent.ts:225`). If a future gate is wired to
read this column — which is exactly the stated plan — it will read `true` on
historical rows where no guardian ever agreed to video, and it will read it
platform-wide.

*Refutation attempted.* I looked for enforcement one layer up in all three
consumers of the consent check. `publications/publish/route.ts:98-108` and
`admin/video-compliance/route.ts:304-325` call `assertGuardianMediaConsent` and
then re-run it inside the transaction — both paths test only `status`.
`shadow/video-analysis/route.ts:106` is the same call. I then checked whether
`public_use_allowed` might be enforced by the *destination* rather than the gate:
`publications/library/route.ts:11` requires
`['coach','admin','organization_admin','athlete']`, so the "research library" is
signed-in-only and there is no public distribution surface at all. That does not
rescue the switch — it makes it worse, because "Allow public use (website, social
media)" names a channel the platform does not have. The refutation failed on
every branch.

*Consequence for a real child.* A guardian who consents to photographs only, and
believes they have withheld video, has their child's training footage approved
for the library on the same `signed` row. There is no code path by which their
narrower choice reaches the decision. This is a change that alters what a
guardian is allowed to control, so per the repository's own guardrails it is an
owner decision, not an autonomous fix. The **cheap** half is separable and is not
an owner decision: the UI is currently making a representation the code does not
honour, and disclosing that on the screen costs nothing.

---

### [HIGH] Film Study checks guardian consent once, at enqueue, and never again — a withdrawal does not stop an analysis already in the queue

*What is wrong.* `POST /api/pilot/shadow/video-analysis` gates correctly at the
door, with a comment explaining exactly why:

> `    await assertGuardianMediaConsent(principal.organizationId, video.athlete_id);`
> — `apps/web/app/api/pilot/shadow/video-analysis/route.ts:106`

It then enqueues a background job carrying the blob path. When the job runs, the
executor re-validates the **role** and nothing else:

> `  const trust = requireAsyncTrustContext(payload);`
> `  if (!['coach', 'organization_admin', 'admin'].includes(trust.role)) {`
> `    throw new Error('SHADOW_JOB_SCOPE_FORBIDDEN');`
> `  }`
> — `apps/web/src/server/pilot/shadowJobProcessor.ts:875-878`

and then reads the child's video straight out of blob storage by the path stored
in the payload:

> `    const videoBytes = await downloadPilotVideoFile(context.blobPath);`
> — `apps/web/src/server/pilot/shadowJobProcessor.ts:892`

Grepping `GuardianConsent|guardianConsent|assertGuardianMediaConsent` across
`shadowJobProcessor.ts`, `shadowJobQueue.ts`, `app/api/pilot/shadow/jobs/process/`
and `app/api/pilot/shadow/film-study/` returns **zero hits**.

*What the withdrawal actually does.* The guardian's withdrawal sweep is
thorough about publications and touches nothing else:

> `      `update pilot.video_publications`
> `       set status = 'retracted',`
> — `apps/web/src/server/pilot/publication.ts:372-373`

It retracts `video_publications` and suppresses `research_library` rows. It does
not cancel queued jobs and does not touch `shadow_film_study_proposals`.

*Refutation attempted.* This is precisely the race the codebase already found and
fixed once, for the publish path — `guardianConsent.ts:138-148` records it as a
"Round-8 review finding" and answers it with `assertGuardianMediaConsentWithClient`
plus a `for share` lock so the re-check is serialised against the withdrawal.
I therefore looked hard for the equivalent on the async path: in the job claim,
in `jobs/process`, in the executor, and in the proposal-creation helper. There is
none. I also checked whether the gap might be milliseconds in practice — it is
not: no workflow under `.github/workflows/` references `shadow/jobs/process`, and
no component or page in `apps/web` calls it either, so I could not establish
*anything* that drives the queue (recorded below under Could not establish). The
window between "consent checked" and "frames sent to the vision model" is
therefore not bounded by anything I can see in this repository.

*Consequence for a real child.* A guardian withdraws consent on Tuesday evening.
The platform tells them, truthfully, that published media has been retracted. A
Film Study job enqueued Tuesday afternoon then runs, downloads the video, extracts
frames of their child, sends those frames to an external vision service, and
writes a durable observation about the child into
`pilot.shadow_film_study_proposals` — all after the withdrawal committed. The
frames are deleted afterwards (`#103`, verified — the temp directory is removed
in a `finally`), but they left the building first.

---

### [HIGH] Minors' video is handed out as 60-minute bearer URLs, in bulk, with no audit — contradicting the platform's own written stance and its sibling route's

*What is wrong.* Two routes mint a one-hour SAS URL against the video container
for footage of a named minor:

> `    const sasUrl = getPilotVideoSasUrl(row.blob_path, 60);`
> — `apps/web/app/api/pilot/video/[videoId]/route.ts:62`

> `          stream_url: videoSession && videoSession.status === 'ready'`
> `            ? getPilotVideoSasUrl(videoSession.blob_path, 60)`
> — `apps/web/app/api/pilot/admin/video-compliance/route.ts:130-131`

The second is inside a **list** handler: one GET of the compliance queue mints one
bearer URL per pending publication, each valid for an hour. `expiryMinutes` is
minutes (`blob.ts:114`: `startsOn.getTime() + expiryMinutes * 60 * 1000`). Neither
route writes an audit event for the link.

The platform's own doctrine on this is written down twice, in the negative, and
both statements are about exactly this container:

> ` * child's face: a SAS URL is a bearer capability with no idea who is holding`
> ` * it, it survives being pasted into a chat window, and it outlives the session`
> ` * that minted it. downloadPilotVideoFile already refuses to mint one for a`
> ` * minor's footage for exactly this reason; portraits take the same stance.`
> — `apps/web/src/server/pilot/blob.ts:138-141`

And the sibling review route holds itself to a far tighter standard for the *same*
container and the *same* children:

> `// Same 15-minute expiry and same audit posture as document-link: these are`
> `// unscanned or screen-refused videos of youth athletes, and who watched what`
> `// has to be answerable afterwards.`
> — `apps/web/app/api/pilot/video/review-link/route.ts:11-13`

Fifteen minutes and an audit row for a quarantined clip; sixty minutes and silence
for a cleared one, issued in batches.

*Refutation attempted.* First, I checked whether the `blob.ts` claim is simply
true and I had misread it — `downloadPilotVideoFile` (`blob.ts:58-74`) is a
server-side buffer read used by the scanner and the Film Study executor. It does
not "refuse to mint" anything; it is a different function that happens not to mint.
The stance the comment asserts is real for the *portrait* container (nothing mints
against it — verified: `getPilotProfileContainerName` appears in no SAS call site)
and is **not** held for the video container. Second, I checked whether a shorter
expiry is applied upstream or whether the URL is proxied rather than returned to
the browser: it is returned verbatim as `stream_url` in the JSON body, and
`next.config.ts:29` explicitly allows `media-src ... https://*.blob.core.windows.net`
so the browser fetches storage directly. Third, I checked whether withdrawal
invalidates an issued SAS: `suppressPublishedMediaForAthlete` updates two tables
and cannot revoke a signed URL — a SAS is only revocable by rotating the account
key. The refutation failed.

*Consequence for a real child.* A URL to a minor's training video, valid for an
hour, requiring no session, is present in the browser history, the JSON response,
any request log, any proxy in front of the app, and anywhere it gets pasted. If a
guardian withdraws consent during that hour, the retraction sweep runs and the URL
keeps working until it expires on its own. The 60-minute figure was inherited from
a default (`blob.ts:122`) rather than chosen for this use.

---

### [HIGH] A hard-deleted athlete record silently re-classifies a still-existing account from "minor athlete" to "staff", releasing the portrait and ring name to every coach and admin in the gym

*What is wrong.* `pilot.accounts.athlete_id` has no foreign key to
`pilot.athletes`:

> `  athlete_id text null,`
> — `infra/azure/pilot_slice_postgres.sql:32`

(the table's only constraints on it are `unique (organization_id, athlete_id)`;
there is no `references pilot.athletes`). The retention purge deletes athlete rows
and, separately, *only parent* accounts:

> `      `delete from pilot.athletes`
> `        where deleted_at is not null and deleted_at < (now() - ${ATHLETE_RETENTION})`
> — `apps/web/scripts/pilot-cleanup-deleted-data.mjs:131-132`

> `      `delete from pilot.accounts`
> `        where deleted_at is not null and deleted_at < (now() - ${ACCOUNT_RETENTION})`
> `          and role = 'parent'`
> — `apps/web/scripts/pilot-cleanup-deleted-data.mjs:136-138`

So after a purge the child's **account row survives** with an `athlete_id` pointing
at a row that no longer exists. `getSubjectIdentity` then takes its fall-through
branch:

> `  return {`
> `    accountId: account.account_id,`
> `    fullName: staffDisplayName(account.login_email, account.account_id),`
> `    athleteId: null,`
> `    dob: null,`
> — `apps/web/src/server/pilot/profileDb.ts:197-201`

`athleteId: null` propagates through `toProfileSubject` as `isAthlete: false`, and
two gates change answer at once. The existing-boundary check stops running
entirely:

> `  if (subject.athleteId) {`
> `    await assertActorCanAccessAthlete(viewer, subject.athleteId);`
> `  }`
> — `apps/web/src/server/pilot/profileDb.ts:320-322`

and `decidePortrait` skips the minor branch and lands in the staff branch:

> `  if (relationship === 'organization_staff') return { show: 'photo', reason: 'released_to_organization_staff' };`
> — `apps/web/src/server/pilot/profileVisibility.ts:188`

`resolveRelationship` returns `organization_staff` for any admin, coach or staff
account (`profileDb.ts:300-302`). `decideRingName` follows the same shape:
`return relationship === 'none' ? null : subject.nickname;`
(`profileVisibility.ts:222`).

*Refutation attempted.* Four ways this could already be prevented, all checked.
(a) A cascade — no: the FK does not exist, and `account_profiles.account_id`
cascades from `accounts`, not from `athletes`, so the portrait row and its
`photo_review_state = 'released'` survive intact. (b) The account being
deactivated at purge — no: nothing in the purge touches `active_flag`, and the
`role = 'parent'` filter is explicit about which accounts it does and does not
remove. (c) Soft delete having the same effect — no, and this is the reassuring
half: `getSubjectIdentity`'s athlete query has no `deleted_at` filter
(`profileDb.ts:180-183`), so a *withdrawn* athlete still resolves as an athlete
and stays inside `MINOR_CIRCLE`. Only a **hard** delete flips it. (d) The purge
being unreachable — partly: `.github/workflows/retention-cleanup.yml:149` shows
scheduled runs are dry-run and applying requires a human to dispatch and type
`APPLY`, and the second implementation (Finding 8) has no callers. So this needs
the destructive job to have been run in apply mode at least once.

*Consequence for a real child.* Retention purges an athlete two years after
withdrawal — a child who left at twelve is fourteen. From the moment the purge
commits, their released portrait and their ring name are served to every coach
and every organization admin in the gym, including the ones `profileVisibility.ts`
went out of its way to exclude:

> ` * Everyone else -- including the organization's own administrators, including`
> ` * the board, including the platform owner -- gets the brass plate.`
> — `apps/web/src/server/pilot/profileVisibility.ts:23-24`

Nobody makes a decision to widen it; a row disappearing does it silently.

---

### [HIGH] A coach can silently overwrite an existing guardian's account binding, severing a real parent from their own child's consent controls

*Related to but distinct from* the known `parent_id` finding (see 2b below). This
is the **write to `pilot.parents`**, not the link.

*What is wrong.* `domain-upsert`'s `guardian_link` branch takes both the parent id
and an arbitrary account id from the request body:

> `      const parentId = asString(body.payload.parent_id);`
> — `apps/web/app/api/pilot/intake/domain-upsert/route.ts:134`

> `        accountId: typeof body.payload.account_id === 'string' ? body.payload.account_id : undefined,`
> — `apps/web/app/api/pilot/intake/domain-upsert/route.ts:142`

and `upsertGuardian` writes them with a conflict clause that **overwrites the
existing row**:

> `     on conflict (organization_id, parent_id) do update set`
> `       account_id = excluded.account_id,`
> `       full_name = excluded.full_name,`
> `       phone = excluded.phone,`
> `       email = excluded.email,`
> — `apps/web/src/server/pilot/intake.ts:723-727`

When `account_id` is omitted the parameter is `params.accountId ?? null`
(`intake.ts:729`) — so a request that names an existing `parent_id` and leaves
`account_id` out **nulls the binding**. Every guardian-scoped read joins on that
exact column:

> `     where gl.organization_id = $1 and p.account_id = $2`
> — `apps/web/src/server/pilot/guardianAccess.ts:70` (`guardianAthleteIds`)

*Refutation attempted.* The route does gate the athlete side —
`assertActorCanAccessAthlete(principal, athleteId)` at `domain-upsert/route.ts:62`
— but `upsertGuardian` is keyed on `(organization_id, parent_id)` and is not
athlete-scoped at all, so that check does not reach it. I then checked
`assertShadowAuthority`, which runs first (`route.ts:47-60`) and looked like it
might refuse: `decideShadowAuthority` (`shadowAuthority.ts:45-71`) refuses only
`automatic` mode on clearance-shaped action names, a declared restriction
conflict, out-of-approved-options, or an `INSUFFICIENT`/`CONFLICTED` confidence
tier. The route hardcodes `lowRisk: true, reversible: true,
withinApprovedOptions: true, restrictionConflict: false` and defaults the mode to
`'assisted'`, so the decision is `{ allowed: true }` on every call. Nothing
upstream refuses. I also checked whether `pilot.parents` has a trigger or a
tighter constraint in any of the 88 migrations — it does not.

*Consequence for a real child.* A coach with legitimate standing on one athlete
issues one `domain-upsert` naming another family's `parent_id`. That guardian's
account binding is nulled. From that instant: `/parent/safety`,
`/parent/messages` and `/parent/consent` all return nothing for their own child,
and — the part that matters here — `resolveActingParent` returns null, so the
**guardian can no longer withdraw media consent**. Their existing `signed`
`photo_media` row remains the current row, so the publish gate keeps saying yes.
A parent who wants their child's video taken down has no lever, and the screen
does not tell them why. The guardian's name, phone and email are overwritten in
the same statement, so the gym's own emergency-contact path for that family is
also silently wrong.

Fixing this narrows what a coach may do, so per this repository's guardrails it is
an owner decision. It is the same gate as 2b and should be decided together.

---

### [HIGH — already recorded, restated with a new consequence] Guardian links accept an unvalidated `parent_id`, which is a door into `MINOR_CIRCLE`

Recorded by the capability-network audit as HIGH and by
`PLATFORM_AUDIT_2026-08-17_FULL_SPECTRUM.md` §13, in both cases as "reported, not
patched — needs an owner decision". **Verified still present** on `04dd116b` at
`apps/web/app/api/pilot/intake/domain-upsert/route.ts:133-153`: the athlete side
is checked at `:62`, the parent side is not checked at all.

The consequence neither prior audit drew, and the reason it belongs in this pass:
`resolveRelationship` derives `guardian_of_subject` from
`pilot.guardian_links` → `pilot.parents.account_id`
(`profileDb.ts:257-269`), and `guardian_of_subject` is one of the three members of
the circle a minor's face never leaves:

> `export const MINOR_CIRCLE: readonly ProfileRelationship[] = [`
> `  'self',`
> `  'coach_of_subject',`
> `  'guardian_of_subject',`
> `];`
> — `apps/web/src/server/pilot/profileVisibility.ts:132-136`

So an unvalidated guardian-link write is not only a read of training holds and
messages, as previously reported — it is a **write into the one relationship set
that grants a minor's photograph and ring name**. An arbitrary `parent`-role
account in the organization, attached to a child by a coach with standing on a
different child, becomes someone `decidePortrait` shows that child's face to.
Cited, not re-filed; the escalation already exists.

---

### [MEDIUM] The waiver-status console and the media-consent gate disagree about the same child, in the direction that makes an admin over-confident

*What is wrong.* Two screens read `pilot.waivers` for `photo_media` with different
queries. The compliance rollup takes the latest row per waiver type, across all
guardians and regardless of `parent_id`:

> `       select distinct on (waiver_type) waiver_type, status`
> `       from pilot.waivers`
> — `apps/web/src/server/pilot/waiverCompliance.ts:50-51`

The gate takes the latest row **per guardian**, and only rows that name one:

> `    `select distinct on (parent_id) parent_id, status, covers_video, public_use_allowed, created_at`
> `     from pilot.waivers`
> `     where organization_id = $1 and athlete_id = $2 and waiver_type = $3 and parent_id is not null`
> — `apps/web/src/server/pilot/guardianConsent.ts:73-75`

Three divergences follow. (a) A `photo_media` row recorded at the front desk has
`parent_id = null` and is invisible to the gate, so `/admin/waiver-status` shows
**signed** while publication is refused. (b) For a child with two guardians where
one has withdrawn, the rollup shows whichever row is newest — so **signed** while
the gate correctly refuses. (c) A child with zero `guardian_links` rows reads
`missing` in the rollup and, in the gate, produces
`{ ok: false, guardianIds: [], missingParentIds: [] }` (`guardianConsent.ts:112`)
— a distinct "unverifiable" state the rollup cannot express.

*Refutation attempted.* I checked whether the rollup screen carries a caveat that
would make this a labelling matter rather than a defect: `/admin/waiver-status`
renders a four-column signed/declined/withdrawn/missing grid and no caveat about
per-guardian scope. I checked whether a separate screen closes the gap:
`/api/pilot/admin/athlete-consent` does return the full per-guardian breakdown —
so the correct information **exists**, on a different screen, and the rollup is
the one an admin uses to answer "who is missing a photo release across the
roster". The refutation half-succeeded: the data is reachable, the summary is
still misleading.

*Consequence for a real child.* An admin runs the compliance roster before a
tournament, sees `photo_media: signed` for a child, and lets a photographer work.
Both divergences (a) and (b) point the same way — the roster over-reports consent
relative to the gate that actually decides. The gate itself is right, so nothing
is published; but the human standing in the gym has been told the wrong thing.

*Separately and minor:* the `/admin/waiver-status` **page** gates on
`allowedRoles={['admin']}` (`apps/web/app/admin/waiver-status/page.tsx:70`) while
its API allows `['admin', 'organization_admin']`
(`.../api/pilot/admin/waiver-status/route.ts:18`). An `organization_admin` — the
modern role — cannot open the screen. Fails closed; a one-word fix.

---

### [MEDIUM] `docs/DATA_RETENTION.md` promises category-by-category deletion of a child's photographs, videos, medical records and waivers; the implementation deletes two tables and no stored bytes

*Previously recorded in part.* The full-spectrum audit §5 already reported that
the doc names a script that does not exist and describes automatic deletion that
is really a dry run. **Not previously reported: the scope.**

*What is wrong.* The policy sets five distinct athlete windows and four guardian
windows — photos/videos 2 years, medical 3 years, waivers 3 years, parent messages
1 year, session tokens 30 days, audit logs 7 years. The implementation has
exactly two constants:

> `const ATHLETE_RETENTION = "interval '2 years'";`
> `const ACCOUNT_RETENTION = "interval '1 year'";`
> — `apps/web/scripts/pilot-cleanup-deleted-data.mjs:47-48`

and deletes exactly two tables (`:131` and `:136`, quoted in Finding 5). No code
deletes a session token on a schedule, expires an audit event, or removes a
message. Row-level cascades do cover much of the athlete tree —
`pilot_waivers_athlete_fk`, `pilot_medical_intake_athlete_fk`,
`pilot_coach_observations_athlete_fk` and their siblings all carry
`on delete cascade` (`infra/azure/pilot_slice_postgres.sql:406,423,448` among
others) — so deleting the athlete row does take those with it.

**What no cascade can reach is blob storage.** The portrait bytes and the video
bytes live in Azure containers, and the only two deleters in `blob.ts` are
`deletePilotProfilePhoto` (`blob.ts:203`) and the gym-wall equivalent
(`blob.ts:280`), both called only from portrait review/block. Nothing in the
retention path, and nothing in `dataDeletion.ts`, deletes a single stored byte.
The `account_profiles` row that names the portrait blob is not reached either —
it cascades from `accounts`, and the purge deletes only `role = 'parent'`
accounts.

*Refutation attempted.* I looked for a second cleanup elsewhere: a scheduled
workflow (`retention-cleanup.yml` is the only one, and it calls this script), a
blob lifecycle-management policy in `infra/` (none found), and a
`purgeExpiredShadowChatData` that might cover more (it is SHADOW chat only). I
also read the workflow's own header, which is candid that the previous state was
worse and this is the correction — the guards it added are genuinely good. The
scope gap is separate from the guards and was not addressed by them.

*Consequence for a real child.* A guardian asks for their child's data to be
deleted. The admin does it, the audit row says it happened, the policy document
promises photographs go in two years and medical records in three. Two years
later the athlete row and its cascaded medical, waiver and observation rows are
removed — and the child's photograph and their training videos are still sitting
in the storage account, with no row left anywhere that says whose they are. That
is the worst of both: the data is retained and it is no longer attributable, so
a future deletion request cannot even find it.

---

### [MEDIUM] A second, unguarded implementation of the destructive purge exists with zero callers

*What is wrong.* `dataDeletion.ts` contains a full duplicate of the retention
purge, with the same two intervals and the same two deletes:

> `export async function purgeExpiredDeletedData(): Promise<{ rowsDeleted: number }> {`
> — `apps/web/src/server/pilot/dataDeletion.ts:199`

It has **none** of the four guards the `.mjs` script's header documents as the
reason that script is safe: no target-hostname/database assertion, no dry-run
default, no blast-radius cap, no `PPBF_RETENTION_APPLY` gate. It keeps the
one-transaction property and the audit row. A repo-wide grep for
`purgeExpiredDeletedData` across `apps/` and `scripts/` returns exactly one hit —
the definition itself.

*Refutation attempted.* I checked whether the `.mjs` imports it (it does not — it
inlines its own SQL and imports only `pg` and the write-target guard), and whether
a route or job wires it (nothing). So it is dead code today. That is the reason
it is MEDIUM and not higher: nothing calls it. It is also the reason it is a
finding at all — it is one `import` away from being the purge that runs, and it
would be a plausible-looking import to write, because it is the module named
`dataDeletion.ts`. `AGENT_KERNEL.md`'s efficiency rule ("Prefer existing
primitives over parallel sources of truth") names this shape directly.

*Consequence for a real child.* If this copy is ever wired up in place of the
script, a mistyped connection string points the only irreversible operation in
the platform at the wrong database, with nothing between the call and the
`delete`.

---

### [LOW] `deleteAthleteRecord`'s own documentation claims it marks photographs and videos for deletion; it sets one column

> ` * Deletes an athlete record and marks all linked data (photos, videos, observations) for deletion.`
> — `apps/web/src/server/pilot/dataDeletion.ts:114`

The body runs one statement — `update pilot.athletes set deleted_at = now()`
(`dataDeletion.ts:139-142`) — and the code twenty lines below the JSDoc explicitly
contradicts it: *"NOT a deletion count: a soft delete leaves the athlete row in
place, so the FK cascade does not fire and nothing here is removed"*
(`dataDeletion.ts:147-150`). Somebody already caught this once, corrected the
audit field, and left the docstring. It matters because it is the sentence an
admin-console screen or a future retention doc would be written from.

---

## Checked and found sound

Listed because a negative result here is worth as much as a finding, and because
each of these was a real hypothesis I expected to confirm.

**The Next image optimizer cannot serve a minor's portrait.** This was the
specific hazard the code comments in scope warn about, and I set out to show the
warning was inadequately honoured. The comment is at
`apps/web/components/ProfilePortrait.tsx:81-86`:

> `A bare <img>, not next/image, and that is the point. The image optimizer fetches the source itself and caches the result on the server, which for a route that answers differently depending on WHO is asking means a cached copy of a child's face served past the visibility gate.`

The component honours it: `<img>` at `:88`, with the ESLint suppression at `:87`,
and `next/image` appears nowhere else in `apps/web/app`, `components`, or `src`
(one grep hit, which is that comment). My concern was that avoiding the component
does not disable the `/_next/image` endpoint, which is live by default —
`next.config.ts` sets no `images.unoptimized` and no `localPatterns`, and
`hasLocalMatch` allows every local path when `localPatterns` is undefined
(`node_modules/next/dist/shared/lib/match-local-pattern.js`). So
`/_next/image?url=%2Fapi%2Fpilot%2Fprofile%2Fphoto%2F<id>&w=256&q=75` is
constructible by hand. **It fails, and the reason is worth recording:** Next's
internal fetch for a same-origin URL builds a mock request that carries **no
headers**, and therefore no cookie —

> `        const mocked = (0, _mockrequest.createRequestResponseMocks)({`
> `            url: href,`
> `            method,`
> `            socket: _req.socket,`
> `            maximumResponseBody`
> `        });`
> — `node_modules/next/dist/server/image-optimizer.js` (`fetchInternalImage`)

with `createRequestResponseMocks({ url, headers = {}, ... })` in
`node_modules/next/dist/server/lib/mock-request.js`. `resolvePrincipal` reads the
session from a cookie and nothing else —
`const token = request.cookies.get(PILOT_SESSION_COOKIE)?.value;`
(`apps/web/src/server/pilot/auth.ts:254`) — so the optimizer's internal request is
unauthenticated, the portrait route returns `hiddenNotFound()`, and there is
nothing to cache. **This is a Next-internal behaviour, not something this
repository pins.** No test asserts it, and a future Next release that forwards
headers to internal image fetches would silently create exactly the cache the
comment describes. Worth a one-line `images: { unoptimized: true }` as belt to the
comment's braces.

**No service worker exists.** `find apps -name "sw.js" -o -name "service-worker*"
-o -name "*serviceWorker*"` returns nothing; there is no `next-pwa` or
`workbox` dependency. Nothing can cache a portrait client-side across sessions.

**No CDN or edge rule caches the portrait route.** `staticwebapp.config.json`
contains only `routes` rewrites for `/public*` and the seven board pages, plus a
`navigationFallback`; it sets no cache headers at all. `next.config.ts` applies
security headers to `/:path*` and no caching directive. The route's own
`'Cache-Control': 'private, no-store, max-age=0'`
(`profile/photo/[accountId]/route.ts:83`) is therefore the only cache instruction
in the chain, and `export const dynamic = 'force-dynamic'` at `:15` prevents
Next's own route cache. **What I could not check is whether an Azure Front Door or
CDN profile sits in front of the container app** — that is infrastructure state,
not source (recorded below).

**Nothing mints a SAS against the portrait container.** All 10 call sites of
`getPilotVideoSasUrl`/`getPilotShadowSasUrl` name the video or shadow container;
`getPilotProfileContainerName` appears in `blob.ts` upload/download/delete helpers
only. The claim at `env.ts:52-53` holds for portraits, exactly as written.

**Every refusal on the portrait route is the same 404.** Not-found, no-photo,
not-released and not-your-family all return `hiddenNotFound()` (`route.ts:52,55,60,70`),
which is a plain `{ error: 'Not found' }` at 404 (`http.ts:67-68`). A viewer
cannot learn that a hidden photograph exists. `profile/card` holds the same line
by assembling the card *after* the decision (`route.ts:25-28`).

**A replaced photograph re-enters review.** `setPhoto` resets
`photo_review_state = 'pending_review'` and nulls the reviewer fields in the same
UPDATE (`profileDb.ts:453-455`), with the reasoning stated at `:450-452`. Swapping
bytes under a released portrait is not possible.

**Both portrait review paths are compare-and-swap guarded.** `releasePhoto` and
`clearPhoto` take an optional `expectedCurrentState` folded into the UPDATE's
WHERE clause (`profileDb.ts:491`, `:514`), and `admin/portrait-review` passes
`'pending_review'` and deletes the blob only after the CAS confirms it won
(`route.ts:93-104`).

**Infected video is refused on every surface, and a coach cannot overturn a
content block.** `authorizeVideoScanReview` refuses `infected` outright
(`videoScanReview.ts:118-124`) after the existence and access checks so the
message discloses nothing; `video/[videoId]/release` allows only
`needs_human_review` and `unconfigured` (`route.ts:21`, `:81-90`); and
`video/[videoId]` returns 404 for anything not `ready` (`route.ts:46-48`). I went
looking specifically for a way to reach a quarantined or infected video by URL and
did not find one. The `review-link` route is the deliberate exception and it is
narrowed to the uploader-or-admin (`videoScanReview.ts:103-105`) precisely because
an earlier version was not — the reasoning is recorded at `:73-80`.

**The unauthenticated gym wall cannot reach a real name.** `/api/pilot/wall` takes
its organization from configuration and never from the caller (`route.ts:48`),
carries no `athlete_id`, and gates names through `resolveDisplayVisibility`, whose
default mode is `initials` and whose consent types have **no writer in the
codebase**. Every failure path in that function returns `initials`
(`wallDisplay.ts:205-232`), including undated, future-dated, expired and
non-guardian-signed. This is fail-closed and the module says so.

**Gym photographs are structurally incapable of carrying a child's face from the
portrait pipeline.** `gymPhotoSrc` rejects anything containing `/`, `\`, `:` or a
leading `.` (`gymPhotos.ts:198-199`), so a slot cannot point at
`/api/pilot/profile/photo/...`; the slot route requires a principal and takes the
org from it (`gym-photos/[slot]/route.ts:27,32`); and the module's header states
there is no code path to `account_profiles`, which `gymPhotos.test.ts` asserts.

**Guardian-facing reads are viewer-scoped, not role-scoped.**
`/api/pilot/parent/safety`, `/parent/messages` and `/parent/consent` all resolve
the caller's own children through `guardianAthleteIds` before reading anything,
and `parent/consent`'s POST re-checks membership before every write
(`route.ts:128-131`) rather than trusting a well-formed `athlete_id`.

**The publish and approve paths close the withdrawal race properly.** Both call
`assertGuardianMediaConsent` and then re-run the check inside the claim's own
transaction via `verifyBeforeCommit`, and the re-check takes `for share` on the
guardian rows against the sweep's `for update` (`guardianConsent.ts:154-166`,
`publication.ts:364-369`). This is genuinely good work and is the standard against
which Finding 3 is measured.

**Withdrawal really does retract.** The sweep runs inside the withdrawal request,
not on a timer; a failed sweep returns 500 rather than being swallowed, and writes
its own audit row so an auditor can tell "no published media" from "suppression
failed" (`parent/consent/route.ts:193-233`). The only exit from `retracted` goes
backwards into the review queue with the compliance check reset
(`publication.ts:399-402`).

**`platform_owner` and `board` are excluded from a minor's face by name**
(`profileDb.ts:246-251`) and from medical state by role set
(`shadowRoleSets.ts:41-52`).

**A parent who is not linked to *this* athlete is `none`, not
`organization_staff`.** One `return` is the entire cross-family boundary for
portraits and it is correct (`profileDb.ts:269`, with the reasoning at `:266-268`).

---

## Could not establish

- **Whether the retention purge has ever been run in `APPLY` mode.** Finding 5's
  reachability depends on it. `retention-cleanup.yml:149` shows scheduled runs
  pass `PPBF_RETENTION_APPLY: ${{ inputs.apply == 'APPLY' }}`, which is empty on a
  schedule — but workflow *run history* is not in the repository. This needs
  someone with Actions access to check.
- **What drives the SHADOW job queue in production.** No workflow under
  `.github/workflows/` and no page or component under `apps/web` references
  `shadow/jobs/process`. It may be an Azure timer, an external scheduler, or
  nothing at all. This bounds Finding 3 in either direction and I could not
  resolve it from source.
- **Whether Defender for Storage malware scanning is actually enabled on the live
  account.** If it is not, `scan_state` lands on `unconfigured`, which is one of
  the two states a coach may release by hand (`video/[videoId]/release/route.ts:21`).
  The design is defensible either way; which branch is live is a runtime fact.
- **Whether a CDN or Front Door sits in front of the container app.** I verified
  every cache directive the *application* emits and the SWA config; I cannot see
  an edge profile from here. If one exists and ignores `no-store`, the portrait
  route's central guarantee is weaker than its comment claims.
- **The live blob container access level.** `uploadPilotProfilePhoto` calls
  `createIfNotExists()` without requesting `container` access
  (`blob.ts:156-159`), and the comment states private is the default — correct for
  a container this code created. A container created out-of-band could differ.
- **Whether any `photo_media` waiver rows with `parent_id = null` exist in the
  live database.** That determines whether Finding 6(a) is theoretical or already
  happening. I did not query any database and would not; `scripts/data/` was not
  opened.
- **Whether `pilot.athletes.deleted_at` is filtered by athlete-facing list
  queries generally.** I established that `getSubjectIdentity` does not filter it
  (which is the *safe* direction for portraits) but did not audit the other
  ~200 athlete reads — that belongs to pass 2 or 6.
- **Nothing in this pass was executed.** Per the audit's own standard, every
  statement above is source reading, and source reading is not runtime proof.

---

## De-duplication against the two prior audits

| Already recorded | Where | Status here |
|---|---|---|
| Guardian consent scope collected, never enforced; `covers_video` defaults true | NETWORK_STATUS, "Blocked on something real" | **Verified independently and extended** — Finding 1 |
| Guardian links accept an unvalidated `parent_id` | NETWORK_STATUS "Found after the map"; FULL_SPECTRUM §13 | **Verified still present**; new `MINOR_CIRCLE` consequence added — Finding 2b |
| Portrait review with no image (#461) | NETWORK_STATUS "In review"; FULL_SPECTRUM §13 | **Verified still present** on `04dd116b`: `/admin/portrait-review/page.tsx` contains no `<img>` and no `ProfilePortrait`. Cited, not re-filed |
| Retention doc names a non-existent script; deletion is dry-run only | FULL_SPECTRUM §5, §10 | Cited; **scope gap is new** — Finding 7 |
| Consent/Waiver Tracker write API had no UI | FULL_SPECTRUM §0 #7 | Superseded: `/admin/consent` exists and calls `domain-upsert` |
| No e-signature or waiver text capture, metadata only | FULL_SPECTRUM §0 #6 | Confirmed, not re-filed |
| Passbook API role allowlist includes `parent` | FULL_SPECTRUM §7 | Out of this pass's scope; unchanged |
| Film Study ran with no consent check (#438) | NETWORK_STATUS "Closed" | **Fix verified present** at `video-analysis/route.ts:106`; the residual async gap is new — Finding 3 |
| Blocked/infected scan filed no escalation (#439) | NETWORK_STATUS "Closed" | Not re-examined; pass 4's surface |

New in this pass: Findings 2, 3, 4, 5, 6, 7, 8, 9, and the extension to 1.

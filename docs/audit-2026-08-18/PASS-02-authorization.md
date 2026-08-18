# Pass 2 — Authorization & tenancy

Read-only audit of `origin/main` at `04dd116b`, working branch
`docs/full-spectrum-audit-2026-08-18`. No application code was changed; this
file is the only write.

## Method

I read four things before opening any route: `AGENT_KERNEL.md`,
`docs/PLATFORM_AUDIT_2026-08-17_FULL_SPECTRUM.md` (from
`origin/claude/app-audit-ux-ui-report-78o4cm`), and `NETWORK_STATUS.md`.
`docs/capabilities/NETWORK_STATUS.md` **does not exist on this branch or on
`origin/main`** — the only copy in the repository is on
`origin/docs/agent-handoff-briefs`, and that is the copy I read. That is worth
saying plainly because the brief cited it as a path on this tree, and a future
reader following the same instruction will get "No such file or directory".

**The primitives.** I enumerated every exported `assert*`/`can*`/`require*`/
`is*`/`has*` function under `apps/web/src/server/pilot/` by grep (91 exports
matched; most are type predicates like `isDrillDifficulty`, not authorization).
I then read four files end to end — `access.ts` (456 lines), `http.ts` (203),
`guardianAccess.ts` (119), `pageGuard.ts` (84) — plus the specific bodies of
`assertCanManageBoardSeats`, `assertConversationAccess`, `renameConversation`,
`softDeleteConversation`, `assertGuardianMediaConsent`,
`assertGuardianMediaConsentWithClient`, `requireGuardianLinkForParentInvite`,
`upsertGuardian`, `linkGuardianAthlete`, `upsertWaiver`, `upsertMedicalIntake`,
`upsertEmergencyContact`, `endMentorship`, `addCompetitionEntry`,
`addLeagueRosterEntry`, `assignBoardSeat`, `assertEligibleHolder`,
`raiseSafetyFlag`, `listOpenSafetyFlags`, `getAthletesForCoach`,
`setSchedulerClassCover`, `purgeExpiredDeletedData` and
`getPilotVideoSasUrl`.

**The routes.** There are exactly 228 files matching
`apps/web/app/api/**/route.ts`. I classified **all 228** mechanically, by
grepping each file for a fixed list of 31 authorization helper names, and the
resulting route → helper table is reproduced in full below. I then **deep-read
31 route files** — every one that called no helper (14), every one that called
only `requirePrincipal` with no role gate (14), the three that call
`isOrganizationAdminRole` without `requireRole`, the seven dynamic-segment
routes, and a set chosen because they handle child data. A **further 22 route
files** I inspected at handler level only: I read the role constant, the
provenance of every `athlete_id`/`parent_id`/`organization_id` parameter, and
the surrounding lines, without reading the whole file. The remaining **175
routes I classified and did not open.** Any claim in this document about a
route I did not open is therefore a claim about which helper it imports and
calls, and nothing more.

**Tenancy.** Rather than eyeball 228 files for missing `organization_id`
predicates, I wrote a scanner (Python, over every template-literal SQL string
in `apps/web/src/server/pilot/**` and `apps/web/app/api/**/route.ts`,
excluding tests) that flags any statement naming a `pilot.*` table without the
substring `organization_id`. It returned **25 hits across 22,000-odd lines of
SQL**, and I read all 25. I also grepped every route for a caller-supplied
`organization_id` and read each of the five resolution helpers that accept one.

**What I did not do.** I ran no code and no tests. Every claim here is source
reading. Per invariant 5 of `AGENT_KERNEL.md` that is not runtime proof, and
the findings below should be reproduced against a running instance before
anyone acts on a severity.

## The authorization primitives

There are two distinct authorization layers and it matters which one a route
reaches for.

**`http.ts` is authentication plus a flat role list.** `requirePrincipal`
resolves the session cookie and then refuses an account still sitting on its
bootstrap PIN — a genuinely good default, because it means a newly-created
athlete account on the publicly-known starting PIN cannot read anything and a
new route inherits that protection without asking for it:

> `apps/web/src/server/pilot/http.ts:29` — `if (principal.mustChangePin === true) {`

`requireMicrosoftAuthenticatedPrincipal` layers on `authProvider !==
'microsoft'`, which is what keeps a PIN session out of user-management routes.
`http.requireRole` is exact list membership:

> `apps/web/src/server/pilot/http.ts:57-59` —
> ```
> export function requireRole(principal: PilotPrincipal, allowedRoles: PilotRole[]): void {
>   if (!allowedRoles.includes(principal.role)) {
>     throw new Error('Forbidden');
> ```

**`access.ts` is the relationship layer, and it is the one that actually knows
about children.** Its `requireRole` is the same idea but tolerant of the legacy
`admin` row, via `roleEquals`:

> `apps/web/src/server/pilot/access.ts:29-31` —
> ```
> export function requireRole(actor: ActorIdentity, allowed: PilotRole[]): void {
>   if (!allowed.some((item) => roleEquals(actor.role, item))) {
>     throw new Error('Forbidden: role not allowed');
> ```

143 of the 177 routes that call a `requireRole` import it from `access.ts`; 34
import it from `http.ts`. The two are not interchangeable (see finding 6).

`assertActorCanAccessAthlete` is the centre of the whole model. It is
**fail-closed by construction** — the function is a ladder of role branches and
the bottom of the ladder throws:

> `apps/web/src/server/pilot/access.ts:321` — `throw new Error('Forbidden: role not allowed');`

so `volunteer`, `staff`, and any role added to the enum in future are refused
by default rather than admitted. Above that, in order: `platform_owner` is
refused unconditionally (line 288), `board` is refused unconditionally (line
292), an org admin must clear `assertAthleteBelongsToOrganization` (line 296), a
coach must clear `assertCoachAssignedToAthlete` (line 301), an athlete must
match their own `athleteId` (line 306), and a parent must clear
`isGuardianLinkedToAthlete` (line 313). `accessibleAthleteIds` is the batched
twin and mirrors every one of those branches, including the same terminal
refusal — I checked it branch by branch and found no divergence.

`assertCoachAssignedToAthlete` admits two relationships: coach of record, or an
unexpired row in `pilot.coach_coverage`. The coverage grant is genuinely
bounded — `MAX_COVERAGE_TTL_HOURS = 14 * 24`, expiry compared against `now()`
at read time so a lapsed grant needs no cleanup job, one live grant per
(athlete, coach) so revocation cannot lie, and a `42P01` tolerance so a
pre-migration database behaves as "no coverage" rather than 500ing the safety
feed. This is careful work.

`isGuardianLinkedToAthlete` is the parent arm, and it is organization-scoped on
**both** sides of the join — the link row and the parent row must each name the
same gym:

> `apps/web/src/server/pilot/guardianAccess.ts:43-49` —
> ```
> `select athlete_id
>  from pilot.guardian_links
>  where organization_id = $1 and athlete_id = $2 and parent_id in (
>    select parent_id
>    from pilot.parents
>    where organization_id = $1 and account_id = $3
>  )`
> ```

Note what this means for finding 1: a guardian's reach is resolved through
`pilot.parents.account_id`. Whoever can write that column decides which signed-in
account is treated as a child's guardian.

`assertAthleteUpdateAllowed` refuses a coach any change to `coach_id`, with the
escalation written out in the comment ("A bound that the bounded party can write
their way out of is not a bound"). `assertCanManageBoardSeats` reads the
President's seat from the database rather than the session. `requirePageRole`
is the server-side page guard and deliberately does not sit inside a
`try/catch`, so a database outage renders an error instead of a misleading
"you are signed out".

Two smaller primitives are worth naming because routes lean on them:
`hiddenNotFound()` (a 404 used for both "does not exist" and "exists but
forbidden", so the two are indistinguishable) and `jsonError`, which maps
message prefixes to statuses and scrubs any unrecognised message behind a
generic 500.

**Verdict on the primitives themselves: they are sound.** Every gap I found is
a route that did not call them, not a primitive that failed.

## Route classification

All 228 routes, by which authorization helpers appear in the file. This is
produced by grep, so it is evidence of *what a route imports and calls*, not
proof that the call sits on every code path through that file. Where I opened
the file and checked the paths, that is stated in the findings.

### Distribution

| Helper combination | Routes |
|---|---|
| `requirePrincipal` + `requireRole` | 95 |
| `requirePrincipal` + `requireRole` + `assertActorCanAccessAthlete` | 43 |
| `requirePrincipal` + `requireRole` + `isOrganizationAdminRole` | 13 |
| `requirePrincipal` only — **no role gate** | 14 |
| **No helper at all** | 14 |
| `requireMicrosoftAuthenticatedPrincipal` family (privileged) | 16 |
| `guardianAthleteIds`-scoped (parent surfaces) | 4 |
| `isOrganizationAdminRole` + `requirePrincipal`, **no `requireRole`** | 3 |
| Everything else (one-off combinations, mostly SHADOW and video) | 26 |

The 14 with no helper at all are all deliberately public or key-gated, and I
read every one — see *Checked and found sound*. The 14 with
`requirePrincipal` and no role gate are also all sound; I read every one.

### The rows that matter

| Route | Helpers found | Note |
|---|---|---|
| `pilot/safety-flags` | requirePrincipal, requireRole | **Finding 2** — coach-inclusive role gate, org-wide minor safety data |
| `pilot/intake/domain-upsert` | assertActorCanAccessAthlete, assertShadowAuthority, requirePrincipal, requireRole | **Finding 1** — athlete side gated, guardian record side not |
| `pilot/achievements/mentorships` | assertActorCanAccessAthlete, requirePrincipal, requireRole | **Finding 4** — DELETE authorizes after the write |
| `pilot/video/[videoId]` | assertActorCanAccessAthlete, isOrganizationAdminRole, requirePrincipal | **Finding 5** — 60-minute SAS bearer URL |
| `pilot/competence-cohorts` | requirePrincipal, requireRole (`http`) | **Findings 3, 6** |
| `pilot/multidiscipline` | requirePrincipal, requireRole (`http`) | **Findings 3, 6** |
| `pilot/coach/transfer-check` | requirePrincipal, requireRole | **Finding 3** |
| `pilot/data-collection-requests` | requirePrincipal, requireRole (`http`) | **Finding 3** |
| `pilot/coach/behavior-standards` | requirePrincipal, requireRole | **Finding 3** |
| `pilot/coach/floor-groups` | requirePrincipal, requireRole | **Finding 3** |
| `pilot/coach/intervention-executions` | requirePrincipal, requireRole | **Finding 3** |
| `pilot/coach/intervention-protocols` | requirePrincipal, requireRole | **Finding 3** |
| `pilot/coach/intervention-review` | requirePrincipal, requireRole | **Finding 3** |
| `pilot/coach/one-percent-club` | requirePrincipal, requireRole | **Finding 3** (athlete role admitted to `nominate`) |
| `pilot/scheduler` | assertActiveCoachAccount, assertActorCanAccessAthlete, assertCoachAssignedToAthlete, guardianAthleteIds, isOrganizationAdminRole, requirePrincipal | **Finding 7** on one action; otherwise the best-guarded route in the tree |
| `pilot/training-holds` | assertAthleteBelongsToOrganization, assertCoachAssignedToAthlete, guardianAthleteIds, isOrganizationAdminRole, requirePrincipal | Sound — the model instance |
| `pilot/escalations` | isOrganizationAdminRole, requirePrincipal | Sound — scopes coaches to their own athletes inline |
| `pilot/board/seats` | assertCanManageBoardSeats, requireMicrosoftAuthenticatedPrincipal, requirePrincipal | Sound — both sides of the link validated |

### Full table

| Route (under `apps/web/app/api/`) | Authorization helpers called |
|---|---|
| `admin/volunteers` | requirePrincipal, requireRole |
| `document-ingest` | requirePrincipal, requireRole |
| `pilot/achievements/mentorships` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/achievements/milestones` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/achievements/recognition` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/admin/accounts/pin-reset` | isOrganizationAdminRole, requireMicrosoftAuthenticatedPrincipal, requireRole |
| `pilot/admin/accounts/repair-auth-provider` | requireMicrosoftAuthenticatedPrincipal, requireRole |
| `pilot/admin/accounts/revoke` | isOrganizationAdminRole, requireMicrosoftAuthenticatedPrincipal, requireRole |
| `pilot/admin/activation-codes` | assertActorCanAccessAthlete, isOrganizationAdminRole, requireMicrosoftAuthenticatedPrincipal |
| `pilot/admin/athlete-accounts` | isOrganizationAdminRole, requireMicrosoftAuthenticatedPrincipal, requireRole |
| `pilot/admin/athlete-consent` | requirePrincipal, requireRole |
| `pilot/admin/athlete-pin-directory` | isOrganizationAdminRole, requireMicrosoftAuthenticatedPrincipal, requireRole |
| `pilot/admin/bootstrap/platform-owner-microsoft` | NONE |
| `pilot/admin/bootstrap` | NONE |
| `pilot/admin/capabilities` | requirePrincipal, requireRole |
| `pilot/admin/citation-checks` | requirePrincipal, requireRole |
| `pilot/admin/coach-coverage` | isOrganizationAdminRole, requireMicrosoftAuthenticatedPrincipal |
| `pilot/admin/community-service` | requirePrincipal, requireRole |
| `pilot/admin/data-deletion` | isOrganizationAdminRole, requireMicrosoftAuthenticatedPrincipal |
| `pilot/admin/data-quality/duplicate-guardians` | requirePrincipal, requireRole |
| `pilot/admin/export/roster` | isOrganizationAdminRole, requireMicrosoftAuthenticatedPrincipal, requireRole |
| `pilot/admin/floor-hours` | requirePrincipal, requireRole |
| `pilot/admin/gear-vendors` | isOrganizationAdminRole, requirePrincipal, requireRole |
| `pilot/admin/gear` | isOrganizationAdminRole, requirePrincipal, requireRole |
| `pilot/admin/grant-obligations` | requirePrincipal, requireRole |
| `pilot/admin/gym-capabilities` | requirePrincipal, requireRole |
| `pilot/admin/gym-photos` | requirePrincipal, requireRole |
| `pilot/admin/local-findings` | requirePrincipal, requireRole |
| `pilot/admin/memberships` | requirePrincipal, requireRole |
| `pilot/admin/portrait-review` | requirePrincipal, requireRole |
| `pilot/admin/program-phases` | requirePrincipal, requireRole |
| `pilot/admin/retraction-checks` | requirePrincipal, requireRole |
| `pilot/admin/roster-import` | isOrganizationAdminRole, requirePrincipal, requireRole |
| `pilot/admin/safety-review` | requirePrincipal, requireRole |
| `pilot/admin/staff` | isOrganizationAdminRole, requireGuardianLinkForParentInvite, requireMicrosoftAuthenticatedPrincipal |
| `pilot/admin/track-assignments` | requirePrincipal, requireRole |
| `pilot/admin/video-compliance` | assertGuardianMediaConsent, assertGuardianMediaConsentWithClient, requirePrincipal, requireRole |
| `pilot/admin/waiver-status` | requirePrincipal, requireRole |
| `pilot/analytics/performance` | isOrganizationAdminRole, requirePrincipal, requireRole |
| `pilot/announcements/get` | requirePrincipal, requireRole |
| `pilot/announcements/post` | requireMicrosoftAuthenticatedPrincipal |
| `pilot/announcements/public` | NONE |
| `pilot/announcements/update` | requireMicrosoftAuthenticatedPrincipal, requireRole |
| `pilot/athlete/chat` | requirePrincipal, requireRole |
| `pilot/athlete/check-in` | requirePrincipal, requireRole |
| `pilot/athletes/get` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/athletes/list` | isOrganizationAdminRole, requirePrincipal, requireRole |
| `pilot/athletes` | requirePrincipal, requireRole |
| `pilot/athletes/update` | assertActorCanAccessAthlete, assertAthleteUpdateAllowed, requirePrincipal, requireRole |
| `pilot/audit/get` | requirePrincipal, requireRole |
| `pilot/auth/activate` | NONE |
| `pilot/auth/change-pin` | requirePrincipal, requirePrincipalAllowingPinChange |
| `pilot/auth/login` | NONE |
| `pilot/auth/logout` | requirePrincipal |
| `pilot/auth/magic-link/consume` | NONE |
| `pilot/auth/magic-link/request` | NONE |
| `pilot/auth/microsoft/callback` | NONE |
| `pilot/auth/microsoft/start` | NONE |
| `pilot/auth/session` | requirePrincipal, resolvePrincipal |
| `pilot/board/chat` | requirePrincipal, requireRole |
| `pilot/board/compliance-rules` | requirePrincipal, requireRole |
| `pilot/board/compliance-summary` | requirePrincipal, requireRole |
| `pilot/board/escalation-summary` | requirePrincipal, requireRole |
| `pilot/board/seats` | assertCanManageBoardSeats, requireMicrosoftAuthenticatedPrincipal, requirePrincipal |
| `pilot/board/summary` | requirePrincipal, requireRole |
| `pilot/coach-reviews/get` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/coach-reviews/list` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/coach-reviews` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/coach-reviews/update` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/coach/barrier-reports` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/coach/behavior-standards` | requirePrincipal, requireRole |
| `pilot/coach/chat` | requirePrincipal, requireRole |
| `pilot/coach/cue-library` | requirePrincipal |
| `pilot/coach/floor-groups` | requirePrincipal, requireRole |
| `pilot/coach/intelligence` | isOrganizationAdminRole, requirePrincipal, requireRole |
| `pilot/coach/intervention-executions` | requirePrincipal, requireRole |
| `pilot/coach/intervention-protocols` | requirePrincipal, requireRole |
| `pilot/coach/intervention-review` | requirePrincipal, requireRole |
| `pilot/coach/one-percent-club` | requirePrincipal, requireRole |
| `pilot/coach/pain-reports` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/coach/readiness-board` | isOrganizationAdminRole, requirePrincipal, requireRole |
| `pilot/coach/transfer-check` | requirePrincipal, requireRole |
| `pilot/competence-cohorts` | requirePrincipal, requireRole |
| `pilot/compliance/escalate` | requirePrincipal, requireRole |
| `pilot/compliance/violations` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/data-collection-requests` | requirePrincipal, requireRole |
| `pilot/drill-library` | requirePrincipal |
| `pilot/drills` | requirePrincipal, requireRole |
| `pilot/escalations` | isOrganizationAdminRole, requirePrincipal |
| `pilot/feedback/list` | isOrganizationAdminRole, requireMicrosoftAuthenticatedPrincipal |
| `pilot/feedback/submit` | requirePrincipal |
| `pilot/feedback/triage` | isOrganizationAdminRole, requireMicrosoftAuthenticatedPrincipal |
| `pilot/floor-hours/public` | NONE |
| `pilot/floor-plans` | assertActorCanAccessAthlete, isOrganizationAdminRole, requirePrincipal, requireRole |
| `pilot/goals/get` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/goals/list` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/goals/personal` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/goals` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/goals/update` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/gym-photos/[slot]` | requirePrincipal |
| `pilot/gym-photos` | requirePrincipal |
| `pilot/incidents` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/individual/chat` | requirePrincipal, requireRole |
| `pilot/intake/cases/get` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/intake/document-link` | requirePrincipal, requireRole |
| `pilot/intake/document-review` | requirePrincipal, requireRole |
| `pilot/intake/domain-get` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/intake/domain-upsert` | assertActorCanAccessAthlete, assertShadowAuthority, requirePrincipal, requireRole |
| `pilot/intake/review-action` | assertActorCanAccessAthlete, assertShadowAuthority, requirePrincipal, requireRole, resolvePrincipal |
| `pilot/intake/review-queue` | requirePrincipal, requireRole |
| `pilot/multidiscipline` | requirePrincipal, requireRole |
| `pilot/operations/external-competition/competitions` | requirePrincipal, requireRole |
| `pilot/operations/external-competition/entries` | requirePrincipal, requireRole |
| `pilot/operations/wrestling-league/events` | requirePrincipal, requireRole |
| `pilot/operations/wrestling-league/roster` | requirePrincipal, requireRole |
| `pilot/operations/wrestling-league/seasons` | requirePrincipal, requireRole |
| `pilot/ops/readiness` | requirePrincipal, requireRole |
| `pilot/parent/barrier-report` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/parent/consent` | guardianAthleteIds, requirePrincipal, requireRole |
| `pilot/parent/messages` | guardianAthleteIds, requirePrincipal, requireRole |
| `pilot/parent/safety` | guardianAthleteIds, requirePrincipal, requireRole |
| `pilot/passbook/gaps` | isOrganizationAdminRole, requirePrincipal, requireRole |
| `pilot/passbook` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/payments/accounts` | requirePrincipal, requireRole |
| `pilot/payments/connect/callback` | requirePrincipal, requireRole |
| `pilot/payments/connect/start` | requirePrincipal, requireRole |
| `pilot/payments/setup-status` | requirePrincipal, requireRole |
| `pilot/payments/webhook` | NONE |
| `pilot/platform/athlete-shell` | requireMicrosoftAuthenticatedPrincipal, requireRole |
| `pilot/platform/gym-summary` | requirePrincipal, requireRole |
| `pilot/platform/organizations/assign-admin` | requirePrincipal, requireRole |
| `pilot/platform/organizations/memberships` | requirePrincipal, requireRole |
| `pilot/platform/organizations` | requirePrincipal, requireRole |
| `pilot/platform/organizations/status` | requirePrincipal, requireRole |
| `pilot/platform/organizations/transfer-admin` | requirePrincipal, requireRole |
| `pilot/platform/overview` | requirePrincipal, requireRole |
| `pilot/platform/staff` | requireGuardianLinkForParentInvite, requireMicrosoftAuthenticatedPrincipal, requireRole |
| `pilot/platform/users/create` | isOrganizationAdminRole, requirePrincipal, requireRole |
| `pilot/platform/users/master-shadow-access` | requirePrincipal, requireRole |
| `pilot/platform/users/status` | requirePrincipal, requireRole |
| `pilot/profile/card` | assertViewerMayReachSubject, requirePrincipal |
| `pilot/profile/me` | requirePrincipal |
| `pilot/profile/nickname/clear` | assertViewerMayReachSubject, isOrganizationAdminRole, requirePrincipal, requireRole |
| `pilot/profile/photo/[accountId]` | assertActorCanAccessAthlete, assertViewerMayReachSubject, requirePrincipal |
| `pilot/profile/photo/review` | assertViewerMayReachSubject, isOrganizationAdminRole, requirePrincipal, requireRole |
| `pilot/profile/photo` | requirePrincipal |
| `pilot/profile/roster` | isOrganizationAdminRole, requirePrincipal, requireRole |
| `pilot/progression/assignments` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/progression/completions` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/progression/gap-justification` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/progression/gaps` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/progression/suggestions` | isOrganizationAdminRole, requirePrincipal, requireRole |
| `pilot/public-interest/review` | requirePrincipal, requireRole |
| `pilot/public-interest` | NONE |
| `pilot/publications/create` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/publications/library` | requirePrincipal, requireRole |
| `pilot/publications/publish` | assertGuardianMediaConsent, assertGuardianMediaConsentWithClient, isOrganizationAdminRole, requirePrincipal, requireRole |
| `pilot/publications/submit` | isOrganizationAdminRole, requirePrincipal, requireRole |
| `pilot/rabbit-holes/get` | assertCanAuthorRabbitHoles, requirePrincipal |
| `pilot/rabbit-holes/post` | assertCanAuthorRabbitHoles, requireMicrosoftAuthenticatedPrincipal |
| `pilot/rabbit-holes/update` | assertCanManageRabbitHole, requireMicrosoftAuthenticatedPrincipal |
| `pilot/safety-flags` | requirePrincipal, requireRole |
| `pilot/scheduler/attendance-summary` | isOrganizationAdminRole, requirePrincipal |
| `pilot/scheduler` | assertActiveCoachAccount, assertActorCanAccessAthlete, assertCoachAssignedToAthlete, guardianAthleteIds, isOrganizationAdminRole, requirePrincipal |
| `pilot/session-scripts` | requirePrincipal |
| `pilot/session-scripts/runs/[runId]` | requirePrincipal, requireRole |
| `pilot/session-scripts/runs` | requirePrincipal, requireRole |
| `pilot/sessions/get` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/sessions/list` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/sessions` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/sessions/update` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/shadow/authority` | requirePrincipal, requireRole |
| `pilot/shadow/capabilities` | requirePrincipal |
| `pilot/shadow/chat` | assertActorCanAccessAthlete, assertConversationAccess, requirePrincipal, requireRole |
| `pilot/shadow/data` | requirePrincipal |
| `pilot/shadow/decision-outcomes` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/shadow/decisions` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/shadow/events` | requirePrincipal, requireRole |
| `pilot/shadow/evidence/review` | requirePrincipal, requireRole |
| `pilot/shadow/feedback` | requirePrincipal, requireRole |
| `pilot/shadow/film-study/diagnostic` | requirePrincipal, requireRole |
| `pilot/shadow/film-study/proposals` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/shadow/formulas/observations` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/shadow/formulas/results` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/shadow/jobs/[jobId]` | requirePrincipal, requireRole |
| `pilot/shadow/jobs/process` | requirePrincipal, requireRole |
| `pilot/shadow/jobs` | cancelJobForActor, requirePrincipal, requireRole |
| `pilot/shadow/knowledge-projection` | requirePrincipal, requireRole |
| `pilot/shadow/library/capability-coverage` | requirePrincipal, requireRole |
| `pilot/shadow/library/chunks` | requirePrincipal, requireRole |
| `pilot/shadow/library/claims` | requirePrincipal, requireRole |
| `pilot/shadow/library/documents` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/shadow/library/review-flags` | requirePrincipal, requireRole |
| `pilot/shadow/library/search` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/shadow/library/sources` | requirePrincipal, requireRole |
| `pilot/shadow/medical-status` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/shadow/memory` | requirePrincipal |
| `pilot/shadow/metrics` | requirePrincipal, requireRole |
| `pilot/shadow/models` | requirePrincipal, requireRole |
| `pilot/shadow/near-misses` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/shadow/observation-projection` | requirePrincipal, requireRole |
| `pilot/shadow/recommendations/decide` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/shadow/recommendations` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/shadow/research-bridge/export` | requireResearchBridgeAccess |
| `pilot/shadow/research-bridge/session-export` | isOrganizationAdminRole, requirePrincipal |
| `pilot/shadow/research-projection` | requirePrincipal, requireRole |
| `pilot/shadow/research-requirements` | guardianAthleteIds, requirePrincipal, requireRole |
| `pilot/shadow/research-submissions` | requirePrincipal, requireRole |
| `pilot/shadow/review-projection` | requirePrincipal, requireRole |
| `pilot/shadow/reviews` | requirePrincipal, requireRole |
| `pilot/shadow/sessions/[conversationId]` | requirePrincipal, requireRole |
| `pilot/shadow/sessions` | assertActorCanAccessAthlete, canUseShadowSessionType, requirePrincipal, requireRole |
| `pilot/shadow/telemetry` | requirePrincipal, requireRole |
| `pilot/shadow/unlocks` | requirePrincipal, requireRole |
| `pilot/shadow/upload` | assertShadowAuthority, requirePrincipal, requireRole |
| `pilot/shadow/video-analysis` | assertActorCanAccessAthlete, assertGuardianMediaConsent, requirePrincipal, requireRole |
| `pilot/training-attempts` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/training-holds` | assertAthleteBelongsToOrganization, assertCoachAssignedToAthlete, guardianAthleteIds, isOrganizationAdminRole, requirePrincipal |
| `pilot/video/[videoId]/release` | isOrganizationAdminRole, requirePrincipal, requireRole |
| `pilot/video/[videoId]` | assertActorCanAccessAthlete, isOrganizationAdminRole, requirePrincipal |
| `pilot/video/list` | assertActorCanAccessAthlete, isOrganizationAdminRole, requirePrincipal, requireRole |
| `pilot/video/review-link` | requirePrincipal, requireRole |
| `pilot/video/scan-review` | requirePrincipal, requireRole |
| `pilot/video/upload` | assertActorCanAccessAthlete, requirePrincipal, requireRole |
| `pilot/wall-of-names` | requirePrincipal |
| `pilot/wall` | NONE |
| `pilot/workout-templates` | requirePrincipal |
| `public/store` | NONE |

## Findings

### [HIGH] A coach can overwrite another family's guardian record, including which account is its guardian

The known, already-escalated finding is that the guardian-link write accepts an
unvalidated `parent_id`. Both prior audits describe it as *linking*: "A coach
with legitimate standing on one athlete can attach any guardian in the
organisation to them." That is correct as far as it goes. It is not the whole
of what this branch does, and the second half is not recorded anywhere I could
find.

The route is `POST /api/pilot/intake/domain-upsert` with
`entity_type: 'guardian_link'`. It gates the athlete side properly —
`requireRole(principal, ['organization_admin', 'coach'])` at line 31 and
`await assertActorCanAccessAthlete(principal, athleteId)` at line 62 — and then:

> `apps/web/app/api/pilot/intake/domain-upsert/route.ts:133-146` —
> ```
>     } else if (entityType === 'guardian_link') {
>       const parentId = asString(body.payload.parent_id);
>       if (!parentId) {
>         throw new Error('Missing parent_id for guardian link');
>       }
>
>       await upsertGuardian({
>         organizationId: principal.organizationId,
>         parentId,
>         accountId: typeof body.payload.account_id === 'string' ? body.payload.account_id : undefined,
>         fullName: asString(body.payload.full_name, 'Guardian'),
>         phone: typeof body.payload.phone === 'string' ? body.payload.phone : undefined,
>         email: typeof body.payload.email === 'string' ? body.payload.email : undefined,
>       });
> ```

Both `parent_id` and `account_id` come straight from the request body, and
neither is validated against anything. `upsertGuardian` is not an insert:

> `apps/web/src/server/pilot/intake.ts:719-729` —
> ```
>   await query(
>     `insert into pilot.parents
>      (organization_id, parent_id, account_id, full_name, phone, email)
>      values ($1,$2,$3,$4,$5,$6)
>      on conflict (organization_id, parent_id) do update set
>        account_id = excluded.account_id,
>        full_name = excluded.full_name,
>        phone = excluded.phone,
>        email = excluded.email,
>        updated_at = now()`,
>     [params.organizationId, params.parentId, params.accountId ?? null, params.fullName, params.phone ?? null, params.email ?? null],
>   );
> ```

So naming an **existing** `parent_id` does not create a second guardian record;
it rewrites the one that is there. Three consequences follow, in increasing
order of seriousness.

The mild one: `full_name`, `phone` and `email` are overwritten unconditionally,
and `phone`/`email` fall to `null` when the caller simply omits them. A coach
performing an ordinary intake edit with a mistyped `parent_id` silently erases
a real guardian's contact details. For a gym holding minors, the guardian's
phone number is the emergency channel.

The middle one: `account_id` falls to `null` when omitted
(`params.accountId ?? null`). Nulling it severs a real guardian from their own
children — they still sign in successfully and see nothing, which is precisely
the failure mode `requireGuardianLinkForParentInvite` exists elsewhere to
prevent, arriving through a different door.

The serious one: `account_id` is the column
`isGuardianLinkedToAthlete` resolves a guardian's reach through
(`guardianAccess.ts:43-49`, quoted above). Writing it decides which signed-in
account is treated as the guardian of every child that parent row is linked to.
Because one guardian record commonly carries siblings, a coach with standing on
*one* child can repoint that child's guardian record at an account of their
choosing, and that account then reaches the **siblings** — children the coach
has no assignment or coverage grant for. That is a path from "reach one athlete"
to "reach a family", which is a different shape from the link-only finding
already on record.

**Refutation attempted.** (a) I re-read the route from line 1 to make sure I had
not missed an upstream check: the only gates before the branch are
`requirePrincipal`, `requireRole(['organization_admin','coach'])`,
`assertShadowAuthority` (an automation-mode gate — it takes `automationMode`,
`confidenceTier`, `reversible`, not an athlete relationship) and
`assertActorCanAccessAthlete` on the *athlete*. Nothing looks at `parent_id`.
(b) I checked whether the database stops it: `pilot.parents` has
`primary key (organization_id, parent_id)` and
`account_id text null references pilot.accounts(account_id)`
(`infra/azure/pilot_slice_postgres.sql:264-274`) — a single-column FK, so the
database will accept any account id that exists anywhere on the platform,
including another gym's. (c) I checked whether the attacker can discover another
family's `parent_id`: `POST /api/pilot/intake/domain-get` returns
`select p.*, g.relationship_to_athlete` for the guardians of an athlete the
caller can already reach (line 31), so a coach learns the `parent_id` of their
own athlete's guardian — which is exactly the record whose siblings are at
stake. (d) I checked the other three writers of `pilot.guardian_links`:
`staffProvisioning.ts:481` derives `parentId` from the invited account and
refuses an ambiguous claim; `intake/review-action` uses
`promotion.guardian.parent_id` from the reviewed packet. Neither takes a raw
caller id. (e) I searched all 143 remote branches for one touching
`domain-upsert` or `intake.ts` — `origin/fix/ct-readiness-provenance` and
`origin/fix/readiness-score-fabrication` both do, and I diffed both: they change
only the `readiness` branch. Nobody owns this.

**Why it matters here.** The escalated version of this finding was held back
because the fix "narrows a role gate coaches may use daily". Validating
`parent_id` and refusing an `account_id` change from this route narrows nothing
a legitimate intake edit needs — it is a different fix from the one that is
parked, and it should not inherit that parking.

### [HIGH] Any coach can read, raise and resolve safety flags for every child in the gym

`/api/pilot/safety-flags` is the queue for `pilot.safety_flags`, whose flag
codes include `medical_clearance_missing` and `concussion_rest_period`
(`safetyFlags.ts:38-42`). Its role gate admits coaches:

> `apps/web/app/api/pilot/safety-flags/route.ts:17` — `const QUEUE_ROLES = ['organization_admin', 'admin', 'coach'] as const;`

and that is the only authorization on any of the three verbs. The read:

> `apps/web/app/api/pilot/safety-flags/route.ts:28-35` —
> ```
>     requireRole(principal, [...QUEUE_ROLES]);
>
>     const { searchParams } = new URL(request.url);
>     const flags = await listOpenSafetyFlags(principal.organizationId, {
>       flagClass: (searchParams.get('flag_class') as SafetyFlagClass | null) ?? undefined,
>       severity: (searchParams.get('severity') as SafetyFlagSeverity | null) ?? undefined,
>       athleteId: searchParams.get('athlete_id') ?? undefined,
>     });
> ```

`listOpenSafetyFlags` filters on `organization_id` and nothing else
(`safetyFlags.ts:155-171`). So an unassigned coach with no coverage grant gets
the whole gym's open safety queue, and can target one child by passing
`?athlete_id=`. `POST` lets the same coach raise a flag naming any
`body.athlete_id` (line 72); `PATCH` lets them set any flag's status to
`bypassed` (line 117) — including a flag about a child they have never met.

The reason this reads as a defect rather than a design choice is that the two
sibling surfaces in the same codebase do the opposite, deliberately and with
comments saying so. `/api/pilot/escalations` builds a coach's athlete list and
scopes the query to it, and additionally hides `athlete_voice` rows from
coaches because "their existence alone says 'this child said something', and the
coach may be who it is about". And training holds are explicit:

> `apps/web/app/api/pilot/training-holds/route.ts:129-133` —
> ```
>     if (role === 'coach') {
>       // A coach reads holds per athlete, through the same assignment gate
>       // every other athlete-scoped read uses -- no org-wide hold roster.
>       if (!athleteId) throw new Error('Missing athlete_id');
>       await assertCoachAssignedToAthlete(principal.accountId, athleteId, principal.organizationId);
> ```

A training hold and a safety flag are the same kind of fact about the same
child. One route refuses an org-wide roster in as many words; the other serves
one.

**Refutation attempted.** (a) I read all 141 lines of the route: there is no
athlete scoping on any verb. (b) I read `listOpenSafetyFlags` and
`raiseSafetyFlag` in full; neither takes an actor. (c) I checked whether the
coach path is dead: the only frontend caller is
`apps/web/app/admin/safety-flags/page.tsx`, an admin page — so today's exposure
is via direct API call, not a UI button. The route is live and coaches hold
sessions. (d) I checked the composite FK — `pilot_safety_flags_athlete_fk
foreign key (organization_id, athlete_id)` does block a cross-gym athlete id, so
this is confined to one organization. (e) Neither prior audit covers it; both
checked "does the route call an auth helper", which this route does. No open
branch touches the file.

**Severity note, stated so the owner can overrule me.** This meets the letter of
the brief's CRITICAL bar — it exposes a specific minor's safety state to
someone the platform's own model says should not see it. I have written it HIGH
rather than CRITICAL because the reader is a vetted coach inside the same gym
rather than an outsider, and because there is no UI path. If the owner reads
"concussion rest period, visible to any coach on the floor" as the more
important fact, HIGH is the wrong label and I would not argue.

### [MEDIUM] Eleven coach-reachable routes take an athlete id from the caller and check only the role

`safety-flags` above is the worst instance of a family. In each of these, a
`coach` is admitted by role and the athlete is named by the request, with no
call to `assertActorCanAccessAthlete`, `assertCoachAssignedToAthlete` or
`accessibleAthleteIds` anywhere in the file. The cleanest example, because it is
31 lines long and there is nowhere for a check to hide:

> `apps/web/app/api/pilot/coach/transfer-check/route.ts:16-26` —
> ```
> const TRANSFER_ROLES = ['coach', 'organization_admin', 'admin'] as const;
> ...
>     requireRole(principal, [...TRANSFER_ROLES]);
>
>     const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim();
>     if (!athleteId) throw new ValidationError('Missing athlete_id.');
>
>     const items = await getTransferReadout(principal.organizationId, athleteId);
> ```

The full list, with the role constant that admits a coach and the athlete-data
operation it reaches:

| Route | Role constant | What a non-assigned coach gets |
|---|---|---|
| `coach/transfer-check` | `TRANSFER_ROLES` (line 16) | read: any athlete's false-progress readout |
| `coach/behavior-standards` | `FLOOR_ROLES` (line 34) | write: recognition and conduct concern against any athlete (line 110, 132) |
| `coach/floor-groups` | `FLOOR_ROLES` (line 24) | write: place/remove any athlete in a floor plan (line 102, 119) |
| `coach/intervention-executions` | `EXECUTION_ROLES` (line 31) | read + write: any athlete's intervention record (line 67, 81) |
| `coach/intervention-protocols` | `PROTOCOL_ROLES` (line 24) | write: a protocol against any athlete (line 71) |
| `coach/intervention-review` | `REVIEW_ROLES` (line 37) | read + write: any athlete's intervention reviews (line 47) |
| `coach/one-percent-club` | `NOMINATOR_ROLES` (line 42) | write: nominate any athlete — and this list admits `athlete` too |
| `competence-cohorts` | inline `['coach','admin']` (line 33) | read: any athlete's assessed levels and derived age |
| `multidiscipline` | inline `['coach','admin']` (line 36) | read: any athlete's grappling-exposure history |
| `data-collection-requests` | `QUEUE_ROLES` (line 15) | read + write: the org-wide capture queue, filterable by athlete |
| `safety-flags` | `QUEUE_ROLES` (line 17) | see finding 2 |

`multidiscipline` deserves a line of its own, because its own header names the
sensitivity and then does not enforce it:

> `apps/web/app/api/pilot/multidiscipline/route.ts:26-27` — `// current participation level. That is athlete safety data, restricted to` / `// coach and admin.`

"Restricted to coach" is enforced. "This athlete's coach" is not.

**Refutation attempted.** (a) I opened `transfer-check`, `competence-cohorts`,
`multidiscipline`, `data-collection-requests` and `safety-flags` in full and
`behavior-standards`, `floor-groups`, `one-percent-club` and the three
`intervention-*` routes at handler level; in none of them does an athlete-level
check appear before or after the call. (b) I checked the obvious upstream
candidate — that the *module* scopes by coach — by reading `getTransferReadout`'s
caller signature and `listOpenSafetyFlags`/`listExecutions`' parameters: they
take `(organizationId, athleteId)` and no actor. (c) I confirmed this is not the
house style by finding four routes that do it correctly with the *same* data
class: `coach/readiness-board`, `coach/intelligence`, `analytics/performance` and
`progression/suggestions` all resolve the coach's roster through
`getAthletesForCoach(principal.organizationId, principal.accountId)` first — and
that helper includes coverage grants and fails safe to coach-of-record on a
missing migration. So the correct pattern exists, is used, and these eleven did
not reach for it. (d) I searched every remote branch; none touches these files
except `origin/fix/session-run-intervention-link-ui`, which changes a page
component, not the route.

**Why it matters here.** The whole point of `pilot.coach_coverage` — the
14-day cap, the one-live-grant rule, the audit trail — is that a substitute
coach gets *bounded* access to one child's record. Eleven routes that hand any
coach any child's record for free make that bound decorative for the data they
carry.

### [MEDIUM] `DELETE /api/pilot/achievements/mentorships` performs the write, then authorizes

This route's `POST` is the best example in the codebase of the two-sided link
check the brief asks about:

> `apps/web/app/api/pilot/achievements/mentorships/route.ts:68-72` —
> ```
>     // BOTH ends are authorized separately. A pairing puts each person's name on
>     // the other's screen, so entitlement to one of them is not entitlement to
>     // publish the other.
>     await assertActorCanAccessAthlete(principal, mentorAthleteId);
>     await assertActorCanAccessAthlete(principal, menteeAthleteId);
> ```

`DELETE`, thirty lines below, gets it wrong twice:

> `apps/web/app/api/pilot/achievements/mentorships/route.ts:115-122` —
> ```
>     const mentorship = await endMentorship(principal.organizationId, mentorshipId);
>     if (!mentorship) {
>       throw new Error('Not found');
>     }
>
>     // Authorized after the read, because the identifier alone says nothing
>     // about who it concerns until the row is in hand.
>     await assertActorCanAccessAthlete(principal, mentorship.mentor_athlete_id);
> ```

The comment says "after the read". `endMentorship` is not a read:

> `apps/web/src/server/pilot/achievements.ts:561-566` —
> ```
>   await query(
>     `update pilot.mentorships
>      set ended_on = current_date
>      where organization_id = $1 and mentorship_id = $2 and ended_on is null`,
>     [organizationId, mentorshipId],
>   );
> ```

The `UPDATE` commits before the authorization line runs, and there is no
transaction and no compensating write. A coach passing any `mentorship_id` in
their organization closes that pairing and then receives a 403 — the refusal is
real, the effect is already durable. Secondly, only the **mentor** side is
authorized on the way out, so even a legitimately-authorized caller can close a
pairing whose mentee they have no standing on — the exact asymmetry `POST`'s
comment warns against.

**Refutation attempted.** (a) I read `endMentorship` in full to be sure the
`UPDATE` was not inside a transaction the route rolls back — it is a bare
`query()`. (b) I checked whether the role gate makes it moot: writers are
`['coach', 'organization_admin', 'admin']`, and for an org admin
`assertActorCanAccessAthlete` would pass anyway, so the gap only bites coaches —
but it does bite them. (c) I looked for a route test that would have caught it:
`apps/web/app/api/pilot/achievements/mentorships/` contains only `route.ts`.
There is no test file for this route at all. (d) No prior audit and no open
branch mentions it.

**Why it matters here.** Low data-exposure impact — a mentorship is a pairing,
not a medical fact. It is listed because "authorize after you have mutated" is
a shape that will be copied, and because the 403-versus-404 difference tells a
caller which `mentorship_id` values are real.

### [MEDIUM] The video detail route hands out a 60-minute bearer URL to a minor's footage, unaudited

`GET /api/pilot/video/[videoId]` does its authorization properly —
`hiddenNotFound()` for a missing row, for a non-`ready` row, and for a failed
`assertActorCanAccessAthlete` — and then converts that one-time check into a
capability that outlives it:

> `apps/web/app/api/pilot/video/[videoId]/route.ts:62` — `const sasUrl = getPilotVideoSasUrl(row.blob_path, 60);`

with `expiryMinutes = 60` (`blob.ts:122`). No audit event is written.

The same repository argues at length that this is the wrong shape for a child:

> `apps/web/src/server/pilot/blob.ts:138-141` —
> ```
>  * child's face: a SAS URL is a bearer capability with no idea who is holding
>  * it, it survives being pasted into a chat window, and it outlives the session
>  * that minted it. downloadPilotVideoFile already refuses to mint one for a
>  * minor's footage for exactly this reason; portraits take the same stance.
> ```

That comment is also inaccurate about its own codebase: `downloadPilotVideoFile`
does not "refuse to mint" a SAS URL for a minor's footage — it is a buffer
download for a background job and has no SAS-minting code to refuse with, while
`getPilotVideoSasUrl` sits eleven lines above it and is called by this route.
The narrower reviewer path in the same domain shows what the team actually
intends: `video/review-link` uses `const LINK_EXPIRY_MINUTES = 15;` and writes a
`video_review_link_issued` audit event naming the athlete. The general read path
is four times longer-lived and leaves no trace.

**Refutation attempted.** (a) I confirmed `status !== 'ready'` is refused, so
this is released footage, not quarantined footage. (b) I checked whether
guardian media consent gates it — it does not, but I do not think it should:
`assertGuardianMediaConsent` gates *publication*, and internal coach review of a
released video is a different act. I am not reporting that as a gap. (c) I
checked the third SAS call site, `admin/video-compliance:131`, which also uses
60 and is admin-only. (d) I read `apps/web/app/api/pilot/video/[videoId]/route.test.ts`
and it asserts `expect(getPilotVideoSasUrl).not.toHaveBeenCalled()` on the
refusal paths — so the authorization is tested; the lifetime is not.

**Why it matters here.** A minute after a coach's coverage grant expires, a URL
they fetched an hour ago still plays the video. The platform reasoned its way to
"no bearer URL for a child's photograph" and then did not carry the reasoning
across to video, which is the more identifying medium.

### [MEDIUM] Two `requireRole` implementations diverge, and two safeguarding reads lock out every current org admin

`access.requireRole` treats `admin` and `organization_admin` as the same role
via `roleEquals`; `http.requireRole` is exact `includes`. 34 routes import the
strict one. Two of them list `admin` without `organization_admin`:

> `apps/web/app/api/pilot/multidiscipline/route.ts:36` — `      requireRole(principal, ['coach', 'admin']);`

> `apps/web/app/api/pilot/competence-cohorts/route.ts:33` — `      requireRole(principal, ['coach', 'admin']);`

`admin` is the legacy value — `access.ts:17` calls it exactly that ("Preserve
compatibility while migrating legacy 'admin' rows") — and every currently-minted
administrator is `organization_admin` (`auth.ts:892`, `:1146`, `:1266`). So the
athlete-data branch of both routes refuses today's org admins outright. The
comments show the intent was the opposite: "That IS athlete data, so it is
restricted to coach and admin" (`competence-cohorts:20-21`).

**Refutation attempted.** (a) I verified which `requireRole` each imports by
joining lines and matching the import specifier — both import from
`@/src/server/pilot/http`, so `roleEquals` does not apply. (b) I checked whether
a test would have caught it: `competence-cohorts/route.test.ts:110` drives the
athlete branch with `role: 'admin'` and `multidiscipline/route.test.ts` never
exercises an admin at all — so both tests pass while the live role fails. (c) I
checked the inverse direction (a route listing only `organization_admin` under
the strict helper, locking out a legacy `admin` row) and found none. (d) This is
fail-closed, which is why it is MEDIUM and not higher — nobody sees data they
should not.

**Why it matters here.** `multidiscipline`'s athlete branch is where a child's
grappling-exposure history lives — the record of chokes and submissions applied
to a minor. An organization admin investigating a safeguarding concern gets a
403 from it today, and the failure will read as a bug in the page rather than a
role-list typo.

### [LOW] Any coach can claim, or overwrite, coverage of any scheduled class

The scheduler is otherwise the most carefully guarded route in the tree — it
calls `assertActiveCoachAccount` on a named coach before granting them anything,
and `assertCoachAssignedToAthlete` on both sides of a coaching-request approval.
One action does not follow suit:

> `apps/web/app/api/pilot/scheduler/route.ts:356-365` —
> ```
>     if (action === 'cover_class') {
>       if (!(actor.role === 'coach' || canManageAll(actor))) {
>         throw new Error('Forbidden: only coach/admin can cover classes');
>       }
>       const classId = requiredString(body.class_id, 'class_id');
>       const existingClass = await getSchedulerClassById(actor.organizationId, classId);
>       if (!existingClass) {
>         throw new Error('Missing class record');
>       }
>       await setSchedulerClassCover(actor.organizationId, classId, actor.accountId, new Date().toISOString());
> ```

`setSchedulerClassCover` is an unconditional `set covering_coach_account_id = $3`
(`schedulerDb.ts:156-164`) — it does not check that the slot is empty, so coach B
silently replaces coach A. And `covering_coach_account_id` is one of the three
things that make a coach the owner of a class:

> `apps/web/app/api/pilot/scheduler/route.ts:136-141` —
> ```
>   if (
>     classItem.coach_account_id === actor.accountId
>     || classItem.scheduled_by_account_id === actor.accountId
>     || classItem.covering_coach_account_id === actor.accountId
>   ) {
>     return;
> ```

**Refutation attempted, and it substantially reduced the severity.** I traced
what class ownership actually buys. Both attendance actions call
`assertCoachOwnsClass` *and then* `assertCanActOnAthlete` per athlete
(lines 644 and 658; 703 and 740), and the GET filters registrations, coaching
requests and attendance through `accessibleAthleteIds`. So a coach who claims a
class they have nothing to do with still cannot read or write any athlete row
they could not already reach. What they get is the class in their list, the
ability to displace the real cover, and a roster record naming them. That is an
integrity and audit problem, not a data-exposure one, which is why it is LOW.

### [LOW] `pilot.parents.account_id` has a single-column foreign key, so a cross-gym account id can be stored

Almost every athlete-bearing table in this schema carries a composite FK on
`(organization_id, athlete_id)` — that is what makes the prior audit's claim
about DB-level cross-tenant protection true. `pilot.parents` is an exception on
its account column:

> `infra/azure/pilot_slice_postgres.sql:267` — `  account_id text null references pilot.accounts(account_id),`

Combined with finding 1, the caller-supplied `account_id` reaching
`upsertGuardian` can name an account in a *different* organization, and the
database will accept it. It does not grant that account access — every read path
scopes by the session's `organizationId` — but it does detach the legitimate
guardian and leaves a row pointing across a tenant boundary. `pilot.volunteers`
has the identical shape at line 279; I did not trace whether any writer there
takes a caller-supplied account id.

**Refutation attempted.** I re-read `isGuardianLinkedToAthlete` and
`guardianAthleteIds` to confirm the read side is double-scoped — it is, on both
the link row and the parent row — which is why this is LOW rather than a
cross-tenant read.

## Checked and found sound

These are things I went looking for and did not find. Recording them so the
next reader does not spend the afternoon I spent.

**The primitives themselves have no fall-through.**
`assertActorCanAccessAthlete` ends in an unconditional throw
(`access.ts:321`), so an unknown or newly-added role is refused rather than
admitted; `accessibleAthleteIds` mirrors it (`access.ts:406`). Both
`requireRole` implementations refuse on non-membership rather than on
membership, so an empty allowlist refuses everyone. `requirePageRole` redirects
rather than admits. I found **no fail-open role gate anywhere** — every
authorization branch I read defaults to refusal.

**Organization scoping in SQL is genuinely tight.** My scanner over every
template-literal SQL statement naming a `pilot.*` table found 25 statements
without an `organization_id` predicate, and I read all 25. Every one is either a
session/token/rate-limit table keyed on a globally-unique id
(`session_tokens`, `magic_link_tokens`, `account_activation_tokens`,
`auth_rate_limit_buckets`), a background retention or archival sweep with no
actor (`purgeExpiredDeletedData`, `shadowArchival`, `shadowJobQueue` cleanup),
or a scan-worker settle path (`videoSessions.ts:210`, `:264`). Two looked wrong
and were not: `rabbitHoles.ts:429` builds its predicates dynamically and seeds
them with `const conditions = ['r.organization_id = $1']`; `dataDeletion.ts:63`
updates by bare `account_id` but is preceded in the same transaction by a
`where account_id = $1 and organization_id = $2 and role = 'parent'` existence
check. **I found no athlete, guardian, video, medical or message read that
omits the organization filter.**

**Caller-supplied `organization_id` is refused or ignored, never trusted.**
Five routes accept one. `admin/activation-codes` refuses a mismatch outright
(`resolveTargetOrganization`, line 32-34). `admin/capabilities` and
`admin/gym-capabilities` silently fall back to the session's org for anyone who
is not `platform_owner`. `platform/users/create` refuses a mismatch and its
comment records that this was previously the bug. `public/store` is the
anonymous catalogue and holds no athlete data by design. The `platform/*`
mutation family requires `platform_owner`, which
`assertActorCanAccessAthlete` separately refuses all athlete access to.

**The "one side checked, the other not" pattern is the exception, not the rule.**
I traced every two-party link write I could find by scanning for `insert into
pilot.*` statements carrying two or more entity ids (about 120 of them). The
ones reachable from a route validate both ends:
`addCompetitionEntry` checks the competition and the athlete against the org
before inserting; `addLeagueRosterEntry` does the same for the season and the
athlete; `assignBoardSeat` calls `assertEligibleHolder`, whose comment says
exactly why ("The table's foreign key only proves the account exists somewhere
on the platform"); `grantCoachCoverage` calls
`assertAthleteBelongsToOrganization` on the athlete *and*
`assertActiveCoachAccount` on the coach; the mentorship `POST` authorizes both
athletes with a comment explaining the principle; the scheduler's
coaching-request approval calls `assertActiveCoachAccount` then
`assertCoachAssignedToAthlete` on the named coach. Findings 1 and 4 are the two
exceptions I found.

**Guardian media consent cannot be forged through the intake route.** I chased
this specifically because `domain-upsert` writes `pilot.waivers`, which is the
table `assertGuardianMediaConsent` reads. The route's waiver branch does **not**
pass `parentId` (`domain-upsert:89-100`), and the consent query requires
`parent_id is not null`, so a coach cannot manufacture a signed media consent.
Adding a bogus guardian link can only *block* publication, since the check
requires every linked guardian to have signed. This one is fine.

**`medical_intake.clearance_status` gates nothing.** `domain-upsert` lets a
coach write an arbitrary `clearance_status` string. I grepped every read of
`pilot.medical_intake` in `apps/web/src`: it is written by `intake.ts:460`, read
back by `intake.ts:767` for the case aggregate, named in three privacy-tier
denylists, and read by no gate. So this is not a clearance bypass. (This is
consistent with the 2026-08-17 audit's §10 finding that the dead client-supplied
clearance boolean lives in `packages/execution/safetyGate.ts` and is not the
live path.)

**Dynamic-segment routes are not IDOR-prone.** All seven were opened.
`profile/photo/[accountId]` runs four gates in order and answers every refusal
with the same `hiddenNotFound()`, with the reasoning written out.
`video/[videoId]` scopes the lookup by `organization_id` and then calls
`assertActorCanAccessAthlete`. `shadow/sessions/[conversationId]` delegates to
`renameConversation`/`softDeleteConversation`, both of which are `where
conversation_id = $1 and organization_id = $2 and account_id = $3`.
`shadow/jobs/[jobId]` validates the UUID shape then delegates to
`getJobStatusForActor`. `session-scripts/runs/[runId]` names one action per
request specifically so a client cannot set a column by including a field.
`gym-photos/[slot]` allowlists the slot key against a manifest.

**The 14 unauthenticated routes are all deliberate.** Four public reads —
`announcements/public`, `floor-hours/public`, `wall`, `public/store` — never
accept a caller-supplied `organization_id`, and `wall` additionally omits
`athlete_id` entirely, hashes its keys, defaults names to initials and is
IP-budgeted. The nine auth entry points are the login/activation/magic-link/
Microsoft-OAuth surfaces. `payments/webhook` is signature-verified. Both
`admin/bootstrap` routes require `PPBF_PILOT_BOOTSTRAP_KEY` behind a shared
durable per-IP rate-limit bucket, and the non-Microsoft one refuses every path
by design.

**The 14 role-gate-free authenticated routes are all self-scoped or
policy-only.** `drill-library`, `session-scripts`, `workout-templates` and
`coach/cue-library` read the gym's own teaching material and carry no athlete
data (each says so in a comment, and `session-scripts` explicitly notes that
what happened on a given night lives in `session_script_runs`, which it does not
touch). `shadow/data`, `shadow/memory`, `shadow/capabilities`, `profile/me`,
`profile/photo`, `feedback/submit`, `auth/logout` act on the caller's own
record. `wall-of-names` and `gym-photos` derive everything from
`principal.organizationId`.

**The three routes with `isOrganizationAdminRole` but no `requireRole` are all
fail-closed inline.** `escalations` throws
`'Forbidden: escalations are available to coach and organization_admin/admin
only'`; `scheduler/attendance-summary` throws the equivalent and additionally
scopes a coach to classes they own; `shadow/research-bridge/session-export`
falls through to `throw new Error('Forbidden: organization_admin role or
cross-organization access required')` and derives its scope entirely from the
session, never from a parameter.

**Board and platform_owner isolation holds at the data layer.** Both are
refused by `assertActorCanAccessAthlete` before any other check
(`access.ts:288`, `:292`) and return an empty set from `accessibleAthleteIds`
(`access.ts:346-348`). I did not find a route that reaches athlete data for
either role without going through one of those two.

## Could not establish

**`docs/capabilities/NETWORK_STATUS.md` is not on this branch.** I read the copy
on `origin/docs/agent-handoff-briefs`. If a newer copy exists elsewhere, my
de-duplication against it is only as current as that branch.

**175 of 228 routes were classified but not opened.** I know which helpers each
imports and calls. I do not know whether the call sits on every path through the
handler, whether a second verb in the same file skips it, or whether a parameter
is used before it. The 138 routes that call `requirePrincipal` + `requireRole`
and nothing else are the population most likely to contain more instances of
finding 3, and I sampled rather than enumerated them.

**No runtime proof of anything.** I did not start the app, run a test, or issue
a request. Findings 1, 2, 3 and 4 all assert what a specific principal can do;
each should be reproduced with an actual coach session before it is treated as
confirmed. Finding 4 in particular depends on `endMentorship`'s `UPDATE`
committing before the throw, which is what the code says but not what I
observed.

**I could not determine whether finding 3 is a decision or an oversight.** The
eleven routes are consistent with each other and inconsistent with the four
routes that do scope coaches by roster. That could mean two build batches with
different assumptions, or it could mean someone decided that floor-staff
surfaces are org-wide on purpose and never wrote it down. `ORGANIZATION_ROLE_MODEL.md`
and `AUTH_CONTRACT.md` were outside the reading path this pass took, and I did
not open them; if either states a coach's read scope explicitly, it settles this
and I did not consult it.

**I did not trace the volunteer analogue of finding 8.** `pilot.volunteers` has
the same single-column `account_id` foreign key
(`infra/azure/pilot_slice_postgres.sql:279`). I did not check whether any route
writes it from a caller-supplied id.

**I did not verify the intake-promotion path.** `intake/review-action` writes
`pilot.parents` and `pilot.guardian_links` from `promotion.guardian.*` rather
than from caller input, which is why I set it aside — but that route is 550+
lines and I read only the two guardian call sites, not the code that builds
`promotion`.

**Open-PR state is from `git branch -r` on this clone, not from GitHub.** I
enumerated 143 remote branches and diffed the ones touching my findings' files,
but I did not query the live PR list, so a PR opened from a branch not yet
fetched here would be invisible to me. `docs/capabilities/NETWORK_STATUS.md`'s
own instruction is to query GitHub rather than trust a file, and I could not
follow it.

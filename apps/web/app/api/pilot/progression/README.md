# Progression visibility -- gates

## What this capability is

The closed-loop progression record -- development gaps a coach identified, the
drills assigned to close them, and the work logged and verified against those
drills -- and the four surfaces that read it:

- `app/coach/progression-intelligence` (staff: read plus the writes below)
- `app/athlete/progression-intelligence` (the athlete's own record)
- `app/parent/progression-visibility` (a guardian's read of their child's record)
- `components/ParentHub.tsx` (the same guardian's hub, which links to the above
  and renders the child's fight card beside it)

All four read the same rows through the routes in this directory:
`gaps/`, `assignments/`, `completions/`, plus `suggestions/` (staff-only
deterministic suggestions) and `gap-justification/`. The server module is
`src/server/pilot/progression.ts`.

Two separate things have to hold for a surface here to be correct, and this
document covers both:

1. **Per-viewer scoping**, server-side: whether this viewer may read this
   child's record at all.
2. **Per-viewer ordering**, client-side: whether the record on screen belongs
   to the child whose name is on screen. A guardian or coach who can legitimately
   read two children's records can still be shown the wrong one of the two, and
   no server-side gate can prevent that -- it is a property of how the browser
   sequences its own requests.

## What it may do

- Show a guardian their own linked child's gaps, assigned drills, due dates,
  completion percentages and verification statuses, in the same athlete-safe
  projection the child themselves reads.
- Show a coach the record of an athlete they are the coach of record for, or
  hold an unexpired coverage grant on.
- Let staff file a gap, assign a drill, and verify or dispute a logged
  completion.
- Show a coach, on the coach surface, that the selected athlete is under an
  active training hold -- as context, not as an enforced block.

## What it may NOT do

- Show any viewer a child they are not linked to, assigned to, or are not.
- Let a guardian log a completion. Logging work is the athlete's act on the
  floor or a coach's; a guardian's surface is read-only.
- Let a guardian or athlete file a gap or assign a drill.
- Render one child's record, card, or hold banner under another child's name --
  including transiently, for the length of a slow request.
- Clear, restrict or prescribe training. Nothing here reads
  `readinessMath.ts` / LEGACY-READINESS, which is registered
  `experimental_unsupported` and is deliberately unwired.

## Gates

### Server-side: who may read whose record

**An authenticated, fully provisioned session**
- what it checks: a resolvable principal, and that the account is not still on
  its bootstrap PIN.
- where it runs: `src/server/pilot/http.ts:requirePrincipal` (via
  `requirePrincipalAllowingPinChange`), called first in every handler in this
  directory.
- refuses with: `Unauthorized` / **401**; or
  `Forbidden: PIN change required before using this account` / **403**.
- why: a new athlete account is created on a PIN that is public knowledge, so
  the starting PIN must be able to read nothing at all.

**Role allow-list on the reads**
- what it checks: the viewer's role is one of coach, admin,
  organization_admin, athlete, parent.
- where it runs: `gaps/route.ts:GET`, `assignments/route.ts:GET`,
  `completions/route.ts:GET`, each via
  `src/server/pilot/access.ts:requireRole`.
- refuses with: `Forbidden: role not allowed` / **403**.
- why: the board and platform-owner roles have no business in an individual
  minor's development record; they are scoped to organization aggregates.

**A subject must be named**
- what it checks: `athlete_id` is present (`assignment_id` on the completions
  read).
- where it runs: `gaps/route.ts:GET`, `assignments/route.ts:GET`,
  `completions/route.ts:GET`.
- refuses with: `Missing athlete_id` / **400**, `Missing assignment_id` /
  **400** (the `Missing ` prefix is what `http.ts:jsonError` maps to 400).
- why: no route here has an "everyone" mode. A read with no subject would be
  an org-wide dump of children's records.

**Per-viewer relationship to that subject**
- what it checks: the specific relationship the viewer's role requires.
- where it runs: `src/server/pilot/access.ts:assertActorCanAccessAthlete`,
  called after the role check in each GET.
- refuses with, per role:
  - parent, via `isGuardianLinkedToAthlete` (`pilot.guardian_links`):
    `Forbidden: parent not linked to athlete` / **403**
  - coach, via `assertCoachAssignedToAthlete` -- `pilot.athletes.coach_id`, or
    an unexpired row in `pilot.coach_coverage`:
    `Forbidden: coach not assigned to athlete` / **403**
  - athlete: `Forbidden: athlete cannot access another athlete record` / **403**
  - organization_admin / admin, via `assertAthleteBelongsToOrganization`:
    `Forbidden: athlete does not belong to organization` / **403**
  - board: `Forbidden: board role is restricted to organization-level aggregates` / **403**
  - platform_owner: `Forbidden: platform owner cannot access organization-private athlete records by default` / **403**
- why: this is the gate the guardian-facing surfaces rest on entirely. A
  guardian reaches a child through the guardian link and nothing else, and a
  coach's access expires with their coverage grant without needing a cleanup
  job. The coach failure text is deliberately identical for "no relationship",
  "expired grant" and "revoked grant" -- the error channel does not disclose
  which.

**Completions are reached through their assignment, and refusals are hidden**
- what it checks: the assignment exists in this organization, then the same
  per-viewer gate against the athlete that assignment belongs to.
- where it runs: `completions/route.ts:GET`, via
  `progression.ts:getDrillAssignmentById` then
  `access.ts:assertActorCanAccessAthlete`, both failures funnelled through
  `http.ts:hiddenNotFound`.
- refuses with: `{"error":"Not found"}` / **404** -- not 403.
- why: this read is keyed by `assignment_id`, not by athlete. A 403 would
  confirm that a guessed assignment id is real, turning the endpoint into an
  enumerator for assignment ids belonging to children the caller cannot see.

**Writes are staff-only; a guardian's surface is read-only**
- what it checks: the writing role.
- where it runs: `gaps/route.ts:POST` and `assignments/route.ts:POST`
  (`['coach', 'admin', 'organization_admin']`); `completions/route.ts:POST`
  (`['athlete', 'coach', 'admin', 'organization_admin']` -- `parent` is absent).
- refuses with: `Forbidden: role not allowed` / **403**.
- why: a guardian reporting that their child did the work is not the same
  record as the child logging it or a coach verifying it, and the parent
  surfaces offer no affordance to try. The route refuses anyway, because a
  missing button is not a gate.

### Client-side: whose record is on screen

These guards do not decide who may see what -- that is settled above, on the
server. They decide which of two responses the viewer is *entitled to* actually
gets rendered, and under whose name. They have no refusal message by design: a
cancelled request is not a failure and must not become an error a guardian
reads.

**A superseded per-child load is cancelled, not left running**
- what it checks: whether the athlete/child this load was started for is still
  the selected one.
- where it runs:
  - `app/coach/progression-intelligence/page.tsx:reloadAthleteData` (one
    `AbortController` in `athleteLoadRef`, aborted by the next load and by the
    selection effect's cleanup) and its `training-holds` effect;
  - `components/ParentHub.tsx` -- the `activeChildId` fight-card effect and the
    roster effect (which re-runs on the Retry button);
  - `app/parent/progression-visibility/page.tsx` -- the `activeChildId`
    progression effect and the linked-children effect.
- refuses with: nothing rendered and nothing written. The superseded request is
  aborted; no message, no error state, no console noise.
- why: each of these loads is a *chain* (gaps and assignments, then one
  completions read per assignment), so two chains for two children resolve
  interleaved in whatever order the network returns them, and the loser can
  land last. That is how a guardian switching between two children was shown
  the first child's gaps, drills and logged work under the second child's name,
  and how a coach's screen could drop an active training hold: athlete A's "no
  active hold" answering after athlete B's hold. Aborting also stops the rest
  of the chain instead of paying for requests whose answers are already known
  to be discardable.

**A response already in flight when we aborted still cannot write state**
- what it checks: `signal.aborted`, re-checked after every `await` and before
  every `setState`.
- where it runs: all six effects/loaders listed immediately above.
- refuses with: nothing rendered and nothing written.
- why: `abort()` does not un-resolve a promise that has already settled, so the
  abort alone is not sufficient. This is the check that makes the ordering
  guarantee hold rather than merely narrow the window.

**An aborted request is not reported as a failure; a real failure still is**
- what it checks: `signal.aborted || (error instanceof Error && error.name === 'AbortError')`
  in every `catch` on these paths.
- where it runs: the same six places. On the coach page the check lives inside
  `reloadAthleteData`, which swallows aborts and rethrows everything else, so
  all five of its callers keep reporting genuine failures through
  `errorMessage` exactly as before.
- refuses with: nothing -- and, importantly, does not clear existing state. A
  real refusal or dead network still reaches each page's existing error surface
  (`errorMessage` on the coach page, the header `alert alert--critical` on the
  parent progression page, the plate on ParentHub).
- why: the first version of this bug class is showing the wrong child's record;
  the second is an aborted read's `catch` writing `null` and erasing the
  *current* child's hold or card. Both are the same failure wearing different
  clothes.

**Per-child state is matched to the current selection at render**
- what it checks: that the child a value was fetched for is the child now
  selected -- `activeHold.athleteId === selectedAthlete` on the coach page
  (`shownHold`), `childCard.athleteId === activeChildId` on ParentHub
  (`shownCard`).
- where it runs: `app/coach/progression-intelligence/page.tsx` and
  `components/ParentHub.tsx`, at render. Same shape as
  `components/RabbitHole.tsx`, which stores its anchor alongside the lessons it
  fetched for that anchor.
- refuses with: the section is not rendered at all.
- why: the abort guard settles which response wins, but not the window between
  tapping a new child and their answer arriving. For these two values absence
  is honest -- no hold banner means "this page knows of no hold", no card means
  "no card was read", both of which are exactly true mid-flight -- so the
  previous child's hold banner and fight card come down immediately instead of
  standing over the new name. A hold banner is a safety claim about one
  particular child's body, and a fight card is a child's face, handwritten ring
  name and coach; neither may be shown on the strength of a read about somebody
  else.

**Unmount cancels in-flight reads**
- what it checks: nothing -- it is the effect cleanup.
- where it runs: `return () => controller.abort()` on each effect listed above
  (`return () => athleteLoadRef.current?.abort()` on the coach page's selection
  effect).
- refuses with: nothing rendered and nothing written.
- why: these are client components a viewer navigates away from mid-request.
  Three of these effects previously had no cleanup at all.

## Deliberately not gated

- **The coach page's gap and assignment lists still show the previously loaded
  athlete for the length of one request.** The ordering guard settles which
  response wins, and the response that finally renders is always the selected
  athlete's -- but that page has no loading state for these lists, so the old
  rows stay visible until the new ones land. Clearing them without a loading
  state would put "No gaps identified yet." and "No drills assigned yet." on
  screen for an athlete nobody has read, trading a wrong-child display for a
  false-empty claim, and inventing that loading state was out of scope for this
  change. The hold banner and the parent surfaces do not have this window: the
  banner is matched at render (above), and
  `app/parent/progression-visibility/page.tsx` shows its existing "Loading
  progression data..." panel for the whole switch.
- **ParentHub's gym-wide one-shot reads** (`/api/pilot/parent/messages`,
  `/api/pilot/parent/safety`) carry no abort guard. They are not keyed to the
  selected child, so they cannot be superseded and carry no wrong-child risk.
  They can still write state after unmount, which is pre-existing and was left
  alone rather than widened into this change.
- **The athlete's own surface** (`app/athlete/progression-intelligence`)
  resolves its `athlete_id` once from the session and never re-keys it, so it
  has no selection to race. It was not changed and needs no ordering guard;
  its scoping is the same server-side gate documented above
  (`Forbidden: athlete cannot access another athlete record`).
- **No client-side authorization anywhere.** None of the client guards above
  decide what a viewer may see; they only decide which already-authorized
  response is displayed. Every access decision is the server's, and a surface
  that skipped its own guard would show the wrong child's record, not somebody
  else's forbidden one.
- **Rate limiting and read auditing** on these routes. Neither exists here; a
  viewer authorized for a child may read that child's progression record as
  often as they like, and the read is not written to an audit trail.
- **Training holds are not enforced against progression work.** The coach
  surface shows an active hold as context only. `progression.ts` has no rule
  connecting a hold to assignment or verification, and this change did not add
  one -- an owner decision, recorded in the page's own comment.

## Verified by

- `app/parent/progression-visibility/page.test.tsx` --
  `describe('request ordering when the guardian switches child')`:
  - "a slow answer for the child left behind never lands on the selected
    child's record" (pins the stale-response case: the first child's gaps
    resolve last and must not render under the second child's name)
  - "the superseded chain does not settle the page while the selected child is
    still loading" (pins the losing chain's `finally` not clearing
    `progressionLoading` into a false "No progression gaps on record")
  - plus the pre-existing tests that the empty state is withheld while loading,
    that a guardian with no linked athlete is told so, and that no
    completion-logging affordance exists.
- `components/parentHubChildSwitch.test.tsx` --
  `describe('request ordering when the guardian switches child')`:
  - "a slow card read for the child left behind never renders under the
    selected child's name" (the fight-card stale-response case)
  - "the previous child's card does not hang over the new name while the new
    read is open" (the render-time selection match)
- `app/coach/progression-intelligence/page.test.tsx` --
  `describe('request ordering when the coach changes athlete')`:
  - "a slow no-hold answer for the previous athlete cannot clear the selected
    athlete's hold banner"
  - "the previous athlete's hold banner does not stand over the newly selected
    athlete"
  - "a slow gaps answer for the previous athlete never lands under the selected
    athlete"
- Server-side scoping is pinned by the route tests beside each handler:
  `gaps/route.test.ts`, `assignments/route.test.ts`,
  `completions/route.test.ts`, `suggestions/route.test.ts`,
  `gap-justification/route.test.ts`; and the gate itself by
  `src/server/pilot/access.test.ts` and
  `src/server/pilot/guardianAccess.test.ts`. Those predate this change and
  were not modified by it.

All seven ordering tests were confirmed to fail against the unfixed pages and
pass against the fixed ones.

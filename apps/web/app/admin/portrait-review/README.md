# Admin portrait review -- gates

Documentation on disk. Nothing imports this file, no page renders it.

Capability home:

- console: `apps/web/app/admin/portrait-review/page.tsx`
- queue + decision route: `apps/web/app/api/pilot/admin/portrait-review/route.ts`
- review-only image route: `apps/web/app/api/pilot/admin/portrait-review/photo/[accountId]/route.ts`

## What this capability is

The one door out of `photo_review_state = 'pending_review'` for an organization
admin. A member uploads a portrait; it is visible to nobody but its uploader
until a human decides it (`src/server/pilot/profileVisibility.ts` states why the
decision must be a human's: "the platform cannot tell whether a photograph of a
child is an appropriate photograph of a child, and it must not pretend to").
This console lists what is waiting and takes that decision.

**What the reviewer is attesting to.** Approving is not bookkeeping. It is a
named adult saying: *I have looked at this photograph, and it is an appropriate
photograph of this member.* Most members here are children. Once released, the
portrait is shown to the athlete's own coaches and guardians under
`decidePortrait()`, and the reviewer's account is the only thing standing behind
that release.

**What they must have seen before they can attest.** The photograph itself, in
this console, painted on their screen. Before this change the console showed a
name and an upload timestamp and offered Approve -- the review step could not do
the one job it exists for.

## What it may do

- List every portrait in this organization sitting in `pending_review`
  (`listPendingReviewPortraits`), with the member's name and upload time.
- Show one pending portrait at a time, on request, to the reviewing admin.
- Release a pending portrait (`releasePhoto`, compare-and-swap on
  `pending_review`) or block it and delete the bytes (`clearPhoto` then
  `deletePilotProfilePhoto`).
- Write an audit event for the view and for the decision.

## What it may NOT do

- Serve a portrait in any state other than `pending_review`. A released
  photograph goes back under `decidePortrait()`, which keeps an admin outside a
  minor's `MINOR_CIRCLE`; a blocked one has had its bytes deleted.
- Widen `access.ts`'s athlete boundary or cross an organization.
- Approve a portrait the reviewer has not had on screen.
- Approve on a single click.
- Reach the Next image optimizer. The optimizer fetches and caches on the
  server, and a cached copy of an undecided child's face would outlive both the
  role check and the review state. Bare `<img>`, deliberately -- the same
  reasoning `components/ProfilePortrait.tsx` and `app/admin/customize/page.tsx`
  already write out.
- Decide a portrait another reviewer has already decided.
- Be used by a coach. Coaches release their own athletes' portraits through
  `app/api/pilot/profile/photo/review`, which has its own, different gate.

## Gates

### 1. Organization admin only, on every part of the capability

- **checks**: `principal.role` is `organization_admin` or `admin`.
- **where**: `app/api/pilot/admin/portrait-review/route.ts` `GET`/`POST`, and
  `app/api/pilot/admin/portrait-review/photo/[accountId]/route.ts` `GET`, all via
  `requireRole` from `src/server/pilot/access.ts`.
- **refuses with**: `403` `{"error":"Forbidden"}`.
- **why**: the console can put a child's undecided photograph on a screen. The
  view route runs this check before it looks anything up, so a refused caller
  learns nothing about whether that child has a photograph at all.

### 2. The image route serves `pending_review` and nothing else

- **checks**: `profile.photoReviewState === 'pending_review'` (and
  `photoBlobPath !== null`).
- **where**: `app/api/pilot/admin/portrait-review/photo/[accountId]/route.ts`
  `GET`.
- **refuses with**: `404` `{"error":"Not found"}` (`hiddenNotFound()`).
- **why**: this route is the narrow exception that lets an admin see a face
  `profileVisibility.ts` would otherwise refuse them. Bounding it to the
  undecided state means the exception is exactly as wide as the decision it
  supports: it is not a general admin backdoor to a released minor's portrait,
  and it cannot pull a rejected photograph back up.

### 3. The existing child-account boundary runs first, and refuses as a 404

- **checks**: `assertViewerMayReachSubject` -> `assertActorCanAccessAthlete`
  (`access.ts`), plus organization scoping in `getSubjectIdentity`.
- **where**: `app/api/pilot/admin/portrait-review/photo/[accountId]/route.ts`
  `GET`.
- **refuses with**: `404` `{"error":"Not found"}` -- identical to "no such
  account" and "no photo on file".
- **why**: nothing about portraits may widen the platform's athlete boundary,
  and a distinct 403 would itself disclose that this child exists and has a
  photograph.

### 4. Looking at a child's portrait is recorded before the bytes are handed over

- **checks**: nothing -- it records. `writePilotAuditEvent` runs after the blob
  download and before the response is constructed.
- **where**: `app/api/pilot/admin/portrait-review/photo/[accountId]/route.ts`
  `GET`; `event_type: 'update'`, `entity_type: 'account_profile_photo'`,
  `details.action: 'portrait_review_image_viewed'`.
- **refuses with**: an audit write that fails takes the image with it --
  `500` `{"error":"Internal server error"}` from `jsonError`, and no bytes.
- **why**: who looked at which child's face has to be answerable afterwards
  (same posture as `app/api/pilot/video/review-link`). Failing closed is the
  safe direction: a reviewer who cannot see the portrait cannot approve it.
  `event_type` is `'update'` because `auditEventTypes.ts` has no read/view value
  and adding one requires a migration; the truth is in `details.action`.

### 5. Approve is refused until the reviewer has seen THIS photograph

- **checks**: `inspectedPortraitKeys.has(`account_id::uploaded_at`)`, set only by
  the portrait `<img>`'s `onLoad` -- the browser having decoded and painted the
  bytes.
- **where**: `app/admin/portrait-review/page.tsx` -- `decide()` returns early for
  `approve`, and the Approve button carries `disabled={isBusy || !isInspected}`.
- **refuses with**: no request is sent. The row renders a `.stamp` reading
  **NOT VIEWED** plus the sentence "Look at this portrait before approving it.
  Rejecting does not require it." (Law 7: a refusal is a stamp, not a toast;
  Law 3's corollary: a greyed control must say why.)
- **why**: the failure this whole change exists to fix -- a reviewer attesting to
  the appropriateness of a photograph of a minor while looking at metadata only.
  Mirrors the watch gate on `app/admin/video-review/page.tsx` (PR #421).
  Keyed on `account_id + photo_uploaded_at`, not the account alone: a portrait is
  a mutable slot on the account row, so a member can replace a pending photo
  while the queue is open, and a look at the first photograph must not authorise
  releasing the second.

### 6. A portrait that would not load is not an inspection

- **checks**: the `<img>`'s `onError` records the key as unavailable and never as
  inspected.
- **where**: `app/admin/portrait-review/page.tsx`, the portrait panel.
- **refuses with**: Approve stays disabled; the panel renders a `.stamp` reading
  **PORTRAIT UNAVAILABLE** and tells the reviewer to reload or reject rather than
  release a photograph nobody has seen.
- **why**: a 404 (already decided by another reviewer, or the bytes deleted) or a
  file that will not decode must not be able to unlock a release. Video review
  records an inspection only after its link request resolves; this is the same
  rule one step later, at the paint.

### 7. Approve requires an explicit, worded confirmation

- **checks**: `window.confirm`, on `approve` only.
- **where**: `app/admin/portrait-review/page.tsx` `decide()`.
- **refuses with**: cancelling sends no request. The wording names the member and
  states what is being attested: "You are attesting that you have looked at the
  photograph above and that it is an appropriate photograph of this member."
- **why**: releasing is the irreversible direction, and a one-click release of a
  child's photograph is the friction pointing the wrong way. Same pattern and
  same reasoning as `admin/video-review`'s approve confirm.

### 8. Two reviewers cannot both decide the same portrait

- **checks**: `releasePhoto` / `clearPhoto` are compare-and-swap on
  `expectedCurrentState = 'pending_review'`; the blob is deleted only after the
  swap wins.
- **where**: `app/api/pilot/admin/portrait-review/route.ts` `POST` (pre-existing,
  unchanged by this work).
- **refuses with**: `400`
  `{"error":"Unsupported: portrait was already decided by another reviewer"}`.
- **why**: two admins with the queue open must not overwrite each other, and a
  losing reject must not delete a photograph the winner just released.

## Deliberately not gated

- **The view requirement is enforced in the browser, not on the server.** `POST
  /api/pilot/admin/portrait-review` still accepts `{account_id, decision}` with
  no attestation field, so an authenticated organization admin using `curl` can
  approve a portrait they never fetched. This is stated plainly because it is
  true: the gate is a gate on the console, not on the route. No server-side
  *proof* of having looked is available -- a self-reported "I viewed it" flag
  would be a claim the server cannot check, and real proof would need new
  per-view state and therefore a migration, which this change may not add. What
  the server does give is evidence after the fact: the view is audited (gate 4)
  and the decision is audited, so an approval with no matching
  `portrait_review_image_viewed` event for that reviewer and account is visible
  in the audit trail. The same posture as the video watch gate in PR #421.
- **Rejecting requires nothing.** No inspection, and the pre-existing confirm
  only warns that the bytes are deleted. Refusing a photograph is the safe
  direction, and a reviewer who wants a photo of a child taken down must never be
  slowed down.
- **Showing a portrait is not itself confirmed.** One click reveals the
  photograph, because that click is the reviewer doing their job. Only one
  portrait is on screen at a time and none is fetched until asked for, which is
  the whole of the protection against a wall of children's faces in a shared
  office.
- **The console assumes a sighted reviewer.** The gate requires that the bytes
  painted, not that a human understood them; it cannot require the second. A
  reviewer who cannot see a photograph cannot review a photograph, and the
  platform does not pretend otherwise.
- **No rate limit on the image route** and no cap on how many portraits one admin
  may open in a session. Each view is audited, which is the control that exists.
- **No bulk approve.** Deliberately still absent (it was already out of scope for
  this console): a bulk control would have to carry gate 5 per portrait, which is
  the opposite of what a bulk control is for.
- **Already-released portraits cannot be re-reviewed here.** Takedown of a
  released photograph is `profile/photo/review`'s `block`, not this console.

## Verified by

- `apps/web/app/admin/portrait-review/page.test.tsx` -- 15 tests. Pins: nothing
  is fetched until the reviewer asks; the portrait comes from the review-only
  route and not the released read path; Approve is disabled, stamped NOT VIEWED
  and sends no request before the portrait is seen; a failed image load is not an
  inspection; one member's portrait does not unlock another's; a replaced photo
  re-locks Approve; Approve works after the portrait is seen and confirmed;
  cancelling the confirm abandons the release; Reject still works with no
  inspection anywhere in the test.
- `apps/web/app/api/pilot/admin/portrait-review/photo/[accountId]/route.test.ts`
  -- 12 tests. Pins: an admin receives the real bytes; the no-store/nosniff/CSP
  headers; the view is audited; an audit failure yields no image; every non-admin
  role is refused before any lookup; released, blocked, removed, missing-photo,
  unknown-account and boundary-refused all answer the same hidden 404.
- `apps/web/app/api/pilot/admin/portrait-review/route.test.ts` -- pre-existing,
  unchanged: the role gate and the compare-and-swap on the decision itself.
- `apps/web/components/designSystemClasses.test.ts` -- the `stamp--sm` /
  `stamp--flat` marks used for the refusals are real design-system classes.

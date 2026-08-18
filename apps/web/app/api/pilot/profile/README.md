# Member profiles, portraits and ring names -- gates

Documentation on disk. Nothing imports this file, it is not under `public/`, and
no page renders it.

Written from what the code does on `origin/main` at `04dd116b`.

## What this capability is

A member's face and chosen name, and the rule that decides who may see them.
This is the strictest privacy tier in the platform
(`privacyTiers.ts` names it `minor_circle`).

Routes under `app/api/pilot/profile/`:

- `photo/route.ts` -- `POST` upload **your own** portrait, `DELETE` remove it.
- `photo/[accountId]/route.ts` -- serve one portrait as an authenticated byte
  stream.
- `photo/review/route.ts` -- an admin or the athlete's own coach releases or
  blocks a pending portrait.
- `card/route.ts` -- one member's "fight card", assembled as this viewer is
  allowed to see it.
- `roster/route.ts` -- a coach's roster, with faces.
- `me/route.ts`, `nickname/route.ts`, `nickname/clear/route.ts` -- own profile
  and ring name.

Server modules: `src/server/pilot/profileVisibility.ts` (the whole privacy
decision, pure, no I/O), `profileDb.ts` (relationship resolution and storage),
`profilePhotoPolicy.ts` (what bytes are acceptable), `profileIdentity.ts` (card
assembly and initials).

## The consent model does not cover display -- and this capability says so

`profileVisibility.ts` opens by stating it: `pilot.waivers` is a freeform
document record whose every writer defaults `waiver_type` to `'general'`, and
`public_interest_submissions.consent_to_contact` is an adult agreeing to be
emailed. Neither is a release to show a child's face to anybody. So this module
**does not look for consent, because there is none to find**. It decides on
RELATIONSHIP instead.

That is a different mechanism from the `photo_media` guardian consent gate
documented at `app/api/pilot/parent/consent/README.md`, which governs *video
publication and AI analysis*. Nothing connects the two. A guardian who withdraws
`photo_media` consent does **not** cause their child's portrait to stop being
served -- see "Deliberately not gated".

## What it may do

- Let any signed-in member upload one portrait of **themselves**.
- Strip EXIF/XMP/IPTC and PNG text chunks from every stored portrait, exactly,
  before it reaches the container.
- Show a member their own pending portrait, so uploading gives feedback without
  releasing anything.
- Show a released portrait to the three parties who already see the child in the
  physical gym: the child, the coaches who train them, the guardians who bring
  them.
- Let an organization admin or one of the athlete's own coaches release a pending
  portrait, or block it -- which deletes the bytes.
- Serve a coach's whole-organization roster with plates for the children who are
  not theirs.

## What it may NOT do

- It may not let an adult upload a photograph of a child (gate 1).
- It may not show a minor's released portrait to an organization admin, the
  board, the platform owner, or another family (gate 5).
- It may not mint a shareable link to any portrait (gate 4).
- It may not accept a format whose metadata it cannot strip exactly (gate 2).
- It may not tell a caller *why* a portrait was withheld (gate 6).
- It may not treat an unknown age, an unreadable review state, or an
  unrecognised relationship as permission (gate 7).
- It may not let a coach release the portrait of a child they do not coach
  (gate 8).

## What must be true before a child's photograph reaches a screen

All of these, in this order. Every failure produces the same brass plate or the
same 404.

| # | Must be true | Where it is decided | If it is not |
|---|---|---|---|
| 1 | A live, non-bootstrap session | `http.ts:requirePrincipal` | 401 / 403 |
| 2 | The subject account exists in the viewer's organization | `profileDb.ts:getSubjectIdentity` | 404 `Not found` |
| 3 | The viewer may reach the subject's athlete record at all | `profileDb.ts:assertViewerMayReachSubject` -> `access.ts:assertActorCanAccessAthlete` | 404 `Not found` |
| 4 | A photo exists and `photo_review_state = 'released'` | `profileVisibility.ts:decidePortrait` | plate / 404 |
| 5 | For a minor: the viewer is `self`, `coach_of_subject`, or `guardian_of_subject` | `profileVisibility.ts:MINOR_CIRCLE` | plate / 404 |
| 6 | The bytes are still in the container | `blob.ts:downloadPilotProfilePhoto` | 404 |

Nothing else is required: no feature flag, no environment variable. This is live
on `main` today.

## Gates

### Gate 1 -- you upload your own face and nobody else's

- **What it checks:** structurally, not by comparison. `POST
  /api/pilot/profile/photo` **takes no account id at all**; the blob path and the
  database row are both derived from `principal.accountId`.
- **Where it runs:** `app/api/pilot/profile/photo/route.ts:POST` -- the path is
  `portrait/${principal.organizationId}/${principal.accountId}/${generatedFileName}`
  and `profileDb.ts:setPhoto` is called with `principal.accountId`.
- **What it refuses with:** nothing -- there is no request shape that expresses
  the forbidden action.
- **Why it exists:** stated in the route's own header: "a coach cannot upload a
  photograph of an athlete, and a guardian cannot upload one of their child.
  That is a policy decision, not an oversight: a portrait is a thing you put up
  about yourself, and letting an adult publish a picture of a child from a form
  that never showed the child the picture is the wrong shape for this platform."
  Staff can TAKE ONE DOWN, which is the direction that needs to be easy.
- **A gate expressed as an absent parameter is the strongest kind:** there is no
  authorization check to get wrong, and no future call site can pass the wrong
  id.

### Gate 2 -- only formats whose metadata this platform can remove exactly

- **What it checks:** three things on the bytes, none of them taken from the
  request:
  - the declared extension must be `.jpg`/`.jpeg`/`.png` **and**
    `file.type` must equal the type that extension implies;
  - the file header must actually parse as that format -- the signature check
    and the dimension read are the same operation;
  - the measured long edge <= 640px, short edge >= 96px, size <= 1.5 MB.
- **Where it runs:** `profilePhotoPolicy.ts:validateProfilePhotoTransport`
  (headers), `:describeProfilePhotoUpload` (declared name/type/size),
  `:validateProfilePhotoContent` -> `:readImageDimensions` ->
  `:pngDimensions` / `:jpegDimensions` (the bytes).
- **What it refuses with:** 415 `A multipart photo upload is required.`;
  411 `A bounded Content-Length is required.`;
  413 `The photo upload is too large.` / `The photo is empty or too large.`;
  415 `Only bounded JPEG and PNG photos are accepted.`;
  415 `The photo content does not match its declared file type.`;
  413 `Photos are stored at 512px. This one is <N>px on its long edge -- resize it and try again.`;
  400 `A portrait needs to be at least 96px on its short edge.`
- **Why it exists:** two reasons, both in the module header.
  1. *Dimensions are measured, not asked for.* The browser downscales before
     upload, "but the browser is not the authority on anything" -- a client that
     skips the downscale gets a 413, not a 12MP blob in the container. Forty
     12-megapixel decodes in a roster grid is a gym tablet's whole budget.
  2. *Metadata is stripped server-side.* A phone photo carries EXIF, and EXIF
     routinely carries GPS, a device serial and an embedded thumbnail that
     survives cropping. "On a platform holding children's records, storing a
     child's portrait with the coordinates of the house it was taken in is not
     an acceptable default." WebP and HEIC are refused **despite being common**
     because stripping them correctly needs a decoder this platform does not
     ship, and "accepting one it cannot would quietly break the guarantee for
     everyone." GIF is out because an animated portrait is not a portrait; SVG
     because "it is a script host wearing an image's file extension."
- **The JPEG walk is exact, not a scan.** `jpegDimensions` walks the marker
  stream using each segment's own length, because "a scan finds `SOF` inside an
  embedded EXIF thumbnail and reports the thumbnail's dimensions."
- **Stripping happens before storing, never after:** "a portrait that reaches
  the container with its EXIF intact has already leaked the coordinates it was
  taken at, and a later cleanup pass cannot un-store it."

### Gate 3 -- a portrait is born pending, and a person has to move it

- **What it checks:** `photo_review_state`. `pending_review` on upload;
  only `'released'` is visible to anyone but the uploader.
- **Where it runs:** written as `pending_review` by
  `profileDb.ts:setPhoto`; the exit is
  `app/api/pilot/profile/photo/review/route.ts:POST` calling
  `profileDb.ts:releasePhoto` or `:clearPhoto`.
- **What it refuses with:** for a non-self viewer, the plate
  (`reason: 'not_released'`) and a 404 on the byte route. The upload response
  itself says so:
  `Uploaded. Only you can see it until a coach or an administrator releases it.`
- **Why it exists:** the state machine has an exit **that exists in the code**.
  `profileVisibility.ts` names the failure it is avoiding: "the video pipeline
  shipped a quarantine state with no exit and every upload died in it". The
  review is a human on purpose -- "the platform cannot tell whether a photograph
  of a child is an appropriate photograph of a child, and it must not pretend
  to." A classifier that claimed to would be worse than none, "because everyone
  downstream would believe it."
- **`block` takes the bytes with it.** `photo/review/route.ts` calls
  `deletePilotProfilePhoto` before `clearPhoto(..., 'blocked', ...)`, because
  "a blocked photograph that stays in the container is a photograph somebody
  with the storage key can still see."
- **A takedown beats self-access.** `decidePortrait`'s `self` branch returns the
  plate for `blocked` and `removed`: "if a coach took the picture down, it is
  down for the uploader too, which is what makes a takedown a takedown."

### Gate 4 -- portraits are an authenticated byte stream, never a link

- **What it checks:** nothing per-request; it is an absence. No SAS URL is
  minted for the portrait container.
- **Where it runs:** `app/api/pilot/profile/photo/[accountId]/route.ts` returns
  the bytes directly from `blob.ts:downloadPilotProfilePhoto`. Contrast the video
  container, where `blob.ts:getPilotVideoSasUrl` exists and is used.
- **Response headers that are part of the gate:**
  `Cache-Control: private, no-store, max-age=0`,
  `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox`,
  `Content-Disposition: inline`.
- **Why it exists:** "a signed URL to a child's face is a bearer capability that
  outlives the session, survives being pasted into a chat window, and has no
  idea who is holding it." `no-store` rather than `max-age` because "a
  photograph whose release is revoked has to stop being served, and a shared
  cache holding a child's face for an hour after a guardian asked for it to come
  down defeats the takedown."

### Gate 5 -- a minor's face never leaves the minor circle

- **What it checks:** for a subject who has an athlete record and is a minor,
  that the viewer's relationship is in
  `profileVisibility.ts:MINOR_CIRCLE = ['self', 'coach_of_subject', 'guardian_of_subject']`.
- **Where it runs:** `profileVisibility.ts:decidePortrait` (the decision, pure)
  and `profileVisibility.ts:decideRingName` (the same set, for the chosen name).
  The relationship comes from `profileDb.ts:resolveRelationship`.
- **What it refuses with:** `{ show: 'plate', reason: 'minor_outside_own_circle' }`,
  which the byte route turns into a 404 and the card route turns into
  `photoAvailable: false`.
- **Who is OUTSIDE the circle, by name:** the organization's own administrators,
  the board, and the platform owner. `resolveRelationship` refuses
  `platform_owner` and `board` explicitly before any join runs, and an admin
  resolves to `organization_staff` -- which is not in the set.
- **Why it exists, and why it is stricter than the record boundary:**
  "`access.ts` lets an `organization_admin` read any athlete record in their
  organization, and that is right for a record; it is not right for a
  photograph of somebody's twelve-year-old." This module sits **on top of** the
  existing boundary and never beside it: `profileDb.ts` calls
  `assertActorCanAccessAthlete` first, "so nothing here can widen what
  `access.ts` already refused, and then narrows further for faces."
- **`MINOR_CIRCLE` is written out rather than derived**, "so widening it is an
  edit somebody has to make on purpose."
- **The cross-family boundary is one return statement.** In
  `resolveRelationship`, a `parent` viewer not linked to *this* athlete returns
  `'none'`, not `'organization_staff'`.
- **The ring name is scoped identically.** `decideRingName` applies the same
  `MINOR_CIRCLE` test: "it is a smaller disclosure than a photograph but it is
  the same kind". That is also what makes the no-wordlist moderation decision
  defensible -- "an unmoderated string only three named parties can read is a
  bounded problem." A cleared ring name is nobody's to see, including the
  athlete's own.

### Gate 6 -- every refusal is the same 404, and the card cannot be read backwards

- **What it checks:** nothing; it constrains the *shape* of every refusal.
- **Where it runs:** `app/api/pilot/profile/photo/[accountId]/route.ts` returns
  `hiddenNotFound()` for "no such account", "no photo", "not released" and "not
  your family" alike -- including by catching
  `assertViewerMayReachSubject`'s throw, whose own 403 would answer the
  question. `app/api/pilot/profile/card/route.ts` assembles the card **after**
  the visibility decision.
- **Why it exists:** "a viewer who is told '403, you may not see this child's
  photo' has been told that this child has a photo, which is itself a disclosure
  about that child." On the card: `photoAvailable: false` and `ringName: null`
  are the same values a member with no photo and no ring name produces, "so the
  response cannot be read backwards to learn that a hidden photograph exists."
- **The plate is not an error.** "The caller renders the brass plate. It is not
  told why, and it does not need to know -- the plate is a finished object, not
  an error state." (Design-system Law 7 in its natural home.)

### Gate 7 -- every unknown resolves to less

- **What it checks:** three defaults, each in the safe direction.
  - **Unknown age is a minor.** `decidePortrait` calls
    `wallDisplay.ts:isMinor(subject.dob, now)`, and a null `dob` is a minor: "a
    gym whose records are incomplete must not have that read as 'adult, publish
    freely'."
  - **An unreadable review state has not been released.**
    `profileVisibility.ts:normalizePhotoReviewState` maps anything outside the
    four known values -- including `''` -- to `'pending_review'`.
  - **A different organization is `'none'`.** `resolveRelationship`'s first
    check: "a different organization is a different building. Nothing crosses
    it."
- **Where it runs:** `profileVisibility.ts` (pure) and
  `profileDb.ts:resolveRelationship`.
- **Why it exists:** the module states it as a rule -- "DEFAULT TO LESS. Every
  unknown in this file resolves to the plate."
- **Why the decision is pure and DB-free:** "the rule that decides whether a
  child's photograph reaches a screen has to be testable without a database, and
  it has to be readable in one sitting." `privacyTiers.ts` explicitly refuses to
  put a lookup in front of it.

### Gate 8 -- a coach may only release the portraits of children they coach

- **What it checks:** on the review decision, that the actor is an organization
  admin **or** that `resolveRelationship` returned `coach_of_subject` or `self`.
- **Where it runs:** `app/api/pilot/profile/photo/review/route.ts:POST`, after
  `requireRole(principal, ['organization_admin', 'admin', 'coach'])` and after
  `assertViewerMayReachSubject`.
- **What it refuses with:** 404 `Not found` (`hiddenNotFound()`), so a coach
  cannot probe which accounts have a pending portrait. Also 400
  `account_id is required.` and 400 `decision must be "release" or "block".`
- **Why it exists:** the route says it -- "a coach with an unassigned athlete
  resolves to `organization_staff`, which is not enough to release a face." The
  role tuple alone would have admitted any coach in the gym.

### Gate 9 -- the roster runs the whole decision per row

- **What it checks:** `decidePortrait` and `decideRingName`, once for **every**
  roster row, with the same relationship resolution as the single-portrait route.
- **Where it runs:** `app/api/pilot/profile/roster/route.ts:GET`.
- **Why it exists:** `scope=organization` "changes WHICH ROWS come back -- never
  what may be seen on one." A coach browsing the whole gym gets plates for the
  children who are not theirs, produced by the same function that serves the
  bytes, so the two cannot disagree. The card route does the same for the coach
  in a member's corner: that portrait "runs the whole gate again from the
  VIEWER's standpoint."
- **Two things the roster deliberately does not carry:** readiness and injury
  flags, and attendance. "The coach roster component already documents that none
  of those has a backend feed and that fabricating them is a safety bug, not a
  cosmetic one."

## Deliberately not gated

- **Guardian `photo_media` consent does not gate portrait display.** These are
  two unconnected mechanisms, by design and stated as such in
  `profileVisibility.ts`. A guardian who withdraws media consent stops video
  publication and Film Study (see `app/api/pilot/parent/consent/README.md`) and
  does **not** un-release their child's portrait. A guardian who wants a
  portrait down asks a coach or admin to `block` it. That is a real seam
  between two capabilities that both answer "who may see this child", and
  nothing today reconciles them.
- **A guardian cannot block their own child's portrait.**
  `photo/review/route.ts` admits `organization_admin`, `admin` and `coach` only.
  A parent has no route that takes a portrait down; they can only ask.
- **The portrait routes have no route-level tests.** There is no
  `app/api/pilot/profile/**/route.test.ts` anywhere in the tree. The *decision*
  is thoroughly unit-tested (see "Verified by"), but the wiring -- that
  `[accountId]/route.ts` really calls `assertViewerMayReachSubject` before
  `decidePortrait`, that it really returns `hiddenNotFound()` rather than the
  bytes, that the `no-store` headers are really set -- is pinned by nothing. A
  refactor could reorder those four gates and every existing test would still
  pass. This is the most significant verification gap on this capability.
- **Additional review-decision gates are being added on branch
  `fix/portrait-review-must-show-image`** (a sibling lane, not merged and not
  present in this branch): requiring that the reviewer actually rendered the
  photograph before Approve is accepted, a worded attestation, a review-only
  image route restricted to `pending_review` portraits, and an audit row before
  the bytes are handed over. Nothing in *this* file describes those as existing.
  On `main` today, `photo/review/route.ts` accepts a `release` decision without
  any evidence that the deciding human ever looked at the image.
- **One portrait per account, and no history.** The blob path is derived from
  the account, so "a replacement overwrites rather than accumulating a history of
  a child's faces in a container." No gate is needed because no history exists.
- **Rate limiting is borrowed, not specific.** `photo/route.ts:POST` calls
  `enforceShadowRateLimit` with `resolveShadowRateLimit('shadow_upload')` -- the
  SHADOW upload budget, not a portrait-specific one. Refuses with 429 and a
  `Retry-After` header.
- **`nickname` content is not moderated.** No wordlist, deliberately -- see
  gate 5's note and `profileIdentity.ts`. The control is the audience, not the
  string.
- **The stored filename is generated, and that is not a gate.**
  `describeProfilePhotoUpload` returns `portrait.jpg`/`portrait.png`: "a blob
  path is read by staff and appears in logs; `my_kid_at_home_2019.jpg` does not
  need to be in either." A hygiene measure, listed so it is not mistaken for an
  access control.

## Verified by

- `src/server/pilot/profileVisibility.test.ts` -- the decision itself:
  `a minor's photograph never leaves their own circle` (gate 5, including the
  admin, board and platform-owner exclusions),
  `a photograph nobody has looked at is nobody else's to see` (gate 3, and the
  self-sees-own-pending case),
  `an adult member`, `a staff member's face is how "who is in your corner" works`,
  `the ring name travels with the face` (gate 5 for `decideRingName`, and the
  cleared-name case),
  `resolveRelationship is the cross-family boundary` (gate 7's organization
  check and the unlinked-parent `'none'`),
  `staff names come from what the platform actually knows`.
- `src/server/pilot/profilePhotoPolicy.test.ts` -- gate 2: the transport
  refusals, the extension/`type` mismatch, the PNG and JPEG dimension walks, the
  edge bounds, and that `stripJpegMetadata` / `stripPngMetadata` remove APPn,
  comment, `eXIf` and text chunks while leaving the image byte-identical to a
  decoder.
- `src/server/pilot/profileIdentity.privacy.test.ts` and
  `profileIdentity.test.ts` -- card assembly and initials.
- `src/server/pilot/privacyTiers.test.ts` -- asserts that the modules each tier
  names as `enforcedBy` still exist and still hold the invariant the tier claims,
  including `profileVisibility.ts#decidePortrait` for `minor_circle`.
- `src/server/pilot/access.test.ts` -- the floor under gate 3
  (`assertActorCanAccessAthlete`), and `assertAthleteUpdateAllowed`'s
  `coach cannot change coach assignment`, which is what stops a coach writing
  themselves into `coach_of_subject` and thereby into the minor circle.
- **Nothing verifies the routes.** See "Deliberately not gated".

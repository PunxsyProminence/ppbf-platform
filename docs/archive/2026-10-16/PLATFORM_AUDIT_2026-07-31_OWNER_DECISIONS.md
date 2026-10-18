# Platform audit 2026-07-31 — decisions that need the owner

> **All 13 items below were decided by the owner on 2026-07-31.** What was
> chosen, and why, is recorded in
> [`PLATFORM_AUDIT_2026-07-31_DECISIONS_MADE.md`](PLATFORM_AUDIT_2026-07-31_DECISIONS_MADE.md).
> This file is kept as the record of what was *asked* — the problem statements
> and the options weighed. Read it for the reasoning behind a question; read
> the other file for the answer.


A full-platform audit (UI, usability, front-end wiring, backend, API
consistency, repo hygiene) ran on 2026-07-31 against `main` at commit
`7772250`. Seven finder agents produced 110 raw findings; duplicates were
merged and every finding was handed to an adversarial verifier whose job was
to refute it.

Everything the audit found that could be fixed **without a product, policy, or
money decision** was fixed and is in the accompanying pull request. This
document is the remainder: defects whose *repair* requires a choice only the
owner can make. Nothing here is a style preference — each one is a real defect
with a real user consequence.

Each item records what a user experiences today, the decision to make, and the
cheapest option. Delete an item when it is decided and done.

---

## 1. Invited staff and volunteers can never sign in — HIGH

**Today:** An organization admin invites a volunteer from `/admin/people`. The
volunteer clicks *Continue With Microsoft*, authenticates successfully, and is
bounced to `/login` with an error. There is no PIN alternative (PIN login is
athlete-only), so an invited staff member or volunteer can never enter the
platform. Each attempt also leaves an orphaned session-token row in Postgres.

**Cause:** `getPilotRoleDestination` has no landing page for `staff` or
`volunteer`, so the callback throws. The invite UI offers both roles anyway,
and the SHADOW routes explicitly allow both — the roles were intended to work.

**Decision:** Where do staff and volunteers land when they sign in?
- **Cheapest:** point both at an existing surface (`/operations` or the
  volunteer roster) and add them to `getPilotRoleDestination` +
  `mapPilotRoleToClubRole`.
- **Alternative:** remove both roles from the invite UI until a workspace
  exists — honest, but it removes a capability the People console advertises.

Either way the destination check should move *before* the session-token insert
so a refused sign-in stops minting tokens.

**Files:** `apps/web/app/api/pilot/auth/microsoft/callback/route.ts:186`,
`apps/web/src/shared/pilotRoleRouting.ts`, `apps/web/components/roleSession.ts`

---

## 2. The capability console silently discards every edit you make — HIGH

**Today:** You (platform owner) open `/admin`. The page admits you. The
capability registry fails to load, so the console silently renders a hardcoded
seed list instead of your organization's saved registry. Every toggle, archive,
and new capability you create fires a background save that returns 403 unseen.
On reload, everything is back to seeds. The console looks like it is working.

**Cause:** `/api/pilot/admin/capabilities` allows `organization_admin` and
`admin` but not `platform_owner`, while the sibling routes
(`track-assignments`, `gym-capabilities`) *do* allow it. The page never checks
the response.

**Decision:** Should Omega edit capability registries directly?
- **If yes:** add `platform_owner` to the route. Note this needs a rule for
  *which* organization's registry an owner edit targets — `gym-capabilities`
  already solves this with an explicit `organization_id`; copy that.
- **If no:** hide the capability-mutation controls from `platform_owner` the
  way the People link already is.

Either way the page must surface save failures instead of ignoring them.

**Files:** `apps/web/app/api/pilot/admin/capabilities/route.ts:12`,
`apps/web/app/admin/page.tsx:499-528`

---

## 3. Athlete pain reports are rejected every time — HIGH

**Today:** An athlete taps a pain location, fills in type and severity, and
saves. The API rejects it with a 400 every single time and the athlete is told
"saved locally but telemetry persistence failed." No pain report has ever been
stored. The same defect hits sparring recovery notes.

**Cause:** The client sends `kind: 'pain_report'` with `unit: 'severity_1_10'`;
neither exists in the server's observation vocabulary.

**Decision:** This is a **safety signal from a minor**, which is why it is
yours and not mine.
- **Option A:** add `pain_report` / `severity_1_10` to the formula engine's
  typed vocabulary — extends the SHADOW input surface.
- **Option B:** remap the client to an accepted kind/unit and carry pain detail
  in dimensions — no engine change, less structured data.

Whichever you choose, decide at the same time whether a saved pain report
should notify a coach. Right now nothing would.

**Files:** `apps/web/components/AthleteWorkspace.tsx:632`,
`apps/web/src/server/pilot/formulas/types.ts`,
`apps/web/app/athlete/dashboard/sparring/page.tsx:62`

---

## 4. Every uploaded video is quarantined forever — HIGH

**Today:** A coach uploads sparring footage and is told it is "quarantined for
security review." No review surface and no scanner exists, and no code path
ever sets a video to `ready`. The Play button reads "Security review"
permanently. Video analysis has never worked end to end.

**Decision:** Who releases youth video, and on what evidence?
- **Cheapest:** an admin/org-admin review action that flips the status,
  mirroring the intake-document clean/quarantined flow that already exists.
- **Fuller:** an automated scan step before release.

This gates the Film Study work, so it is worth deciding early.

**Files:** `apps/web/app/api/pilot/video/upload/route.ts:84`, issue #125

---

## 5. Publishing a youth video skips every compliance check — HIGH

**Today:** A coach creates a draft publication of a youth athlete's video and
clicks Publish. It enters the research library as `published` with
`compliance_check_status` still `pending`. No safety, consent, or legal check
ever runs, and the route does not verify the publication belongs to the
caller's organization. Separately, the coach-facing workflow can never reach
`approved`, so the Publish button is unreachable from the coach UI — the
exposure is via the API, not the page.

**Decision:** What gates publication of a minor's video?
Recommended minimum, consistent with the schema already in place: scope the
publication load by the caller's organization; require `status = 'approved'`
**and** `compliance_check_status = 'passed'`; restrict publishing to admin
roles. Then decide who moves a publication to `approved` — the natural
candidate is `/publications/check` setting it when a check passes.

Also decide whether the research library is a real surface at all: nothing in
the UI reaches `/publications/library`, and `trackLibraryView` is dead, so view
counts can never move.

**Files:** `apps/web/app/api/pilot/publications/publish/route.ts:25`,
`apps/web/app/coach/video-publications/page.tsx:244`,
`apps/web/src/server/pilot/publication.ts:203`

---

## 6. A live HTTP route still executes production DDL — HIGH

**Today:** `POST /api/pilot/admin/migrate-multiorg` runs 125 DDL statements
against the production database. It is bootstrap-key protected (that was #111),
but README and MASTER_INDEX both state schema changes never come from an HTTP
route. Anyone holding the static key can reshape the youth-data schema with one
request. Its inline DDL also diverges from the same-named infra file, so "the
multiorg migration has been applied" means two different schemas depending on
which path ran.

This audit removed the largest reason the route still existed: the nine
compliance/progression/publication tables it alone created now have a real
migration.

**Decision:** Delete the route, or keep it and amend the documented rule?
Recommendation: delete it. Everything it does is now reachable through
`apply-migrations.yml`. If kept, it should at minimum call the same runners
instead of carrying its own copy of the schema.

**Files:** `apps/web/app/api/pilot/admin/migrate-multiorg/route.ts:22`,
`README.md:50`, `MASTER_INDEX.md:70-71`

---

## 7. Owner bootstrap hardcodes an email address — HIGH — RESOLVED

**Resolved (annotation, 2026-08-15):** both paths now resolve through the
single `getPrimaryOwnerEmail()` in `apps/web/src/server/pilot/auth.ts` --
the bootstrap route and the sign-in callback read the same function, so the
drift this finding describes is structurally closed. The text below is the
original finding, kept as written.

**Today:** The platform-owner bootstrap route hardcodes
`Admin@punxsyprominence.org` while the sign-in callback enforces
`PPBF_PRIMARY_OWNER_EMAIL`. If that secret holds any other address, bootstrap
provisions the owner account for the wrong identity and the configured owner
cannot sign in.

**Decision:** Confirm which address is authoritative, then make the bootstrap
route read the same variable the callback enforces.

**Files:**
`apps/web/app/api/pilot/admin/bootstrap/platform-owner-microsoft/route.ts:13`

---

## 8. Screens that present invented data as real — MEDIUM

Three surfaces still show fabricated content with nothing marking it as
illustrative. The workspaces were cleaned up in this PR using the repo's
existing "not yet tracked" pattern; these three need a decision because the fix
is to wire them up or to admit they are demos.

| Surface | What it shows | Decision |
| --- | --- | --- |
| `/audit` | Five invented audit events with real-looking users | Wire to `POST /api/pilot/audit/get` behind a gate, or label as sample |
| `/operations`, `/launch` | Fake **safety alerts** and counts as live ops data | Wire to real telemetry, or label — the safety wording makes leaving it worst |
| `/research/chat` | "Save Note" confirms a note was logged, then discards it | Persist it, or say it is session-local |

The audit page matters most: the platform's own governance story is that
actions are traceable, and that page is where someone goes to check.

**Files:** `apps/web/app/audit/page.tsx:3`, `apps/web/app/operations/page.tsx:74`,
`apps/web/app/research/chat/page.tsx:121`

---

## 9. Role-boundary questions — MEDIUM

Each of these is a "who should be able to do what" call, so none were touched.

- **Omega is locked out of `/operations` and `/launch`.** The header link
  silently redirects. Mission Control is unreachable for the owner account. The
  page is navigation-only with no athlete data — allow it, or make the redirect
  explain itself. (`apps/web/app/operations/page.tsx:179`)
- **`/admin/shadow` shows Omega actions every backing API refuses** — uploads,
  review actions, document review. Narrow the page gate, or keep read-only
  access and disable the controls with a reason.
  (`apps/web/app/admin/shadow/page.tsx:1672`)
- **`/admin`'s Compliance Center link is a dead end for Omega.**
  (`apps/web/app/admin/page.tsx:842`)
- **`pin-reset` lets `platform_owner` reset athlete PINs**, a power the
  codebase documents as permanently excluded from Omega. Drop the role, or
  record the exception deliberately.
  (`apps/web/app/api/pilot/admin/accounts/pin-reset/route.ts:13`)
- **An org admin's invite can silently overwrite a peer admin's or a board
  member's role.** Protect existing `organization_admin` and `board` accounts
  from role changes made through the invite path.
  (`apps/web/src/server/pilot/staffProvisioning.ts:150`)
- **`transferOrganizationAdmin` does not verify the target belongs to the
  organization**, and does not refuse a platform-owner target.
  (`apps/web/src/server/pilot/auth.ts:963`)

---

## 10. Retention of minors' chat data never runs — MEDIUM

`shadowArchival.ts` implements daily archival and monthly aggregation. Nothing
calls it. No archival has ever run, so the code implies a retention policy the
platform does not have.

**Decision:** Wire `runDailyArchival` into the job worker (the housekeeping
hook added on 2026-07-31 is the natural home), or delete the module. Retention
of minors' conversation data is a policy call.

**Files:** `apps/web/src/server/pilot/shadowArchival.ts:148`

---

## 11. Athlete medical failsafe is hardcoded off — MEDIUM

The athlete layout contains a medical-lockout block that is hardcoded to
inactive and never consults the real medical-status store. The safety posture
the code implies does not exist.

**Decision:** Wire it to the athlete's current medical administrative status,
or delete the block. If wired, decide what a lockout actually blocks.

**Files:** `apps/web/app/athlete/layout.tsx:8`

---

## 12. Session notes are typed and thrown away — MEDIUM

On the athlete dashboard the session-notes textarea only appears *after* the
check-in that would have transmitted it, and check-out persists nothing. An
athlete can type "my wrist hurts" into a box that discards it.

**Decision:** Send notes on check-out, or remove the field until there is a
place to put them. Given the pain-report defect above, free text about pain
being silently dropped is the variant most worth closing.

**Files:** `apps/web/components/AthleteWorkspace.tsx:947`

---

## 13. Smaller calls

- **Gym Notices cannot be authored in the app.** The announcement publish and
  list endpoints have zero UI callers; notices exist only via direct API calls.
  Build a small publish surface, or document API-only authoring.
  (`apps/web/app/api/pilot/announcements/post/route.ts:35`)
- **Team-wide videos can never be published** — publication requires an
  athlete. Make `athlete_id` optional, or filter athlete-less videos out of the
  picker and say why. (`apps/web/app/coach/video-publications/page.tsx:79`)
- **Athlete goal category and progress are decorative** — the UI reads fields
  the API never stores or returns. Add the columns, or drop the badge and
  progress bar. (`apps/web/components/AthleteWorkspace.tsx:322`)
- **Staging is missing `PPBF_PRIMARY_OWNER_EMAIL`**, which production sets, so
  staging does not validate the owner identity production enforces.
  (`.github/workflows/deploy-staging.yml:178`)
- **PIN login rate limiting is memory-only** while weaker endpoints got the
  durable limiter. Worth aligning once the durable table has a migration of its
  own. (`apps/web/app/api/pilot/auth/login/route.ts:27`)

---

## What was already fixed

For contrast, these came out of the same audit and needed no decision — they
are in the accompanying PR: every new athlete dead-ending on first sign-in;
publications failing 100% of the time on a malformed array literal; nine tables
that existed only inside an HTTP route; rate-limit buckets keyed on
attacker-chosen input; parent oversight inverted so minors' self-registrations
were marked reviewed; typed text invisible on the default theme; athlete goals
404ing on the static deployment; the owner's own session cache being erased on
every read; sign-in errors rendering on a tab nobody was looking at.

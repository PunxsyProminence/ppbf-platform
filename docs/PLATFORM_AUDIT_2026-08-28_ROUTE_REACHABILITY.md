# Route reachability triage — 2026-08-28

Which of the 251 API routes under `app/api/pilot` no application code calls.

This is a **reachability** audit, not an authorization one. Every route named
below is gated correctly as far as this pass could tell (see *Gates are not the
finding*). The question here is narrower and, on this platform, has turned out
to matter more than once: a capability nobody can reach is a capability the gym
does not have, however well it is written and however carefully it is tested.

Three findings from this sweep have already shipped or are in review:
`profile/nickname/clear` (the ring-name takedown — a safeguarding control with
no door), `shadow/data` (a person's own conversation history, only obtainable
by asking an admin to run a query), and `admin/accounts/revoke` (an admin could
end a session only by destroying the account's credential along with it).

---

## Method, and how it was wrong twice before it was right

State it plainly, because the first two versions of this list were wrong in
opposite directions and either would have sent somebody chasing the wrong work.

**Pass 1 — too narrow (reported 9).** It searched every `.ts/.tsx/.mjs/.js`
file outside `app/api` for each route's literal path. That counts a **test
file** naming a path, and the **runtime-probe manifest** listing one, as
callers. Neither is a door. `floor-hours/public` was hidden by exactly this: the
only things naming it are `routeGateDeclaration.convention.test.ts` and
`scripts/runtime-probes.manifest.mjs`.

**Pass 2 — too wide (reported 38).** Excluding tests and the manifest exposed
the opposite error: a caller reaches a dynamic route by building it in a
template literal (`${base}/api/pilot/shadow/sessions/${encodeURIComponent(id)}`),
so the literal path with its `[segment]` never appears anywhere. Five routes
were listed as unreachable while being called on every page load.

**Pass 3 — the list below (33).** Tests and the probe manifest excluded from
the corpus; a dynamic route counted as reached when the static prefix before
its first `[segment]` appears. Reproduce it with the script in *Reproducing
this*.

**Known limits.** A caller that assembles a path from fragments
(`` `${base}/api/pilot/${section}/list` ``) would still be missed, and this
pass makes no attempt to find one. So the list can still overcount. It cannot
undercount for static routes.

---

## Gates are not the finding

A first mechanical pass at each route's role gate printed "any signed-in" for
five of them. That reading was wrong for every one, and publishing it would
have been a false alarm about authorization on a children's platform:

| Route | What actually gates it |
| --- | --- |
| `auth/logout-all` | `requirePrincipal` only, **deliberately** — it is self-service, the actor is the subject |
| `parent-tasks` | `canSetParentTask(role)` — coach and organization admin only |
| `drills/proposals/review` | the domain functions call `requireEvidenceReviewer(role)`; the route's own header explains it avoids a second copy that could drift |
| `shadow/memory` | `submitMemoryCorrection` runs `requireTenantOwner` and refuses `board` outright |
| `shadow/research-bridge/export` | `requireResearchBridgeAccess(request)` |

`routeGateDeclaration.convention.test.ts` already holds the line these five sit
on. Nothing in this document is a request to change a gate.

---

## Correctly caller-less (3) — verified, no action

| Route | Who invokes it |
| --- | --- |
| `auth/microsoft/callback` | the identity provider redirects here (its URL appears as a `callbackUrl` in `microsoftOAuthFlow`) |
| `payments/connect/callback` | the payment provider redirects here (`redirect_uri` in `paymentConnect`) |
| `admin/bootstrap/platform-owner-microsoft` | an operator, holding `PPBF_PILOT_BOOTSTRAP_KEY` |

These **should** have no in-app caller. Do not "fix" them.

## Unverified (1)

`shadow/jobs/process` — no cron, workflow, npm script or manifest entry names
it in this repository. An external scheduler could be calling it. Not
classified either way; check the deployment before treating it as orphaned.

## Addressed since this sweep (3)

| Route | Where |
| --- | --- |
| `profile/nickname/clear` | door added on the coach roster |
| `shadow/data` (GET, then POST) | download control, then the request queue |
| `coach-reviews/update` | removed — no caller, and a second copy of an authorization sequence that had been repaired twice |

---

## Settled: unreachable on purpose (1)

**`profile/photo/review`** was listed here as a capability with no door, and
that was read wrong. Portraits are **not** stuck: `/admin/portrait-review` is a
built console with a door in the building map, and it calls a different route,
`/api/pilot/admin/portrait-review`, which lists pending portraits and releases
or blocks them. The feature works today.

What `profile/photo/review` carries that the console does not is a **broader
gate** — `coach_of_subject` and `self` alongside organization admin. That
breadth is deliberate and its surface was deliberately not built. The admin
route's own header records why:

> T-004: THE ORG-WIDE DOOR INTO THE EXIT profile/photo/review ALREADY BUILT.
> … This route adds the list and **narrows the actor to organization admin
> only, per the ticket**; it does not touch or loosen the sibling route's own
> (broader, deliberate) gate.

Owner decision, 2026-08-29: **portrait review stays admin-only.** No
coach-facing surface is to be built, and this route is not to be re-raised by a
future sweep as a missing door.

TWO THINGS A READER SHOULD STILL KNOW. A coach-facing surface would need a
coach-scoped pending list that does not exist — `listPendingReviewPortraits`
takes an organization and returns the whole gym. And the broader gate is not
merely dormant: a coach who knows an athlete's `account_id` can still reach
this route by calling it directly, because `requireRole` admits `coach` and
`resolveRelationship` answers `coach_of_subject` for their own athlete. Nothing
here narrows that, because T-004 explicitly declined to touch this route's
gate and reversing that is as much a deliberate act as widening it would be.
If it should be narrowed, that is its own change.

## Capabilities with no door (25)

Methods and gates as they stand. **Presence here is not a defect claim** — some
of these may be deliberately dormant, some may be reachable through a surface
this method cannot see, and some may simply not be wanted yet. Each needs a
read before anything is built or removed.

| Route | Methods | Gate |
| --- | --- | --- |
| `admin/accounts/repair-auth-provider` | POST | organization_admin, platform_owner |
| `admin/citation-checks` | GET | REVIEW_ROLES |
| `admin/floor-hours` | GET/POST | ADMIN_ROLES |
| `admin/local-findings` | GET/PATCH/POST | RAISE_ROLES |
| `admin/retraction-checks` | GET/PATCH | REVIEW_ROLES |
| `auth/logout-all` | POST | self-service |
| `board/chat` | POST | organization_admin, admin |
| `coach/athlete-intelligence` | GET | ATHLETE_INTELLIGENCE_ROLES |
| `coach/chat` | POST | organization_admin, admin, coach |
| `data-collection-requests` | GET/POST/PATCH/DELETE | QUEUE_ROLES |
| `drills/lineage` | GET | DRILL_PROPOSER_ROLES |
| `drills/proposals` | GET/POST | DRILL_PROPOSER_ROLES |
| `drills/proposals/review` | POST | `requireEvidenceReviewer` (in the domain functions) |
| `floor-hours/public` | GET | unauthenticated by design |
| `individual/chat` | POST | organization_admin, admin, parent |
| `ops/readiness` | GET | admin, organization_admin, platform_owner |
| `parent-tasks` | POST | `canSetParentTask` — coach, organization_admin |
| `platform/organizations/memberships` | POST | platform_owner |
| `platform/users/create` | POST | organization_admin |
| `progression/gap-justification` | GET | coach, admin, organization_admin, athlete, parent |
| `publications/library` | GET | coach, admin, organization_admin, athlete |
| `shadow/library/search` | POST | SHADOW_PROJECTION_READ_ROLES |
| `shadow/memory` | POST | `requireTenantOwner`, board refused |
| `shadow/research-bridge/export` | GET | `requireResearchBridgeAccess` |
| `shadow/research-bridge/session-export` | GET | organization admin (inline) |

### The three worth reading first, and why

**`admin/floor-hours`.** The only one where data is already being *published*
with no way to correct it. Hours accumulate from live application code —
`activityLog.ts`, `communityService.ts`, `attendancePrecedence.ts` and others
write `pilot.activity_log` — and `floor-hours/public` exposes the aggregate on
an unauthenticated endpoint that the runtime probes hit, which is consistent
with external consumption rather than an in-app page. `admin/floor-hours` is
the operator's per-person read plus the correction path, and it is
append-only by design: `recordActivityAdjustment` inserts into
`pilot.activity_log_adjustments` with a nonzero delta, a reason of at least
`MIN_REASON_LENGTH`, the adjuster and their role, and never edits or deletes a
recorded activity row. An operator who spots wrong hours on the public board
today has no way to file that correction.

**`board/chat`, `coach/chat`, `individual/chat`.** Three per-role SHADOW chat
routes with no caller, while `athlete/chat` is wired into `AthleteWorkspace`
and `shadow/chat` serves the SHADOW page. Whether these are superseded or
merely unbuilt is not something this pass establishes — but three of four
siblings being unreachable is worth one read.

---

## Reproducing this

```python
# from apps/web
import os
API = 'app/api/pilot'
routes = ['/' + os.path.relpath(r, 'app').replace(os.sep, '/')
          for r, _, files in os.walk(API) if 'route.ts' in files]

corpus = []
for root, _, files in os.walk('.'):
    if any(x in root for x in ('node_modules', '.next', '.git')): continue
    if root.startswith('./app/api'): continue          # a route is not its own caller
    for f in files:
        if not f.endswith(('.ts', '.tsx', '.mjs', '.js')): continue
        if '.test.' in f or f.endswith('.manifest.mjs'): continue   # neither is a door
        corpus.append(open(os.path.join(root, f), encoding='utf8', errors='ignore').read())
blob = '\n'.join(corpus)

def reached(p):
    # a dynamic route is built in a template literal, so only the static
    # prefix before the first [segment] ever appears as a literal
    return p in blob or ('[' in p and p.split('/[')[0] in blob)

for p in sorted(routes):
    if not reached(p): print(p)
```

Re-run it after any change to this list. The count moves as doors are built,
and a route dropping off it for the right reason is the point.

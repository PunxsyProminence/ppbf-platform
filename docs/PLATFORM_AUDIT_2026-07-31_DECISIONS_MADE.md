# Platform audit 2026-07-31 — the decisions, as made

A full-platform audit ran on 2026-07-31 against `main` at `7772250`. Everything
fixable without a product, policy, or money decision shipped in #144. The
remainder — 13 defects whose *repair* required a choice — was put to the owner
and decided the same day.

This file records **what was decided and why it matters**, so the reasoning
survives the implementation. It supersedes the question list in
`PLATFORM_AUDIT_2026-07-31_OWNER_DECISIONS.md`; that file is the record of what
was asked, this one is the record of what was answered.

Owner: Jason Neale. Decided 2026-07-31.

---

## Access and identity

**1. Staff and volunteers get their own landing page.** They authenticated
successfully and were bounced, because no role destination existed for them —
and PIN login is athlete-only, so there was no way in at all. They now land on
a shared workspace of their own rather than borrowing a dashboard built for
another role. Refused sign-ins also stop minting orphan session tokens.

**2. The capability console saves for the platform owner.** It admitted Omega,
failed every save with a 403 nobody surfaced, and reverted to seed data on
reload. The route now accepts `platform_owner` using the organization-targeting
mechanism its sibling `gym-capabilities` already had, and the page surfaces
failures instead of swallowing them.

**3. Omega keeps breadth, loses depth.** The owner's framing: *"Omega's job is
primarily to gather data and help organization admins."* So: the Operations hub
opens for the platform owner; the SHADOW controls whose APIs refuse Omega are
hidden rather than left to 403 in silence; the dead Compliance Center link is
hidden; and Omega loses the power to reset athlete PINs, which the codebase had
always documented as excluded.

**4. One owner identity.** Bootstrap now reads `PPBF_PRIMARY_OWNER_EMAIL`, the
same variable sign-in enforces, instead of a hardcoded address that could
silently disagree with it.

**5. Board seats become real — DECIDED, BUILT SEPARATELY.** Seat names exist
only as client-side display labels; the server has no concept of which seat a
board member holds, so President versus Treasurer is a URL slug and nothing
more. The decision: store seats, one primary holder per seat with additional
holders allowed; a member lands on their own seat's page; the president and
chair may open any seat as oversight; everyone else on a board session goes to
the shared hub; both the organization admin and the president assign and manage
seats. This ships in its own change set — it is not part of the work described
above.

---

## Safety signals from minors

These were the sharpest findings in the audit, and all three were decided the
same way: make it work, or say plainly that it did not.

**6. Pain reports persist, and reach a coach.** Every pain report an athlete had
ever filed was rejected by the API — the client sent a kind and unit the server
vocabulary did not contain — while the athlete was told it was "saved locally."
The vocabulary now carries them, and a saved report surfaces to a coach rather
than sitting in a table nobody opens. Sparring recovery notes had the same root
cause and the same fix.

**7. Session notes persist on check-out.** The notes box appeared only after the
check-in that would have carried it, and check-out saved nothing — an athlete
could type "my wrist hurts" into a field that discarded it.

**8. The dead medical failsafe is deleted.** A medical-lockout block sat
hardcoded to inactive, disconnected from the real medical-status store. Rather
than leave code implying a safety net that did not exist, it is gone. If a
medical hold should ever gate athlete surfaces, that gets built deliberately.

---

## Youth video

**9. A coach releases their own uploaded video.** Nothing had ever set a video to
`ready`, so every upload was quarantined forever and video analysis had never
worked end to end. The uploading coach (or an admin) may now release, scoped to
their organization, quarantined→ready only, written to the audit trail. An
athlete never can.

**10. Publishing requires checks to have passed.** Publish ran no ownership,
approval, or check gating at all — a draft went into the research library with
compliance still pending. Now a compliance check moves a publication to
approved or rejected, and publish refuses anything not approved with checks
passed. The coach who submitted it may publish; admins still can too.

---

## Schema and operations

**11. The DDL-over-HTTP route is deleted.** A single POST could execute ~125 DDL
statements against the production youth-data database. README and MASTER_INDEX
have always claimed schema never comes from an HTTP route; that claim is now
true.

Four tables it created still have no migration: `pilot.athlete_chat_audit`,
`board_chat_audit`, `coach_chat_audit`, and `individual_chat_audit`. Their only
DDL is `apps/web/src/server/pilot/migrations/003_create_chat_audit_tables.sql`,
which no script, package entry, or workflow references. They exist in an
environment only because the deleted route once ran there — so they are the
last remnant of the pattern, and they need a migration of their own before any
environment is rebuilt.

**12. Retention actually runs.** Daily archival and monthly aggregation of
minors' SHADOW chat data existed as code nothing ever called — the platform
implied a retention policy it did not have. It now runs on the worker's
housekeeping tick, capped to once a day, and cannot take the worker down if it
fails.

**13. Every gym starts with the five default compliance rules.** The old HTTP
route seeded them; the migrations that replaced it did not, so a gym set up the
documented way began with an empty rule set and compliance monitoring that did
nothing. The seeds are now a migration of their own.

---

## Truth on screen

**14. `/audit` shows the real audit trail.** It had been showing five invented
events with real-looking users, on the one page whose entire purpose is proving
what actually happened.

**15. The fake safety alerts are gone from Mission Control.** Invented alerts and
counts presented as live operational data, on athlete safety, in the hub the
platform calls The Ring.

**16. `/research/chat` stops claiming it saved a note** it discards.

**17. Gym notices and motivational content become authored, not hardcoded.**
Coaches as well as admins can post, and the same mechanism drives the banners
and motivational lines throughout the app, so changing them no longer means
changing code.

**Standing instruction from the owner:** *"fake data will need to be removed when
we start taking real athletes."* Treat any remaining seeded or illustrative
content as a release blocker for onboarding real families, not as decoration.

---

## Deliberately not decided yet

- **The board seat pages have no data behind them.** Routing a treasurer to
  their own page is worth doing on its own; filling ~30 metric tiles that all
  read "Unavailable" is not. Program & Safety Director and Secretary are the
  two seats whose data already exists (compliance escalations; the audit
  trail). The Treasurer, whose duty is clearest, has the least available data —
  the platform collects nothing financial until the payment slot is built.
- **New organizations created after the seed migration** do not receive the
  default compliance rules; gym creation would have to seed them too.
- **Team-wide (athlete-less) videos** still cannot be published.
- **Athlete goal category and progress** are read by the UI but stored nowhere.

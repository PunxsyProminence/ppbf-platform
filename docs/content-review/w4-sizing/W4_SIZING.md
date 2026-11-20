# W4 sizing (lane W4S)

Read-only sizing of the eight W4 items in Backbone's wave plan of 2026-11-19,
so Overwatch can plan the last wave. Jason's card OW26-02, "C: Everything,
FUTURE items too" (OD-2026-11-19-016), says no completion date can be given
until each W4 item is sized. This file sizes them. It builds nothing and
decides nothing: every owner question is put as a question, with the
recommended option first.

- **Read at:** `main` `7a1736d9fc9028a21d9a7f906c712244a6ad6bbb`. Line numbers
  are from that commit. Lane RS's list is from its branch head
  `1e78a04d735340e2b0ca7b76fb3cbba6416db62e` (#2008, open).
- **Labels:** OBSERVED (read in the code, with file:line), INFERRED,
  UNVERIFIED. Paths under `apps/web/` are written in full. Migrations are under
  `infra/azure/`.
- **Scrub files:** the App Scrub's item files (FAM-09, CF-11, CF-14) are not in
  this repository. A search of its `.md`, `.ts` and `.tsx` files found CF-14
  only in a test comment (`apps/web/components/buildingMap.test.ts:498`) and
  found no FAM-09 or CF-11. Items 4 and 5 are sized from the brief's one-line
  wording.

## How the sizes were made (INFERRED estimates)

A size is the changed lines outside tests: insertions plus deletions from
`git show --numstat`, leaving out `*.test.*` files. Each estimate is matched to
a merged PR of the same shape, measured that way on `main`:

| Merged PR (commit) | Shape | Non-test lines, measured (code and SQL; for HW, content and review sheet) |
|---|---|---|
| AS2-a #1984 (`f71e432`) | one new table, its runner, a read route and a write route, audited | 414 (366 code, 48 SQL) |
| AS2-c #1986 (`054cf74`) | one settings control on an existing page | 174 |
| SH-3 (`d37d96b`) | one line on the Parent Hub | 90 |
| SH-2 #1968 (`2062213`) | a write path, its screen and a migration | 597 (551 code, 46 SQL) |
| U2-6e #1991 (`d4df553`) | read-side change on two existing screens | 432 |
| AS2-b #1985 (`0c5392b`) | device-side behaviour across every signed-in screen | 652 |
| U2-6a #2001 (`0752bb4`) | a new page | 754 |
| HW #1980 (`f97f7c1`) | 6 AI-drafted drills, 6 templates, review sheet | 529 (drill CSVs 41, template CSVs 160, review sheet 325, track 2, ACTIVE_WORK 1) |

Six of these eight went over the brief's "about 400" target. Estimates here aim at
400 or less per PR and say where a PR may go over. Tests are not counted. In
the PRs above, tests were 0.6 to 3.5 times the non-test lines.

**Risk route** (from the brief): Opus for sign-in, permissions, minors' data
and safety; Sonnet otherwise. **G3** is Jason's signed-in staging check for
sign-in, minors' data and safety screens, run once per wave (OW26-01,
OD-2026-11-19-015).

---

## 1. Opt-in, content-free email alerts

**Ruling:** OD-2026-11-19-019, Jason: *"1 and 2 now we will do 3 later"*. The
entry reads this as in-app alerts plus "an opt-in, content-free email from the
gym's Microsoft 365 mailbox that says only "open the app"" now, and web push
later. It changes OD-2026-10-01-006 and -008 "for outside alerts" (-008
section 3 had said "No email, text or push"). Its "Not ruled here" line says
"the email lane's build" is not ruled. OD-2026-11-19-009 records the App Scrub
answer "Alert wording: Only 'open the app'". That entry says "Ruling: none by
this entry".

**What exists (OBSERVED):**

- **The mailer.** `apps/web/src/server/pilot/graphMailer.ts:120`,
  `sendPlainTextMail(`, takes any `to`, `subject` and `body`. Its header says
  "NOT A GENERAL MAILER" (`:25`) and "Magic links are the only thing this
  platform sends" (`:28-29`). Its only importer outside tests is
  `apps/web/src/server/pilot/magicLinkStore.ts:7`. It gets its token from the
  app's managed identity (`managedIdentityToken.ts:133-134`, `IDENTITY_ENDPOINT`
  and `IDENTITY_HEADER`). The sender mailbox is a constant in
  `magicLinkStore.ts:29`.
- **Where addresses are.** `pilot.accounts.login_email`
  (`infra/azure/pilot_slice_postgres.sql:27`) and `pilot.parents.email` (`:293`).
- **The in-app alert.** `pilot.safety_escalations` is pull-only. The migration
  says "There is no notification channel in this platform at all"
  (`infra/azure/pilot_slice_postgres_safety_escalations_migration.sql:9-10`).
  Coaches read their own athletes' rows (`apps/web/app/api/pilot/escalations/route.ts:35`,
  `:45`). The SHADOW disclosure path files a row for the coach of record, any
  covering coach and admins, and says "No email, text or push -- the escalation
  list is the only channel" (`apps/web/src/server/pilot/shadowDisclosure.ts:19-20`,
  `:328`). The header badge polls every 2 minutes
  (`apps/web/components/SafetyAttentionBadge.tsx:81`).
- **Family notes.** Parents' replies send nothing: "Nothing is sent (no email,
  no push)" (`apps/web/src/server/pilot/familyMessageReplies.ts:20`).
- **A tick to send on.** The SHADOW job worker starts in
  `apps/web/instrumentation.ts:38`, with sweep and housekeeping hooks
  (`:47`, `:63`). It runs only when `PPBF_SHADOW_WORKER_ENABLED` is set
  (`apps/web/src/server/pilot/shadowJobWorker.ts:28`).

**What is missing (searches, scoped):** a search of `infra/azure/*.sql` for
`opt_in`, `notification_pref`, `email_pref`, `unsubscribe` and `email_consent`
found no email preference. The only opt-in is cycle tracking. A search of
`apps/web` for `outbox` found no match. So missing are: who opted in, which
events send, who receives each, a send log, retries and a rate limit, the
opt-in screen, and corrected "sends no email" comments
(`apps/web/app/api/pilot/escalations/route.ts:16-17`, `shadowDisclosure.ts:20`,
`familyMessageReplies.ts:20`, `graphMailer.ts:25-29`). Migration files are left
as written.

**PR split (INFERRED):**

| PR | What | Est. lines | Basis |
|---|---|---|---|
| EM-1 | Migration: an opt-in table (per account, opted-in and opted-out times, audited) and a send-log table (who, when, which event kind; no message content). Runner, own-account read and write route. | about 420 | AS2-a 414 |
| EM-2 | The opt-in switch on the account's own settings page. | about 180 | AS2-c 174 |
| EM-3 | The sender: a send-log sweep on a server tick, a per-person rate limit, retry, through `sendPlainTextMail`. The comments above corrected. | about 300 | INFERRED |
| EM-4 | Trigger points and recipients: the events Q1.1 names, each resolved to the people who can already read it in the app and who opted in. | about 280 | INFERRED |

- **Total:** about 1,180 lines in 4 PRs.
- **Migrations:** 1, in EM-1.
- **Route:** Opus for all four (sign-in addresses, minors' contacts, safety alerts).
- **G3:** applies (EM-2 is a sign-in-account screen; EM-4 routes safety alerts).
- **Outside the repository:** UNVERIFIED whether the managed identity's mail
  permission is limited to one mailbox. Sign-in links send today, so it can
  send from the sign-in mailbox (INFERRED); nothing in the repo says more.
- **Dependencies:** none on open PRs. Item 2 reuses EM-1 and EM-3. Item 4 may
  add a trigger (Q4.3).
- **File overlap:** none with #2005 to #2010 (their changed-file lists, read 2026-11-20).

**Owner questions:**

- **Q1.1 Which events send the email?**
  - **A (recommended):** the events that already raise something in the app
    for that person: a safety escalation a staff member can read, including
    SHADOW safety alerts (OD-2026-10-01-008 section 3 kept those in-app only;
    OD-2026-11-19-019 changes it "for outside alerts"), and a new family note
    or parent reply.
  - **B:** safety escalations for staff only.
  - **C:** A plus gym announcements.
- **Q1.2 Who may opt in?**
  - **A (recommended):** staff (coach, admin, organization admin) and parents.
    No athlete gets the email. An athlete with no date of birth counts as a
    minor (OD-2026-10-04-010).
  - **B:** A, plus athletes 18 or over.
  - **C:** anyone with a sign-in email.
- **Q1.3 How often?**
  - **A (recommended):** at most one email per person per hour, whatever the
    number of events. The email still says only "open the app".
  - **B:** one email per event.
  - **C:** one a day.
- **Q1.4 How does a person opt out?**
  - **A (recommended):** with the same switch in the app. The email holds only
    "open the app" (the recorded answer "Only 'open the app'").
  - **B:** also with a link in the email.
- **Q1.5 Which mailbox sends it?**
  - **A (recommended):** the gym mailbox that sends sign-in links today. This
    needs no Azure change.
  - **B:** a separate gym mailbox, which Jason sets up in Microsoft 365 first.

## 2. Web push (later, per Jason)

**Ruling:** OD-2026-11-19-019: web push "is later"; its build is "Not ruled
here". Sized only.

**What exists (OBSERVED, searches):** a search of the repository for
`serviceWorker`, `PushManager`, `VAPID`, `web-push`, `webmanifest`, `sw.js`,
`pushSubscription` and `Notification.requestPermission` found no match. The one
`manifest.json` is `design-system/manifest.json`, which is not a web app
manifest. `web-push` is not in `apps/web/package.json`.

**External fact (UNVERIFIED against the primary page):** on iPhone and iPad,
web push works only for a site added to the Home Screen, from iOS and iPadOS
16.4, and permission may be asked only on a user's tap. This comes from a web
search summary of the WebKit blog post "Web Push for Web Apps on iOS and
iPadOS"; the primary page was not opened. The gym's tablets are planned as
iPad and Android (OD-2026-11-19-009, facts table). Android behaviour was not
checked.

**What is missing:** a web app manifest, a service worker (push only, no
caching), a subscription per account per device, a VAPID key pair (a secret),
a sender, an opt-in on a tap, and removing the subscription at sign-out. Gym
tablets are shared, and they sign out after idle time
(`apps/web/components/TabletIdleSignOut.tsx`).

**PR split (INFERRED):**

| PR | What | Est. lines |
|---|---|---|
| WP-1 | Manifest, service worker, migration for subscriptions, subscribe and unsubscribe routes | about 420 |
| WP-2 | The sender, on EM-3's send log: VAPID signing and payload encryption | about 250 with the `web-push` package; about 450 without (INFERRED) |
| WP-3 | The opt-in on a tap; unsubscribe at sign-out and on a device marked as a gym tablet | about 220 |

- **Total:** about 890 to 1,090 lines in 3 PRs.
- **Migrations:** 1.
- **Also needs:** one new dependency if `web-push` is used (Overwatch's call),
  and one secret that Overwatch or Jason puts in Azure. No AI enters a secret.
- **Route:** Opus (sign-in and sign-out, shared tablets, minors).
- **G3:** applies.
- **Dependencies:** item 1 (EM-1 and EM-3) first. WP-3 touches the tablet
  sign-out files of lane U1's AS2 work (merged).
- **File overlap:** none with the open PRs.

**Owner questions (for when web push is started):**

- **Q2.1 Push on a shared gym tablet?**
  - **A (recommended):** no push on a device marked as a gym tablet. Push goes
    only to a person's own phone or computer.
  - **B:** allowed, and the subscription ends at sign-out.
- **Q2.2 Same events and limits as the email?**
  - **A (recommended):** yes, the Q1.1 and Q1.3 answers.
  - **B:** its own list.

## 3. A live "on the floor now" line on every home

**Source:** the App Scrub answer "Q12 live floor line: A: on every home; parents
see only their own child", "FUTURE lane with a privacy review" (recorded in
OD-2026-11-19-009, which says "Ruling: none by this entry"). The brief says the
privacy review comes first.

**What exists (OBSERVED):**

- **What is live now.** A session run has `run_state`, `started_at` and
  `ended_at`
  (`infra/azure/pilot_slice_postgres_session_run_state_migration.sql:38-40`),
  in progress or not (`:61`), one live run per coach (`:128-130`), and it may
  be tied to a class (`pilot_slice_postgres_session_run_class_migration.sql:105`).
  A run idle 3 hours is closed (`apps/web/src/server/pilot/sessionScriptRuns.ts:152`).
- **Who is marked here.** `pilot.session_run_athletes`
  (`infra/azure/pilot_slice_postgres_session_run_athletes_migration.sql:80`).
  The migration calls it "SESSION DETAIL, NOT ATTENDANCE" (`:26`). Only the
  delivering coach marks, and only while the run is live
  (`apps/web/src/server/pilot/sessionRunAthletes.ts:98`, `:101`). Staff read it
  (`apps/web/app/api/pilot/session-scripts/runs/[runId]/athletes/route.ts:46`, `:62`).
- **The register.** A mark is copied to the class register only for a session
  tied to a class (`sessionRunAthletes.ts:171`).
- **Today's attendance.** `apps/web/app/api/pilot/coach/attendance-today/route.ts:13`
  says "Who is marked on the floor today". The public wall counts today's
  present marks without a sign-in (`apps/web/src/server/pilot/wallDisplayDb.ts:106`,
  `apps/web/app/api/pilot/wall/route.ts:22`).
- **The homes.** The coach home shows only the coach's own run: "Session in
  progress" and "Athletes Present" (`apps/web/components/CoachWorkspace.tsx:1391`,
  `:3482`). A search of `apps/web/components/ParentHub.tsx` and
  `apps/web/components/AthleteWorkspace.tsx` for live-presence words found no
  match. The parent home loads only linked children whose guardian link has not
  ended (`apps/web/app/api/pilot/athletes/list/route.ts:53`, `:64`).
- **Minors.** Unknown age is a minor (`apps/web/src/server/pilot/wallDisplay.ts:216-223`).
  A guardian's access ends at 18 (`apps/web/src/server/pilot/guardianAccess.ts:46`, `:70`, `:111`).

**What is missing:** a gym-wide "who is here now" read (the live-run read
returns only the caller's own run: `sessionScriptRuns.ts:315`), cut by role.
Staff see the gym, a parent sees only their own children, an athlete sees only
themselves. Also missing: the line on four homes, and the privacy review.

**PR split (INFERRED):**

| PR | What | Est. lines | Basis |
|---|---|---|---|
| FN-0 | Privacy review, docs only: what each role sees, what the public wall already shows, the minors rules | about 120 | INFERRED |
| FN-1 | One read and route, cut by role (staff, parent via `guardianAthleteIds`, athlete self) | about 250 | INFERRED |
| FN-2 | The line on the Parent Hub and the athlete home | about 150 | SH-3 90, two homes |
| FN-3 | The line on the coach home and the admin home | about 120 | SH-3 90 |

- **Total:** about 640 lines in 4 PRs.
- **Migrations:** none (INFERRED: built on the tables above).
- **Route:** Opus for FN-0 to FN-3 (minors' data).
- **G3:** applies.
- **Dependencies:** FN-0 before FN-1. FN-3 changes `CoachWorkspace.tsx`, lane
  U2's file (AS-7, coach home), so it waits on U2. FN-2 changes
  `AthleteWorkspace.tsx`, which #2006 (lane U3) and U2 item 4e also plan to change.
- **File overlap:** #2006 (`AthleteWorkspace.tsx`, in its plan); U2's later PRs (`CoachWorkspace.tsx`).

**Owner questions:**

- **Q3.1 What counts as "on the floor now"?**
  - **A (recommended):** marked here in a session that is running now. That
    record is the only one that is live.
  - **B:** marked present on today's class register.
  - **C:** either one.
- **Q3.2 What does a parent see?**
  - **A (recommended):** a line for each of their own children who is on the
    floor now, and nothing about anyone else.
  - **B:** A, plus the class and the time it started.
- **Q3.3 What do coaches and admins see?**
  - **A (recommended):** the names of everyone on the floor now. Coaches can
    already read every athlete in their gym
    (`apps/web/src/server/pilot/access.ts:398-401`).
  - **B:** a count only.
- **Q3.4 What does an athlete see?**
  - **A (recommended):** a line about themselves only.
  - **B:** A, plus the number of people on the floor (the public wall already
    shows today's head count).

## 4. A parent starts a message to the coach (scrub FAM-09)

**What exists (OBSERVED):** messages run one way today. The coach starts and
the parent answers.

- **Coach to family.** A coach posts a note to the family as a
  `coach_observations` row with `note_type 'parent_message'`
  (`apps/web/app/coach/decision-loop/page.tsx:1102`).
- **Parent reads.** `apps/web/app/api/pilot/parent/messages/route.ts:36`, `:38`.
- **Parent replies.** The parent replies under it in
  `pilot.family_message_replies`
  (`infra/azure/pilot_slice_postgres_family_message_replies_migration.sql:62`),
  where the author must be a parent (`:83`).
- **Unread state.** Both sides keep it:
  `pilot_slice_postgres_family_message_reads_migration.sql:59` and
  `pilot_slice_postgres_family_reply_reads_migration.sql:54`. The parent's
  count is at `apps/web/components/ParentHub.tsx:1476`. The coach's "New" mark
  is per athlete (`apps/web/components/FamilyNotesPosted.tsx:42-44`).
- **What a parent can start today.** Only a barrier report
  (`apps/web/app/api/pilot/parent/barrier-report/route.ts:43`).
- **Who coaches whom.** The assigned coach plus active cover is
  `athleteIdsForCoach` (`apps/web/src/server/pilot/access.ts:508`, `:511-516`).
  The guardian check is `isGuardianLinkedToAthlete`
  (`apps/web/src/server/pilot/guardianAccess.ts:70`).

**What is missing:** a message a parent starts, a staff list of those messages
with an unread count across the roster, the staff reply to one, and its
storage. INFERRED: today's reply table requires a coach note to hang from, so a
parent-started message needs either a new table or a widened reply table.
Either way it is a migration.

**PR split (INFERRED):**

| PR | What | Est. lines | Basis |
|---|---|---|---|
| PM-1 | Migration, store, and routes: a parent posts about their own child; staff list and read state | about 420 | AS2-a 414 |
| PM-2 | Staff reply, and the parent's view of the thread | about 250 | INFERRED |
| PM-3 | The parent's composer on the Parent Hub | about 200 | INFERRED |
| PM-4 | The staff inbox with an unread count across the roster | about 250 | INFERRED |

- **Total:** about 1,120 lines in 4 PRs.
- **Migrations:** 1.
- **Route:** Opus (minors' data, permissions, guardian access).
- **G3:** applies.
- **Dependencies:** a Q4.3 A answer makes item 1 (EM-4) send for it.
- **File overlap:** PM-4's home depends on Q4.4. If it is the Decision Loop,
  #2010 (lane AS-5) plans changes to `apps/web/app/coach/decision-loop/page.tsx`
  in AS5-1. If it is the coach home, that is U2's `CoachWorkspace.tsx`.

**Owner questions:**

- **Q4.1 Who reads a parent's message?**
  - **A (recommended):** the child's assigned coach, any coach covering them,
    and admins, the same people a SHADOW safety alert reaches
    (OD-2026-10-01-008 section 3).
  - **B:** every coach in the gym.
  - **C:** admins only, who pass it on.
- **Q4.2 What is a message about?**
  - **A (recommended):** one of the parent's own children, chosen by the parent.
  - **B:** a general message to the gym.
- **Q4.3 Does a parent's new message send the email alert (item 1)?**
  - **A (recommended):** yes, to staff who opted in.
  - **B:** in the app only.
- **Q4.4 Where do coaches read them?**
  - **A (recommended):** on the coach home, beside the alerts.
  - **B:** on the Decision Loop's "Post to the Family's Page" section.

## 5. A coach adds drills or blocks to a session plan, and schedules a class from it (scrub CF-11)

**What exists (OBSERVED):**

- **The screen.** "Session Plans" is the screen name for session scripts
  (`apps/web/app/coach/session-scripts/page.tsx:477`).
- **Making a plan.** A plan is made only from a workout template
  (`apps/web/app/api/pilot/session-scripts/route.ts:125-132`;
  `apps/web/app/coach/workout-templates/MakeSessionScript.tsx:78-82`), or by
  an admin content import.
- **Editing a plan.** An edit changes the name and each block's title and
  minutes only (`route.ts:174`). The server says "blocks are never added,
  removed or reordered here" (`apps/web/src/server/pilot/sessionScriptAuthoring.ts:409-411`),
  and refuses an unknown block (`:436-437`). A plan that has been run gets a
  new version (`:31-38`, `:500-551`).
- **Blocks.** A block can name a library drill
  (`infra/azure/pilot_slice_postgres_session_scripts_migration.sql:87`). Its
  order is unique within the plan (`:96`). It must hold some text (`:99-100`).
  The template path meets that by writing the step's facts into
  `what_to_explain` (`sessionScriptAuthoring.ts:140-142`).
- **Scheduling.** A coach schedules their own classes
  (`apps/web/app/api/pilot/scheduler/route.ts:804-806`, `:831-832`) from
  `/schedule` (`apps/web/app/schedule/page.tsx:1044`). A class row has no plan
  column (`infra/azure/pilot_slice_postgres_scheduler_tables_migration.sql:11-26`).
- **Class and plan.** They meet only when a session starts
  (`apps/web/src/client/startClassSession.ts:45-52`). The class screen starts
  with no plan (`apps/web/app/coach/class/page.tsx:147`; its comment at `:19`
  says "Plans are still started from Session Plans").

**What is missing:** adding a block (a drill from the library), removing and
reordering blocks, a class that carries a plan, and the class screen starting
that plan. INFERRED: adding and reordering need no migration, because order
can be renumbered in one transaction and a new drill block can carry
"From the drill" facts in `what_to_explain` the way template steps do. A class
that carries a plan needs one.

**PR split (INFERRED):**

| PR | What | Est. lines | Basis |
|---|---|---|---|
| SP-1 | Server and edit route: add a drill block, remove a block, move a block; the versioning as today | about 350 | INFERRED, `sessionScriptAuthoring.ts` is 724 lines |
| SP-2 | The editor: a drill picker, remove, move up and down | about 300 | `SessionScriptEditor.tsx` is 259 lines today |
| SP-3 | Migration: a plan link on a scheduled class; the scheduler accepts it | about 250 | INFERRED |
| SP-4 | "Schedule a class" from Session Plans; the class screen starts the class's plan | about 250 | INFERRED |

- **Total:** about 1,150 lines in 4 PRs.
- **Migrations:** 1 (SP-3), only if Q5.2 is A.
- **Route:** Sonnet for SP-2. Opus for SP-1, because a sparring-contact drill
  could be added to a plan; UNVERIFIED whether any gate reads a block's
  contact level at run time (a search was not conclusive). Opus for SP-3 and
  SP-4 (the scheduler's role gate).
- **G3:** INFERRED not to apply (no sign-in, minors' data or safety screen),
  unless SP-1 finds a contact gate.
- **Dependencies:** OD-2026-10-21-002 D4 ("A: Tie them") already ties a
  session to its class at start. SP-4 changes the class screen, which lane U2
  owns (6b to 6d not started).
- **File overlap:** U2's later class-screen PRs (`apps/web/app/coach/class/page.tsx`).

**Owner questions:**

- **Q5.1 What can a coach add?**
  - **A (recommended):** a drill from the library, as a new block.
  - **B:** A, plus a block copied from another plan.
- **Q5.2 What does "schedules a class from it" keep?**
  - **A (recommended):** the class keeps the plan, and Start on the class
    screen starts that plan.
  - **B:** the plan only fills in the schedule form (title, length), and
    nothing is kept.

## 6. A "who has stopped coming" page (scrub CF-14)

**What exists (OBSERVED):**

- **Passbook Gaps is not it.** The page says it is "not a check on who has
  stopped coming" (`apps/web/app/coach/passbook-gaps/page.tsx:184`; also `:22`,
  `:155`). A test keeps any door from claiming the words "until a page answers
  it" (`apps/web/components/buildingMap.test.ts:498-501`). SC2-1 (#1981) took
  the words off the door (`apps/web/components/buildingMap.ts:461-463`).
- **Per-athlete data.** Last present date and days since come from
  `getAttendanceLast28Days`, over 28 days
  (`apps/web/src/server/pilot/attendancePrecedence.ts:241`, `:262`, `:286`).
- **Membership status.** It is active, lapsed or ended, set by hand
  (`infra/azure/pilot_slice_postgres_program_memberships_migration.sql:28`).
- **Lapses.** A search of `apps/web` for `lapsed`, `stopped coming`,
  `days_since` and `last_seen` found no query that marks a lapse by itself.
- **Data gap (INFERRED from `sessionRunAthletes.ts:171`):** a session not tied
  to a class writes no register mark. An athlete seen only at untied open gym
  may have no attendance record, and would look as if they had stopped coming.

**What is missing:** a gym-wide list of athletes with no present mark for a
set number of days (looking further back than 28 days), its page, a door, and
the guard test turned to require that door.

**PR split (INFERRED):**

| PR | What | Est. lines |
|---|---|---|
| SC-1 | Query and route (coach, admin), reading register marks and, with Q6.3 A, session marks | about 300 |
| SC-2 | Page, door, guard test turned | about 250 |

- **Total:** about 550 lines in 2 PRs.
- **Migrations:** none (INFERRED), unless Q6.4 is B.
- **Route:** Opus (minors' data).
- **G3:** applies.
- **Dependencies:** the door is in `buildingMap.ts`, which lane U2's AS-4 plans
  to change; sequence with U2.
- **File overlap:** U2's AS-4 (not open yet).

**Owner questions:**

- **Q6.1 How long without coming counts?**
  - **A (recommended):** 3 weeks with no present mark. INFERRED reason: it
    catches a member who misses three weekly classes in a row.
  - **B:** 2 weeks.
  - **C:** 30 days.
- **Q6.2 Who is listed?**
  - **A (recommended):** athletes with an active membership who were present
    at least once before.
  - **B:** everyone on the roster.
- **Q6.3 Does open gym count as coming?**
  - **A (recommended):** yes. Open-gym "here" marks count too, which SC-1 reads
    from the session marks (in its estimate).
  - **B:** register marks only.
- **Q6.4 What can a coach do on the page?**
  - **A (recommended):** read the list and open the athlete.
  - **B:** A, plus mark "reached out", which needs a migration and a third PR
    (about 200 lines more).

## 7. An offline save queue: failed saves are kept and retried

**Rulings and records (OBSERVED):**

- OD-2026-09-28-008: "offline storage stays parked".
- `docs/current/ACTIVE_WORK.md:269`, PARKED `BACKLOG-offline-write-queue`:
  re-open when "A concrete identity-scoped encrypted/offline storage design is
  selected".
- `docs/current/ACTIVE_WORK.md:55`: "online-only writes until the
  offline-storage decision is made".
- OD-2026-11-19-009 records the scrub answer "Failed saves: A: small honesty
  fixes now, offline queue later" (and "Ruling: none by this entry").

**State: BLOCKED until Q7.1 is answered.** Building a queue that stores data on
the device before a design is selected would go past the PARKED row's re-open
condition.

**What exists (OBSERVED):**

- **No device storage.** A search of `apps/web` for `serviceWorker`,
  `indexedDB`, `navigator.onLine`, `Idempotency-Key`, `workbox`, `dexie` and
  `localforage` found no match. `localStorage` holds UI preferences only.
- **Keys, not payloads.** `sessionStorage` holds only a pending request key,
  never the payload (`apps/web/app/schedule/page.tsx:262`,
  `apps/web/app/coach/test-day/page.tsx:77-78`).
- **Repeat-safe writes.** Several writes are already safe to send twice:
  - class create by request key (`apps/web/app/api/pilot/scheduler/route.ts:163-176`);
  - intervention log by request key
    (`apps/web/app/api/pilot/coach/intervention-executions/route.ts:119`);
  - the live "here" tap by its natural key
    (`apps/web/src/server/pilot/sessionRunAthletes.ts:120`).
- **Not repeat-safe.** Staff notes
  (`apps/web/components/SessionStaffNotesPanel.tsx:199`) and the run actions
  (`apps/web/app/api/pilot/session-scripts/runs/[runId]/route.ts:38`) carry no
  request key.
- **Failure messages.** Each shows a message and none retries, e.g.
  `apps/web/components/SessionRunPresence.tsx:195` and
  `apps/web/components/SessionScriptLiveDelivery.tsx:126-127`.
- **A retry pattern exists.** The tablet sign-out retries every 15 seconds and
  on `online` (`apps/web/components/TabletIdleSignOut.tsx:69`, `:145`, `:148`).

**What is missing:** a client queue, request keys on the writes that lack them,
the retry, and what the screen says while a save waits. If Q7.1 is B, also
encrypted device storage tied to the signed-in person and wiped at sign-out.

**PR split (INFERRED), for Q7.1 A:**

| PR | What | Est. lines |
|---|---|---|
| OQ-1 | Request keys on staff notes and run actions (server, and a migration for their unique keys if the natural keys do not cover them) | about 300 |
| OQ-2 | One client retry queue, in memory, with the waiting and failed words | about 280 |
| OQ-3 | Wire the live floor writes (here taps, run actions, staff notes, intervention log) | about 250 |
| OQ-4 | Wire the other writes Q7.2 names | about 250 |

- **Total:** about 1,080 lines in 4 PRs, with 0 or 1 migration.
- **If Q7.1 is B:** add about 500 lines (encrypted store, wipe at sign-out,
  privacy review), about 1,580 in 5 PRs (INFERRED).
- **Route:** Opus (data integrity, minors' data on shared tablets, sign-out).
- **G3:** applies.
- **Dependencies:** OQ-3 touches the live console
  (`SessionScriptLiveDelivery.tsx`), which #2005 (lane U2) also changes.
- **File overlap:** #2005 (`SessionScriptLiveDelivery.tsx`).

**Owner questions:**

- **Q7.1 Where is a failed save kept?**
  - **A (recommended):** in the open page only, retried until it goes through
    or the page closes. Nothing is stored on the device, so the PARKED row's
    identity and data-at-rest problems do not arise.
  - **B:** on the device, encrypted, tied to the signed-in person, wiped at
    sign-out. This is the design the PARKED row asks to be selected.
  - **C:** B for staff writes only, never for an athlete's own entries on a
    shared tablet.
- **Q7.2 Which saves?**
  - **A (recommended):** the live floor writes first (here taps, run actions,
    staff notes, intervention log).
  - **B:** every save in the app.

## 8. OW26-05: the typed steps in the 11 mixed templates

**Ruling:** OD-2026-11-19-030, Jason: *"B: Turn typed lines into library
drills"* (against the recommendation). Effect as recorded (INFERRED from the
card): each typed step becomes a library drill in PPBF words, AI-draft
labelled like the home week, after the pilot. The card's own cost line: "New
content to write and check, not sized".

**The list (OBSERVED):** `TYPED_IN_MIXED` in
`apps/web/src/server/pilot/committedTemplateIssueSweep.test.ts:315` on #2008's
head, 11 templates. The step numbers match the committed
`apps/web/seed-data/workout-templates/seed_workout_template_items.csv`, where a
typed step is a row with no `drill_id` (checked by script, no mismatch).

**The count (measured by script on the committed CSV):**

- **85 typed step positions.**
- **71 unique typed lines.** That is 61 distinct `free_text_drill` texts, plus
  10 steps of "Scripted 60-Minute Class (test run 4-5)"
  (`wtp_900c0a3fd4422a`) whose `free_text_drill` is empty. Their text is only
  in `details` (`block_title`, and the coach scripts in `parts`). Exact text
  and whitespace-and-case-folded text give the same count.
- **The three youth manuals.** They share 7 lines at the same positions
  (steps 1, 2, 7, 8, 9, 13, 14), and steps 10 to 12 differ. That is 16 unique
  lines for 30 positions.
- **Sparring contact.** Four typed lines carry contact above none: Friday
  Sparring step 9 (open sparring), Gold Standard steps 6 and 7 and the Phase 2
  archetype step 6 (controlled sparring).
- **Headings and instructions (INFERRED, not counted).** Some lines are block
  headings or coach instructions rather than exercises, e.g. "Warm-up — 12 min",
  "Briefing (3 min)", "Athletes rotate partners.", "Evaluate → reset". See Q8.2.
- **Library overlap (INFERRED, not counted).** Some lines look covered by
  library drills, e.g. "Punch Burst" (`drl_85a93f6757497a`), "Pogo Jumps"
  (`drl_6370c51875c49f`), "Skipping — Continuous" (`drl_40acc6820f5df6`),
  "Post-Session Mobility" (`drl_786d761c9321c0`). Matching is a content call.
  See Q8.1.

**Per-drill cost (measured on HW #1980):**

- **CSV lines.** 6 drafted drills took 41 drill-CSV lines (library row, three
  scale levels, own stop rules, cue), about 7 per drill.
- **Review sheet.** Each drill's section in
  `docs/content-review/home-week/HOME_WEEK_REVIEW.md` is about 13 lines.
- **Template rows.** A converted step rewrites one template-item row, which is
  2 changed lines.

**PR split (INFERRED: 20 lines per new drill, 2 per position, about 10 per
template of review header):**

| PR | Templates | Positions | New drills (if all unique lines) | Est. lines |
|---|---|---|---|---|
| TL-1 | the three 48-Session Youth Coaching Manuals | 30 | 16 | about 410 |
| TL-2 | Scripted 60-Minute Class (test run 4-5) | 10 | 10 | about 230 |
| TL-3 | Friday Sparring Coach Sheet; Wednesday Coach Sheet Defense Day; Wednesday – Gold Standard Coach Script | 18 | 18 | about 430 (may go over; 3 sparring lines) |
| TL-4 | Iso + Plyo 60-Minute Boxing Session | 13 | 13 | about 300 |
| TL-5 | Conditioning session A — SIT; Phase 2 archetype vs. pressure fighter; Phase 1 boxing skill session | 14 | 14 | about 340 (1 sparring line) |

- **Total:** about 1,700 lines in 5 PRs, if every unique line becomes a new
  drill. Fewer if Q8.1 is A.
- **Migrations:** none (HW loaded the same way, by content import).
- **Route:** Sonnet for TL-1, TL-2 and TL-4. Opus for TL-3 and TL-5 (sparring
  contact).
- **Recommendation:** every new drill carries its own stop rules (safety
  text), so I recommend an Opus reviewer on the stop rules in all five.
  Overwatch's call.
- **G3:** no screen changes. INFERRED not to apply. The load's dry run on
  staging is the check, as for HW.
- **Dependencies:** #2008 merges first. It adds `TYPED_IN_MIXED`, and each TL
  PR removes its templates' entries. Each TL PR also updates the content-count
  tests that HW had to update (test files).
- **Load:** after each merge, staging then production, by Overwatch.
- **File overlap:** #2008 changes `seed_drill_library.csv` and
  `seed_drill_cues.csv`.

**Owner questions:**

- **Q8.1 A typed line that a library drill already covers?**
  - **A (recommended):** link the existing drill; draft new drills only for the
    rest. Fewer drafts to check.
  - **B:** a new drill for every line, as the card's option text says.
- **Q8.2 A line that is a heading or an instruction, not an exercise?**
  - **A (recommended):** it still becomes a drill, as the card says (e.g. a
    12-minute warm-up drill). This matches OW26-05 B.
  - **B:** fold it into the coach note of the next drill step, and remove the
    step. This changes those templates' step lists.

---

## Summary

| # | Item | PRs | Est. lines outside tests | Migrations | Route | G3 | Waits on |
|---|---|---|---|---|---|---|---|
| 1 | Email alerts | 4 | about 1,180 | 1 | Opus | yes | Q1.1 to Q1.5 |
| 2 | Web push (later) | 3 | about 890 to 1,090 | 1 | Opus | yes | item 1; Q2.1, Q2.2; a key in Azure; a dependency call |
| 3 | On the floor now | 4 | about 640 | 0 | Opus | yes | privacy review (FN-0); Q3.1 to Q3.4; U2 for the coach home |
| 4 | Parent starts a message | 4 | about 1,120 | 1 | Opus | yes | Q4.1 to Q4.4 |
| 5 | Plan blocks; class from a plan | 4 | about 1,150 | 0 or 1 | Opus (SP-1, SP-3, SP-4), Sonnet (SP-2) | no (INFERRED) | Q5.1, Q5.2; U2 for the class screen |
| 6 | Stopped coming | 2 (3 if Q6.4 B) | about 550 | 0 (1 if Q6.4 B) | Opus | yes | Q6.1 to Q6.4; U2 for the door |
| 7 | Offline save queue | 4 (5 if B) | about 1,080 (1,580 if B) | 0 or 1 | Opus | yes | BLOCKED: Q7.1, Q7.2 |
| 8 | Typed lines to drills | 5 | about 1,700 (less if Q8.1 A) | 0 | Sonnet (TL-1, 2, 4), Opus (TL-3, 5) | no (INFERRED) | #2008 merged; Q8.1, Q8.2 |

**Total (INFERRED):**

- **Size:** 30 PRs, about 8,310 changed lines outside tests, with the
  recommended answers. Taking each item's larger case (web push without the
  package, offline queue B, the "reached out" mark) gives 32 PRs and about
  9,210.
- **Migrations:** 4 or 5 with the recommended answers; 3 to 6 across all
  answers.
- **Questions:** 25 owner questions (Q1.1 to Q8.2).
- **Route:** 26 of the 30 PRs route to Opus.
- **Not given here:** a completion date. Lane throughput was not measured by
  this lane.

**Order that the dependencies allow (INFERRED):**

- Item 8 can start once #2008 merges; it needs only Q8.1 and Q8.2.
- Items 1, 4 and 6 need only their questions.
- Item 3 needs its privacy review first.
- Item 5's class part and items 3 and 6's coach-side pieces wait on lane U2's
  files.
- Item 2 waits on item 1.
- Item 7 is BLOCKED until Q7.1 selects a design.

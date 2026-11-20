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

## How the sizes were made

A size is the changed lines outside tests: insertions plus deletions from
`git show --numstat`, leaving out `*.test.*` files. Every size here is an
INFERRED estimate, made one of two ways.

- **Matched (11 of the 30 PRs):** EM-1, EM-2, FN-2, FN-3, PM-1 and the six TL
  PRs. Each is matched to a merged PR of the same shape, measured below. The TL
  PRs use the home week's per-drill rates.
- **Judgement (the other 19):** each is my estimate from the code it would
  change. Its table row says "judgement".

The merged PRs, measured that way on `main`:

| Merged PR (commit) | Shape | Non-test lines, measured (code and SQL; for HW, content and review sheet) |
|---|---|---|
| AS2-a #1984 (`f71e432`) | one new table, its runner, a read route and a write route, audited | 414 (366 code, 48 SQL) |
| AS2-c #1986 (`054cf74`) | one settings control on an existing page | 174 |
| SH-3 #1969 (`d37d96b`) | one line on the Parent Hub | 90 |
| SH-2 #1968 (`2062213`) | a write path, its screen and a migration | 597 (551 code, 46 SQL) |
| U2-6e #1991 (`d4df553`) | read-side change on two existing screens | 432 |
| AS2-b #1985 (`0c5392b`) | device-side behaviour across every signed-in screen | 652 |
| U2-6a #2001 (`0752bb4`) | a new page | 754 (750 without a 4-line e2e spec) |
| HW #1980 (`f97f7c1`) | 6 AI-drafted drills, 6 templates, review sheet | 529 (drill CSVs 41, template CSVs 160, review sheet 325, track 2, ACTIVE_WORK 1) |

**The judgement rows may read low.** Six of these eight merged PRs went over
the brief's "about 400". The judgement rows mostly sit at 220 to 350. If every
judgement row came in at the median of the eight measured PRs (about 480), the
total would be about 12,500 lines rather than about 8,500, with more PRs where
a row goes over 400. Each table marks a PR that may go over. Tests are not
counted; in the PRs above they were 0.6 to 3.5 times the non-test lines.

**Risk route** (from the brief): Opus for sign-in, permissions, minors' data
and safety; Sonnet otherwise. **G3** is Jason's signed-in staging check for
sign-in, minors' data and safety screens, run once per wave (OW26-01,
OD-2026-11-19-015).

**New restrictions.** Two rules bear on the questions below:

- The brief's L1 rule: no new warnings, gates or disclaimers for minors.
- RULES section 1, folded word for word into OD-2026-11-10-001: "Do not add new
  restrictions, warnings or gates unless the owner directs it." That entry
  also says the fold "rules nothing".

Where an option would add a restriction, the question says so.

---

## 1. Opt-in, content-free email alerts

**Ruling:** OD-2026-11-19-019, Jason: *"1 and 2 now we will do 3 later"*.

- **What it means.** The entry reads this as in-app alerts plus "an opt-in,
  content-free email from the gym's Microsoft 365 mailbox that says only "open
  the app"" now, and web push later.
- **What it changes.** OD-2026-10-01-006 and -008 "for outside alerts" (-008
  section 3 had said "No email, text or push").
- **What it leaves open.** Its "Not ruled here" line says "the email lane's
  build" is not ruled.
- **Recorded scrub answers.** OD-2026-11-19-009's table records, against the
  "Notifications file", the "Alert wording" answer "Only 'open the app'" and
  the "Page counts" answer "B: totals only, no user, device or IP". That entry
  says "Ruling: none by this entry".

**What exists (OBSERVED):**

- **The mailer.** `apps/web/src/server/pilot/graphMailer.ts:120`,
  `sendPlainTextMail(`, takes any `to`, `subject` and `body`. Its header says
  "NOT A GENERAL MAILER" (`:25`) and "Magic links are the only thing this
  platform sends" (`:28-29`).
- **Its one caller.** The only importer outside tests is
  `apps/web/src/server/pilot/magicLinkStore.ts:7`. The sender mailbox is a
  constant in `magicLinkStore.ts:29`.
- **How it signs in.** The app's managed identity
  (`managedIdentityToken.ts:133-134`, `IDENTITY_ENDPOINT` and `IDENTITY_HEADER`).
- **The one-mailbox rule.** `graphMailer.ts:15-23` says Mail.Send is
  tenant-wide, and that an Exchange Application Access Policy restricts it to
  one sender, which the module cannot enforce. `assertSenderIsExpected`
  (`:114`, called at `:125`) refuses any sender other than the configured one.
  UNVERIFIED whether that policy is applied in Azure.
- **Where addresses are.** `pilot.accounts.login_email`
  (`infra/azure/pilot_slice_postgres.sql:27`) and `pilot.parents.email` (`:293`).
- **The in-app alert.** `pilot.safety_escalations` is pull-only. The migration
  says "There is no notification channel in this platform at all"
  (`infra/azure/pilot_slice_postgres_safety_escalations_migration.sql:9-10`).
  Coaches read their own athletes' rows
  (`apps/web/app/api/pilot/escalations/route.ts:35`, `:45`). The header badge
  polls every 2 minutes (`apps/web/components/SafetyAttentionBadge.tsx:81`).
- **SHADOW disclosures.** The disclosure path files a row for the coach of
  record, any covering coach and admins, and says "No email, text or push --
  the escalation list is the only channel"
  (`apps/web/src/server/pilot/shadowDisclosure.ts:19-20`, `:328`).
- **Family notes.** Parents' replies send nothing: "Nothing is sent (no email,
  no push)" (`apps/web/src/server/pilot/familyMessageReplies.ts:20`).
- **A tick to send on.** The SHADOW job worker starts in
  `apps/web/instrumentation.ts:38`, with sweep and housekeeping hooks
  (`:47`, `:63`). It runs only when `PPBF_SHADOW_WORKER_ENABLED` is set
  (`apps/web/src/server/pilot/shadowJobWorker.ts:28`).

**What is missing:**

- **Preferences.** A search of `infra/azure/*.sql` for `opt_in`,
  `notification_pref`, `email_pref`, `unsubscribe` and `email_consent` found no
  email preference; the only opt-in is cycle tracking.
- **A queue.** A search of `apps/web` for `outbox` found no match.
- **So missing are:** who opted in; which events send; who receives each; a
  send log; retries and a rate limit; the opt-in screen.
- **Comments to correct.** The "sends no email" comments in
  `apps/web/app/api/pilot/escalations/route.ts:16-17`, `shadowDisclosure.ts:20`,
  `familyMessageReplies.ts:20` and `graphMailer.ts:25-29`. Migration files are
  left as written.

**PR split (INFERRED):**

| PR | What | Est. lines | Basis |
|---|---|---|---|
| EM-1 | Migration: an opt-in table (per account, opted-in and opted-out times, audited) and a send log (what Q1.6 allows; no message content). Runner, own-account read and write route. | about 420 (may go over) | matched, AS2-a 414 |
| EM-2 | The opt-in switch on the account's own settings page | about 180 | matched, AS2-c 174 |
| EM-3 | The sender: a send-log sweep on a server tick, a per-person rate limit, retry, through `sendPlainTextMail`. The comments above corrected. | about 300 | judgement |
| EM-4 | Trigger points and recipients: the events Q1.1 names, each resolved to the people who can already read it in the app and who opted in | about 280 | judgement |

- **Total:** about 1,180 lines in 4 PRs.
- **Migrations:** 1, in EM-1.
- **Route:** Opus for all four (sign-in addresses, minors' contacts, safety alerts).
- **G3:** applies. EM-2 is a sign-in-account screen; EM-4 routes safety alerts.
- **Dependencies:** none on open PRs. Item 2 reuses EM-1 and EM-3. Item 4 may
  add a trigger (Q4.3).
- **File overlap:** none with #2005 to #2010 (their changed-file lists and plan
  bodies, read 2026-11-20).

**Owner questions:**

- **Q1.1 Which events send the email?**
  - **A (recommended):** the events that already raise something in the app
    for that person: a safety escalation a staff member can read, including
    SHADOW safety alerts, and a new family note or parent reply.
    (OD-2026-10-01-008 section 3 kept SHADOW alerts in-app only;
    OD-2026-11-19-019 changes it "for outside alerts".)
  - **B:** safety escalations for staff only.
  - **C:** A plus gym announcements.
- **Q1.2 Who may opt in?**
  - **A (recommended):** anyone with a sign-in email. This adds no new
    restriction (the L1 rule and RULES section 1, above), and the email holds
    nothing but "open the app".
  - **B:** staff (coach, admin, organization admin) and parents only. This is a
    new restriction, so it needs Jason's direction.
  - **C:** B, plus athletes 18 or over. An athlete with no date of birth counts
    as a minor (OD-2026-10-04-010). This is also a new restriction.
- **Q1.3 How often?**
  - **A (recommended):** at most one email per person per hour, whatever the
    number of events.
  - **B:** one email per event.
  - **C:** one a day.
- **Q1.4 How does a person opt out?**
  - **A (recommended):** with the same switch in the app. The email holds only
    "open the app" (the recorded "Alert wording" answer).
  - **B:** also with a link in the email.
- **Q1.5 Which mailbox sends it?**
  - **A (recommended):** the gym mailbox that sends sign-in links today. This
    needs no Azure or Microsoft 365 change.
  - **B:** a separate gym mailbox. Jason would first set it up in Microsoft
    365, widen the mailbox access policy (`graphMailer.ts:15-23`) and change
    the configured sender.
- **Q1.6 What may the send log keep?** The recorded "Page counts" answer, "B:
  totals only, no user, device or IP", sits against the same "Notifications
  file", and the record does not say whether it reaches an email send log.
  - **A (recommended):** who was sent an email and when, nothing else. That is
    what the per-person limit (Q1.3 A) needs.
  - **B:** totals only. Then a per-person limit cannot be kept across a
    restart.
- **Q1.7 What does the subject line say?** The recorded answer covers only the
  body.
  - **A (recommended):** the gym's name and "open the app", nothing else.
  - **B:** "open the app" only.

## 2. Web push (later, per Jason)

**Ruling:** OD-2026-11-19-019: web push "is later"; its build is "Not ruled
here". Sized only.

**What exists (OBSERVED, searches):**

- **No push code.** A search of the repository for `serviceWorker`,
  `PushManager`, `VAPID`, `web-push`, `webmanifest`, `sw.js`,
  `pushSubscription` and `Notification.requestPermission` found no match
  outside prose saying there is no service worker.
- **No web app manifest.** The one `manifest.json` is
  `design-system/manifest.json`, which is not a web app manifest.
- **No package.** `web-push` is not in `apps/web/package.json`.

**External fact (UNVERIFIED against the primary page):**

- On iPhone and iPad, web push works only for a site added to the Home Screen,
  from iOS and iPadOS 16.4, and permission may be asked only on a user's tap.
- This comes from a web search summary of the WebKit blog post "Web Push for
  Web Apps on iOS and iPadOS"; the primary page was not opened.
- The gym's tablets are planned as iPad and Android (OD-2026-11-19-009, facts
  table). Android behaviour was not checked.

**What is missing:** a web app manifest, a service worker (push only, no
caching), a subscription per account per device, a VAPID key pair (a secret),
a sender, an opt-in on a tap, and removing the subscription at sign-out. Gym
tablets are shared, and they sign out after idle time
(`apps/web/components/TabletIdleSignOut.tsx`).

**PR split (INFERRED):**

| PR | What | Est. lines | Basis |
|---|---|---|---|
| WP-1 | Manifest, service worker, migration for subscriptions, subscribe and unsubscribe routes | about 420 (may go over) | judgement |
| WP-2 | The sender, on EM-3's send log: VAPID signing and payload encryption | about 250 with the `web-push` package; about 450 without | judgement |
| WP-3 | The opt-in on a tap; unsubscribe at sign-out | about 220 | judgement |

- **Total:** about 890 to 1,090 lines in 3 PRs.
- **Migrations:** 1.
- **Also needs:** one new dependency if `web-push` is used (Overwatch's call),
  and one secret that Overwatch or Jason puts in Azure. No AI enters a secret.
- **Route:** Opus (sign-in and sign-out, shared tablets, minors).
- **G3:** applies.
- **Dependencies:** item 1 (EM-1 and EM-3) first. WP-3 touches the tablet
  sign-out work of lane U1's AS2 PRs (merged).
- **File overlap:** none with the open PRs.

**Owner questions (for when web push is started):**

- **Q2.1 Push on a shared gym tablet?**
  - **A (recommended):** allowed like any device; the subscription ends at
    sign-out. This adds no new restriction.
  - **B:** no push on a device marked as a gym tablet. This is a new
    restriction, so it needs Jason's direction.
- **Q2.2 Same events and limits as the email?**
  - **A (recommended):** yes, the Q1.1 and Q1.3 answers.
  - **B:** its own list.

## 3. A live "on the floor now" line on every home

**Source:** OD-2026-11-19-009 records the App Scrub answer to "Q12 live floor
line" as "A: on every home; parents see only their own child", affecting
"Navigation map; FUTURE lane with a privacy review". That entry says "Ruling:
none by this entry". The brief says the privacy review comes first.

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
  A guardian's access ends at 18 (`apps/web/src/server/pilot/guardianAccess.ts:46`,
  `:70`, `:111`).

**What is missing:**

- **A gym-wide read.** The live-run read returns only the caller's own run
  (`sessionScriptRuns.ts:315`). Needed is a "who is here now" read, cut by role:
  staff see the gym, a parent sees only their own children, an athlete sees only
  themselves.
- **The line** on four homes.
- **The privacy review.**

**PR split (INFERRED):**

| PR | What | Est. lines | Basis |
|---|---|---|---|
| FN-0 | Privacy review, docs only: what each role sees, what the public wall already shows, the minors rules | about 120 | judgement |
| FN-1 | One read and route, cut by role (staff; parent via `guardianAthleteIds`; athlete self) | about 250 | judgement |
| FN-2 | The line on the Parent Hub and the athlete home | about 150 | matched, SH-3 90, two homes |
| FN-3 | The line on the coach home and the admin home | about 120 | matched, SH-3 90 |

- **Total:** about 640 lines in 4 PRs.
- **Migrations:** none (INFERRED: built on the tables above).
- **Route:** Opus for FN-0 to FN-3 (minors' data).
- **G3:** applies.
- **Dependencies:** FN-0 before FN-1, signed off as Q3.5 says.
- **File overlap:**
  - FN-2 changes `AthleteWorkspace.tsx`, which #2006 (lane U3) plans to change,
    and U2 item 4e later.
  - FN-3 changes `CoachWorkspace.tsx`, lane U2's file (AS-7, coach home). #2010
    (lane AS-5) would also edit it if Overwatch picks its Q11 B.

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
- **Q3.5 Who signs off the privacy review (FN-0) before FN-1 starts?**
  - **A (recommended):** Jason. It decides what minors' data each home shows.
  - **B:** Overwatch, after two adversarial reviewers pass it, the way content
    drafts are handled (OD-2026-11-15-011).

## 4. A parent starts a message to the coach (scrub FAM-09)

**What exists (OBSERVED):** a parent can already write to the coach, and a coach
can already write to the family. Neither side can answer the other's note in a
thread the parent started.

- **Parent to coach: the note (WO-PH-04).** A guardian writes a free-text note
  for the coach about their own child
  (`apps/web/app/api/pilot/parent/observations/route.ts:17-35`), from
  `apps/web/components/ParentObservations.tsx:98` on the Parent Hub
  (`ParentHub.tsx:1870`).
  - It is a `pilot.coach_observations` row: "No new table, no migration"
    (`route.ts:22-26`).
  - A guardian reads only the notes they wrote, not the other guardian's (the
    split-household line LQ-PH04-1, `route.ts:28-30`).
  - Staff read it under "From the family" on `/coach/decision-loop`, through
    `GET /api/pilot/coach/family-observations` (`route.ts:31-34`).
- **Parent to coach: barrier reports.** A parent can also send one
  (`apps/web/app/api/pilot/parent/barrier-report/route.ts:43`).
- **Coach to family.** A coach posts a note to the family as a
  `coach_observations` row with `note_type 'parent_message'`
  (`apps/web/app/coach/decision-loop/page.tsx:1102`). The parent reads it
  (`apps/web/app/api/pilot/parent/messages/route.ts:36`, `:38`).
- **Parent replies.** The parent replies under a coach note in
  `pilot.family_message_replies`
  (`infra/azure/pilot_slice_postgres_family_message_replies_migration.sql:62`),
  whose author must be a parent (`:83`).
- **Unread state.** Both sides keep it:
  `pilot_slice_postgres_family_message_reads_migration.sql:59` and
  `pilot_slice_postgres_family_reply_reads_migration.sql:54`. The parent's
  count is at `apps/web/components/ParentHub.tsx:1476`. The coach's "New" mark
  is per reply, for each staff member, on one athlete's panel
  (`apps/web/components/FamilyNotesPosted.tsx:15-16`, `:42-44`).
- **Who coaches whom.** The assigned coach plus active cover is
  `athleteIdsForCoach` (`apps/web/src/server/pilot/access.ts:508`, `:511-516`).
  The guardian check is `isGuardianLinkedToAthlete`
  (`apps/web/src/server/pilot/guardianAccess.ts:70`).

**What is missing (for Q4.1 A):**

- a staff reply under a parent's note;
- the parent seeing that reply, with unread state;
- an unread count across the roster for staff;
- the storage for the reply. INFERRED: the reply table allows only a parent
  author (`:83`), so a staff reply needs a migration.

**PR split (INFERRED), for Q4.1 A:**

| PR | What | Est. lines | Basis |
|---|---|---|---|
| PM-1 | Migration, store and routes: a staff reply under a parent's note; the parent reads it; read state | about 380 | matched, AS2-a 414 |
| PM-2 | Staff side: reply on "From the family", and the unread count across the roster | about 300 | judgement |
| PM-3 | Parent side: the thread under their note on the Parent Hub, with unread | about 200 | judgement |

- **Total:** about 880 lines in 3 PRs. If Q4.1 is B (a new thread type), add
  one PR and about 240 lines (judgement).
- **Migrations:** 1.
- **Route:** Opus (minors' data, permissions, guardian access).
- **G3:** applies.
- **Dependencies:** a Q4.3 A answer makes item 1 (EM-4) send for it.
- **File overlap:**
  - PM-2 changes `apps/web/app/coach/decision-loop/page.tsx`, which #2010
    (lane AS-5) plans to change in AS5-1.
  - A coach-home inbox (Q4.4 B) changes `CoachWorkspace.tsx`, which is U2's
    file and #2010's Q11 B.

**Owner questions:**

- **Q4.1 Does FAM-09 extend the parent's note (WO-PH-04), or start something new?**
  - **A (recommended):** extend the note. Staff can reply under it, and the
    parent sees the reply. It reuses the record and the split-household line.
  - **B:** a new message thread, separate from the note.
- **Q4.2 Does the other guardian see the thread?**
  - **A (recommended):** no. Each guardian sees their own, the same line the
    note and the barrier report draw for split households (LQ-PH04-1).
  - **B:** both guardians see it.
- **Q4.3 Does a parent's new note send the email alert (item 1)?**
  - **A (recommended):** yes, to staff who opted in.
  - **B:** in the app only.
- **Q4.4 Where do coaches answer?**
  - **A (recommended):** on the Decision Loop's "From the family", where the
    notes are read today.
  - **B:** on the coach home, beside the alerts.
- **Q4.5 Whose unread count does a new note raise?** Today any staff member can
  read every note type (`route.ts:31-32`).
  - **A (recommended):** the child's assigned coach, any coach covering them,
    and admins: the people a SHADOW safety alert reaches (OD-2026-10-01-008
    section 3).
  - **B:** every coach in the gym.

## 5. A coach adds drills or blocks to a session plan, and schedules a class from it (scrub CF-11)

**What exists (OBSERVED):**

- **The screen.** "Session Plans" is the screen name for session scripts
  (`apps/web/app/coach/session-scripts/page.tsx:477`).
- **Making a plan.** A plan is made only from a workout template
  (`apps/web/app/api/pilot/session-scripts/route.ts:125-132`;
  `apps/web/app/coach/workout-templates/MakeSessionScript.tsx:78-82`), or by an
  admin content import.
- **Editing a plan.** The edit route also retires a plan and marks it reviewed
  (`route.ts:174`). Its edit changes the plan's name and each block's title and
  minutes only. The server says "blocks are never added, removed or reordered
  here" (`apps/web/src/server/pilot/sessionScriptAuthoring.ts:409-411`) and
  refuses an unknown block (`:436-437`). A plan that has been run gets a new
  version (`:31-38`, `:500-551`).
- **Blocks.** A block can name a library drill
  (`infra/azure/pilot_slice_postgres_session_scripts_migration.sql:87`). Its
  order is unique within the plan (`:96`), and it must hold some text
  (`:99-100`). The template path meets that by writing the step's facts into
  `what_to_explain` (`sessionScriptAuthoring.ts:140-142`).
- **Scheduling.** A coach schedules their own classes
  (`apps/web/app/api/pilot/scheduler/route.ts:804-806`, `:831-832`) from
  `/schedule` (`apps/web/app/schedule/page.tsx:1044`). A class row has no plan
  column (`infra/azure/pilot_slice_postgres_scheduler_tables_migration.sql:11-26`).
- **Class and plan.** They meet only when a session starts
  (`apps/web/src/client/startClassSession.ts:45-52`). The class screen starts
  with no plan (`apps/web/app/coach/class/page.tsx:147`). Its comment at `:19`
  says "Plans are still started from Session Plans".

**What is missing:**

- **The block edits.** Adding a block (a drill from the library), and removing
  and reordering blocks. INFERRED: these need no migration. Order can be
  renumbered in one transaction, and a new drill block can carry "From the
  drill" facts in `what_to_explain`, the way template steps do.
- **The class link.** A class that carries a plan, which needs a migration,
  and the class screen starting that plan.

**PR split (INFERRED):**

| PR | What | Est. lines | Basis |
|---|---|---|---|
| SP-1 | Server and edit route: add a drill block, remove a block, move a block; the versioning as today | about 350 | judgement (`sessionScriptAuthoring.ts` is 724 lines) |
| SP-2 | The editor: a drill picker, remove, move up and down | about 300 | judgement (`SessionScriptEditor.tsx` is 259 lines) |
| SP-3 | Migration: a plan link on a scheduled class; the scheduler accepts it | about 250 | judgement |
| SP-4 | "Schedule a class" from Session Plans; the class screen starts the class's plan | about 250 | judgement |

- **Total:** about 1,150 lines in 4 PRs.
- **Migrations:** 1 (SP-3), only if Q5.2 is A.
- **Route:**
  - Sonnet for SP-2.
  - Opus for SP-1, because a sparring-contact drill could be added to a plan.
    UNVERIFIED whether any gate reads a block's contact level at run time; a
    search was not conclusive.
  - Opus for SP-3 and SP-4 (the scheduler's role gate).
- **G3:** INFERRED not to apply (no sign-in, minors' data or safety screen),
  unless SP-1 finds a contact gate.
- **Dependencies:** OD-2026-10-21-002 D4 ("A: Tie them") already ties a session
  to its class at start. SP-4 changes the class screen, which lane U2 owns
  (6b to 6d not started).
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

- **Passbook Gaps is not this check.** The page says it is "not a check on who
  has stopped coming" (`apps/web/app/coach/passbook-gaps/page.tsx:184`; also
  `:22`, `:155`).
- **The guard.** A test keeps any door from claiming the words "until a page
  answers it" (`apps/web/components/buildingMap.test.ts:498-501`). SC2-1
  (#1981) took the words off the door
  (`apps/web/components/buildingMap.ts:461-463`).
- **Per-athlete data.** Last present date and days since, over 28 days, from
  `getAttendanceLast28Days`
  (`apps/web/src/server/pilot/attendancePrecedence.ts:241`, `:262`, `:286`).
- **Membership status.** It is active, lapsed or ended, set by hand
  (`infra/azure/pilot_slice_postgres_program_memberships_migration.sql:28`).
  A search of `apps/web` for `lapsed`, `stopped coming`, `days_since` and
  `last_seen` found no query that marks a lapse by itself.
- **Data gap (INFERRED from `sessionRunAthletes.ts:171`).** A session not tied
  to a class writes no register mark. An athlete seen only at untied open gym
  may have no attendance record, and would look as if they had stopped coming.

**What is missing:** a gym-wide list of athletes with no present mark for a set
number of days, looking further back than 28 days. It also needs its page, a
door, and the guard test turned to require that door.

**PR split (INFERRED):**

| PR | What | Est. lines | Basis |
|---|---|---|---|
| SC-1 | Query and route (coach, admin), reading register marks and, with Q6.3 A, session marks | about 300 | judgement |
| SC-2 | Page, door, guard test turned | about 250 | judgement |

- **Total:** about 550 lines in 2 PRs.
- **Migrations:** none (INFERRED), unless Q6.4 is B.
- **Route:** Opus (minors' data).
- **G3:** applies.
- **Dependencies:** the door is in `buildingMap.ts`; sequence with lane U2's
  AS-4.
- **File overlap:**
  - `buildingMap.ts`: U2's AS-4 (not open yet), and #2010 if Overwatch picks
    its Q11 B.
  - `apps/web/components/buildingMapCoverage.test.ts`: #2009 (lane BT) changes
    it, and a new door will likely touch it.

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
  - **A (recommended):** yes. Open-gym "here" marks count too; SC-1 reads them
    from the session marks (in its estimate).
  - **B:** register marks only.
- **Q6.4 What can a coach do on the page?**
  - **A (recommended):** read the list and open the athlete.
  - **B:** A, plus mark "reached out". That needs a migration and a third PR
    (about 200 lines more).

## 7. An offline save queue: failed saves are kept and retried

**Rulings and records (OBSERVED):**

- OD-2026-09-28-008: "offline storage stays parked".
- The PARKED row `BACKLOG-offline-write-queue` in `docs/current/ACTIVE_WORK.md`
  (`:269` on main, `:270` once this PR's row is in): re-open when "A concrete
  identity-scoped encrypted/offline storage design is selected".
- `docs/current/ACTIVE_WORK.md:55`: "online-only writes until the
  offline-storage decision is made".
- OD-2026-11-19-009 records the "Failed saves" answer "A: small honesty fixes
  now, offline queue later". That entry says "Ruling: none by this entry".

**State: BLOCKED until Q7.1 is answered.** Building a queue that stores data on
the device before a design is selected would go past the PARKED row's re-open
condition.

**What exists (OBSERVED):**

- **No device storage.** A search of `apps/web` outside tests for
  `serviceWorker`, `indexedDB`, `navigator.onLine`, `Idempotency-Key`,
  `workbox`, `dexie` and `localforage` found no match.
- **Browser storage.** `localStorage` holds UI preferences, the gym-tablet
  device mark (`apps/web/src/lib/gymTabletMark.ts`) and the chosen child
  (`apps/web/src/lib/chosenChild.ts`); no save payload. `sessionStorage` holds
  only a pending request key, never the payload
  (`apps/web/app/schedule/page.tsx:262`, `apps/web/app/coach/test-day/page.tsx:77-78`).
- **Writes that are safe to repeat:**
  - class create, by request key (`apps/web/app/api/pilot/scheduler/route.ts:163-176`);
  - the intervention log, by request key
    (`apps/web/app/api/pilot/coach/intervention-executions/route.ts:119`);
  - the live "here" tap, by its natural key
    (`apps/web/src/server/pilot/sessionRunAthletes.ts:120`).
- **Writes with no request key:** staff notes
  (`apps/web/components/SessionStaffNotesPanel.tsx:199`) and the run actions
  (`apps/web/app/api/pilot/session-scripts/runs/[runId]/route.ts:38`).
- **Failure messages.** Each failure shows a message and none retries, e.g.
  `apps/web/components/SessionRunPresence.tsx:195` and
  `apps/web/components/SessionScriptLiveDelivery.tsx:126-127`.
- **A retry pattern to copy.** The tablet sign-out retries every 15 seconds and
  on `online` (`apps/web/components/TabletIdleSignOut.tsx:69`, `:145`, `:148`).
- **Sign-out does not reload the page.** The header's sign-out is a soft
  navigation except on camera pages
  (`apps/web/components/GlobalRoleHeader.tsx:199-200`). So page memory, and an
  in-memory queue, can outlive a sign-out on a shared tablet.

**What is missing:**

- a client queue, with each queued save bound to the account that made it and
  dropped at sign-out or when the signed-in account changes;
- request keys on the writes that lack them;
- the retry;
- what the screen says while a save waits.

If Q7.1 is B, also missing is encrypted device storage tied to the signed-in
person and wiped at sign-out.

**PR split (INFERRED), for Q7.1 A:**

| PR | What | Est. lines | Basis |
|---|---|---|---|
| OQ-1 | Request keys on staff notes and run actions (server, and a migration for their unique keys if the natural keys do not cover them) | about 300 | judgement |
| OQ-2 | One client retry queue, in memory, bound to the account; dropped at sign-out or an account change; the waiting and failed words | about 320 | judgement |
| OQ-3 | Wire the live floor writes (here taps, run actions, staff notes, intervention log) | about 250 | judgement |
| OQ-4 | Wire the other writes Q7.2 names | about 250 | judgement |

- **Total:** about 1,120 lines in 4 PRs, with 0 or 1 migration.
- **If Q7.1 is B:** add about 500 lines (encrypted store, wipe at sign-out,
  privacy review), about 1,620 in 5 PRs (judgement).
- **Route:** Opus (data integrity, minors' data on shared tablets, sign-out).
- **G3:** applies.
- **Dependencies:** OQ-3 touches the live console
  (`SessionScriptLiveDelivery.tsx`), which #2005 (lane U2) also changes.
- **File overlap:** #2005 (`SessionScriptLiveDelivery.tsx`).

**Owner questions:**

- **Q7.1 Where is a failed save kept?**
  - **A (recommended):** in the open page only, retried until it goes through
    or the page closes. Each save is tied to the account that made it and
    dropped at sign-out (above).
    - INFERRED: nothing is left on the device after the page closes, so the
      data-at-rest problem does not arise.
    - The attribution problem rests on that tie and drop, which OQ-2 must
      prove with a test.
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
drills"* (against the recommendation).

- **Effect, as recorded** (INFERRED from the card): each typed step becomes a
  library drill in PPBF words, AI-draft labelled like the home week, after the
  pilot.
- **The card's own cost line:** "New content to write and check, not sized".

**The list (OBSERVED):** `TYPED_IN_MIXED` in
`apps/web/src/server/pilot/committedTemplateIssueSweep.test.ts:315`, on #2008's
head, lists 11 templates. The step numbers match the committed
`apps/web/seed-data/workout-templates/seed_workout_template_items.csv`, where a
typed step is a row with no `drill_id` (checked by script, no mismatch).

**The count (measured by script on the committed CSV, and recounted by the
citation reviewer):**

- **85 typed step positions.**
- **71 unique typed lines.**
  - 61 of them are distinct `free_text_drill` texts. Exact text and
    whitespace-and-case-folded text give the same count.
  - The other 10 are steps of "Scripted 60-Minute Class (test run 4-5)"
    (`wtp_900c0a3fd4422a`) whose `free_text_drill` is empty. Their text is only
    in `details` (`block_title`, and the coach scripts in `parts`). The 10 are
    distinct, and none repeats a typed text.
- **The three youth manuals.** They share 7 lines at the same positions (steps
  1, 2, 7, 8, 9, 13 and 14); steps 10 to 12 differ. That is 16 unique lines for
  30 positions.
- **Sparring contact.** Four typed lines carry contact above none:
  - Friday Sparring step 9 (open sparring);
  - Gold Standard steps 6 and 7, and Phase 2 archetype step 6 (controlled
    sparring).
- **Headings and instructions (INFERRED, not counted).** Some lines are block
  headings or coach instructions rather than exercises, e.g. "Warm-up — 12 min",
  "Briefing (3 min)", "Athletes rotate partners.", "Evaluate → Reset". See Q8.2.
- **Library overlap (INFERRED, not counted).** Some lines look covered by
  library drills: "Punch Burst" (`drl_85a93f6757497a`), "Pogo Jumps"
  (`drl_6370c51875c49f`), "Skipping — Continuous" (`drl_40acc6820f5df6`),
  "Post-Session Mobility" (`drl_786d761c9321c0`). Matching is a content call.
  See Q8.1.

**Rates (measured on HW #1980):**

- **Per drill.** 6 drafted drills took 41 drill-CSV lines (library row, three
  scale levels, own stop rules, cue), about 7 each. Each drill's section in
  `docs/content-review/home-week/HOME_WEEK_REVIEW.md` is 13 or 14 lines.
- **Per template.** A day's section is about 18 lines (lines 72-182 for six
  days).
- **Per converted step.** It rewrites one template-item row, which is 2 changed
  lines.
- **Per PR.** The sheet has about 70 lines before its first day and 13 for its
  reviews.

**Estimate formula (INFERRED):** 20 lines per new drill, 2 per position, 18 per
template, and 50 per PR for the opening and the reviews.

**PR split:**

| PR | Templates | Positions | New drills (if all unique lines) | Est. lines |
|---|---|---|---|---|
| TL-1 | the three 48-Session Youth Coaching Manuals | 30 | 16 | about 480 (over 400; the shared lines tie the three together. It can split into the 16 drills, about 370, then the 30 step rewrites, about 110) |
| TL-2 | Scripted 60-Minute Class (test run 4-5) | 10 | 10 | about 290 |
| TL-3a | Friday Sparring Coach Sheet; Wednesday Coach Sheet Defense Day | 11 | 11 | about 330 (1 sparring line) |
| TL-3b | Wednesday – Gold Standard Coach Script | 7 | 7 | about 220 (2 sparring lines) |
| TL-4 | Iso + Plyo 60-Minute Boxing Session | 13 | 13 | about 350 |
| TL-5 | Conditioning session A — SIT; Phase 2 archetype vs. pressure fighter; Phase 1 boxing skill session | 14 | 14 | about 410 (may go over; 1 sparring line) |

- **Total:** about 2,080 lines in 6 PRs, if every unique line becomes a new
  drill. Fewer if Q8.1 is A.
- **Migrations:** none. HW loaded the same way, by content import.
- **Route:** Opus for all six. Every new drill carries its own stop rules
  (safety text), TL-1 is the youth manual, and four lines carry sparring
  contact.
- **G3:** no screen changes; INFERRED not to apply. The load's dry run on
  staging is the check, as for HW.
- **Dependencies:** #2008 merges first. It adds `TYPED_IN_MIXED`, and each TL
  PR removes its templates' entries.
- **Load:** after each merge, staging then production, by Overwatch.
- **File overlap with #2008, which changes all of these:**
  - `seed_drill_library.csv` and `seed_drill_cues.csv`;
  - test files that each TL PR will also edit:
    `apps/web/src/server/pilot/committedTemplateIssueSweep.test.ts`,
    `apps/web/src/server/pilot/ft1ContentPackage.pg.test.ts`,
    `apps/web/scripts/backbone-export-ft1-track.test.ts`.

**Owner questions:**

- **Q8.1 A typed line that a library drill already covers?**
  - **A (recommended):** link the existing drill, and draft new drills only for
    the rest. That leaves fewer drafts to check.
  - **B:** a new drill for every line, as the card's option text says.
- **Q8.2 A line that is a heading or an instruction, not an exercise?**
  - **A (recommended):** it still becomes a drill, as the card says (e.g. a
    12-minute warm-up drill). This matches OW26-05 B.
  - **B:** fold it into the coach note of the next drill step, and remove the
    step. This departs from OW26-05 B's "Each typed step becomes a drill" and
    changes those templates' step lists.

---

## Summary

| # | Item | PRs | Est. lines outside tests | Migrations | Route | G3 | Waits on |
|---|---|---|---|---|---|---|---|
| 1 | Email alerts | 4 | about 1,180 | 1 | Opus | yes | Q1.1 to Q1.7 |
| 2 | Web push (later) | 3 | about 890 to 1,090 | 1 | Opus | yes | item 1; Q2.1, Q2.2; a key in Azure; a dependency call |
| 3 | On the floor now | 4 | about 640 | 0 | Opus | yes | privacy review (FN-0, Q3.5); Q3.1 to Q3.4; U2 for the coach home |
| 4 | Parent starts a message | 3 (4 if Q4.1 B) | about 880 (1,120 if B) | 1 | Opus | yes | Q4.1 to Q4.5 |
| 5 | Plan blocks; class from a plan | 4 | about 1,150 | 0 or 1 | Opus (SP-1, SP-3, SP-4), Sonnet (SP-2) | no (INFERRED) | Q5.1, Q5.2; U2 for the class screen |
| 6 | Stopped coming | 2 (3 if Q6.4 B) | about 550 | 0 (1 if Q6.4 B) | Opus | yes | Q6.1 to Q6.4; U2 for the door |
| 7 | Offline save queue | 4 (5 if B) | about 1,120 (1,620 if B) | 0 or 1 | Opus | yes | BLOCKED: Q7.1, Q7.2 |
| 8 | Typed lines to drills | 6 | about 2,080 (less if Q8.1 A) | 0 | Opus | no (INFERRED) | #2008 merged; Q8.1, Q8.2 |

**Total (INFERRED):**

- **Size:** 30 PRs, about 8,490 changed lines outside tests, with the
  recommended answers.
- **Larger case:** taking each item's larger case (web push without the
  package, a new thread type, the "reached out" mark, offline queue B) gives
  33 PRs and about 9,630.
- **If the judgement rows run like the measured PRs:** about 12,500 (see "How
  the sizes were made").
- **Migrations:** 4 or 5 with the recommended answers; 3 to 6 across all
  answers.
- **Questions:** 29 owner questions (Q1.1 to Q8.2).
- **Route:** 29 of the 30 PRs route to Opus; SP-2 is Sonnet.
- **Not given here:** a completion date. This lane did not measure lane
  throughput.

**Order that the dependencies allow (INFERRED):**

- Item 8 can start once #2008 merges; it needs only Q8.1 and Q8.2.
- Items 1, 4 and 6 need only their questions; item 4's staff side waits for
  #2010's Decision Loop PR.
- Item 3 needs its privacy review signed off first.
- Item 5's class part and items 3 and 6's coach-side pieces wait on lane U2's
  files.
- Item 2 waits on item 1.
- Item 7 is BLOCKED until Q7.1 selects a design.

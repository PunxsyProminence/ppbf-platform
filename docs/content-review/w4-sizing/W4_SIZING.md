# W4 sizing (lane W4S)

Read-only sizing of the eight W4 items in Backbone's wave plan of 2026-11-19
(lane W4R adds item 9, room renaming),
so Overwatch can plan the last wave. Jason's card OW26-02, "C: Everything,
FUTURE items too" (OD-2026-11-19-016), says no completion date can be given
until each W4 item is sized. This file sizes them. It builds nothing and
decides nothing: every owner question is put as a question, with the
recommended option first.

- **Code read at:** `main` `7a1736d9fc9028a21d9a7f906c712244a6ad6bbb`, and line
  numbers are from that commit. `main` has since moved to `c27c581` (#2007 and
  #2015). #2007 changes no code file cited here. #2015 adds the scrub files
  cited below. ACTIVE_WORK lines are cited at `c27c581`.
- **Lane RS's list:** read at its branch head
  `1e78a04d735340e2b0ca7b76fb3cbba6416db62e` (#2008, open). Its head is now
  `37d9108`, where only one comment line of the sweep test changed, so the
  list and its line, 315, are the same.
- **Open PRs:** their files were read on 2026-11-20 at these heads: #2005
  `79f45ea6`, #2006 `c5c39034`, #2008 `37d9108d`, #2009 `21102636`, #2010
  `0d342ee3`, #2012 `5efdc9b6`, #2013 `de25bb6f`, #2016 `b42e3c66`, and nine
  dependabot PRs (#1992 `40232ce5` to #2000 `590a9b4d`). A head that moves
  later can add overlaps. #2006, #2009, #2012, #2013 and #2016 have moved since;
  the citation reviewer found the moves add none.
- **Shared registration files.** A PR here that adds a route or a migration
  also edits `apps/web/src/server/pilot/apiRouteInventory.json`,
  `apps/web/package.json` or, for a migration,
  `.github/workflows/apply-migrations.yml`, as AS2-a and SH-2 did. #2013 changes
  the first two today; no open PR changes the third. INFERRED:
  such edits usually merge line by line.
- **Labels:** OBSERVED (read in the code, with file:line), INFERRED,
  UNVERIFIED. Paths under `apps/web/` are written in full. Migrations are under
  `infra/azure/`.
- **Scrub files:** the App Scrub's stage 1 and stage 3 files are in
  `docs/research/app-scrub-2026-11-19/` since #2015. Its README says they are
  "findings and proposals, not rulings". Items 4, 5 and 6 quote their FAM-09,
  CF-11 and CF-14 rows. The stage 3 file lists all three as FUTURE (section
  3.6).
- **Lane W4R update, 2026-11-20:** item 1 re-sized under OD-2026-11-20-001;
  item 9, room renaming, added. Both read at `main` `244c13d` and re-checked at
  `600b4f7361f3c557b295aaa58a8f4c8efb141cc1`, where item 1's earlier citations
  still hold. Of the files cited, only `buildingMap.ts` changed between the two
  (#2030); its lines are cited at `600b4f7`. `main` then moved to `58974af`
  (#2025, #2031), which changes no file cited in items 1 and 9. Open PR heads
  #2017 to #2021, #2027, #2029, #2032 to #2049 and #2051 to #2053 were read the
  same day.
  Overwatch's answers on #2050 (2026-11-20) are applied: Q1.9, Q1.10 and Q8.2.
  Items 2 to 8 were not re-read: #2005, #2006, #2008, #2009, #2010, #2012,
  #2013 and #2016, cited there as open, have since merged.
- **Lane W4S-REFRESH update, 2026-11-23.** Every answer below is read from
  `docs/current/OWNER_DECISIONS.md` itself, and each change names its OD id and
  card number.
  - **Code read at:** `main` `a4b420c41a9d10c2e991df9b6290914aed41b126`. Items 2
    to 7 were re-read there: every cited file and line was checked against the
    earlier base (`7a1736d9`), and those that moved or changed were re-read
    (the cites in those items now read at `a4b420c`). Items 1, 4, 8 and 9 had
    their cites that moved updated, and item 9 re-read for U2's 4a to 4c. Where
    an item still names an older commit, its code was not re-read.
  - **Merged since the 2026-11-20 reads:** #2005 (`48bc2ae1`), #2006
    (`a940ea4a`), #2008 (`9ef38ecb`), #2009 (`79716421`), #2010 (`393d4305`),
    #2012 (`48d9bd46`), #2013 (`cdb69cff`), #2016 (`e8231d2b`), #2029
    (U2-4a, `b555d5b8`), #2068 (U2-4b, `5b28948a`) and #2073 (U2-4c,
    `3580389a`); with AS8-4 (#2100, `cc29c963`) and the PATTERN window screen
    (#2120, `fce92a0`).
  - **Open PRs on 2026-11-23** (listed through the GitHub API): #2039, #2082,
    #2124, #2126 and this one. Only #2124's files were read
    (`BehaviourSampleWindow.tsx` and its test); #2126 listed none; #2039 and
    #2082 were not read. Overlap statements say so.
  - **Applied:** OD-2026-11-21-006 (OW27-17 to OW27-36, items 2 to 7) and
    OD-2026-11-21-007 (OW27-38 to OW27-41, items 1 and 9). **OD-2026-11-23-001
    answers no W4 question.** It records the "Skip this chance" control (a coach
    write on the live floor, noted under item 7), that finished lanes are
    archived, the three live readability fixes, Overwatch's order of work and the
    staging test coach accounts. OW27-37 (the Overwatch restart limit) and
    OW27-42 to OW27-44 (words and where Overwatch 28 runs) are not W4 questions.
  - **No stale wait remains:** item 7's old wait on Q7.1 and Q7.2 is removed
    (both are answered), as are the waits on #2005 to #2016 and #2029.
  - The sections of items 2 to 7 are kept in their earlier form where nothing
    changed. A table headed "Answered since" opens each item that has answers.


## How the sizes were made

A size is the changed lines outside tests: insertions plus deletions from
`git show --numstat`, leaving out `*.test.*` files. For the seven code PRs
below, docs lines (their ACTIVE_WORK row) are also left out; for HW they are
counted, because its review sheet is part of the work. Every size here is an
INFERRED estimate, made one of two ways.

- **Matched (13 of the 32 PRs):** EM-1, EM-2, FN-2, FN-3, PM-1 and the eight TL
  PRs. Each is matched to a merged PR of the same shape, measured below. The TL
  PRs use the home week's rates and a by-script count of the step rewrites.
- **Judgement (the other 19):** each is my estimate from the code it would
  change. Its table row says "judgement".
- **After lane W4R:** 17 of 39 matched (adding EM-5, EM-6, RN-1 and RN-4) and
  22 judgement (EM-3, EM-4a, EM-4b, RN-2, RN-3 and W4S's 17 others).
- **After lane W4S-REFRESH:** 20 of 46 matched (adding SC-0a, SC-0b and SC-3a,
  each matched to AS2-a or AS2-c) and 26 judgement (adding EM-2b, SP-1b, SP-2b
  and SC-3b, and splitting SP-1 and SP-2 into a and b; WP-3, FN-1, SC-1 and SC-2
  grew).

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
total would be about 12,900 lines rather than about 9,050, with more PRs where
a row goes over 400. Each table marks a PR that may go over. Tests are not
counted; in the PRs above they were 0.6 to 3.5 times the non-test lines.
After lane W4R the same check gave about 15,700 rather than about 11,080.
The 22 judgement rows summed to about 5,970; at 480 each they would be 10,560.
After lane W4S-REFRESH the check gives about 18,600 rather than about 12,880.
The 26 judgement rows sum to about 6,770; at 480 each they would be 12,480.

**Risk route** (from the brief): Opus for sign-in, permissions, minors' data
and safety; Sonnet otherwise. **G3** is Jason's signed-in staging check for
sign-in, minors' data and safety screens, run once per wave (OW26-01,
OD-2026-11-19-015).

**New restrictions.** Where an option would add a restriction, the question says
so. Two texts bear on that:

- **The brief's L1 rule:** no new warnings, gates or disclaimers for minors.
  This binds this lane.
- **RULES section 1:** "Do not add new restrictions, warnings or gates unless
  the owner directs it."
  - It is the Backbone's build rule, folded word for word into
    OD-2026-11-10-001.
  - That entry says the fold "rules nothing" and decides nothing new: "Where
    the block and another entry of this file, or `AGENT_KERNEL.md`, disagree,
    the fold does not settle it."
  - So it is quoted here as the Backbone's rule, not as a ruling on these items.

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

**Answered since (OD-2026-11-20-001, lane W4R).** W4S's questions Q1.1 to Q1.8
are answered. Each answer is quoted from that entry's section for the card
named:

| Q | Answer (OD-2026-11-20-001) | Effect on the build |
|---|---|---|
| Q1.1 events | OW27-01: *"it should be settings for the gym"*. Settled by OW27-10, *"A: Gym picks the events; each person has one switch (Recommended)"*, whose option text has the organization admin choose "for each user type (staff, parents, athletes 18 or over), which events can send the email" (the entry's recorded reading: "the gym's organization admin chooses, per user type, which events can send the email, on a gym settings page") | A gym setting: events by user type (EM-5, EM-6) |
| Q1.2 who | OW27-02: *"C: B plus athletes 18 or over"*. B's text: "Coach, admin, organization admin and parents". No date of birth counts as a minor (OD-2026-10-04-010) | The switch is offered to those people only. INFERRED: the `staff` and `volunteer` roles, which the card does not name, get none |
| Q1.3 how often | OW27-03: *"B: One email per event"* | No per-person limit |
| Q1.4 opt out | OW27-04: *"it shsould have a switch and we should have a setting page for each user type to adjust those"*. Settled by OW27-10 A (the entry's recorded reading: "each person has one on/off switch on their own settings page") | No link in the email; no route that works without signing in |
| Q1.5 mailbox | OW27-05: *"A: The mailbox that sends sign-in links today (Recommended)"* | No Azure or Microsoft 365 change; the sign-in sender constant |
| Q1.6 send log | OW27-06, delegated (*"Use your best judgment for this question"*). Overwatch picked A, "who was emailed and when, nothing else", and added: "If the build needs the event reference too, the lane asks first" | See Q1.10 |
| Q1.7 subject | OW27-07: *"B: The gym's name and "open the app""* | The subject reads the gym's name |
| Q1.8 sign-in off | OW27-08: *"A: No (Recommended)"* ("Covers staff logins too") | Only accounts whose sign-in is on get the email |

**What exists (OBSERVED):**

- **The mailer.** `apps/web/src/server/pilot/graphMailer.ts:120`,
  `sendPlainTextMail(`, takes any `to`, `subject` and `body`. Its header says
  "NOT A GENERAL MAILER" (`:25`) and "Magic links are the only thing this
  platform sends" (`:28-29`).
- **Its one caller.** The only importer outside tests is
  `apps/web/src/server/pilot/magicLinkStore.ts:7`. It passes its own sender
  constant (`:29`, used at `:99`).
- **How it signs in.** The app's managed identity
  (`managedIdentityToken.ts:133-134`, `IDENTITY_ENDPOINT` and `IDENTITY_HEADER`).
- **The one-mailbox rule.**
  - `graphMailer.ts:15-23` says Mail.Send is tenant-wide, and that an Exchange
    Application Access Policy restricts it to one sender, which the module
    cannot enforce. UNVERIFIED whether that policy is applied in Azure.
  - `assertSenderIsExpected` (`:114-118`) compares a sender with the configured
    one. Its one call (`:125`) passes `config.sender` as both, so in practice it
    refuses only an empty sender. See "Adjacent finding" at the end.
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
  (`apps/web/src/server/pilot/shadowDisclosure.ts:19-20`, `:380`).
- **Family notes.** Parents' replies send nothing: "Nothing is sent (no email,
  no push)" (`apps/web/src/server/pilot/familyMessageReplies.ts:20`).
- **A tick to send on.** The SHADOW job worker starts in
  `apps/web/instrumentation.ts:38`, with sweep and housekeeping hooks
  (`:47`, `:63`). It runs only when `PPBF_SHADOW_WORKER_ENABLED` is set
  (`apps/web/src/server/pilot/shadowJobWorker.ts:28`). The deploy workflows set
  it to `true` (`.github/workflows/deploy-staging.yml:383`,
  `.github/workflows/deploy-production.yml:787`): that is OBSERVED intent. What
  is deployed now is UNVERIFIED; this session read no environment.

**Also on `main` `600b4f7` (OBSERVED, lane W4R), for the answers above:**

- **A settings page for every user type.** `/profile` admits athlete, coach,
  parent, admin, staff and volunteer (`apps/web/app/profile/page.tsx:30`);
  `mapPilotRoleToClubRole` reads `organization_admin` as `admin`
  (`apps/web/components/roleSession.ts:231`, `:245-246`). Its panels are
  portrait, ring name, corner, program and sign-in
  (`apps/web/components/ProfileSettings.tsx:226`, `:263`, `:315`, `:345`,
  `:368`). Its route reads and writes only the caller's own account
  (`apps/web/app/api/pilot/profile/me/route.ts:28-36`).
- **A gym setting to copy.** AS2-a (#1984) and AS2-c (#1986), the tablet idle
  time: a table keyed by organization
  (`infra/azure/pilot_slice_postgres_organization_tablet_idle_policy_migration.sql:35-39`);
  GET for members and PUT for the organization admin
  (`apps/web/app/api/pilot/gym-tablet/idle/route.ts:29`, `:42-46`); a drawer on
  Customize the Gym (`apps/web/app/admin/customize/page.tsx:35-36`, `:370`,
  `:385`).
- **Sign-in off.** `setAccountActiveStatus` sets `pilot.accounts.active_flag`
  and the membership's flag (`apps/web/src/server/pilot/auth.ts:1513`,
  `:1527-1529`, `:1552-1555`), for staff and, since #2013 (`cdb69cf`), athletes.
  An athlete who has not activated also has it off (`auth.ts:1199-1201`).
- **Age and the gym's name.** `isMinor` counts an unknown date of birth as a
  minor (at `600b4f7`: `apps/web/src/server/pilot/wallDisplay.ts:220-223`, 18
  at `:128`; at `a4b420c` it is `apps/web/src/lib/minorAge.ts:51`, 18 at `:12`).
  The name is `pilot.organizations.organization_name`
  (`infra/azure/pilot_slice_postgres.sql:8`).
- **No address for an athlete.** Athlete logins are created with no
  `login_email` (`auth.ts:1199-1201`, `:1251-1253`;
  `apps/web/src/server/pilot/activation.ts:90-93`) and sign in with a PIN
  (`apps/web/src/server/pilot/credentialPolicy.ts:123-124`). A search of
  `infra/azure/*.sql` for email columns found none held for an athlete: the
  account's `login_email` (`pilot_slice_postgres.sql:27`), `pilot.parents.email`
  (`:293`), `pilot.emergency_contacts.email` (`:406`, the contact's own), and
  others for sign-in links, gear vendors, the gym profile and the public
  interest form. So an athlete 18 or over has no address to send to (Q1.11).
- **Where each event is written.** Escalations, SHADOW alerts included:
  `fileEscalation` and `fileIncidentReport`
  (`apps/web/src/server/pilot/escalationLadder.ts:126`, `:281`). Family notes
  and a coach's message to an athlete: one coach-note insert
  (`apps/web/src/server/pilot/intake.ts:956`), `note_type` `parent_message` or
  `athlete_message` (`apps/web/src/server/pilot/athleteCoachMessages.ts:4-7`).
  Parent replies: `familyMessageReplies.ts:81`. Announcements:
  `apps/web/src/server/pilot/announcements.ts:213`.
- **Who reads an escalation.** Coaches, for their own and covered athletes,
  without `athlete_voice` rows; admins and organization admins, every row
  (`apps/web/app/api/pilot/escalations/route.ts:33-56`). The parents' safety
  read leaves escalations out (`apps/web/app/api/pilot/parent/safety/route.ts:39-44`).

**What is missing:**

- **Preferences.** A case-insensitive search of `infra/azure/*.sql` for
  `opt-in`, `opt_in`, `opted_in`, `opted_out`, `notification_pref`,
  `email_pref`, `unsubscribe` and `email_consent` matched one file. Its opt-in
  is cycle tracking
  (`infra/azure/pilot_slice_postgres_athlete_self_report_measures_migration.sql:28`),
  not email.
- **A queue.** A search of `apps/web` for `outbox` found no match.
- **So missing are:** who opted in; the gym's choice of events by user type
  and its drawer; who receives each; a send log; retries; the switch on each
  person's own settings page; an address for an athlete 18 or over (Q1.11).
- **Comments to correct.** The "sends no email" comments in
  `apps/web/app/api/pilot/escalations/route.ts:16-17`, `shadowDisclosure.ts:20`,
  `familyMessageReplies.ts:20` and `graphMailer.ts:25-29`. Migration files are
  left as written.

**PR split (INFERRED; lane W4R, under OD-2026-11-20-001).** This replaces
W4S's split (EM-1 to EM-4, about 1,200 lines). The gym setting and the
athlete's address are new scope. The hourly limit and the opt-out link are
gone.

| PR | What | Est. lines | Basis |
|---|---|---|---|
| EM-1 | Migration: each person's switch (per account; on and off times; audited). With Q1.11 B (OW27-38), the adult athlete's own address on the same row, not used until confirmed. Runner. An own-account read and write route that refuses anyone OW27-02 C leaves out: under-18 athletes, athletes with no date of birth, and other roles. | about 420 (may go over) | matched, AS2-a 414 |
| EM-2 | The switch on `/profile`, shown only to the people OW27-02 C names, and the address field beside it (Q1.11 B, OW27-38). | about 200 | matched, AS2-c 174, plus the field |
| EM-2b | The confirm step (Q1.11 B, OW27-38): the code email, the field for the code, and the address used only after it is entered. INFERRED: the code is kept on EM-1's table, or on a table of its own (one more migration). | about 150 | OW27-38's own figure ("about 150 lines, maybe a migration"); judgement |
| EM-3 | Migration: the send log: who, when, and the event's kind and row id (Q1.10). The sender: a sweep on a server tick, with retry, through `sendPlainTextMail` and the sign-in sender constant (`magicLinkStore.ts:29`). The subject is the gym's name and "open the app"; the body is "open the app". The "sends no email" comments are corrected. | about 380 (may go over) | judgement |
| EM-4a | Staff events: escalations (SHADOW alerts included) and parent replies. One email is queued per staff member who can read the event in the app, whose user type the gym turned it on for, whose switch is on and whose sign-in is on. | about 260 | judgement |
| EM-4b | Family and athlete events: family notes, gym announcements and a coach's message to an athlete, with the same checks. An athlete only when 18 or over (`isMinor`). | about 280 | judgement |
| EM-5 | Migration: the gym's choice, one row per gym, user type and event; every event on the gym's list starts ticked (Q1.12 = OW27-39 A), and each person's own switch still starts off. Runner. Read and write for the organization admin, audited. | about 400 | matched, AS2-a 414 |
| EM-6 | An "Email alerts" drawer on Customize the Gym: the events, by user type. | about 200 | matched, AS2-c 174 |

- **Total:** about 2,290 lines in 8 PRs, sized under the recorded answers
  Q1.11 B (OW27-38) and Q1.12 A (OW27-39). It is the earlier 2,140 in 7 PRs plus
  EM-2b, about 150. The other options are not built: A and C would be about
  2,140, D about 2,000. All judgement.
- **Order:** EM-1 and EM-5, then EM-3, then EM-4a and EM-4b; EM-2 and EM-6
  after their routes; EM-2b after EM-2 and EM-3 (it sends mail).
- **Migrations:** 3, in EM-1, EM-3 and EM-5 (INFERRED: Overwatch may fold them
  into fewer files); 4 if EM-2b keeps its code in a table of its own.
- **Route:** Opus for all eight: sign-in addresses, minors' ages, safety
  alerts, a new organization-admin write.
- **G3:** applies. EM-2 and EM-2b are on `/profile`, shown only to the people
  OW27-02 C names; EM-6 is on Gym Office; EM-4a
  and EM-4b route safety alerts and messages to and about minors.
- **Dependencies:** EM-3 needs a tick that runs: the deploy workflows set
  `PPBF_SHADOW_WORKER_ENABLED`, and Overwatch confirms the deployed value, or
  the sweep runs from a scheduled workflow, as `session-autoclose.yml` does.
  The athlete sign-in switch is on `main` (#2013). Item 2 reuses EM-1 and EM-3.
  Item 4's parent message, once built, joins the gym's list (OW27-25 A,
  OD-2026-11-21-006; Q1.9).
- **File overlap (open PR heads read 2026-11-20):** no open lane PR changes
  `ProfileSettings.tsx`, the Customize page, `escalationLadder.ts`, `intake.ts`,
  `familyMessageReplies.ts`, `announcements.ts`, `graphMailer.ts`,
  `magicLinkStore.ts`, `instrumentation.ts` or `shadowJobWorker.ts`. EM-2 and
  AS-8's AS8-4 (in #2020's body, not built; UNVERIFIED in the repo) both list
  `ProfileSettings.tsx`; EM-6
  and item 9's RN-4 both add a Customize drawer: one after the other in each
  case. EM-1, EM-3 and EM-5 share the registration files; seven open
  dependabot PRs and #2035 (lane DEP) change `apps/web/package.json`.

**Owner questions.** Q1.1 to Q1.8 are answered (the table above); their options,
as asked, are in OD-2026-11-20-001. Overwatch answered Q1.9 and Q1.10 on #2050
(2026-11-20). Q1.11 and Q1.12 are answered by OD-2026-11-21-007 (OW27-38 and
OW27-39). None is open.

- **Q1.9 Which events are on the gym's list? Answered, as a reading
  (INFERRED).** Overwatch on #2050: "Q1.9 = A, as a reading". These are not
  Jason's words. The gym's list offers every event named in the OW27-01 card
  (OD-2026-11-20-001), each only to the user types who read it in the app. The
  organization admin turns each on or off per user type (OW27-10 A):
  - staff: safety escalations (SHADOW safety alerts included) and parent
    replies;
  - parents: new family notes;
  - athletes 18 or over: a coach's message to an athlete;
  - all three: gym announcements (athletes read them:
    `apps/web/app/api/pilot/announcements/get/route.ts:58`);
  - once item 4 is built, staff: a parent's new message (was Q4.3; answered
    yes by OW27-25 A, OD-2026-11-21-006).
- **Q1.10 Does the send log keep the event's reference? Answered: yes.**
  Overwatch on #2050: "Q1.10 = A". This is Overwatch's pick under Jason's
  OW27-06 delegation (*"Use your best judgment for this question"*), not
  Jason's words. The send log keeps who, when, and the event's kind and row
  id; no content, device or IP. The sweep then sends each queued email once, so
  a restart neither resends nor skips.
- **Q1.11 Where does an athlete 18 or over get an email address? Answered:
  B.** OD-2026-11-21-007, OW27-38, Jason's answer: *"B: Typed, then confirmed
  with a code (Recommended)"*. The entry's recorded reading: the adult athlete
  types the address beside their switch; it is used only after they enter a
  code the app emails to it; that one code email may say more than "open the
  app", "a narrow exception to OD-2026-11-19-009's alert wording, by this
  answer". It adds one PR, about 150 lines, "maybe a migration" (EM-2b above).
  The card's options were A (typed, no confirm), B, C (gym office enters it)
  and D (none for now). As the entry notes, the sizing had recommended A and
  Overwatch recommended B. The code email's wording and expiry are not ruled
  here.
- **Q1.12 Which events start turned on for a gym? Answered: A.**
  OD-2026-11-21-007, OW27-39, Jason's answer: *"A: All ticked; each person
  still opts in (Recommended)"*. The entry's reading: every event on the gym's
  list starts ticked; each person's own switch still starts off (OD-2026-11-19-019).
  This replaces the "none ticked" basis the earlier size used. Size: no change
  (a value in EM-5; INFERRED, as the card says "about the same size").

## 2. Web push (later, per Jason)

**Ruling:** OD-2026-11-19-019: web push "is later"; its build is "Not ruled
here". Sized only.

**Answered since (OD-2026-11-21-006; re-sized by lane W4S-REFRESH at `main`
`a4b420c41a9d10c2e991df9b6290914aed41b126`, 2026-11-23):**

- **Q2.1, OW27-17:** Jason chose *"B: No push on a gym tablet"*, against the
  recommendation. The entry records it as the new restriction, "by Jason's
  direction (RULES s1 allows it when the owner directs it): a device marked as a
  gym tablet never offers web push."
- **Q2.2, OW27-18:** *"A: Same settings as the email (Recommended)"*. Push
  follows the gym's event picks, one per event, and goes to no switched-off
  account.
- **Still later.** The card repeats that web push is "later"
  (OD-2026-11-19-019). Nothing here starts it.

**What exists (OBSERVED, searches):**

- **No push code.** A case-sensitive search of the repository for
  `serviceWorker`, `PushManager`, `VAPID`, `web-push`, `webmanifest`, `sw.js`,
  `pushSubscription` and `Notification.requestPermission` found no match
  (apart from this report), re-run at `a4b420c`.
- **No web app manifest.** The one `manifest.json` is
  `design-system/manifest.json`, which is not a web app manifest. At `a4b420c`
  neither `apps/web/app/manifest*` nor a `*.webmanifest` under
  `apps/web/public` exists.
- **No package.** `web-push` is not in `apps/web/package.json` at `a4b420c`.
- **How a gym tablet is told apart (for Q2.1 B).** A device mark the gym admin
  sets on the tablet itself, from Customize the Gym: one key,
  `ppbf.device.gymTablet`, in that browser's `localStorage`
  (`apps/web/src/lib/gymTabletMark.ts:21`; read by `isGymTabletMarked`, `:32`).
  Its own header calls it "a fact about the DEVICE, not the person" (`:8`) and
  "not a security boundary" (`:11`). Its readers are the header,
  `TabletIdleSignOut.tsx`, the sign-in pages and `GymTabletSettings.tsx`.
  INFERRED: a push opt-in can ask the same function, so no new table or
  setting is needed. UNVERIFIED: whether a Home Screen web app on an iPad
  shares that `localStorage` with Safari. The OW27-17 card says iPad push works
  only for a Home Screen app, so the case would arise. If it does not share it,
  the mark would have to be set inside the installed app.

**External fact (UNVERIFIED against the primary page):**

- On iPhone and iPad, web push works only for a site added to the Home Screen,
  from iOS and iPadOS 16.4, and permission may be asked only on a user's tap.
- This comes from a web search summary of the WebKit blog post "Web Push for
  Web Apps on iOS and iPadOS"; the primary page was not opened.
- OD-2026-11-19-009's facts table records the tablet answer "most likley two
  but will eventually need a mix", affecting "Design for iPad and Android
  together". Android behaviour was not checked.

**What is missing:** a web app manifest, a service worker (push only, no
caching), a subscription per account per device, a VAPID key pair (a secret),
a sender, an opt-in on a tap, and removing the subscription at sign-out. Gym
tablets are shared, and they sign out after idle time
(`apps/web/components/TabletIdleSignOut.tsx`).

**PR split (INFERRED):**

| PR | What | Est. lines | Basis |
|---|---|---|---|
| WP-1 | Manifest, service worker, migration for subscriptions, subscribe and unsubscribe routes | about 420 (may go over) | judgement |
| WP-2 | The sender, on EM-3's send log: VAPID signing and payload encryption. It sends for the events the gym turned on (Q2.2 A), once per event, to no switched-off account. | about 250 with the `web-push` package. About 450 without it, which splits into signing and encryption. | judgement |
| WP-3 | The opt-in on a tap, not offered on a device marked as a gym tablet (Q2.1 B: a check of `isGymTabletMarked`, about 30 lines, INFERRED); unsubscribe at sign-out | about 250 | judgement; the earlier 220 plus the tablet check |

- **Total:** about 920 lines in 3 PRs with the package; about 1,120 in 4
  without. The earlier sizing said about 890 and 1,090; the 30 is Q2.1 B's
  check. Q2.2 A adds none: it reuses the gym's event picks (EM-5) and the send
  log (EM-3).
- **Not ruled:** whether a subscription on a personal phone also ends at
  sign-out. OW27-17 A had said so; B says only that a marked tablet never
  offers push. The table keeps the unsubscribe (INFERRED). Whether a person's
  email switch also gates push is not ruled either; sized as the tap alone.
- **Migrations:** 1.
- **Also needs:** one new dependency if `web-push` is used (Overwatch's call),
  and one secret that Overwatch or Jason puts in Azure. No AI enters a secret.
- **Route:** Opus (sign-in and sign-out, shared tablets, minors).
- **G3:** applies.
- **Dependencies:** item 1 (EM-1, EM-3 and EM-5, whose event picks Q2.2 A
  reuses) first. WP-3 touches the tablet sign-out work of lane U1's AS2 PRs
  (merged) and reads `gymTabletMark.ts`.
- **File overlap (open PRs listed 2026-11-23):** WP-1 shares the registration
  files (above). WP-2 adds a package to `apps/web/package.json` and
  `package-lock.json`. The nine dependabot PRs cited earlier are no longer
  open: the open PRs are #2039, #2082, #2124, #2126 and this one. #2124's files
  (`BehaviourSampleWindow.tsx` and its test) touch none of these; #2126 listed
  no files when read; #2039 and #2082 were not read.

**Owner questions.** None open. Q2.1 is answered B (OW27-17) and Q2.2 is
answered A (OW27-18), both OD-2026-11-21-006. Their options, as asked:

- **Q2.1 Push on a shared gym tablet?** A: allowed like any device, the
  subscription ending at sign-out (recommended). **B: no push on a device marked
  as a gym tablet: Jason's answer.**
- **Q2.2 Same events and limits as the email?** **A: yes (recommended): Jason's
  answer.** B: its own list.

## 3. A live "on the floor now" line on every home

**Source:** OD-2026-11-19-009 records the App Scrub answer to "Q12 live floor
line" as "A: on every home; parents see only their own child", affecting
"Navigation map; FUTURE lane with a privacy review". That entry says "Ruling:
none by this entry". The brief says the privacy review comes first.

**Answered since (OD-2026-11-21-006; re-sized by lane W4S-REFRESH at `main`
`a4b420c41a9d10c2e991df9b6290914aed41b126`, 2026-11-23).** Each is Jason's
answer on the card named:

| Q | Answer | Effect |
|---|---|---|
| Q3.1 (OW27-19) | *"C: Either one"*, against the recommendation. Either a "here" mark in a running session or a present mark on today's register shows a person on the floor | The read has two sources. The entry's note: "a register mark has no end time (INFERRED)", so the card's con stands for the build to handle |
| Q3.2 (OW27-20) | *"A: Own child's line only (Recommended)"* | A parent sees a line for each of their own children on the floor, and nothing else |
| Q3.3 (OW27-21) | *"A: Names of everyone on the floor (Recommended)"* | Staff see the names; "adds no new access" |
| Q3.4 (OW27-22) | *"A: A line about themselves only (Recommended)"* | An athlete sees only their own status, no count |
| Q3.5 (OW27-23) | *"B: Overwatch, after two reviewers pass it"*, against the recommendation | Overwatch signs off FN-0 once two adversarial reviewers pass it, as content drafts are handled (OD-2026-11-15-011); Jason does not read it first |

Already ruled and kept: the line "is not an attendance figure" and a
run-presence mark is not attendance (CT-13, `ATTENDANCE_PRECEDENCE.md`), as
OW27-19 states.

**What exists (OBSERVED):**

- **What is live now.** A session run has `run_state`, `started_at` and
  `ended_at`
  (`infra/azure/pilot_slice_postgres_session_run_state_migration.sql:38-40`),
  in progress or not (`:61`), one live run per coach (`:128-130`), and it may
  be tied to a class (`pilot_slice_postgres_session_run_class_migration.sql:105`).
  A run idle 3 hours is closed (`apps/web/src/server/pilot/sessionScriptRuns.ts:153`).
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
  `apps/web/app/api/pilot/wall/route.ts:22`). The count is `distinct athlete_id`
  from `pilot.scheduler_attendance` with `status = 'present'` and `checked_in_at`
  inside the gym day (`wallDisplayDb.ts:105-110`), leaving out a cancelled
  class's marks. A register row has a check-in time and no end time (Q3.1 C's
  con). The wall serves "a shape with no person in it" (`wall/route.ts:20-24`;
  OD-2026-10-07-008).
- **The homes.** The coach home shows only the coach's own run: "Session in
  progress" and "Athletes Present" (`apps/web/components/CoachWorkspace.tsx:1326`,
  `:3295`). A search of `apps/web/components/ParentHub.tsx` and
  `apps/web/components/AthleteWorkspace.tsx` for live-presence words ("on the
  floor", "on floor") found nothing that is a live line, re-run at `a4b420c`.
  Both files, and the coach home, have been rearranged since the earlier read
  (coach home: the Floor tab and tab row, lane 6C7 and the Needs You Now
  strip; athlete home: AS8-1 opens on "How I feel today"; Parent Hub: AS9-1 and
  AS9-3 tabs). Where the line sits on each is not decided here. The parent home loads only linked children whose guardian link has not
  ended (`apps/web/app/api/pilot/athletes/list/route.ts:53`, `:64`).
- **Minors.** Unknown age is a minor: `isMinor` is now in
  `apps/web/src/lib/minorAge.ts:51` (18 at `:12`), and `wallDisplay.ts:5-7`
  re-exports it. A guardian's access ends at 18
  (`apps/web/src/server/pilot/guardianAccess.ts:47`, `:100`, `:141`). Since
  #2012 (`48d9bd46`, merged) the server also refuses a new guardian link to an
  athlete 18 or over (lane GA).

**What is missing:**

- **A gym-wide read.** The live-run read returns only the caller's own run
  (`sessionScriptRuns.ts:337`). Needed is a "who is here now" read, cut by role:
  staff see the gym, a parent sees only their own children, an athlete sees only
  themselves. Under Q3.1 C it unions the two sources: athletes marked on a run
  that is in progress, and athletes with a present register mark today.
- **Not ruled:** the words of the line, and what it says for a person who has
  only a register mark (no end time). Left to FN-0.
- **The line** on four homes.
- **The privacy review.**

**PR split (INFERRED):**

| PR | What | Est. lines | Basis |
|---|---|---|---|
| FN-0 | Privacy review, docs only: what each role sees (Q3.2 to Q3.4), what the public wall already shows, the minors rules, the register mark with no end time (Q3.1 C) | about 120 | judgement |
| FN-1 | One read and route, cut by role (staff names; parent via `guardianAthleteIds`, own children; athlete self), over two sources: live-run marks and today's present register marks (Q3.1 C) | about 310 | judgement; the earlier 250 plus about 60 for the second source |
| FN-2 | The line on the Parent Hub and the athlete home | about 150 | matched, SH-3 90, two homes |
| FN-3 | The line on the coach home and the admin home | about 120 | matched, SH-3 90 |

- **Total:** about 700 lines in 4 PRs (was about 640; Q3.1 C adds about 60 to
  FN-1). Judgement.
- **Migrations:** none (INFERRED: built on the tables above).
- **Route:** Opus for FN-0 to FN-3 (minors' data).
- **G3:** applies.
- **Dependencies:** FN-0 before FN-1, signed off by Overwatch after two
  adversarial reviewers pass it (Q3.5 B). #2012 has merged.
- **File overlap (open PRs listed 2026-11-23: #2039, #2082, #2124, #2126):**
  - FN-1 uses the guardian checks in `guardianAccess.ts`; #2012's change is on
    `main`. It shares the registration files with nothing open that this lane
    read.
  - FN-2 changes `AthleteWorkspace.tsx` and the Parent Hub; FN-3 changes
    `CoachWorkspace.tsx`. The U2, AS-7, AS-8 and AS-9 PRs that changed them
    since the earlier read have merged (git log of those files on `main`).
    #2126 is part B of the kiosk text-size sweep; part A (#2123) edited
    `CoachWorkspace.tsx`. #2126 listed no files when read, so any overlap is
    UNKNOWN. #2124 changes only `BehaviourSampleWindow.tsx` and its test.

**Owner questions.** None open. Q3.1 to Q3.5 are answered (the table above);
their options, as asked, are in OD-2026-11-21-006: Q3.1 A, B or C (C chosen);
Q3.2 A or B (A); Q3.3 A or B (A); Q3.4 A or B (A); Q3.5 A (Jason) or B
(Overwatch after two reviewers; B chosen).

## 4. A parent starts a message to the coach (scrub FAM-09)

**The scrub (stage 1, FAM-09 row):** "A parent cannot start a message to the
coach; they can only reply under one. With "No messages yet." the tab offers
nothing. Barrier types are Home and Transportation only." Its proposal: "Point the empty Messages state to Report a Barrier,
Observations and the coach (a compose box would be FUTURE)." Stage 3 section
3.6 lists the compose box as FUTURE.

**Answered since (OD-2026-11-21-006; lane W4S-REFRESH, 2026-11-23).** Each is
Jason's answer on the card named. Sizes are unchanged: the answers choose the
sized option.

| Q | Answer | Effect |
|---|---|---|
| Q4.1 (OW27-24) | *"A: A message box on the Parent Hub (Recommended)"* | PM-1 to PM-3 as sized: about 970 lines, 3 PRs, 1 migration |
| Q4.2 | Ruled earlier. OD-2026-11-21-006's check note lists it as "ruled, batch 1"; the ruling is OD-2026-10-12-024, *"A: No, each sees only their own (Recommended)"*, about a child's two guardians and their replies to the coach | Each guardian sees only their own thread. INFERRED: that ruling is about replies; applying it to a message a parent starts follows its words, "nothing may show one guardian what the other did" |
| Q4.3 (OW27-25) | *"A: Yes, the gym can pick it (Recommended)"*, narrowed because OW27-10 A already put the event list in the gym's settings | A parent's new message is one more event the gym can turn on for staff (item 1, Q1.9) |
| Q4.4 (OW27-26) | *"A: Decision Loop 'From the family' (Recommended)"* | PM-2 is on `/coach/decision-loop`; no coach-home inbox |
| Q4.5 (OW27-27) | *"A: Child's coach, covering coaches, admins (Recommended)"* | The unread count goes up for the same people a SHADOW safety alert reaches. Other coaches can still read the message |

**What exists (OBSERVED):** a parent can write to the coach outside Messages,
and a coach can write to the family. On the Messages tab, a parent can only
reply.

- **Parent to coach: the Observations note (WO-PH-04).** A guardian writes a
  free-text note for the coach about their own child
  (`apps/web/app/api/pilot/parent/observations/route.ts:17-35`), from
  `apps/web/components/ParentObservations.tsx:98` on the Parent Hub
  (`ParentHub.tsx:1906`).
  - It is a `pilot.coach_observations` row: "No new table, no migration"
    (`route.ts:22-26`).
  - A guardian reads only the notes they wrote, not the other guardian's (the
    split-household line LQ-PH04-1, `route.ts:28-30`).
  - Staff read it under "From the family" on `/coach/decision-loop`, through
    `GET /api/pilot/coach/family-observations` (`route.ts:31-34`).
- **Parent to coach: barrier reports.** A parent can also send one
  (`apps/web/app/api/pilot/parent/barrier-report/route.ts:43`), of two types
  only, home and transportation (`:24`).
- **Coach to family.** A coach posts a note to the family as a
  `coach_observations` row with `note_type 'parent_message'`
  (`apps/web/app/coach/decision-loop/page.tsx:1114`). The parent reads it on
  Messages (`apps/web/app/api/pilot/parent/messages/route.ts:36`, `:38`).
- **Parent replies.** The parent replies under a coach note in
  `pilot.family_message_replies`
  (`infra/azure/pilot_slice_postgres_family_message_replies_migration.sql:62`),
  whose author must be a parent (`:83`).
- **Unread state.** Both sides keep it:
  `pilot_slice_postgres_family_message_reads_migration.sql:59` and
  `pilot_slice_postgres_family_reply_reads_migration.sql:54`. The parent's
  count, per child, is at `apps/web/components/ParentHub.tsx:1577`. The coach's "New" mark
  is per reply, for each staff member, on one athlete's panel
  (`apps/web/components/FamilyNotesPosted.tsx:15-16`, `:42-44`).
- **Who coaches whom.** The assigned coach plus active cover is
  `athleteIdsForCoach` (`apps/web/src/server/pilot/access.ts:508`, `:511-516`).
  The guardian check is `isGuardianLinkedToAthlete`
  (`apps/web/src/server/pilot/guardianAccess.ts:100`).

**What is missing (for Q4.1 A):**

- a message a parent starts on Messages;
- the coach's reply under it;
- the parent seeing that reply;
- an unread count across the roster for staff;
- the storage for all of it. INFERRED: the reply table allows only a parent
  author (`:83`), so a coach reply under a parent's message needs a migration.

**PR split (INFERRED), for Q4.1 A:**

| PR | What | Est. lines | Basis |
|---|---|---|---|
| PM-1 | Migration, store and routes: a parent starts a message about their own child; a coach replies under it; read state | about 420 (may go over) | matched, AS2-a 414 |
| PM-2 | Staff side: the messages on "From the family" with reply (Q4.4 A), and the unread count, raised for the child's coach, any covering coach and admins (Q4.5 A) | about 300 | judgement |
| PM-3 | Parent side: the compose box and the thread on the Messages tab | about 250 | judgement |

- **Total:** about 970 lines in 3 PRs.
  - Q4.1 B: about 880 in 3 PRs (judgement): a staff reply under a parent's
    Observations note, with its migration (about 380); the staff side (about
    300); the parent seeing the reply (about 200).
  - Q4.1 C: none.
- **Migrations:** 1 (none under C).
- **Route:** Opus (minors' data, permissions, guardian access).
- **G3:** applies.
- **Dependencies:** #2012 (merged, `48d9bd46`) was PM-1's. Under item 1's gym
  setting, a parent's new message is one more event the gym can turn on for
  staff (OW27-25 A).
- **File overlap (open PRs listed 2026-11-23: #2039, #2082, #2124, #2126):**
  - PM-1 uses `guardianAccess.ts`; #2012's change is on `main`. It shares the
    registration files with nothing open that this lane read.
  - PM-2 changes `apps/web/app/coach/decision-loop/page.tsx`; #2010 (lane AS-5,
    AS5-1, `393d4305`) is merged and is the last change to it on `main`. None
    of the open PRs read changes it (#2126's files unknown).
  - Q4.4 B's coach-home inbox, which would have changed `CoachWorkspace.tsx`,
    was not chosen.

**Owner questions.** None open. Q4.1 to Q4.5 are answered (the table above).
Options as asked are in OD-2026-11-21-006; Q4.2's are in OD-2026-10-12-024.

## 5. A coach adds drills or blocks to a session plan, and schedules a class from it (scrub CF-11)

**The scrub (stage 1, CF-11 row):** "Planning stops short: a session plan can
only be made from a template and only renamed or retimed (no drills, no blocks
added); a scheduled class cannot carry its plan, they meet only at start." Its
FUTURE list names "a class that carries its session plan ahead of time
(CF-11)".

**Answered since (OD-2026-11-21-006; re-sized by lane W4S-REFRESH at `main`
`a4b420c41a9d10c2e991df9b6290914aed41b126`, 2026-11-23).**

- **Q5.1:** OW27-28 got a question back, not an option: Jason's free text,
  *"which is the most veritile"*. OW27-36 answered it and he chose *"A: All
  three: drill, copied block, text block (Recommended)"*. The entry: "Settles
  W4 Q5.1: library drill, copied block and text block. Item 5 needs re-sizing
  (the add-ons were not sized)." This is that re-size.
- **Q5.2, OW27-29:** *"A: Class keeps the plan; Start runs it (Recommended)"*.
  One migration, and the class screen's Start opens that plan. The card's con:
  "waits on U2's class-screen PRs".

**What exists (OBSERVED):**

- **The screen.** "Session Plans" is the screen name for session scripts
  (`apps/web/app/coach/session-scripts/page.tsx:506`).
- **Making a plan.** A plan is made only from a workout template
  (`apps/web/app/api/pilot/session-scripts/route.ts:125-132`;
  `apps/web/app/coach/workout-templates/MakeSessionScript.tsx:78-82`), or by an
  admin content import.
- **Editing a plan.** The edit route also retires a plan and marks it reviewed
  (`route.ts:174`). Its edit changes the plan's name and each block's title and
  minutes only.
  - The server says "blocks are never added, removed or reordered here"
    (`apps/web/src/server/pilot/sessionScriptAuthoring.ts:409-411`) and refuses
    an unknown block (`:436-437`).
  - A plan that has been run gets a new version (`:31-38`, `:500-551`).
- **Blocks.** A block can name a library drill
  (`infra/azure/pilot_slice_postgres_session_scripts_migration.sql:87`).
  - Its order is unique within the plan (`:96`).
  - It must hold some text (`:99-100`). The template path meets that by writing
    the step's facts into `what_to_explain` (`sessionScriptAuthoring.ts:140-142`).
- **Scheduling.** A coach schedules their own classes
  (`apps/web/app/api/pilot/scheduler/route.ts:804-806`, `:831-832`) from
  `/schedule` (`apps/web/app/schedule/page.tsx:1112`). A class row has no plan
  column (`infra/azure/pilot_slice_postgres_scheduler_tables_migration.sql:11-26`).
- **Class and plan.** They meet only when a session starts
  (`apps/web/src/client/startClassSession.ts:45-52`). The class screen starts
  with no plan (`apps/web/app/coach/class/page.tsx:159`, `scriptId: null`); its comment at `:22`
  says "Plans are still started from Session Plans".

**What is missing:**

- **The block edits.** Adding a block (a drill from the library, a copy of a
  block from another plan, or a text block), and removing and reordering
  blocks.
  - INFERRED: these need no migration. Order can be renumbered in one
    transaction.
  - A new drill block can carry "From the drill" facts in `what_to_explain`,
    the way template steps do.
  - **A text block** uses the kinds that already exist: `reset_minute`,
    `teaching_minute` and `transition` among ten
    (`infra/azure/pilot_slice_postgres_session_scripts_migration.sql:84-86`).
    The table's own check says a block must hold some text unless it is a
    `transition`, `arrival` or `close` (`:99-100`), so a text block with no text
    is allowed only for those three kinds. A block with no drill has
    `drill_id` null (`:87`).
  - **A copied block** carries its source's `contact_level`
    (`:89`, default `'none'`). INFERRED: it can come from any plan the coach can
    read. Every coach and organization admin reads any plan's stored rows
    (`apps/web/app/api/pilot/session-scripts/route.ts:20-48`, the coaching-content
    read policy), so a copy gives no read the coach lacks.
- **The class link.** A class that carries a plan, which needs a migration, and
  the class screen starting that plan.

**PR split (INFERRED), re-sized under Q5.1 A and Q5.2 A.** The earlier
SP-1 and SP-2 (drill blocks only, 350 and 300) are kept as SP-1a and SP-2a. The
copied and text blocks (Q5.1) are two new PRs, SP-1b and SP-2b, each its own
rate by judgement: the server side adds two accepted shapes to the same route,
the editor adds one form and one picker.

| PR | What | Est. lines | Basis |
|---|---|---|---|
| SP-1a | Server and edit route: add a drill block, remove a block, move a block; the versioning as today | about 350 | judgement (`sessionScriptAuthoring.ts` is 724 lines) |
| SP-1b | Server: add a text block (kind, title, minutes and text; the content rule above) and add a block copied from another plan (same gym; its fields and `contact_level` carried; a new block id; the plan's contact label recomputed) | about 190 | judgement |
| SP-2a | The editor: a drill picker, remove, move up and down | about 300 | judgement (`apps/web/app/coach/session-scripts/SessionScriptEditor.tsx` is 259 lines) |
| SP-2b | The editor: a text-block form (kind, title, minutes, text) and a "copy a block from another plan" picker | about 200 | judgement |
| SP-3 | Migration: a plan link on a scheduled class; the scheduler accepts it | about 250 | judgement |
| SP-4 | "Schedule a class" from Session Plans; the class screen starts the class's plan | about 250 | judgement |

- **Total:** about 1,540 lines in 6 PRs (was about 1,150 in 4: drill blocks,
  Q5.1 D). The two new PRs add about 390. Judgement.
- **Migrations:** 1 (SP-3), Q5.2 being A.
- **Route:**
  - **Opus for SP-1a and SP-1b**, because a sparring-contact drill could be
    added to a plan, and a copied block carries its source's contact level.
    - The plan's contact label is computed from its steps (`contactStructure`,
      `sessionScriptAuthoring.ts:113-121`) and shown on Session Plans
      (`page.tsx:607`).
    - Block minutes are checked (`pilot_ssb_window`, migration `:97`).
    - SP-1a and SP-1b must keep both right when blocks are added, copied,
      removed or moved. A text block has `contact_level` `none` (the column's
      default); INFERRED.
    - UNVERIFIED whether any gate reads a block's contact level when a session
      runs.
  - **Sonnet for SP-2a and SP-2b.** The pickers and the form send only what
    SP-1a's and SP-1b's route accepts, so any contact rule lives and is reviewed
    there. If SP-1a or SP-1b finds a contact gate, SP-2a and SP-2b move to Opus.
  - **Opus for SP-3 and SP-4** (the scheduler's role gate).
- **G3:** INFERRED not to apply (no sign-in, minors' data or safety screen),
  unless SP-1a or SP-1b finds a contact gate.
- **Dependencies:** OD-2026-10-21-002 D4 ("A: Tie them") already ties a session
  to its class at start. SP-4 changes the class screen
  (`apps/web/app/coach/class/page.tsx`, 288 lines at `a4b420c`). Lane U2's PRs
  to it that are on `main`: 6a (#2001), 6b-1 (#2005, `48bc2ae1`), 6b-2 (#2023,
  `244c13d2`) and 6d (#2026, `cebf54dd`). The file's last change on `main` is
  `244c13d2`. The U2 row of `docs/current/ACTIVE_WORK.md` (at `a4b420c`) still
  says "6c, AS-4 (4a to 4e) and AS-7 not started", which does not match `main`,
  where U2-4a, 4b and 4c (#2029, #2068, #2073) and the coach home PRs of lane 6C7
  are merged (git log of `main`). Whether a 6c PR will change the class screen
  is UNKNOWN here.
- **File overlap (open PRs listed 2026-11-23: #2039, #2082, #2124, #2126):** none
  of those read changes the class screen, the scheduler, or the session-script
  files (#2124 changes only `BehaviourSampleWindow.tsx` and its test; #2126's
  files unknown; #2039 and #2082 not read). SP-3 shares the registration files
  with whatever migration lands first; no open PR read changes them.

**Owner questions.** None open. Q5.1 is answered A (OW27-36) and Q5.2 is
answered A (OW27-29). Their options, as asked, are in OD-2026-11-21-006: Q5.1
(OW27-28, then OW27-36): A all three, B drill plus text block, C drill plus
copied block, D drill only; Q5.2: A the class keeps the plan, B the plan only
fills the form.

## 6. A "who has stopped coming" page (scrub CF-14)

**The scrub (stage 1, CF-14 row):** "No page answers "who has stopped coming";
the Passbook Gaps door keywords say "stopped coming" while the page says it is
not that check." Its FUTURE list names "a "who has stopped coming" list
(CF-14)".

**Answered since (OD-2026-11-21-006; re-sized by lane W4S-REFRESH at `main`
`a4b420c41a9d10c2e991df9b6290914aed41b126`, 2026-11-23).** Each is Jason's
answer on the card named:

| Q | Answer | Effect |
|---|---|---|
| Q6.1 (OW27-30) | *"A: Gym setting, first value 2 weeks (Recommended)"*. "New option (not in W4_SIZING): a gym setting the organization admin can change; first value 2 weeks. Item 6 needs the setting added to its size." | A gym setting, like the tablet idle time (SC-0a, SC-0b below) |
| Q6.2 (OW27-31) | *"A: Active members seen at least once (Recommended)"* | Active membership and present at least once before |
| Q6.3 (OW27-32) | *"A: Yes, on this page only (Recommended)"*. Jason's ruling for this page only: open-gym here marks count as coming on this page; "no attendance figure, report, board or grant figure changes (OD-2026-09-28-008 and CT-13 stand)" | SC-1 reads session marks as well as register marks. This departs from Overwatch's 2026-10-13 note; he ruled it |
| Q6.4 (OW27-33) | *"B: A, plus mark 'reached out'"*, against the recommendation. The entry: "Adds the 'reached out' mark: a migration and a third PR, about 200 lines more (W4_SIZING)" | The "reached out" mark (SC-3a, SC-3b below) |

**What exists (OBSERVED):**

- **Passbook Gaps is not this check.** The page says it is "not a check on who
  has stopped coming" (`apps/web/app/coach/passbook-gaps/page.tsx:186`; also
  `:24`, `:157`).
- **The guard.** A test keeps any door from claiming the words "until a page
  answers it" (`apps/web/components/buildingMap.test.ts:499-506`). SC2-1
  (#1981) took the words off the door
  (`apps/web/components/buildingMap.ts:500-502`).
- **Per-athlete data.** Last present date and days since, over 28 days, from
  `getAttendanceLast28Days`
  (`apps/web/src/server/pilot/attendancePrecedence.ts:241`, `:262`, `:286`).
- **Membership status.** It is active, lapsed or ended, set by hand
  (`infra/azure/pilot_slice_postgres_program_memberships_migration.sql:28`).
  A search of `apps/web` outside tests for `lapsed`, `stopped coming`,
  `days_since` and `last_seen`, re-run at `a4b420c`, found no query that marks a
  lapse by itself (the matches are other things: a TV's last-seen time,
  clearance wording and elapsed clocks).
- **Open-gym marks (INFERRED from `sessionRunAthletes.ts:171`).** A session not
  tied to a class writes no register mark, so an athlete seen only at untied
  open gym has no register record. Q6.3 A makes SC-1 read the session marks
  (`pilot.session_run_athletes`) for that reason.
- **A gym setting to copy.** Still the tablet idle time (item 1): a table keyed
  by organization, GET for members and PUT for the organization admin, a drawer
  on Customize the Gym. At `a4b420c` a search of `infra/azure` finds no shared
  gym-settings table: the two policy tables are the tablet idle time and a
  video policy (`pilot_slice_postgres_organization_tablet_idle_policy_migration.sql`,
  `pilot_slice_postgres_organization_video_policy_migration.sql`).
- **Where a new door goes now.** U2's AS-4 is on `main`: U2-4a (`b555d5b8`),
  4b (`5b28948a`) and 4c (`3580389a`). Search's "All pages" places every door
  but Home in exactly one of 17 Room Map rooms, and a test enforces it
  (`apps/web/components/roomPlaces.test.ts:30`; the lists are in
  `apps/web/components/roomPlaces.ts`). Job bars name items by `href`
  (`apps/web/components/jobBars.ts`). So SC-2 also edits `roomPlaces.ts`, and
  maybe `jobBars.ts`. Which room and which bar is Overwatch's call, as AS-4's QT
  was.

**What is missing:** a gym-wide list of athletes with no present mark for the
gym's chosen number of days, looking further back than 28 days if the gym sets
more than 28 (see "Not ruled"). It also needs its page, a door, and the guard
test turned to require that door; the gym setting; and the "reached out" mark.

**Not ruled (left to the build, listed so they are not lost):** the setting's
allowed range (INFERRED: a gym could set more than 28 days, which
`getAttendanceLast28Days` cannot read); which records count as "present at
least once before" in Q6.2 A (INFERRED: either source, as Q6.3 A); and what
"reached out" holds. Sized as who and when, no free text (INFERRED, so that no
more is written about a minor than the card asks).

**PR split (INFERRED), re-sized under Q6.1 A to Q6.4 B:**

| PR | What | Est. lines | Basis |
|---|---|---|---|
| SC-0a | Migration: the gym's "no present mark for" number, one row per gym, first value 2 weeks. Runner. A read for the gym's members and a write for the organization admin, audited | about 410 (may go over) | matched, AS2-a 414 |
| SC-0b | A "Stopped coming" drawer on Customize the Gym: the number, its default, "Use the default" | about 180 | matched, AS2-c 174 |
| SC-1 | Query and route (coach, admin): active members, present at least once, with no present mark for the gym's number of days; reads register marks and session marks (Q6.3 A) | about 320 | judgement; the earlier 300 plus the setting read |
| SC-2 | Page, door, guard test turned; the door's Room Map room (`roomPlaces.ts`) and, if needed, its job bar | about 280 | judgement; the earlier 250 plus the room and bar entries |
| SC-3a | Migration: the "reached out" mark (who and when, per athlete; audited). Runner. A read and a write route for staff | about 410 (may go over) | matched, AS2-a 414 |
| SC-3b | The mark on the page: a button, and "reached out by (who) on (date)" on the row | about 120 | judgement |

- **Total:** about 1,720 lines in 6 PRs (was about 550 in 2). Judgement and
  matched as marked.
  - The cards put the two adds lower: OW27-30 called the setting a "small extra
    build (INFERRED, not sized)" and OW27-33 gave "about 200 lines more" for the
    mark. By this file's own method (a table, its runner and two routes are
    AS2-a's shape, 414 lines) each is about 410 plus its screen. If the cards'
    figures hold, the total is about 870 (550, a setting of about 120, a mark of
    about 200). Overwatch can fold the setting and the mark into one migration
    each with other items' settings (EM-5, RN-1) to cut some of this; not
    decided here.
- **Migrations:** 2 (SC-0a and SC-3a).
- **Route:** Opus (minors' data), all six. SC-0b and SC-2 are the lightest; that
  is not a ruling.
- **G3:** applies (SC-1 to SC-3b show minors' attendance; SC-0b is on Gym
  Office).
- **Dependencies:** the door is in `buildingMap.ts` and `roomPlaces.ts`, lane
  U2's files; U2-4a to 4c are merged. SC-0b and EM-6 and RN-4 each add a
  Customize drawer: one after the other.
- **File overlap (open PRs listed 2026-11-23: #2039, #2082, #2124, #2126):** none
  of those read changes `buildingMap.ts`, `roomPlaces.ts`, `jobBars.ts` or the
  Customize page (#2124 changes only `BehaviourSampleWindow.tsx` and its test;
  #2126's files unknown; #2039 and #2082 not read). The earlier overlaps, #2009
  (lane BT, `buildingMapCoverage.test.ts`) and #2010 (lane AS-5), have merged.
  SC-0a and SC-3a share the registration files with the other migration PRs.

**Owner questions.** None open. Q6.1 to Q6.4 are answered (the table above); the
options, as asked, are in OD-2026-11-21-006: Q6.1 A gym setting first value 2
weeks, B fixed 3 weeks, C fixed 2 weeks, D fixed 30 days; Q6.2 A active members
seen at least once, B everyone on the roster; Q6.3 A yes on this page only, B
register marks only; Q6.4 A read the list and open the athlete, B A plus mark
"reached out".

## 7. An offline save queue: failed saves are kept and retried

**Rulings and records (OBSERVED):**

- OD-2026-09-28-008: "offline storage stays parked".
- The PARKED row `BACKLOG-offline-write-queue` in `docs/current/ACTIVE_WORK.md`
  (`:290` on `main` `a4b420c`; it was `:270` at `c27c581`): re-open when "A concrete identity-scoped
  encrypted/offline storage design is selected".
- `docs/current/ACTIVE_WORK.md:55`: "online-only writes until the
  offline-storage decision is made".
- OD-2026-11-19-009 records the "Failed saves" answer "A: small honesty fixes
  now, offline queue later". That entry says "Ruling: none by this entry".

**State: not blocked. Q7.1 and Q7.2 are answered** (OD-2026-11-21-006; re-sized
by lane W4S-REFRESH at `main` `a4b420c41a9d10c2e991df9b6290914aed41b126`,
2026-11-23):

- **Q7.1, OW27-34:** *"A: In the open page; dropped at sign-out
  (Recommended)"*. The entry: "Unblocks W4 item 7 (with OW27-35). Offline
  storage on the device stays parked (OD-2026-09-28-008)." So nothing is stored
  on the device after the page closes, and the PARKED row's re-open condition
  ("a concrete identity-scoped encrypted/offline storage design is selected")
  is not triggered. B (encrypted on the device) and C (B for staff only) were
  not chosen.
- **Q7.2, OW27-35:** *"A: Live floor saves first (Recommended)"*: "'Here' taps,
  run actions, staff notes, intervention log." Other saves keep today's
  behaviour, with the honesty fixes.

The earlier sizing's wait is gone: the size below is the sized option, Q7.1 A
and Q7.2 A, re-read at `a4b420c` and unchanged at about 1,120 lines in 4 PRs.

**What exists (OBSERVED):**

- **No device storage.** A search of `apps/web` outside tests for
  `serviceWorker`, `indexedDB`, `navigator.onLine`, `Idempotency-Key`,
  `workbox`, `dexie` and `localforage` found no match.
- **Browser storage. Neither store holds a save payload.**
  - `localStorage` holds UI preferences, the gym-tablet device mark
    (`apps/web/src/lib/gymTabletMark.ts`) and the chosen child
    (`apps/web/src/lib/chosenChild.ts:31`).
  - It also holds a notice-catalog counter
    (`apps/web/components/gymNotices.ts:173`) and per-athlete "ceremony shown"
    records keyed by athlete id (`apps/web/components/milestoneCeremony.ts:55`,
    `apps/web/components/achievementCeremony.ts:52`).
  - `sessionStorage` holds a pending request key
    (`apps/web/app/schedule/page.tsx:260`,
    `apps/web/app/coach/test-day/page.tsx:125-126`) and the chosen child.
- **Writes that are safe to repeat:**
  - class create, by request key (`apps/web/app/api/pilot/scheduler/route.ts:163-176`);
  - the intervention log, by request key
    (`apps/web/app/api/pilot/coach/intervention-executions/route.ts:119`);
  - the live "here" tap, by its natural key
    (`apps/web/src/server/pilot/sessionRunAthletes.ts:120`).
- **Writes with no request key:** staff notes
  (`apps/web/components/SessionStaffNotesPanel.tsx:199`) and the run actions
  (`apps/web/app/api/pilot/session-scripts/runs/[runId]/route.ts:38`). Both
  re-read at `a4b420c`: a search of those two files and
  `SessionScriptLiveDelivery.tsx` for `request_key` and `requestKey` matches only
  the intervention log's send (`SessionScriptLiveDelivery.tsx:460`, `:492`).
- **A live write that is not on Q7.2's list.** Since the earlier read the coach
  window screen and its routes are on `main` (PATTERN-1e-3 `0a9b297`, the screen
  `fce92a0`). A tap is a staff write during a live run
  (`apps/web/components/BehaviourSampleWindow.tsx`, PATCH of a window), and on an
  answer it cannot read the screen re-reads the window rather than resend. "Skip
  this chance" (OD-2026-11-23-001, ruling 1; open as #2124 at its head
  `1cf267c2`) saves nothing and is kept on that screen only. OW27-35 A names four
  saves and not this one. Whether it joins OQ-3 is NOT RULED; sized without it
  (INFERRED: about 60 lines if included).
- **Failure messages.** Each failure shows a message and none retries, e.g.
  `apps/web/components/SessionRunPresence.tsx:297` and
  `apps/web/components/SessionScriptLiveDelivery.tsx:126-127`.
- **A retry pattern to copy.** The tablet sign-out retries every 15 seconds and
  on `online` (`apps/web/components/TabletIdleSignOut.tsx:69`, `:145`, `:148`).
- **Sign-out does not reload the page.** The header's sign-out is a soft
  navigation except on camera pages
  (`apps/web/components/GlobalRoleHeader.tsx:196-202`). So page memory, and an
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
- **Not chosen, for reference:** Q7.1 B would add about 500 lines in 2 more PRs
  (an encrypted store with its wipe at sign-out; a privacy review), about 1,620
  in 6 PRs (judgement).
- **Route:** Opus (data integrity, minors' data on shared tablets, sign-out).
- **G3:** applies.
- **Dependencies:** OQ-3 touches the live console
  (`SessionScriptLiveDelivery.tsx`). #2005 (lane U2, `48bc2ae1`) has merged;
  it is on `main`.
- **File overlap (open PRs listed 2026-11-23: #2039, #2082, #2124, #2126):** none
  of those read changes the live console, the staff notes panel, the run routes or
  `SessionRunPresence.tsx` (#2124 changes only `BehaviourSampleWindow.tsx` and its
  test; #2126's files unknown; #2039 and #2082 not read).

**Owner questions.** None open. Q7.1 is answered A (OW27-34) and Q7.2 is
answered A (OW27-35). Options as asked, from OD-2026-11-21-006:

- **Q7.1 Where is a failed save kept?** **A: in the open page; dropped at
  sign-out (recommended): Jason's answer.** B: on the device, encrypted, wiped at
  sign-out. C: B for staff saves only (a new restriction falling on minors).
  - INFERRED, from the earlier sizing: nothing is left on the device after the
    page closes, so the data-at-rest problem does not arise.
  - The attribution problem rests on each save being tied to the account that
    made it and dropped at sign-out, which OQ-2 must prove with a test.
- **Q7.2 Which saves?** **A: the live floor first (recommended): Jason's
  answer.** B: every save in the app.

## 8. OW26-05: the typed steps in the 11 mixed templates

**Ruling:** OD-2026-11-19-030, Jason: *"B: Turn typed lines into library
drills"* (against the recommendation).

- **Effect, as recorded** (INFERRED from the card): each typed step becomes a
  library drill in PPBF words, AI-draft labelled like the home week, after the
  pilot.
- **The card's own cost line:** "New content to write and check, not sized".

**The list (OBSERVED):** `TYPED_IN_MIXED` in
`apps/web/src/server/pilot/committedTemplateIssueSweep.test.ts:315`, on `main`
`a4b420c` (#2008 merged as `9ef38ecb`; the line is the same as on its head),
lists 11 templates. The step numbers match the committed
`apps/web/seed-data/workout-templates/seed_workout_template_items.csv`, where a
typed step is a row with no `drill_id` (checked by script, no mismatch).

**The count (measured by script on the committed CSV, and recounted twice by
the citation reviewers):**

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

**Rates:**

- **Per drill (measured on HW #1980).** 6 drafted drills took 41 drill-CSV
  lines (library row, three scale levels, own stop rules, cue), about 7 each.
  Each drill's section in `docs/content-review/home-week/HOME_WEEK_REVIEW.md`
  is 13 or 14 lines. That gives 20 per drill.
- **Per template (measured on HW).** A day's section is about 18 lines (lines
  72-182 for six days).
- **Per PR (measured on HW).** 71 lines before the first day and 13 for the
  reviews: 84.
- **Per converted step (measured by script, INFERRED method).** A converted
  step gets its `drill_id`, and its `free_text_drill` is cleared. That follows
  the import's own rule for a linked step, "leave free_text_drill blank"
  (`apps/web/src/server/pilot/contentImport/aiPrompt.ts:134-145`); the
  database allows both (`infra/azure/pilot_slice_postgres_workout_template_details_migration.sql:95`).
  - Simulating that rewrite on the committed CSV and diffing each row gives 247
    changed lines for the 85 steps.
  - 27 of the rows span several CSV lines: TL-3a has 8, TL-3b 7 and TL-4 12.
  - The script re-writes rows with Python's CSV writer. Passing the unchanged
    file through the same writer gives it back byte for byte (checked by the
    citation reviewer), so the count is not a quoting effect.

**PR split** (20 per new drill, the measured step lines, 18 per template, 84
per PR):

| PR | Templates | Steps rewritten | New drills (if all unique lines) | Est. lines |
|---|---|---|---|---|
| TL-1a | the three 48-Session Youth Coaching Manuals: the drills | 0 | 16 | about 400 (at the limit) |
| TL-1b | the same three: the step rewrites and template sections | 30 | 0 | about 200 |
| TL-2 | Scripted 60-Minute Class (test run 4-5) | 10 | 10 | about 320 |
| TL-3a | Friday Sparring Coach Sheet; Wednesday Coach Sheet Defense Day | 11 | 11 | about 400 (at the limit; 1 sparring line) |
| TL-3b | Wednesday – Gold Standard Coach Script | 7 | 7 | about 270 (2 sparring lines) |
| TL-4 | Iso + Plyo 60-Minute Boxing Session | 13 | 13 | about 410 (may go over) |
| TL-5a | Conditioning session A — SIT; Phase 1 boxing skill session | 10 | 10 | about 340 |
| TL-5b | Phase 2 archetype vs. pressure fighter | 4 | 4 | about 190 (1 sparring line) |

- **Total:** about 2,530 lines in 8 PRs, if every unique line becomes a new
  drill. Fewer if Q8.1 is A.
- **TL-1a** loads the 16 drills only. The three manuals stay on
  `TYPED_IN_MIXED` until TL-1b rewrites their steps.
- **Migrations:** none. HW loaded the same way, by content import.
- **Route:** Opus for all eight. Every new drill carries its own stop rules
  (safety text), TL-1 is the youth manual, and four lines carry sparring
  contact.
- **G3:** no screen changes; INFERRED not to apply. The load's dry run on
  staging is the check, as for HW.
- **Dependencies:** #2008 has merged. It added `TYPED_IN_MIXED`, and each PR
  that rewrites steps removes its templates' entries.
- **Load:** after each merge, staging then production, by Overwatch.
- **File overlap:** #2008 has merged, so it no longer overlaps. The files the
  TL PRs will edit are `seed_drill_library.csv` and `seed_drill_cues.csv`, and
  these test files:
  `apps/web/src/server/pilot/committedTemplateIssueSweep.test.ts`,
  `apps/web/src/server/pilot/ft1ContentPackage.pg.test.ts`,
  `apps/web/scripts/backbone-export-ft1-track.test.ts`. No open PR listed on
  2026-11-23 is known to change them (#2126's files unknown; #2039 and #2082
  not read). The template seed CSVs (`apps/web/seed-data/workout-templates/`) and `aiPrompt.ts`
  show no change between `7a1736d9` and `a4b420c` (`git diff --stat`), so the
  counts above stand; they were not re-run.

**Owner questions:**

- **Q8.1 A typed line that a library drill already covers?**
  - **A (recommended):** link the existing drill, and draft new drills only for
    the rest. That leaves fewer drafts to check. This narrows OW26-05 B's
    option text ("Each typed step becomes a drill in PPBF words, AI-draft
    labelled"), because a linked drill is neither new nor AI-drafted.
  - **B:** a new drill for every line, as the card's option text says.
  - **Answered:** OD-2026-11-20-001 (OW27-09): *"B: A new drill for every
    line"*.
- **Q8.2 A line that is a heading or an instruction, not an exercise?**
  - **A (recommended):** it still becomes a drill, as the card says (e.g. a
    12-minute warm-up drill). This matches OW26-05 B.
  - **B:** fold it into the coach note of the next drill step, and remove the
    step. This departs from OW26-05 B's "Each typed step becomes a drill" and
    changes those templates' step lists.
  - **Answered.** Overwatch on #2050 (2026-11-20): ruled "by plain principle
    from OD-2026-11-19-030" (*"B: Turn typed lines into library drills"*): "a
    heading is a typed line". This is Overwatch's application of that ruling,
    not new words from Jason. INFERRED: that is option A, so the line becomes a
    drill.

## 9. Room renaming by the gym (A-124; lane W4R)

**Rulings (OD-2026-11-20-001):** OW27-11, Jason: *"these room should be able to
be changed in the app by the organization to relat e to it"*; the entry's
reading (INFERRED, Overwatch's): "an organization admin can rename the app's
rooms from Gym Office". OW27-15, Jason: *"A: New names as defaults now; renaming
later (Recommended)"*, whose option text reads "AS-8 uses "Your Profile", "Who
you train with" and "Your entry" as the starting names; a separate, sized lane
later lets the organization rename rooms". AS-8 built the starting names as AS8-4 (#2100, `cc29c963`, merged 2026-11-22;
read at `a4b420c`, below). This sizes only the later renaming.

**Answered since (OD-2026-11-21-007; read by lane W4S-REFRESH at `main`
`a4b420c41a9d10c2e991df9b6290914aed41b126`, 2026-11-23).** Each is Jason's
answer on the card named:

- **Q9.1, OW27-40:** *"A: Those names plus the Room Map rooms (Recommended)"*.
  The entry: "Matches W4_SIZING Q9.1 A (sized: about 1,090 lines, 4 PRs). The
  sizing's option C was not offered (it would undo OW27-11); this card's C is a
  different option." The card's own option C was "Only the names already
  answered".
- **Q9.2, OW27-41:** *"A: No; Search uses the shown name (Recommended)"*.
- **Size:** unchanged, about 1,090 lines in 4 PRs. #2029 (U2-4a, `b555d5b8`),
  #2068 (4b, `5b28948a`) and #2073 (4c, `3580389a`) have merged, so RN-2 no
  longer waits for them, and RN-3 no longer waits for AS8-4.

**What "room" names in code** (OBSERVED, re-read at `main` `a4b420c`; the
earlier read was at `600b4f7`):

- **Seven rooms.** `Room` (`apps/web/components/buildingMap.ts:61`), named in
  `ROOM_LABEL` (`:772`, e.g. "Front Office", "Gym Floor").
- **Doors.** 150 in `BUILDING` (`:165` on; the lines with `{ href:`, counted by
  `grep -c`; it was 144 at `600b4f7`). A door's key is its `href`; its `label`
  is the page's name in the menus (`Door`, `:84-125`).
- **The `/profile` door and its page differ.** The door's label is still "Your
  Corner" (`buildingMap.ts:382`); the page's title is now "Your Profile"
  (`apps/web/app/profile/page.tsx:25`, `:32`, set by AS8-4). The title test does
  not see it: `/profile` is in its `TITLE_NOT_LITERAL` list
  (`apps/web/components/doorLabelsMatchTitles.test.ts:35`). That is a gap against
  OD-2026-10-17-001 item 1 ("Each menu label matches its page title."), found
  here and not fixed. UNVERIFIED which menus show the door's label.
- **The 17 Room Map rooms.** On `main` since #2029 (U2-4a): `ROOM_PLACE_LABEL`
  (`apps/web/components/roomPlaces.ts:62-80`), and `searchGroups` (`:201`)
  groups Search's "All pages" by them. They are a field apart from a door's
  `room` (that file's header).
- **Job bars.** On `main`: `apps/web/components/jobBars.ts` has sections with
  their own names (`JobSection.label`, `:51`) and items by `href` only
  (`JobItem`, `:43-45`); U2-4b draws them in `apps/web/components/JobBar.tsx`.
- **Names inside pages.** "My Corner" is a heading, not a door
  (`apps/web/components/AthleteCorner.tsx:127`). The mentors heading, now "Who
  you train with" for an athlete and "Who they train with" for a family
  (`apps/web/components/AthleteAchievements.tsx:467`), and the Sparring Log
  eyebrow, "Your entry" for an athlete and "Coach Entry" for staff
  (`apps/web/app/athlete/dashboard/sparring/page.tsx:771`), are typed into their
  files (AS8-4).

**Where the names show (OBSERVED):**

- **Corridor, and Search with All pages.** OD-2026-11-19-008's replacement of
  Jump has landed (U2-4c, `3580389a`). `Corridor.tsx` now prints the Search
  group's name (`searchGroupLabel`, `Corridor.tsx:38`, `:51`), and
  `CardCatalog.tsx` is Search, grouping by `ROOM_PLACE_LABEL` (`:98`, `:578`);
  both are mounted by `GlobalRoleHeader.tsx:245`, `:267`. The seven rooms'
  `ROOM_LABEL` no longer shows there; it still shows in the door register
  (`apps/web/app/admin/door-register/page.tsx:264`, `:298`) and in
  `apps/web/scripts/page-shots.ts:66`, `:531`. The job bar shows its own
  section names (`JobBar.tsx`). "ClusterNav" names clusters in its own table
  (`apps/web/components/ClusterNav.tsx:62-69`).
- **Search.** `searchDoors` scores the label, then label, keywords and href
  together (`buildingMap.ts:842-863`). The door register
  (`apps/web/app/admin/door-register/page.tsx`) prints room and door names too.
- **Page titles.** Each page types its own; none comes from `buildingMap.ts`
  (e.g. `apps/web/app/schedule/page.tsx:990-992`). `/profile`'s is the shell's
  `roleLabel` (`apps/web/app/profile/page.tsx:25`, printed at
  `apps/web/components/RoleStandaloneView.tsx:249`).
- **The rule that ties them.** `apps/web/components/doorLabelsMatchTitles.test.ts`
  checks each door label against its page's literal `<h1>`. Doors whose title
  is not a literal are listed in `TITLE_NOT_LITERAL` (`:30`), `/profile`
  among them (`:35`). The rule is OD-2026-10-17-001 item 1
  ("Each menu label matches its page title."), which OD-2026-11-19-008 keeps.

**Gym settings today (OBSERVED):** a search of `infra/azure/*.sql` for
`door_label`, `room_label`, `room_name`, `label_override`, `nav_label`,
`display_label`, `organization_settings`, `org_settings` and `gym_profile` found
no match. `pilot.organization_profiles` has no column for names
(`infra/azure/pilot_slice_postgres_organization_profiles_migration.sql:42-87`),
and the root layout reads only the operating gym's profile, not the signed-in
person's (`apps/web/src/server/pilot/organizationProfileStore.ts:40`,
`:252-254`; `apps/web/app/layout.tsx:87`). So a gym's names cannot ride that
read (INFERRED). The pattern to copy is the tablet idle time (item 1).

**What is missing:** a name per gym for each name that can change, with the
default in code; a read for the gym's members and a write for the organization
admin; every place that shows such a name reading it; a drawer on Customize the
Gym. Under Q9.1 B, every page title also reads its door's name.

**PR split (INFERRED), for Q9.1 A:**

| PR | What | Est. lines | Basis |
|---|---|---|---|
| RN-1 | Migration: one row per gym per name, from a closed list of keys in code, each with its default. Runner. A read for the gym's signed-in members and a write for the organization admin, audited. INFERRED: a blank name means the default; a name another key uses is refused. | about 420 (may go over) | matched, AS2-a 414 |
| RN-2 | One read after sign-in and a lookup that falls back to the default. Whatever shows room names now that AS-4 has landed reads them through it: Search's Room Map groups (`CardCatalog.tsx`) and the name Corridor prints for the group, and the door register. Search matches the name shown (Q9.2 A, OW27-41). NOT RULED: whether the job bar's own section names are renamable; they are not Room Map rooms, and OW27-40 A names the Room Map rooms and the card names, so they are left out (INFERRED). | about 300 | judgement |
| RN-3 | The three names in OW27-15's option text, now typed in their files by AS8-4, read through the lookup: "Your Profile" (the `/profile` door and title), "Who you train with", "Your entry"; plus "My Corner", which the entry's reading of OW27-15 gives as an example (INFERRED). | about 120 | judgement |
| RN-4 | A "Room names" drawer on Customize the Gym: each name, its default, a field, "Use the default". | about 250 | matched, AS2-c 174, plus a list |

- **Total:** about 1,090 lines in 4 PRs. Q9.1 B adds about 700 to 1,000 in 3
  more PRs (judgement): page titles read their door's name, and
  `doorLabelsMatchTitles.test.ts` checks that instead of a literal. Q9.1 C:
  about 970 in 3 PRs (no RN-3).
- **Migrations:** 1 (RN-1).
- **Route:** Opus for RN-1 (a new write route and its gate); Sonnet for RN-2 to
  RN-4 (words; no permission, sign-in or minors' data change).
- **G3:** INFERRED not to apply: only what a place is called changes.
- **Dependencies:** none outstanding. #2029 and U2's 4a, 4b and 4c have merged,
  and AS-8's AS8-4 (#2100) has set the starting names. RN-4 and EM-6 (and item
  6's SC-0b) each add a Customize drawer, one after the other.
- **File overlap (open PRs listed 2026-11-23: #2039, #2082, #2124, #2126):**
  - `buildingMap.ts` (RN-2's search) is lane U2's file; its last changes on
    `main` are `013a4fd7` (PATTERN-1c) and `9006c27b` (AS10-7). It is in
    `PG_SUITE_DEPENDENCIES` (`scripts/ci-classify-paths.mjs:89-90`), so RN-2 runs
    the pg suites, and a new name file it imports is added there (INFERRED).
    `roomPlaces.ts` and `jobBars.ts` are new on `main` and were not checked
    against that list.
  - RN-3 changes the files AS8-4 changed: `app/profile/page.tsx`,
    `AthleteCorner.tsx`, `AthleteAchievements.tsx` and the sparring page. AS8-4
    has merged.
  - RN-1 shares the registration files with the other migration PRs. None of
    the open PRs read changes these (#2124 changes only
    `BehaviourSampleWindow.tsx` and its test; #2126's files unknown; #2039 and
    #2082 not read).

**Owner questions:**

**Owner questions.** None open. Q9.1 is answered A (OW27-40) and Q9.2 is
answered A (OW27-41), both OD-2026-11-21-007 (the table above).

- **Q9.1 What can a gym rename? Answered: A.** The rooms and the card names. The
  rooms are the 17 Room Map rooms, and the 7 rooms while their names still show,
  wherever they show. The card names are the three in OW27-15's option text,
  "Your Profile" (the `/profile` door and title), "Who you train with" and "Your
  entry", plus "My Corner", the entry's own example (INFERRED); other pages keep
  theirs. Sized this way. Not chosen: B, A plus every door's page name (150 on
  `main` at `a4b420c`; about 700 to 1,000 more lines in 3 more PRs, the title test
  rebuilt). This file's old option C, the rooms only (about 970 in 3 PRs), was not
  offered; the card's C was "Only the names already answered", which is smaller
  than A and not sized (INFERRED, as the card says).
- **Q9.2 Does Search find a renamed page or room by its old name? Answered: A.**
  No. Search matches the name shown and the door's existing keywords, unchanged.
  Sized this way. Not chosen: B, the old name stays a search word (about 20 more
  lines in RN-2, judgement).

---

## Summary

| # | Item | PRs | Est. lines outside tests | Migrations | Route | G3 | Waits on |
|---|---|---|---|---|---|---|---|
| 1 | Email alerts (W4R; Q1.11 and Q1.12 answered) | 8 | about 2,290 | 3 (4 if EM-2b keeps its code in its own table) | Opus | yes | a running tick; no open question |
| 2 | Web push (later) | 3 (4 without the package) | about 920 (1,120 without the package) | 1 | Opus | yes | item 1 (EM-1, EM-3, EM-5); a key in Azure; a dependency call; "later" (OD-2026-11-19-019). Q2.1 and Q2.2 answered |
| 3 | On the floor now | 4 | about 700 | 0 | Opus | yes | the privacy review (FN-0), signed off by Overwatch after two reviewers (Q3.5 B). Q3.1 to Q3.4 answered |
| 4 | Parent starts a message | 3 | about 970 | 1 | Opus | yes | no open question (Q4.1 A to Q4.5 A) |
| 5 | Plan blocks (drill, copied, text); class from a plan | 6 | about 1,540 | 1 | Opus (SP-1a, SP-1b, SP-3, SP-4), Sonnet (SP-2a, SP-2b) | no (INFERRED) | no open question. Whether a U2 6c PR will change the class screen is UNKNOWN |
| 6 | Stopped coming (gym setting; "reached out" mark) | 6 | about 1,720 (about 870 on the cards' figures) | 2 | Opus | yes | no open question |
| 7 | Offline save queue (open page only) | 4 | about 1,120 | 0 or 1 | Opus | yes | no open question (unblocked by Q7.1 A and Q7.2 A) |
| 8 | Typed lines to drills | 8 | about 2,530 | 0 | Opus | no (INFERRED) | no open question |
| 9 | Room renaming (W4R; Q9.1 and Q9.2 answered) | 4 | about 1,090 | 1 | Opus (RN-1), Sonnet (RN-2 to RN-4) | no (INFERRED) | no open question |

**Total (INFERRED):**

Updated by lane W4S-REFRESH, 2026-11-23, at `main` `a4b420c`: items 2 to 7 re-sized
under the recorded answers (OD-2026-11-21-006), items 1 and 9 under
OD-2026-11-21-007. W4S's figures were 32 PRs, about 9,050 lines and 30
questions; lane W4R's were 39 PRs, about 11,080 lines.

- **Size:** 46 PRs, about 12,880 changed lines outside tests, with the recorded
  answers to every question. By item: 2,290 + 920 + 700 + 970 + 1,540 + 1,720 +
  1,120 + 2,530 + 1,090. Item 8 is sized with every unique line a new drill, the
  recorded Q8.1 answer.
- **What moved:** item 1 +150 (EM-2b, Q1.11 B); item 2 +30 (the gym-tablet
  check, Q2.1 B); item 3 +60 (two sources, Q3.1 C); item 5 +390 (copied and text
  blocks, Q5.1 A); item 6 +1,170 (the gym setting, Q6.1 A, about 590; the "reached
  out" mark, Q6.4 B, about 530; the rest, +50); items 4, 7, 8 and 9 unchanged.
- **Larger case:** web push without the package, Overwatch's call, adds 1 PR
  and about 200: 47 PRs, about 13,080. The sized options that were not chosen
  (Q7.1 B, about 500 more; Q9.1 B, about 700 to 1,000 more) are not part of it.
- **Smaller case:** item 6 on the cards' own figures (a setting of about 120, a
  mark of about 200) is about 870, so the total is about 12,030.
- **If the judgement rows run like the measured PRs:** about 18,600 (see "How
  the sizes were made").
- **Migrations:** 9 with the recorded answers (item 1: 3; item 2: 1; item 4: 1;
  item 5: 1; item 6: 2; item 9: 1), up to 11 if EM-2b keeps its code in its own
  table and item 7's request keys need a unique-key migration. Overwatch may fold
  some into fewer files.
- **Questions: 0 open.** All 36 W4 questions are answered or ruled. Each is
  written out once, in its item.
  - Q1.1 to Q1.8: OD-2026-11-20-001 (OW27-01 to OW27-08 and OW27-10).
  - Q1.9 (as a reading, INFERRED), Q1.10 (its pick under Jason's OW27-06
    delegation) and Q8.2 (from OD-2026-11-19-030): Overwatch on #2050. Q8.1:
    OD-2026-11-20-001, OW27-09.
  - OD-2026-11-21-007: Q1.11 = OW27-38 B; Q1.12 = OW27-39 A; Q9.1 = OW27-40 A;
    Q9.2 = OW27-41 A.
  - OD-2026-11-21-006: Q2.1 = OW27-17 B; Q2.2 = OW27-18 A; Q3.1 = OW27-19 C;
    Q3.2 = OW27-20 A; Q3.3 = OW27-21 A; Q3.4 = OW27-22 A; Q3.5 = OW27-23 B;
    Q4.1 = OW27-24 A; Q4.3 = OW27-25 A; Q4.4 = OW27-26 A; Q4.5 = OW27-27 A;
    Q5.1 = OW27-28, answered by OW27-36 A; Q5.2 = OW27-29 A; Q6.1 = OW27-30 A;
    Q6.2 = OW27-31 A; Q6.3 = OW27-32 A; Q6.4 = OW27-33 B; Q7.1 = OW27-34 A;
    Q7.2 = OW27-35 A.
  - Q4.2: ruled earlier, OD-2026-10-12-024 (listed as "ruled, batch 1" in
    OD-2026-11-21-006's check note).
  - Against the recommendation (as OD-2026-11-21-006 lists): OW27-17 B, OW27-19
    C, OW27-23 B and OW27-33 B.
  - OD-2026-11-23-001 answers none.
  - Not ruled, left to the builds (each is in its item): the code email's
    wording (item 1); whether a personal phone's push subscription ends at
    sign-out and whether the email switch also gates push (item 2); the words of
    the live line and the register-only case (item 3); the gap setting's range,
    the "present at least once" source and what "reached out" holds (item 6);
    whether the PATTERN window taps join the live-floor saves (item 7); whether
    job bar section names are renamable (item 9).
- **Route:** 41 of the 46 PRs route to Opus. SP-2a and SP-2b are Sonnet unless
  SP-1a or SP-1b finds a contact gate; RN-2 to RN-4 are Sonnet.
- **Not given here:** a completion date. This lane did not measure lane
  throughput.

**Order that the dependencies allow (INFERRED):**

- Item 8: #2008 has merged, and Q8.1 and Q8.2 are answered; no question is
  open.
- Items 1, 4, 5, 6, 7 and 9 need no answer. What each still needs:
  - Item 1's EM-3 needs a tick confirmed (#2013 has merged); EM-2b after EM-2
    and EM-3.
  - Item 4's PM-1 and PM-2 have nothing open waiting on them: #2012 and #2010
    have merged.
  - Item 5's SP-4 changes the class screen; U2's 6a, 6b-1, 6b-2 and 6d are
    merged, and whether a 6c PR comes is UNKNOWN.
  - Item 6's SC-0a first, then SC-1; SC-2's door goes into one Room Map room
    (Overwatch's call).
  - Item 9's RN-1 first; AS-4 (4a to 4c) and AS8-4 have merged.
- Item 3 needs its privacy review signed off first, by Overwatch after two
  reviewers (Q3.5 B), then FN-1, then FN-2 and FN-3.
- Item 2 waits on item 1, and is "later" (OD-2026-11-19-019).
- Item 7 is not blocked: Q7.1 A and Q7.2 A (OD-2026-11-21-006) select its
  design.

## Adjacent finding (reported, not part of any W4 item)

- **What the comment says.** `apps/web/src/server/pilot/graphMailer.ts:19-23`
  says `assertSenderIsExpected()` "refuses to send from anything other than the
  configured address", so a misconfiguration "cannot quietly widen the blast
  radius from this side".
- **What the call does.** Its only call (`:125`) compares `config.sender` with
  itself, so it refuses only an empty sender.
- **Effect today (INFERRED).** None, while the one caller passes its own
  constant (`magicLinkStore.ts:29`, `:99`).
- **When it matters.** It becomes real once a second sender path exists. With
  one mailbox (OD-2026-11-20-001, OW27-05 A), item 1 adds no second sender, so
  EM-3 does not need the fix. It is listed here so it is not lost.

## Adjacent findings from lane W4S-REFRESH (reported, not fixed; outside this file)

- **ACTIVE_WORK's U2 row is behind `main`.** At `a4b420c`, `docs/current/ACTIVE_WORK.md`
  (the lane U2 row, line 138) says "6c, AS-4 (4a to 4e) and AS-7 not started",
  while `main` carries U2-4a (#2029, `b555d5b8`), 4b (#2068, `5b28948a`) and 4c
  (#2073, `3580389a`) and the coach home PRs of lane 6C7 (git log of `main`).
- **The `/profile` door and page differ.** The door's label is "Your Corner"
  (`apps/web/components/buildingMap.ts:382`); the page's title is "Your Profile"
  (`apps/web/app/profile/page.tsx:25`). The title test lists `/profile` in
  `TITLE_NOT_LITERAL` (`doorLabelsMatchTitles.test.ts:35`), so it does not see
  the difference (see item 9).

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
- **Lane W4S-REFRESH update, 2026-11-23 (in progress):** the recorded answers of
  OD-2026-11-21-006 (OW27-17 to OW27-37) and OD-2026-11-21-007 (OW27-38 to
  OW27-44) are applied; OD-2026-11-23-001 answers no W4 question. Item 1's
  Q1.11 and Q1.12 are applied in this commit; the other items follow.

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
After lane W4R the same check gives about 15,700 rather than about 11,080.
The 22 judgement rows sum to about 5,970; at 480 each they would be 10,560.

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
  (`apps/web/src/server/pilot/shadowDisclosure.ts:19-20`, `:328`).
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
  parent, admin, staff and volunteer (`apps/web/app/profile/page.tsx:26`);
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
  minor (`apps/web/src/server/pilot/wallDisplay.ts:220-223`; 18 at `:128`).
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
- **Dependencies:** FN-0 before FN-1, signed off as Q3.5 says; #2012 before
  FN-1.
- **File overlap:**
  - FN-1 uses the guardian checks in `guardianAccess.ts`, which #2012 (lane
    GA) changes (+30 lines at `5efdc9b6`). FN-1 goes after #2012 merges.
  - FN-1 shares the registration files with #2013 (above).
  - FN-2 changes `AthleteWorkspace.tsx`, which #2006 (lane U3) changes (+256
    lines at `c5c39034`), and U2 item 4e later.
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

**The scrub (stage 1, FAM-09 row):** "A parent cannot start a message to the
coach; they can only reply under one. With "No messages yet." the tab offers
nothing. Barrier types are Home and Transportation only." Its proposal: "Point the empty Messages state to Report a Barrier,
Observations and the coach (a compose box would be FUTURE)." Stage 3 section
3.6 lists the compose box as FUTURE.

**What exists (OBSERVED):** a parent can write to the coach outside Messages,
and a coach can write to the family. On the Messages tab, a parent can only
reply.

- **Parent to coach: the Observations note (WO-PH-04).** A guardian writes a
  free-text note for the coach about their own child
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
  (`apps/web/app/api/pilot/parent/barrier-report/route.ts:43`), of two types
  only, home and transportation (`:24`).
- **Coach to family.** A coach posts a note to the family as a
  `coach_observations` row with `note_type 'parent_message'`
  (`apps/web/app/coach/decision-loop/page.tsx:1102`). The parent reads it on
  Messages (`apps/web/app/api/pilot/parent/messages/route.ts:36`, `:38`).
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
| PM-2 | Staff side: the messages on "From the family" with reply, and the unread count across the roster | about 300 | judgement |
| PM-3 | Parent side: the compose box and the thread on the Messages tab | about 250 | judgement |

- **Total:** about 970 lines in 3 PRs.
  - Q4.1 B: about 880 in 3 PRs (judgement): a staff reply under a parent's
    Observations note, with its migration (about 380); the staff side (about
    300); the parent seeing the reply (about 200).
  - Q4.1 C: none.
- **Migrations:** 1 (none under C).
- **Route:** Opus (minors' data, permissions, guardian access).
- **G3:** applies.
- **Dependencies:** #2012 before PM-1. Under item 1's gym setting, a parent's
  new message is one more event the gym can turn on for staff (Q1.9).
- **File overlap:**
  - PM-1 uses `guardianAccess.ts`, which #2012 (lane GA) changes (+30 lines at
    `5efdc9b6`). PM-1 goes after #2012 merges. It also shares the registration
    files with #2013.
  - PM-2 changes `apps/web/app/coach/decision-loop/page.tsx`, which #2010 (lane
    AS-5, AS5-1) changes (+20 lines at `0d342ee3`).
  - A coach-home inbox (Q4.4 B) changes `CoachWorkspace.tsx`, which is U2's file
    and #2010's Q11 B.

**Owner questions:**

- **Q4.1 What does FAM-09 build?**
  - **A (recommended):** the scrub's FUTURE item: a compose box on the Parent
    Hub's Messages tab. The parent's message sits in the same list as the
    coach's notes, and the coach answers under it.
  - **B:** no new box. Staff can answer under a parent's existing Observations
    note, and the parent sees the answer there.
  - **C:** nothing to build. Observations already lets a parent write to the
    coach, and Report a Barrier covers home and transportation only. The
    scrub's AS-9 batch would point the empty Messages state to them; a search
    of ACTIVE_WORK on `main` found no AS-9 lane.
- **Q4.2 Does the other guardian see the thread?**
  - **A (recommended):** no. Each guardian sees their own, the same line the
    Observations note and the barrier report draw for split households
    (LQ-PH04-1).
  - **B:** both guardians see it.
- **Q4.3 (folded into Q1.9, lane W4R).** Under OD-2026-11-20-001 (OW27-10 A)
  the gym picks which events send the email. A parent's new message is one more
  event on that list for staff, so this is no longer asked here (INFERRED).
- **Q4.4 Where do coaches answer?**
  - **A (recommended):** on the Decision Loop's "From the family", where
    parents' notes are read today.
  - **B:** on the coach home, beside the alerts.
- **Q4.5 Whose unread count does a new message raise?** Today any staff member
  can read every note type (`route.ts:31-32`).
  - **A (recommended):** the child's assigned coach, any coach covering them,
    and admins: the people a SHADOW safety alert reaches (OD-2026-10-01-008
    section 3).
  - **B:** every coach in the gym.

## 5. A coach adds drills or blocks to a session plan, and schedules a class from it (scrub CF-11)

**The scrub (stage 1, CF-11 row):** "Planning stops short: a session plan can
only be made from a template and only renamed or retimed (no drills, no blocks
added); a scheduled class cannot carry its plan, they meet only at start." Its
FUTURE list names "a class that carries its session plan ahead of time
(CF-11)".

**What exists (OBSERVED):**

- **The screen.** "Session Plans" is the screen name for session scripts
  (`apps/web/app/coach/session-scripts/page.tsx:477`).
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
  `/schedule` (`apps/web/app/schedule/page.tsx:1044`). A class row has no plan
  column (`infra/azure/pilot_slice_postgres_scheduler_tables_migration.sql:11-26`).
- **Class and plan.** They meet only when a session starts
  (`apps/web/src/client/startClassSession.ts:45-52`). The class screen starts
  with no plan (`apps/web/app/coach/class/page.tsx:147`); its comment at `:19`
  says "Plans are still started from Session Plans".

**What is missing:**

- **The block edits.** Adding a block (a drill from the library), and removing
  and reordering blocks.
  - INFERRED: these need no migration. Order can be renumbered in one
    transaction.
  - A new drill block can carry "From the drill" facts in `what_to_explain`,
    the way template steps do.
- **The class link.** A class that carries a plan, which needs a migration, and
  the class screen starting that plan.

**PR split (INFERRED):**

| PR | What | Est. lines | Basis |
|---|---|---|---|
| SP-1 | Server and edit route: add a drill block, remove a block, move a block; the versioning as today | about 350 | judgement (`sessionScriptAuthoring.ts` is 724 lines) |
| SP-2 | The editor: a drill picker, remove, move up and down | about 300 | judgement (`apps/web/app/coach/session-scripts/SessionScriptEditor.tsx` is 259 lines) |
| SP-3 | Migration: a plan link on a scheduled class; the scheduler accepts it | about 250 | judgement |
| SP-4 | "Schedule a class" from Session Plans; the class screen starts the class's plan | about 250 | judgement |

- **Total:** about 1,150 lines in 4 PRs.
- **Migrations:** 1 (SP-3), only if Q5.2 is A.
- **Route:**
  - **Opus for SP-1**, because a sparring-contact drill could be added to a
    plan.
    - The plan's contact label is computed from its steps (`contactStructure`,
      `sessionScriptAuthoring.ts:113-121`) and shown on Session Plans
      (`page.tsx:607`).
    - Block minutes are checked (`pilot_ssb_window`, migration `:97`).
    - SP-1 must keep both right when blocks are added, removed or moved.
    - UNVERIFIED whether any gate reads a block's contact level when a session
      runs.
  - **Sonnet for SP-2.** The picker sends only what SP-1's route accepts, so
    any contact rule lives and is reviewed in SP-1. If SP-1 finds a contact
    gate, SP-2 moves to Opus.
  - **Opus for SP-3 and SP-4** (the scheduler's role gate).
- **G3:** INFERRED not to apply (no sign-in, minors' data or safety screen),
  unless SP-1 finds a contact gate.
- **Dependencies:** OD-2026-10-21-002 D4 ("A: Tie them") already ties a session
  to its class at start. SP-4 changes the class screen, which lane U2 owns
  (6b to 6d not started).
- **File overlap:** U2's later class-screen PRs (`apps/web/app/coach/class/page.tsx`);
  SP-3 shares the registration files with #2013.

**Owner questions:**

- **Q5.1 What can a coach add?**
  - **A (recommended):** a drill from the library, as a new block.
  - **B:** A, plus a block copied from another plan.
  - **C:** A, plus a block with its own text and no drill: a teaching minute, a reset
    minute or a transition, from the existing block kinds
    (`infra/azure/pilot_slice_postgres_session_scripts_migration.sql:84-86`).
- **Q5.2 What does "schedules a class from it" keep?**
  - **A (recommended):** the class keeps the plan, and Start on the class
    screen starts that plan. This is the scrub's FUTURE wording, "a class that
    carries its session plan ahead of time".
  - **B:** the plan only fills in the schedule form (title, length), and
    nothing is kept.

## 6. A "who has stopped coming" page (scrub CF-14)

**The scrub (stage 1, CF-14 row):** "No page answers "who has stopped coming";
the Passbook Gaps door keywords say "stopped coming" while the page says it is
not that check." Its FUTURE list names "a "who has stopped coming" list
(CF-14)".

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
  - SC-1 shares the registration files with #2013.

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
- **Q6.3 Does open gym count as coming?** This is an open owner decision.
  - The session-marks migration says the table is "SESSION DETAIL, NOT
    ATTENDANCE", and that whether a mark "should ever count toward a
    participation figure is an owner decision that has not been made".
  - It quotes Overwatch, 2026-10-13: a mark "feeds NO attendance report,
    reconciled view, board or grant figure"
    (`infra/azure/pilot_slice_postgres_session_run_athletes_migration.sql:26-32`).
  - OD-2026-09-28-008 keeps one system of record for attendance.
  - **A (recommended):** yes, for this page only. Open-gym "here" marks count
    as coming, so an athlete seen only at open gym is not listed. SC-1 reads
    them (in its estimate). No attendance figure changes. This departs from
    Overwatch's 2026-10-13 note, so it needs Jason's ruling.
  - **B:** register marks only, as attendance is counted today. The list may
    then name athletes who come only to open gym. SC-1 is about 250.
- **Q6.4 What can a coach do on the page?**
  - **A (recommended):** read the list and open the athlete.
  - **B:** A, plus mark "reached out". That needs a migration and a third PR
    (about 200 lines more).

## 7. An offline save queue: failed saves are kept and retried

**Rulings and records (OBSERVED):**

- OD-2026-09-28-008: "offline storage stays parked".
- The PARKED row `BACKLOG-offline-write-queue` in `docs/current/ACTIVE_WORK.md`
  (`:270` on `main` `c27c581`): re-open when "A concrete identity-scoped
  encrypted/offline storage design is selected".
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
- **Browser storage. Neither store holds a save payload.**
  - `localStorage` holds UI preferences, the gym-tablet device mark
    (`apps/web/src/lib/gymTabletMark.ts`) and the chosen child
    (`apps/web/src/lib/chosenChild.ts:31`).
  - It also holds a notice-catalog counter
    (`apps/web/components/gymNotices.ts:173`) and per-athlete "ceremony shown"
    records keyed by athlete id (`apps/web/components/milestoneCeremony.ts:55`,
    `apps/web/components/achievementCeremony.ts:52`).
  - `sessionStorage` holds a pending request key
    (`apps/web/app/schedule/page.tsx:262`,
    `apps/web/app/coach/test-day/page.tsx:77-78`) and the chosen child.
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
- **If Q7.1 is B:** add about 500 lines in 2 more PRs (an encrypted store with
  its wipe at sign-out; a privacy review), about 1,620 in 6 PRs (judgement).
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
    shared tablet. This is a new restriction, and it falls on minors.
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
- **Dependencies:** #2008 merges first. It adds `TYPED_IN_MIXED`, and each PR
  that rewrites steps removes its templates' entries.
- **Load:** after each merge, staging then production, by Overwatch.
- **File overlap with #2008, which changes all of these:**
  - `seed_drill_library.csv` and `seed_drill_cues.csv`;
  - test files that the TL PRs will also edit:
    `apps/web/src/server/pilot/committedTemplateIssueSweep.test.ts`,
    `apps/web/src/server/pilot/ft1ContentPackage.pg.test.ts`,
    `apps/web/scripts/backbone-export-ft1-track.test.ts`.

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
later lets the organization rename rooms". AS-8 builds the starting names
(#2020's PR body, read 2026-11-20: plan approved, not built; not in the repo,
so UNVERIFIED here). This sizes only the later renaming.

**What "room" names in code** (OBSERVED; `main` `600b4f7`, #2029 at `1f803f4d`):

- **Seven rooms.** `Room` (`apps/web/components/buildingMap.ts:60-78`), named in
  `ROOM_LABEL` (`:733-741`, e.g. "Front Office", "Gym Floor").
- **Doors.** 144 in `BUILDING` (`:150-728`; the `{ href:` entries, counted by
  script). A door's key is its `href`; its `label` is the page's name in the
  menus (`Door`, `:83-110`). "Your Corner" is the `/profile` door (`:346`).
- **The 17 Room Map rooms.** Not on `main` (a search of `apps/web` for
  `room map`, `roomMap`, `ROOM_MAP` matched only a test). #2029 (lane U2, AS-4,
  open) adds them for Search as `ROOM_PLACE_LABEL`
  (`apps/web/components/roomPlaces.ts:62-80` at its head).
- **Job bars.** None on `main` (a search for `jobBar`, `job bar`, `job-bar`).
  #2029's `apps/web/components/jobBars.ts` has sections with their own names
  (`:48-51`) and items by `href` only (`:42-45`); "4b draws it" (`:6`).
- **Names inside pages.** "My Corner" is a heading, not a door
  (`apps/web/components/AthleteCorner.tsx:127-128`). The mentors heading
  (`apps/web/components/AthleteAchievements.tsx:467`) and the Sparring Log
  eyebrow (`apps/web/app/athlete/dashboard/sparring/page.tsx:771`) are typed
  into their files.

**Where the names show (OBSERVED):**

- **Corridor and Jump.** `Corridor.tsx` (`ROOM_LABEL` at `:88`) and
  `CardCatalog.tsx` (`:292-293`, `:495`), on every route through
  `GlobalRoleHeader.tsx:244`, `:266`; client components that wait for the
  session (`Corridor.tsx:31`, `CardCatalog.tsx:128`). OD-2026-11-19-008
  replaces both with "a job bar and Search; the Rooms list becomes "All pages"
  inside Search", which U2's AS-4 builds. So RN-2 changes whatever shows room
  names once AS-4 is done (INFERRED); whether the 7 rooms' names still show then
  is UNKNOWN.
- **Search.** `searchDoors` scores the label, then label, keywords and href
  together (`buildingMap.ts:782-805`). The door register
  (`apps/web/app/admin/door-register/page.tsx`) prints room and door names too.
- **Page titles.** Each page types its own; none comes from `buildingMap.ts`
  (e.g. `apps/web/app/schedule/page.tsx:943-944`). `/profile`'s is the shell's
  `roleLabel` (`apps/web/app/profile/page.tsx:24`, printed at
  `apps/web/components/RoleStandaloneView.tsx:249`).
- **The rule that ties them.** `apps/web/components/doorLabelsMatchTitles.test.ts`
  checks each door label against its page's literal `<h1>`. Doors whose title
  is not a literal are listed in `TITLE_NOT_LITERAL` (`:29-47`), `/profile`
  among them (`:34`). The rule is OD-2026-10-17-001 item 1
  ("Each menu label matches its page title."), which OD-2026-11-19-008 keeps.

**Gym settings today (OBSERVED):** a search of `infra/azure/*.sql` for
`door_label`, `room_label`, `room_name`, `label_override`, `nav_label`,
`display_label`, `organization_settings`, `org_settings` and `gym_profile` found
no match. `pilot.organization_profiles` has no column for names
(`infra/azure/pilot_slice_postgres_organization_profiles_migration.sql:42-87`),
and the root layout reads only the operating gym's profile, not the signed-in
person's (`apps/web/src/server/pilot/organizationProfileStore.ts:40`,
`:252-254`; `apps/web/app/layout.tsx:86`). So a gym's names cannot ride that
read (INFERRED). The pattern to copy is the tablet idle time (item 1).

**What is missing:** a name per gym for each name that can change, with the
default in code; a read for the gym's members and a write for the organization
admin; every place that shows such a name reading it; a drawer on Customize the
Gym. Under Q9.1 B, every page title also reads its door's name.

**PR split (INFERRED), for Q9.1 A:**

| PR | What | Est. lines | Basis |
|---|---|---|---|
| RN-1 | Migration: one row per gym per name, from a closed list of keys in code, each with its default. Runner. A read for the gym's signed-in members and a write for the organization admin, audited. INFERRED: a blank name means the default; a name another key uses is refused. | about 420 (may go over) | matched, AS2-a 414 |
| RN-2 | One read after sign-in and a lookup that falls back to the default. Whatever shows room names after AS-4 reads them through it: Search's Room Map groups, the job bars, the door register, and Corridor and Jump if they remain. Search matches the name shown (Q9.2). | about 300 | judgement |
| RN-3 | The three names in OW27-15's option text read through the lookup: "Your Profile" (the `/profile` door and title), "Who you train with", "Your entry"; plus "My Corner", which the entry's reading of OW27-15 gives as an example (INFERRED). | about 120 | judgement |
| RN-4 | A "Room names" drawer on Customize the Gym: each name, its default, a field, "Use the default". | about 250 | matched, AS2-c 174, plus a list |

- **Total:** about 1,090 lines in 4 PRs. Q9.1 B adds about 700 to 1,000 in 3
  more PRs (judgement): page titles read their door's name, and
  `doorLabelsMatchTitles.test.ts` checks that instead of a literal. Q9.1 C:
  about 970 in 3 PRs (no RN-3).
- **Migrations:** 1 (RN-1).
- **Route:** Opus for RN-1 (a new write route and its gate); Sonnet for RN-2 to
  RN-4 (words; no permission, sign-in or minors' data change).
- **G3:** INFERRED not to apply: only what a place is called changes.
- **Dependencies:** #2029 merges first; RN-2's job bar part waits for U2's 4b;
  RN-3 goes after AS-8's AS8-4 sets the starting names; RN-4 and EM-6 both add
  a Customize drawer, one after the other.
- **File overlap (heads read 2026-11-20):** `buildingMap.ts` (RN-2's search):
  #2029 changes it (#2030 changed it and has merged), and it is lane U2's
  file. It is in
  `PG_SUITE_DEPENDENCIES` (`scripts/ci-classify-paths.mjs:89-90`), so RN-2 runs
  the pg suites, and a new name file it imports is added there (INFERRED). RN-3
  changes AS8-4's planned files, per #2020's body (UNVERIFIED in the repo):
  `app/profile/page.tsx`, `AthleteCorner.tsx`, `AthleteAchievements.tsx` and
  the sparring page. RN-1 shares the registration
  files.

**Owner questions:**

- **Q9.1 What can a gym rename?** Jason's; it goes to him as a card. Checked,
  not answered in:
  `docs/current/OWNER_DECISIONS.md` (OD-2026-11-20-001 OW27-11 and -15;
  OD-2026-10-17-001; OD-2026-11-19-008; a search for "rename" and "room
  names"), `docs/research/app-scrub-2026-11-19/` (stages 1 and 3), this
  lane's brief.
  - **A (recommended):** the rooms and the card names. The rooms are
    #2029's 17 Room Map rooms, and the 7 rooms while their names still show,
    wherever they show. The card names are the three in OW27-15's option text,
    "Your Profile" (the `/profile` door and title), "Who you train with" and
    "Your entry", plus "My Corner", the entry's own example (INFERRED); other
    pages keep theirs. Pros: covers the names on the cards and the rooms; a
    door and its title read one name, so each menu label still matches its
    page title. Cons: other pages cannot be renamed. Sized this way.
  - **B:** A, plus every door's page name (144 on `main`). Pros: every name a
    person moves between can change. Cons: about 700 to 1,000 more lines in 3
    more PRs; the title test is rebuilt.
  - **C:** the rooms only. Pros: smallest: about 970 in 3 PRs, about 120 less.
    Cons: the card names ("Your Profile", "My Corner") stay fixed.
- **Q9.2 Does Search find a renamed page or room by its old name?** Jason's; it
  goes to him as a card. Checked, not answered in: the same sources.
  - **A (recommended):** no. Search matches the name shown and the door's
    existing keywords, unchanged. Sized this way. This avoids the problem the title test was
    written for: "the catalog search found a page by a name the page never
    showed" (`doorLabelsMatchTitles.test.ts:7-9`).
  - **B:** yes, the default stays a search word. Pros: a member who learned the
    old name still finds it. Cons: Search shows a page for a name it does not
    show; about 20 more lines in RN-2 (judgement).

---

## Summary

| # | Item | PRs | Est. lines outside tests | Migrations | Route | G3 | Waits on |
|---|---|---|---|---|---|---|---|
| 1 | Email alerts (re-sized, W4R) | 7 (8 if Q1.11 B) | about 2,140 (2,290 if Q1.11 B) | 3 (4 if Q1.11 B) | Opus | yes | Q1.11, Q1.12; a running tick |
| 2 | Web push (later) | 3 (4 without the package) | about 890 (1,090 without the package) | 1 | Opus | yes | item 1; Q2.1, Q2.2; a key in Azure; a dependency call |
| 3 | On the floor now | 4 | about 640 | 0 | Opus | yes | privacy review (FN-0, Q3.5); Q3.1 to Q3.4; #2012; U2 for the coach home |
| 4 | Parent starts a message | 3 (0 if Q4.1 C) | about 970 (880 if B; 0 if C) | 1 (0 if C) | Opus | yes | Q4.1 to Q4.5; #2012 |
| 5 | Plan blocks; class from a plan | 4 | about 1,150 | 0 or 1 | Opus (SP-1, SP-3, SP-4), Sonnet (SP-2) | no (INFERRED) | Q5.1, Q5.2; U2 for the class screen |
| 6 | Stopped coming | 2 (3 if Q6.4 B) | about 550 | 0 (1 if Q6.4 B) | Opus | yes | Q6.1 to Q6.4; U2 for the door |
| 7 | Offline save queue | 4 (6 if B) | about 1,120 (1,620 if B) | 0 or 1 | Opus | yes | BLOCKED: Q7.1, Q7.2 |
| 8 | Typed lines to drills | 8 | about 2,530 (Q8.1 answered B) | 0 | Opus | no (INFERRED) | no open question (#2008 has merged) |
| 9 | Room renaming (W4R) | 4 (7 if Q9.1 B; 3 if C) | about 1,090 (1,790 to 2,090 if B; 970 if C) | 1 | Opus (RN-1), Sonnet (RN-2 to RN-4) | no (INFERRED) | Q9.1, Q9.2; #2029; U2's 4b; AS8-4 |

**Total (INFERRED):**

Updated by lane W4R: item 1 re-sized, item 9 added. W4S's figures were 32
PRs, about 9,050 lines and 30 questions.

- **Size:** 39 PRs, about 11,080 changed lines outside tests, with the recorded
  answers and the recommended answers to the open questions. Item 8 is sized
  with every unique line a new drill, the recorded Q8.1 answer.
- **Larger case:** adding the sized alternatives gives 47 PRs and about 12,830
  to 13,130. Those are: web push without the package, the "reached out" mark,
  offline queue B, Q1.11 B's confirm step, and Q9.1 B's page names. Q4.4 B,
  and Q5.1 B and C, are not sized.
- **If the judgement rows run like the measured PRs:** about 15,700 (see "How
  the sizes were made").
- **Migrations:** 7 or 8 with the recommended answers; 5 to 10 across all
  answers.
- **Questions:** 23 open. Each is written out once, in its item.
  - Open: Q1.11, Q1.12, Q2.1 to Q2.2, Q3.1 to Q3.5, Q4.1, Q4.2, Q4.4, Q4.5,
    Q5.1 to Q5.2, Q6.1 to Q6.4, Q7.1 to Q7.2, and Q9.1 to Q9.2.
  - Jason's, going to him as cards (Overwatch on #2050): Q1.11, Q9.1 and Q9.2.
  - Answered in OD-2026-11-20-001: Q1.1 to Q1.8 and Q8.1.
  - Answered by Overwatch on #2050: Q1.9 (as a reading, INFERRED), Q1.10 (its
    pick under Jason's OW27-06 delegation) and Q8.2 (from OD-2026-11-19-030).
    Q4.3 is folded into Q1.9.
- **Route:** 35 of the 39 PRs route to Opus. SP-2 is Sonnet unless SP-1 finds a
  contact gate; RN-2 to RN-4 are Sonnet.
- **Not given here:** a completion date. This lane did not measure lane
  throughput.

**Order that the dependencies allow (INFERRED):**

- Item 8: #2008 has merged, and Q8.1 and Q8.2 are answered; no question is
  open.
- Items 1, 4 and 6 need only their questions, apart from these:
  - Item 1's EM-3 needs a tick confirmed (#2013 has merged).
  - Item 4's PM-1 waits for #2012, and its staff side for #2010's Decision
    Loop PR.
- Item 3 needs its privacy review signed off first.
- Item 5's class part and items 3 and 6's coach-side pieces wait on lane U2's
  files.
- Item 2 waits on item 1.
- Item 7 is BLOCKED until Q7.1 selects a design.
- Item 9 waits for #2029 (U2's AS-4) and AS-8's AS8-4, and its job bar part for
  U2's 4b.

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

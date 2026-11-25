# FN-0: privacy review of the "on the floor now" line (W4 item 3)

The privacy review W4 item 3 waits on (`W4_SIZING.md`, section 3, row FN-0).
It builds nothing; it recommends. It says, for each role, what the live line
may show and what it must never show, over the two sources Jason chose. Six
points are not ruled, and are questions in section 6: a register mark on a
cancelled class, the words of the line (including what a register-only mark
is called and from when it counts), what the line shows on the homes no answer covers, whether two
findings go to Jason, what a family sees when the read fails, and a clash
between a run mark and a later register mark. One is for App Overwatch and
five for Jason.

- **Who signs it off:** Jason's answer: "B: Overwatch, after two reviewers
  pass it" (Q3.5, OW27-23, OD-2026-11-21-006, `docs/current/OWNER_DECISIONS.md:1314`);
  the recorded ruling reads "after two adversarial reviewers pass it"
  (`:1501`). Reading that Overwatch as App Overwatch, which holds this lane,
  comes from the lane brief, not the record. INFERRED. The
  option's con, as shown to him: "What minors' data the homes show is settled
  without you reading it" (`:1312`). FN-1 starts after that sign-off.
- **Code read at:** `main` `f8963ecb06b8aa9ec52093a2e2ccd034f3ad6b3c`. Every
  `file:line` below is at that commit. (Earlier versions read `348e126d`.
  Between the two, seven of the files named here changed. In
  `sessionRunAthletes.ts`, the run's athletes route (W4 item 7, a late tap,
  2.1) and `OWNER_DECISIONS.md`, cited lines moved and were re-pinned. In
  `sessionStaffNotes.ts`, `apply-migrations.yml` and `ACTIVE_WORK.md`, every
  change is below the lines cited here; `apps/web/package.json` is named, not
  cited by line, and the search it appears in was re-run at this commit.) Paths under `apps/web/` are given in
  full at least once; elsewhere a cite may use the file name alone.
  Migrations are under `infra/azure/`.
- **Labels:** OBSERVED (read in the code or the record, with file:line),
  INFERRED (my reasoning past what was read), UNVERIFIED (not checked).
  Nothing here was run: no route, test, database or screen. Every OBSERVED
  claim is a code read, not runtime evidence.
- **Words:** "staff" means coach, organization admin and admin, as the code's
  `STAFF_NOTE_ROLES` does (`apps/web/src/server/pilot/sessionStaffNotes.ts:74`).
  The "coach line" is the line those three see. The roles named `staff` and
  `volunteer` are written "staff-role and volunteer accounts".
- **Public repository:** counts and roles only; no member names or record
  details.

## 1. The rulings this review applies

OD-2026-11-21-006 is RECONSTRUCTED: copied by script from Backbone's card file
(`OWNER_DECISIONS.md:1225`). Its ruling is the "Jason's answer" lines
(`:1501`); the notes under each answer are Backbone's, not Jason's words.

| Ruling | What it says | Where |
|---|---|---|
| OD-2026-11-19-009, Q12 (RECONSTRUCTED) | "A: on every home; parents see only their own child"; affects "Navigation map; FUTURE lane with a privacy review". The entry itself says "Ruling: none by this entry" | `OWNER_DECISIONS.md:2538`, `:2571` |
| OD-2026-11-21-006, Q3.1 (OW27-19) | Jason: "C: Either one". The card's cons: B "May still show someone after they have gone home (INFERRED: the register has no end time)"; C "Has B's may-still-show problem". Backbone's note: "The card's con stands for the build to handle" | `:1263-1264`, `:1266`, `:1267` |
| Q3.2 (OW27-20) | Jason: "A: Own child's line only (Recommended)"; option text "A line for each of their own children on the floor now; nothing about anyone else." Option B (class and start time) not chosen | `:1275`, `:1278` |
| Q3.3 (OW27-21) | Jason: "A: Names of everyone on the floor (Recommended)"; option text "Names of all athletes on the floor now. Adds no new access." Con on the chosen option: "Names on a screen others may see over a shoulder" | `:1287`, `:1290` |
| Q3.4 (OW27-22) | Jason: "A: A line about themselves only (Recommended)"; option text "Their own status; nothing about others." Option B (a count) not chosen | `:1299`, `:1302` |
| Q3.5 (OW27-23) | Jason: "B: Overwatch, after two reviewers pass it" | `:1314` (Backbone's note `:1315`) |
| Not attendance | The card's "Today's rule" line (card text): "a run-presence mark is not attendance (CT-13, ATTENDANCE_PRECEDENCE.md); this line is not an attendance figure" | `OWNER_DECISIONS.md:1258`; `docs/current/ATTENDANCE_PRECEDENCE.md:146-160` |
| OD-2026-10-07-008, ruling 1 | "checked-in athletes' initials and session milestones go only to a gym TV paired with a code. The public no-sign-in address shows today's classes and a head count only." | `OWNER_DECISIONS.md:8713` |
| OD-2026-10-07-008, ruling 3 | "A guardian link goes dormant automatically when the athlete reaches 18, for every read and every consent change." | `:8715` |
| OD-2026-10-04-010 | "an athlete with no date of birth on file is treated as a minor" (an adult-pathway ruling). In code, `isMinor` treats an unknown date of birth as a minor (`apps/web/src/lib/minorAge.ts:47-54`) and the guardian rule uses it (`apps/web/src/server/pilot/guardianAccess.ts:41-48`) | `OWNER_DECISIONS.md:10646-10649` |
| OD-2026-10-11-007 | Jason: "lets make it coaches to whole gym". Overwatch's reading ("his words govern"): "a coach of a gym can read and act on every athlete of that gym ... nothing changes for athletes, parents, the platform owner or any other role" | `OWNER_DECISIONS.md:7924`, `:7926` |
| Kernel floor | "Minors' privacy, role gates and organization boundaries are untouched. Nothing false ships: ... an unknown value never looks complete or zero." | `AGENT_KERNEL.md:104-107` |
| L1 rule (this brief; W4_SIZING) | No new warnings, gates or disclaimers for minors | `W4_SIZING.md:134-135` |

Other rulings that bear on the line:

| Ruling | What it says | Where |
|---|---|---|
| OD-2026-10-12-006 | "an athlete or parent can check in as Present on the day of the class only. A self check-in never replaces a coach or admin mark. Absent and Excused are staff only." | `OWNER_DECISIONS.md:7798` |
| OD-2026-10-21-004, rulings 1 and 2 | A "here" tap flips an Absent or Excused register mark to Present; untapping removes the register mark the tap created "only if nobody changed it since" | `OWNER_DECISIONS.md:6035-6036` |
| OD-2026-10-22-001 (Overwatch's application, not Jason's words; RECONSTRUCTED for the applications) | "a cancelled class's attendance stops counting (rows kept, staff still see them)" | `OWNER_DECISIONS.md:5974` |
| OD-2026-10-12-024 | "a guardian sees the coach's notes and their own replies and not the other guardian's replies" | `OWNER_DECISIONS.md:7540` |
| OD-2026-10-05-024, ruling 4 | "Co-guardians see each other's consent status only ..., nothing more." | `OWNER_DECISIONS.md:9398` |
| OD-2026-11-17-009, ruling 3 (OW25-35 A; RECONSTRUCTED) | When a member's medical restriction cannot be read, "the member's screens and the parent's Safety page" show "one neutral line, "Medical restriction: could not be checked just now; your coach can see it", with no warning colour and nothing blocked ... This is the owner's direction that RULES s1 allows." The card put it to Jason because of "Your rule against new warnings" | `OWNER_DECISIONS.md:3328`; card `:3265-3272` |
| OD-2026-10-06-024, ruling 1 | "An active hold blocks nothing at check-in or drill assignment; staff see a warning in both places." | `OWNER_DECISIONS.md:8957` |
| OD-2026-10-17-014 | "the app has no age rule on staff roles (coach, staff, volunteer, admin)" | `OWNER_DECISIONS.md:6899` |
| OD-2026-09-28-005 | the platform account sees "de-identified, aggregate data across gyms and never an individual athlete's file" (option A, chosen) | `OWNER_DECISIONS.md:16054-16057` |
| OD-2026-11-19-007, ruling 2 (OW25-53 A; RECONSTRUCTED) | "the gym admin sets the tablet sign-out time in gym settings"; in code one of 15, 30, 60, 120 or 240 minutes, default 60 (`apps/web/src/shared/tabletIdle.ts:11-13`) | `OWNER_DECISIONS.md:2675` |
| OD-2026-11-20-001, OW27-12 A (RECONSTRUCTED) | Approved TV words: "Nobody is marked here yet today." ("it counts I'm here and the coach's register") | `OWNER_DECISIONS.md:1897`, `:1900` |
| OD-2026-09-28-008 | "offline storage stays parked"; restated in Backbone's note on OW27-34 A: "Offline storage on the device stays parked" | `OWNER_DECISIONS.md:15973-15975`; `:1466` |
| OD-2026-11-23-006 | "no pain-report notes on the class screen; coaches read them on the coach home" | `OWNER_DECISIONS.md:863` |
| OD-2026-10-17-008, ruling 1 | "the gym TV keeps showing only who is present, by initials" | `OWNER_DECISIONS.md:6997` |
| OD-2026-09-30-003, G8 | "overwatch answers technical, how-to and scope questions; product intent, design, safety, minors' privacy and spending go to Jason" | `OWNER_DECISIONS.md:15070-15072` |
| OD-2026-10-13-013 | "Overwatch and lanes apply a standing ruling to every case its words or plain principle reach, tell him in one line, and do not ask again; when he picks against the recommendation the cost is stated once in that exchange and what he chose is built" | `OWNER_DECISIONS.md:7331` |
| OD-2026-11-21-006, OW27-32 A | Jason: "A: Yes, on this page only (Recommended)"; the option text said counting open-gym marks on the stopped-coming page "Departs from the 10-13 note, so it needs your ruling". The 10-13 note (Overwatch's): a run mark "feeds NO attendance report, reconciled view, board or grant figure" | `OWNER_DECISIONS.md:1437`, `:1440`; note in `infra/azure/pilot_slice_postgres_session_run_athletes_migration.sql:29-32` |
| OD-2026-11-21-007, OW27-43 A (RECONSTRUCTED) | Status words for the staff-only Athlete Safety page (`apps/web/app/coach/athlete-safety/page.tsx:536`, coach and admin) went to Jason ("those words are yours", said of the words for "no hold" and the injury count); the option he chose also set the not-read words, "Hold not read yet" and "Injury reports not read yet" | `OWNER_DECISIONS.md:1193`, `:1197`, `:1201` |
| OD-2026-10-01-002, item 2 (with OD-2026-10-01-001) | "What an athlete sees when the training-hold check fails: his own wording." Asked A ("We could not check your training status just now. Ask your coach before you train."), B (nothing) or C (his own words): "**C.** The line is "Talk to your coach about today's training."" OD-2026-10-01-001 had marked this question his: "One question inside it is his" | `OWNER_DECISIONS.md:14029-14033`; `:14208-14212` |
| OD-2026-10-08-003, R2 and PLAN-3 (RECONSTRUCTED) | "platform_owner is removed from the six gym routes (... session-script runs ...)", on every verb in those files | `OWNER_DECISIONS.md:8528-8529` |

**On G8 and Q3.5 B.** G8 sends minors'-privacy questions to Jason. Q3.5 B is
later and is about FN-0: the card asks "Who signs off the privacy review
(FN-0)" (`OWNER_DECISIONS.md:1307`), Jason answered "B: Overwatch, after two reviewers pass it"
(`OWNER_DECISIONS.md:1314`) with the con above in front of him (`:1312`), and the recorded
ruling names FN-0 (`OWNER_DECISIONS.md:1501`). I read Q3.5 B as governing this review and
one of its questions, whether two findings go to Jason (FN0-Q4). Five are
put to Jason, each because its recommended answer narrows one of his
answers or the record sends that kind of question to him: a register mark
on a cancelled class (FN0-Q1, which narrows Q3.1 C for families through an
Overwatch application, not his words); the words of the line, including
what a register-only mark is called and from when it counts (FN0-Q2),
because "What a screen looks like and how it flows is decided by Jason with
the lane doing the work" (the kernel's own rule, `AGENT_KERNEL.md:87-88`, in
its section headed with OD-2026-10-02-004, `:76`), and
the start time narrows his C for a case his card did not show; what "every home" means
(FN0-Q3, the record pointing both ways); the family's words when a check
fails (FN0-Q5, a new line on minors' screens: the L1 rule bars new
warnings, gates or disclaimers, and RULES section 1 adds "unless the owner
directs it", `W4_SIZING.md:136-137`, as OW25-35 shows); and a case where two of his rulings pull
different ways (FN0-Q6). The brief named App Overwatch for the words and
the register-only case; App Overwatch's check sees that these reach him and
are not already ruled. Questions for
Jason are asked in this lane (OD-2026-10-03-018; and Overwatch's applied note
on OD-2026-11-24-001, `OWNER_DECISIONS.md:807`). If App Overwatch reads its
own question as product intent under G8, or as narrowing one of Jason's
answers, it is asked of Jason in this PR too. This routing departs from the
brief, which says to propose the words of the line and the register-only case
"as questions for App Overwatch". If App Overwatch holds the brief's routing,
it may answer FN0-Q1 and FN0-Q2 itself in this PR, but only with an option
that narrows none of Jason's answers (FN0-Q1 C; for FN0-Q2, the words with
B's timing, the refresh rate staying with Jason); a pick that narrows one goes to Jason. FN0-Q1 rides with FN0-Q2
because both are about which register marks count. INFERRED.

**On OD-2026-10-13-013 ("asked once, ruled once").** It has a standing ruling
applied to every case its words or plain principle reach, without asking
again, and "when he picks against the recommendation ... what he chose is
built". Jason picked Q3.1 C ("either record counts as on the floor", the
recorded ruling, `:1501`) and Q3.5 B against the recommendation. So this
review recommends building C as chosen: a register-only mark shows as "on
the floor now", with the card's con (after they have gone home) as he
accepted it. It recommends three narrowings of Q3.1 C, each for a case the
card did not show, and each goes to him: a present mark on a cancelled class, for families
(FN0-Q1); a register-only mark the family wrote, before its class starts,
so the line does not say a child is on the floor before they arrive (FN0-Q2,
F2); and a run mark the register later set Absent or Excused (FN0-Q6, F16).
Nothing he has not chosen reaches a family in the meantime: FN-1 builds each
case as its own condition and serves staff only until FN-2 opens its parent
and athlete branches, and FN-2 and FN-3, the first PRs that show the line,
ship after he has answered (section 4). Until FN0-Q3 is answered, three
homes get no line, a temporary narrowing of Q12 A if "every home" reaches
them (section 4). OD-2026-10-10-007 records his complaint about questions
that "slowly adds constrainsts" (`OWNER_DECISIONS.md:8034`); each of the
three is put once, each with the option that builds C as chosen. Narrower words are an option put to him, not a recommendation
(FN0-Q2). Where a ruling's plain
principle may already reach a case, the question says so (FN0-Q5, FN0-Q6).
INFERRED.

**Not read:** the research finding `findings/2026-11-19-online-gym-as-a-room.md`,
which OD-2026-11-19-007 cites for the line (`OWNER_DECISIONS.md:2665`). A
search of this repository found no copy; a search of `docs/research/` found no
file on the floor line.

## 2. The two sources, as the code has them

### 2.1 A "here" mark in a running session (`pilot.session_run_athletes`)

- **Live means `run_state = 'in_progress'`.** A run has `run_state`,
  `started_at` and `ended_at`
  (`infra/azure/pilot_slice_postgres_session_run_state_migration.sql:38-40`),
  one of `in_progress`, `completed`, `abandoned` (`:60-62`), and at most one
  live run per coach (`:128-130`). OBSERVED.
- **A live run ends** when the coach ends it, or is settled as `abandoned`
  once nothing on it has been saved for 3 hours
  (`apps/web/src/server/pilot/sessionScriptRuns.ts:121-153`; Jason's "A: Yes,
  after 3 hours (Rec.)", OD-2026-10-21-001 D2, `OWNER_DECISIONS.md:6087`).
  OBSERVED. **The close is lazy.** It runs only before certain calls: the
  coach's own live lookup, a start, the two history reads, and in `gymTvs.ts`
  the paired TV's read, the Paired TVs list and a send to a TV
  (`sessionScriptRuns.ts:146-152`). A search of `apps/web/src`,
  `apps/web/app`, `apps/web/scripts`, `scripts/` and `.github/` found the
  close (`closeIdleSessionRuns`) called, outside database tests, only
  through its wrapper `sweepIdleRuns` (defined at `:322`, calling it at
  `:324`), whose non-test callers are in
  `sessionScriptRuns.ts` (`:343`, `:457`, `:790`, `:837`) and
  `apps/web/src/server/pilot/gymTvs.ts` (`:200`, `:416`, `:689`).
  A failed close is logged and swallowed (`sessionScriptRuns.ts:322-335`).
  OBSERVED. So a run nobody opens can stay `in_progress` long past 3 hours
  (before the close existed, one sat 29 hours, `:115-119`), and a line that
  reads `run_state` alone would show its marked athletes on the floor all that
  time. INFERRED. See F13.
- **Who writes:** only the coach delivering the run, only while it is live,
  with an active staff membership and reach to the athlete
  (`apps/web/src/server/pilot/sessionRunAthletes.ts:92-120`). A tap kept in
  the coach's open page while the wifi was down can be sent late; the mark
  then records the tap's time, never before the run began, and on a tied
  session the register treats it as a tap made then (W4 item 7,
  `sessionRunAthletes.ts:69-80`; at most a day late,
  `runs/[runId]/athletes/route.ts:24-29`, `:60-61`). A mark taken
  back keeps its row with `removed_at` set (`sessionRunAthletes.ts:165-171`); a standing mark has
  `removed_at is null` (`:256`). OBSERVED.
- **Who reads today: staff only, and a source-scan test is written to fail
  otherwise (read, not run).** The module says
  "Athletes, parents, the board and the platform owner have no read of this at
  all" (`:42-44`). The privacy registry puts `session_run_athletes.athlete_id`
  in the `organization` tier: "Athletes, guardians, the board and
  platform_owner have no read of it ... this list, its run and who else was in
  it stay staff only" (`apps/web/src/server/pilot/privacyTiers.ts:557-580`).
  The staff route says the same
  (`apps/web/app/api/pilot/session-scripts/runs/[runId]/athletes/route.ts:31-34`).
  `apps/web/src/server/pilot/sessionRunPresenceStaffOnly.convention.test.ts`
  fails if any route under an athlete, parent, guardian, family, board,
  public, platform, wall or kiosk path reaches the table (`:160-168`), and
  allows only a fixed list of files to reach it (`:142-145`). The table is on
  the public-surface denylist (`privacyTiers.ts:723-724`). OBSERVED. See F1.
- **Not attendance.** "SESSION DETAIL, NOT ATTENDANCE"
  (`infra/azure/pilot_slice_postgres_session_run_athletes_migration.sql:26`;
  `sessionRunAthletes.ts:19-27`). On a session tied to a class, the same tap
  also writes an ordinary present mark on that class's register
  (`sessionRunAthletes.ts:206-211`; `apps/web/src/server/pilot/schedulerDb.ts:783-794`),
  except when the class is cancelled or the marking coach does not run it
  (`apps/web/src/server/pilot/sessionRunClass.ts:88`, `:122-126`). An untied
  (open gym) session writes no register mark (`ATTENDANCE_PRECEDENCE.md:157-158`).
  OBSERVED.

### 2.2 A present mark on today's register (`pilot.scheduler_attendance`)

- **One row per class and athlete**, status `present`, `absent` or `excused`,
  with a `checked_in_at` and no end time
  (`infra/azure/pilot_slice_postgres_scheduler_tables_migration.sql:84-93`).
  The class itself has `start_at` and a non-null `end_at` (`:15-16`). OBSERVED.
- **Staff write it for any class that is not cancelled.** The coach running
  the class, the cover, the scheduler or an admin marks the register
  (`apps/web/app/api/pilot/scheduler/route.ts:1411-1413`; OD-2026-10-07-008
  ruling 4); a cancelled class is refused (`:1439-1441`). A search of the
  route for `gymDayIso` finds only the family check at `:1432` (and the
  import); the staff branch (`:1411-1413`) shows no day check, and nor do the
  helpers it calls (`resolveRegisterMark`, `scheduler/route.ts:296-314`, then
  `apps/web/src/server/pilot/access.ts:651-688`, both read). `checked_in_at`
  is the server's time of the write (`scheduler/route.ts:1449`, `:1460`). OBSERVED. So a coach
  marking an earlier class today writes today's time. INFERRED.
- **An athlete or a parent may also write it**, for a class the athlete is
  registered to, on the class's own gym day, `present` only
  (`scheduler/route.ts:1396-1436`; OD-2026-10-12-006), and it never
  overwrites a staff mark (`schedulerDb.ts:692-730`). The athlete does this
  from the "I'm here" card on Today
  (`apps/web/components/AthleteWorkspace.tsx:3270-3275`). OBSERVED. So a
  present mark can be written in the morning for an evening class, before the
  athlete has left home. INFERRED from the same-day rule, which checks the day
  and not the hour.
- **Families already receive the marker's role and the method.** The family
  read sends each of their own register marks, except any on a cancelled
  class (`familyView`, `scheduler/route.ts:597-618`, filter at `:617`; also
  Overwatch's application, "past cancelled classes drop off parent and
  athlete lists", `OWNER_DECISIONS.md:5975`), with `status`, `method`,
  `checked_in_by_role` and `checked_in_at`, leaving out only the marking
  account and the note (`scheduler/route.ts:569-582`, applied at `:749`;
  scoped at `:678-697`). A search of `apps/web/components` found no screen
  that shows `checked_in_by_role`. OBSERVED.
- **The public wall reads this source only** (not run marks), as
  `count(distinct athlete_id)` of present marks whose `checked_in_at` falls in
  the gym day, leaving out deleted athletes and cancelled classes
  (`apps/web/src/server/pilot/wallDisplayDb.ts:86-119`). OBSERVED.

### 2.3 What already shows presence, and to whom (OBSERVED)

| Surface | Who | What | Where |
|---|---|---|---|
| Public wall `/api/pilot/wall` | anyone, no sign-in | today's classes; a head count per class and in total; no person, no initials, no key | `apps/web/app/api/pilot/wall/route.ts:20-35`; `apps/web/src/server/pilot/wallDisplay.ts:462-485` |
| Paired gym TV `/api/pilot/tv/session` | a TV paired with a code (the route and its gate as the code's comments describe them, `wallDisplay.ts:444-449`; the route file was not read) | initials (or a consented name) of today's present marks, newest first, up to 18, and session milestones (`marquee`, `wallDisplay.ts:458`) | `wallDisplay.ts:444-460`, `:545-558`; `ON_FLOOR_MAX` `:491` |
| Coach "who is marked today" | coach, organization admin, admin | every mark today across the gym's live roster, from CT-13's reconciled view | `apps/web/app/api/pilot/coach/attendance-today/route.ts:12-13`, `:17-21`, `:49-53`, `:90-92` |
| A run's marks by run id | coach, organization admin, admin | the names marked on that run, for the gym's live athletes | `runs/[runId]/athletes/route.ts:63-79` |
| Finished runs | coach, organization admin, admin | who was marked on each settled run | `apps/web/app/api/pilot/session-scripts/runs/route.ts:69-72` |
| Coach home live panel | the coach running the run | "Session in progress" and "Athletes Present" for their own run | `apps/web/components/CoachWorkspace.tsx:1325-1326`, `:3296` |
| Parent Hub attendance list | parent, own linked minor children | each register mark for the child on screen, dated by the class | `apps/web/components/ParentHub.tsx:1276-1298`; family read `scheduler/route.ts:569-582`, `:678-686` |
| `/schedule`, family view | parent and athlete, own marks | each register mark with its class, its status, "via" the method (parent, coach, admin, walk-in or self check-in, `apps/web/src/shared/attendanceMethodWords.ts:8-14`) and the time of the mark; "Records could not be loaded just now." on a failed read | `apps/web/app/schedule/page.tsx:1554-1558`, `:1591-1597` |
| Athlete "I'm here" | the athlete | their own check-in for today's class | `AthleteWorkspace.tsx:3270-3275`; `scheduler/route.ts:688-697` |

A search of `ParentHub.tsx` and `AthleteWorkspace.tsx` for "on the floor",
"floor now" and "here now" found no live line on either home. The matches are
the athlete Floor tab, code comments, and one sign-in message
(`AthleteWorkspace.tsx:3563`, "tell a coach you are on the floor"). OBSERVED,
search only.

## 3. Findings

**F1. Something derived from run marks reaches roles that read none today,
by Jason's newer answers.** Today run marks are staff only (2.1). Under Q3.1 C
a run mark alone puts a person on the floor, and Q3.2 A and Q3.4 A give the
parent and the athlete a line about that person. So the line would let a
parent and an athlete learn one fact derived from a run mark (from FN-2,
which opens the read's family branches, section 4): "marked here in a
running session, yes or no". For a session tied to a class the family often
already learns it through the register copy (2.1); when the copy is skipped,
or the session is untied, the fact is new to the family. OBSERVED (the
reads), INFERRED (the effect). A count that includes run marks on the board or
platform owner's home would also depart from Overwatch's 10-13 note that a run
mark feeds no "board or grant figure", which OW27-32 treated as needing
Jason's ruling (section 1); Backbone's note on his answer there keeps "no
attendance figure, report, board or grant figure changes"
(`OWNER_DECISIONS.md:1441`). That is FN0-Q3.
- **The authority the code cites.** For staff-only, the module, the registry,
  the migration, the convention test and the staff route cite OD-2026-10-10-003
  items 3 and 4 (`sessionRunAthletes.ts:44`; `privacyTiers.ts:574`;
  `infra/azure/pilot_slice_postgres_session_run_athletes_migration.sql:35-39`;
  `sessionRunPresenceStaffOnly.convention.test.ts:1-4`; `runs/[runId]/athletes/route.ts:34`); the
  registry, the migration and the test also cite OD-2026-10-11-007. OBSERVED.
  OD-2026-10-10-003's items rule that "A coach's own session note is staff
  only" and that an admin may withdraw a departed coach's capacity note
  (`OWNER_DECISIONS.md:8145-8146`); neither names run marks. OBSERVED.
  OD-2026-10-11-007 is Overwatch's reading of Jason's "lets make it coaches to
  whole gym" (`:7924`, `:7926`); its "nothing changes for ... parents" reads to
  me as describing that change only. INFERRED. A search of
  `OWNER_DECISIONS.md` for F-067, `session_run_athletes`, "who is here",
  "run-presence" and "staff only" found no ruling that keeps a run mark from
  the athlete or the parent. So, by my reading, the staff-only rule is in
  code, and the newer answers (OD-2026-11-21-006) govern: **not a CONFLICT**.
  INFERRED. The OW27-19 card told Jason only that a run mark "is not
  attendance" (`:1258`), not that it is staff-only today; whether that goes to
  him is FN0-Q4.
- **Recommendation for the read (FN-1, with its family branches opened by
  FN-2):** only that yes/no leaves the server for a family reader, for their own child or themselves; the run, its coach, its
  class, its times, and who else is in it stay staff only, as the registry
  note says. That holds for what is sent; a family who watches the line
  change can still tell roughly when a run-only mark began and when the run
  ended (F14). FN-1 adds its staff read to the convention test's lists
  (check 7) and leaves the family wording as it is, since it serves families
  nothing yet. The PR that opens the family branches (FN-2), naming
  OD-2026-11-21-006, changes the module comment
  (`sessionRunAthletes.ts:38-44`), the registry entry
  (`privacyTiers.ts:557-580`), the staff route comment
  (`runs/[runId]/athletes/route.ts:31-34`) and the convention test's family
  rule, so none of them claims a family read before one exists. The test
  carries a minors'-privacy guard, so it is narrowed, not dropped: it should
  still fail for any family, board, platform or public route that reaches the
  table, except the one floor-line read. Its audience pattern
  (`sessionRunPresenceStaffOnly.convention.test.ts:161`) keeps `wall` and
  `kiosk` and should add `tv`: `/api/pilot/tv/session` does not match it
  today, and the paired TV is held to initials (OD-2026-10-07-008 ruling 1,
  `OWNER_DECISIONS.md:8713`). The floor-line read should be shown to
  return only the yes/no to a family and nothing at all to a board,
  platform-owner, staff-role or volunteer caller (any count Jason rules under
  FN0-Q3 comes from its own read) ("Do not
  weaken authorization, organization isolation, safeguarding
  ... merely to make a task pass", `AGENT_KERNEL.md:546`). The table stays on
  the public-surface denylist (`privacyTiers.ts:723-724`).

**F2. A register mark has no end time, and can be written before arrival or
long after the class.** (2.2) A present mark is never closed. A family mark
can be written hours before the class. A staff mark for an earlier class,
written today, carries today's `checked_in_at`. INFERRED from the reads. A
line that counts "a present mark with `checked_in_at` today", as the wall does
(`wallDisplayDb.ts:91-92`), would show a person on the floor all day: after
they leave (the card's con, `OWNER_DECISIONS.md:1263-1264`), and also, by my
reading of 2.2, before they arrive and for a class held on another day. That
is more than the record says (kernel floor, `AGENT_KERNEL.md:105-107`). Jason
chose C with the after-they-leave con in front of him (`OWNER_DECISIONS.md:1266`). The
before-arrival case was not on his card; FN0-Q2 puts it to him with the
line's words (recommended: a mark the family wrote counts from its class's
start). A child's own tap can also stand for a class they never come to: the
server checks only the gym day (`scheduler/route.ts:1427-1435`), and no
adult confirms it. INFERRED. The other-day case is
not part of that con, and is handled below.
- Whatever the answer, **"today" should be the class's gym day, not the
  mark's**: CT-13's view keys on the class's `start_at` in gym time
  (`ATTENDANCE_PRECEDENCE.md:140-144`), and the Parent Hub was fixed for this
  exact trap ("THE DATE IS THE CLASS'S, NOT THE MARK'S", `ParentHub.tsx:1276-1282`).
  Recommendation.

**F3. "Every home" names more homes than the answers cover.** The signed-in
landing pages are, by role: platform owner, organization admin and admin,
coach, athlete, parent, board, and one shared page for staff-role and
volunteer accounts (`apps/web/src/shared/pilotRoleRouting.ts:20-56`).
OBSERVED. Q3.2 to Q3.4 say what parents, coaches and admins, and athletes
see; nothing says what the board, the platform owner, or staff-role and
volunteer accounts see. Their limits today:
- board: "Counts only, floored by k-anonymity ... never a row, never a name"
  (`privacyTiers.ts:81-87`); the scheduler read refuses the board outright
  (`scheduler/route.ts:707-709`);
- platform owner: no athlete ids, no names, across organizations
  (`privacyTiers.ts:73-79`), and "never an individual athlete's file"
  (OD-2026-09-28-005); taken off the session-script runs routes
  (OD-2026-10-07-011 ruling 2, `OWNER_DECISIONS.md:8646`; repeated in
  OD-2026-10-08-003 R2), a card that cited Jason's "platform for platform
  gym for gym" (his words in OD-2026-10-02-013, `:12291-12292`, about research
  shelves; applied in OD-2026-10-02-015 D3, `:12204-12206`; quoted at
  `:8638`); and kept from
  the board's compliance and escalation summaries (OD-2026-10-05-006, F-003,
  `:9742-9745`);
- staff-role and volunteer accounts: "hold no athlete-scoped or
  administrative surface" (`pilotRoleRouting.ts:51-52`); the run read admits
  only coach, organization admin and admin (`runs/[runId]/athletes/route.ts:52`,
  `:66`; the staff set its helper uses, `sessionStaffNotes.ts:74`, `:121-131`).
OBSERVED. A names line on any of those homes would be new access
(INFERRED). A count is
smaller, but not free:
- the public wall's count has no floor (`wallDisplay.ts:607-632`;
  OD-2026-10-07-008 ruling 1 allows "a head count"), but it serves only the
  configured default gym (`wall/route.ts:30-32`, `:50-52`;
  `apps/web/src/server/pilot/env.ts:40-41`), so no other gym's count is
  public. Whether the default gym is the pilot gym is UNVERIFIED: the setting
  is a deploy secret (`.github/workflows/deploy-production.yml:778`);
- a board count must clear a floor of 5, "never a small real number"
  (`privacyTiers.ts:85-86`; `ORGANIZATION_ROLE_MODEL.md:109-113`;
  `apps/web/src/server/pilot/boardSummary.ts:5`). That floor is a repo
  contract and code, not an owner ruling: a search of `OWNER_DECISIONS.md`
  for "k-anonym", "BOARD_MINIMUM", "cohort size", "minimum cohort",
  "insufficient" and "aggregate only" found no ruling that sets it. In code
  it gates the board's figures, and the two platform routes' own comments say
  every metric they show the platform owner is gated by it
  (`apps/web/app/api/pilot/platform/gym-summary/route.ts:28-33`;
  `apps/web/app/api/pilot/platform/overview/route.ts:40-46`; comments read,
  code path not traced); `boardSummary.ts:72-73` wants any other board
  aggregate to hold "this same floor rather than inventing a second, weaker
  one". The board's figures are
  rolling 30-day or chosen-window ones (`boardSummary.ts:203-206`), not a
  live count, and they read athletes, training sessions, goals and coach
  reviews (`boardSummary.ts:211-246`), not the class register: the board is
  refused the scheduler read (`scheduler/route.ts:707-709`) and the
  attendance summary (`apps/web/app/api/pilot/scheduler/attendance-summary/route.ts:48`,
  role gate `:58-65`).
  On their signed-in home, staff-role and volunteer accounts see no count
  today (the page's one fetch is announcements, `apps/web/app/workspace/page.tsx:85`); the public wall's count is open to anyone for the default gym.
OBSERVED. Q12 A puts the line "on every home" (`OWNER_DECISIONS.md:2538`;
repeated as already ruled on the card, `:1258`). The research Q12 came from
(the App Scrub) points both ways. Its stage 3 uses "the three homes" as the
scope of one fix (AS-3: "outside the three homes",
`docs/research/app-scrub-2026-11-19/2026-11-19-app-scrub-stage-3.md:67`,
`:105`) and names them as the coach, athlete and parent home files
(`:194-196`, `:206`; also `2026-11-19-app-scrub-stage-1.md:11`); it adds the
board once (`stage-1.md:528`). Its stage 1 also says "Sign-in sends each role to one
home", naming the staff and volunteer page and the platform owner's page
among them (`stage-1.md:47`; `:334`, `:347`). OBSERVED. The routing code
cites an "owner decision, Operations V1 2026-08-21: every role lands in its
operational work" (`pilotRoleRouting.ts:29-30`); a search of
`OWNER_DECISIONS.md` for "Operations V1", "operational work" and "lands in
its operational" found no such entry, so that is UNVERIFIED. More that bears
on it:
- The Q12 answer is the App Scrub file's quotation of his answers to its
  cards, recorded in a RECONSTRUCTED entry (`OWNER_DECISIONS.md:2527`,
  `:2569`). OBSERVED. That the words "on every home" are the card's option
  text, not his own typing, is INFERRED from that.
- Q12's row says it affects the "Navigation map" (`:2538`); the Backbone
  Overwatch 25 note (OD-2026-11-19-007) has the job-bar shell lane (AS-4)
  wait on Q11 and Q12 "if they change the shell" (`:2665`);
  `docs/current/ACTIVE_WORK.md:138` lists "Q12 A" among Lane U2's
  authorities; AS-4 gives "Each role" its job sections (`stage-3.md:68`),
  and stage 3 calls that shell "The shell every home depends on"
  (`stage-3.md:54`). OBSERVED. That these lean towards every role is my
  reading. INFERRED.
- His standing direction of 2026-08-16 says "the goal is every role
  (coach, athlete, admin, parent, board members, staff), not one favored
  role" (OD-2026-11-11-002, RECONSTRUCTED, `OWNER_DECISIONS.md:4592-4593`); it names no
  platform owner. OBSERVED. It bears on "every home" by analogy. INFERRED.
- On the board, a drill-library ruling (OD-2026-08-27-001, RECONSTRUCTED:
  "the wording is a lane's transcription", `OWNER_DECISIONS.md:18326-18330`)
  calls it an "oversight / aggregate-governance role, not an operational
  coaching-content role" (`:18334-18335`). OBSERVED; the words are a lane's,
  and it is about coaching content, so here it is an analogy.
- Stage 1 also says "admin has three homes" (`stage-1.md:181`), so "home" is
  not one fixed set of pages there either.
- The App Scrub's navigation map and its stage 2 file are not in this
  repository (`docs/research/app-scrub-2026-11-19/` holds stage 1, stage 3
  and a README), nor is the finding cited for Q12 (section 1).
So what Jason meant by "every home" is UNVERIFIED, and the record supports
both readings.
The sizing builds the line on four homes
(`W4_SIZING.md:551-554`). What the line shows on the other three homes (the
board's, the platform owner's, and the one staff-role and volunteer accounts
share) is question FN0-Q3.

**F4. No mark is not absence.** "A ROW MEANS A MARK. NO ROW MEANS NO MARK --
NOT ABSENCE" (`attendance-today/route.ts:33-38`); the wall has no absent row
"because on a wall those read as a public record of who did not turn up"
(`wallDisplay.ts:29-31`). OBSERVED. A coach who runs neither a session nor a
register leaves every athlete with no mark unless the athlete or a parent
checked in (the con of the card's option A, `OWNER_DECISIONS.md:1262`, which
C does not remove). INFERRED. So the line never says anyone is "not here",
"absent" or "gone home", for any role. For a parent, Q3.2 A's option text is
"A line for each of their own children on the floor now", which reads as no
line for a child with no mark. For an athlete, Q3.4 A's "Their own status"
reads as a status either way, so "not marked yet", never "absent".
INFERRED. Recommendation; the words are question FN0-Q2.

**F5. The coach line's names: the same people, sooner and in one place.** A coach
already reads every live athlete of the gym (OD-2026-10-11-007), and the
"marked today" read already returns the whole gym's marks, from CT-13's
reconciled view, to a coach
and an admin (`attendance-today/route.ts:49-53`). OBSERVED. For run marks,
today a coach finds only their own live run
(`sessionScriptRuns.ts:339-350`), reads any run's marks by its run id
(`runs/[runId]/athletes/route.ts:63-79`), and sees every run's marks in one
list only once the runs have settled (`runs/route.ts:69-72`). OBSERVED. So the
coach line shows no person a coach cannot already read; what is new is every
coach's live run marks gathered into one list while the runs are live.
INFERRED. That keeps Q3.3 A's "Adds no new access" true, provided FN-1 uses
the same gate: an active staff membership in this organization
(`staffNoteRoleInOrganization`, `sessionStaffNotes.ts:121-131`; "A coach whose
membership was ended reads nobody", `sessionRunAthletes.ts:268-271`) and the
gym's live roster. Recommendation.

**F6. The parent's scope is the guardian rule, with the 18 and deletion
rules inside it.** `guardianAthleteIds` returns only live, linked children who
are minors, an unknown date of birth reading as a minor
(`guardianAccess.ts:34-49`, `:141-147`, `:165-182`; `minorAge.ts:47-54`). Its sibling
`linkedAthleteIdsIncludingAdults` keeps adult children and is "not a guardian
read" (`guardianAccess.ts:149-163`). OBSERVED. So FN-1's parent branch uses
`guardianAthleteIds` (as the sizing plans, `W4_SIZING.md:552`), never the
sibling, never ids from the request. Then a child who turns 18 drops off the
parent's line on that gym day, and a child with no date of birth stays on it,
which is the existing rule (OD-2026-10-07-008 ruling 3 for the 18 rule; the
unknown-date-of-birth rule is the code's `isMinor`, `minorAge.ts:51-54`, as
`guardianAccess.ts:41-44` says,
which matches OD-2026-10-04-010, an adult-pathway ruling), not a new one.
Recommendation.

**F7. Q3.2 A limits the line, not the Parent Hub's existing list.** The
parent's line must not carry the class or the start time (Q3.2 B not chosen).
The Parent Hub already lists each register mark for the child with the class's
date and time (`ParentHub.tsx:1286-1298`). OBSERVED. This review does not
recommend changing that list: it predates the card, and the card asked only
about the line. Information for App Overwatch; no action.

**F8. The line and the wall count can disagree, by design.** The public wall
counts present marks over the whole gym day and never reads run marks
(`wallDisplayDb.ts:86-119`); the line reads both, and leaves out a cancelled
class only as FN0-Q1 rules. INFERRED: the wall's count can differ from the
number of names on the coach line. Neither is wrong; they count different
things, so the line should not reuse the wall's count. Information; see
FN0-Q3 (counts) and
FN0-Q2.

**F9. Only the two ruled sources.** Two other records look live and are not
sources under Q3.1 C: the athlete's own training session (open until checked
out or closed after 20 minutes of inactivity,
`apps/web/src/server/pilot/sessionAutoClose.ts:1-10`) and the wellness
check-in (`pilot.athlete_check_ins`, `sessionAutoClose.ts:33`).
OBSERVED. Nor are the other attendance records: `pilot.activity_log`, the
legacy `pilot.attendance`, and CT-13's combined view
`pilot.attendance_reconciled`, which ranks `activity_log` first and the
legacy table third and gives one row per athlete-day
(`ATTENDANCE_PRECEDENCE.md:113-120`, `:124-126`). OBSERVED. CT-13's guard test makes that
view the default for new attendance readers
(`apps/web/src/server/pilot/attendancePrecedence.test.ts:21-23`), and the
coach "marked today" read uses it (`attendance-today/route.ts:17-21`).
INFERRED: a line built on it would count sources Jason did not choose and
would show a child all day. **Recommendation:** FN-1 reads
`pilot.scheduler_attendance` joined to the class (for its day, times and
status) and `pilot.session_run_athletes`, and nothing else; adding a source
would be a new answer to Q3.1, not a build choice.

**F10. Minors' rules, checked one by one.**
- Unknown date of birth is a minor (OD-2026-10-04-010; `minorAge.ts:47-54`).
  The line itself has no age split: the answers give each role the same view
  whatever the athlete's age, and the only age effect is the guardian rule
  (F6). OBSERVED (the code), INFERRED (the reading of the answers).
- **No new warning, gate or disclaimer (L1 rule).** Nothing here asks the app
  to warn or block. One line may count as new words for families: the line
  when the read fails (F15). Words for a failed read on a family or athlete
  screen have gone to Jason, or to his design, three times before (F15), so
  whether his latest answer already reaches it is FN0-Q5, put to Jason, not
  settled on my own. Some recommendations narrow when or where
  the line shows, and each is carried by a ruling or a question: the class's
  gym day for a register mark (F2, CT-13's day rule); a register mark on a
  cancelled class for families, as the family read already does (FN0-Q1);
  a family's register mark counted from its class's start (F2, FN0-Q2 A),
  with narrower words offered to Jason in option C, not recommended; which homes
  get a line (FN0-Q3); a stale run not
  counted as live (F13, the 3-hour ruling); a later Absent or Excused on a
  tied class (F16, FN0-Q6). INFERRED.
- The public wall and the paired TV are unchanged: the line is for signed-in
  homes only, and none of it reaches `/api/pilot/wall` or `/api/pilot/tv/session`
  (OD-2026-10-07-008 ruling 1). Recommendation.
- A shared gym tablet: the tablet signs out after the idle time the gym admin
  sets (OD-2026-11-19-007 ruling 2; 15, 30, 60, 120 or 240 minutes, default
  60, `tabletIdle.ts:11-13`). OBSERVED. Recommendation: the athlete line shows
  only the signed-in athlete, the coach line shows names (the con on Q3.3's
  chosen option), and nothing from the line is kept in device storage
  (offline storage stays parked, OD-2026-09-28-008).
- A coach may be under 18 (OD-2026-10-17-014), and under Q3.3 A sees every
  name on the floor, as they already see the roster. Information; no action.
- **A sign to the child.** The OW27-20 card cites the UK children's code (a
  design reference, not US law): a service that lets a parent monitor a child
  should show the child an obvious sign (`OWNER_DECISIONS.md:1271`). Jason
  chose A; no sign was offered on the card. The athlete's own line (Q3.4 A)
  shows the athlete, when signed in, the same yes/no the parent sees.
  INFERRED: that is the nearest thing to such a sign the answers give. A
  separate notice to the child would be a new notice for minors, which needs
  Jason's direction (L1 rule; RULES section 1, "unless the owner directs
  it", `W4_SIZING.md:136-137`); this review does not recommend one.

**F11. The line should not say who marked a child.** "Who marked a child
present, and by what method, is safeguarding evidence"
(`ATTENDANCE_PRECEDENCE.md:100-101`). For register marks the family read
already sends the marker's role and the method (2.2), and the family view of
`/schedule` shows the method ("via" parent, coach, admin, walk-in or self check-in)
and the time of each mark (2.3); a search of `apps/web/components` found no
component that shows the role. The run's marker is staff only (2.1).
OBSERVED. So keeping "who marked" off the family line is a choice about the
line's words, not an existing boundary: it repeats nothing the family
already sees elsewhere and leaves the run's marker staff only. For the
parent's line, Q3.2 A's "nothing about anyone else" (`OWNER_DECISIONS.md:1275`)
already covers the other guardian's or a coach's act directly. It also
avoids the line telling one guardian what the other did. The closest ruling
is OD-2026-10-13-009:
"Athletes and parents read no mirrored audit rows", asked because one
parent's filing showed up in the family feed (`OWNER_DECISIONS.md:7396`,
`:7404`); OD-2026-10-12-024 and OD-2026-10-05-024 ruling 4 ("Co-guardians
see each other's consent status only ..., nothing more") point the same
way. Those rulings are about feeds, replies and consent, so applying them
here is an analogy. INFERRED; recommendation,
carried in FN0-Q2. Whether the existing family read should keep sending the
role and method is outside FN-0; information for App Overwatch.

**F12. A hold does not keep a child off the line.** A hold blocks nothing at
check-in (OD-2026-10-06-024 ruling 1). OBSERVED. So an athlete on a hold can
be on the floor. INFERRED. The answered line is presence: for a family, a hold, pain,
readiness or injury state on the line would go beyond Q3.2 A and Q3.4 A. For
staff, I found no ruling either way (a search of `OWNER_DECISIONS.md` for
"coach home" with hold, pain, injury, readiness or safety, and for
"presence" with hold, pain or injury, found no relevant hit but
OD-2026-11-23-006 and the mark rule OW25-48, neither about a presence line);
OD-2026-11-23-006 keeps pain-report notes
off the class screen and says "coaches read them on the coach home", which is
where the coach line goes. So for staff this review recommends presence only,
as answered, and adds no ban. The medical-stop mark `--locked` keeps its one
meaning on the line for every role (`AGENT_KERNEL.md:97-98`). INFERRED;
recommendation.

**F13. A forgotten live run would keep children on the line.** (2.1) The
3-hour close runs only before certain reads and swallows its own failure.
OBSERVED. An existing yes/no read of run marks,
`isSessionRunningForAthleteToday` (`apps/web/src/server/pilot/sessionNotes.ts:165-199`),
checks `run_state = 'in_progress'` without closing idle runs first, and counts
a live run with no marks for every athlete of the gym (`:148-152`, `:180-186`).
OBSERVED. (Another, the behaviour-report check at
`apps/web/src/server/pilot/behaviourObservations.ts:272-279`, asks only
whether a mark stands.) **Recommendation for FN-1:** close idle runs before
the read, as the coach's live lookup, a start, the history reads and the TV
calls do (`sessionScriptRuns.ts:146-152`), and also treat a run idle past the
3-hour limit as not live in the read itself, since a failed close is logged
but silent to the reader (`sessionScriptRuns.ts:322-335`), by reusing that
module's idle rule rather than restating its activity signals (which include
`pilot.session_staff_notes`, `:121-131`; a file naming that table also falls
under the convention test, `sessionRunPresenceStaffOnly.convention.test.ts:51`);
and do not reuse `isSessionRunningForAthleteToday` for any reader of the
line. This applies the 3-hour ruling; it adds no new one.

**F14. Split households (information).** `pilot.guardian_links` holds the
parent, the athlete and the relationship, and no field for a restriction on a
guardian (`infra/azure/pilot_slice_postgres.sql:449-458`; a search of
`infra/azure/*.sql` found no later `alter table pilot.guardian_links`).
OBSERVED. So every linked guardian of a minor gets the line. For an untied
session that is near-live whereabouts a guardian does not get today (F1).
INFERRED. There is a staff-only signal for the case: `pilot.athlete_release_restrictions`,
one bit meaning "restrictions apply to who may collect or contact this child
-- speak to the welfare lead"
(`infra/azure/pilot_slice_postgres_release_restrictions_migration.sql:1-10`;
in the migration list, `.github/workflows/apply-migrations.yml:112`; the
migration cites an "Owner decision, 2026-08-28" at
`pilot_slice_postgres_release_restrictions_migration.sql:9-10` that a search of
`OWNER_DECISIONS.md` for "welfare lead" and "release restriction" did not
find, so that is UNVERIFIED). Its
module keeps it from every guardian because "A restriction frequently
concerns one of the guardians" (`apps/web/src/server/pilot/releaseRestrictions.ts:21-31`).
A search of `apps/web` for "releaseRestrictions" and
"release_restrictions" found only the module, its database test,
`apps/web/package.json` and the migration runner
(`apps/web/scripts/pilot-apply-release-restrictions-migration.mjs`), so no
screen sets or reads the flag today. OBSERVED. Holding the line back from one guardian would be a new gate
(L1 rule), and the app has no way today to tell which guardian a restriction
concerns. INFERRED. Nor is ending the link always open: staff removal of a
link is refused when it is a signed-in guardian's only link, and while that
guardian's media consent is withdrawn
(`apps/web/src/server/pilot/staffProvisioning.ts:1138-1140`, `:1151-1153`).
Nor can the gym simply switch a parent's login off: the organization admin's
deactivate route admits only coach, staff, volunteer and athlete accounts,
and sends a guardian back to "the people console's link controls"
(`apps/web/app/api/pilot/admin/accounts/deactivate/route.ts:28-34`,
`:88-91`), as OD-2026-10-07-009 ruling 1 (`OWNER_DECISIONS.md:8693`, coach,
staff, volunteer) and OD-2026-11-19-025 (athletes) set it; the platform
owner's status route can (`apps/web/app/api/pilot/platform/users/status/route.ts:30-38`,
which refuses only athletes). What the organization admin can do is delete
the guardian account (`apps/web/app/api/pilot/admin/data-deletion/route.ts:28-35`,
`:52-61`; `apps/web/src/server/pilot/dataDeletion.ts:180-196`), which ends
that login; for a child who still has another guardian, the deletion does not
withdraw the child (`infra/azure/pilot_slice_postgres_data_retention_deletion_migration.sql:57-66`),
and a deleted guardian's media-consent "no" keeps restricting the child
(OD-2026-10-05-023). The organization admin can also end a login's sessions
(`apps/web/app/api/pilot/admin/accounts/revoke/route.ts:13`, `:26`), which does
not, by my reading, stop the next sign-in (INFERRED), and moving a guardian to a new login switches the
old one off only when it backs no guardian record left
(`apps/web/src/server/pilot/guardianLoginMove.ts:337-348`; reported at
`apps/web/app/api/pilot/admin/guardian-login/route.ts:46`).
OBSERVED, from a read of those routes, not a search of every path. So in
those two cases the gym's lasting lever is a deletion with retention effects,
not a switch. INFERRED. The line also carries timing. For a run-only mark
(open gym), "the line clears when the session ends" (Q3.1 A's option text,
`OWNER_DECISIONS.md:1262`), so a guardian who checks the page sees roughly
when the child was marked in and when the session ended: the pickup timing
that Q3.2 B offered ("Helps with pickup timing", `:1276`) and Jason did not
choose. Every linked guardian gets it, including one a release restriction
concerns. INFERRED. How often the line refreshes sets how closely a guardian
can time this; that is a screen-flow choice, which the kernel gives to Jason
with the lane (`AGENT_KERNEL.md:87-88`), so it is asked in FN0-Q2. This review recommends no new gate (L1 rule). Whether this, with F1, goes to
Jason before FN-2 is FN0-Q4.

**F15. A failed read must not look like "nobody".** The kernel floor says
"an unknown value never looks complete or zero" (`AGENT_KERNEL.md:106-107`).
The line joins two sources, and the idle close hides its own failure (2.1).
OBSERVED. If a read fails, "Nobody is marked ..." on the coach line, or no
line to a parent, would read as "not on the floor"; and a list built from one
source when the other failed would look complete. INFERRED. The coach home
already has words for this case: "Whether you have a session in progress could
not be checked." (`apps/web/components/CoachWorkspace.tsx:1320-1321`).
OBSERVED.
- **Recommendation:** the read fails as a whole if either source fails. The
  coach line then says it could not be checked, as the coach home already
  does. The failure text a family sees is the same whatever the cause, and
  carries no athlete id: the shared error helper can pass a message through to
  the caller (`apps/web/src/server/pilot/http.ts:174-191`), which is why the
  wall route does not use it (`wall/route.ts:59-62`).
- **What a family sees is FN0-Q5.** For families the kernel floor points to a
  line saying the read failed. The record points two ways. The Parent Hub
  already shows "Unavailable" to a parent when a read about the child has
  not loaded, failure included
  (`apps/web/components/ParentHub.tsx:1221-1223`; the comments at
  `:1125-1129` and `:1373-1375` describe the same state),
  and the family view of `/schedule` shows "Records could not be loaded just
  now." when its read fails (`apps/web/app/schedule/page.tsx:1558`); searches
  of `OWNER_DECISIONS.md` for "unavailable" and "could not be loaded" found no
  ruling behind either. But the words for a failed or empty read on a family or athlete screen
  have gone to Jason, or to his design, three times:
  - OW25-35 ("Your rule against new warnings is why it was left out, so the
    call is yours"; his A is recorded as "the owner's direction that RULES s1
    allows", `OWNER_DECISIONS.md:3265-3272`, `:3328`);
  - the athlete's failed training-hold check, a question OD-2026-10-01-001
    marked his, where he turned down "We could not check ..." and wrote his
    own line, "Talk to your coach about today's training." (`:14029-14033`,
    `:14208-14212`);
  - the chalkboard, which sits on the athlete home and the Parent Hub
    (`AthleteWorkspace.tsx:3296`, `ParentHub.tsx:1474`). His words were about
    loading: "a quote and a loading  .... under the quote"
    (`OWNER_DECISIONS.md:11295-11297`); the lane read them as "whenever there's nothing real to
    show (still loading, or the read failed)" (`OWNER_DECISIONS.md:11299-11300`); and PR #1144,
    as the entry reports it, built a gym saying with "Can't read the board
    right now." after a failed read (OD-2026-10-03-010, `OWNER_DECISIONS.md:11308-11310`). This is
    the same two homes the line goes on; the failed-read words there are the
    lane's, under his design.
  (OW27-43 sent such words to him too, for a staff page.) OBSERVED. OW25-35 A
  is the latest and covers "the member's screens and the parent's Safety
  page" (`OWNER_DECISIONS.md:3328`); whether its plain principle already reaches the line's
  failed read, under OD-2026-10-13-013, is FN0-Q5. INFERRED.

**F16. A run mark and a later register Absent can disagree, and the line has
to pick one.** Both rulings below hold as written: ruling 1 decides which mark
the register keeps, and Q3.1 C decides which records the line counts. Neither
is wrong and neither blocks the task, so this is not a CONFLICT under the
brief; but read together on one child they give the line two answers. On a session
tied to a class, the run mark stands even when the register is set Absent or
Excused after the tap; the code keeps that later register mark
(`sessionRunAthletes.ts:206-207`; for a session tied mid-way,
`sessionRunClass.ts:85-86`), as OD-2026-10-21-004 ruling 1 says: "a later
register change still wins" (`OWNER_DECISIONS.md:6035`). OBSERVED. Read
literally, Q3.1 C would still show a child the coach has since marked Excused
(for example, sent home) as on the floor. INFERRED. **Recommendation:** for a
run tied to a class, a register Absent or Excused written after the child's
run mark takes the child off the line, applying ruling 1's "later register
change wins" to the line. "After" is measured from the run mark's recorded
time, which for a tap sent late is the tap's time, as the register already
does (2.1; `sessionRunAthletes.ts:71-75`). This narrows the running-session half of Jason's
C ("Either record counts", taking in option A's "Marked here in a running
session", `OWNER_DECISIONS.md:1262`, `:1264`): the card's con the build was
left to handle is option
B's, "May still show someone after they have gone home (INFERRED: the
register has no end time)", which C's con points to ("Has B's may-still-show
problem", `OWNER_DECISIONS.md:1263-1264`), and Backbone's note limits it to
"a register mark has no end time" (`:1267`); F16 is about a run mark, not a
register mark. The recommendation rests on the kernel floor instead
("Nothing false ships", `AGENT_KERNEL.md:105`). INFERRED. So it is put to
Jason as FN0-Q6; section 4 and check 5 defer to his answer, and the line
ships after it (section 4).

## 4. What the line may show, and must never show, by role

The verdicts assume the questions are answered as recommended; a different
answer changes the rows it names. Three questions change which marks count
and narrow Jason's C: FN0-Q1, FN0-Q2's start time and FN0-Q6. No interim is
set for them. FN-1 builds each as its own condition and serves staff only:
its parent and athlete branches are refused, as for a role the read does not
serve (check 4), until FN-2 opens them, and FN-2 and FN-3, the first PRs
that show the line, ship after he has answered. So no family gets a value he
has not chosen. The staff branch shows staff nothing they cannot already
read (2.1, 2.2), whatever the three conditions hold (section 1). Until FN0-Q3 is answered,
the board's, the platform owner's and the staff-role and volunteer homes get
no line: they are outside the sized PRs (`W4_SIZING.md:553-554`), and if
"every home" reaches them this is a temporary narrowing of Q12 A.

**Which marks count, for every role.** A person counts when either:
- they have a standing mark (`removed_at is null`) on a run that is
  `in_progress` and not idle past 3 hours (F13), whatever its class's status
  (Q3.1 C), except as FN0-Q6 rules for a run tied to a class whose register
  marked them Absent or Excused after the run mark (F16); or
- they have a present register mark on a class whose gym day is today (F2),
  to the end of that gym day: a mark the family wrote from the class's start
  time, a staff mark from when it is written (FN0-Q2, recommended; under its
  option B, every mark from when it is written). A mark on
  a cancelled class counts only as FN0-Q1 rules (recommended: on the coach
  line only, as the family read already leaves it out).

Both are shown as "on the floor now" unless Jason picks other words for a
register-only mark (FN0-Q2).

Never: a deleted athlete; another organization's athlete or run; an absent or
excused mark; a run mark taken back; a settled run; a register mark for a
class on another day. The same rule feeds the coach line, the parent's line,
the athlete's line and any count (FN0-Q3), except for a cancelled class,
which FN0-Q1 splits by reader.

| Role (home) | May show | Must never show |
|---|---|---|
| Coach, organization admin, admin (coach home, admin home): the coach line | The names of every live athlete of this gym who counts, from either source (Q3.3 A). Presence only, as answered (F12). Staff gate as F5. That it could not be checked, when the read fails (F15). | Anyone the rule above leaves out. Absent or excused shown as "not here" (F4). "Nobody ..." when the read failed (F15). |
| Parent (Parent Hub) | For each of their own children who counts, a line saying so (Q3.2 A), in the words FN0-Q2 rules. Scope as F6. When the read fails, what FN0-Q5 rules. | Any other athlete: no name, no initials, no count, no id. The class, the start time, the time of the mark, the coach, the run, the room (Q3.2 B not chosen; a run mark's time is staff only today, `runs/[runId]/athletes/route.ts:74`; a register mark's time already reaches families on the schedule read, 2.2, but not on this line). A child who is 18 or over, unlinked, or deleted. Who marked the child or how (F11). A hold, pain, readiness or injury state (F12). "Not here" or "absent" (F4). A failed read shown as "not on the floor" (F15). |
| Athlete (athlete home) | Their own status (Q3.4 A, "A line about themselves only ... Their own status"): on the floor now, or not marked on the floor right now (FN0-Q2). When the read fails, what FN0-Q5 rules. | Anyone else: no name, no count (Q3.4 B not chosen), no id; not who else is in the session, nor the coach ("nothing about others", Q3.4 A). Recommended, not ruled by Q3.4 A: not the run, the class or the time of the mark, so the athlete's line carries no more than the parent's (Q3.2 A). Who marked them or how (F11). A hold or health state (F12). A failed read shown as "not on the floor" (F15). |
| Board, staff-role and volunteer accounts | Under FN0-Q3 A, the classes running now (title and times only) and no person, as far as class titles name none (FN0-Q3 A's con). Under its other options, only what Jason rules there. | Names, initials or ids (F3). Any count that includes run marks unless Jason rules it (F1, FN0-Q3). On the board's home, a number below 5. |
| Platform owner | Nothing, under FN0-Q3 A ("platform for platform gym for gym"). Under its other options, only what Jason rules there. | Names, initials or ids (F3; OD-2026-09-28-005). Any per-gym class list or count unless Jason rules it. |
| Signed out: public wall, paired TV | Unchanged: classes and counts on the public address, initials on a paired TV (OD-2026-10-07-008 ruling 1). | Any part of the line. |

**For every role:** the server cuts the response by role before it is sent;
nothing gym-wide reaches a family browser to be filtered there. The
organization and the athlete ids come from the signed-in principal and the
server's own scope, never the request, as the coach "marked today" read does
(`attendance-today/route.ts:43-44`, `:51-52`). The response is `no-store`, as
the wall and the staff read are (`wall/route.ts:56`;
`attendance-today/route.ts:90-92`), and the page keeps none of it in device
storage (F10). A family's failure text is the same whatever the cause (F15).
No athlete name or id goes to a log line: the wall logs an event name and the
error's message (`wall/route.ts:63`), so FN-1 logs an event and a code only.
Recommendations.

## 5. Checks FN-1 to FN-3 should carry (recommended, not built)

Each guard below should be seen to fail when broken (`AGENT_KERNEL.md`,
"Independent verification duties", duty 3):

1. A parent gets a line for a linked minor child on the floor, and nothing for
   a child linked to another parent, a child who is 18 or over, or a deleted
   child; a child with no date of birth is treated as a minor (F6). A parent
   whose every linked child is 18 or over, unlinked or deleted gets nothing,
   not the gym: an empty scope "matches nothing", never "undefined (matches
   everything)" (`guardianAccess.ts:135-139`).
2. A parent's and an athlete's response contains no other athlete's id or
   name and no count (Q3.2 A, Q3.4 A).
3. A family response carries no run id, mark time or "since" time, coach,
   method or marker, nor which source counted the child, run or register
   (under FN0-Q2 A or B; C shows it by design) (F1, F11), and no hold, pain, readiness or injury state
   (F12); a parent's carries no class, start time or room either (Q3.2 B not
   chosen), and an athlete's no run, class or time of the mark either
   (section 4's athlete row; recommended, not ruled by Q3.4 A).
4. A coach whose staff membership has ended, a board member, the platform
   owner, a staff-role or volunteer account, and a caller from another
   organization are refused by the line's read, not given an empty answer,
   which would read as "Nobody ..." (F15): no names, no yes/no and no count
   (F1, F3, F5). Until FN-2 opens them, parents and athletes are refused the
   same way (section 4). Any count Jason rules under FN0-Q3
   comes from its own read with its own guard.
5. For a coach-line, a parent and an athlete reader alike, and in any count,
   these do not show: a deleted athlete; a run mark taken back; a run that is
   completed or abandoned; a run idle past 3 hours that no read has closed
   (F13); a run mark on a tied class whose register later says Absent or
   Excused, if FN0-Q6 so rules (F16); a register mark on a cancelled class, except as FN0-Q1
   rules; an absent or excused
   mark; a register mark for a class on another day; an `activity_log` or
   legacy `pilot.attendance` row alone (F2, F4, F9, section 4).
6. A register-only mark is shown in the words FN0-Q2 rules, only for a class
   on today's gym day, from the time FN0-Q2 rules (recommended: the class's
   start for a mark the family wrote) to the end of that gym day.
7. `sessionRunPresenceStaffOnly.convention.test.ts`, `privacyTiers.ts`,
   `sessionRunAthletes.ts` and the staff route comment say who reads the
   derived run-mark fact (a yes/no for families, from the PR that opens the
   family branches, FN-2, F1), and the test still fails
   for any other family, board, platform, public or TV route that reaches the
   table (its audience pattern keeps `wall` and `kiosk` and adds `tv`, F1). The new read's name goes into the test's `REACHES` pattern
   (`sessionRunPresenceStaffOnly.convention.test.ts:47-48`), its module onto
   `TABLE_FILES` (`:102`) and a reach list for the "exactly" check
   (`:142-145`, lists at `:54-60`, `:66-69` and `:72-78`), and its one route onto a list of its own
   with its own role check (the `STAFF_ROUTES` check admits only the three
   staff roles, `:53`, `:170`), as `isSessionRunningForAthleteToday` is
   pinned: the test
   says it "does NOT catch a new export added to a file already on the lists"
   (`:16-17`).
8. An athlete account with no athlete id gets no line (the scheduler read
   returns no attendance rows for one, `scheduler/route.ts:689-691`); a
   request that names an athlete or an organization gets the same answer as
   one that names none.
9. The line raises no push or email event. If W4 item 2 adds a service worker,
   it does not cache the line's route. INFERRED (no finding here; a guard on
   the one read, so the line cannot leave by another path).
10. When either source fails, the whole read fails; the coach line says it
    could not be checked, never "Nobody ..."; families see what FN0-Q5 rules;
    a family's failure text is the same whatever the cause; no log line
    carries an athlete name or id (F15).
11. The homes of the board and of staff-role and volunteer accounts show
    what FN0-Q3 rules (under its option A, the classes running now, title and
    times only, from one gym's guarded read); the platform owner's home shows
    nothing under option A; none shows a name (under option A, as far as class
    titles name none), and none a count built from run marks unless Jason
    rules one.
12. A signed-out caller, `/api/pilot/wall` and `/api/pilot/tv/session` get
    nothing from the line: their payloads are unchanged (F10).

One existing guard FN-1 meets: the CT-13 test lets only listed files read
`pilot.scheduler_attendance` directly; "Anything new goes through
pilot.attendance_reconciled" (`apps/web/src/server/pilot/attendancePrecedence.test.ts:21-23`,
list at `:63`). The line is not attendance (Q3.1 card), and the combined
view would add sources Jason did not choose (F9), so FN-1 should not read the
line from `pilot.attendance_reconciled`; it reads `pilot.scheduler_attendance`
directly and is added to the test's list with that reason, or reuses a
listed reader that reads only the register. INFERRED.

## 6. Questions

FN0-Q4 is for App Overwatch; FN0-Q1, Q2, Q3, Q5 and Q6 are for Jason
(section 1, "On G8 and Q3.5 B"). Each is posted in the PR as its own comment,
headed `QUESTION FOR App Overwatch:` or `QUESTION FOR Jason:`. If App
Overwatch reads FN0-Q4, or any finding above, as narrowing one of Jason's
answers or as product intent under G8, it goes to Jason in this PR.

Every question was checked against the same sources. **Checked, not answered
in:** `docs/current/OWNER_DECISIONS.md` (OD-2026-11-21-006 cards OW27-19 to
OW27-23; OD-2026-11-19-009; the searches in section 7), `docs/research/`,
`W4_SIZING.md` section 3, the brief, this PR's comments. **Not checked:**
`findings/2026-11-19-online-gym-as-a-room.md` (cited at `OWNER_DECISIONS.md:2665`;
no copy in this repository).

**What each question holds up (INFERRED, from the sizing's PR split,
`W4_SIZING.md:549-554`).** FN-1, the read: FN0-Q1, FN0-Q6 and FN0-Q2's
start time change which marks count. FN-1 can build those three as separate
conditions before they are answered, serving staff only until FN-2; FN-2 and
FN-3 ship after (section 4), and FN0-Q4 decides whether Jason hears F1 and
F14 before FN-2. FN-2 and
FN-3, the screens: FN0-Q2 sets the words for both, and FN0-Q5 the family
words on a failed read, in FN-2. FN0-Q3 sets what the
board's, the platform owner's and the staff-role and volunteer homes show;
the sizing's screen PRs cover only the Parent Hub, the athlete home, the
coach home and the admin home (`W4_SIZING.md:553-554`), so any line FN0-Q3
adds is outside the sized PRs.

**FN0-Q1 (for Jason). Does a present register mark on a cancelled class put
a child on the line?**
Plain: if the office cancels a class after children were marked present,
are they still shown on the floor?
Why it is his: the recommended option narrows your Q3.1 C ("Either record
counts", your option's text, `OWNER_DECISIONS.md:1264`; the recorded ruling,
"either record counts as on the floor", `:1501`) for families. It follows
an application recorded in OD-2026-10-22-001 as one of Overwatch's
applications of OD-2026-10-21-005, not words of yours, and this review sends every narrowing of your answers to you
(section 1). The brief named App Overwatch for the words and the
register-only case, a person with only a register mark and so no end time
(`W4_SIZING.md:542-543`); a present mark on a cancelled class sits next to
that case rather than inside it, but it is about which register marks count,
as FN0-Q2 is, so it rides with it (section 1). If App Overwatch holds the brief's routing, it may
answer this itself, but only with C; a pick of A or B goes to you (section
1). The office can
cancel a class after it starts (`apps/web/src/server/pilot/schedulerCancelRule.ts:78-79`;
OD-2026-10-22-001), so children marked present may still be on the floor.
Overwatch's application: "a cancelled class's attendance stops counting (rows
kept, staff still see them)" and "past cancelled classes drop off parent and
athlete lists" (`OWNER_DECISIONS.md:5974-5975`); the family read already sends
no mark on a cancelled class (`scheduler/route.ts:617`). OBSERVED. A run mark
on such a class still counts while its run is live (section 4).
- **A (recommended): on the coach line, kept; for families, not shown.** Pros:
  the coach's head count keeps children who may still be there, as "staff
  still see them"; families get what the family read already gives them,
  following an application recorded with OD-2026-10-22-001 (one of
  "Overwatch's applications of OD-2026-10-21-005", as the entry's heading
  says, `OWNER_DECISIONS.md:5959`), not a new rule.
  Cons: two rules; for families it narrows your Q3.1 C read literally
  (option C), by that application; a child who may still be on the floor
  after a mid-class cancel loses the family's line, which reads as "not on
  the floor" (F15), unless a session tied to the class still has them
  marked (section 4).
- **B: not shown to anyone, as the wall does.** Pros: one rule; matches the
  wall. Cons: children marked present before a mid-class cancel drop off the
  coach's head count.
- **C: shown to everyone as any other mark.** Pros: Q3.1 C read literally.
  Cons: gives families a mark the family read withholds today; a parent may
  see a line for a class that never ran.
- Families get nothing from the read, and no screen shows the line, until
  you answer (section 4).

**FN0-Q2 (for Jason). What are the words of the line, and from when does a
register-only mark count?**
Plain: what exactly does the line say on each home? And for a child marked
on the class register but not in a live session, what is it called, and does
it show from the moment the mark is written or from the class's start?
Why it is his: "What a screen looks like and how it flows is decided by Jason
with the lane doing the work" (`AGENT_KERNEL.md:87-88`); App Overwatch has
put new words to him at its own request before, among them the TV's presence
line, "using the names already ruled" (OW27-11, OW27-12, `OWNER_DECISIONS.md:1877`,
`:1893`); and options A and C narrow your Q3.1 C ("Either record counts",
`:1264`; the recorded ruling, "either record counts as on the floor",
`:1501`), A for a case your OW27-19 card did not show. The brief named App
Overwatch for these words and the register-only case, and the sizing leaves
them to FN-0 (`W4_SIZING.md:542-543`); App Overwatch's check sees that this
reaches you and is not already ruled. If App Overwatch holds the brief's
routing, it may answer the words itself, with B's timing, leaving the refresh
rate to you (F14); a pick of A's
start time or of C goes to you (section 1).
The case the card did not show: a family's register mark can say "on the
floor now" before the child arrives. An "I'm here" tap marks one class (one
button per class, `apps/web/components/AthleteImHere.tsx:352-376`; one
request per tap, `:240-251`), and a family check-in only has to be on the
class's gym day (`scheduler/route.ts:1432`), so a morning tap for an evening
class puts the child on the line all day. OBSERVED (the code), INFERRED (the effect).
- **A (recommended): your C, with a family's register-only mark counted from
  its class's start.** "On the floor now" for either record; a register-only
  mark the family wrote (an athlete's or parent's own check-in, as the
  scheduler tells one apart: method self or parent, or an older parent mark
  by its role, `schedulerDb.ts:723-729`) counts from its class's start time to the
  end of that gym day, not from when it was written; a staff mark counts from
  when it is written, as a staff mark is staff's word that the child is
  there (INFERRED: the code lets staff mark any class that is not cancelled,
  at any hour, `scheduler/route.ts:1411-1413`, `:1497-1530`).
  - Coach line: "On the floor now: " and the names. With nobody counted:
    "Nobody is marked on the floor right now." (the shape of the TV's
    approved "Nobody is marked here yet today.", OW27-12 A). When the read
    fails: "Who is on the floor could not be checked." (the coach home's
    existing "could not be checked" form, F15).
  - Parent: "[first name] is on the floor now." for each child who counts;
    nothing for a child who does not (Q3.2 A's option text, "A line for each
    of their own children on the floor now").
  - Athlete: "You're on the floor now." or "You're not marked on the floor
    right now." (Q3.4 A, "Their own status"; never "absent", F4).
  - A board count, if FN0-Q3 rules one: "On the floor now: [number]"; below
    5, the board's existing hidden-figure state (`insufficient_data`, no
    number; `privacyTiers.ts:85-86`).
  - No line says who marked or how (F11). A family's line on a failed read is
    FN0-Q5.
  - Pros: your C and its "on the floor now", less the before-arrival case for
    a family's own mark; never
    claims absence (F4); the same kernel-floor ground as FN0-Q6 ("Nothing
    false ships", `AGENT_KERNEL.md:105`); keeps an early arrival a coach has
    marked on the coach's head count (Q3.3 A's "for safety and the head
    count", `OWNER_DECISIONS.md:1287`). Cons: narrows your C for the time
    before a class starts; a child who taps in early shows only from the
    class's start; a child's own tap for a class they never come to still
    shows them from its start (F2); a staff mark written early (a roster
    marked at noon for an evening class) still shows those children from
    when it is written; an athlete who taps "I'm here" in the morning for an
    evening class reads "You're not marked on the floor right now." while
    the check-in card says "You are marked here. Your coach can see it."
    (`apps/web/components/AthleteImHere.tsx:364`); a line before a class
    starts can only come from a staff mark, so its timing tells a family
    that staff marked the child (low: families already see "via" the
    method, `apps/web/app/schedule/page.tsx:1596`); keeps the con you
    accepted (may still show someone after they have gone home).
- **B: your C exactly as chosen.** As A, but a register-only mark counts from
  when it is written, all gym day. Pros: exactly what you chose, as
  OD-2026-10-13-013 asks. Cons: as on your OW27-19 card, plus the
  before-arrival case above, a staff mark written early shows the children
  from when it is written, and a child's own tap for a class they never
  come to shows them all day (F2).
- **C: the ruled name for a register-only mark.** As A, but a register-only
  mark reads "marked here today" ("[first name] is marked here today.", as
  the family confirmation already says "is marked here.",
  `apps/web/app/schedule/page.tsx:1506`), using "I'm here", the ruled name for
  attendance (OD-2026-10-17-001 ruling 2, `OWNER_DECISIONS.md:7124`); "on the
  floor now" stays for a running-session mark; counted as in A. Pros: says only what the
  register says (kernel floor, "Nothing false ships"), true at any hour,
  before arrival, after leaving, or for a class the child never comes to. Cons: narrows your C's "on the floor" for a
  register-only mark; two kinds of line, so a family learns whether a live
  session or only the register marked the child, which the other options
  keep off the line (F11, check 3); and on a session tied to a class the
  line changes from "on the floor now" to "marked here today" when the run
  ends, because the register copy stays (`sessionRunAthletes.ts:206-211`),
  which shows the family when the session ended (F14).
- **D: your own words.**
- **Also asked: how often the line refreshes.** Recommended: when the page
  opens and when the reader refreshes it, not pushed live. Pros: limits the
  timing a guardian can read off the line (F14). Cons: an open page can be
  out of date; the card calls it "the live line"
  (`OWNER_DECISIONS.md:1258`).
- Families get nothing from the read, and no screen shows the line, until
  you answer (section 4).

**FN0-Q3 (for Jason). What does the line show on the board's home, the
platform owner's home, and the home staff-role and volunteer accounts share?**
Plain: the option you picked puts the line "on every home". Those three homes
exist too.
Do they get a line, and if so what is on it?
Why it is his: "on every home" is the option he picked (the record of his
answer is RECONSTRUCTED), and the record points both ways. The App Scrub uses
"the three homes" (coach, athlete, parent) as one fix's scope, but also says
sign-in sends "each role to one home"; Q12's row says it affects the
"Navigation map", and the job-bar shell lane, which gives each role its
sections, waits on Q12 (F3). If his "every home" reaches these homes,
OD-2026-10-13-013 has it applied, not asked again; what the line shows there
is still open, because each of these roles has limits on what it may see
(F3).
- **A (recommended): on the board's and the staff-role and volunteer home, a
  line with no person in it, the classes running now; on the platform
  owner's home, nothing.** The classes are one gym's, from their own guarded
  read, title and times only (no head count, coach or room). "Running now"
  comes from the class schedule alone: a class whose `start_at` is at or
  before now and whose `end_at` is after now, and which is not cancelled
  (`infra/azure/pilot_slice_postgres_scheduler_tables_migration.sql:15-16`,
  `:22`); no register or run mark is read. The platform
  owner gets nothing under your "platform for platform gym for gym"
  (OD-2026-10-02-013, `OWNER_DECISIONS.md:12291-12292`; applied in OD-2026-10-07-011 ruling 2
  and OD-2026-10-10-004 ruling 3), whose plain principle reaches a gym's
  floor. Pros: a line on every gym's homes; no person's name or mark. Cons: a
  class list is new on the two homes that get it (the scheduler read admits
  only athlete, parent, coach, organization admin and admin,
  `scheduler/route.ts:723`), though the public wall shows the default gym's
  classes to anyone and families already see the class titles (all but
  cancelled classes that have ended, `scheduler/route.ts:610-614`)
  (`scheduler/route.ts:680-681`) (F3); a title is staff-written text and a
  class can have a capacity of 1
  (`infra/azure/pilot_slice_postgres_scheduler_tables_migration.sql:13-18`),
  so "no person" rests on titles naming none; the board's privacy tier is
  "Counts only ... never a row" (`privacyTiers.ts:84-86`), and the record
  calls the board an "oversight / aggregate-governance role"
  (OD-2026-08-27-001, a lane's transcription and an analogy, F3); a class list is rows, though of
  classes, not people; not an "on the floor" line; leaving the platform
  owner's home with no line narrows your Q12 A there if "every home" reaches
  it, as B's con says for all three; not sized.
- **B: no line on those three homes.** Pros: no new access and no new
  restriction for any role; matches the sizing. Cons: narrows your Q12 A if
  "every home" meant every role's landing page, and much of the record leans
  that way (F3).
- **C: a count of who counts under section 4's rule, from register marks
  only,** on the
  board's home and on the staff-role and volunteer home, both held to the
  board's floor of 5 (on the staff-role and volunteer home that floor is
  this review's choice for a new count, not an existing rule), labelled as
  FN0-Q2 rules. Pros: a number about the floor, no names, no run marks. Cons: new on those homes, although the public wall shows the
  default gym's day count to anyone (F3); a moving number thins the board's
  floor; a different number from the coach line (F8); not sized.
- **D: a count that includes run marks on the board and platform owner's
  homes,** held to the floor of 5. Pros: the same count as the coach line.
  Cons: departs from Overwatch's 10-13 note that a run mark feeds no "board or
  grant figure", which OW27-32 treated as needing your ruling (F1); goes
  against "platform for platform gym for gym" for the platform owner (taken
  off the session-run routes and nine more gym-data routes, OD-2026-10-07-011
  ruling 2, OD-2026-10-10-004 ruling 3, `OWNER_DECISIONS.md:8112`, and kept
  from the board's compliance and escalation summaries, OD-2026-10-05-006,
  F-003); not sized.
- **E: your own words.**
- Not offered: names on any of the three homes, which would show minors'
  names to the board and the platform owner, whose limits forbid it (F3;
  OD-2026-09-28-005), and to staff-role and volunteer accounts, which read no
  athlete record today (a code comment, `pilotRoleRouting.ts:51-52`; the wall
  of names gives every signed-in role initials and years only, by its route's
  comment, which depends on a deploy setting not checked here,
  `apps/web/app/api/pilot/wall-of-names/route.ts:26-33`).

**FN0-Q4 (for App Overwatch). Do F1 and F14 go to Jason before FN-2
ships?**
Plain: with the line, a parent learns their child is on the floor from a
mark in an open-gym session, which only staff see today, and every linked
guardian sees it, including roughly when the child was marked in and when
the session ended; the app has no way to hold it back from one guardian,
adding one would be a new gate, and when the gym cannot remove a guardian's
link, the lasting lever found is deleting that guardian's account (F14). The
cards Jason answered did not say either thing. Should he hear it, and when?
The rules on how he is told are both Overwatch's readings, not his words.
OD-2026-10-10-007 ruling 3 (`OWNER_DECISIONS.md:8036`, `:8039`): Overwatch
"stops putting safety, legal, medical and compliance questions to him ...
He hears about such a matter only if it breaks the hard floor in his rules
(safeguarding, minors' privacy, authorization, data integrity, nothing
false), and then as one line." OD-2026-10-21-005's limits, on pilot
questions: "Anything touching safety or minors' privacy gets a one-line note
after it's applied" (`:6017`). Applying either here is my reading. INFERRED.
Timing: FN-2 already waits on Jason's answers to FN0-Q1, Q2, Q5 and Q6, and
FN-1 serves families nothing before it (section 4), so none of the options costs FN-1
anything; the choice is only whether, and how, Jason hears these two facts
before families see the line.
- **A (recommended): App Overwatch decides, and Jason gets one line on F1 and
  F14, posted in this PR with the five questions, before FN-2 ships.** I read
  F1 and F14 as inside his Q3.2 A answer (a parent sees their own child's
  line), so not breaking the hard floor; they do touch minors' privacy and
  safeguarding, and OD-2026-10-21-005's "touching" standard gives a one-line
  note for that. INFERRED. Pros: he learns the two facts the cards did not
  show before any family sees the line; it asks him nothing, as ruling 3
  reads. Cons: OD-2026-10-21-005 was written for pilot questions; a one-line
  note asks him nothing, and the one fix this review found for F14, holding
  the line back from one guardian, is a new restriction that needs his
  direction (RULES section 1, `W4_SIZING.md:136-137`), so under A it reaches
  him only if he asks back. F14 is told, not asked, because the build needs
  no decision on it (this review recommends no new restriction); FN0-Q5 is
  asked because FN-2 cannot ship without its words.
- **B: App Overwatch decides; nothing to Jason.** Pros: ruling 3 read
  narrowly (no floor broken, so he hears nothing). Cons: the cards did not
  show him that run marks are staff-only today (`OWNER_DECISIONS.md:1258`), or that one
  guardian cannot be held back.
- **C: ask Jason in this PR, with the five questions.** For use if App
  Overwatch reads either finding as breaking the hard floor. Ruling 3 gives
  him only a line then, so asking goes beyond it; it rests on G8 ("minors'
  privacy ... go to Jason"), the kernel floor ("Minors' privacy ...
  untouched", `AGENT_KERNEL.md:104-105`) and his rule that lanes ask him in
  their own lane (OD-2026-10-03-018). Pros: he decides on F14's fix before
  families see the line, at no cost to FN-1. Cons: goes beyond ruling 3; one
  more question, of the kind he called "slowly adds constrainsts"
  (`OWNER_DECISIONS.md:8034`).

**FN0-Q5 (for Jason). What does a parent or an athlete see when the app
cannot check the line?**
Plain: if the app cannot tell whether a child is on the floor (a failed
read), what does the Parent Hub or the athlete home say?
Why it is his: it is a new line on minors' screens; the L1 rule bars new
warnings, gates or disclaimers for minors, and RULES section 1 leaves any to
you ("unless the owner directs it", `W4_SIZING.md:136-137`). Words for a failed
read on a family or athlete screen have gone to you, or to your design,
three times (F15): OW25-35 A (2026-11-17, the latest), which covers "the
member's screens and the parent's Safety page" with "one neutral line ...
with no warning colour and nothing blocked", recorded as "the owner's
direction that RULES s1 allows" (`OWNER_DECISIONS.md:3328`); the athlete's
failed hold check, where on 2026-10-01 you turned down "We could not check
..." and wrote your own line; and the chalkboard, whose failed-read line is
the lane's words under your design. OW25-35 A's words are about a medical
restriction; whether its plain principle already reaches this line under
OD-2026-10-13-013 is a reading, so it is put to you rather than applied.
INFERRED. With no line at all, a failed read looks like "not on the floor"
(F15).
- **A (recommended): OW25-35 A's shape.** "Whether [child's first name] is
  on the floor could not be checked just now." for a parent; "Whether you're
  on the floor could not be checked just now." for an athlete; no warning
  colour, nothing blocked, the same text whatever the cause. Pros: a failure
  never reads as "not on the floor" (F15); the latest shape you chose for
  these screens. Cons: OW25-35 A was given for a medical restriction; your
  athlete-hold answer chose your own words over this shape.
- **B: the chalkboard's form.** "Can't check the floor right now." on both
  homes. Pros: the same form as the chalkboard's "Can't read the board right
  now." already on those two homes (F15;
  `apps/web/components/Chalkboard.tsx:274`). Cons: those words are a lane's, not
  yours.
- **C: nothing.** Pros: no new line on minors' screens. Cons: a failed read
  then looks like "not on the floor" (F15; kernel floor, "an unknown value
  never looks complete or zero", `AGENT_KERNEL.md:106-107`).
- **D: your own words.**

**FN0-Q6 (for Jason). On a run tied to a class, does a later Absent or Excused
on the register take the child off the line?**
Plain: if the coach tapped a child "here" in the session and later marked
them Excused on the class register (for example, sent home), does the line
still say they are on the floor?
Why it is his: two of your rulings point different ways (F16). Your Q3.1 C,
"Either one" ("Either record counts", taking in option A's "Marked here in a
running session", `OWNER_DECISIONS.md:1262`, `:1264`), counts the here mark;
your ruling 1 of OD-2026-10-21-004 says "a later register change still wins"
on the register (`:6035`). OD-2026-10-13-013 would apply a ruling to a case
its plain principle reaches without asking, but here each ruling's principle
reaches the case and they disagree, so it is put to you. INFERRED.
- **A (recommended): yes, the later register mark wins.** Pros: the line
  follows staff's latest word and never shows a child sent home as on
  the floor (kernel floor, "Nothing false ships", `AGENT_KERNEL.md:105`).
  Cons: narrows Q3.1 C for this case; one more rule in the read; it applies
  to every reader, so the child also leaves the coach's head count while
  their run mark stands (staff set the later mark: the class's coach, a
  cover or an organization admin, `access.ts:651-657`).
- **B: no, a standing here mark on a running session always counts.** Pros:
  exactly Q3.1 C. Cons: a child sent home and marked Excused still shows on
  the floor until the coach untaps them or the run ends, while the family's
  schedule view shows the same child Excused for that class
  (`apps/web/app/schedule/page.tsx:1596`).
- Families get nothing from the read, and no screen shows the line, until
  you answer (section 4).

## 7. Sources read, and what was not

- Read at `f8963ecb`: the files cited above; in
  `docs/current/OWNER_DECISIONS.md`, the entries named in section 1 (each at
  the lines cited) and these, at the lines cited where the body cites lines
  and otherwise as named: OD-2026-10-07-011,
  OD-2026-10-10-003, OD-2026-10-10-007, OD-2026-10-21-001, -002 and -005,
  OD-2026-10-13-009, OD-2026-10-02-013 and -015, OD-2026-10-03-010,
  OD-2026-10-03-018, OD-2026-10-05-006, OD-2026-10-05-023, OD-2026-10-07-009,
  OD-2026-10-10-004, OD-2026-10-17-001, OD-2026-11-19-025, OD-2026-11-24-001,
  OD-2026-11-24-002, OD-2026-11-24-007 and OD-2026-11-25-001; `docs/current/ATTENDANCE_PRECEDENCE.md`;
  `W4_SIZING.md` section 3.
- Searched (a search, not a full read): `OWNER_DECISIONS.md`, `docs/research/`,
  `docs/current/ACTIVE_WORK.md`, `ORGANIZATION_ROLE_MODEL.md` and
  `AUTH_CONTRACT.md`, for presence, check-in, wall, minors, guardian, shared
  tablet, board, staff and volunteer terms. No ruling found contradicts Q3.1
  to Q3.5 as such; F16 records two of his rulings that point different ways
  for one case (FN0-Q6).
- Versions of this file were reviewed by two adversarial reviewers in
  rounds; each round's findings, and the commit it read, are in the PR
  comments.
- Not read: `docs/AI_COLLABORATION.md`; the paired TV route's own file
  (`/api/pilot/tv/session`; its board is read from `wallDisplay.ts` and
  `wallDisplayDb.ts`); any screen, staging or production. Not run: any test.
- The sizing's own code cites (in `W4_SIZING.md` section 3) were made at
  `a4b420c`; some have moved (for example the register copy, `sessionRunAthletes.ts:171` there, is
  `:206-211` here). This file cites `f8963ecb` throughout.

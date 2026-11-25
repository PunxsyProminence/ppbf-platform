# FN-0: privacy review of the "on the floor now" line (W4 item 3)

The privacy review W4 item 3 waits on (`W4_SIZING.md`, section 3, row FN-0).
It recommends and builds nothing. It says, for each role, what the live line
may show and what it must never show, over the two sources Jason chose. The
words of the line, the register-only case, what the line shows on the homes
no answer covers, what a family sees when the read fails, whether two
findings go to Jason, and a clash between a run mark and a later register
mark are not ruled. They are six questions in section 6: two for App
Overwatch and four for Jason.

- **Who signs it off:** Jason's answer: "B: Overwatch, after two reviewers
  pass it" (Q3.5, OW27-23, OD-2026-11-21-006, `docs/current/OWNER_DECISIONS.md:1274`);
  the recorded ruling reads "after two adversarial reviewers pass it"
  (`:1461`). Reading that Overwatch as App Overwatch, which holds this lane,
  comes from the lane brief, not the record. INFERRED. The
  option's con, as shown to him: "What minors' data the homes show is settled
  without you reading it" (`:1272`). FN-1 starts after that sign-off.
- **Code read at:** `main` `348e126dcc8728a4763fc9ee854a46a4f358bd25`. Every
  `file:line` below is at that commit. Paths under `apps/web/` are written in
  full; migrations are under `infra/azure/`.
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
(`OWNER_DECISIONS.md:1185`). Its ruling is the "Jason's answer" lines
(`:1461`); the notes under each answer are Backbone's, not Jason's words.

| Ruling | What it says | Where |
|---|---|---|
| OD-2026-11-19-009, Q12 | "A: on every home; parents see only their own child"; affects "Navigation map; FUTURE lane with a privacy review". The entry itself says "Ruling: none by this entry" | `OWNER_DECISIONS.md:2498`, `:2531` |
| OD-2026-11-21-006, Q3.1 (OW27-19) | Jason: "C: Either one". The card's cons: B "May still show someone after they have gone home (INFERRED: the register has no end time)"; C "Has B's may-still-show problem". Backbone's note: "The card's con stands for the build to handle" | `:1223-1224`, `:1226`, `:1227` |
| Q3.2 (OW27-20) | Jason: "A: Own child's line only (Recommended)"; option text "A line for each of their own children on the floor now; nothing about anyone else." Option B (class and start time) not chosen | `:1235`, `:1238` |
| Q3.3 (OW27-21) | Jason: "A: Names of everyone on the floor (Recommended)"; option text "Names of all athletes on the floor now. Adds no new access." Con on the chosen option: "Names on a screen others may see over a shoulder" | `:1247`, `:1250` |
| Q3.4 (OW27-22) | Jason: "A: A line about themselves only (Recommended)"; option text "Their own status; nothing about others." Option B (a count) not chosen | `:1259`, `:1262` |
| Q3.5 (OW27-23) | Jason: "B: Overwatch, after two reviewers pass it" | `:1274` (Backbone's note `:1275`) |
| Not attendance | The card's "Today's rule" line (card text): "a run-presence mark is not attendance (CT-13, ATTENDANCE_PRECEDENCE.md); this line is not an attendance figure" | `:1218`; `docs/current/ATTENDANCE_PRECEDENCE.md:146-160` |
| OD-2026-10-07-008, ruling 1 | "checked-in athletes' initials and session milestones go only to a gym TV paired with a code. The public no-sign-in address shows today's classes and a head count only." | `OWNER_DECISIONS.md:8673` |
| OD-2026-10-07-008, ruling 3 | "A guardian link goes dormant automatically when the athlete reaches 18, for every read and every consent change." | `:8675` |
| OD-2026-10-04-010 | "an athlete with no date of birth on file is treated as a minor" (an adult-pathway ruling). In code, `isMinor` treats an unknown date of birth as a minor (`apps/web/src/lib/minorAge.ts:47-54`) and the guardian rule uses it (`apps/web/src/server/pilot/guardianAccess.ts:41-48`) | `:10606-10609` |
| OD-2026-10-11-007 | Jason: "lets make it coaches to whole gym". Overwatch's reading ("his words govern"): "a coach of a gym can read and act on every athlete of that gym ... nothing changes for athletes, parents, the platform owner or any other role" | `:7884`, `:7886` |
| Kernel floor | "Minors' privacy, role gates and organization boundaries are untouched. Nothing false ships: ... an unknown value never looks complete or zero." | `AGENT_KERNEL.md:104-107` |
| L1 rule (this brief; W4_SIZING) | No new warnings, gates or disclaimers for minors | `W4_SIZING.md:134-135` |

Other rulings that bear on the line:

| Ruling | What it says | Where |
|---|---|---|
| OD-2026-10-12-006 | "an athlete or parent can check in as Present on the day of the class only. A self check-in never replaces a coach or admin mark. Absent and Excused are staff only." | `:7758` |
| OD-2026-10-21-004, rulings 1 and 2 | A "here" tap flips an Absent or Excused register mark to Present; untapping removes the register mark the tap created "only if nobody changed it since" | `:5995-5996` |
| OD-2026-10-22-001 (Overwatch's application, not Jason's words) | "a cancelled class's attendance stops counting (rows kept, staff still see them)" | `:5934` |
| OD-2026-10-12-024 | "a guardian sees the coach's notes and their own replies and not the other guardian's replies" | `:7500` |
| OD-2026-10-05-024, ruling 4 | "Co-guardians see each other's consent status only ..., nothing more." | `:9358` |
| OD-2026-11-17-009, ruling 3 (OW25-35 A) | When a member's medical restriction cannot be read, families see "one neutral line, "Medical restriction: could not be checked just now; your coach can see it", with no warning colour and nothing blocked ... This is the owner's direction that RULES s1 allows." The card put it to Jason because of "Your rule against new warnings" | `:3288`; card `:3225-3232` |
| OD-2026-10-06-024, ruling 1 | "An active hold blocks nothing at check-in or drill assignment; staff see a warning in both places." | `:8917` |
| OD-2026-10-17-014 | "the app has no age rule on staff roles (coach, staff, volunteer, admin)" | `:6859` |
| OD-2026-09-28-005 | the platform account sees "de-identified, aggregate data across gyms and never an individual athlete's file" (option A, chosen) | `:16014-16017` |
| OD-2026-11-19-007, ruling 2 (OW25-53 A) | "the gym admin sets the tablet sign-out time in gym settings"; in code one of 15, 30, 60, 120 or 240 minutes, default 60 (`apps/web/src/shared/tabletIdle.ts:11-13`) | `:2635` |
| OD-2026-11-20-001, OW27-12 A | Approved TV words: "Nobody is marked here yet today." ("it counts I'm here and the coach's register") | `:1857`, `:1860` |
| OD-2026-09-28-008 | "offline storage stays parked"; restated in Backbone's note on OW27-34 A: "Offline storage on the device stays parked" | `:15933-15935`; `:1426` |
| OD-2026-11-23-006 | "no pain-report notes on the class screen; coaches read them on the coach home" | `:823` |
| OD-2026-10-17-008, ruling 1 | "the gym TV keeps showing only who is present, by initials" | `:6957` |
| OD-2026-09-30-003, G8 | "overwatch answers technical, how-to and scope questions; product intent, design, safety, minors' privacy and spending go to Jason" | `:15030-15032` |
| OD-2026-10-13-013 | "Overwatch and lanes apply a standing ruling to every case its words or plain principle reach, tell him in one line, and do not ask again; when he picks against the recommendation the cost is stated once in that exchange and what he chose is built" | `:7291` |
| OD-2026-11-21-006, OW27-32 A | Jason: "A: Yes, on this page only (Recommended)"; the option text said counting open-gym marks on the stopped-coming page "Departs from the 10-13 note, so it needs your ruling". The 10-13 note (Overwatch's): a run mark "feeds NO attendance report, reconciled view, board or grant figure" | `:1397`, `:1400`; note in `infra/azure/pilot_slice_postgres_session_run_athletes_migration.sql:29-32` |
| OD-2026-11-21-007, OW27-43 A | Words for a status that was not read, on the staff-only Athlete Safety page (`apps/web/app/coach/athlete-safety/page.tsx:536`, coach and admin), went to Jason ("those words are yours"); he chose option A, whose text includes "Hold not read yet" and "Injury reports not read yet" | `:1153`, `:1157`, `:1161` |
| OD-2026-10-01-002, item 2 (with OD-2026-10-01-001) | "What an athlete sees when the training-hold check fails: his own wording." Asked A ("We could not check your training status just now. Ask your coach before you train."), B (nothing) or C (his own words): "**C.** The line is "Talk to your coach about today's training."" OD-2026-10-01-001 had marked this question his: "One question inside it is his" | `:13989-13993`; `:14168-14172` |
| OD-2026-10-08-003, R2 and PLAN-3 | "platform_owner is removed from the six gym routes (... session-script runs ...)", on every verb in those files | `:8488-8489` |

**On G8 and Q3.5 B.** G8 sends minors'-privacy questions to Jason. Q3.5 B is
later and is about FN-0: the card asks "Who signs off the privacy review
(FN-0)" (`:1267`), Jason answered "B: Overwatch, after two reviewers pass it"
(`:1274`) with the con above in front of him (`:1272`), and the recorded
ruling names FN-0 (`:1461`). I read Q3.5 B as governing this review and
two of its questions (section 6). Four are put to Jason: the words of the
line (FN0-Q2), because "What a screen looks like and how it flows is decided
by Jason with the lane doing the work" (`AGENT_KERNEL.md:87-88`,
OD-2026-10-02-004), although the brief named App Overwatch for them; what
"every home" means (FN0-Q3, the record pointing both ways); the words a
family sees when a check fails (FN0-Q5, a kind of question the record sends
to him); and a case where two of his rulings point different ways (FN0-Q6).
FN0-Q1 stays with App Overwatch because the brief and the sizing hand it the
register-only case. Questions for Jason are asked in this lane
(OD-2026-10-03-018; OD-2026-11-24-001). If App Overwatch reads either of its
own as product intent under G8, or as narrowing one of Jason's answers, that
one is asked of Jason in this PR too. INFERRED.

**On OD-2026-10-13-013 ("asked once, ruled once").** It has a standing ruling
applied to every case its words or plain principle reach, without asking
again, and "when he picks against the recommendation ... what he chose is
built". Jason picked Q3.1 C and Q3.5 B against the recommendation. So this
review recommends building C as chosen and handling its stated con in the
words of the line, not by cutting which marks count (FN0-Q1); where a
recommendation still narrows one of his answers, it says so and routes it.
INFERRED.

**Not read:** the research finding `findings/2026-11-19-online-gym-as-a-room.md`,
which OD-2026-11-19-007 cites for the line (`OWNER_DECISIONS.md:2625`). A
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
  after 3 hours (Rec.)", OD-2026-10-21-001 D2, `OWNER_DECISIONS.md:6047`).
  OBSERVED. **The close is lazy.** It runs only before certain calls: the
  coach's own live lookup, a start, the two history reads, and in `gymTvs.ts`
  the paired TV's read, the Paired TVs list and a send to a TV
  (`sessionScriptRuns.ts:146-152`). A search of `apps/web/src`,
  `apps/web/app`, `apps/web/scripts`, `scripts/` and `.github/` found the
  close (`closeIdleSessionRuns`) called only through its wrapper
  `sweepIdleRuns` (`:324`), whose non-test callers are in
  `sessionScriptRuns.ts` (`:343`, `:457`, `:790`, `:837`) and
  `apps/web/src/server/pilot/gymTvs.ts` (`:200`, `:416`, `:689`).
  A failed close is logged and swallowed (`sessionScriptRuns.ts:322-335`).
  OBSERVED. So a run nobody opens can stay `in_progress` long past 3 hours
  (before the close existed, one sat 29 hours, `:115-119`), and a line that
  reads `run_state` alone would show its marked athletes on the floor all that
  time. INFERRED. See F13.
- **Who writes:** only the coach delivering the run, only while it is live,
  with an active staff membership and reach to the athlete
  (`apps/web/src/server/pilot/sessionRunAthletes.ts:76-103`). A mark taken
  back keeps its row with `removed_at` set (`:143-149`); a standing mark has
  `removed_at is null` (`:232`). OBSERVED.
- **Who reads today: staff only, and a source-scan test is written to fail
  otherwise (read, not run).** The module says
  "Athletes, parents, the board and the platform owner have no read of this at
  all" (`:42-44`). The privacy registry puts `session_run_athletes.athlete_id`
  in the `organization` tier: "Athletes, guardians, the board and
  platform_owner have no read of it ... this list, its run and who else was in
  it stay staff only" (`apps/web/src/server/pilot/privacyTiers.ts:557-580`).
  The staff route says the same
  (`apps/web/app/api/pilot/session-scripts/runs/[runId]/athletes/route.ts:25-28`).
  `apps/web/src/server/pilot/sessionRunPresenceStaffOnly.convention.test.ts`
  fails if any route under an athlete, parent, guardian, family, board,
  public, platform, wall or kiosk path reaches the table (`:160-168`), and
  allows only a fixed list of files to reach it (`:142-145`). The table is on
  the public-surface denylist (`privacyTiers.ts:723-724`). OBSERVED. See F1.
- **Not attendance.** "SESSION DETAIL, NOT ATTENDANCE"
  (`infra/azure/pilot_slice_postgres_session_run_athletes_migration.sql:26`;
  `sessionRunAthletes.ts:19-27`). On a session tied to a class, the same tap
  also writes an ordinary present mark on that class's register
  (`sessionRunAthletes.ts:182-187`; `apps/web/src/server/pilot/schedulerDb.ts:783-794`),
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
  is the server's time of the write (`:1449`, `:1460`). OBSERVED. So a coach
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
  athlete lists", `OWNER_DECISIONS.md:5935`), with `status`, `method`,
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
| Paired gym TV `/api/pilot/tv/session` | a TV paired with a code | initials (or a consented name) of today's present marks, newest first, up to 18 | `wallDisplay.ts:444-460`, `:545-558`; `ON_FLOOR_MAX` `:491` |
| Coach "who is marked today" | coach, organization admin, admin | every mark today across the gym's live roster, from CT-13's reconciled view | `apps/web/app/api/pilot/coach/attendance-today/route.ts:12-13`, `:17-21`, `:49-53`, `:90-92` |
| A run's marks by run id | coach, organization admin, admin | the names marked on that run, for the gym's live athletes | `runs/[runId]/athletes/route.ts:54-70` |
| Finished runs | coach, organization admin, admin | who was marked on each settled run | `apps/web/app/api/pilot/session-scripts/runs/route.ts:69-72` |
| Coach home live panel | the coach running the run | "Session in progress" and "Athletes Present" for their own run | `apps/web/components/CoachWorkspace.tsx:1325-1326`, `:3296` |
| Parent Hub attendance list | parent, own linked minor children | each register mark for the child on screen, dated by the class | `apps/web/components/ParentHub.tsx:1276-1298`; family read `scheduler/route.ts:569-582`, `:678-686` |
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
parent and the athlete a line about that person. So FN-1 would let a parent
and an athlete learn one fact derived from a run mark: "marked here in a
running session, yes or no". For a session tied to a class the family often
already learns it through the register copy (2.1); when the copy is skipped,
or the session is untied, the fact is new to the family. OBSERVED (the
reads), INFERRED (the effect). A count that includes run marks on the board or
platform owner's home would also depart from Overwatch's 10-13 note that a run
mark feeds no "board or grant figure", which OW27-32 treated as needing
Jason's ruling (section 1); Backbone's note on his answer there keeps "no
attendance figure, report, board or grant figure changes"
(`OWNER_DECISIONS.md:1401`). That is FN0-Q3.
- **The authority the code cites.** For staff-only, the module, the registry,
  the migration, the convention test and the staff route cite OD-2026-10-10-003
  items 3 and 4 (`sessionRunAthletes.ts:44`; `privacyTiers.ts:574`; migration
  `:35-39`; convention test `:1-4`; `runs/[runId]/athletes/route.ts:28`); the
  registry, the migration and the test also cite OD-2026-10-11-007. OBSERVED.
  OD-2026-10-10-003's items rule that "A coach's own session note is staff
  only" and that an admin may withdraw a departed coach's capacity note
  (`OWNER_DECISIONS.md:8105-8106`); neither names run marks. OBSERVED.
  OD-2026-10-11-007 is Overwatch's reading of Jason's "lets make it coaches to
  whole gym" (`:7884`, `:7886`); its "nothing changes for ... parents" reads to
  me as describing that change only. INFERRED. A search of
  `OWNER_DECISIONS.md` for F-067, `session_run_athletes`, "who is here",
  "run-presence" and "staff only" found no ruling that keeps a run mark from
  the athlete or the parent. So, by my reading, the staff-only rule is in
  code, and the newer answers (OD-2026-11-21-006) govern: **not a CONFLICT**.
  INFERRED. The OW27-19 card told Jason only that a run mark "is not
  attendance" (`:1218`), not that it is staff-only today; whether that goes to
  him is FN0-Q4.
- **Recommendation for FN-1:** only that yes/no leaves the server for a
  family reader, for their own child or themselves; the run, its coach, its
  class, its times, and who else is in it stay staff only, as the registry
  note says. In the same PR, naming OD-2026-11-21-006, FN-1 changes the module
  comment (`sessionRunAthletes.ts:38-44`), the registry entry
  (`privacyTiers.ts:557-580`), the staff route comment
  (`runs/[runId]/athletes/route.ts:25-28`) and the convention test. The test
  carries a minors'-privacy guard, so it is narrowed, not dropped: it should
  still fail for any family, board, platform or public route that reaches the
  table, except the one floor-line read, and that read should be shown to
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
they leave (the card's con, `OWNER_DECISIONS.md:1223-1224`), and also, by my
reading of 2.2, before they arrive and for a class held on another day. That
is more than the record says (kernel floor, `AGENT_KERNEL.md:105-107`). How
the register-only case is handled is question FN0-Q1.
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
  (OD-2026-10-07-011 ruling 2, `OWNER_DECISIONS.md:8606`; repeated in
  OD-2026-10-08-003 R2), a card that cited Jason's "platform for platform
  gym for gym" (his words in OD-2026-10-02-013, `:12251`, about research
  shelves; applied in OD-2026-10-02-015 D3, `:12164-12166`; quoted at
  `:8598`); and kept from
  the board's compliance and escalation summaries (OD-2026-10-05-006, F-003,
  `:9702-9705`);
- staff-role and volunteer accounts: "hold no athlete-scoped or
  administrative surface" (`pilotRoleRouting.ts:51-52`); the run read admits
  only coach, organization admin and admin (`sessionStaffNotes.ts:74`, `:121-131`).
OBSERVED. A names line on any of those homes is new access. A count is
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
OBSERVED. Q12 A puts the line "on every home" (`OWNER_DECISIONS.md:2498`;
repeated as already ruled on the card, `:1218`). The research Q12 came from
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
  cards, recorded in a RECONSTRUCTED entry (`OWNER_DECISIONS.md:2487`,
  `:2529`). OBSERVED. That the words "on every home" are the card's option
  text, not his own typing, is INFERRED from that.
- Q12's row says it affects the "Navigation map" (`:2498`); the Backbone
  Overwatch 25 note (OD-2026-11-19-007) has the job-bar shell lane (AS-4)
  wait on Q11 and Q12 "if they change the shell" (`:2625`);
  `docs/current/ACTIVE_WORK.md:138` lists "Q12 A" among Lane U2's
  authorities; AS-4 gives "Each role" its job sections (`stage-3.md:68`),
  and stage 3 calls that shell "The shell every home depends on"
  (`stage-3.md:54`). OBSERVED. That these lean towards every role is my
  reading. INFERRED.
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
checked in (the con of the card's option A, `OWNER_DECISIONS.md:1222`, which
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
(`runs/[runId]/athletes/route.ts:54-70`), and sees every run's marks in one
list only once the runs have settled (`runs/route.ts:69-72`). OBSERVED. So the
coach line shows no person a coach cannot already read; what is new is every
coach's live run marks gathered into one list while the runs are live.
INFERRED. That keeps Q3.3 A's "Adds no new access" true, provided FN-1 uses
the same gate: an active staff membership in this organization
(`staffNoteRoleInOrganization`, `sessionStaffNotes.ts:121-131`; "A coach whose
membership was ended reads nobody", `sessionRunAthletes.ts:244-247`) and the
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
which is the existing rule (OD-2026-10-04-010, OD-2026-10-07-008 ruling 3),
not a new one. Recommendation.

**F7. Q3.2 A limits the line, not the Parent Hub's existing list.** The
parent's line must not carry the class or the start time (Q3.2 B not chosen).
The Parent Hub already lists each register mark for the child with the class's
date and time (`ParentHub.tsx:1286-1298`). OBSERVED. This review does not
recommend changing that list: it predates the card, and the card asked only
about the line. Information for App Overwatch; no action.

**F8. The line and the wall count can disagree, by design.** The public wall
counts present marks over the whole gym day and never reads run marks
(`wallDisplayDb.ts:86-119`); the line reads both, and under FN0-Q1 A puts
running-session marks under "on the floor now" and register-only marks under
"checked in today". INFERRED: the wall's count can differ from the coach
line's "on the floor now" list. Neither is wrong; they count different
things, so the line should not reuse the wall's count. Information; see
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
  it is put to him as
  FN0-Q5, not settled on my own. Some recommendations narrow when or where
  the line shows, and each is carried by a ruling or a question: the class's
  gym day for a register mark (F2, CT-13's day rule); a register mark on a
  cancelled class for families, as the family read already does (FN0-Q1
  part 2); which homes
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
  should show the child an obvious sign (`OWNER_DECISIONS.md:1231`). Jason
  chose A; no sign was offered on the card. The athlete's own line (Q3.4 A)
  shows the athlete, when signed in, the same yes/no the parent sees.
  INFERRED: that is the nearest thing to such a sign the answers give. A
  separate notice to the child would be a new notice for minors, which needs
  Jason's direction (L1 rule); this review does not recommend one.

**F11. The line should not say who marked a child.** "Who marked a child
present, and by what method, is safeguarding evidence"
(`ATTENDANCE_PRECEDENCE.md:100-101`). For register marks the family read
already sends the marker's role and the method (2.2), though a search of
`apps/web/components` found no screen that shows
the role. The run's marker is staff only (2.1). OBSERVED. So keeping "who
marked" off the family line is a choice about the line's words, not an
existing boundary: it repeats nothing the family read already sends and
leaves the run's marker staff only. It also avoids the line telling one
guardian what the other did. The closest ruling is OD-2026-10-13-009:
"Athletes and parents read no mirrored audit rows", asked because one
parent's filing showed up in the family feed (`OWNER_DECISIONS.md:7356`,
`:7364`); OD-2026-10-12-024 and OD-2026-10-05-024 ruling 4 ("Co-guardians
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
in the migration list, `.github/workflows/apply-migrations.yml:112`). Its
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
`:88-91`), as OD-2026-10-07-009 ruling 1 (`OWNER_DECISIONS.md:8653`, coach,
staff, volunteer) and OD-2026-11-19-025 (athletes) set it; the platform
owner's status route can (`apps/web/app/api/pilot/platform/users/status/route.ts:30-38`,
which refuses only athletes). What the organization admin can do is delete
the guardian account (`apps/web/app/api/pilot/admin/data-deletion/route.ts:28-35`,
`:52-61`; `apps/web/src/server/pilot/dataDeletion.ts:180-196`), which ends
that login; for a child who still has another guardian, the deletion does not
withdraw the child (`infra/azure/pilot_slice_postgres_data_retention_deletion_migration.sql:57-66`).
OBSERVED, from a read of those three routes, not a search of every path. So in
those two cases the gym's lever is a deletion with retention effects, not a
switch. INFERRED. This review recommends no new gate (L1 rule). Whether this, with F1, goes to
Jason before FN-1 is FN0-Q4.

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
  already shows "Unavailable" to a parent when a read about the child fails
  (`apps/web/components/ParentHub.tsx:1125-1129`, `:1221-1223`, `:1373-1375`);
  a search of `OWNER_DECISIONS.md` for "unavailable" found no ruling behind
  it. But the words for a failed or empty read on a family or athlete screen
  have gone to Jason, or to his design, three times:
  - OW25-35 ("Your rule against new warnings is why it was left out, so the
    call is yours"; his A is recorded as "the owner's direction that RULES s1
    allows", `OWNER_DECISIONS.md:3225-3232`, `:3288`);
  - the athlete's failed training-hold check, a question OD-2026-10-01-001
    marked his, where he turned down "We could not check ..." and wrote his
    own line, "Talk to your coach about today's training." (`:13989-13993`,
    `:14168-14172`);
  - the chalkboard, which sits on the athlete home and the Parent Hub
    (`AthleteWorkspace.tsx:3296`, `ParentHub.tsx:1474`). His words were about
    loading: "a quote and a loading  .... under the quote"
    (`:11255-11257`); the lane read them as "whenever there's nothing real to
    show (still loading, or the read failed)" (`:11259-11260`); and PR #1144,
    as the entry reports it, built a saying above "Can't read the board right
    now." after a failed read (OD-2026-10-03-010, `:11268-11270`). This is
    the same two homes the line goes on; the failed-read words there are the
    lane's, under his design.
  (OW27-43 sent such words to him too, for a staff page.) OBSERVED. So I put
  FN0-Q5 to Jason. INFERRED.

**F16. A run mark and a later register Absent can disagree.** On a session
tied to a class, the run mark stands even when the register is set Absent or
Excused after the tap; the code keeps that later register mark
(`sessionRunAthletes.ts:182-183`; for a session tied mid-way,
`sessionRunClass.ts:85-86`), as OD-2026-10-21-004 ruling 1 says: "a later
register change still wins" (`OWNER_DECISIONS.md:5995`). OBSERVED. Read
literally, Q3.1 C would still show a child the coach has since marked Excused
(for example, sent home) as on the floor. INFERRED. **Recommendation:** for a
run tied to a class, a register Absent or Excused written after the child's
run mark takes the child off the line, applying ruling 1's "later register
change wins" to the line. This narrows the running-session half of Jason's
C ("Either record counts", taking in option A's "Marked here in a running
session", `OWNER_DECISIONS.md:1222`, `:1224`): the card's con the build was
left to handle is option
B's, "May still show someone after they have gone home (INFERRED: the
register has no end time)", which C's con points to ("Has B's may-still-show
problem", `OWNER_DECISIONS.md:1223-1224`), and Backbone's note limits it to
"a register mark has no end time" (`:1227`); F16 is about a run mark, not a
register mark. The recommendation rests on the kernel floor instead
("Nothing false ships", `AGENT_KERNEL.md:105`). INFERRED. So it is put to
Jason as FN0-Q6; section 4 and check 5 assume the recommended answer.

## 4. What the line may show, and must never show, by role

The verdicts assume FN0-Q1 to FN0-Q6 are answered as recommended; a different
answer changes the rows it names.

**Which marks count, for every role.** A person counts when either:
- they have a standing mark (`removed_at is null`) on a run that is
  `in_progress` and not idle past 3 hours (F13), whatever its class's status
  (Q3.1 C), unless the run is tied to a class whose register marked them
  Absent or Excused after the run mark (F16, FN0-Q6); this is shown as "on
  the floor now"; or
- they have a present register mark on a class whose gym day is today (F2)
  and no counting run mark; this is shown as FN0-Q1 rules (recommended A:
  all gym day, as "checked in today"). A mark on a cancelled class counts
  only as FN0-Q1 part 2 rules (recommended: on the coach line only, as the
  family read already leaves it out).

Never: a deleted athlete; another organization's athlete or run; an absent or
excused mark; a run mark taken back; a settled run; a register mark for a
class on another day. The same rule feeds the coach line, the parent's line,
the athlete's line and any count (FN0-Q3), except for a cancelled class,
which part 2 splits by reader.

| Role (home) | May show | Must never show |
|---|---|---|
| Coach, organization admin, admin (coach home, admin home): the coach line | The names of every live athlete of this gym who counts, from either source (Q3.3 A). Presence only, as answered (F12). Staff gate as F5. That it could not be checked, when the read fails (F15). | Anyone the rule above leaves out. Absent or excused shown as "not here" (F4). "Nobody ..." when the read failed (F15). |
| Parent (Parent Hub) | For each of their own children who counts, a line saying so (Q3.2 A), in the words FN0-Q1 and FN0-Q2 rule. Scope as F6. When the read fails, what FN0-Q5 rules. | Any other athlete: no name, no initials, no count, no id. The class, the start time, the time of the mark, the coach, the run, the room (Q3.2 B not chosen; a run mark's time is staff only today, `runs/[runId]/athletes/route.ts:65`; a register mark's time already reaches families on the schedule read, 2.2, but not on this line). A child who is 18 or over, unlinked, or deleted. Who marked the child or how (F11). A hold, pain, readiness or injury state (F12). "Not here" or "absent" (F4). A failed read shown as "not on the floor" (F15). |
| Athlete (athlete home) | Their own status (Q3.4 A, "A line about themselves only ... Their own status"): on the floor now, checked in today, or not marked yet (FN0-Q1, FN0-Q2). When the read fails, what FN0-Q5 rules. | Anyone else: no name, no count (Q3.4 B not chosen), no id. The run, the coach, the time of the mark, who else is in the session. Who marked them or how (F11). A hold or health state (F12). A failed read shown as "not on the floor" (F15). |
| Board, platform owner, staff-role and volunteer accounts | Under FN0-Q3 A, the classes running now and no person. Under its other options, only what Jason rules there. | Names, initials or ids (F3). Any count that includes run marks unless Jason rules it (F1, FN0-Q3). On the board's or the platform owner's home, a number below 5. |
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
   method or marker (F1, F11), and no hold, pain, readiness or injury state
   (F12); a parent's carries no class, start time or room either (Q3.2 B not
   chosen), and an athlete's none of the run's class or times (F1).
4. A coach whose staff membership has ended, a board member, the platform
   owner, a staff-role or volunteer account, and a caller from another
   organization get an empty answer from the line's read: no names, no
   yes/no and no count (F1, F3, F5). Any count Jason rules under FN0-Q3
   comes from its own read with its own guard.
5. For a coach-line, a parent and an athlete reader alike, and in any count,
   these do not show: a deleted athlete; a run mark taken back; a run that is
   completed or abandoned; a run idle past 3 hours that no read has closed
   (F13); a run mark on a tied class whose register later says Absent or
   Excused (F16); a register mark on a cancelled class, except as FN0-Q1
   part 2 rules; an absent or excused
   mark; a register mark for a class on another day; an `activity_log` or
   legacy `pilot.attendance` row alone (F2, F4, F9, section 4).
6. The register-only case behaves as FN0-Q1 rules: under its option A, a
   register-only mark never reads "on the floor now".
7. `sessionRunPresenceStaffOnly.convention.test.ts`, `privacyTiers.ts`,
   `sessionRunAthletes.ts` and the staff route comment say who now reads the
   derived run-mark fact (a yes/no for families), and the test still fails
   for any other family, board, platform or public route that reaches the
   table (F1). The new read's name goes into the test's `REACHES` pattern
   (`sessionRunPresenceStaffOnly.convention.test.ts:47-48`), its module onto
   `TABLE_FILES` (`:102`) and a reach list for the "exactly" check
   (`:142-145`, lists at `:66-69`), and its one route onto a list of its own
   with its own role check (the `STAFF_ROUTES` check admits only the three
   staff roles, `:54`, `:170`), as `isSessionRunningForAthleteToday` is
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
11. The homes of the board, the platform owner and staff-role and volunteer
    accounts show what FN0-Q3 rules (under its option A, the classes running
    now and nothing about any person), never a name, and no count built from
    run marks unless Jason rules one.
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

FN0-Q1 and Q4 are for App Overwatch; FN0-Q2, Q3, Q5 and Q6 are for Jason
(section 1, "On G8 and Q3.5 B"). Each is posted in the PR as its own comment,
headed `QUESTION FOR App Overwatch:` or `QUESTION FOR Jason:`. If App
Overwatch reads either of its questions, or any finding above, as narrowing
one of Jason's answers or as product intent under G8, it goes to Jason in
this PR.

Every question was checked against the same sources. **Checked, not answered
in:** `docs/current/OWNER_DECISIONS.md` (OD-2026-11-21-006 cards OW27-19 to
OW27-23; OD-2026-11-19-009; the searches in section 7), `docs/research/`,
`W4_SIZING.md` section 3, the brief, this PR's comments. **Not checked:**
`findings/2026-11-19-online-gym-as-a-room.md` (cited at `OWNER_DECISIONS.md:2625`;
no copy in this repository).

**FN0-Q1 (for App Overwatch). How does the line show a present register mark
that has no running-session mark?**
Plain: if the coach only took the register (no live session), what does the
line say about that athlete, and for how long?
Why it is asked here: the record leaves this to the build and to FN-0.
Backbone's note on Q3.1 C: "The card's con stands for the build to handle:
a register mark has no end time" (`OWNER_DECISIONS.md:1227`); the sizing:
"Not ruled: ... what it says for a person who has only a register mark (no
end time). Left to FN-0." (`W4_SIZING.md:542-543`), the whole register-only
case; the brief puts "the register-only case" to App Overwatch. Jason picked
C against the recommendation with that con stated, and OD-2026-10-13-013 has
"what he chose is built" (`:7291`), so the recommendation keeps every mark C
counts and handles the con in the words. INFERRED.
Part 1:
- **A (recommended): all gym day, in honest words.** A register-only mark
  shows as "checked in today" (a "Checked in today" list on the coach line;
  "[name] checked in today." for a parent; "You're checked in today." for the
  athlete); "on the floor now" is kept for a running-session mark. Pros:
  builds C as chosen (either record counts, all day) and handles the card's
  con in the words, as OD-2026-10-13-013 asks; says exactly what the record
  says, so a check-in made from home is not called "on the floor"; the paired
  TV already lists register marks all gym day under the approved "Nobody is
  marked here yet today." (`wallDisplay.ts:545-558`; OW27-12 A). Cons: two
  kinds of entry; a parent learns "checked in today" rather than "on the
  floor"; a child who has gone home still reads "checked in today" (true).
- **B: during the class's own time, as "on the floor now".** From the class's
  `start_at` to its `end_at`. Pros: clears itself; one kind of entry. Cons:
  cuts both ends of what Jason chose, so it narrows C and would go to him; a
  child who arrives early or stays after drops off the coach line (the head
  count Q3.3 A serves).
- **C: all gym day as "on the floor now".** Pros: C read literally. Cons:
  shows a person on the floor after they leave (the card's con) and, by F2,
  before they arrive; the record says only that a mark was made (kernel
  floor, `AGENT_KERNEL.md:105-107`).
- **D: from the mark until the class ends, as "on the floor now".** Pros: no
  start cut for a coach's mark on arrival. Cons: a check-in made from home
  shows "on the floor" before arrival (F2); cuts the end of what he chose.
- A check-in made from home counts, in every option, until a coach changes
  the register; a staff mark replaces a family one (`schedulerDb.ts:662-690`).
  Under A it reads "checked in today", which is true. INFERRED.

Part 2, a register mark on a class that is cancelled. The office can cancel a
class after it starts (`apps/web/src/server/pilot/schedulerCancelRule.ts:78-79`;
OD-2026-10-22-001), so children marked present may still be on the floor.
Overwatch's application: "a cancelled class's attendance stops counting (rows
kept, staff still see them)" and "past cancelled classes drop off parent and
athlete lists" (`OWNER_DECISIONS.md:5934-5935`); the family read already sends
no mark on a cancelled class (`scheduler/route.ts:617`). OBSERVED. A run mark
on such a class still counts while its run is live (section 4).
- **A (recommended): on the coach line, kept; for families, not shown.** Pros:
  the coach's head count keeps children who may still be there, as "staff
  still see them"; families get what the family read already gives them.
  Cons: two rules.
- **B: not shown to anyone, as the wall does.** Pros: one rule; matches the
  wall. Cons: children marked present before a mid-class cancel drop off the
  coach's head count.
- **C: shown to everyone as any other mark.** Pros: C read literally. Cons:
  gives families a mark the family read withholds today; a parent may see a
  line for a class that never ran.

**FN0-Q2 (for Jason). What are the words of the line?**
Plain: what exactly does the line say on each home?
Why it is his: "What a screen looks like and how it flows is decided by Jason
with the lane doing the work" (`AGENT_KERNEL.md:87-88`), and App Overwatch has
put new words to him at its own request before, among them the TV's presence
line, which counts athletes' and parents' "I'm here" (OW27-11, OW27-12; both
cards "asked for by App Overwatch", `OWNER_DECISIONS.md:1837`, `:1853`). The
brief named App Overwatch for these words, and the sizing says "Left to
FN-0" (`W4_SIZING.md:542-543`); App Overwatch's check sees that this reaches
you and is not already ruled (OD-2026-11-24-001).
- **A (recommended):** (assumes FN0-Q1 A)
  - Coach line: "On the floor now: " and the names marked in a running
    session; "Checked in today: " and the names with a register mark only.
    With nobody in the first list: "Nobody is marked in a running session
    now." (the shape of the TV's approved "Nobody is marked here yet
    today.", OW27-12 A). When the read fails: "Who is on the floor could not
    be checked." (the coach home's existing "could not be checked" form, F15).
  - Parent, for each child who counts: "[first name] is on the floor now."
    or "[first name] checked in today."; nothing for a child who does not
    (Q3.2 A's option text, "A line for each of their own children on the
    floor now").
  - Athlete: "You're on the floor now.", "You're checked in today." or
    "You're not marked on the floor yet." (Q3.4 A, "Their own status"; never
    "absent", F4).
  - A board count, if FN0-Q3 rules one: "On the floor now: [number]"; below
    5, the board's existing hidden-figure state (`insufficient_data`, no
    number; `privacyTiers.ts:85-86`), not a new form such as "fewer than 5".
  - No line says who marked or how (F11). A family's line on a failed read is
    FN0-Q5.
  - Pros: plain; never claims absence (F4); does not reuse the wall's count
    (F8). Cons: a parent cannot tell "not marked" from "nothing to show".
- **B:** as A, plus "Not marked on the floor right now." for each of a
  parent's children with no mark. Pros: the parent always sees a line. Cons:
  more text; "not marked" can read as "not here"; goes beyond Q3.2 A's option
  text (F4).
- **C:** as A, but the athlete sees nothing when not marked. Pros: the same
  rule as the parent's. Cons: a narrower reading of "Their own status".
- **D: your own words.**

**FN0-Q3 (for Jason). What does the line show on the board's home, the
platform owner's home, and the home staff-role and volunteer accounts share?**
Plain: you said the line goes "on every home". Those three homes exist too.
Do they get a line, and what is on it?
Why it is his: "on every home" is the option he picked (the record of his
answer is RECONSTRUCTED), and the record points both ways. The App Scrub uses
"the three homes" (coach, athlete, parent) as one fix's scope, but also says
sign-in sends "each role to one home"; Q12's row says it affects the
"Navigation map", and the job-bar shell lane, which gives each role its
sections, waits on Q12 (F3). If his "every home" reaches these homes,
OD-2026-10-13-013 has it applied, not asked again; what the line shows there
is still open, because each of these roles has limits on what it may see
(F3). So this asks only that.
- **A (recommended): a line with no person in it:** the classes running now.
  Pros: a line on every home, as Q12 A says; nothing about any person, so no
  minors' data reaches these roles. Cons: not an "on the floor" line; class
  titles and times are new on the board's and the platform owner's homes
  (the board is refused the scheduler read, F3), though the public wall
  already shows the default gym's classes to anyone (F3); not sized.
- **B: no line on those three homes.** Pros: no new access and no new
  restriction for any role; matches the sizing. Cons: narrows your Q12 A if
  "every home" meant every role's landing page, and much of the record leans
  that way (F3).
- **C: a live count from register marks only** on the board's home (held to
  its floor of 5) and on the staff-role and volunteer home. Pros: a number
  about the floor, no names, no run marks. Cons: new on those homes, although
  the public wall shows the default gym's live count to anyone (F3); a moving
  number thins the board's floor; a different number from the coach line
  (F8); not sized.
- **D: a count that includes run marks on the board and platform owner's
  homes,** held to the floor of 5. Pros: the same "now" as the coach line.
  Cons: departs from Overwatch's 10-13 note that a run mark feeds no "board or
  grant figure", which OW27-32 treated as needing your ruling (F1); the
  platform owner was taken off the session-run routes (OD-2026-10-07-011
  ruling 2) and nine more gym-data routes (OD-2026-10-10-004 ruling 3,
  `OWNER_DECISIONS.md:8072`), and is kept from the board's compliance and
  escalation summaries (OD-2026-10-05-006, F-003); not sized.
- **E: your own words.**
- Not offered: names on any of the three homes, which would show minors'
  names to the board and the platform owner, whose limits forbid it (F3;
  OD-2026-09-28-005), and to staff-role and volunteer accounts, which read no
  athlete record today (a code comment, `pilotRoleRouting.ts:51-52`; the wall
  of names gives every signed-in role initials and years only,
  `apps/web/app/api/pilot/wall-of-names/route.ts:26-33`).

**FN0-Q4 (for App Overwatch). Do F1 and F14 go to Jason before FN-1
starts?**
Plain: with the line, a parent learns their child is on the floor from a
mark in an open-gym session, which only staff see today, and every linked
guardian sees it; the app has no way to hold it back from one guardian,
adding one would be a new gate, and when the gym cannot remove a guardian's
link its only lever is deleting that guardian's account (F14). The cards
Jason answered did not say either thing. Should he hear it, and when?
The rules on how he is told are both Overwatch's readings, not his words.
OD-2026-10-10-007 ruling 3 (`OWNER_DECISIONS.md:7996`, `:7999`): Overwatch
"stops putting safety, legal, medical and compliance questions to him ...
He hears about such a matter only if it breaks the hard floor in his rules
(safeguarding, minors' privacy, authorization, data integrity, nothing
false), and then as one line." OD-2026-10-21-005's limits, on pilot
questions: "Anything touching safety or minors' privacy gets a one-line note
after it's applied" (`:5977`). Applying either here is my reading. INFERRED.
- **A (recommended): App Overwatch decides, and Jason gets one line on F1 and
  F14; FN-1 does not wait.** I read F1 and F14 as inside his Q3.2 A answer (a
  parent sees their own child's line), so not breaking the hard floor; they
  do touch minors' privacy and safeguarding, and OD-2026-10-21-005's
  "touching" standard gives a one-line note for that. INFERRED. Pros: he
  learns the two facts the cards did not show; FN-1 does not wait. Cons: he
  hears after the sign-off, not before; OD-2026-10-21-005 was written for
  pilot questions. Timing: OD-2026-11-24-002 says "finish the cloud lanes and
  start no new ones" (`OWNER_DECISIONS.md:741`, `:745`), while the brief says
  FN-1 starts after this sign-off under Jason's 2026-11-24 "A" (not yet in
  `OWNER_DECISIONS.md`). If FN-1 cannot start soon anyway, C costs no time
  and A's main pro falls away; App Overwatch knows which holds.
- **B: App Overwatch decides; nothing to Jason.** Pros: ruling 3 read
  narrowly (no floor broken, so he hears nothing). Cons: the cards did not
  show him that run marks are staff-only today (`:1218`), or that one
  guardian cannot be held back.
- **C: ask Jason in this PR before FN-1.** For use if App Overwatch reads
  either finding as breaking the hard floor. Ruling 3 gives him only a line
  then, so asking first goes beyond it; it rests on G8 ("minors' privacy ...
  go to Jason"), the kernel floor ("Minors' privacy ... untouched",
  `AGENT_KERNEL.md:104-105`) and his rule that lanes ask him in their own
  lane (OD-2026-10-03-018). Pros: he decides first. Cons: FN-1 waits.

**FN0-Q5 (for Jason). When the app cannot check, what does a parent or an
athlete see?**
Plain: if the app cannot tell whether a child is on the floor, what should
the parent's and the athlete's screen say?
Why it is his: words for a failed or empty read on a family or athlete screen
have come from you, or your design, three times before (F15): OW25-35 A, your
pick for families; the athlete's failed training-hold check, where you turned
down "We could not check ..." and wrote your own line; and the chalkboard on
the athlete home and the Parent Hub, where you asked for a saying with a
loading line under it and the lane built "Can't read the board right now."
under the saying for a failed read. The kernel floor says a failure must not
look like "not on the floor" (F15).
- **A (recommended): the OW25-35 shape, your pick for families.** "Whether
  [child's first name] is on the floor could not be checked just now." for a
  parent ("Whether you're on the floor could not be checked just now." for
  an athlete), no warning colour, nothing blocked, the same text whatever the
  cause. Pros: a failure never reads as "not on the floor"; the shape you
  chose for a family's medical-restriction line. Cons: you turned down a
  near-identical "We could not check ..." line for athletes before; new words
  on two screens.
- **B: the chalkboard's built line.** "Can't check the floor right now.",
  the same for every child. Pros: short; matches the chalkboard on these
  same homes. Cons: those failed-read words are the lane's, not yours; it
  does not name the child.
- **C: nothing.** Pros: no new words. Cons: a failed check looks like "not on
  the floor" (F15).
- **D: your own words,** as you did for the athlete's failed training-hold
  check ("Talk to your coach about today's training.").

**FN0-Q6 (for Jason). On a run tied to a class, does a later Absent or Excused
on the register take the child off the line?**
Plain: if the coach tapped a child "here" in the session and later marked
them Excused on the class register (for example, sent home), does the line
still say they are on the floor?
Why it is his: two of your rulings point different ways (F16). Your Q3.1 C,
"Either one" ("Either record counts", taking in option A's "Marked here in a
running session", `OWNER_DECISIONS.md:1222`, `:1224`), counts the here mark;
your ruling 1 of OD-2026-10-21-004 says "a later register change still wins"
on the register (`:5995`). OD-2026-10-13-013 would apply a ruling to a case
its plain principle reaches without asking, but here each ruling's principle
reaches the case and they disagree, so it is put to you. INFERRED.
- **A (recommended): yes, the later register mark wins.** Pros: the line
  follows the coach's latest word and never shows a child sent home as on
  the floor (kernel floor, "Nothing false ships", `AGENT_KERNEL.md:105`).
  Cons: narrows Q3.1 C for this case; one more rule in the read.
- **B: no, a standing here mark on a running session always counts.** Pros:
  exactly Q3.1 C. Cons: a child sent home and marked Excused still shows on
  the floor until the coach untaps them or the run ends.

## 7. Sources read, and what was not

- Read at `348e126d`: the files cited above; in
  `docs/current/OWNER_DECISIONS.md`, the entries named in section 1 (each at
  the lines cited) and, at the lines cited, OD-2026-10-07-011,
  OD-2026-10-10-003, OD-2026-10-10-007, OD-2026-10-21-001, -002 and -005,
  OD-2026-10-13-009, OD-2026-10-02-013 and -015, OD-2026-10-03-010,
  OD-2026-10-03-018, OD-2026-10-05-006, OD-2026-10-07-009, OD-2026-10-10-004,
  OD-2026-11-19-025, OD-2026-11-24-001 and OD-2026-11-24-002;
  `docs/current/ATTENDANCE_PRECEDENCE.md`; `W4_SIZING.md` section 3.
- Searched (a search, not a full read): `OWNER_DECISIONS.md`, `docs/research/`,
  `docs/current/ACTIVE_WORK.md`, `ORGANIZATION_ROLE_MODEL.md` and
  `AUTH_CONTRACT.md`, for presence, check-in, wall, minors, guardian, shared
  tablet, board, staff and volunteer terms. No ruling found contradicts Q3.1
  to Q3.5.
- Earlier versions of this file were reviewed by two adversarial reviewers in
  ten rounds (summarised in the PR comments). This version has not yet
  passed them.
- Not read: `docs/AI_COLLABORATION.md`; the paired TV route's own file
  (`/api/pilot/tv/session`; its board is read from `wallDisplay.ts` and
  `wallDisplayDb.ts`); any screen, staging or production. Not run: any test.
- Line numbers in `W4_SIZING.md` section 3 were read at `a4b420c`; some have
  moved (for example the register copy, `sessionRunAthletes.ts:171` there, is
  `:182-187` here). This file cites `348e126d` throughout.

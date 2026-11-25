# FN-0: privacy review of the "on the floor now" line (W4 item 3)

The privacy review W4 item 3 waits on (`W4_SIZING.md`, section 3, row FN-0).
It recommends and builds nothing. It says, for each role, what the live line
may show and what it must never show, over the two sources Jason chose. The
words of the line and the register-only case are not ruled; they are put as
questions for App Overwatch in section 6.

- **Who signs it off:** App Overwatch, after two adversarial reviewers pass it
  (Q3.5 B, OW27-23, OD-2026-11-21-006, `docs/current/OWNER_DECISIONS.md:1274-1275`).
  Jason does not read it first. FN-1 starts after that sign-off.
- **Code read at:** `main` `348e126dcc8728a4763fc9ee854a46a4f358bd25`. Every
  `file:line` below is at that commit. Paths under `apps/web/` are written in
  full; migrations are under `infra/azure/`.
- **Labels:** OBSERVED (read in the code or the record, with file:line),
  INFERRED (my reasoning past what was read), UNVERIFIED (not checked).
  Nothing here was run: no route, test, database or screen. Every OBSERVED
  claim is a code read, not runtime evidence.
- **Public repository:** counts and roles only; no member names or record
  details.

## 1. The rulings this review applies

| Ruling | What it says (quoted or as recorded) | Where |
|---|---|---|
| OD-2026-11-19-009, Q12 | "A: on every home; parents see only their own child"; affects "Navigation map; FUTURE lane with a privacy review". The entry itself says "Ruling: none by this entry" | `OWNER_DECISIONS.md:2498`, `:2531` |
| OD-2026-11-21-006, Q3.1 (OW27-19) | "C: Either one". "Either a here mark in a running session or a present mark on today's register shows a person on the floor. The card's con stands for the build to handle: a register mark has no end time (INFERRED)." | `:1226-1227` |
| Q3.2 (OW27-20) | "A: Own child's line only (Recommended)": "A line for each of their own children on the floor now; nothing about anyone else." Option B (class and start time) not chosen | `:1235`, `:1238` |
| Q3.3 (OW27-21) | "A: Names of everyone on the floor (Recommended)": "Names of all athletes on the floor now. Adds no new access." Con accepted: "Names on a screen others may see over a shoulder" | `:1247`, `:1250` |
| Q3.4 (OW27-22) | "A: A line about themselves only (Recommended)": "Their own status; nothing about others." Option B (a count) not chosen | `:1259`, `:1262` |
| Q3.5 (OW27-23) | "B: Overwatch, after two reviewers pass it" | `:1274-1275` |
| Not attendance | The card: "a run-presence mark is not attendance (CT-13, ATTENDANCE_PRECEDENCE.md); this line is not an attendance figure" | `:1218`; `docs/current/ATTENDANCE_PRECEDENCE.md:146-160` |
| OD-2026-10-07-008, ruling 1 | "checked-in athletes' initials and session milestones go only to a gym TV paired with a code. The public no-sign-in address shows today's classes and a head count only." | `OWNER_DECISIONS.md:8673` |
| OD-2026-10-07-008, ruling 3 | "A guardian link goes dormant automatically when the athlete reaches 18, for every read and every consent change." | `:8675` |
| OD-2026-10-04-010 | "an athlete with no date of birth on file is treated as a minor" (an adult-pathway ruling; the app applies the same rule everywhere, `apps/web/src/lib/minorAge.ts:47-54`) | `:10606-10609` |
| OD-2026-10-11-007 | "a coach of a gym can read and act on every athlete of that gym ... nothing changes for athletes, parents, the platform owner or any other role" | `:7886` |
| Kernel floor | "Minors' privacy, role gates and organization boundaries are untouched. Nothing false ships: ... an unknown value never looks complete or zero." | `AGENT_KERNEL.md:104-107` |
| L1 rule (this brief; W4_SIZING) | No new warnings, gates or disclaimers for minors | `W4_SIZING.md:134-135` |

Other rulings that bear on the line:

| Ruling | What it says | Where |
|---|---|---|
| OD-2026-10-12-006 | "an athlete or parent can check in as Present on the day of the class only. A self check-in never replaces a coach or admin mark. Absent and Excused are staff only." | `:7758` |
| OD-2026-10-21-004, rulings 1 and 2 | A "here" tap flips an Absent or Excused register mark to Present; untapping removes the register mark the tap created "only if nobody changed it since" | `:5995-5996` |
| OD-2026-10-22-001 (Overwatch's application, not Jason's words) | "a cancelled class's attendance stops counting (rows kept, staff still see them)" | `:5934` |
| OD-2026-10-12-024 | "a guardian sees the coach's notes and their own replies and not the other guardian's replies" | `:7500` |
| OD-2026-10-06-024, ruling 1 | "An active hold blocks nothing at check-in or drill assignment; staff see a warning in both places." | `:8917` |
| OD-2026-10-17-014 | "the app has no age rule on staff roles (coach, staff, volunteer, admin)" | `:6859` |
| OD-2026-09-28-005 | the platform account sees "de-identified, aggregate data across gyms and never an individual athlete's file" (option A, chosen) | `:16014-16017` |
| OD-2026-11-20-001, OW27-12 A | Approved TV words: "Nobody is marked here yet today." ("it counts I'm here and the coach's register") | `:1857`, `:1860` |
| OD-2026-11-21-006, OW27-34 A | Failed saves are held "In the open page; dropped at sign-out"; its pro: "Nothing left on a shared tablet"; "Offline storage on the device stays parked" | `:1421`, `:1425-1426` |
| OD-2026-11-23-006 | "no pain-report notes on the class screen; coaches read them on the coach home" | `:823` |
| OD-2026-10-17-008, ruling 1 | "the gym TV keeps showing only who is present, by initials" | `:6957` |
| OD-2026-09-30-003, G8 | "overwatch answers technical, how-to and scope questions; product intent, design, safety, minors' privacy and spending go to Jason" | `:15030-15032` |

**On G8 and Q3.5 B.** G8 sends minors'-privacy questions to Jason. Q3.5 B is
later and names FN-0: "FN-0 is signed off by Overwatch ... Jason does not read
it first" (`:1275`). I read Q3.5 B as governing this review and its
questions (section 6). If App Overwatch reads any of them as product intent
under G8, that one is asked of Jason in this PR. INFERRED.

**Not read:** the research finding `findings/2026-11-19-online-gym-as-a-room.md`,
which OD-2026-11-19-007 cites for the line (`OWNER_DECISIONS.md:2625`). A
search of this repository found no copy; `docs/research/` holds no file on the
floor line.

## 2. The two sources, as the code has them

### 2.1 A "here" mark in a running session (`pilot.session_run_athletes`)

- **Live means `run_state = 'in_progress'`.** A run has `run_state`,
  `started_at` and `ended_at`
  (`infra/azure/pilot_slice_postgres_session_run_state_migration.sql:38-40`),
  one of `in_progress`, `completed`, `abandoned` (`:60-62`), and at most one
  live run per coach (`:128-130`). OBSERVED.
- **A live run ends** when the coach ends it, or is closed as `abandoned`
  after 3 hours with nothing saved
  (`apps/web/src/server/pilot/sessionScriptRuns.ts:153`; Jason's "A: Yes, after
  3 hours (Rec.)", OD-2026-10-21-001 D2, `OWNER_DECISIONS.md:6047`). OBSERVED.
  So this source has an end: it cannot show someone for more than about 3
  hours after the last save on the run. INFERRED.
- **Who writes:** only the coach delivering the run, only while it is live,
  with an active staff membership and reach to the athlete
  (`apps/web/src/server/pilot/sessionRunAthletes.ts:76-103`). A mark taken
  back keeps its row with `removed_at` set (`:143-149`); a standing mark has
  `removed_at is null` (`:232`). OBSERVED.
- **Who reads today: staff only.** The module says "Athletes, parents, the
  board and the platform owner have no read of this at all" (`:42-44`), and
  the privacy registry puts `session_run_athletes.athlete_id` in the
  `organization` tier: "Athletes, guardians, the board and platform_owner have
  no read of it ... this list, its run and who else was in it stay staff only"
  (`apps/web/src/server/pilot/privacyTiers.ts:557-580`). The table is on the
  public-surface denylist (`:723-724`). OBSERVED. See finding F1.
- **Not attendance.** "SESSION DETAIL, NOT ATTENDANCE"
  (`infra/azure/pilot_slice_postgres_session_run_athletes_migration.sql:26`;
  `sessionRunAthletes.ts:19-27`). On a session tied to a class, the same tap
  also writes an ordinary present mark on that class's register
  (`sessionRunAthletes.ts:182-187`; `apps/web/src/server/pilot/schedulerDb.ts:783-794`).
  An untied (open gym) session writes no register mark
  (`ATTENDANCE_PRECEDENCE.md:157-158`). OBSERVED.

### 2.2 A present mark on today's register (`pilot.scheduler_attendance`)

- **One row per class and athlete**, status `present`, `absent` or `excused`,
  with a `checked_in_at` and no end time
  (`infra/azure/pilot_slice_postgres_scheduler_tables_migration.sql:84-93`).
  The class itself has `start_at` and a non-null `end_at` (`:15-16`). OBSERVED.
- **Staff write it for any class, on any day.** The coach running the class,
  the cover, the scheduler or an admin marks the register
  (`apps/web/app/api/pilot/scheduler/route.ts:1411-1413`; OD-2026-10-07-008
  ruling 4). The only gym-day check in that route is the family one at `:1432`
  (a search of the file for `gymDayIso` finds only that use and its import).
  `checked_in_at` is the server's time of the write (`:1449`, `:1460`), so a
  coach marking last week's class today writes today's time. OBSERVED.
- **An athlete or a parent may also write it**, for a class the athlete is
  registered to, on the class's own gym day, `present` only
  (`scheduler/route.ts:1396-1436`; OD-2026-10-12-006), and it never
  overwrites a staff mark (`schedulerDb.ts:692-730`). The athlete does this from the "I'm here" card on
  Today (`apps/web/components/AthleteWorkspace.tsx:3270-3275`). OBSERVED. So a
  present mark can be written in the morning for an evening class, before the
  athlete has left home. INFERRED from the same-day rule, which checks the day
  and not the hour.
- **The public wall reads this source only** (not run marks), as
  `count(distinct athlete_id)` of present marks whose `checked_in_at` falls in
  the gym day, leaving out deleted athletes and cancelled classes
  (`apps/web/src/server/pilot/wallDisplayDb.ts:86-119`). OBSERVED.

### 2.3 What already shows presence, and to whom (OBSERVED)

| Surface | Who | What | Where |
|---|---|---|---|
| Public wall `/api/pilot/wall` | anyone, no sign-in | today's classes; a head count per class and in total; no person, no initials, no key | `apps/web/app/api/pilot/wall/route.ts:20-35`; `apps/web/src/server/pilot/wallDisplay.ts:462-485` |
| Paired gym TV `/api/pilot/tv/session` | a TV paired with a code | initials (or a consented name) of today's present marks, newest first, up to 18 | `wallDisplay.ts:444-460`, `:545-558`; `ON_FLOOR_MAX` `:491` |
| Coach "who is marked today" | coach, organization admin, admin | every mark today across the gym's live roster, from CT-13's reconciled view | `apps/web/app/api/pilot/coach/attendance-today/route.ts:12-13`, `:49-53`, `:90-92` |
| Coach home live panel | the coach running the run | "Session in progress" and "Athletes Present" for their own run | `apps/web/components/CoachWorkspace.tsx:1325-1326`, `:3296` |
| Parent Hub attendance list | parent, own linked minor children | each register mark for the child on screen, dated by the class | `apps/web/components/ParentHub.tsx:1276-1298`; family read `scheduler/route.ts:569-582`, `:678-686` |
| Athlete "I'm here" | the athlete | their own check-in for today's class | `AthleteWorkspace.tsx:3270-3275`; `scheduler/route.ts:688-697` |

A search of `ParentHub.tsx` and `AthleteWorkspace.tsx` for "on the floor",
"floor now" and "here now" found no live line on either home (the matches are
the athlete Floor tab and kiosk text-size comments). OBSERVED, search only.

## 3. Findings

**F1. Run marks become visible to two new roles, by Jason's newer answers.**
Today run marks are staff only (2.1). Under Q3.1 C a run mark alone puts a
person on the floor, and Q3.2 A and Q3.4 A give the parent and the athlete a
line about that person. So FN-1 would let a parent and an athlete learn one
fact derived from a run mark that today only staff read: "marked here in a
running session, yes or no". For a session tied to a class that fact already
reaches the family through the register mark the same tap writes (2.1); for
an untied session it does not. OBSERVED (the reads), INFERRED (the effect).
- The authority both files cite for staff-only, OD-2026-10-10-003 items 3 and
  4 (`sessionRunAthletes.ts:44`; `privacyTiers.ts:574`), rules that "A coach's
  own session note is staff only" and that an admin may withdraw a departed
  coach's capacity note (`OWNER_DECISIONS.md:8105-8106`). Neither names run
  marks. OBSERVED. So I found no ruling that keeps a run mark from the athlete
  and the parent; the staff-only rule is in code, and the newer answers
  (OD-2026-11-21-006) govern. **Not a CONFLICT.**
- **Recommendation for FN-1:** only that yes/no leaves the server for a
  family reader, for their own child or themselves; the run, its coach, its
  class, its times, and who else is in it stay staff only, as the registry
  note says. FN-1 changes the module comment (`sessionRunAthletes.ts:38-44`)
  and the registry entry (`privacyTiers.ts:557-580`) in the same PR, naming
  OD-2026-11-21-006, so the code does not claim a rule it no longer keeps. The
  table stays on the public-surface denylist (`privacyTiers.ts:723-724`).

**F2. A register mark has no end time, and can be written before arrival or
long after the class.** (2.2) A present mark is never closed. A family mark
can be written hours before the class. A staff mark for an earlier class,
written today, carries today's `checked_in_at`. INFERRED from the reads. A
line that counts "a present mark with `checked_in_at` today", as the wall does
(`wallDisplayDb.ts:91-92`), would show a person on the floor all day: before
they arrive, after they leave, and for a class held on another day. That is a
claim the record does not make (kernel floor, `AGENT_KERNEL.md:105-107`).
This is the con Jason accepted for the build to handle (Q3.1 C note,
`OWNER_DECISIONS.md:1227`). How it is handled is question FN0-Q1.
- Whatever the answer, **"today" should be the class's gym day, not the
  mark's**: CT-13's view keys on the class's `start_at` in gym time
  (`ATTENDANCE_PRECEDENCE.md:140-144`), and the Parent Hub was fixed for this
  exact trap ("THE DATE IS THE CLASS'S, NOT THE MARK'S", `ParentHub.tsx:1276-1282`).
  Recommendation.

**F3. "Every home" names more homes than the answers cover.** The signed-in
landing pages are, by role: platform owner, organization admin and admin,
coach, athlete, parent, board, and one shared page for staff and volunteers
(`apps/web/src/shared/pilotRoleRouting.ts:20-56`). OBSERVED. Q3.2 to Q3.4 say
what parents, coaches and admins, and athletes see; nothing says what the
board, the platform owner, staff or volunteers see. Their tiers today:
- board: "Counts only, floored by k-anonymity ... never a row, never a name"
  (`privacyTiers.ts:81-87`); the scheduler read refuses the board outright
  (`scheduler/route.ts:707-709`);
- platform owner: no athlete ids, no names, across organizations
  (`privacyTiers.ts:73-79`), and "never an individual athlete's file"
  (OD-2026-09-28-005);
- staff and volunteers: "hold no athlete-scoped or administrative surface"
  (`pilotRoleRouting.ts:51-52`); the run read admits only coach,
  organization admin and admin (`apps/web/src/server/pilot/sessionStaffNotes.ts:74`, `:121-131`).
OBSERVED. A names line on any of those homes is new access; a live count on
the board home would be a small real number, which its tier forbids. INFERRED.
The sizing builds the line on four homes only (`W4_SIZING.md:551-554`). Which
homes "every home" means is question FN0-Q3.

**F4. No mark is not absence.** "A ROW MEANS A MARK. NO ROW MEANS NO MARK --
NOT ABSENCE" (`attendance-today/route.ts:33-38`); the wall has no absent row
"because on a wall those read as a public record of who did not turn up"
(`wallDisplay.ts:29-31`). OBSERVED. A coach who runs neither a session nor a
register leaves every athlete with no mark (the con of Q3.1 A, which C keeps:
`OWNER_DECISIONS.md:1222`). So the line never says anyone is "not here",
"absent" or "gone home", for any role. For a parent, Q3.2 A's text is "A line
for each of their own children on the floor now", which reads as no line for
a child with no mark. Recommendation; the words are question FN0-Q2.

**F5. Staff names add no new access.** A coach already reads every live
athlete of the gym (OD-2026-10-11-007), and the coach "marked today" read
already returns the whole gym's marks to a coach and an admin
(`attendance-today/route.ts:49-53`), as the run read does
(`sessionRunAthletes.ts:238-280`). OBSERVED. So Q3.3 A's "Adds no new access"
holds for the register source and for run marks, provided FN-1 uses the same
gate: an active staff membership in this organization (the run read's
`staffNoteRoleInOrganization`, `sessionStaffNotes.ts:121-131`; "A coach whose
membership was ended reads nobody", `sessionRunAthletes.ts:244-247`) and the
gym's live roster. Recommendation.

**F6. The parent's scope is the guardian rule, with the 18 and deletion
rules inside it.** `guardianAthleteIds` returns only live, linked children who
are minors, an unknown date of birth reading as a minor
(`apps/web/src/server/pilot/guardianAccess.ts:34-49`, `:141-147`;
`apps/web/src/lib/minorAge.ts:47-54`). Its sibling
`linkedAthleteIdsIncludingAdults` keeps adult children and is "not a guardian
read" (`guardianAccess.ts:149-163`). OBSERVED. So FN-1's parent branch uses
`guardianAthleteIds` (as the sizing plans, `W4_SIZING.md:552`), never the
sibling, never ids from the request. Then: a child who turns 18 drops off the
parent's line on that gym day, and a child with no date of birth stays on it,
which is the existing rule (OD-2026-10-04-010, OD-2026-10-07-008 ruling 3),
not a new one. Recommendation.

**F7. Q3.2 A limits the line, not the Parent Hub's existing list.** The
parent's line must not carry the class or the start time (Q3.2 B not chosen).
The Parent Hub already lists each register mark for the child with the class's
date and time (`ParentHub.tsx:1286-1298`). OBSERVED. This review does not
recommend changing that list: it predates the card and the card asked only
about the line. Information for App Overwatch; no action.

**F8. The line and the wall count can disagree, by design.** The public wall
counts present marks over the whole gym day and never reads run marks
(`wallDisplayDb.ts:86-119`); the line reads both and, under F2, only for the
time a person is on the floor. INFERRED: the wall can read "12" while a
coach's line names 5. Neither is wrong; they count different things, so the
line should not reuse the wall's words. Information; see FN0-Q2.

**F9. Only the two ruled sources.** Two other records look live and are not
sources under Q3.1 C: the athlete's own training session (open until checked
out or closed after 20 minutes of inactivity,
`apps/web/src/server/pilot/sessionAutoClose.ts:1-10`) and the "How I feel
today" check-in (`pilot.athlete_check_ins`, `sessionAutoClose.ts:33`).
OBSERVED. FN-1 reads neither. Recommendation; adding one would be a new
answer to Q3.1, not a build choice.

**F10. Minors' rules, checked one by one.**
- Unknown date of birth is a minor (OD-2026-10-04-010; `minorAge.ts:47-54`).
  The line itself has no age split: the answers give every role the same view
  whatever the athlete's age, and the only age effect is the guardian rule
  (F6). OBSERVED, INFERRED.
- No new warning, gate or disclaimer (L1 rule). The recommendations here add
  none: each one keeps an existing gate (guardian scope, staff membership,
  organization, deletion, cancelled class) on the new read. INFERRED.
- The public wall and the paired TV are unchanged: the line is for signed-in
  homes only, and none of it reaches `/api/pilot/wall` or `/api/pilot/tv/session`
  (OD-2026-10-07-008 ruling 1). Recommendation.
- A shared gym tablet: the athlete line shows only the signed-in athlete; the
  coach line shows names, which is Q3.3's accepted con; the tablet signs out
  after 1 hour idle (OD-2026-11-19-009 Q5, `OWNER_DECISIONS.md:2493`).
  Nothing from the line is kept on the device ("Nothing left on a shared
  tablet", OW27-34 A; offline storage parked). OBSERVED (the record),
  INFERRED (the effect).
- A coach may be under 18 (OD-2026-10-17-014), and under Q3.3 A sees every
  name on the floor, as they already see the roster. Information; no action.

**F11. Who marked a child stays with staff.** "Who marked a child present,
and by what method, is safeguarding evidence"
(`docs/current/ATTENDANCE_PRECEDENCE.md:100-101`). Both guardians of a child
would see the child's line, and the record keeps one guardian's replies from
the other (OD-2026-10-12-024). OBSERVED. So the family line never says who
marked the child or how: not "your coach", not "checked in by a parent", not
"self". INFERRED from both; recommendation.

**F12. A hold does not keep a child off the line, and the line shows no
hold.** A hold blocks nothing at check-in (OD-2026-10-06-024 ruling 1), so an
athlete on a hold can be on the floor. OBSERVED. The line carries presence
only, for every role, and never uses the medical-stop mark `--locked`
(`AGENT_KERNEL.md:97-98`). Jason keeps sensitive detail off the shared floor
screen (OD-2026-11-23-006). Recommendation.

## 4. What the line may show, and must never show, by role

The verdicts assume FN0-Q1 to FN0-Q3 are answered as recommended; a different
answer changes the rows it names.

| Role (home) | May show | Must never show |
|---|---|---|
| Coach, organization admin, admin (coach home, admin home) | The names of every live athlete of this gym on the floor now, from either source (Q3.3 A). Staff gate as F5. | Anything from another organization. A deleted athlete. A mark taken back. A mark on a cancelled class. Absent or excused as "not here" (F4). Health, hold, readiness, pain, injury or behaviour detail on the line itself (the line is presence only; staff read those elsewhere). |
| Parent (Parent Hub) | For each of their own children who is on the floor now, a line saying so (Q3.2 A). Scope as F6. | Any other athlete: no name, no initials, no count, no id. The class, the start time, the coach, the run, the room (Q3.2 B not chosen). A child who is 18 or over, unlinked, or deleted. Who marked the child, the method, or any staff note (F11). A hold, pain, readiness or injury state (F12). "Not here" or "absent" (F4). |
| Athlete (athlete home) | Their own status: on the floor now (Q3.4 A). | Anyone else: no name, no count (Q3.4 B not chosen), no id. The run, the coach, who else is in the session. Who marked them or how (F11). A hold or health state (F12). |
| Board, platform owner, staff, volunteer | Nothing (recommended, FN0-Q3). | Names, initials, ids or a live count (F3). |
| Signed out: public wall, paired TV | Unchanged: classes and counts on the public address, initials on a paired TV (OD-2026-10-07-008 ruling 1). | Any part of the line. |

**For every role:** the server cuts the response by role before it is sent;
nothing gym-wide reaches a family browser to be filtered there. The
organization comes from the signed-in principal, never the request (the wall
route's rule, `wall/route.ts:30-32`). The response is `no-store`, as the wall
and the staff read are (`wall/route.ts:56`; `attendance-today/route.ts:90-92`),
and the page keeps none of it in device storage (F10).
No athlete name goes to a log line (the wall logs only an event and a message,
`wall/route.ts:63`). Recommendations.

## 5. Checks FN-1 to FN-3 should carry (recommended, not built)

Each guard below should be seen to fail when broken (the kernel's
"Independent verification duties", duty 3):

1. A parent gets a line for a linked minor child on the floor, and nothing for
   a child linked to another parent, a child who is 18 or over, or a deleted
   child; a child with no date of birth is treated as a minor (F6).
2. A parent's and an athlete's response contains no other athlete's id or
   name and no count (Q3.2 A, Q3.4 A).
3. A family response carries no run id, class, start time, coach, method or
   marker (F1, Q3.2 A).
4. A coach whose staff membership has ended, a board member, the platform
   owner, a staff or volunteer account, and a caller from another
   organization get no names (F3, F5).
5. A run mark that was taken back, a run that is completed or abandoned, a
   mark on a cancelled class, an absent or excused mark, and a register mark
   for a class on another day do not show (F2, F4).
6. The register-only case behaves as FN0-Q1 rules.
7. `privacyTiers.ts` and `sessionRunAthletes.ts` say who now reads a derived
   run-mark fact (F1).
8. A family response says nothing about who marked the child or how (F11),
   and no line carries a hold, pain, readiness or injury state (F12).

One existing guard FN-1 meets: the CT-13 test lets only listed files read
`pilot.scheduler_attendance` directly; "Anything new goes through
pilot.attendance_reconciled" (`apps/web/src/server/pilot/attendancePrecedence.test.ts:21-23`,
list at `:63`). The line is not attendance (Q3.1 card), so whether FN-1
reuses an existing reader or is added to the list with a reason is FN-1's
design choice; it should not count the line as attendance either way.
INFERRED.

## 6. Questions for App Overwatch

Each is posted in the PR as its own comment in the official form.

**FN0-Q1. When does a present register mark, with no running-session mark,
show a person on the floor?**
- **A (recommended): during the class's own time.** From the class's
  `start_at` to its `end_at`, on the class's gym day, class not cancelled.
  Pros: clears itself, as option A on the card did; no one shows before the
  class or after it; uses a time the class already has. Cons: an athlete who
  stays after the class drops off at its end; a mark taken before the class
  shows only from its start.
- **B: all gym day, in other words.** The register-only line says "checked in
  today" rather than "on the floor now". Pros: says exactly what the record
  says. Cons: two kinds of line to read; the parent learns less than "on the
  floor".
- **C: all gym day as "on the floor now".** Pros: the plainest reading of
  "C: Either one". Cons: shows a child on the floor before they arrive and
  after they leave (F2), which the kernel floor calls false.
- If App Overwatch reads A as narrowing Jason's C rather than handling its
  con, it is a question for Jason, asked here.
- Checked, not answered in: `OWNER_DECISIONS.md` (OD-2026-11-21-006 cards
  OW27-19 to OW27-23; OD-2026-11-19-009), `docs/research/`, `W4_SIZING.md`
  section 3 ("Not ruled: ... what it says for a person who has only a register
  mark"), the brief, this PR's comments.

**FN0-Q2. What are the words of the line?**
- **A (recommended):** staff: "On the floor now: " and the names; with no
  marks, "Nobody is marked on the floor right now." (the shape of the TV's
  approved "Nobody is marked here yet today.", OW27-12 A). Parent: "[child's
  first name] is on the floor now." for each child who is, and nothing for a
  child who is not. Athlete: "You're on the floor now.", and nothing when not
  marked. Pros: plain; never claims absence (F4); does not reuse the wall's
  count (F8); says nothing about who marked (F11). Cons: a parent or athlete
  with no line cannot tell "not marked" from "nothing to show".
- **B:** as A, plus "Not marked on the floor right now." for a parent's child
  and the athlete when there is no mark. Pros: the family always sees a line.
  Cons: more text; "not marked" can read as "not here".
- Checked, not answered in: as FN0-Q1.

**FN0-Q3. Which homes does "every home" (Q12 A) mean?**
- **A (recommended): the four homes the answers cover** (coach, admin,
  parent, athlete). The board, the platform owner, staff and volunteers get
  no line. Pros: no new access for any role (F3); matches the sizing. Cons: a
  narrower reading of "every home".
- **B: A, plus a count on the board home,** held to the board's k-anonymity
  floor (`privacyTiers.ts:81-87`). Pros: the board sees activity. Cons: a live
  count below the floor must read "insufficient data", so it is often empty;
  not sized.
- Checked, not answered in: as FN0-Q1; also `apps/web/src/shared/pilotRoleRouting.ts`.

## 7. Sources read, and what was not

- Read at `348e126d`: the files cited above; in
  `docs/current/OWNER_DECISIONS.md`, the entries named in section 1 (each at
  the lines cited) and OD-2026-10-10-003, OD-2026-10-21-001 and -002;
  `docs/current/ATTENDANCE_PRECEDENCE.md`; `W4_SIZING.md` section 3.
- Searched (a search, not a full read): `OWNER_DECISIONS.md`, `docs/research/`,
  `docs/current/ACTIVE_WORK.md`, `ORGANIZATION_ROLE_MODEL.md` and
  `AUTH_CONTRACT.md`, for presence, check-in, wall, minors, guardian, shared
  tablet, board, staff and volunteer terms. No ruling found contradicts Q3.1
  to Q3.5.
- Not read: `docs/AI_COLLABORATION.md`; the paired TV route's own file
  (`/api/pilot/tv/session`; its board is read from `wallDisplay.ts` and
  `wallDisplayDb.ts`); any screen, staging or production. Not run: any test.
- Line numbers in `W4_SIZING.md` section 3 were read at `a4b420c`; some have
  moved (for example the register copy, `sessionRunAthletes.ts:171` there, is
  `:182-187` here). This file cites `348e126d` throughout.

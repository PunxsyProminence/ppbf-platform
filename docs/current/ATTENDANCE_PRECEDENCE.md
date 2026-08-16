# Attendance precedence (CT-13)

Status: **RESOLVED IN CODE** — precedence declared, reconciliation view shipped,
guard test in place. This document is the written half of that decision.

CT-13 was filed as "two attendance tables with no precedence, every
funder-facing and board-facing participation figure at double-count risk."
This is the finding that resolves it. Two things in the original ticket turned
out to be wrong, and one of them is good news.

---

## Headline: no funder-facing number is currently double-counted

**Nothing reported to a funder or the board is wrong today from this defect.**

The reason is narrow and worth stating exactly, because it is luck rather than
design: **no shipped query reads more than one attendance table.** Every
consumer picked one source and stayed on it. The double-count was a real risk
that had not yet been realised, not an error already in a report.

Every non-test reference to the three tables, checked individually:

| Consumer | Reads | Cross-source? |
|---|---|---|
| `attendanceReporting.ts` (admin dashboard, #122/#173) | `scheduler_attendance` only | No |
| `app/api/pilot/admin/export/roster` (CSV export) | `scheduler_attendance` only | No |
| `app/api/pilot/scheduler/attendance-summary` | `scheduler_attendance` only | No |
| `wallDisplayDb.ts` | `scheduler_attendance` only | No |
| `schedulerDb.ts` | `scheduler_attendance` only (sole writer) | No |
| `performanceAnalytics.ts` | `activity_log` only, deliberately | No |
| `passbook.ts` | `attendance` only | No |
| `intake.ts`, `intake/domain-get`, `intake/domain-upsert`, `intake/review-action` | `attendance` only (sole writer) | No |

Three files name more than one table; none of them queries across them:
`performanceAnalytics.ts` and `activityLog.ts` name the others in header
comments explaining why they abstain, and `privacyTiers.ts` lists all three in
`PUBLIC_RANKING_FORBIDDEN_TABLES`, which is a ranking prohibition, not a sum.

The one exported figure that reaches paper is `Attendance rate` in the roster
CSV. It is single-sourced from `scheduler_attendance`, and further restricted
to marks backed by a live `scheduler_registrations` row. It is internally
consistent. It answers **"of the classes this athlete was registered for and
marked in, what share were present"** — a class-attendance rate, not an
athlete-day participation count. Anyone quoting it to a funder as "days
attended" would be misreading it, but the number itself is not double-counted.

## Correction to the ticket: there are three tables, not two

CT-13 names `pilot.attendance` and `pilot.scheduler_attendance`.
`pilot.activity_log` is a third attendance-shaped table, it is the newest, and
it is the only one with the constraint this whole problem is about.

| | `pilot.attendance` | `pilot.scheduler_attendance` | `pilot.activity_log` |
|---|---|---|---|
| Grain | athlete-day (claimed) | athlete-class | person-occurrence |
| Uniqueness | **none at all** | `unique (org, class_id, athlete_id)` | `unique (org, person, occurred_on, domain, class_id, started_at)` |
| Status vocabulary | free text, unconstrained | `present\|absent\|excused` | `present\|absent\|excused` |
| Who marked it | not recorded | `method`, `checked_in_by_role`, `checked_in_by_account_id` | `capture_method`, `recorded_by_role`, `recorded_by_account_id` |
| Date column | `attendance_date date` | derived from `scheduler_classes.start_at` | `occurred_on date` |
| Written by | intake case flow only | scheduler check-in | `activityLog.ts` |
| Scope | boxing only | boxing classes only | boxing + schoolwork + service + work-study |

## The real defect is inside `pilot.attendance`, not only between tables

`pilot.attendance` has a primary key of `(organization_id, attendance_id)`
where `attendance_id` is a fresh `randomUUID()` per insert. There is **no
unique constraint on `(organization_id, athlete_id, attendance_date)` and no
unique index anywhere**. Marking the same athlete present on the same day
twice produces two rows, and nothing refuses it.

That makes any `count(*)` over that table an over-count in the presence of
duplicates, without any second table being involved. `passbook.ts` does
exactly this today for `recorded_absences_since_last_visit`. That figure is
coach-facing, not funder-facing, so this is a real but contained correctness
issue rather than a reporting-integrity one.

Its `status` column is also unconstrained free text. `passbook.ts` reads it as
`lower(trim(status)) in ('present','late')` — `'late'` is a value the other two
tables cannot express at all. The defensive `lower(trim(...))` is itself
evidence that the values were never trusted to be clean.

## The decision

**`pilot.activity_log` is the athlete-day system of record.**
**`pilot.scheduler_attendance` is the class-session detail that feeds it.**
**`pilot.attendance` is frozen legacy history — readable, never authoritative.**

### Why this differs from the ledger's recommendation

CT-13 recommends `pilot.attendance` as the athlete-day system of record. That
recommendation should not be followed, for four reasons:

1. **It has no unique constraint.** A table that permits unlimited duplicate
   athlete-days cannot be the authority on how many athlete-days there were.
   This is disqualifying on its own and cannot be retrofitted safely — see
   "What this deliberately does not do" below.
2. **Its status vocabulary is unconstrained free text**, so two rows saying
   `'Present'` and `'present'` are different values to the database.
3. **It records no capture evidence.** Who marked a child present, and by what
   method, is safeguarding evidence. `scheduler_attendance` and `activity_log`
   both carry it; `pilot.attendance` carries none.
4. **It is not fed by the live floor.** Its only writer is the intake case
   flow (`intake.ts`). The gym's actual check-in path writes
   `scheduler_attendance`, and the go-forward path writes `activity_log`.

This is also the direction the owner has already recorded. `ACTIVE_WORK.md`'s
`BACKLOG-activity-log-backfill` reads: *"Legacy attendance sources cannot
support a trustworthy synthetic history. Do not invent a backfill.
`pilot.activity_log` is go-forward evidence."* Declaring `activity_log`
authoritative follows existing owner policy rather than inventing new policy.

### Precedence order, for one athlete on one day

1. `pilot.activity_log` where `activity_domain = 'boxing_training'` and
   `athlete_id is not null`
2. `pilot.scheduler_attendance`, collapsed to a day via the class start time
3. `pilot.attendance` (legacy)

Highest available source wins outright. Lower sources are **not added to** it.

## The reconciliation view

`pilot.attendance_reconciled` — exactly one row per
`(organization_id, athlete_id, attendance_date)`, no matter how many rows the
underlying tables hold for that day.

It exposes `source` (which table won) and `contributing_sources` (how many of
the three had anything to say about that athlete-day), so disagreement is
visible rather than silently resolved. A day where all three sources have a row
still produces **one** row here — that is the entire point.

`class_marks_that_day` carries the number of class-level marks behind the day,
so "attended 2 classes on Tuesday" is still answerable without ever letting
that number inflate a participation count.

### Timezone

`scheduler_attendance` has no date column; its day is derived from
`scheduler_classes.start_at`, which is `timestamptz`. The view converts to the
gym's own timezone (`America/New_York`) before taking `::date`. Taking `::date`
in UTC would push any class starting after 8pm ET onto the following calendar
day and quietly misattribute it. This mirrors the rule `gymTimeDrift.test.ts`
already enforces on the front end.

## What this deliberately does not do

- **Does not drop, truncate, or alter either legacy table.** Both hold real
  records.
- **Does not retrofit a unique constraint onto `pilot.attendance`.** Adding a
  unique index to a table that may already contain duplicate athlete-days
  fails at apply time against real data, and "make it pass" would mean deleting
  rows. The view de-duplicates on read instead; the underlying rows stay
  exactly as they are.
- **Does not backfill.** `BACKLOG-activity-log-backfill` is parked by the owner
  and this change does not disturb that.
- **Does not change any existing consumer.** Every current reader keeps its
  current source and its current numbers. The view is additive, for the KPI
  layer that has not been built yet.

## The guard

`attendancePrecedence.test.ts` scans source and fails if any single SQL
statement references more than one attendance table, or if a new consumer
reads a legacy table without going through the view. The failure mode this
protects against is silent: a well-meant `UNION ALL` across two attendance
tables type-checks, passes review, and produces an inflated participation
figure that looks plausible. A test is the only thing that catches it.

## Open for the owner

- The roster CSV's `Attendance rate` column is a **class-attendance rate**, not
  an athlete-day participation rate. If that file is sent to funders, the
  column heading is worth renaming so it cannot be read as days attended. Not
  changed here: renaming an exported column changes a file someone may already
  be reconciling against, which is the owner's call rather than mine.
- Whether the ~coach-facing `recorded_absences_since_last_visit` in
  `passbook.ts` should be switched to the view. Left alone here because
  changing a shipped coach-facing number is outside CT-13's scope, and its
  inflation only occurs where duplicate rows exist.

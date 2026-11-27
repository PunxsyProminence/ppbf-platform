# Audit test record cleanup — `cleanup-audit-test-records`

Pilot blocker B6: audit walks left test classes (with their sign-ups and attendance), notes and TVs in the
real gym, and test gyms beside it. This workflow **reports** them, by explicit markers only (`mode`
dry-run, the default), and with `mode` apply acts on a reviewed report, one run at a time, each with
Jason's word (production data).

Rulings: OD-2026-10-11-009 item 2 (Jason "2A", remove them); OD-2026-10-13-012 H-2 A ("hiit fit" closed
only as an empty duplicate, its contents shown to him first). App Overwatch's GO, QR and QS answers on
#2227 set the markers, the kinds and the keyed references.

## What it reports

- **Markers.** STRICT: the text starts with exactly `ZZ-AUDIT` or `AUDIT TEST` (case as written, no
  trimming), then the end of the text or an ASCII character that is not a letter or digit (so
  `AUDIT TESTING`, `ZZ-AUDIT2`, and a marker followed by any non-ASCII character, a no-break space
  included, are not STRICT). Only STRICT records are planned. NEAR (`zz-audit` anywhere, or `audit test` first after any whitespace, any case, not STRICT)
  is reported and never planned.
- **`classes`** (K1): STRICT-titled classes. Each has its registrations, attendance, tied runs and
  register marks, rows that name it with no foreign key, its audit-row count, `distinct_athletes`, and
  `apply_would_refuse`: `TIED_RUN_LIVE`, `CLASS_RUNNING_NOW`, `UNTRACKED_REFERENCE`,
  `UNKNOWN_FOREIGN_KEY` or `KNOWN_FOREIGN_KEY_MISSING`.
- **`tvs`** (K2): `marked` (STRICT-named) and `others` (every other TV in scope, NEAR or unmarked). Both
  carry the same fields: ids, marker, pairing and revocation dates, and session and pair-code state. Only
  `marked` is planned.
- **`test_organizations`** (K3): status, `members_by_role` and `rows_by_table`.
- **`hiit_fit`** (K4, id `danielles` and name "hiit fit"): `found_id`, `name_matches` (with the note
  "id found, name differs" when it does), status, `rows_by_table`, `holding_tables` (the tables it holds
  rows in; `organizations` and `audit_events` do not count) and `apply_would_refuse` (`NAME_DIFFERS`,
  `NOT_EMPTY`).
- **`sweep`** (K5): every text column of every `pilot` table: table, column, key, organization, marker.
  With `--organization`, a table with no `organization_id` column is skipped and listed in
  `tables_skipped_no_organization_column`; run `ALL_ORGANIZATIONS` to sweep those. Also
  `columns_not_swept_by_type` (arrays and json), `truncated_tables` (more than 500 matching rows; STRICT
  rows first) and `tables_failed` (a sweep table that could not be read, by error code).
- **`plan_fingerprint`**: sha256 over the markers and STRICT rule, the scope, the `kinds` when the run names
  them (sorted), and these raw values:
  - each STRICT class (id, title, status, start and end, whether it is running now, whether an
    `activity_log` or `floor_plans_daily` row names it), every registration and attendance row on it (ids,
    athlete ids, statuses), its tied runs (id, state) and register marks, and any unknown or missing
    foreign key;
  - each STRICT TV (id, pairing and revocation times, whether it shows a session or holds a pair code);
  - each test gym and "hiit fit" in scope (status, whether the name matches) and, for "hiit fit", the
    names of the tables it holds rows in.

  It leaves out, on purpose: live sessions (they move with every login; the apply revokes whatever is live
  when it runs, and counts them); how many rows "hiit fit" holds (whether it holds any decides K4's
  refusal, so the table names are in); members, rows per table and audit history of the test gyms and
  classes, and a TV's last-seen time (report only; they move routinely and would make a reviewed plan go
  stale); and the sweep (report only). An apply re-reads the plan with its rows locked and refuses unless
  the fingerprint, with its kinds, is the one App Overwatch and Jason reviewed. With no kinds the value is
  B6-1's.

**Never printed:** any record's text (titles, names, notes, TV names) and any raw person id. Person ids
and keys that are not class, run, TV or organization ids or non-person uuids print as a reference, an
HMAC-SHA256 under the `PPBF_AUDIT_TEST_CLEANUP_REF_KEY` secret (first 12 hex). `"person_ref"` says
`environment key` or, with no secret set, `per-run key`: references then group one person's rows within
that report but cannot be tied to an id by anyone.

## Running it (App Overwatch)

1. **The secret, once.** Ask Jason to set `PPBF_AUDIT_TEST_CLEANUP_REF_KEY` in the `staging` and
   `production` environments (QR answer). Make it at least as strong as the per-run key the script makes
   for itself, 32 random bytes (for example `openssl rand -hex 32`), and use it for nothing else: anyone
   who learns it can test guessed ids against the public log. Until it exists, read the counts only.
2. **Staging:** `target` staging, `organization` `ALL_ORGANIZATIONS`. Smoke test; check `counts`,
   `tables_failed` empty, `person_ref`.
3. **Production, the gym:** `target` production, `organization` the real gym's id. The job waits for the
   production environment's approval.
4. **Production, everything:** the same with `ALL_ORGANIZATIONS`, for the Audit Test Gyms, "hiit fit",
   the other gyms' marked rows and the tables step 3 skipped.
5. **Report to Jason:** for each planned class, its date, status, `distinct_athletes` and refusals; with
   the key, whether every reference on it is the test athlete's; the TVs; the test gyms' status; what
   "hiit fit" holds; the sweep's STRICT and NEAR counts by table; and the fingerprints.

**Locks.** Do not dispatch while a migration of the same target runs. The first read (K1 to K4) is one
read-only snapshot. For the seconds it lasts it holds read locks on the tables it reads directly (the
class tables, `activity_log`, `floor_plans_daily`, `gym_tvs`, `organizations`,
`organization_memberships`, `audit_events`) and, with a test gym or "hiit fit" in scope, on every table
with an `organization_id`. A migration that needs one of those tables waits for it. If one of them is
locked elsewhere for more than 10 seconds, the whole run fails (`audit_test_cleanup.failed`, code
`55P03`) and prints no plan; dispatch again later. The sweep reads each table in its own short
transaction: a sweep table locked for more than 10 seconds is listed in `tables_failed`, and the rest of
the report stands.

**Where it runs.** The `launch` job decides, as `session-token-cleanup.yml`'s does (lane DBT,
OD-2026-11-17-008). With the repository variable `PPBF_AZURE_DB_RUNNER` set to `true` and a dispatch
from `main`, `cleanup` runs on a single-use runner inside Azure, which the database firewall admits;
otherwise on GitHub's runner, where a job GitHub places on AWS stops at the database preflight
(`PROBE_TIMEOUT`, as the first staging attempt did, run 46000784632).
- **Before the first Azure run:** the runner image must carry this job's line in
  `infra/gh-runner/allowed-jobs.txt`. Its guard refuses any job not baked into the image, so rebuild
  (`build-runner-image`) and roll (`IMAGE` in `azure-runner.conf`, then `resources.sh create --apply`), as
  `infra/gh-runner/README.md` says. Until then leave the variable unset for this workflow's runs, or
  expect the job to be refused.
- **The runner stops an hour after it starts** (`REPLICA_TIMEOUT_SECONDS` 3600). `launch` starts it
  before the production approval is asked for, so the approval and the run (up to 30 minutes) must fit in
  that hour: dispatch production when the approver is ready.
- **Re-run with "Re-run all jobs"**, never "Re-run failed jobs": `cleanup` alone would wait for that
  attempt's runner, which is gone. If an approval came too late, cancel the run and dispatch again.

## Applying it (App Overwatch, with Jason's word for each run)

1. **Dry run first**, on the exact scope the apply will use (`target` and `organization`) and naming the
   kinds it will apply (`kinds`, comma separated, no spaces). The dry run Jason sees must name those kinds:
   its `plan` and result line print them, and its fingerprint binds them. Get his word for this run.
2. **Dispatch** with `mode` apply, the same `target`, `organization` and exactly those `kinds`,
   `confirm_delete` `DELETE AUDIT TEST RECORDS`, and `expected_fingerprint` the dry run's
   `plan_fingerprint`. Other kinds, or a change to anything the fingerprint covers (above), refuses with
   `PLAN_FINGERPRINT_MISMATCH` and writes nothing. The refusal prints only the fingerprint it expected:
   dry-run again, and have the new plan reviewed.
3. **One kind group per run**, as App Overwatch chooses. What each kind writes, in one transaction:
   - `classes` (Q1 A): deletes every STRICT class in scope with its attendance and registrations. Its tied
     runs and register marks are kept, with the tie cleared (the foreign keys' SET NULL). Refused
     (`CLASS_APPLY_REFUSED`, naming each class and why) while any planned class has an
     `apply_would_refuse`.
   - `tvs` (Q5 A): the app's own Disconnect on every STRICT TV in scope that is still connected (not
     revoked, or showing a session, or holding a pair code). The row stays; it leaves the coaches' list 7
     days later. A STRICT TV already disconnected is left as it is and listed in
     `tvs_already_disconnected`; it alone does not count its gym as affected.
   - `test-organizations` (Q3 B): only with `organization` an Audit Test Gym's id. Sets it inactive and
     revokes its live sessions (the app's `setOrganizationStatus`). Never a delete. Setting every Audit
     Test Gym inactive leaves none for a future write-audit; it can be set active again from the platform
     desk.
   - `hiit-fit` (Q4 A): only with `organization` `danielles`, and only while "hiit fit" holds no row
     (`HIIT_FIT_APPLY_REFUSED` with `NOT_EMPTY` or `NAME_DIFFERS` otherwise; `holding` names the tables it
     holds rows in, with their counts and nothing else). Inactive, as above.
   - The sweep (K5) and every NEAR record are never written, in any mode.
4. **Read the result.** `audit_test_cleanup.applied` gives the kinds, the fingerprint, the counts written
   (`classes`, `registrations`, `attendance`, `tied_runs_untied`, `register_marks_untied`, `tvs`,
   `tvs_already_disconnected`, `sessions_revoked`), the class and TV ids, and the organization set
   inactive. Each affected
   organization gets one `audit_events` row (`entity_type` `audit_test_record_cleanup`; `data_purged`
   where classes were deleted, otherwise `update`). `nothing-to-apply` means the kinds asked for had
   nothing planned; nothing was written. Any other refusal (`UNKNOWN_TRIGGER`, `WRITE_COUNT_MISMATCH`,
   `END_STATE_MISMATCH`, ...) rolled everything back.
5. **Dry-run again** on the same scope and kinds. What changes, per kind:
   - `classes`: the deleted classes are gone from `classes`, with their sign-ups and attendance.
   - `tvs`: the TVs stay in `tvs.marked`, now with `revoked_at` set and no session or pair code. Their
     revocation time is in the fingerprint, so another `tvs` apply needs this fresh dry run's fingerprint.
     It then leaves them alone: `nothing-to-apply`, no write and no audit row, with them listed in
     `tvs_already_disconnected` (a gym with other STRICT TVs still connected gets its own audit row for
     those only).
   - `test-organizations` and `hiit-fit`: the organization stays listed, with status `inactive`.

**Locks.** The apply locks, for its transaction and before it reads the plan:
- the planned classes and the rows hanging off them, the STRICT TVs, and a named organization's row
  (`FOR UPDATE`, which also holds back any insert whose foreign key on `organization_id` names that
  organization) and its live sessions;
- with `classes`: the whole of `activity_log` and `floor_plans_daily` (`SHARE`: reads go on, writes
  wait), since they name a class with no foreign key;
- with `hiit-fit`: the whole of every organization table no such key holds back (no foreign key on
  `organization_id` whose columns are all `NOT NULL`, not deferrable, to a `pilot` table's
  `organization_id`). The list is read from the catalog at run time; on the full schema today it is
  `recording_sessions`, `shadow_evidence_claims`, `shadow_evidence_items`, `shadow_message_citations` and
  `video_sessions`. A row there could otherwise join "hiit fit" with no lock on its organization row.

So no row can come to name a planned class or join "hiit fit" between the plan and the commit; writes to
those tables wait for the seconds the apply lasts.
Dispatch it outside class hours. After its writes it re-reads the end state (for `hiit-fit`, every table
with an `organization_id`) and rolls back on any difference. It refuses if any trigger it does not know
exists on a table it writes.

**Target.** The script's target guard is RR-1's (`scripts/lib/postgres-write-target.mjs`): it refuses a
connection whose host or database is not the declared one. The declared target is the environment's
`PPBF_EXPECTED_POSTGRES_HOSTNAME` and `PPBF_EXPECTED_POSTGRES_DATABASE` vars when they are set, and
otherwise the host and database of the same connection string, so then the target rests on the container
app and resource group the workflow picks for `target`.

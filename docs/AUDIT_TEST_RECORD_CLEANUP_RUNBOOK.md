# Audit test record report — `cleanup-audit-test-records`

Pilot blocker B6: audit walks left test classes (with their sign-ups and attendance), notes and TVs in the
real gym, and test gyms beside it. This workflow **reports** them, by explicit markers only. It writes
nothing: the apply, with Jason's word for each run, comes in lane W5-B6's B6-3.

Rulings: OD-2026-10-11-009 item 2 (Jason "2A", remove them); OD-2026-10-13-012 H-2 A ("hiit fit" closed
only as an empty duplicate, its contents shown to him first). App Overwatch's GO, QR and QS answers on
#2227 set the markers, the kinds and the keyed references.

## What it reports

- **Markers.** STRICT: the text starts with exactly `ZZ-AUDIT` or `AUDIT TEST` (case as written, no
  trimming), then the end or a character that is not a letter or digit. Only STRICT records are planned.
  NEAR (`zz-audit` anywhere, or `audit test` first after any whitespace, any case, not STRICT) is
  reported and never planned.
- **`classes`** (K1): STRICT-titled classes. Each has its registrations, attendance, tied runs and
  register marks, rows that name it with no foreign key, its audit-row count, `distinct_athletes`, and
  `apply_would_refuse`: `TIED_RUN_LIVE`, `CLASS_RUNNING_NOW`, `UNTRACKED_REFERENCE`,
  `UNKNOWN_FOREIGN_KEY` or `KNOWN_FOREIGN_KEY_MISSING`.
- **`tvs`** (K2): `marked` (STRICT-named, with pairing and session state) and `others` (ids and dates only).
- **`test_organizations`** (K3) and **`hiit_fit`** (K4, id `danielles` and name "hiit fit"): status,
  members by role and rows per table. `hiit_fit` says "id found, name differs" when it does, and lists the
  tables it holds rows in (`holding_tables`; `organizations` and `audit_events` do not count).
- **`sweep`** (K5): every text column of every `pilot` table: table, column, key, organization, marker.
  Also `columns_not_swept_by_type` (arrays and json), `truncated_tables` (over 500 hits; STRICT first)
  and `tables_failed` (a table that could not be read, by error code).
- **`plan_fingerprint`**: over everything a later apply would act on or refuse on. An apply will refuse
  unless the plan it reads has this fingerprint.

**Never printed:** any record's text (titles, names, notes, TV names) and any raw person id. Person ids
and keys that are not class, run, TV or organization ids or non-person uuids print as a reference, an
HMAC-SHA256 under the `PPBF_AUDIT_TEST_CLEANUP_REF_KEY` secret (first 12 hex). `"person_ref"` says
`environment key` or, with no secret set, `per-run key`: references then group one person's rows within
that report but cannot be tied to an id by anyone.

## Running it (App Overwatch)

1. **The secret, once.** Ask Jason to set `PPBF_AUDIT_TEST_CLEANUP_REF_KEY` in the `staging` and
   `production` environments (QR answer). Until it exists, read the counts only.
2. **Staging:** `target` staging, `organization` `ALL_ORGANIZATIONS`. Smoke test; check `counts`,
   `tables_failed` empty, `person_ref`.
3. **Production, the gym:** `target` production, `organization` the real gym's id. The job waits for the
   production environment's approval.
4. **Production, everything:** the same with `ALL_ORGANIZATIONS`, for the Audit Test Gyms, "hiit fit" and
   the other gyms' marked rows.
5. **Report to Jason:** for each planned class, its date, status, `distinct_athletes` and refusals; with
   the key, whether every reference on it is the test athlete's; the TVs; the test gyms' status; what
   "hiit fit" holds; the sweep's STRICT and NEAR counts by table; and the fingerprints.

Do not dispatch while a migration of the same target runs: with a test gym in scope the first read holds
read locks on every organization table for the seconds it lasts. A table locked by something else for
more than 10 seconds is listed in `tables_failed`, and the rest of the report stands.

The target guard is the same as RR-1's (`scripts/lib/postgres-write-target.mjs`): the script refuses a
connection string whose host or database is not the declared one.

# Intake research-requirement cleanup — `cleanup-intake-research-requirements`

Until PR #1122 (2026-10-03) every athlete intake upload also wrote a `pilot.shadow_research_requirements`
row whose text carried the uploaded file's name, often a child's. That table is listed on `/research`
to every organization role. #1122 stopped new rows; this tool deletes the old ones.

Rulings: OD-2026-10-02-015 D4 (athlete intake files stay out of research); OD-2026-10-03-002
section 1 ("Delete them all": a read-only count first, then Jason's word for each run).

## What it deletes

- Every row tagged `source_event_name = 'SHADOW_UPLOAD_CLASSIFIED_AND_ROUTED'` **and**
  `source_entity_type = 'shadow_intake'` (the pair the removed insert wrote), open and resolved, in
  the organization named at dispatch or in all organizations (`ALL_ORGANIZATIONS`).
- The `pilot.shadow_research_submissions` rows linked to those rows (the foreign key would cascade
  them anyway; they are deleted first and counted).
- Nothing else: no other tag, no text match, no other table. One `pilot.audit_events` row
  (`event_type = 'data_purged'`, `entity_type = 'intake_research_requirement_cleanup'`) in each
  affected organization, holding the fingerprint, counts and ids.

It prints ids, counts, organizations, open/resolved split, the created_at range and the
`plan_fingerprint`. It never prints a row's text, metadata or subject.

## Running it (Overwatch)

Dispatch the `cleanup-intake-research-requirements` workflow:

1. `target` staging, `organization` `ALL_ORGANIZATIONS`, `mode` dry-run. Smoke test of the workflow;
   read `counts`, `by_organization` and `plan_fingerprint`.
2. `target` production, same `organization`, `mode` dry-run. This is the read-only production count.
   Report to Jason: the total, the open/resolved split, the per-organization counts, the linked
   submissions and the fingerprint. If he wants resolved rows kept, stop: the tool has no such option
   and needs a change first.
3. On Jason's word for that run: `target` production, the **same** `organization`, `mode` apply,
   `confirm_delete` = `DELETE INTAKE RESEARCH REQUIREMENTS`, `expected_fingerprint` = the fingerprint
   from step 2. The job runs in the `production` environment, where Jason approves it in GitHub.
4. A production dry run with the same `organization`: `counts.requirements` 0.

The target guard is real only when the staging and production GitHub environments carry
`PPBF_EXPECTED_POSTGRES_HOSTNAME` and `PPBF_EXPECTED_POSTGRES_DATABASE`; they were absent until
2026-11-09 17:07Z and are set in both now (`gh variable list --env`, checked 2026-11-09). Without them the workflow derives both
from the connection string it checks, as `repair-research-baseline.yml` does.

Staging may be applied the same way first if Overwatch wants a rehearsal on a real database; the CI
suite `cleanupIntakeResearchRequirements.pg.test.ts` is the rehearsal otherwise.

## What the fingerprint protects

It is sha256 over the scope, the tag, every planned row (id, organization, status) and every linked
submission. The apply re-reads the rows with them locked and refuses (`PLAN_FINGERPRINT_MISMATCH`,
before its first delete) unless that reading gives the fingerprint Jason approved. So a row added,
removed, moved between organizations or flipped between open and resolved since the dry run, or a
different `organization` input, stops the run instead of deleting something he did not see counted.
The apply also refuses if a delete removes a different number of rows than planned or if any tagged
row is left in scope, and commits only after those checks.

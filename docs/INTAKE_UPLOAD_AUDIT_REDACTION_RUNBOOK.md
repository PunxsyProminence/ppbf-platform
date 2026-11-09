# Intake upload audit redaction — `redact-intake-upload-audit`

Until PR #1122 (2026-10-03) every athlete intake upload also wrote a `pilot.audit_events` row of
`event_type = 'shadow_research_upload_requirement'` whose `details.research_requirement` copied the
uploaded file's name, often a child's: "Review <type> (<file name>) and validate routing to
<queue>." (`git show 40df6e742^`, `shadow.ts` `buildUploadResearchFields`). #1897 deletes the
research rows themselves; this tool removes the name from the matching audit rows and keeps the rows.

Rulings: Jason 2026-11-09, "Redact the names"; behind it OD-2026-10-02-015 D4 and OD-2026-10-03-002
section 1. Overwatch, applying it (2026-11-09): `research_requirement` only, because it was the only
key that carried the name; `details.knowledge_gap` was a fixed sentence per classification and stays.

## What it changes

- Rows: `event_type = 'shadow_research_upload_requirement'`, `details->>'source_event_name' =
  'SHADOW_UPLOAD_CLASSIFIED_AND_ROUTED'`, `details->>'source_entity_type' = 'shadow_intake'`, no
  `redacted_at` key yet; in the organization named at dispatch or in all organizations
  (`ALL_ORGANIZATIONS`, which also takes a row with no organization). Never a text match.
- In each: `details.research_requirement` becomes
  `[redacted 2026-11-09: intake file name; Jason 2026-11-09 'Redact the names']`, and
  `redacted_at` (ISO UTC) and `redacted_fields` (`["research_requirement"]`, or `[]` for a row without
  that key) are added. Every other key stays byte for byte; the apply checks that in the database
  before it commits.
- Not touched: any other event_type. The upload's other audit rows (`shadow_classification`,
  `shadow_routing`) never held the name (`git show 40df6e742^`). The name also sits outside
  `pilot.audit_events` (the intake tables, `pilot.shadow_events` payloads,
  `pilot.shadow_authority_checks` metadata); this ruling does not cover those.
- One `pilot.audit_events` row (`event_type = 'update'`, `entity_type = 'audit_details_redaction'`,
  `entity_id` = the organization, or `no-organization`) per affected organization, holding the
  fingerprint, counts, the redacted audit_ids and the ruling.

It prints audit_ids, counts, organizations, the created_at range and the `plan_fingerprint`. It never
prints a details value.

## Running it (Overwatch)

Dispatch the `redact-intake-upload-audit` workflow:

1. `target` staging, `organization` `ALL_ORGANIZATIONS`, `mode` dry-run. Smoke test of the workflow.
2. `target` production, same `organization`, `mode` dry-run. The read-only production count; it also
   runs in the `production` environment, so it waits for the same GitHub approval. Report to Jason:
   `counts` (in scope, already redacted, all rows of the event type), `by_organization`, the
   created_at range and the fingerprint.
3. On Jason's word for that run: `target` production, the **same** `organization`, `mode` apply,
   `confirm_redact` = `REDACT INTAKE UPLOAD AUDIT ROWS`, `expected_fingerprint` = the fingerprint from
   step 2. The job runs in the `production` environment, where Jason approves it in GitHub.
4. A production dry run with the same `organization`: `counts.in_scope_unredacted` 0.

Order against #1897's cleanup does not matter: that tool selects only from
`pilot.shadow_research_requirements`; each tool's own record row in `pilot.audit_events` is outside the
other's selection.

## What the fingerprint protects

It is sha256 over the scope, the selection, the marker and every planned row (audit_id, organization,
whether it has `research_requirement`). The apply re-reads the rows with them locked and refuses
(`PLAN_FINGERPRINT_MISMATCH`, before any write) unless that reading gives the fingerprint Jason
approved. It also refuses if the update touches a different number of rows than planned, if any row
in scope is left unredacted, or if any other key of a planned row changed, and commits only after
those checks. The CI suite `redactIntakeUploadAudit.pg.test.ts` is the rehearsal.

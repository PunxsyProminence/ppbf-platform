# SHADOW research intake import

The verified PPBF boxing-learning and gym-operations research package is stored at:

`apps/web/seed-data/shadow-research/2026-08-07`

It contains the original ten research artifacts and database-ready seed data for:

- 1,214 library sources
- 14 synthesis documents
- 1,193 claim-level retrieval chunks
- 30 capability coverage records
- 229 open research requirements

## Safety boundaries

The importer is dry-run by default and writes only when `--apply` is supplied. A live run also requires the operator to declare the expected PostgreSQL hostname and database. The importer refuses missing organizations, missing or inactive accounts, non-privileged accounts, cross-tenant actors, cross-tenant ID collisions, malformed CSV/JSON/array fields, changed row counts, broken package references, and post-import count mismatches.

New evidence is not automatically trusted. Database defaults leave sources and documents at `pending_review` and `unverified`. The importer neither approves evidence nor generates embeddings.

## Local validation

From `apps/web`:

```bash
PPBF_ORG_ID=<organization-id> \
SEED_ACCOUNT_ID=<privileged-account-id> \
npm run seed:shadow:research:dry
```

The validation succeeds without a database connection. Expected output ends with `SHADOW RESEARCH DRY-RUN PASS` and the five expected row counts.

## Database migration

Apply the read-only triage view through the normal migration workflow or locally:

```bash
AZURE_POSTGRES_CONNECTION_STRING=<connection-string> \
PPBF_EXPECTED_POSTGRES_HOSTNAME=<hostname> \
PPBF_EXPECTED_POSTGRES_DATABASE=<database> \
npm run pilot:apply-research-triage-view
```

The view uses `security_invoker=true`, so it does not acquire the view owner's privileges.

## Import

From `apps/web`:

```bash
PPBF_ORG_ID=<organization-id> \
SEED_ACCOUNT_ID=<privileged-account-id> \
AZURE_POSTGRES_CONNECTION_STRING=<connection-string> \
PPBF_EXPECTED_POSTGRES_HOSTNAME=<hostname> \
PPBF_EXPECTED_POSTGRES_DATABASE=<database> \
npm run seed:shadow:research -- --apply
```

The five table loads and their post-import verification run in one transaction. Any failure rolls back the full import. Re-running is idempotent on the package IDs and the research-requirement natural key.

The GitHub Actions workflow `.github/workflows/import-shadow-research.yml` provides the same process for staging or production. Apply mode requires the target to be retyped and the phrase `IMPORT RESEARCH` to be entered exactly. Production environment protection rules apply normally.

## Make the evidence retrievable

After import:

1. A qualified evidence reviewer verifies and approves selected sources/documents in `/admin/shadow`.
2. Run the existing `pilot:backfill-chunk-embeddings` process with the same embedding deployment used by SHADOW retrieval.
3. Confirm approved sources, indexed documents, and non-null chunk embeddings before enabling citations.
4. Review `EVIDENCE_TIER_SPEC.md` separately. This integration deliberately does not change `shadowEvidenceTier.ts`.

Medical clearance, concussion decisions, youth safety, safeguarding, weight cutting, contact clearance, and eligibility remain human decisions regardless of research status.

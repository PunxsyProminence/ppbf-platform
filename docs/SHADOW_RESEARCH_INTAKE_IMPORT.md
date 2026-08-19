# SHADOW research intake import

This document covers the deterministic import of a **derived GitHub research corpus** into the SHADOW Library. It does not define original-file custody or replace the governed Microsoft archive.

Start with [SHADOW_RESEARCH_ARCHITECTURE.md](SHADOW_RESEARCH_ARCHITECTURE.md) for the controlling archive, provenance, taxonomy, and source-of-truth boundaries.

## Source layers

The research system deliberately separates three layers:

1. **Governed originals and provenance** — `admin@punxsyprominence.org / OneDrive / Library Intake`, using `_CONTROL`, R00, R01-R19, and R98.
2. **Reviewer-facing evidence reference package** — `apps/web/seed-data/research-evidence/2026-08-07/`; this package is not loaded into the database.
3. **Loadable SHADOW corpus** — `apps/web/seed-data/shadow-research/2026-08-07/`; this is the current importer's default seed directory.

The repository also contains `apps/web/seed-data/shadow-research/2026-08-08/`. Its Penn State and multidiscipline integration artifacts remain proposed/reference material unless a separate approved import and runtime verification establishes a later state.

Presence in Microsoft, Google Drive, GitHub, or a seed directory does not by itself make evidence citable.

## Current loadable package

`apps/web/seed-data/shadow-research/2026-08-07/` contains database-ready seed data for:

- 1,214 library sources
- 14 synthesis documents
- 1,193 claim-level retrieval chunks
- 30 capability coverage records
- 229 open research requirements

These are derived records. Licensed publisher PDFs remain in the governed internal Microsoft archive and must not be committed to public GitHub.

## Safety boundaries

The importer is dry-run by default and writes only when `--apply` is supplied. A live run also requires the operator to declare the expected PostgreSQL hostname and database. The importer refuses missing organizations, missing or inactive accounts, non-privileged accounts, cross-tenant actors, cross-tenant ID collisions, malformed CSV/JSON/array fields, changed row counts, broken package references, and post-import count mismatches.

New evidence is not automatically trusted. Database defaults leave sources and documents at `pending_review` and `unverified`. The importer neither approves evidence nor generates embeddings.

Importing does not:

- prove the original archive object exists;
- verify source provenance;
- establish duplicate or lineage status;
- index documents;
- generate embeddings;
- approve or verify sources/documents;
- resolve a research requirement;
- adopt PPBF methodology;
- change SHADOW algorithm or safety policy.

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

## Make imported evidence retrievable

Import is only the first stage. Retrieval requires all of the following:

1. Generate chunk embeddings with the same embedding deployment used by SHADOW retrieval. Repeat the existing `pilot:backfill-chunk-embeddings` process until no eligible chunks remain.
2. Index each document so `ingest_state = 'indexed'` and `index_completed_at` is populated.
3. A qualified evidence reviewer verifies and approves selected sources and documents in `/evidence`.
4. Confirm active, non-suppressed sources; approved/verified sources and documents; indexed documents; and current-model, non-null chunk embeddings before claiming citations are live.

The SHADOW Library reads the requesting organization's approved shelf plus the reserved `__platform__` baseline. The governed archive is upstream custody; it is not a competing retrieval authority.

## Ongoing research intake

The bulk importer is not the finished ongoing source-intake workflow. New research should flow through:

```text
governed original archive
    -> provenance and duplicate/lineage review
    -> SHADOW Library source registration as pending/unverified
    -> optional research-requirement link in /research
    -> document processing, chunking, and embeddings
    -> applicability review
    -> indexing and human evidence review in /evidence
    -> retrieval eligibility
```

The missing archive-to-SHADOW automation must be research-specific and idempotent. It may reuse authenticated PDF validation and SharePoint upload primitives, but it must preserve stable archive identity, content hash, provenance, and duplicate status. A generic upload classifier must not decide research authority or subject classification automatically.

Medical clearance, concussion decisions, youth safety, safeguarding, weight cutting, contact clearance, sparring clearance, and eligibility remain human decisions regardless of research status.

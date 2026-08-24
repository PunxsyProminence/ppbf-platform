# SHADOW research intake import

This document covers the deterministic import of a **derived GitHub research corpus** into the SHADOW Library. It does not define original-file custody or replace the governed Microsoft archive.

Start with [SHADOW_RESEARCH_ARCHITECTURE.md](SHADOW_RESEARCH_ARCHITECTURE.md) for the controlling archive, provenance, taxonomy, and source-of-truth boundaries.

## Source layers

The research system deliberately separates three layers:

1. **Governed originals and provenance.** Corrected 2026-08-24; this read
   *"proposed, unconfirmed"* and described three stores none of which were settled. The
   permanent archive is now verified, and the three are distinct on purpose:

   | | Store | What it is |
   |---|---|---|
   | **Permanent research archive** | SharePoint `/sites/PunxsyProminenceClubOperations` -> `Documents` -> `Research Archive` | **Verified 2026-08-24.** Physically contains `_CONTROL`, `R00`, `R01`-`R19`, `R98`. Drive and item identity in `SHADOW_RESEARCH_ARCHITECTURE.md` §1.0. This is what open, owner-authored [issue #345](https://github.com/PunxsyProminence/ppbf-platform/issues/345) meant by SharePoint, and #345 remains the durable contract. |
   | **Temporary migration source** | OneDrive `admin@punxsyprominence.org / Library Intake/` | Still the working/migration source, mirroring the same taxonomy. Its listing rests on a 2026-08-19 agent-connector observation with no artifact in this repository. **Migration is not complete** — the prior inventory states its recursive enumeration is not exhausted. |
   | **Generic intake uploader** | Configurable generic SharePoint destination, defaulting to `PPBF/Intake` (`apps/web/src/server/document-intake/sharepoint.ts`; the path comes from `SHAREPOINT_FOLDER_PATH`) | A third thing again, and the *only* Microsoft destination this repository's code writes to. It is a configurable general uploader, not the research archive, and it decides no research authority or subject classification. |

   **Custody is not citability.** A document living in the permanent archive is not
   admissible SHADOW evidence and does not resolve a research requirement. The gate chain
   in §3 of the architecture document is unchanged, and the research-specific
   archive-to-SHADOW automation described in §7 below still does not exist.
2. **Reviewer-facing evidence reference package** — `apps/web/seed-data/research-evidence/2026-08-07/`; this package is not loaded into the database.
3. **Loadable SHADOW corpus** — `apps/web/seed-data/shadow-research/2026-08-07/`; this is the current importer's default seed directory.

The repository also contains `apps/web/seed-data/shadow-research/2026-08-08/`. **This importer
cannot load it**: it supplies only one of the five required seed files, and `EXPECTED_COUNTS`
would reject it on row counts even if the rest were present. As a SHADOW research corpus it is
unimported and unloadable.

That is not the same as "nothing in the package is live". The package's warm-up-decay stop rule
reached the operational drill seed by a different route — `seed_drill_stop_rules.csv`, loaded by
`npm run seed:drill-library` — on a separate, recorded 2026-08-08 owner decision. See
[SHADOW_RESEARCH_ARCHITECTURE.md](SHADOW_RESEARCH_ARCHITECTURE.md) §8 for the full provenance.

Presence in Microsoft, Google Drive, GitHub, or a seed directory does not by itself make evidence citable.

## Current loadable package

`apps/web/seed-data/shadow-research/2026-08-07/` contains database-ready seed data for:

- 1,214 library sources
- 14 synthesis documents
- 1,193 claim-level retrieval chunks
- 30 capability coverage records
- 229 open research requirements

These are derived records, and "derived" is doing real work: the chunk rows carry licensed
publisher **content** as extracted claim text. Whole publisher PDFs stay in the governed archive
and must never be committed here — but the absence of `.pdf` files in this repository is not
evidence that licensed content is absent from it. Govern by content, not by file extension.
This is a private repository; that is why the extracts are currently tolerable, not why they are
unlimited.

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

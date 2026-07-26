# Dual-track athlete import package (code-only, sanitized)

Prepared in an isolated worktree/branch off `origin/agent/shadow-trust-foundation @ e73829f`, without touching the active Codex worktree or the previously-checked-out branch. Contains no real personal, financial, or military data. See the top-level final report (delivered in chat, not committed) for the full status writeup.

## Files

| File | Deliverable |
|---|---|
| `schema.ts` + `schema.test.ts` | Reusable dual-track athlete configuration schema |
| `henryMapping.fixture.ts` + `henryMapping.fixture.test.ts` | Sanitized example fixture (opaque IDs, synthetic values only) |
| `sourceManifest.ts` + `sourceManifest.test.ts` | Source-classification and deduplication manifest schema |
| `dryRunImporter.ts` + `dryRunImporter.test.ts` | Dry-run-only importer/validator (never opens a DB connection) |
| `privacyClassification.ts` + `privacyClassification.test.ts` | The four-tier classification model and its allowed destinations |
| `MAPPING.md` | Schema/API mapping to existing tables and routes |
| `ACCESS_CONTROL_MATRIX.md` | Role × classification access matrix |
| `SOURCE_INVENTORY.md` | **Blocked** — no SharePoint/Drive connector available this session |
| `../../../../../infra/azure/drafts/pilot_slice_postgres_dual_track_migration.sql` | Draft additive migration — **not applied anywhere** |

## Hard guarantees this package enforces in code, not just policy

- `planDualTrackImport` never opens a database connection or issues a write — passing `dryRun: false` throws unconditionally.
- No record kind or destination table lets the importer create a new `pilot.athletes` row — identity is always the caller-supplied existing `athlete_id`; a missing one throws before any record is processed.
- `admin_restricted`-classified content is rejected unconditionally, regardless of destination — because no destination in the current schema keeps it out of ordinary coach/SHADOW-chat reach.
- Undated "current" measurements and target-as-result records are rejected, not silently accepted.

## Known blocker

Source discovery (Microsoft/Google) could not be performed — no connector tool was available in this session. See `SOURCE_INVENTORY.md`.

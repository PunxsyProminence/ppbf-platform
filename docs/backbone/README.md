# Backbone spec and design source

The PPBF training backbone was built in OneDrive (`PPBF-AI-Lanes\Research\Backbone`) and frozen there as an archive on 2026-11-10 (Backbone cards PK-202 and PK-203, both option A). From the freeze on, this repository is the only live copy (Backbone RULES section 2, folded into `docs/current/OWNER_DECISIONS.md` as OD-2026-11-10-001). These are the spec and design files the hand-off lanes build to. Paths approved with the hand-off package (Backbone Q-210, PK-202).

## Files

Each file is the frozen file byte for byte. The hash is the first 16 hex characters of its sha256, as in the archive's `FREEZE_MANIFEST.json` (itself `38b52df4c2d8d7a1`).

| File here | Path in the archive | sha256[:16] | Bytes |
|---|---|---|---|
| `SCHEMA_PROPOSAL.md` | `docs/SCHEMA_PROPOSAL.md` | `c68afab55d0fce63` | 23,507 |
| `entities.schema.json` | `working/design-2026-10-25/entities.schema.json` | `1c4e1074721b7fe1` | 39,411 |
| `DATA_MODEL.md` | `working/design-2026-10-25/DATA_MODEL.md` | `dbc226d028a6825a` | 27,150 |
| `EVIDENCE_VOCABULARY.md` | `working/design-2026-10-25/EVIDENCE_VOCABULARY.md` | `2fa1a4b6f993ee51` | 11,712 |
| `DECISION_REGISTER.json` | `working/drift/DECISION_REGISTER.json` | `ff49eba2369e1c3d` | 516,873 |
| `HANDOFF_NOTE.md` | `working/repo-handoff-2026-11-10/HANDOFF_NOTE.md` | `9acfadec7bc62fb9` in the archive; `1891093bfeef9d47` here | 14,784 |

`HANDOFF_NOTE.md` differs from the archive by one character: section 2 said the 1,509 catalog errors are named in section 4 "items 3 and 7"; it is items 3 and 8 (1,406 + 101 + 2). The archive copy is frozen and keeps the error.

## Reading them

- The first line of each file, "Status: DRAFT, not app source until handoff (RULES.md)", is kept as written. What those lines become after the hand-off was not ruled.
- "This folder", "the Backbone folder" and relative paths such as `data/` or `working/` inside these files mean the OneDrive archive, not this repository.
- Later changes are made here, by pull request. A changed file no longer matches its archive hash; say so in the pull request that changes it.
- Not in the repository: the content records (`data/`, 616 files) and `design_catalogs.json`, which reach the app only through the exporters and the content-package intake, with every research `quote` and `quotes` key dropped (Backbone Q-208; OD-2026-10-02-013); the manuals; `DECISION_CHECKS.md` and the rest of the archive.
- `RULES.md` is not a file here. Its sections 0 to 11 are in OD-2026-11-10-001, and "backbone RULES section N" anywhere in this repository means section N of that entry.

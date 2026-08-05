# Backup & Restore Runbook

## What already exists

There is a real, verified backup mechanism today. This document does not introduce one — it
consolidates what `.github/workflows/backup.yml` and `scripts/backup-export.ps1` already do into
a single place, and adds the drill checklist neither of those is the right place to hold.

| | Automated | Manual |
|---|---|---|
| Where | `.github/workflows/backup.yml` | `scripts/backup-export.ps1` |
| When | Nightly, 07:10 UTC, plus on-demand `workflow_dispatch` | On demand, from a machine with the connection string |
| Scope | Whole `pilot` schema (`pg_dump --schema=pilot`) | Same |
| Verified | Yes — decompressed and row-counted against the live database before upload | Yes — same verifier (`pilot-export-verify-dump.mjs`) |
| Stored | Private Azure Blob container `ppbf-pilot-backups`, path `pilot-schema/<target>/<year>/<month>/` | Local file, default `~/ppbf-backups` |
| Retention | 90 days, never fewer than 14 backups regardless of age | Operator's own disk |
| Needs Azure access to restore from | Yes | No — this is the point of it |

Both refuse to run against a database nobody explicitly named (`PPBF_EXPECTED_POSTGRES_HOSTNAME`
/ `PPBF_EXPECTED_POSTGRES_DATABASE`), for the same reason every migration runner does: a shell
holding a production connection string is one copy-paste away from acting on the wrong
environment.

## Restore procedure

The dump is plain SQL (`--format=plain --no-owner --no-privileges`), not a custom-format
archive, specifically so restoring never depends on matching a `pg_restore` version to the one
that produced it:

```bash
gunzip -c pilot-<target>-<stamp>.sql.gz | psql <destination connection string>
```

Run this against an **empty** database — the dump does not `DROP` anything first, so replaying
it into a database that already has a `pilot` schema will collide on every `CREATE`. To restore
into a fresh environment:

1. Provision a new Postgres flexible server (or an empty database on an existing one).
2. Run `psql <destination> -c "CREATE SCHEMA IF NOT EXISTS pilot;"` if the dump's `CREATE SCHEMA`
   statement is not present (it is, by default `pg_dump` behavior, but confirm before assuming).
3. `gunzip -c <dump> | psql <destination>`.
4. Run `apps/web/scripts/pilot-export-verify-dump.mjs verify` against the *restored* database
   (not the dump file) to confirm the row counts match what the dump's own verification step
   recorded in that backup run's job summary.
5. Point the application at the restored database and re-run the smoke checks in
   `docs/PRODUCTION_READINESS.md` before serving real traffic from it.

To get the dump itself:
- **From automated backups**: download the blob from `ppbf-pilot-backups` in the Azure Portal, or
  `az storage blob download --container-name ppbf-pilot-backups --name <blob path>`. Blob paths
  are recorded in the `backup` workflow's run summary under Actions.
- **From a manual export**: it is already a local file — see the `-OutputDirectory` you ran
  `backup-export.ps1` with (default `~/ppbf-backups`).

## What this does not cover

- **Point-in-time recovery.** This is a nightly full dump, not continuous WAL archiving — the
  recovery point objective is "as of last night's 07:10 UTC run," not "as of the last committed
  transaction." If Azure's own flexible-server point-in-time restore is enabled separately, that
  is a shorter RPO for infrastructure-level failure; it is not tracked in this repository and
  should be confirmed against the Azure Portal, not assumed.
- **Blob storage account loss.** The backups live in the same Azure subscription as the database
  they protect. A subscription-level incident affecting both is not mitigated by this runbook —
  if that risk matters, an operator should periodically pull a manual export
  (`backup-export.ps1`) to storage outside Azure entirely.
- **Anything before this workflow existed.** There is no backup for data written before the
  `backup` workflow first ran successfully.

## Restore drill checklist

A backup nobody has restored from is a hypothesis, not a plan. Run this at least once against
**staging**, never production, and record the result below.

- [ ] Pick a recent staging backup blob (or run `backup.yml` with `target: staging` to make one).
- [ ] Provision a scratch Postgres database — not staging's real one — to restore into.
- [ ] Time the restore from `gunzip -c ... | psql ...` start to completion.
- [ ] Run `pilot-export-verify-dump.mjs verify` against the restored database; confirm every
      table's row count matches the source backup run's job summary.
- [ ] Confirm the application boots against the restored database and a login round-trips
      (any seeded test account is enough — this is checking connectivity and schema shape, not
      re-running the full smoke suite).
- [ ] Record the wall-clock time here, so "restore within X hours" is a measured number the next
      time someone asks, not a guess:

  | Date | Backup size (compressed) | Restore time | Verified by |
  |---|---|---|---|
  | _(fill in after first drill)_ | | | |

- [ ] Tear down the scratch database. Nothing from a restore drill should be left reachable.

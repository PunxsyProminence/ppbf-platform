# Multi-Organization Rollback Runbook

## Objective
Provide a controlled rollback path for multi-organization rollout if critical defects are observed.

## Rollback trigger conditions
- Cross-organization data exposure confirmed.
- Authentication/authorization outage affecting pilot endpoints.
- Severe migration regression impacting core workflows.

## Critical note
The additive migration introduces new tables and organization ownership columns. Full data rollback is not always lossless if new multi-org records are written after cutover.

## Rollback strategy
1. Application rollback first.
   - Revert service deployment to last known good build.
2. Database mitigation second.
   - Prefer forward-fix where possible.
   - Avoid destructive table drops in emergency response windows.

## Emergency application rollback
1. Redeploy prior stable artifact.
2. Re-run smoke tests for legacy behavior.
3. Disable platform-owner organization lifecycle endpoints if needed.

## Database rollback options

### Option A: Forward-fix preferred
- Keep new schema.
- Apply targeted patches for failing checks/policies.
- Re-verify boundaries.

### Option B: Hard rollback (high risk)
Use only if approved and backed up.
- Restore database from pre-migration backup snapshot.
- Redeploy pre-multi-org app build.
- Reconcile data created after migration window separately.

## Migration action to rollback mapping

Reference migration actions in [infra/azure/pilot_slice_postgres_multiorg_migration.sql](infra/azure/pilot_slice_postgres_multiorg_migration.sql).

### Step 1: Add organization columns to existing tables
- Action:
   - Add `organization_id` (and `is_platform_owner` where applicable).
- Preferred rollback:
   - Do not drop columns in emergency windows.
   - Revert application to pre-multi-org build and leave additive columns in place.
- Hard rollback path:
   - Restore pre-migration snapshot.

### Step 2: Seed bootstrap organization
- Action:
   - Insert `ppbf-default-org`.
- Preferred rollback:
   - Keep bootstrap org row; harmless in backward app mode.
- Hard rollback path:
   - Snapshot restore.

### Step 3: Backfill organization ownership
- Action:
   - Update null `organization_id` values to bootstrap org.
- Preferred rollback:
   - Keep backfilled values and run forward-fix if mapping errors are found.
   - Correct rows via targeted updates using captured migration logs.
- Hard rollback path:
   - Snapshot restore.

### Step 4: Seed organization memberships
- Action:
   - Insert/upsert from `pilot.accounts` to `pilot.organization_memberships`.
- Preferred rollback:
   - Keep membership rows and disable multi-org endpoints if needed.
   - Correct role assignments via targeted updates.
- Hard rollback path:
   - Snapshot restore.

### Step 5: Set NOT NULL and foreign keys
- Action:
   - Enforce `organization_id` constraints and FK relationships.
- Preferred rollback:
   - If constraints cause runtime failures, drop the specific failing FK/NOT NULL constraint and keep data.
   - Re-run smoke gate after each targeted mitigation.
- Hard rollback path:
   - Snapshot restore.

### Step 6: Organization-scoped uniqueness changes
- Action:
   - Drop legacy uniqueness where present.
   - Add org-scoped unique indexes.
- Preferred rollback:
   - If index conflicts occur, drop the new unique index and apply targeted deduplication/fix scripts.
   - Recreate index after correction.
- Hard rollback path:
   - Snapshot restore.

### Step 7: Add organization access indexes
- Action:
   - Create org-scoped performance indexes.
- Preferred rollback:
   - Drop only problematic indexes if needed (no data loss).
   - Recreate in low-load window.
- Hard rollback path:
   - Snapshot restore.

## Rollback command checklist per incident

1. Roll back application artifact first.
2. Disable high-risk endpoints if required.
3. Apply step-specific DB mitigation from mapping above.
4. Run smoke tests to confirm containment.
5. Escalate to snapshot restore only if containment fails.

## Data safety requirements
- Snapshot before migration.
- Snapshot after migration.
- Preserve audit evidence from incident window.

## Incident response checklist
- Capture failing requests and affected endpoints.
- Capture query evidence showing scope breach or failure.
- Record timestamped mitigation actions.
- Document final root cause and preventive changes.

## Re-entry after rollback
- Reproduce issue in staging.
- Patch and verify with multi-org gate.
- Re-plan deployment window.

# Multi-Organization Smoke Test Plan

## Scope
Validate critical multi-organization behaviors after migration and deployment.

## Runtime prerequisites
- App endpoint available.
- PPBF_PILOT_BOOTSTRAP_KEY configured.
- Database migrated with multi-org schema.

## Automated smoke gate
- Script: [apps/web/scripts/pilot-multiorg-gate.mjs](apps/web/scripts/pilot-multiorg-gate.mjs)
- Command: npm --prefix apps/web run gate:pilot:multiorg

## Manual verification checklist

### Platform Owner
- Can create organization.
- Can assign organization admin.
- Can activate/suspend organization.
- Cannot access organization-private athlete endpoint.

### Organization Admin
- Can create athlete in own organization.
- Can reset account PIN in own organization.
- Can revoke sessions in own organization.
- Cannot access data from other organizations.

### Isolation checks
- Same athlete_id can exist in multiple organizations.
- Reads return records only from caller organization.
- Audit events include organization_id.

### Auth checks
- Session response includes organization_id.
- Inactive/suspended org accounts denied login (non-platform-owner).

## Exit criteria
- Automated gate passes.
- No cross-org exposure observed.
- Core pilot operations functional in each organization.

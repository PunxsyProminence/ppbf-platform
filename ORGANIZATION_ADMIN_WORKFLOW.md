# Organization Admin Workflow

## End-to-end registration workflow

1. Platform Owner (Jason Neale) creates organization.
2. Platform Owner assigns organization admin.
3. Organization is activated.
4. Organization admin receives access.
5. Organization admin creates users (coaches, athletes, parents, volunteers, staff).
6. System automatically stamps organization ownership for every created record.

## Platform Owner workflow

### Create organization

Inputs:

- organization name
- organization type
- contact email
- contact phone
- subscription status

Result:

- organization record created with pending or active status.

### Assign organization admin

Inputs:

- user identifier
- target organization_id

Result:

- membership role set to organization_admin for that organization.

### Activate/deactivate organization

Result:

- organization status toggled
- user login/operations for that organization gated by status

### Platform analytics access

Platform Owner dashboards should expose aggregate-only metrics:

- total organizations
- total athletes
- total coaches
- attendance trends
- usage metrics
- adoption metrics
- anonymous benchmark metrics

## Organization Admin workflow

### User management actions

- create coach
- create athlete
- create parent
- create volunteer
- create staff
- reset credentials
- activate/deactivate organization users

All actions are restricted to own organization.

### Data operations

- view organization data
- manage organization-private records

Cross-organization operations are denied.

## Permission boundary requirements

Organization admins and downstream roles cannot access another organization.

Platform Owner never opens an individual athlete record: it sees de-identified, aggregate data only, and no delegated or support-pass route exists (OD-2026-09-28-005; enforcement in [ORGANIZATION_ROLE_MODEL.md](ORGANIZATION_ROLE_MODEL.md#enforcement-model)). Individual records are reached by signing in with the organization's own admin account.

## Audit requirements

Every organization lifecycle and membership action should emit an audit event including:

- actor id
- actor role
- organization_id
- action type
- timestamp

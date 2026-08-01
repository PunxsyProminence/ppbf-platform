# PPBF Platform

A nonprofit, safety-first training and development platform for boxing/combat
sports gyms, built on Next.js (App Router) with a PostgreSQL backend. Supports
multiple organizations (gyms) with strict data isolation, role-based
workspaces for athletes, coaches, parents, board members, and admins, and
SHADOW, an AI assistant that provides evidence-based training guidance.

See [MASTER_INDEX.md](MASTER_INDEX.md) for the full documentation map.

## Quick Start

```bash
npm install
```

Configure `apps/web/.env.local` with your Azure credentials
(`AZURE_POSTGRES_CONNECTION_STRING`, `AZURE_STORAGE_CONNECTION_STRING`,
`PPBF_PILOT_BOOTSTRAP_KEY`) — see
[DEVELOPER_ONBOARDING.md](DEVELOPER_ONBOARDING.md) for the full list.

```bash
cd apps/web
npm run pilot:apply-schema   # apply the pilot.* Postgres schema
npm run pilot:preflight      # verify environment/config
npm run gate:pilot           # run the pilot readiness gate
npm run dev                  # start the app
```

## Key Architecture

- **Multi-organization isolation**: every organization-owned record carries
  `organization_id`; roles and access are scoped per organization except for
  Platform Owner (see [ORGANIZATION_ARCHITECTURE.md](ORGANIZATION_ARCHITECTURE.md)).
- **Roles**: `platform_owner`, `organization_admin`, `admin`, `board`,
  `coach`, `athlete`, `parent`, `volunteer`, `staff` — see
  [ORGANIZATION_ROLE_MODEL.md](ORGANIZATION_ROLE_MODEL.md).
- **Auth**: opaque session tokens over HTTP-only cookies, plus Microsoft
  sign-in for staff/board roles — see [AUTH_CONTRACT.md](AUTH_CONTRACT.md).
- **SHADOW**: an Azure OpenAI-backed assistant with doctrine filtering,
  evidence citation, and a boxing-metrics formula engine. Strictly
  educational, never diagnostic.

## Development

- `npm run typecheck` / `npm run lint` / `npm test` from the repo root run
  against the `web` workspace.
- Data seeding: [SEED_GUIDE.md](SEED_GUIDE.md).
- Database migrations are applied only by the controlled operator scripts
  (`npm run pilot:apply-*`), run either from an operator's shell or from the
  manually dispatched `apply-migrations` workflow. No HTTP route changes the
  schema, and no push, merge, or deploy applies a migration as a side effect.

## Status

Active pilot. See [MASTER_INDEX.md](MASTER_INDEX.md)'s currency warning —
verify current behavior against `origin/main`, not a local branch.

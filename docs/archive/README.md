# Archive — historical material only

Everything in this folder is a point-in-time snapshot. Nothing here is
current implementation authority. Verify any claim against current `main`
and current tests before acting on it. Do not load this directory for
ordinary development.

Two traps worth naming so old prose is not mistaken for the real system:

- `TENANT_ARCHITECTURE`'s `tenant_id` model was never adopted. The shipped
  isolation model uses `organization_id` (see the `pilot.*` schema and
  `apps/web/src/server/pilot/contracts.ts`).
- The 2026-07-13 "REALITY_BASED" planning set describes a Microsoft
  Dataverse backend that was never built. The shipped backend is Postgres
  (`pilot.*`) via `apps/web/src/server/pilot/*`.

Full history for every archived document is in git.

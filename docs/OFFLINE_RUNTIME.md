# PPBF offline runtime

Run a full local schema plus synthetic demo data:

```text
npm --workspace web run offline -- --reset --port 3111
```

Open `http://127.0.0.1:3111`. The seeded accounts cover every current account
role: `offline-owner`, `offline-admin`, `offline-program-admin`,
`offline-coach`, `offline-athlete`, `offline-parent`, `offline-volunteer`, and
`offline-staff`; all use the synthetic PIN `246810`.

## Lifecycle

The launcher is scoped to the checkout that started it. Two worktrees can run
replicas at the same time; `stop` and `status` never target another checkout.

```text
npm --workspace web run offline -- --port 3111
npm --workspace web run offline -- status
npm --workspace web run offline -- stop
npm --workspace web run offline -- restart --port 3111
```

`--reset` deletes and recreates only this checkout's `.ppbf-offline/` directory.
It cannot be combined with `stop` or `status`.

The launcher writes `.ppbf-offline/runtime-state.json` with the worktree path
and process ids. `stop` kills those processes, then on Windows also sweeps
processes whose command line both contains this checkout path and an offline
runtime marker (`offline-runtime.mjs`, `.ppbf-offline`, `.next-offline`, or
`embedded-postgres`). It does not match a hardcoded machine path.

## Safety boundary

The launcher supplies its own loopback PostgreSQL string, disables TLS only
for that embedded database in `NODE_ENV=development`, clears the configured
Azure/Google/Microsoft/Azure AI/payment credentials, disables Next telemetry,
and starts Node with `offline-network-guard.cjs`. The guard rejects all
non-loopback outbound sockets and HTTP(S) requests before an external client
can send a request. Consequently the offline instance cannot write to
production or an external service; its only writable service is its own local
Postgres cluster.

Next still discovers `apps/web/.env.local` by its normal precedence rules, but
the launcher overrides every runtime value it uses and the network guard
remains the final boundary. It never modifies that file.

## Inventory: production-to-local gaps closed here

| Production dependency | Existing gap | Offline handling |
| --- | --- | --- |
| Azure PostgreSQL | The app requires `AZURE_POSTGRES_CONNECTION_STRING`; default TLS rejects embedded Postgres. | Embedded PostgreSQL with every checked-in migration; `PPBF_OFFLINE_RUNTIME=true` in development is the sole local TLS exception. |
| Windows database encoding | The host default was Windows-1252, while checked-in migrations include UTF-8. | The local cluster is initialized explicitly with UTF-8. |
| Azure Blob Storage | Profile, video, credential, and SHADOW blob paths expect a configured Azure service. | Configuration is blank and non-loopback calls are rejected. |
| Microsoft/Google/OAuth, Azure AI, payments | These features are configured from environment values and may call external providers. | Credentials are cleared and the process-level guard blocks every external socket/request. |
| Existing normal dev server | Next's default `.next` directory conflicted with an active app server. | Offline mode uses `.next-offline` only. |
| Real tenant data and sessions | The live app has no portable local fixture. | One synthetic organization, five role personas, one synthetic athlete, a goal, and a session; the normal local PIN login flow remains in use. |
| Multiple local checkouts | A process killer keyed to one machine path would stop the wrong replica, or fail to stop this one. | Start/stop/status match this checkout's path and write state under its `.ppbf-offline/`. |

The runtime intentionally does not simulate an external provider, and it does
not claim that empty synthetic fixtures exercise every role-specific screen.
Those screens run against the complete local schema and can be populated only
with further synthetic records.

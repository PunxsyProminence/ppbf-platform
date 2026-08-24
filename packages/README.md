# packages/ — legacy, unwired code

Every directory under `packages/` is legacy code with no runtime consumers:
no `package.json` (not real npm workspaces despite the root workspaces glob),
zero imports from `apps/web`, and no `@ppbf/*` consumers anywhere. Live
functionality — including portals and the real safety/clearance path
(`apps/web/src/server/pilot/contactClearanceGate.ts`) — lives in `apps/web`.

Do not extend anything here without an explicit decision. Evidence:
`docs/PLATFORM_AUDIT_2026-08-17_FULL_SPECTRUM.md`.

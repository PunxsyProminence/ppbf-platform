# PPBF Developer Onboarding Guide

## Step 1: Clone and Setup
git clone https://github.com/PunxsyProminence/ppbf-platform.git
cd ppbf-platform

## Step 2: Install
This is an npm workspace — install from the repository root, never from
`apps/web`:

    npm ci

(The `.ps1` scripts under `scripts/` are legacy Windows helpers, not part of
the supported setup path. The checks that matter are the npm ones in Step 5.)

## Step 3: Environment
Copy `.env.example` from the repository root to `apps/web/.env.local` and fill
in the Azure pilot values. Only the names are in the template -- no filled
environment file is ever committed, because apps/web/.gitignore ignores
`.env*`.

    cp .env.example apps/web/.env.local

Values for a pilot machine can be read from the staging Container App:

    az containerapp secret list --name app-ppbf-staging \
      --resource-group rg-ppbf-enterprise-staging --show-values -o tsv

The authoritative list of what a running instance is given is the
`--set-env-vars` block in .github/workflows/deploy-staging.yml. Locally you need
at least:

Required -- apps/web/src/server/pilot/env.ts throws without them:
- AZURE_POSTGRES_CONNECTION_STRING
- AZURE_STORAGE_CONNECTION_STRING

Pilot identity and bootstrap:
- PPBF_PILOT_BOOTSTRAP_KEY
- PPBF_PILOT_DEFAULT_ORG_ID
- PPBF_PILOT_SHADOW_CONTAINER

Microsoft federated login, only to exercise /api/pilot/auth/microsoft:
- PPBF_MS_TENANT_ID
- PPBF_MS_CLIENT_ID
- PPBF_MS_CLIENT_SECRET
- PPBF_MS_REDIRECT_URI
- PPBF_MS_POST_LOGIN_PATH

SHADOW, only to exercise chat, Library search, or Film Study:
- AZURE_AI_ENDPOINT
- AZURE_AI_DEPLOYMENT_NAME
- AZURE_AI_API_VERSION
- AZURE_AI_KEY
- AZURE_AI_EMBEDDING_DEPLOYMENT_NAME
- AZURE_AI_VISION_DEPLOYMENT_NAME

Magic-link sign-in -- required in every environment real families use:
- PPBF_APP_ORIGIN (the origin sign-in links are built against: an absolute
  https URL with a host and nothing after it, e.g.
  `https://www.punxsyprominence.org`; `http://localhost:3000` for a local dev
  server. Unset logs `MISSING_PPBF_APP_ORIGIN`, any other shape logs
  `INVALID_PPBF_APP_ORIGIN:<reason>`, and in both cases magicLinkStore.ts
  refuses to send and the request route answers 503 for every address alike,
  so the fault is visible without becoming a roster-disclosure oracle. See
  .env.example's own comment on this variable.)

## Step 4: Governance
Roles, scope, and who may merge are in [AGENT_KERNEL.md](AGENT_KERNEL.md);
staging and production release work follows
[docs/AI_DELIVERY_PIPELINE.md](docs/AI_DELIVERY_PIPELINE.md). This step does
not restate them.

## Step 5: Start Development
From the repository root:

    npm run dev

Before opening a PR, run the same checks CI runs (also from the root):
`npm run typecheck`, `npm run lint`, `npm test`, `npm run build` — and
`npm run test:migrations` when SQL or persistence code changed.

## Step 6: Quick Reference
See [README.md](README.md) for the documentation hierarchy and
[apps/web/README.md](apps/web/README.md) for the full command reference.

Welcome to the PPBF platform development team.


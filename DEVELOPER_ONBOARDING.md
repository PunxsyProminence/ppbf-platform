# PPBF Developer Onboarding Guide

## Step 1: Clone and Setup
git clone https://github.com/PunxsyProminence/ppbf-platform.git
cd ppbf-platform

## Step 2: Run Setup Batches
Run scripts in order:
- .\scripts\init.ps1
- .\scripts\check-governance.ps1
- .\scripts\run-tests.ps1

For full status checks and wrap-up:
- .\scripts\final-master-status.ps1
- .\scripts\quick-reference.ps1
- .\scripts\health-check.ps1

Use .\master-runner.ps1 only when you want the top-level sequence runner.
Use .\ppbf-cli.ps1 status or .\ppbf-cli.ps1 health for quick daily checks.

## Step 3: Environment
There is no template to copy. apps/web/.gitignore ignores `.env*`, so every
environment file is written by hand and none of them are in the repository.
Create apps/web/.env.local yourself and fill in the Azure pilot values.

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

## Step 4: Governance
All development must follow Layer 0 rules. Get Jason approval before promoting anything to ACTIVE.

## Step 5: Start Development
cd apps/web
npm install
npm run dev

## Step 6: Quick Reference
Keep quick-reference.ps1 handy.
Run final-master-status.ps1 for current status.
Use backup-export.ps1 before changes.
See [MASTER_INDEX.md](MASTER_INDEX.md) for the current documentation map.

Welcome to the PPBF platform development team.


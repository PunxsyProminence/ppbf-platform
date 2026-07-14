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
Copy apps/web/.env.example to apps/web/.env.local and fill in Azure pilot credentials:
- AZURE_POSTGRES_CONNECTION_STRING
- AZURE_STORAGE_CONNECTION_STRING
- PPBF_PILOT_BOOTSTRAP_KEY

## Step 4: Governance
All development must follow Layer 0 rules. Get Jason approval before promoting anything to ACTIVE.

## Step 5: Start Development
cd apps/web
npm install
npm run dev

## Step 6: Quick Reference
Keep quick-reference.ps1 and COMPLETE_REFERENCE_GUIDE.md handy.
Run final-master-status.ps1 for current status.
Use backup-export.ps1 before changes.

Welcome to the PPBF platform development team.


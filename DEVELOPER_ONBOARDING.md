# PPBF Developer Onboarding Guide

## Step 1: Clone and Setup
git clone https://github.com/PunxsyProminence/ppbf-platform.git
cd ppbf-platform

## Step 2: Run Setup Batches
Run the batch scripts in order (Batch 1 → Batch 12), or simply run .\master-runner.ps1 or .\ultimate-summary.ps1. Use run-tests.ps1 before commits, review QUALITY_CHECKLIST.md for every change, and run it as part of pre-deploy verification. See FINAL_SUMMARY.md, PROJECT_COMPLETE.md, COMPLETE_REFERENCE_GUIDE.md and FINAL_RECOMMENDATIONS.md. New reusable components: DashboardLayout and MainNavigation from packages/portals. Use backup-export.ps1 regularly for data protection. Use quick-reference.ps1 and final-master-status.ps1 for daily ops. Try ppbf-cli.ps1 health or ppbf-cli.ps1 status. See health-check.ps1 and version.ts. Use ppbf-cli.ps1 all for quick full check. Version: packages/governance/version.ts (use getVersionInfo()). health-check.ps1 does real checks. ppbf-cli.ps1 is the recommended entry point. health-check.ps1, ppbf-cli.ps1, and version.ts added for operations and metadata. ppbf-cli.ps1, health-check.ps1, and version.ts added for operations and metadata.

## Step 3: Environment
Copy .env.example to .env.local and fill in Supabase credentials.

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


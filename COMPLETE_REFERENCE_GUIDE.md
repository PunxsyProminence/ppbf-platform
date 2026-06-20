# PPBF Platform – Complete Reference Guide

## Project Structure
- docs/                    → Master blueprint and governance rules
- packages/                → Core logic (governance, routing, execution, intelligence, continuity)
- apps/web                 → Main Next.js portal
- apps/coach-review        → Coach Review Queue
- infra/supabase           → Database schema
- Various .ps1 scripts     → Automation and governance tools

## Key Files
- PPBF_CAPABILITIES.json   → Central configuration (25 capabilities + matrices)
- README.md                → Project overview
- COMPLETE_BUILD_SUMMARY.md → Full summary of everything built
- FINAL_DOCUMENTATION.md   → Complete documentation

## How to Continue Development
1. Always run governance checks before major changes
2. Use feature flags from PPBF_CAPABILITIES.json
3. Log important actions to the Continuity Ledger
4. Respect bounded contexts
5. Get Jason approval before promoting anything to production

## Current Status
The platform is in a highly complete, governed state after 16 batches of systematic development.

You have built a professional, safety-first implementation of the original PPBF unified blueprint.

# Archive — historical snapshots, not current truth

Everything in this folder is a **point-in-time document**. It described the
platform on the day it was written and was never updated afterwards. Do not
read anything here as a description of how the system works today.

This matters more than it sounds. Most of these documents were written between
2026-06-19 and 2026-07-20, which is *before* the work that landed in PRs #12
through #28 — session expiry and revocation, the formula engine, the SHADOW
chat trust foundation, the multi-org membership model, PIN/Microsoft auth
boundaries, and the decision loop. An audit in this folder can simultaneously
contain findings that are still live and findings that were fixed weeks ago,
with nothing in the text to tell them apart.

If you need to know whether something in here is still true, check it against
`origin/main` and the deployed revision. Do not check it against a local
branch — local branches in this repo have repeatedly been many commits behind.

## What's in here

**Audits, reports, and verification snapshots** — findings as of their date.
Treat every individual finding as unverified until reconfirmed:
`AUTH_DEPENDENCY_REPORT`, `AUTH_DEPLOYMENT_VERIFICATION`, `AUTH_REFACTOR_REPORT`,
`BACKEND_TRUTH_AUDIT`, `COMPREHENSIVE_PLATFORM_AUDIT`,
`COMPREHENSIVE_USABILITY_EFFICIENCY_AUDIT`, `DEEP_AUDIT_PPBF_SHADOW_2026-07-18`,
`FRONTEND_BACKEND_AUDIT`, `FULL_PLATFORM_AUDIT_COMPREHENSIVE`,
`ORGANIZATION_IMPACT_REPORT`, `PPBF_CAPABILITY_MAP_SELF_AUDIT`,
`PPBF_CRITICAL_GAP_CLOSURE_REPORT`, `PPBF_DEPLOYMENT_ARCHITECTURE_VERIFICATION`,
`PPBF_IN_APP_TUTORIAL_SYSTEM_REPORT`, `SHADOW_AUDIT_REPORT`,
`SHADOW_MVP_HARDENING_SUMMARY`, `SQL_AUDIT_REPORT`, the `*_SMOKE_REPORT` files,
`MULTI_ORG_EXECUTION_STATUS`, `PPBF_STEP1_APPROVAL_LOCK`, `ALL_SCRIPTS_SUMMARY`.

**Plans and specs for work that has since shipped, changed, or been dropped:**
`BACKEND_SLICE_EXECUTION_SPEC`, `COMPLETE_REFERENCE_GUIDE`,
`IMPLEMENTATION_SEQUENCE`, `MOCK_TO_API_INTEGRATION_PLAN`,
`MULTI_ORG_MASTER_TODO`, `ORGANIZATION_DATABASE_PLAN`,
`ORGANIZATION_MIGRATION_PLAN`, `PHASE0_IMPLEMENTATION_SPEC`,
`PPBF_BACKEND_BUILD_PLAN_REALITY_BASED`,
`PPBF_MISSING_CAPABILITY_IMPLEMENTATION_PLAN`,
`PPBF_PROJECT_SEQUENCE_UPDATE_CAPABILITY_FIRST`,
`SHADOW_CHAT_IMPLEMENTATION_PLAN`.

**Earlier closing/summary documents** from the original build batches:
`CLOSING_RECOMMENDATIONS`, `COMPLETE_BUILD_SUMMARY`, `FINAL_RECOMMENDATIONS`,
`FINAL_SUMMARY`, `MASTER_EVERYTHING_REFERENCE`, `PROJECT_COMPLETE`,
`SESSION_WORK_SUMMARY`, `THANK_YOU_CLOSING`, `ULTIMATE_CLOSING_DOCUMENT`,
`ULTIMATE_PROJECT_SUMMARY`.

Nothing was deleted — this is a move, and full history is in git.

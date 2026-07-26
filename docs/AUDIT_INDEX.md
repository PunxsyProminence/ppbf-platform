# Audit Truth Index

Last updated: 2026-07-26

Purpose: one navigation page for current audit truth, historical reports, and stale claims that must be reverified against current source and deploy state before reuse.

## Current Truth Sources

- [BACKEND_SLICE_EXECUTION_SPEC.md](../BACKEND_SLICE_EXECUTION_SPEC.md) - current launch queue and execution ordering for the active backend slice.
- [BACKEND_TRUTH_AUDIT.md](../BACKEND_TRUTH_AUDIT.md) - evidence-only backend inventory for current repository state.
- [AUTH_DEPLOYMENT_VERIFICATION.md](../AUTH_DEPLOYMENT_VERIFICATION.md) - deployment/auth verification reference when checking runtime behavior.
- [SHADOW_PHASE1_HARDENING_CHECKLIST.md](SHADOW_PHASE1_HARDENING_CHECKLIST.md) - current SHADOW phase-1 hardening checklist.
- [SHADOW_TOTAL_TODO_EXECUTION.md](SHADOW_TOTAL_TODO_EXECUTION.md) - current SHADOW execution tracker and verification log.

## Historical Reports

These documents are useful for context, but they are not authoritative until revalidated against current source and current deploys.

- [COMPREHENSIVE_PLATFORM_AUDIT.md](../COMPREHENSIVE_PLATFORM_AUDIT.md) - historical platform-wide audit snapshot.
- [FULL_PLATFORM_AUDIT_COMPREHENSIVE.md](../FULL_PLATFORM_AUDIT_COMPREHENSIVE.md) - historical full-spectrum audit snapshot.
- [DEEP_AUDIT_PPBF_SHADOW_2026-07-18.md](../DEEP_AUDIT_PPBF_SHADOW_2026-07-18.md) - historical deep SHADOW audit snapshot.
- [SHADOW_AUDIT_REPORT.md](../SHADOW_AUDIT_REPORT.md) - historical SHADOW audit report.
- [DEEP_CRITICAL_APP_AUDIT_2026-07-18.md](DEEP_CRITICAL_APP_AUDIT_2026-07-18.md) - historical deep app audit snapshot.
- [PHASE2_HARDENING_REPORT_2026-07-18.md](PHASE2_HARDENING_REPORT_2026-07-18.md) - historical phase-2 hardening report.
- [PHASE2_PRODUCTION_VERIFICATION_2026-07-18.md](PHASE2_PRODUCTION_VERIFICATION_2026-07-18.md) - historical production verification report.
- [PHASE3_ROLE_LOGIN_AND_MINIMAL_DATA_READINESS_2026-07-18.md](PHASE3_ROLE_LOGIN_AND_MINIMAL_DATA_READINESS_2026-07-18.md) - historical readiness report with explicit NOT VERIFIED items.

## Stale Claims To Reverify

Treat the following claim families as stale until proven against current source and deployment state:

- documentation claims that say there is no CI/CD or no deployment workflow
- claims that the root test entrypoint is only simulated if the current package scripts and Jest targets say otherwise
- claims that production target selection is inferred from the resource-group name alone
- claims that announcement routes are caller-scoped when principal-scoped authorization now exists
- claims that session authority is purely client-local when the server session route is authoritative

## Revalidated In Current Session

- [apps/web/app/api/pilot/shadow/debug/route.ts](../apps/web/app/api/pilot/shadow/debug/route.ts) is currently principal-gated and role-gated; it is no longer a public debug surface.
- [apps/web/app/api/pilot/video/list/route.ts](../apps/web/app/api/pilot/video/list/route.ts) is currently principal-gated with role and athlete ownership checks.
- [apps/web/app/api/pilot/auth/session/route.ts](../apps/web/app/api/pilot/auth/session/route.ts) now supports both GET and POST and returns both provider field spellings for compatibility.
- [apps/web/app/api/pilot/admin/bootstrap/route.ts](../apps/web/app/api/pilot/admin/bootstrap/route.ts) and [apps/web/app/api/pilot/admin/migrate-multiorg/route.ts](../apps/web/app/api/pilot/admin/migrate-multiorg/route.ts) now require explicit control-plane intent headers.
- [.github/workflows/deploy-production.yml](../.github/workflows/deploy-production.yml) now hard-asserts its target app and legacy-named resource group.
- [scripts/run-tests.ps1](../scripts/run-tests.ps1) now runs real workspace test suites instead of simulated file checks, and `npm test` passes.

## Revalidation Rule

Before citing any audit report as current truth, record:

1. source SHA
2. deploy SHA
3. repository scope
4. runtime scope
5. verification command used
6. whether the finding is current, stale, or superseded

Do not rewrite historical audits in place when the goal is to preserve audit history.
Use this index to route readers to the right current source of truth.
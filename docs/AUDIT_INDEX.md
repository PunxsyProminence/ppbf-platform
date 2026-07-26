# Audit Truth Index

Status: Current authoritative index
Index date: 2026-07-26
Scope: Audit navigation and truth lifecycle (code, runtime, infrastructure)

## How to Use This Index

- Treat this file as the current entrypoint for audit evidence.
- Treat individual audit reports as time-bound snapshots.
- Do not silently rewrite historical reports; supersede them with newer evidence.

## Current Truth Sources

- BACKEND_SLICE_EXECUTION_SPEC.md
- AUTH_CONTRACT.md
- AUTH_DEPLOYMENT_VERIFICATION.md
- .github/workflows/deploy-production.yml
- scripts/run-tests.ps1

## Historical Snapshots (Revalidation Required)

- COMPREHENSIVE_PLATFORM_AUDIT.md
- FULL_PLATFORM_AUDIT_COMPREHENSIVE.md
- SHADOW_AUDIT_REPORT.md
- DEEP_AUDIT_PPBF_SHADOW_2026-07-18.md

## Finding Classification Rules

- confirmed current: reproduces on current source and/or deployed target with direct evidence
- production-only: observed only on deployed runtime and not reproducible in source-only checks
- resolved since audited checkout: no longer reproducible due to merged changes
- stale: claim refers to superseded code or workflow state
- false positive: claim contradicted by verified implementation behavior
- requires runtime verification: needs deployed artifact, environment, or workflow run evidence

## Evidence Requirements

- include exact file path and line references for code claims
- include test names and pass/fail outcomes for contract claims
- include workflow run IDs, deployed SHA/digest, and environment identifiers for runtime claims

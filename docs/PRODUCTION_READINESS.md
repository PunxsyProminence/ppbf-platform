# PPBF Production Readiness Checklist

> **Superseded — point-in-time, v21 architecture.** This checklist describes
> the Supabase-backed build that preceded the move to Azure Container Apps and
> PostgreSQL. Its checked boxes record what was true then, not what production
> runs now: there is no Supabase client, no PIN 15715 demo auth, and the
> "Batch N" numbering refers to a build sequence that ended. For current
> readiness, see [MULTI_ORG_SMOKE_TEST_PLAN.md](MULTI_ORG_SMOKE_TEST_PLAN.md)
> and the deploy workflows themselves. Kept because knowing what was claimed
> complete, and when, is worth more than a deleted file.

**Governance**: Layer 0 enforced at every step. Jason approval required for promotion.

## Completed
- [x] 25 Capabilities defined in PPBF_CAPABILITIES.json
- [x] 16 Task Dimensions + 11 Lifecycle Tags
- [x] Routing engine + Safety Gate Matrix
- [x] Coach Review Queue with live refusals
- [x] Continuity Ledger
- [x] Stakeholder portals (Athlete, Guardian, Public, Reports, Brand, Payment, Audit, Migration, Launch)
- [x] Supabase client + typed models + PPBFService
- [x] Feature flags + promotion workflow stubs
- [x] Gated Payment Service (proof + Jason approval)
- [x] Basic CI/CD pipeline
- [x] Governance Audit Tool
- [x] Legacy Migration Service
- [x] AI/ML Refusal Engine
- [x] Bounded Context Manager
- [x] Developer Onboarding Guide + API Documentation stubs
- [x] Comprehensive Test Runner (run-tests.ps1) + Code Quality Checklist (QUALITY_CHECKLIST.md) (Batch 11)
- [x] Ultimate Master Runner + Final Summary (Batch 12)
- [x] Backup/Export script + Ultimate Master Summary + Project Complete docs (Batch 14)


## Pending / Next Steps
- [ ] Deploy the Postgres schema (`cd apps/web; npm run pilot:apply-schema`)
- [ ] Connect real participant data
- [ ] Flip remaining capabilities to "active" only after Jason review
- [ ] Implement real auth + RBAC (beyond PIN 15715 demo)
- [ ] Add real PDF export / reporting
- [ ] Full end-to-end tests for safety gates
- [ ] Promote all DRAFT items

**Rule**: Nothing goes to production unless listed as ACTIVE in the Governance Audit Tool and the Go-Live checklist passes.

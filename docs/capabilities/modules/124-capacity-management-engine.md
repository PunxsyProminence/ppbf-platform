# Module 124 — Capacity Management Engine

| Field | Value |
|-------|-------|
| Status | **DONE** (Wave 9 slice promotion) |
| Vertical slice | per-class seat cap + waitlist enforcement inside the scheduler; a broader capacity console is future work |
| Active | false |
| Promotion required | true |
| Category | Class / Program Management (`classProgramManagement`) |
| Source | `2.0.0-draft-merged` |
| Parent original-25 | _unmapped_ |

## Intent
_One paragraph: what this module owns and what it must never do._

## Boundaries
- Does **not** auto-approve progression, medical, or board decisions.
- Does **not** expose athlete-level data to board / public aggregates without suppression rules.
- Does **not** invent metrics that are not stored by the platform.

## Dependencies
- Upstream: 
- Downstream: 
- Related original-25 capability: 

## Acceptance criteria
- [ ] Data model / tables named
- [ ] API surface listed (or explicitly none)
- [ ] Roles that may read / write
- [ ] Safety / refusal cases
- [ ] Audit events
- [ ] UI surface or "API-only"

## Implementation notes
_Scaffold only. Do not mark active until promotion review._

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | scaffold-script | Stub created from PPBF_CAPABILITIES.json |
| 2026-08-15 | wave9-reconciliation | Reconciliation audit: PARTIAL coverage — POST class-creation validates capacity (1-200); role-gated writes; registration path checks capacity/waitlist. Missing: Real capacity-enforcement and waitlisting exists for class scheduling with role gates and org isolation, but this is a narrow per-class seat cap embed. Evidence: apps/web/app/api/pilot/scheduler/route.ts; apps/web/src/server/pilot/schedulerDb.ts. Status stays DRAFT. |
| 2026-08-16 | wave9-reconciliation | Owner decision 2026-08-16: narrow-but-real slices promote per the playbook rule (DONE means slice shipped in code), with the slice line naming exactly what exists. Evidence: apps/web/app/api/pilot/scheduler/route.ts; apps/web/src/server/pilot/schedulerDb.ts. Test: apps/web/app/api/pilot/scheduler/route.test.ts exercises class capacity and registration/waitlist behavior |

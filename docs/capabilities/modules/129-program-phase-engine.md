# Module 129 — Program Phase Engine

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Status note | Was "DONE (slice shipped 2026-08-16)" until 2026-10-16. startPhase/endPhase (programPhases.ts,101) behind GET/POST/PATCH route and /admin/program-phases page |
| Code | `apps/web/app/api/pilot/admin/program-phases/route.ts`, `apps/web/app/admin/program-phases/page.tsx`, `apps/web/src/server/pilot/programPhases.ts` |
| Tests | `apps/web/app/api/pilot/admin/program-phases/route.test.ts`, `apps/web/app/admin/program-phases/page.test.tsx`, `apps/web/src/server/pilot/programPhases.pg.test.ts` |
| Vertical slice | `pilot.program_phases`: human-declared blocks per program (name, focus, start, optional end) with ONE OPEN PHASE per program enforced by partial unique index; starting a new phase closes the previous the day before, keeping history intact. Staff read, admin declares; audited. `/admin/program-phases`. Phases carry no athlete ids and change nothing about any athlete. Future work: surfacing the active phase as context on session and planning surfaces. |
| Active | false |
| ManualVerification | PENDING_SIGN_OFF |
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
| 2026-08-16 | claude-session | Slice shipped: a phase is a STATED intent, never computed or recommended -- nothing here infers a block from data or applies one to an athlete. One open phase per program is a database fact; closed phases keep their dates so past sessions retain the context they actually happened in; a new phase cannot begin before the phase it replaces. Promoted per playbook rule with ManualVerification PENDING_SIGN_OFF. |
| 2026-09-29 | Claude (housekeeping round 3) | ManualVerification row added: PENDING_SIGN_OFF, meaning built, not yet tried by a person (OD-2026-09-29-002, 9a). It moves to SIGNED_OFF only on Jason's word; how to try it is in docs/capabilities/SIGN_OFF_WALKTHROUGH.md. The 2026-08-16 entry above named PENDING_SIGN_OFF but wrote no row, and no SIGNED_OFF was recorded for this module on 2026-08-28. |
| 2026-10-16 | Claude (lane L32) | Status set to **DONE** under the 2026-10-16 status vocabulary (DONE / MAPPED / CLAIMED-NO-CODE / DRAFT; Overwatch GO). Was "DONE (slice shipped 2026-08-16)". Code and Tests rows added; the capability status check in CI reads them. ManualVerification unchanged. |

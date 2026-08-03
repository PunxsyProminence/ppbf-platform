# Module 152 — Incident Report Engine

| Field | Value |
|-------|-------|
| Status | **DONE** |
| Active | false |
| ManualVerification | PENDING_SIGN_OFF |
| Parent original-25 | 11 Safety / 194 Escalation |
| Vertical slice | incident report create/list for staff (no public) |

## Intent
Staff can file and list incident reports linked to an athlete (or org-only). Not public. May relate to 194 escalations but stays a separate record.

## Boundaries
- Does not publish incidents to public portal.
- Does not auto-set safety gate (use 003 manually).
- Does not show incident narrative on board aggregates.

## Vertical slice
1. Find existing incident/compliance violation paths or add minimal create/list
2. Staff create: athlete_id optional, summary/code, status
3. Staff list org-scoped
4. Audit on create
5. Tests: public/athlete cannot list all incidents

## Checklist (manual) — REQUIRED FOR SIGN-OFF
- [ ] Staff can create
- [ ] Staff can list
- [ ] Public cannot access
- [ ] ManualVerification=PASSED

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | wave-ps | DONE; 153 started |
| 2026-08-03 | vscode | Restored Intent/Boundaries/Vertical slice/Checklist, which the DONE write had overwritten. PENDING_SIGN_OFF refers to the checklist above; without it nobody could sign off. |

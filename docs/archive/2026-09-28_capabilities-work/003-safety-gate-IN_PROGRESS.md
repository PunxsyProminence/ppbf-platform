# WORK — 003 Safety Gate (IN_PROGRESS)
Date: 2026-08-03

## Search in repo
- apps/web/app/api/pilot/** (medical, pain, safety, session, athlete)
- apps/web/src/server/pilot/**
- coach sports-medicine / review surfaces

## Do in order
1. Find current medical/hold fields — do not create a parallel model if one exists
2. Add enum/constants: clear, hold, medical_review
3. validate + persist
4. GET + POST APIs (coach, organization_admin write; athlete read own)
5. Block ONE path (prefer session start or kiosk check-in)
6. Audit writePilotAuditEvent on change
7. Minimal UI signals
8. Tests
9. Backlog Status -> DONE; Active still false

## Out of scope
- Full medical chart
- Board-visible clinical data
- Auto-hold from ML
- Modules 075/076 until 003 ships

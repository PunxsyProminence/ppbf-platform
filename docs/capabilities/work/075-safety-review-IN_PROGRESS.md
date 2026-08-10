# WORK — 075 Safety Review Engine (IN_PROGRESS)
Date: 2026-08-03

## Depends on
- 003 gate states + set API (DONE)
- 076 flags optional on detail row (DONE)

## Do in order
1. API or query: athletes with gate in (hold, medical_review)
2. Coach/admin-only
3. Detail: current gate + recent flags
4. Buttons -> 003 set-gate (clear / hold / medical_review)
5. Audit decision
6. Tests
7. Status -> DONE

## Out of scope
- Board visibility
- Auto-clear timers
- Full medical chart
- Next Wave 1 module after this: 011 Goals (if free) or 006 Assignment

# WORK — 076 Pain / Symptom Flag (IN_PROGRESS)
Date: 2026-08-03

## Depends on
003 Safety Gate (DONE) — flags recommend; gate API still owns hold/clear.

## Search
- pain report / sports-medicine / athlete update APIs
- coach review queue

## Do in order
1. Reuse existing pain report path if present
2. Small enum: type + severity (or map existing fields)
3. Athlete create; coach list
4. UI: "Recommend hold" button calls 003 set-gate — no auto write
5. Audit on flag create
6. Tests
7. Status -> DONE

## Out of scope
- Auto-hold
- 075 Safety Review Engine (next after 076)
- Medical diagnosis coding

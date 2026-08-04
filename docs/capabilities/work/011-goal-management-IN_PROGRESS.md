# WORK — 011 Goal Management (IN_PROGRESS)
Date: 2026-08-03

## Parent
Original 25 #4 — Goal Intake (PARTIAL: category + progress not persisted)

## Search
- apps/web/app/api/pilot/goals/**
- src/server/pilot/validation.ts (validateGoalPayload)
- src/server/pilot/contracts (GOAL_FIELDS / PilotGoal)
- goal UI under athlete/coach

## Do in order
1. Confirm current goal columns in DB
2. Add category + progress if missing (migration only if needed)
3. GOAL_FIELDS + validateGoalPayload
4. create/update/list/get persist and return
5. One form field each
6. Tests
7. Status -> DONE

## Out of scope
- Auto routing to program lanes
- AI goal suggestions
- Board goal rollups beyond existing aggregate buckets
- Next after this: 006 Training Assignment

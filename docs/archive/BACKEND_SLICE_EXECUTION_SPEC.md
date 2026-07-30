# BACKEND_SLICE_EXECUTION_SPEC

Status: APPROVED
Date: 2026-07-13
Scope: Pilot backend vertical slice

## 1. Canonical Backend Choice
- Azure PostgreSQL is the single source of truth for:
  - Athlete
  - Goal
  - Session
  - Coach Review
  - SHADOW Intake
- Dataverse remains unchanged and limited to document ingest and future Microsoft integration work.
- No dual-write.
- No second source of truth.

## 2. Pilot Login Policy
- Admin creates athlete accounts.
- Athlete login = Athlete ID + PIN.
- No self-signup.
- No OAuth.
- No MFA.

Session policy:
- Persistent login.
- Session remains active until:
  - user logs out
  - admin revokes account/session
  - PIN reset occurs
- Remember-device enabled.

## 3. Role Rules
### Admin
- Full create/save access to all slice entities.

### Coach
- Create Athlete
- Save Athlete
- Create Goal
- Save Goal
- Create Session
- Save Session
- Create Coach Review
- Save Coach Review
- Limited to assigned athletes.

### Athlete
- View own profile
- Update limited profile fields
- Create Goal
- Save own Goal
- Create Session
- Save own Session

Athlete cannot:
- change role
- change coach assignment
- change status flags

## 4. Frozen Minimal Entity Fields
Do not add additional fields.

### Athlete
- athlete_id
- full_name
- dob
- weight_class
- gym_status
- emergency_contact
- active_flag
- coach_id
- created_at
- updated_at

### Goal
- goal_id
- athlete_id
- title
- target_date
- metric
- status
- created_at
- updated_at

### Session
- session_id
- athlete_id
- date
- rpe
- notes
- completed_flag
- created_at
- updated_at

### Coach Review
- review_id
- session_id
- coach_id
- decision
- notes
- approved_flag
- created_at
- updated_at

## 5. SHADOW Routing Map
- Session Note -> Session Queue
- Athlete Profile Update Candidate -> Athlete Review Queue
- Coach Review Candidate -> Coach Review Queue
- Unclassified -> Admin SHADOW Queue

Rule:
- No automatic writes.
- All routed records require human approval before modifying operational records.

## 6. Retention, Storage, and Audit
Retention:
- Keep all audit records. No purge window.

Uploads:
- Store files in Azure Blob Storage.
- Store metadata in database.

Audit events required:
- Create
- Update
- Login
- Logout
- SHADOW Classification
- SHADOW Routing

## 7. Environment Ownership
Jason provides:
- AZURE_POSTGRES_CONNECTION_STRING
- AZURE_STORAGE_CONNECTION_STRING
- PPBF_PILOT_BOOTSTRAP_KEY

Until supplied:
- Use environment placeholders only.
- Never hardcode credentials.

## 8. Migration Safety
- Fresh pilot schema for this slice.
- Do not retrofit legacy schemas into this slice.
- Isolated pilot schema for:
  - Athlete
  - Goal
  - Session
  - Coach Review
  - SHADOW Intake
- Preserve legacy artifacts until migration review confirms safe removal.

## 9. Mandatory Pass/Fail Gate
System is not complete until this scenario passes end-to-end:
- Create Athlete
- Create Goal
- Create Session
- Create Coach Review
- Logout
- Login
- Reload

Pass criteria:
- All records remain available.
- All records are correctly linked.

---

## Dependency-Ordered Todo List (Autopilot Build Queue)

### Phase 0 - Contract Lock
1. Create pilot schema namespace/tables for frozen entities only.
2. Freeze API contracts to frozen fields only.
3. Define role-action matrix in code constants.

### Phase 1 - Auth Foundation
4. Implement Athlete ID + PIN auth tables and hashed PIN verification.
5. Implement persistent session token/cookie model (remember-device behavior).
6. Implement logout, admin session revoke, and PIN reset invalidation logic.
7. Add audit logging for login/logout/revoke/reset events.

### Phase 2 - Core Entity Persistence
8. Implement Athlete create/save APIs with role enforcement and assigned-athlete checks.
9. Implement Goal create/save APIs with ownership/assignment enforcement.
10. Implement Session create/save APIs with ownership/assignment enforcement.
11. Implement Coach Review create/save APIs with assignment enforcement.
12. Add create/update audit writes for all four entities.

### Phase 3 - SHADOW Intake
13. Implement SHADOW upload API (file to Azure Blob Storage + metadata row).
14. Implement deterministic classification stage and persistence.
15. Implement routing stage to review queues and persistence.
16. Enforce no automatic operational writes from SHADOW intake outputs.
17. Add SHADOW classification/routing audit events.

### Phase 4 - UI Wiring
18. Wire login/logout UI to new persistent auth APIs.
19. Wire Athlete/Goal/Session/Coach Review create/save UI calls to backend APIs.
20. Keep excluded domains untouched (AI/compliance/publication/progression).

### Phase 5 - Verification Gates
21. Execute mandatory end-to-end pass/fail scenario.
22. Verify refresh/logout/login/reload persistence and relational integrity.
23. Verify role boundaries and forbidden athlete field changes.
24. Verify SHADOW intake stores files, classifies, routes, and awaits human approval.

## Out of Scope (Do Not Build in This Slice)
- AI features
- Compliance automation
- Publication workflow automation
- Progression intelligence automation
- Non-slice domain expansions

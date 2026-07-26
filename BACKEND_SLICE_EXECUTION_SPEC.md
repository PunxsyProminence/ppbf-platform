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

## Launch-Focused Queue (PPBF V1)

### Mission
Deliver a usable PPBF V1 at https://www.punxsyprominence.org where:
- Jason signs in with Microsoft and can administer the gym.
- Jason can create, activate, and reset athlete PIN access.
- All eight athletes can use PIN login.
- PIN sessions receive athlete access only.
- Coaches use Microsoft login for privileged access.
- Athlete dashboard and currently implemented basic SHADOW features work.
- Phone and tablet workflows are usable.

Do not expand the build beyond what is required for this outcome.

### Completed Baseline
- PR #18 is merged and deployed.
- Production and staging are healthy.
- Athlete-only PIN controls are implemented.
- The current release uses the same staged image in production.
- Further release-workflow hardening is post-launch unless it directly blocks this V1 release.

### Immediate Housekeeping
- Reverse only the exact queue-document edit previously introduced in the dirty checkout.
- Do not switch branches, clean, stash, reset, restore, stage, commit, or alter any unrelated file in that checkout.
- After reversing that one edit, leave the dirty checkout alone.
- Use a fresh isolated worktree from current origin/main for all remaining source work.

### Launch Queue
1. Targeted login truth check
Inspect only existing authentication, account-management, membership, athlete-number, and relevant UI paths.

Confirm what already works:
- athlete PIN login
- Jason Microsoft login
- athlete dashboard
- coach interface
- gym-admin athlete/PIN management
- PIN activation/reset
- basic SHADOW access
- phone/tablet layout

Do not perform another broad repository, Azure, cost, or architecture audit.
Produce one short list containing only actual launch blockers.

2. Fix the minimum launch blockers
Create one focused V1-login branch and PR if source or schema changes are required.

Implementation requirements:
- Microsoft privileged login validates signature, issuer, audience, nonce, expiry, and expected tenant.
- PIN login remains athlete-only.
- Coach/admin privileged paths require Microsoft-authenticated sessions.
- Gym admin can create athlete account entries, then activate/reset athlete PIN.
- Scope all admin mutations to the caller organization.
- Keep UI flow usable on phone and tablet.

## Out of Scope (Do Not Build in This Slice)
- AI features
- Compliance automation
- Publication workflow automation
- Progression intelligence automation
- Non-slice domain expansions

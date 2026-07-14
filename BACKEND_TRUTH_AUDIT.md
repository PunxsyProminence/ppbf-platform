# BACKEND_TRUTH_AUDIT

Audit mode: evidence-only architecture and persistence audit.
Scope: current repository state only.
Classification key: REAL, MOCK, PLACEHOLDER, UNKNOWN.

## SECTION 1
## CANONICAL BACKEND INVENTORY

| Technology | Purpose | Current Usage | Active or Inactive | Referenced or Unreferenced | Risk Level | Evidence |
|---|---|---|---|---|---|---|
| Dataverse | Store document-ingest records | Used by server route when mock mode is off | CONDITIONAL ACTIVE | Referenced | High | apps/web/app/api/document-ingest/route.ts:67,72 and apps/web/src/server/document-intake/config.ts:22-26 and apps/web/src/server/document-intake/dataverse.ts:44 |
| Supabase | Planned relational persistence and RLS | SQL schemas and migration script exist; web runtime usage not found in apps/web source routes/components | INACTIVE in current web runtime | Referenced (infra/scripts/docs) | High | infra/supabase/schema.sql:1-66 and infra/supabase/ppbf_core_schema.sql:1-13 and scripts/migrate.ts:1-14 |
| Local Storage | Role session and client persistence | Used for role session, admin capability registry, track assignments, athlete floor plans, login announcement | ACTIVE | Referenced | Medium | apps/web/components/roleSession.ts:26-27,90-91 and apps/web/app/admin/page.tsx:63,228,249,322 and apps/web/components/trackAssignments.ts:16,17,136,153,171 and apps/web/components/AthleteWorkspace.tsx:305,308 |
| File Storage | Persist ingest audit and uploaded documents | Writes .audit/document-ingest.jsonl locally; uploads to SharePoint and Google Drive in non-mock mode | CONDITIONAL ACTIVE | Referenced | High | apps/web/src/server/document-intake/audit.ts:12-18 and apps/web/src/server/document-intake/sharepoint.ts:28-66 and apps/web/src/server/document-intake/googleDrive.ts:25-57 |
| JSON / JSONL | Structured payload and audit records | JSON request/response and JSONL append-only ingest audit | ACTIVE | Referenced | Medium | apps/web/src/server/document-intake/audit.ts:13,17 and apps/web/src/server/document-intake/dataverse.ts:28-42 |
| Mock Services | Front-end capability placeholders and synthetic ingest IDs | Explicit mock queue/items and placeholder routes; ingest mock mode returns synthetic IDs/URLs | ACTIVE | Referenced | Medium | apps/web/app/admin/shadow/page.tsx:151,219-220 and apps/web/app/api/document-ingest/route.ts:18,67-84 and apps/web/app/coach/video-analysis/page.tsx:49 |
| API Routes | Server entry points | Single route exists: /api/document-ingest | ACTIVE | Referenced | Medium | apps/web/app/api/document-ingest/route.ts:15 and apps/web/app/admin/shadow/page.tsx:502 and apps/web/app/api/document-ingest/route.ts:1-120 |
| Other: AAD client-credential token helper | Acquire Graph/Dataverse tokens for server-to-server calls | Used by Dataverse and SharePoint upload modules | ACTIVE when ingest is non-mock | Referenced | High | apps/web/src/server/document-intake/auth.ts:6-33 and apps/web/src/server/document-intake/dataverse.ts:49-55 and apps/web/src/server/document-intake/sharepoint.ts:33-39 |
| Other: In-memory execution/continuity package services | Domain service stubs and continuity ledger in memory | Supabase calls marked TODO; logging outputs to console; continuity ledger stores in memory array | ACTIVE as code paths, not wired as authoritative backend | Referenced | Medium | packages/execution/ppbfService.ts:5-19 and packages/execution/loggingService.ts:10-11 and packages/continuity/ledger.ts:14-36 |

## SECTION 2
## WORKSPACE AUDIT

| Workspace | Capability | Route | Data Source | Persistence Source | Authentication Source | Role Protection Source | Classification | Evidence |
|---|---|---|---|---|---|---|---|---|
| Athlete | Athlete dashboard | /athlete/dashboard | React state arrays (goals, tasks, sessions) | In-memory + localStorage floor-plan snapshots | roleSession localStorage session | RoleStandaloneView -> RoleSessionGate | MOCK | apps/web/app/athlete/dashboard/page.tsx:8 and apps/web/components/AthleteWorkspace.tsx:204,236,305,308 |
| Athlete | Video analysis | /athlete/video-analysis | Static placeholder panels | None | roleSession localStorage session | RoleStandaloneView -> RoleSessionGate | PLACEHOLDER | apps/web/app/athlete/video-analysis/page.tsx:18,25,33 |
| Athlete | Progression intelligence | /athlete/progression-intelligence | Static timeline/recommendation cards | None | roleSession localStorage session | RoleStandaloneView -> RoleSessionGate | PLACEHOLDER | apps/web/app/athlete/progression-intelligence/page.tsx:30,39 |
| Coach | Coach review workspace | /coach/review-queue | React state arrays (athletes/tasks/blocks) | In-memory + reads athlete floor plans from localStorage | roleSession localStorage session | RoleStandaloneView -> RoleSessionGate | MOCK | apps/web/components/CoachWorkspace.tsx:99,107,265 and apps/web/app/coach/review-queue/page.tsx:8 |
| Coach | Video analysis | /coach/video-analysis | Static placeholders + labels | None | roleSession localStorage session | RoleStandaloneView -> RoleSessionGate | PLACEHOLDER | apps/web/app/coach/video-analysis/page.tsx:13-17,49,73 |
| Coach | Progression intelligence | /coach/progression-intelligence | Static trend/queue cards | None | roleSession localStorage session | RoleStandaloneView -> RoleSessionGate | PLACEHOLDER | apps/web/app/coach/progression-intelligence/page.tsx:22,31,51 |
| Parent | Parent hub | /parent/dashboard | React state arrays (children, attendance, goals, messages) | In-memory | roleSession localStorage session | RoleStandaloneView -> RoleSessionGate | MOCK | apps/web/components/ParentHub.tsx:129,143 and apps/web/app/parent/dashboard/page.tsx:8 |
| Parent | Progression visibility | /parent/progression-visibility | Static placeholder panels | None | roleSession localStorage session | RoleStandaloneView -> RoleSessionGate | PLACEHOLDER | apps/web/app/parent/progression-visibility/page.tsx:15,24,33 |
| Board | Board hub directory | /board | Static board seat config/overview constants | None | None enforced on this route | No gate in page component | MOCK | apps/web/app/board/page.tsx:4-7 and apps/web/app/board/boardWorkspaceConfig.ts:30 |
| Board | Board seat workspace | /board/{seat} | Static board config and dashboard constants | None | roleSession localStorage session | BoardMemberDashboard uses RoleSessionGate with seat allowed role | MOCK | apps/web/app/board/BoardSeatWorkspace.tsx:16-21 and apps/web/components/BoardMemberDashboard.tsx:13,146 |
| Board | Compliance monitoring | /board/compliance-monitoring | Static compliance cards | None | roleSession localStorage session | RoleSessionGate with board roles | PLACEHOLDER | apps/web/app/board/compliance-monitoring/page.tsx:25,31,42 |
| Admin | Admin capability console | /admin | localCapabilityRepository + static fallback capability data | localStorage ppbf-admin-capabilities-v1 + track assignments localStorage | roleSession localStorage session | RoleSessionGate admin | MOCK | apps/web/app/admin/page.tsx:63,222-254,322,557 |
| Admin | SHADOW admin console | /admin/shadow | useState queue/log/history + ingest API results | In-memory queue/history + optional server .audit via ingest API | roleSession localStorage session | RoleStandaloneView allowedRoles admin | MIXED: MOCK + REAL (ingest API path) | apps/web/app/admin/shadow/page.tsx:151,219-220,502 |
| Admin | Compliance center | /admin/compliance-center | Static panels | None | roleSession localStorage session | RoleSessionGate admin | PLACEHOLDER | apps/web/app/admin/compliance-center/page.tsx:19,25,36 |
| Operations | Operations / Mission Control | /operations | Static arrays for role selector, workspaces, capability radar | None | roleSession localStorage session | RoleSessionGate (all declared roles) | MOCK + PLACEHOLDER map entries | apps/web/app/operations/page.tsx:2,79-124,134 |
| Mission Control | Same surface branded as Mission Control in Operations page | /operations | Same as operations row | Same as operations row | Same as operations row | Same as operations row | Same as operations row | apps/web/app/operations/page.tsx:152 |
| SHADOW | SHADOW chat | /shadow | In-memory message state and rule-based canned responses | In-memory only | readRoleSession check and redirect if absent | Redirect guard only in useEffect, no RoleSessionGate wrapper | MOCK | apps/web/app/shadow/page.tsx:15,17,27-31,56-83 |
| Source Control | Source control lane | /source-control | Static state lanes/version history/destination arrays | None | None enforced on this route | No gate in page component | MOCK + PLACEHOLDER | apps/web/app/source-control/page.tsx:4,33,43,64,143 |
| Source Control | Publication workflow | /source-control/publication-workflow | Static workflow stage list and status labels | None | None enforced on this route | No gate in page component | PLACEHOLDER | apps/web/app/source-control/publication-workflow/page.tsx:3,24,32-33,46 |

## SECTION 3
## PERSISTENCE TRUTH AUDIT

Entity list requested: Athlete, Coach, Parent, Attendance, Goal, Assessment, Coach Review, Session, Development Route, Compliance Item, Publication Item.

| Entity | Create | Read | Update | Delete | Persistent Store | Survives Refresh | Survives Logout | Survives Redeploy | Classification | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| Athlete | No authoritative create path found | Yes (mock arrays) | Partial (track assignment map updates) | No | localStorage for track assignments only | Yes (for track assignments) | Yes (logout clears role session, not track assignments) | Yes (browser localStorage) | MOCK | apps/web/components/CoachWorkspace.tsx:99 and apps/web/app/admin/page.tsx:411 and apps/web/components/trackAssignments.ts:136,153 |
| Coach | No | Yes (mock arrays/tasks) | No authoritative persistent update | No | None | No | No | No | MOCK | apps/web/components/CoachWorkspace.tsx:99,107 |
| Parent | No | Yes (mock arrays) | No authoritative persistent update | No | None | No | No | No | MOCK | apps/web/components/ParentHub.tsx:129,143 |
| Attendance | No | Yes (mock attendance array) | No | No | None | No | No | No | MOCK | apps/web/components/ParentHub.tsx:129 |
| Goal | Yes (UI create in state) | Yes | Partial (state updates) | No explicit delete shown in evidence pass | In-memory state only | No | No | No | MOCK | apps/web/components/AthleteWorkspace.tsx:204 and apps/web/components/AthleteWorkspace.tsx:272 |
| Assessment | No verified persisted CRUD | Placeholder displays and references | No verified persisted update | No | None verified | No | No | No | PLACEHOLDER | apps/web/app/athlete/progression-intelligence/page.tsx:14-19 and apps/web/app/coach/progression-intelligence/page.tsx:17-20 |
| Coach Review | No active runtime persistence path found in app routes | Placeholder references in progression lanes | No | No | SQL draft table exists only | Unknown in runtime (no active binding found) | Unknown in runtime | Unknown in runtime | UNKNOWN (runtime) + DRAFT (schema) | infra/supabase/schema.sql:30 and apps/web/app/coach/progression-intelligence/page.tsx:31 |
| Session | Yes (check-in creates session/task state) | Yes | Yes (check-out updates in-memory log) | No explicit delete | In-memory; floor-plan subset persisted to localStorage | Partial (floor plans yes, session log no) | Partial (floor plans yes, session log no) | Partial (floor plans yes, session log no) | MOCK | apps/web/components/AthleteWorkspace.tsx:236,272,315,305,308 |
| Development Route | No explicit route-entity backend CRUD | Yes (track manifests and assignments) | Yes (assignment changes in admin) | No explicit delete | localStorage assignments | Yes | Yes | Yes | MOCK | apps/web/components/trackAssignments.ts:20-112,136,153 and apps/web/app/admin/page.tsx:263,314,411 |
| Compliance Item | No | Yes (static cards/counters) | No persistent update | No | None | No | No | No | PLACEHOLDER | apps/web/app/board/compliance-monitoring/page.tsx:9-20,42 and apps/web/app/admin/compliance-center/page.tsx:5-16 |
| Publication Item | No backend create path | Yes (static state lane arrays) | No backend update path | No | None | No | No | No | PLACEHOLDER | apps/web/app/source-control/page.tsx:4-31,88,143 and apps/web/app/source-control/publication-workflow/page.tsx:3,46 |

## SECTION 4
## AUTHENTICATION AND ROLE PROTECTION TRUTH

### 4.1 Authentication Mechanism
- Current mechanism is client-side role session with a hardcoded PIN.
- Evidence:
  - OPERATOR_PIN hardcoded: apps/web/components/roleSession.ts:5
  - Session object saved in localStorage: apps/web/components/roleSession.ts:26-27
  - Session TTL 8 hours: apps/web/components/roleSession.ts:4,23
  - Login creates role session via createRoleSession: apps/web/app/login/page.tsx:50

Classification: REAL (implemented), but client-side only.

### 4.2 Route Protection Mechanism
- Primary guard is RoleSessionGate.
- Evidence:
  - Redirect to /login if session missing: apps/web/components/RoleSessionGate.tsx:22
  - Role allow-list check: apps/web/components/RoleSessionGate.tsx:17
  - Redirect to role home if unauthorized: apps/web/components/RoleSessionGate.tsx:27

Classification: REAL for routes wrapped with RoleSessionGate/RoleStandaloneView.

### 4.3 Ungated or differently-gated surfaces observed
- Board hub page has no RoleSessionGate or RoleStandaloneView wrapper in page component.
  - Evidence: apps/web/app/board/page.tsx:4-7
- Source control pages show no RoleSessionGate or RoleStandaloneView wrapper in page components.
  - Evidence: apps/web/app/source-control/page.tsx:64 and apps/web/app/source-control/publication-workflow/page.tsx:10
- SHADOW page uses readRoleSession redirect in useEffect, not RoleSessionGate wrapper.
  - Evidence: apps/web/app/shadow/page.tsx:27-31

Classification: MIXED (some routes strongly wrapped, some not).

### 4.4 API Auth Enforcement
- /api/document-ingest route evidence shows file/form processing and external writes; no role-session check found in route code.
- Evidence:
  - Route entry: apps/web/app/api/document-ingest/route.ts:36
  - Accepts formData file/source directly: apps/web/app/api/document-ingest/route.ts:38-51
  - No RoleSessionGate/readRoleSession usage in this server route file.

Classification: UNKNOWN for intended policy, REAL for current implementation path without visible role-session enforcement in this file.

## SECTION 5
## API AND INTEGRATION TRUTH

### 5.1 API Route Inventory
- One API route found in apps/web app router:
  - /api/document-ingest
  - Evidence: apps/web/app/api/document-ingest/route.ts:1-120 and file inventory count from apps/web/app/api/**/*

### 5.2 Live Integration Path
- Admin SHADOW calls the API route.
  - Evidence: apps/web/app/admin/shadow/page.tsx:502
- API route can:
  - Parse PDF text
  - Classify content
  - Write Dataverse
  - Upload SharePoint and Google Drive
  - Append local audit JSONL
  - Evidence: apps/web/app/api/document-ingest/route.ts:54-114

Classification: REAL (implemented server flow), CONDITIONAL because mock mode can bypass live integrations.

### 5.3 Mock Mode and Conditional Behavior
- Mock mode flag:
  - PPBF_INGEST_MOCK_MODE toggles synthetic IDs/URLs instead of live external writes.
  - Evidence: apps/web/app/api/document-ingest/route.ts:18,67-84
- Required env for live path:
  - Dataverse: DATAVERSE_ORG_URL, DATAVERSE_TENANT_ID, DATAVERSE_CLIENT_ID, DATAVERSE_CLIENT_SECRET
  - SharePoint/Graph: GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, SHAREPOINT_SITE_ID, SHAREPOINT_DRIVE_ID
  - Google Drive: GOOGLE_SERVICE_ACCOUNT_JSON
  - Evidence: apps/web/src/server/document-intake/config.ts:21-37

Classification: REAL implementation with MOCK fallback.

## SECTION 6
## ENTITY AND STORAGE MAP (CURRENT STATE)

| Entity / Data Group | Current System of Record | Storage Type | Status |
|---|---|---|---|
| Role Session | Browser localStorage keys ppbf-role-session and ppbf-club-role | LocalStorage | REAL |
| Login Announcement | Browser localStorage key ppbf-login-announcement | LocalStorage | REAL |
| Admin Capability Registry | Browser localStorage key ppbf-admin-capabilities-v1 | LocalStorage | REAL |
| Track Assignments and Active Athlete Profile | Browser localStorage keys ppbf-track-assignments-v1 and ppbf-active-athlete-profile | LocalStorage | REAL |
| Athlete Floor Plans | Browser localStorage key ppbf-athlete-floor-plans | LocalStorage | REAL |
| SHADOW Admin queue/history/logs | Component state | In-memory | MOCK |
| Board/Compliance/Publication/Progression placeholder data | Static arrays/constants in page/components | In-memory source code constants | PLACEHOLDER / MOCK |
| Ingest audit stream | .audit/document-ingest.jsonl | Local file JSONL | REAL (when ingest runs) |
| Supabase tables in infra | SQL files only; no active binding found from current web route/components evidence | SQL draft artifacts | UNKNOWN runtime / DRAFT |

Evidence:
- apps/web/components/roleSession.ts:3,26-27,90-91
- apps/web/app/login/page.tsx:11,67,80
- apps/web/app/admin/page.tsx:63,222-254
- apps/web/components/trackAssignments.ts:15-17,136,153,171
- apps/web/components/AthleteWorkspace.tsx:305,308
- apps/web/src/server/document-intake/audit.ts:12-18
- infra/supabase/schema.sql:1-66

## SECTION 7
## REALITY SCORECARD

Counted from audited capability rows in Section 2.

- REAL: 0 workspace capabilities are purely backend-real as end-to-end domain systems.
- MIXED (contains real backend call plus mock state): 1 (Admin SHADOW ingest flow).
- MOCK: 11 rows (role workspaces primarily client state/static).
- PLACEHOLDER: 8 rows (video analysis, progression, compliance, publication surfaces).
- UNKNOWN: 0 rows in Section 2 table itself; UNKNOWN appears in runtime policy/persistence interpretation where evidence is incomplete.

Interpretation statement (evidence-only):
- Most capability surfaces are front-end state or placeholder labels.
- Verified backend route inventory currently centers on one ingest endpoint.

## SECTION 8
## PILOT READINESS BLOCKERS (FACTS ONLY)

1. Core domain entities are not consistently persisted to authoritative backend storage.
- Evidence: Athlete/Coach/Parent/Attendance/Goal/Session behavior in components uses useState/localStorage (Section 3 evidence set).

2. Supabase backend artifacts exist primarily as infra/schema/scripts without confirmed active runtime binding in current audited web routes/components.
- Evidence: infra/supabase/schema.sql and infra/supabase/ppbf_core_schema.sql exist; scripts/migrate.ts logs placeholder completion.

3. Authentication is client-side role session with hardcoded PIN.
- Evidence: apps/web/components/roleSession.ts:5,16-27.

4. Route protection is inconsistent across major surfaces.
- Evidence: board hub and source-control pages without RoleSessionGate wrappers (apps/web/app/board/page.tsx:4 and apps/web/app/source-control/page.tsx:64).

5. API surface is narrow (single route) relative to audited workspace capability breadth.
- Evidence: only apps/web/app/api/document-ingest/route.ts found in API route inventory.

6. Several business-critical capability lanes self-declare as planned/placeholders/backend-required.
- Evidence examples:
  - apps/web/app/coach/video-analysis/page.tsx:49
  - apps/web/app/board/compliance-monitoring/page.tsx:31
  - apps/web/app/source-control/publication-workflow/page.tsx:24,33

End of audit.

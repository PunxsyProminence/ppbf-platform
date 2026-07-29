# Mock Data → Real API Integration: Deep Dive & Action Plan

**Date:** July 17, 2026  
**Priority:** 🔴 CRITICAL (8-12 hours)  
**Status:** PARTIALLY BUILT

---

## Executive Summary

✅ **Good News:**
- Backend API endpoints exist and are ready
- Some pages (AthleteProgressionIntelligencePage, AthleteVideoAnalysisPage) already call real APIs
- Database functions exist (getAthleteById, getGoalById, getSessionById, etc.)
- RBAC and error handling implemented

❌ **Bad News:**
- Frontend components (AthleteWorkspace, CoachWorkspace, ParentHub) hardcoded with mock data
- Missing "list" endpoints (no `/api/pilot/athletes/list`, `/api/pilot/goals/list`)
- Frontend doesn't make API calls for core workflows

**Result:** App is **mock-only despite backend readiness** — need to wire frontend to backend

---

## 1. Current State Verification

### A. Backend Endpoints That Exist ✅

| Endpoint | Method | Purpose | Status |
|----------|--------|---------|--------|
| `/api/pilot/athletes/get` | POST | Get single athlete | ✅ Ready |
| `/api/pilot/athletes` | POST | Create athlete | ✅ Ready |
| `/api/pilot/goals/get` | POST | Get single goal | ✅ Ready |
| `/api/pilot/goals` | POST | Create goal | ✅ Ready |
| `/api/pilot/sessions` | POST | Create session | ✅ Ready |
| `/api/pilot/coach-reviews` | POST | Create review | ✅ Ready |
| `/api/pilot/progression/gaps` | GET/POST | List/create gaps | ✅ Ready |
| `/api/pilot/progression/assignments` | GET/POST | List/create assignments | ✅ Ready |
| `/api/pilot/video/list` | GET | List videos | ✅ Ready |
| `/api/pilot/shadow/chat` | POST | SHADOW chat | ✅ Ready |
| `/api/pilot/shadow/observation-projection` | POST | Get observations | ✅ Ready |

### B. Backend Endpoints Missing ❌

| Endpoint | Method | Purpose | Status |
|----------|--------|---------|--------|
| `/api/pilot/athletes` | GET | **List athletes for organization** | ❌ MISSING |
| `/api/pilot/goals` | GET | **List goals for athlete** | ❌ MISSING |
| `/api/pilot/sessions` | GET | **List sessions for athlete** | ❌ MISSING |
| `/api/pilot/coach-tasks` | GET/POST | **List coach tasks** | ❌ MISSING |
| `/api/pilot/floor-tasks` | GET/POST | **List floor tasks for athlete** | ❌ MISSING |
| `/api/pilot/drills` | GET | **List available drills** | ❌ MISSING |

---

## 2. Frontend Components Status

### Working Pattern (Already Using Real API) ✅

**File:** `apps/web/app/athlete/progression-intelligence/page.tsx` (lines 80-160)

```typescript
// THIS IS THE PATTERN TO COPY EVERYWHERE
const [gaps, setGaps] = useState<ProgressionGap[]>([]);
const [loading, setLoading] = useState(true);
const [errorMessage, setErrorMessage] = useState<string | null>(null);

useEffect(() => {
  const fetchData = async () => {
    try {
      setLoading(true);
      setErrorMessage(null);

      // Call real API
      const gapsRes = await fetch(`${apiBase()}/api/pilot/progression/gaps`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (!gapsRes.ok) throw new Error(`Failed to fetch gaps: ${gapsRes.status}`);
      const gapsData = await gapsRes.json();
      setGaps(gapsData.items || []);

    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  fetchData();
}, []);

if (loading) return <LoadingSpinner />;
if (errorMessage) return <ErrorAlert message={errorMessage} />;
return <GapsList gaps={gaps} />;
```

**Also Working:**
- `apps/web/app/athlete/video-analysis/page.tsx` - Calls `/api/pilot/video/list` ✅

---

### Broken Pattern (Mock Data Only) ❌

**File:** `apps/web/components/AthleteWorkspace.tsx` (lines 210-280)

```typescript
// THIS IS WHAT NEEDS TO CHANGE
const [smartGoals, setSmartGoals] = useState<SMARTGoal[]>([
  { id: 'sg_1', title: 'Master 5-Punch Combination', ... },  // ❌ HARDCODED
  { id: 'sg_2', title: 'Build 10-Pound Muscle Mass', ... },  // ❌ HARDCODED
  { id: 'sg_3', title: 'Maintain 4.0 GPA', ... }              // ❌ HARDCODED
]);

const [floorTasks, setFloorTasks] = useState<FloorTask[]>([
  { id: 'ft_1', title: 'Morning Readiness Check-In', ... },   // ❌ HARDCODED
  // ... more hardcoded tasks
]);

// ❌ NO useEffect to fetch from API
// ❌ NO loading state
// ❌ NO error handling
// ❌ NO error boundary
```

**Same Pattern (Broken):**
- `apps/web/components/CoachWorkspace.tsx` (athletes, coachTasks) ❌
- `apps/web/components/ParentHub.tsx` (children, attendance, messages) ❌
- `apps/web/components/RoleSummaryPanels.tsx` (if using mock) ❌

---

## 3. What Needs To Be Built

### Phase 1: Add Missing Backend Endpoints (2-3 hours)

**In:** `apps/web/src/server/pilot/entities.ts`

```typescript
// ADD THESE FUNCTIONS:

export async function getAthletesByOrganization(
  organizationId: string
): Promise<PilotAthlete[]> {
  return query<PilotAthlete>(
    'select * from pilot.athletes where organization_id = $1 order by created_at desc',
    [organizationId]
  );
}

export async function getGoalsByAthlete(
  organizationId: string,
  athleteId: string
): Promise<PilotGoal[]> {
  return query<PilotGoal>(
    'select * from pilot.goals where organization_id = $1 and athlete_id = $2 order by created_at desc',
    [organizationId, athleteId]
  );
}

export async function getSessionsByAthlete(
  organizationId: string,
  athleteId: string
): Promise<PilotSession[]> {
  return query<PilotSession>(
    'select * from pilot.sessions where organization_id = $1 and athlete_id = $2 order by date desc',
    [organizationId, athleteId]
  );
}

export async function getCoachReviewsBySession(
  organizationId: string,
  sessionId: string
): Promise<PilotCoachReview[]> {
  return query<PilotCoachReview>(
    'select * from pilot.coach_reviews where organization_id = $1 and session_id = $2 order by created_at desc',
    [organizationId, sessionId]
  );
}
```

**In:** `apps/web/app/api/pilot/athletes/list/route.ts` (NEW FILE)

```typescript
import { NextResponse, type NextRequest } from 'next/server';
import { getAthletesByOrganization } from '@/src/server/pilot/entities';
import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'athlete']);

    const athletes = await getAthletesByOrganization(principal.organizationId);
    return NextResponse.json({ items: athletes });
  } catch (error) {
    return jsonError(error);
  }
}
```

**In:** `apps/web/app/api/pilot/goals/list/route.ts` (NEW FILE)

```typescript
import { NextResponse, type NextRequest } from 'next/server';
import { getGoalsByAthlete } from '@/src/server/pilot/entities';
import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'athlete']);

    const athleteId = request.nextUrl.searchParams.get('athlete_id');
    if (!athleteId) throw new Error('Missing athlete_id');

    await assertActorCanAccessAthlete(principal, athleteId);
    const goals = await getGoalsByAthlete(principal.organizationId, athleteId);
    return NextResponse.json({ items: goals });
  } catch (error) {
    return jsonError(error);
  }
}
```

### Phase 2: Refactor Frontend Components (5-8 hours)

**Pattern to Apply to AthleteWorkspace.tsx:**

BEFORE (Mock Data):
```typescript
const [smartGoals, setSmartGoals] = useState<SMARTGoal[]>([
  { id: 'sg_1', title: 'Master 5-Punch Combination', ... }
]);
```

AFTER (Real API):
```typescript
const [smartGoals, setSmartGoals] = useState<SMARTGoal[]>([]);
const [goalsLoading, setGoalsLoading] = useState(true);
const [goalsError, setGoalsError] = useState<string | null>(null);
const [backendAthleteId, setBackendAthleteId] = useState<string | null>(null);

useEffect(() => {
  const fetchSession = async () => {
    try {
      const response = await fetch('/api/pilot/auth/session', { method: 'POST' });
      const payload = (await response.json()) as { authenticated?: boolean; athlete_id?: string };
      if (response.ok && payload.authenticated && payload.athlete_id) {
        setBackendAthleteId(payload.athlete_id);
      }
    } catch {
      // Backend unavailable, keep workspace usable in local mode
    }
  };
  void fetchSession();
}, []);

useEffect(() => {
  if (!backendAthleteId) return;

  const fetchGoals = async () => {
    try {
      setGoalsLoading(true);
      setGoalsError(null);

      const response = await fetch(`/api/pilot/goals/list?athlete_id=${backendAthleteId}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch goals: HTTP ${response.status}`);
      }

      const data = (await response.json()) as { items: SMARTGoal[] };
      setSmartGoals(data.items || []);
    } catch (err) {
      setGoalsError(err instanceof Error ? err.message : 'Failed to load goals');
      // Fall back to empty array, not mock data
      setSmartGoals([]);
    } finally {
      setGoalsLoading(false);
    }
  };

  void fetchGoals();
}, [backendAthleteId]);

// Then in JSX:
{goalsLoading && <div className="text-center">Loading goals...</div>}
{goalsError && <div className="text-red-500">Error: {goalsError}</div>}
{smartGoals.length === 0 && !goalsLoading && (
  <div className="text-gray-500">No active goals yet. Create your first goal.</div>
)}
{smartGoals.map(goal => (
  // Render goal
))}
```

**Components to Refactor:**

1. `AthleteWorkspace.tsx` - Goals, Tasks, Drills, Session Log
2. `CoachWorkspace.tsx` - Athletes, Coach Tasks
3. `ParentHub.tsx` - Children, Attendance, Goals
4. Any other components using mock data

---

## 4. Implementation Checklist

### Step 1: Create Backend Endpoints
- [ ] Add `getAthletesByOrganization()` to entities.ts
- [ ] Add `getGoalsByAthlete()` to entities.ts
- [ ] Add `getSessionsByAthlete()` to entities.ts
- [ ] Create `/api/pilot/athletes/list/route.ts`
- [ ] Create `/api/pilot/goals/list/route.ts`
- [ ] Test endpoints manually with `pilot-gate.mjs` script
- [ ] Verify error handling and auth

### Step 2: Refactor AthleteWorkspace
- [ ] Add loading state for goals
- [ ] Add error state for goals
- [ ] Replace `useState(mockGoals)` with API call in useEffect
- [ ] Repeat for tasks, drills, session log
- [ ] Add loading/error UI in JSX
- [ ] Test with real backend session

### Step 3: Refactor CoachWorkspace
- [ ] Add loading state for athletes
- [ ] Add error state for athletes
- [ ] Replace `useState(mockAthletes)` with API call
- [ ] Replace mock tasks with API call
- [ ] Test with real data

### Step 4: Refactor ParentHub
- [ ] Add loading state for children
- [ ] Add error state
- [ ] Replace mock data with API calls
- [ ] Test end-to-end

### Step 5: Test & Verify
- [ ] Run `pilot-gate.mjs` to create test data
- [ ] Login as athlete, verify goals load
- [ ] Login as coach, verify athletes load
- [ ] Test error scenarios (network down, permission denied)
- [ ] Verify loading/error UI displays properly

---

## 5. Test Script Reference

**Location:** `apps/web/scripts/pilot-gate.mjs`

**What it does:**
1. Creates admin account
2. Creates athlete account
3. Creates athlete profile
4. Creates goal
5. Creates session
6. Creates coach review

**To run:**
```bash
export PILOT_ADMIN_ACCOUNT_ID=admin_001
export PILOT_ADMIN_PIN=12345
export PPBF_PILOT_BOOTSTRAP_KEY=your-key

node apps/web/scripts/pilot-gate.mjs
```

This creates real data you can test with.

---

## 6. Error Scenarios to Handle

### 1. Backend Session Not Available
```typescript
// Keep workspace usable in local mode
try {
  const session = await fetch('/api/pilot/auth/session');
  if (!session.ok) {
    setBackendAthleteId(null);
    // Show mock data or empty state
  }
} catch {
  setBackendAthleteId(null); // Local mode
}
```

### 2. Network Failure During Fetch
```typescript
try {
  await fetch(...);
} catch (err) {
  if (err instanceof TypeError) {
    setError('Network error - check connection');
  } else {
    setError(err instanceof Error ? err.message : 'Unknown error');
  }
}
```

### 3. HTTP 403 (Forbidden)
```typescript
if (response.status === 403) {
  setError('You do not have permission to access this data');
} else if (response.status === 404) {
  setSmartGoals([]); // Show empty state
} else if (!response.ok) {
  throw new Error(`HTTP ${response.status}`);
}
```

---

## 7. Timeline

| Phase | Task | Time | Cumulative |
|-------|------|------|-----------|
| 1 | Add backend list endpoints | 2-3h | 2-3h |
| 2 | Refactor AthleteWorkspace | 3-4h | 5-7h |
| 3 | Refactor CoachWorkspace | 2-3h | 7-10h |
| 4 | Refactor ParentHub | 1-2h | 8-12h |
| 5 | Testing & edge cases | 1-2h | 9-14h |

**Total:** 8-12 hours (as estimated) ✅

---

## 8. Success Criteria

✅ **Backend:**
- All list endpoints working
- Proper RBAC on all endpoints
- Error responses include meaningful messages

✅ **Frontend:**
- AthleteWorkspace loads real goals on mount
- CoachWorkspace loads real athletes on mount
- Loading states display
- Error messages display
- Empty states work correctly
- Can create goals/tasks and see them reflected
- No mock data hardcoded

✅ **End-to-End:**
- Run `pilot-gate.mjs` to create test data
- Login as athlete
- See real goals/tasks/sessions (not mock)
- Create new goal → see it in list immediately
- Logout → login as coach → see athlete
- All workflows use real data, not mock

---

## 9. Quick Reference: API Patterns

### For GET (List) Endpoints:
```typescript
const response = await fetch(`${apiBase()}/api/pilot/goals/list?athlete_id=${athleteId}`, {
  method: 'GET',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
});
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const data = await response.json();
setItems(data.items || []);
```

### For POST (Create) Endpoints:
```typescript
const response = await fetch(`${apiBase()}/api/pilot/goals`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ goal_id, athlete_id, title, target_date, metric, status }),
});
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const data = await response.json();
```

### For POST (Get Single) Endpoints:
```typescript
const response = await fetch(`${apiBase()}/api/pilot/athletes/get`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ athlete_id }),
});
if (!response.ok) throw new Error(`HTTP ${response.status}`);
const data = await response.json();
if (data.found) setAthlete(data.athlete);
```

---

**Next Steps:**
1. Review this plan
2. Create backend list endpoints
3. Start with AthleteWorkspace refactor
4. Test with real data
5. Repeat for other components

**Blocked By:** None - can start immediately!

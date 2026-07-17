# SHADOW AI Architecture — Technical Companion

**Date:** 2026-07-17  
**Audience:** VS (implementation reference)  
**Purpose:** Quick technical guide while coding the foundation

---

## System Overview

**Dual-Mode Architecture:**
- **Quick Round:** Fast responses for day-to-day interactions (most users, most queries)
- **Heavy Bag Session:** Deep reasoning for complex analysis, research, and admin tasks

Both modes use the same underlying components; the difference is in **triggering**, **execution pattern**, and **context depth**.

---

## Quick Round (Fast Model)

### Triggering
- **Default behavior:** Auto-detect based on:
  - Query complexity score (heuristic: length, keywords, multi-step reasoning)
  - Topic type (coaching vs research vs diagnostic)
  - User role (Athletes default to Quick Round; Coaches can escalate)
  - Authority level (View-only users stay in Quick Round)
  - Previous interaction patterns

### Execution
- **Sync (user waits)**
- **Latency target:** < 3 seconds (model + context + validation + logging)
- **Context:** Lightweight — base profile, role, recent interactions only
- **Cache:** Aggressive (results reused for identical/similar queries within 10 min window)

### When to Use
- Day-to-day coaching questions
- Quick suggestions
- Standard queries
- Low-risk topics

---

## Heavy Bag Session (Deep Reasoning)

### Triggering
- **Auto-detect escalation** if:
  - Query complexity score exceeds threshold (multi-step, novel situation, high-risk topic)
  - Query involves research requirement or Scout Report
  - Previous Quick Round response was marked "unhelpful" by user
  - Explicit user request (Coaches/Admins: "Give me a deep analysis")

- **Manual override** by:
  - Coaches: "Switch to Heavy Bag" button / command
  - Admins: Always available
  - Athletes: Not available by default (show as "Coming soon" or "Ask your coach")

### Execution
- **Async (background, by default)**
  - User gets Quick Round response immediately
  - Deep analysis queued for background processing
  - Results delivered via notification + dashboard + updated SHADOW Library
  
- **Sync (user waits, on-demand)**
  - Only if user explicitly requests and role permits
  - Latency target: < 10 seconds (extended reasoning)

### When to Use
- Complex athlete situations (form gaps, psychology, conflict resolution)
- Research requirements
- Admin reporting / analysis
- Scout Reports (opportunities, gaps in knowledge)
- Failure analysis (when coaching didn't work as expected)

---

## Context Layers (buildUserShadowContext)

### Architecture
```typescript
interface ShadowContext {
  baseContext: BaseContext;        // Role, org, authority
  queryContext: QueryContext;       // Classification, complexity, intent
  personalShadow: PersonalShadow;   // User preferences, style, history
  knowledgeContext: KnowledgeContext; // Relevant library entries, precedents
}
```

### Weighting Dimensions (Order of Priority)

| Dimension | Quick Round | Heavy Bag | Notes |
|-----------|-------------|-----------|-------|
| **Role** | High | High | Coach vs Athlete vs Admin — determines scope |
| **Authority Level** | High | High | What decisions can user make? |
| **Query Complexity** | Medium | High | Simple → light context; complex → full context |
| **Query Topic** | High | High | Medical vs coaching vs operational vs research |
| **Recency** | High | High | Recent data weighted more |
| **Confidence** | Medium | High | Unreliable data deprioritized in recommendations |
| **User Expertise** | Medium | High | Veteran coach gets less scaffolding; new coach gets more |
| **Previous Feedback** | Low | High | What worked for THIS user in past? |
| **Org Context** | Low | Low | Gym size, focus area, maturity — secondary for now |

### Implementation Notes
- Quick Round: Use top 3-4 dimensions, sample knowledge context (last 10 entries)
- Heavy Bag: Use all dimensions, full knowledge context, all recent interactions
- Both: Always include `organization_id` filter (multi-tenant isolation)

---

## Personal User Shadow Data

### Storage
**PostgreSQL:** `pilot.shadow_user_profiles`

### Schema (Relevant Fields)
```typescript
interface ShadowUserProfile {
  org_id: string;
  user_id: string;
  user_role: string;                    // coach | athlete | admin | etc
  authority_level: string;               // Full | Medical | Operations | Education | etc
  communication_style: string;           // Formal | Casual | Directive | Collaborative | etc
  expertise_level: 'novice' | 'intermediate' | 'expert';
  remembered_facts: { [key: string]: string }; // {"athlete_height": "6'2\"", ...}
  recent_interactions: Array<{           // Last 20 interactions
    timestamp: Date;
    query_type: string;
    response_quality: 'helpful' | 'unhelpful' | 'neutral';
    topic: string;
  }>;
  interaction_count: number;             // Total interactions with SHADOW
  last_updated: Date;
  preferences: {
    default_mode: 'quick' | 'heavy' | 'auto';
    notify_on_deep_analysis: boolean;
  };
}
```

### How to Use in Chat Flow
1. **Load at request time:** Query before building context
2. **Update after response:** Log interaction, feedback, update recent_interactions array
3. **Easy to access:** Create helper function `loadUserProfile(userId, orgId)` and `updateUserProfile(...)`
4. **Cache-friendly:** Cache for 5 min, invalidate on explicit update

---

## Endpoint Refactoring (POST /api/pilot/shadow/chat)

### Current State
- Single monolithic function
- Doctrine validation baked in
- Context building implicit
- No feedback hooks

### Target State
```
POST /api/pilot/shadow/chat
├─ 1. buildShadowContext(user, query, userProfile)
│     └─ Returns: enriched context with all dimensions
├─ 2. classifyRequest(query, context)
│     └─ Returns: complexity score, topic, suggested tier (quick vs heavy)
├─ 3. validateDoctrine(query)
│     └─ Pre-flight: blocks diagnosis, clearance, prescription
├─ 4. callLLM(query, context, tier)
│     └─ Routes to appropriate model (future: pluggable)
│     └─ Handles streaming
├─ 5. validateResponse(response, user_authority)
│     └─ Post-flight: removes restricted content, adds deferrals
├─ 6. applyPersonality(response, userProfile.communication_style)
│     └─ Adjust tone, formatting, detail level
├─ 7. logInteraction(...)
│     └─ Record to audit + feedback hooks
├─ 8. triggerAsyncWork(...)
│     └─ If Heavy Bag + async: queue background deep analysis
└─ 9. return response to client
```

### Feedback Hooks to Add

**At step 7 (logInteraction):**
```typescript
interface InteractionLog {
  user_id: string;
  org_id: string;
  query: string;
  response: string;
  tier: 'quick' | 'heavy';
  context_dimensions: { [key: string]: any };
  timestamp: Date;
  // Feedback hooks (populated later by user or system)
  user_feedback?: 'helpful' | 'unhelpful' | 'neutral';
  outcome_tracked?: boolean;           // Did recommendation work?
  growth_metric_id?: string;           // Link to Growth Metrics if applicable
  library_suggestion?: string;         // Should this go into SHADOW Library?
}
```

**Callback after user provides feedback:**
- `recordFeedback(interactionId, feedback)` → Updates audit log + feeds Growth Metrics
- `trackOutcome(interactionId, outcome)` → Did the recommendation actually help?
- `suggestForLibrary(interactionId)` → Good interactions → SHADOW Library candidates

---

## Multi-Tenant Isolation Checklist

Before submitting any code, verify:

- [ ] All database queries include `WHERE organization_id = ?`
- [ ] User org_id verified from auth headers (not client-provided)
- [ ] `buildShadowContext()` filters knowledge library by org_id
- [ ] Personal User Shadow data fetched with org_id check
- [ ] Audit logs tagged with org_id
- [ ] Test coverage includes cross-org prevention scenarios

---

## Boxing Terminology Reference

For internal discussions and code comments:

| Term | Meaning | Usage |
|------|---------|-------|
| **Quick Round** | Fast model response | `tier: 'quick'` |
| **Heavy Bag Session** | Deep reasoning response | `tier: 'heavy'` |
| **The Corner** | Routing/orchestration layer | Future: `shadowRouter.ts` |
| **The Playbook** | SHADOW Knowledge Library | `pilot.shadow_library` |
| **Scout Report** | Research requirement | `research_requirement_id` in query |
| **The Scorecard** | Growth Metrics tracking | `pilot.growth_metrics` |

---

## What to Start With (Week 1)

**Priority Order:**

1. ✅ **Refactor context layer** (`buildUserShadowContext`)
   - Add weighting dimensions
   - Make it pluggable for Quick vs Heavy

2. ✅ **Refactor endpoint** (`POST /api/pilot/shadow/chat`)
   - Separate concerns into named functions
   - Add feedback hooks
   - Keep doctrine validation (pre + post)

3. ✅ **Load Personal User Shadow data**
   - Create `loadUserProfile()` helper
   - Integrate into context building
   - Cache with 5-min TTL

4. ✅ **Add complexity classifier**
   - Heuristic function to detect if Quick Round or Heavy Bag
   - Return confidence score

5. ⏳ **Verify multi-tenant isolation**
   - Audit log queries for org_id filters
   - Test cross-org prevention

**What to Skip (Wait for Router):**
- ❌ Calling different models
- ❌ Background job queue
- ❌ Async execution logic

---

## Testing Strategy

### Unit Tests
- `classifyRequest()` → verify complexity detection
- `buildShadowContext()` → verify weighting logic
- `loadUserProfile()` → verify data retrieval + caching
- Doctrine validation → already covered, keep existing tests

### Integration Tests
- Full request flow (Quick Round scenario)
- Multi-tenant isolation (same query, different orgs)
- Feedback hook capture
- Context weighting (verify correct dimensions used)

---

## Performance Targets

| Metric | Quick Round | Heavy Bag (Sync) |
|--------|------------|-----------------|
| **Total latency** | < 3 sec | < 10 sec |
| **LLM inference** | < 2 sec | < 8 sec |
| **Context building** | < 500ms | < 1 sec |
| **Validation + logging** | < 300ms | < 500ms |

---

## Questions for Design Review

Once implementation starts, review with team:

1. **Complexity classifier heuristic:** What score threshold triggers Heavy Bag? (Initial guess: score > 7/10)
2. **Async job storage:** Where to queue background tasks? (Postgres? Redis? Azure Service Bus?)
3. **Feedback UI:** Where do users provide "helpful/unhelpful" feedback in the chat?
4. **Library contribution:** Automatic ("all Deep Analysis goes to Library") or manual review?

---

**Reference Implementation:** None yet — you're building the foundation!  
**Next Milestone:** Once one model deployed to Azure, integrate it with these scaffolds.


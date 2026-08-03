# SHADOW: Total Best ML Build Specification

**Version:** 1.1  
**Status:** Production Design  
**Last Updated:** 2026-08-03  
**Verified against code:** `main` @ `2aa2ded` — §1, §2.1, §4.2, §5, and §7 were
rewritten on 2026-08-03 to match `shadowRouter.ts` / `shadowClassifier.ts` as
shipped. Where this document and the code disagree, the code is authoritative;
treat any drift as a defect in this file.  
**Audience:** Engineering, Platform Leadership

---

## Executive Summary

SHADOW is the responsible, adaptive, continuously improving organizational intelligence engine for the PPBF Platform. It amplifies coaches and athletes with evidence-based, personalized guidance while maintaining strict human authority, safety boundaries, and privacy.

This specification defines the complete technical architecture, API contracts, data models, and implementation phases for SHADOW v1.0+.

---

## Table of Contents

1. [Core Architecture](#core-architecture)
2. [System Components](#system-components)
3. [API Specifications](#api-specifications)
4. [Data Models](#data-models)
5. [Processing Pipelines](#processing-pipelines)
6. [Safety & Governance](#safety--governance)
7. [Implementation Phases](#implementation-phases)
8. [File Structure](#file-structure)
9. [Deployment Architecture](#deployment-architecture)
10. [Success Metrics](#success-metrics)

---

## Core Architecture

### 1.1 Hybrid Intelligence Stack

SHADOW is a **dual-mode** inference architecture — Quick Round and Heavy Bag —
plus a dedicated vision path for Film Study. (An earlier three-tier design with
a "Standard Round" middle tier was never built; the classifier resolves every
conversational request to one of the two tiers.)

```
User Query
    ↓
┌─────────────────────────────────────┐
│  REQUEST CLASSIFIER                 │
│  (shadowClassifier.ts)              │
│  - Complexity scoring (0.0 - 1.0)   │
│  - Topic category                   │
│  - Role baseline adjustment         │
│  - High-risk pattern detection      │
│  - Manual tier override handling    │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│  THE CORNER (shadowRouter.ts)       │
│  Model routing per session type     │
└─────────────────────────────────────┘
    ↓
    ├─ Quick Round (complexity < 0.4, and boundary cases 0.4–0.6)
    │  └→ gpt-5.6-luna-shadow (fallback: gpt-5-mini-shadow)
    │     measured ~33s, 90s timeout, synchronous, no streaming yet
    │
    ├─ Heavy Bag (complexity ≥ 0.6, high-risk patterns, or manual escalation)
    │  └→ gpt-5.6-sol-shadow (fallback: gpt-5-shadow)
    │     measured ~95s, 210s timeout — async-default via shadow_jobs,
    │     processed by /jobs/process, result linked in shadow_chat_audit
    │
    └─ Film Study (vision)
       └→ gpt-5-vision-shadow (fallback: text-only via luna)
          measured ~75s, 200s timeout
```

**Design Rationale:**
- Quick Round handles the common case: fast (for a reasoning model), consistent
  coaching answers. It is still ~33s unstreamed today — streaming this path is
  the top open UX item, tracked in the capability build plan (Track S1).
- Heavy Bag is reserved for complex, high-stakes work (progression planning,
  risk assessment, sensitive escalations) and is a poor synchronous wait by
  design — the async job path is the intended UX.
- High-risk medical/psychological patterns force Heavy Bag regardless of the
  complexity score. Safety escalation is never latency-optimized away.
- All timeouts stay under 240s because that is the Azure Container Apps ingress
  limit; a longer provider wait would be cut off by the platform.
- All paths are deterministic and explainable (routing rationale and
  classification reasoning are recorded per request).

### 1.2 Inference Engine Selection

**Primary (and only) provider:** Azure OpenAI. The model registry lives in
`shadowRouter.ts` (`MODEL_REGISTRY`) and is the source of truth; latencies below
were measured 2026-07-29 against a representative Heavy Bag prompt.

| Deployment | Role | Measured latency | Timeout | Max completion |
|---|---|---|---|---|
| `gpt-5.6-luna-shadow` | Quick Round primary | ~33s | 90s | 8192 |
| `gpt-5.6-sol-shadow` | Heavy Bag primary | ~95s | 210s | 16384 |
| `gpt-5-mini-shadow` | Quick Round fallback | ~58s | 150s | 4096 |
| `gpt-5-shadow` | Heavy Bag fallback | ~75s | 200s | 16384 |
| `gpt-5-vision-shadow` | Film Study (vision) | ~75s | 200s | 16384 |

`gpt-5-vision-shadow` is the same natively-multimodal gpt-5 under its own
deployment alias; Film Study stays on it because the Azure catalog reports no
vision flag for the gpt-5.6 family. Scout/Board synthesis and background
recovery rounds route through the same registry (sol or luna).

**Degradation strategy (as implemented):**
1. Azure OpenAI current generation (luna/sol)
2. Azure OpenAI previous generation (mini/gpt-5) — same tier, never a silent
   downgrade from heavy to quick
3. Human escalation (safety net for all services)

**Deferred — specified but NOT implemented:** an Anthropic Claude secondary
provider and a static-library-claims tertiary path. Neither exists in
`azureAiRuntime.ts` today. Build them only if Azure quota becomes a real
production incident; until then this paragraph is the record that the gap is
intentional.

**Fine-Tuning Plan — deferred indefinitely:** the learning loop's
`fine_tuning_pipeline` capability is disabled in code until a governance,
privacy, and evaluation process exists (threshold: 500 labeled examples). The
earlier "Q3 2026, +12-15% relevance" projection was aspirational; collecting
high-quality (query, context, response, feedback) pairs under the retention
policy is the only fine-tuning work in scope now.

### 1.3 Context Assembly Engine

For each query, SHADOW constructs an optimal context window:

```typescript
interface ShadowContext {
  // User & Role Context
  userProfile: {
    role: 'athlete' | 'coach' | 'parent' | 'admin';
    organizationId: string;
    athleteProfile?: AthleteProfile;
  };
  
  // Quick Round: lightweight depth (classifier suggestedContextDepth)
  quickRoundContext: {
    recentQuestions: QueryHistory[];  // last 3 from session
    roleGuidance: string;              // 150 tokens
    safetyBoundaries: string;          // 200 tokens
  };
  
  // Heavy Bag: full depth
  heavyBagContext: {
    ...quickRoundContext,
    athleteAssessments: AssessmentSummary[];
    progressionHistory: ProgressionHistory;
    previousRecommendations: Recommendation[];
    researchLibraryMatches: ResearchMatch[];
    executedRecommendations: ExecutionOutcome[];
    learningLoopInsights: LearningInsight[];
  };
}
```

There are two context depths, matching the two tiers (`suggestedContextDepth:
'lightweight' | 'full'`); the three-depth version with a "standard" middle was
part of the never-built middle tier. Video analysis results reach context via
the Film Study proposals path, and biometric trends are deferred with the rest
of biometric integration (§7 Phase 4).

---

## System Components

### 2.1 The Classifier and The Corner

**Purpose:** Resolve each query to a tier (classifier), then to a model and call
parameters (router).

**Locations:** `src/server/pilot/shadowClassifier.ts` (tier decision) and
`src/server/pilot/shadowRouter.ts` (The Corner — model routing).

**Algorithm (as shipped — a transparent heuristic, deliberately not a trained
model):** `classifyRequest(message, role, userManualTier?)` computes an additive
complexity score:

1. **Message length** — word-count buckets, max +0.2
2. **Complexity keywords** — multi-step / trade-off / edge-case / compare /
   conditional-logic patterns, +0.05 each, capped at +0.3
3. **High-risk patterns** — concussion, medical clearance, return-to-play,
   surgery, prescription, weight cutting, self-harm/mental-health: **+0.6**,
   which forces Heavy Bag regardless of everything else
4. **Role baseline** — coach +0.15, admin/org-admin +0.1, platform owner/staff
   +0.05, parent/board 0, athlete/volunteer −0.05

It also detects a topic (technique, training, recovery, medical, mindset,
strategy, competition, safety, equipment) by first-match pattern, and honors
manual tier overrides: **Heavy Bag escalation is gated to coach/admin/org-admin/
platform-owner; Quick Round downgrade is available to anyone** (a downgrade is
always safe). There is no history multiplier and no profile-tier adjustment —
earlier drafts of this section described both, but they were never built.

**Routing Decision (thresholds in code):**
- **complexity < 0.4:** Quick Round
- **complexity ≥ 0.6:** Heavy Bag
- **0.4 ≤ complexity < 0.6 (boundary):** Quick Round, with a manual-override
  flag offered to authorized roles

**Known limitation:** as a pure heuristic it will misroute nuanced language in
both directions (high-risk patterns excepted — those always escalate). The
planned evolution is to log (query, tier, override, outcome) and calibrate or
augment with a small classifier once labeled volume exists — not before
(capability build plan, Track S8).

### 2.2 Multimodal Input Engine

SHADOW accepts and processes:

#### 2.2.1 Text
- Coach notes & assessments
- Athlete check-ins
- Parent observations
- Board documents
- Policy queries

#### 2.2.2 Video Intelligence
- **Pose Estimation:** OpenAI Vision API detects key points (15 points per frame)
- **Movement Quality Scoring:** ML classifier evaluates technique quality (0-100)
- **Drill Classification:** Matches video to known drills (confidence threshold 0.85+)
- **Error Detection:** Identifies form deviations, safety issues
- **Personalized Drill Recommendations:** Based on detected errors

**API:** `POST /api/pilot/shadow/upload`
```typescript
{
  contentType: 'video' | 'document' | 'image';
  fileData: Buffer;
  context: {
    athleteId: string;
    drillType?: string;
    sessionDate: ISO8601;
    videoMetadata?: {
      duration: number;
      fps: number;
      resolution: string;
    };
  };
}
```

#### 2.2.3 Document Intelligence
- **Key Fact Extraction:** Azure Document Intelligence extracts structured data
- **Validation:** Cross-references with athlete record for inconsistencies
- **Linking:** Automatically links to athlete profile
- **OCR:** Processes handwritten notes (confidence > 0.90)

**API:** `POST /api/pilot/shadow/documents/analyze`
```typescript
{
  documentId: string;
  documentType: 'medical_intake' | 'assessment_result' | 'coach_note' | 'parent_observation';
  extractedFacts: ExtractedFact[];
  inconsistencies: Inconsistency[];
  linkedRecords: LinkedRecord[];
}
```

#### 2.2.4 Biometric Integration
- **Real-time Ingestion:** HR, HRV, sleep, training load from wearables
- **Trend Detection:** 7-day, 30-day, 90-day rolling averages
- **Anomaly Detection:** ML classifier identifies unusual patterns
- **Predictive Signals:** Fatigue, readiness, injury risk (ML-based)

**API:** `POST /api/pilot/shadow/metrics/ingest`
```typescript
{
  athleteId: string;
  timestamp: ISO8601;
  metrics: {
    heartRate?: number;
    hrv?: number;
    sleepQuality?: 0-100;
    trainingLoad?: number;
    recoveryScore?: 0-100;
    readinessScore?: 0-100;
    injuryRiskScore?: 0-100;
  };
}
```

### 2.3 Personalization Engine

SHADOW maintains a **tiered voluntary profiling system** (Bronze / Silver / Gold):

```typescript
interface UserProfile {
  // Tier
  tier: 'Bronze' | 'Silver' | 'Gold';
  tier_updated_at: ISO8601;
  interaction_count: number;
  
  // Learning Style
  learning_style: 'visual' | 'kinesthetic' | 'verbal' | 'mixed';
  explanation_complexity: 0-100;  // 0=simple, 100=advanced
  example_preference: 'video' | 'text' | 'diagram' | 'real_athlete';
  
  // Personality & Traits
  personality_traits: {
    growth_mindset_score: 0-100;
    grit_score: 0-100;
    coachability_score: 0-100;
    resilience_score: 0-100;
  };
  
  // Preferences
  communication_style: 'direct' | 'collaborative' | 'supportive' | 'data_driven';
  feedback_frequency: 'real_time' | 'daily' | 'weekly' | 'on_request';
  goal_orientation: 'technique' | 'performance' | 'health' | 'competition';
  
  // Memory
  remembered_facts: RememberedFact[];  // contextual facts about athlete
  open_questions: OpenQuestion[];       // unresolved topics
  previous_concerns: Concern[];         // history of worries/escalations
  
  // Interaction State
  last_interaction: ISO8601;
  session_context: SessionContext;
  readiness_signal: ReadinessSignal;
}

// Tier advancement rules
function advanceTier(profile: UserProfile): 'Bronze' | 'Silver' | 'Gold' {
  if (profile.interaction_count < 10) return 'Bronze';
  if (profile.interaction_count < 50) return 'Silver';
  return 'Gold';
}
```

**Adaptive Response Generation:**

```typescript
interface AdaptiveResponse {
  // Dynamic formatting
  tone: 'directive' | 'collaborative' | 'supportive' | 'analytical';
  complexity: 0-100;
  length: 'brief' | 'standard' | 'detailed';
  format: 'text' | 'bullet_points' | 'numbered_steps' | 'comparison' | 'video_script';
  
  // Example selection
  exampleRelevance: 'peer_athlete' | 'similar_sport' | 'published_research' | 'organizational_data';
  
  // Personalized framing
  motivationalElementsEnabled: boolean;
  safetyEmphasisLevel: 0-100;  // higher for injury-prone athletes
}
```

### 2.4 Closed-Loop Learning System

**Philosophy:** Every recommendation → outcome signal → effectiveness scored → library updated → profile updated

#### 2.4.1 Recommendation Lifecycle

```typescript
interface Recommendation {
  id: string;
  messageId: string;
  athleteId: string;
  organizationId: string;
  
  // Recommendation
  title: string;
  description: string;
  category: string;
  confidence: 0-100;  // AI confidence in recommendation
  reasoning: string;  // full chain-of-thought
  
  // Guidance
  successCriteria: string[];
  timeframe: '1_session' | '1_week' | '4_weeks' | '12_weeks';
  progressionPath?: string;
  
  // Safety
  contraindications: string[];
  escalationTriggers: string[];
  
  // Tracking
  status: 'pending' | 'accepted' | 'in_progress' | 'completed' | 'abandoned' | 'escalated';
  created_at: ISO8601;
  deadline: ISO8601;
  executed_at?: ISO8601;
}
```

#### 2.4.2 Outcome Signal Collection

```typescript
interface OutcomeSignal {
  recommendationId: string;
  athlete_feedback: {
    outcome: 'thumbs_up' | 'thumbs_down' | 'followed_advice' | 'escalated_to_human';
    rating: 1-5;
    comment?: string;
  };
  
  objective_data: {
    progressionMade: boolean;
    improvementMetric: number;
    timeToResult: number;
    unintendedConsequences?: string[];
  };
  
  execution_context: {
    sessionType: 'quick_round' | 'standard' | 'heavy_bag';
    complexityScore: 0-100;
    athleteProfile: UserProfile;
    organizationContext: string;
  };
  
  recorded_at: ISO8601;
}
```

#### 2.4.3 Effectiveness Scoring

```typescript
function scoreEffectiveness(signal: OutcomeSignal): EffectivenessScore {
  let score = 0;
  
  // Subjective feedback (40%)
  if (signal.athlete_feedback.outcome === 'thumbs_up') score += 40;
  else if (signal.athlete_feedback.outcome === 'thumbs_down') score -= 20;
  else if (signal.athlete_feedback.outcome === 'followed_advice') score += 30;
  
  // Objective outcome (40%)
  if (signal.objective_data.progressionMade) score += 40;
  else score -= 10;
  
  // Rating (20%)
  score += (signal.athlete_feedback.rating / 5) * 20;
  
  // Penalties
  if (signal.objective_data.unintendedConsequences?.length > 0) score -= 15;
  
  return {
    score: Math.max(0, Math.min(100, score)),
    confidence: calculateConfidence(signal),
    recommendation_id: signal.recommendationId
  };
}
```

#### 2.4.4 Library Update Trigger

When recommendation effectiveness is scored:

1. **If score > 80:** Promote recommendation to high-confidence library entry
2. **If score 50-80:** Keep in standard library (effective for most contexts)
3. **If score 30-50:** Add context markers ("works for: athletes with X profile")
4. **If score < 30:** Flag for review, consider removal

```typescript
interface LibraryEntry {
  id: string;
  title: string;
  description: string;
  
  // Effectiveness tracking
  effectiveness_score: 0-100;
  success_count: number;
  failure_count: number;
  confidence_threshold: 0-100;
  
  // Contextual applicability
  applicable_to: {
    roles: string[];
    athlete_profiles: string[];
    topics: string[];
    organizations: string[];
    age_groups: string[];
  };
  
  // Versioning
  version: number;
  created_at: ISO8601;
  updated_at: ISO8601;
  promoted_from_recommendation_id?: string;
}
```

### 2.5 Safety & Governance Layer

#### 2.5.1 Pre-Flight Validation

```typescript
async function validateRequest(
  message: string,
  userRole: string,
  organizationId: string
): Promise<ValidationResult> {
  const checks = await Promise.all([
    // 1. Content safety
    detectJailbreakAttempts(message),
    detectMedicalEmergency(message),
    detectMaliciousIntent(message),
    
    // 2. Rate limiting
    checkUserRateLimit(userRole, organizationId),
    
    // 3. Consent & privacy
    verifyConsentStatus(organizationId),
    verifyDataRetentionPolicy(organizationId),
  ]);
  
  if (checks.some(c => c.blocked)) {
    return { approved: false, reason: 'safety_gate_triggered' };
  }
  
  return { approved: true };
}
```

#### 2.5.2 Post-Response Filtering

```typescript
async function filterResponse(
  response: string,
  context: RequestContext
): Promise<FilteredResponse> {
  const issues = [];
  
  // 1. Medical boundary enforcement
  if (isMedicalAdvice(response) && !context.userRole.includes('doctor')) {
    response = prependMedicalDisclaimer(response);
    issues.push('medical_boundary_triggered');
  }
  
  // 2. Confidence markers
  if (estimateConfidence(response) < 0.7) {
    response = addConfidenceMarker(response, 'LOW');
    issues.push('low_confidence_flagged');
  }
  
  // 3. Explainability
  const explanation = generateChainOfThought(response);
  
  // 4. Escalation triggers
  if (shouldEscalatToHuman(response)) {
    issues.push('escalation_triggered');
  }
  
  return {
    filtered_response: response,
    issues,
    explanation,
    confidence: estimateConfidence(response),
    requires_human_review: issues.includes('escalation_triggered')
  };
}
```

#### 2.5.3 Audit Trail

Every interaction is logged with full traceability:

```typescript
interface AuditEntry {
  id: string;
  timestamp: ISO8601;
  
  // Request
  user_id: string;
  user_role: string;
  organization_id: string;
  message: string;
  message_hash: string;  // one-way hash for privacy
  
  // Processing
  classification: CornerClassification;
  context_assembled: string[];
  model_used: string;
  prompt_hash: string;
  token_count: number;
  
  // Response
  response: string;
  response_hash: string;
  confidence: 0-100;
  safety_filters_applied: string[];
  
  // Outcome
  user_feedback?: 'thumbs_up' | 'thumbs_down' | 'escalated';
  outcome_signal?: OutcomeSignal;
  
  // Retention
  retention_policy: 'active' | 'archived' | 'deleted';
  retention_until: ISO8601;
}
```

---

## API Specifications

### 3.1 Primary Chat Endpoint

**`POST /api/pilot/shadow/chat`**

```typescript
// Request
{
  message: string;
  sessionType?: 'quick_round' | 'standard' | 'heavy_bag';  // optional override
  context?: {
    athleteId?: string;
    previousMessagesCount?: number;
  };
}

// Response (200 OK)
{
  success: true;
  response: string;
  messageId: string;
  createdAt: ISO8601;
  
  // Metadata
  tier: 'quick_round' | 'standard' | 'heavy_bag';
  complexity: 0-100;
  confidence: 0-100;
  modelUsed: string;
  tokenCount: {
    input: number;
    output: number;
  };
  
  // Async handling
  async: boolean;  // true if Heavy Bag
  jobId?: string;  // for async queries
  estimatedCompleteTime?: ISO8601;
  
  // Safety & governance
  filtered: boolean;
  requiresHumanReview: boolean;
  escalationReason?: string;
  chainOfThought?: string;
}

// Error Response (5xx, 400)
{
  success: false;
  error: string;
  errorCode: 'rate_limited' | 'safety_blocked' | 'service_unavailable' | 'invalid_request';
}
```

**Auth:** `requirePrincipal` (cookie-based session)  
**Rate Limits:** 30 requests/60s per user, 400/day per user, 10 Heavy Bag/hour per user
(administrative tier exempt)  
**Timeout:** Quick Round (2s), Standard (5s), Heavy Bag (0s, async)

> **Two deliberate divergences from earlier drafts of this section.** Both were decided;
> neither is drift.
>
> The per-minute cap is **30, not the 100 this document specified** — stricter, because the
> limit exists to protect the connection pool and the provider from a double-submit or a
> retry loop, not to ration a person. `shadowRateLimit.ts` carries the reasoning inline.
>
> The Heavy Bag cap is **per user, not per organization** (owner decision, 2026-08-01). A
> shared organization pool was rejected on purpose: one member exhausting it would silently
> deny everyone else in the gym, and a coach would have no way to tell a limit from a fault.
> The administrative tier — `organization_admin`, `admin`, `platform_owner` — is exempt.
> Note that this set is deliberately *not* the manual-override set, which includes `coach`:
> being able to *choose* Heavy Bag and being able to run it *without limit* are separate
> permissions and get separate lists.
>
> Every limit is overridable per deployment through `PPBF_SHADOW_RATE_LIMIT_<KEY>`. The
> window is not — `chat_daily` means a day, so an override that changed it would make the
> key a lie.

### 3.2 Feedback Endpoint

**`POST /api/pilot/shadow/feedback`**

```typescript
{
  messageId: string;
  recommendationId?: string;
  helpful: boolean;
  rating?: 1-5;
  comment?: string;
  outcomeSignal: 'thumbs_up' | 'thumbs_down' | 'followed_advice' | 'escalated_to_human';
}

// Response (200 OK)
{
  ok: true;
  feedbackId: string;
  aggregatedSatisfaction: {
    totalResponses: number;
    satisfactionRate: 0-100;
    avgRating: 1-5;
  };
}
```

**Purpose:** Collect outcome signals for Learning Loop

### 3.3 Job Processing Endpoint

**`POST /api/pilot/shadow/jobs/process`**

Claims and executes the next pending Heavy Bag job.

```typescript
{
  jobType?: 'heavy_bag' | 'scout_report' | 'board_summary' | 'learning_loop';
}

// Response (200 OK)
{
  ok: true;
  jobId: string;
  jobType: string;
  status: 'completed' | 'failed';
  output: any;  // depends on job type
  executionTime: number;  // milliseconds
  error?: string;
}
```

**Auth:** `x-bootstrap-key` header OR `platform_owner` session  
**Timeout:** 60 seconds

### 3.4 Job Status Endpoint

**`GET /api/pilot/shadow/jobs/[jobId]`**

```typescript
// Response
{
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  jobType: string;
  createdAt: ISO8601;
  startedAt?: ISO8601;
  completedAt?: ISO8601;
  output?: any;
  error?: string;
  progress?: {
    current: number;
    total: number;
  };
}
```

### 3.5 Scout Reports Endpoint — **not implemented; awaiting a product decision**

Recorded here as specified, but nothing below `GET /api/pilot/shadow/scout-reports` exists
today, and the generation pipeline in §5.5 was deliberately deleted — `generateScoutReport`
is gone and only a tombstone comment remains at `shadowHeavyBag.ts:261`.

`/shadow/scout` is still linked and titled for Scout Reports while showing the generic job
list. That is a live inconsistency with two honest resolutions — build the pipeline, or
retitle the surface to what it shows — and it is an open owner decision, not drift to be
quietly patched. **Do not treat this section as describing shipped behavior.**

`POST /api/pilot/shadow/jobs` below **does** exist; it is the enqueue path that survived.

**`POST /api/pilot/shadow/jobs`**  (enqueue Scout Report)

```typescript
{
  jobType: 'scout_report';
  athleteId: string;
  scope: 'last_30_days' | 'last_90_days' | 'all_time';
}

// Response
{
  jobId: string;
  status: 'pending';
  estimatedCompleteTime: ISO8601;
}
```

**`GET /api/pilot/shadow/scout-reports`**  (retrieve completed reports)

```typescript
// Response
[
  {
    reportId: string;
    athleteId: string;
    generatedAt: ISO8601;
    report: {
      summary: string;
      strengths: string[];
      growthAreas: string[];
      recommendedTopics: string[];
      openQuestions: string[];
      insights: string;
    };
  }
]
```

### 3.6 Research Requirements Endpoint

**`POST /api/pilot/shadow/research-requirements`**

Auto-generates research requirements based on recommendation effectiveness gaps.

```typescript
// Response
{
  ok: true;
  generatedRequirements: [
    {
      id: string;
      title: string;
      description: string;
      priority: 'high' | 'medium' | 'low';
      linkedRecommendationIds: string[];
      evidenceNeeded: string;
      estimatedResearchHours: number;
    }
  ]
}
```

### 3.7 Migration Endpoint — **removed, do not rebuild**

This section formerly specified `POST /api/pilot/shadow/migrate`, which ran idempotent DDL
to create and verify the shadow tables. **No such endpoint exists, and none should.**

Schema is applied by the manual `apply-migrations` workflow, which requires an operator to
retype the target environment before it will run, and which is governed by an explicit rule
that migrations are **never applied as a side effect of merging**. A workflow guard also
fails the run if any `pilot:apply-*` script is missing from the `all` list, so a new
migration cannot be silently left out of a rebuild.

That is strictly safer than an HTTP route that could execute DDL against the production
youth-data database on a single request — which is precisely the pattern deleted from this
platform in the 2026-07-31 audit, and which README and MASTER_INDEX had always claimed did
not exist.

Anything that needs schema goes in a migration file under `infra/azure/` and a matching
`pilot:apply-*` script. Nothing gets a DDL endpoint.

---

## Data Models

### 4.1 Database Schema

```sql
-- Core Feedback & Learning
CREATE TABLE shadow_feedback (
  feedback_id UUID PRIMARY KEY,
  message_id UUID,
  organization_id VARCHAR(255),
  account_id VARCHAR(255),
  role VARCHAR(50),
  helpful BOOLEAN,
  rating INT CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  outcome_signal VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES pilot.organizations(organization_id)
);

CREATE TABLE shadow_learning_events (
  event_id BIGSERIAL PRIMARY KEY,
  organization_id VARCHAR(255),
  message_id UUID,
  recommendation_id UUID,
  feedback_id UUID,
  topic VARCHAR(100),
  session_type VARCHAR(50),
  outcome_signal VARCHAR(50),
  effectiveness_score INT,
  effectiveness_confidence FLOAT,
  library_updated BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User Profiling
CREATE TABLE shadow_user_profiles (
  profile_id UUID PRIMARY KEY,
  organization_id VARCHAR(255),
  account_id VARCHAR(255),
  tier VARCHAR(20),
  tier_updated_at TIMESTAMP,
  interaction_count INT DEFAULT 0,
  learning_style VARCHAR(50),
  explanation_complexity INT,
  communication_style VARCHAR(50),
  feedback_frequency VARCHAR(50),
  goal_orientation VARCHAR(50),
  last_interaction TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Recommendation Effectiveness
CREATE TABLE shadow_recommendation_effectiveness (
  entry_id UUID PRIMARY KEY,
  organization_id VARCHAR(255),
  recommendation_title VARCHAR(255),
  applicable_roles VARCHAR(255)[],
  applicable_athlete_profiles VARCHAR(255)[],
  effectiveness_score INT,
  success_count INT DEFAULT 0,
  failure_count INT DEFAULT 0,
  confidence_threshold INT,
  version INT DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  promoted_from_recommendation_id UUID
);

-- Job Queue for Heavy Bag
CREATE TABLE shadow_jobs (
  job_id UUID PRIMARY KEY,
  organization_id VARCHAR(255),
  account_id VARCHAR(255),
  job_type VARCHAR(50),
  status VARCHAR(50) DEFAULT 'pending',
  input_data JSONB,
  output_data JSONB,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  expires_at TIMESTAMP,
  retry_count INT DEFAULT 0,
  max_retries INT DEFAULT 3
);

-- Chat Audit Trail
CREATE TABLE shadow_chat_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  message_id UUID,
  organization_id VARCHAR(255),
  account_id VARCHAR(255),
  user_role VARCHAR(50),
  message_hash VARCHAR(255),
  model_used VARCHAR(100),
  complexity_score FLOAT,
  confidence FLOAT,
  response_hash VARCHAR(255),
  safety_filters_applied VARCHAR(255)[],
  feedback_received VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  retention_until TIMESTAMP
);

-- Library Review Flags
CREATE TABLE shadow_library_review_flags (
  flag_id UUID PRIMARY KEY,
  organization_id VARCHAR(255),
  library_entry_id VARCHAR(255),
  recommendation_id UUID,
  flag_reason VARCHAR(100),
  effectiveness_trend VARCHAR(50),
  priority VARCHAR(50),
  flagged_by VARCHAR(255),
  resolution_status VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP
);
```

### 4.2 Cache Layer (Redis) — **NOT IMPLEMENTED; design only**

No Redis layer exists in the SHADOW path today: profiles, recent queries,
library entries, and jobs are all read from Postgres, and the job queue is
`shadow_jobs` with lease-based claiming. The keyspace below is retained as the
design of record for if/when a cache tier is justified by measured load — it is
**not** a description of running code.

```
// User Profiles (2-hour TTL)
shadow:profiles:{organization_id}:{account_id} → UserProfile (JSON)

// Recent Queries (1-hour TTL)
shadow:recent:{account_id}:{session_id} → Query[] (JSON)

// Library Entries (24-hour TTL)
shadow:library:{topic} → LibraryEntry[] (JSON)

// Recommendation Tracking (7-day TTL)
shadow:recommendations:{athlete_id}:{recommendation_id} → Recommendation (JSON)

// Job Queue (active)
shadow:jobs:pending → Job[] (JSON)
shadow:jobs:{job_id} → Job (JSON)
```

---

## Processing Pipelines

### 5.1 Quick Round Pipeline (synchronous, ~33s measured)

```
1. Message received
2. Validate request (content safety, rate limits — 30/60s chat bucket)
3. Classify (shadowClassifier: complexity < 0.4, or boundary 0.4–0.6)
4. Assemble lightweight context (role guidance, safety boundaries)
5. Call Azure OpenAI gpt-5.6-luna-shadow (90s timeout; fallback gpt-5-mini)
6. Filter response (medical boundaries, confidence markers)
7. Log to shadow_chat_audit
8. Return response with metadata
```

**Measured:** ~33s end-to-end — luna is a reasoning model and there is **no
streaming yet**. The earlier "< 2s" SLA was aspirational and is withdrawn;
streaming this path (Track S1) is the route to perceived speed, not a faster
synchronous wait.

### 5.2 Standard Round Pipeline — **REMOVED FROM DESIGN**

The middle tier was never built. Boundary-complexity requests (0.4–0.6) run as
Quick Round with a manual escalation flag for authorized roles (§2.1). This
heading is retained so old references resolve to an explanation rather than a
dangling anchor.

### 5.3 Heavy Bag Pipeline (async-default, ~95s measured execution)

```
1. Message received
2. Validate & classify (complexity ≥ 0.6, high-risk pattern, or manual
   escalation by an authorized role) — 10/user/hour Heavy Bag rate bucket
3. Create job record → shadow_jobs table (status = 'pending')
4. Return jobId to user with "processing" indicator
5. [Async] /api/pilot/shadow/jobs/process claims job (lease-based)
6. [Async] Assemble full context (history, library evidence, research)
7. [Async] Call Azure OpenAI gpt-5.6-sol-shadow (210s timeout; fallback gpt-5)
8. [Async] Apply full safety pipeline
9. [Async] Update job record (status = 'completed', output = response)
10. [Client polls via GET /api/pilot/shadow/jobs/:jobId]
```

**Measured:** ~95s model execution. The earlier "< 30s" SLA was aspirational
and is withdrawn; the async job path is the intended UX, and timeouts are
bounded by the 240s Azure Container Apps ingress limit, not by an SLA.

### 5.4 Learning Loop Pipeline

**Trigger:** User submits feedback (thumbs up/down/escalation)

```
1. Feedback received → POST /api/pilot/shadow/feedback
2. Record to shadow_feedback table
3. Link to recommendation & message
4. [Async, fire-and-forget] Call processLearningSignal()
5. [Async] Score effectiveness (0-100)
6. [Async] Update shadow_learning_events
7. [Async] Determine library action:
   - If score > 80: promote to high-confidence entry
   - If score < 30: flag for review
   - If context-specific: add applicability markers
8. [Async] Update user profile (interaction_count++, tier_recalc)
9. [Async] Check for auto-generated research requirements
10. [Async] Update personalization engine
```

**Fire-and-Forget:** Does not block feedback response

### 5.5 Scout Report Generation Pipeline — **deleted; see §3.5**

The dedicated producer this section describes (`generateScoutReport`, `requestMode: 'profile'`,
72h TTL) was **fully implemented and never gained a caller** — the live scout path has always
been the chat route's `executeHeavyBagAsync` branch. It was deleted in the 2026-07-31 audit
(finding B5) rather than kept plausible; git history holds it if a profile-mode scout is ever
wanted.

The flow below is retained as the design of record for whoever picks up that decision. It is
**not** a description of running code.

**Trigger:** User requests Scout Report OR admin processes pending job

```
1. GET /api/pilot/shadow/scout-reports OR POST with athleteId
2. Create scout_report job → shadow_jobs table
3. [Async] Aggregate athlete data (last 30/90/all sessions)
4. [Async] Assemble Heavy Bag context + full history
5. [Async] Call Azure OpenAI gpt-5-shadow with Scout prompt:
   "Generate a comprehensive athlete intelligence report:
    - Summary of recent performance & interaction patterns
    - Key strengths based on feedback & outcomes
    - Growth areas identified from recommendation effectiveness
    - Recommended topics for next coaching cycle
    - Open questions from athlete interaction history
    - Strategic insights for organizational planning"
6. [Async] Structure response as JSON:
   {
     summary: string,
     strengths: string[],
     growthAreas: string[],
     recommendedTopics: string[],
     openQuestions: string[],
     strategicInsights: string
   }
7. [Async] Store in shadow_jobs.output_data
8. [Admin UI] Display Scout Report with interactive drill-down
```

**Computation:** 5-15s per athlete

---

## Safety & Governance

### 6.1 Multi-Stage Validation

**Stage 1: Pre-Flight (100% of requests)**
- ✅ Content safety API (Azure Content Moderator)
- ✅ Jailbreak detection (keyword + pattern matching)
- ✅ Medical emergency detection (911 trigger words)
- ✅ Rate limit enforcement
- ✅ Consent status verification

**Stage 2: Request Classification (100% of requests)**
- ✅ Risk level assessment (low/medium/high/escalate)
- ✅ Sensitivity detection
- ✅ Escalation decision

**Stage 3: Post-Response Filtering (100% of requests)**
- ✅ Medical boundary enforcement (prepend disclaimers)
- ✅ Confidence scoring (flag low-confidence responses)
- ✅ Explainability requirement (attach chain-of-thought)
- ✅ Escalation trigger check (human review flag)

**Stage 4: Audit Trail (100% of requests)**
- ✅ One-way hash of request/response
- ✅ Full metadata logging
- ✅ Retention policy enforcement

### 6.2 Confidence & Explainability

Every response includes:

```typescript
{
  response: string;
  
  // Explainability
  confidence: 0-100;
  confidenceReason: string;
  chainOfThought: string;  // step-by-step reasoning
  
  // Markers
  confidenceMarker: 'HIGH' | 'MEDIUM' | 'LOW' | 'RESEARCH_NEEDED';
  
  // Attribution
  librarySourcesUsed: string[];
  recommendationsLinked: string[];
  
  // Caveats
  caveats: string[];  // "Only applies to weight class X", "Requires medical approval for athletes with history Y"
}
```

### 6.3 Human-in-the-Loop Triggers

SHADOW escalates to human review when:

1. **Risk Level = High**
   - Medical concerns
   - Psychological safety
   - Liability exposure

2. **Confidence < 50%**
   - Insufficient data
   - Ambiguous request
   - Novel situation

3. **User Escalation**
   - User clicks "Escalate to Human"
   - User provides negative feedback twice
   - User reports safety concern

4. **Governance Alerts**
   - Recommendation contradicts policy
   - Request outside scope
   - Organizational sensitivity

**Escalation Flow:**
1. Flag in shadow_jobs (job_type = 'human_review')
2. Notify admin/coach dashboard
3. Set 24-hour SLA for human response
4. Log in audit trail

### 6.4 Privacy & Data Retention

**Retention Policy:**
- **Active Data:** 90 days (recent interactions visible to user)
- **Archived Data:** 1 year (aggregated analytics only, not individual responses)
- **Deleted Data:** One-way hash only (for audit compliance)

**Tenant Isolation:**
- Organization data completely isolated in all queries (enforced in Postgres —
  every organization-owned record carries `organization_id`)
- No cross-organization recommendations or patterns

**Consent Management:**
- Gold-tier members opt-in to anonymized pattern analysis
- Opt-out available at any time (historical data retained, future data anonymous)

---

## Implementation Phases

### Phase 1: Foundation (Weeks 1-4)
- ✅ Quick Round MVP (Azure OpenAI integration)
- ✅ Basic feedback collection
- ✅ Session-based auth
- **Status:** COMPLETE

### Phase 2: Heavy Bag & Learning Loop (Weeks 5-8)
- ✅ Heavy Bag async job processing
- ✅ Learning Loop feedback → effectiveness scoring
- ❌ Scout Reports — the dedicated producer was implemented, never gained a
  caller, and was **deleted** in the 2026-07-31 audit; build-or-retitle is an
  open owner decision (§3.5, §5.5)
- **Status:** COMPLETE except Scout Reports

### Phase 3: Personalization (Weeks 9-12)
- 🔄 User Profiling (Bronze/Silver/Gold tiers) — shipped; tiers must never gate
  capabilities
- ⏳ Adaptive response generation — unlock-gated; needs real feedback volume
  and human review capacity before it can warm up
- ⏳ Learning style detection — current inference is crude heuristics; do not
  deepen until volume exists
- **Status:** partially shipped; advancing is gated on operational volume, not
  code

### Phase 4: Multimodal (status: emerging, not scheduled)
- 🔄 Video Intelligence — upload → content scan → promote path is **live**;
  Film Study executor runs behind a mandatory human proposals gate; per-frame
  cost measurement still required before general availability. Pose estimation
  and drill classification are **aspirational, not in scope**.
- 🔄 Document Intelligence — document-intake pipeline exists (classify, review,
  link); OCR/fact-extraction depth is future work
- ⏳ Biometric Integration — **deferred; nothing built**
- The original week-13-16 timeline is withdrawn; this phase advances behind
  the capability build plan's Track S5.

### Phase 5: Fine-Tuning & Optimization (deferred indefinitely)
- ⏳ Collect curated training examples under retention policy — the only
  in-scope work
- ❌ Fine-tune / deploy `ppbf-shadow-v1-mini` — **disabled in code** until a
  governance, privacy, and evaluation process exists (500-example threshold);
  the September 2026 timeline is withdrawn

### Phase 6: Advanced Features (Weeks 21+)
- ⏳ Cross-organizational anonymized insights
- ⏳ Predictive readiness/fatigue/injury risk
- ⏳ Board-level analytics
- ⏳ What-If simulator for training plans

---

## File Structure

**Recommended project structure for future development:**

```
apps/web/
├── src/
│   ├── server/
│   │   └── pilot/
│   │       ├── shadowAI/
│   │       │   ├── index.ts
│   │       │   ├── theCorner.ts          # Complexity classifier
│   │       │   ├── contextAssembler.ts   # Builds optimal context window
│   │       │   ├── responseFilter.ts     # Post-response safety filtering
│   │       │   ├── confidentceMarker.ts  # Confidence scoring
│   │       │   └── chainOfThought.ts     # Explainability generation
│   │       │
│   │       ├── shadowPersonalization/
│   │       │   ├── userProfile.ts        # Tier management, memory
│   │       │   ├── adaptiveGeneration.ts # Tone, complexity, format adaptation
│   │       │   ├── learningStyleDetector.ts
│   │       │   └── readinessSignal.ts
│   │       │
│   │       ├── shadowLearningLoop/
│   │       │   ├── index.ts
│   │       │   ├── outcomeSignal.ts      # Collect & score outcomes
│   │       │   ├── libraryUpdater.ts     # Promote/demote recommendations
│   │       │   ├── researchRequirement.ts # Auto-generate gaps
│   │       │   └── profileUpdater.ts     # Update user profiles
│   │       │
│   │       ├── shadowJobQueue/
│   │       │   ├── index.ts
│   │       │   ├── claim.ts              # Claim next job
│   │       │   ├── execute.ts            # Execute (dispatch to handler)
│   │       │   ├── handlers/
│   │       │   │   ├── heavyBag.ts
│   │       │   │   ├── scoutReport.ts
│   │       │   │   ├── boardSummary.ts
│   │       │   │   └── learningLoop.ts
│   │       │   └── store.ts              # Job persistence
│   │       │
│   │       ├── shadowMultimodal/
│   │       │   ├── video/
│   │       │   │   ├── poseEstimation.ts
│   │       │   │   ├── drillClassifier.ts
│   │       │   │   └── errorDetector.ts
│   │       │   ├── document/
│   │       │   │   ├── textExtraction.ts
│   │       │   │   └── validation.ts
│   │       │   └── biometric/
│   │       │       ├── ingestion.ts
│   │       │       └── trendAnalysis.ts
│   │       │
│   │       ├── shadowSafety/
│   │       │   ├── preFlightValidator.ts
│   │       │   ├── contentSafety.ts
│   │       │   ├── medicalBoundary.ts
│   │       │   ├── escalationLogic.ts
│   │       │   └── auditLogger.ts
│   │       │
│   │       └── shadowLibrary/
│   │           ├── index.ts
│   │           ├── claim.ts             # Quick retrieval
│   │           ├── search.ts            # Vector search
│   │           └── versioning.ts        # Entry versioning
│   │
│   └── client/
│       ├── components/
│       │   ├── ShadowChatInterface.tsx    # Main chat component
│       │   ├── ShadowMessage.tsx          # Message with feedback
│       │   ├── FeedbackButtons.tsx        # 👍 👎 escalate
│       │   ├── ScoutReportCard.tsx        # Report display
│       │   └── ConfidenceMarker.tsx       # Confidence indicator
│       │
│       └── pages/
│           ├── shadow/
│           │   ├── page.tsx               # Chat interface
│           │   ├── scout/
│           │   │   └── page.tsx           # Scout Reports dashboard
│           │   ├── library/
│           │   │   └── page.tsx           # Library browser (admin)
│           │   └── analytics/
│           │       └── page.tsx           # Learning analytics (admin)
│
├── app/
│   └── api/
│       └── pilot/
│           └── shadow/
│               ├── chat/
│               │   └── route.ts           # Main chat endpoint
│               ├── feedback/
│               │   └── route.ts           # Feedback collection
│               ├── jobs/
│               │   ├── route.ts           # List/cancel jobs
│               │   ├── process/
│               │   │   └── route.ts       # Claim & execute
│               │   └── [jobId]/
│               │       └── route.ts       # Poll status
│               ├── scout-reports/
│               │   └── route.ts           # List completed reports
│               ├── upload/
│               │   └── route.ts           # Video/document upload
│               ├── migrate/
│               │   └── route.ts           # DB migrations
│               └── debug/
│                   └── route.ts           # Diagnostic endpoint
│
└── docs/
    ├── SHADOW_ML_ARCHITECTURE_SPEC.md    # This document
    ├── API_CONTRACTS.md                  # Detailed API specs
    ├── DATA_MODEL_REFERENCE.md           # Schema deep dive
    └── SAFETY_GOVERNANCE.md              # Compliance & audit
```

---

## Deployment Architecture

### 9.1 Infrastructure (Azure)

```
┌─────────────────────────────────────────────────────────────┐
│ Azure Static Web App (ppbf-platform)                        │
│ ├─ Next.js App (Node.js runtime)                            │
│ │  ├─ Shadow UI (/shadow, /shadow/scout)                   │
│ │  └─ API routes (/api/pilot/shadow/*)                     │
│ └─ GitHub Actions CI/CD                                    │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│ Azure OpenAI (shadow-ai.openai.azure.com)                  │
│ ├─ gpt-5.6-luna-shadow (Quick Round)                       │
│ ├─ gpt-5.6-sol-shadow (Heavy Bag)                          │
│ ├─ gpt-5-vision-shadow (Film Study)                        │
│ └─ gpt-5-mini-shadow / gpt-5-shadow (fallbacks)            │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│ Azure PostgreSQL (ppbf-pg-*.postgres.database.azure.com)   │
│ ├─ pilot.shadow_feedback                                   │
│ ├─ pilot.shadow_jobs                                       │
│ ├─ pilot.shadow_user_profiles                              │
│ ├─ pilot.shadow_recommendation_effectiveness               │
│ └─ pilot.shadow_chat_audit                                 │
└─────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────┐
│ Azure Container Registry (ppbfacr*.azurecr.io)             │
│ └─ App container images                                    │
└─────────────────────────────────────────────────────────────┘
```

(The Redis cache tier shown in earlier versions of this diagram was never
provisioned — see §4.2. Fine-tuned model hosting is deferred with §7 Phase 5.)

### 9.2 Environment Variables

```
# Azure OpenAI
AZURE_AI_ENDPOINT=https://shadow-ai.openai.azure.com/
AZURE_AI_KEY=<secret>
AZURE_AI_DEPLOYMENT_NAME=<default deployment; per-tier routing comes from
                          MODEL_REGISTRY in shadowRouter.ts>
AZURE_AI_API_VERSION=2024-12-01-preview

# Database
AZURE_POSTGRES_CONNECTION_STRING=postgresql://...

# Bootstrap
PPBF_PILOT_BOOTSTRAP_KEY=<secret>
PPBF_PILOT_DEFAULT_ORG_ID=ppbf-default-org

# Feature Flags
SHADOW_ENABLE_HEAVY_BAG=true
SHADOW_ENABLE_SCOUT_REPORTS=true
SHADOW_ENABLE_LEARNING_LOOP=true
SHADOW_ENABLE_PERSONALIZATION=false  # Phase 3
SHADOW_ENABLE_MULTIMODAL=false       # Phase 4
```

### 9.3 CI/CD Pipeline

**GitHub Actions workflow** (`.github/workflows/deploy-shadow.yml`):

```yaml
name: Deploy SHADOW

on:
  push:
    branches: [main]
    paths:
      - 'apps/web/**'
      - '.github/workflows/deploy-shadow.yml'

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 20
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Build
        run: npm run build
        env:
          NEXT_PUBLIC_API_BASE: ${{ secrets.NEXT_PUBLIC_API_BASE }}
      
      - name: Run tests
        run: npm run test:shadow
      
      - name: Deploy to SWA
        uses: Azure/static-web-apps-deploy@v1
        with:
          azure_static_web_apps_api_token: ${{ secrets.AZURE_SWA_TOKEN }}
          repo_token: ${{ secrets.GITHUB_TOKEN }}
          action: "upload"
          app_location: "apps/web"
          output_location: ".next"
```

---

## Success Metrics

### 10.1 Performance

| Metric | Target | Current (measured 2026-07-29) |
|--------|--------|---------|
| Quick Round latency (unstreamed) | streaming first token < 5s (Track S1) | ~33s full response |
| Heavy Bag completion (async) | tracked, not SLA'd — bounded by 240s ingress | ~95s model execution |
| API availability | 99.9% | TBD |
| Withheld-answer (over-filter) rate | < 1% (Track S4) | measurement landing (#178) |

(The former "< 2s / < 5s / < 30s" targets described the never-built three-tier
design and are withdrawn. The cache-hit-rate metric goes with the unbuilt Redis
tier, §4.2.)

### 10.2 Quality

| Metric | Target | Current |
|--------|--------|---------|
| Recommendation effectiveness (avg score) | > 75 | TBD |
| User satisfaction rate | > 80% | TBD |
| Safety gate accuracy | > 99% | TBD |
| Escalation false positives | < 5% | TBD |
| Recommendation follow-through | > 60% | TBD |

### 10.3 Adoption

| Metric | Target (Q4 2026) | Current |
|--------|------------------|---------|
| Active coaches using SHADOW | > 80% | TBD |
| Avg queries per coach/day | > 5 | TBD |
| Tier distribution (Gold) | > 30% | TBD |
| Library size (high-confidence entries) | > 200 | TBD |
| Heavy Bag queries / day | > 50 | TBD |

### 10.4 Learning Loop Impact

| Metric | Target | Current |
|--------|--------|---------|
| Recommendations promoted to library / month | > 15 | TBD |
| Research gaps auto-generated / month | > 20 | TBD |
| Average recommendation effectiveness improvement | +10% / quarter | TBD |
| User profile accuracy | > 85% | TBD |

---

## Appendix: Glossary

- **Quick Round:** synchronous, lightweight context, luna (~33s measured, unstreamed)
- **Heavy Bag:** async-default, full context and deep reasoning, sol (~95s measured)
- **The Corner:** model routing layer (`shadowRouter.ts`); tier decisions come
  from the classifier (`shadowClassifier.ts`)
- **Scout Report:** Comprehensive athlete intelligence generated async
- **Outcome Signal:** User feedback (thumbs up/down) + objective data
- **Effectiveness Score:** 0-100 rating of recommendation quality
- **Learning Loop:** Recommendation → Outcome → Score → Library Update → Profile Update
- **Tier:** Bronze (< 10 interactions), Silver (10-50), Gold (50+)
- **Confidence Marker:** HIGH/MEDIUM/LOW label on responses
- **Chain-of-Thought:** Step-by-step reasoning explanation
- **Fire-and-Forget:** Async operation that doesn't block request

---

## Appendix: Recommended Readings

- OpenAI GPT-5 Fine-Tuning Guide: https://platform.openai.com/docs/guides/fine-tuning
- Azure OpenAI Best Practices: https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/best-practices
- Responsible AI Framework: https://www.microsoft.com/en-us/ai/responsible-ai
- MLOps Playbook: https://ml-ops.systems/

---

**Document Control**

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-07-18 | Engineering | Initial specification |

**Next Review:** 2026-10-18 (after Phase 3 completion)

---

This specification is **production-ready** and can be used immediately for Phase 3+ development planning. It includes concrete API contracts, database schemas, file structure, and implementation timelines.

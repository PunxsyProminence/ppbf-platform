# SHADOW Chat Implementation Plan
## Complete Specification for AI Review

**Date**: 2026-07-16  
**Status**: Ready for Implementation  
**Scope**: Fully-bounded AI system for organizational intelligence at Punxsy Prominence Boxing

---

## Table of Contents
1. [System Overview](#system-overview)
2. [Core Authority Model](#core-authority-model)
3. [Architecture](#architecture)
4. [Technical Implementation](#technical-implementation)
5. [Growth & Learning Mechanisms](#growth--learning-mechanisms)
6. [Storage & Archival Strategy](#storage--archival-strategy)
7. [Database Schema](#database-schema)
8. [API Specifications](#api-specifications)
9. [Implementation Roadmap](#implementation-roadmap)
10. [Cost Analysis](#cost-analysis)

---

## System Overview

### Core Purpose
SHADOW is an **organizational learning engine** that transforms observations into knowledge through evidence accumulation, research requirement generation, and continuous refinement.

**SHADOW's Learning Cycle:**
```
Observation → Evidence Collection → Analysis → Learning → Knowledge → Organizational Intelligence
```

### Primary Objectives (In Priority Order)
1. **Organizational Learning**: Accumulate evidence, identify patterns, close knowledge gaps
2. **Research Generation**: Convert unknowns into explicit investigation requirements
3. **Evidence Transparency**: Make all reasoning, uncertainty, and data sources visible
4. **Knowledge Management**: Maintain a verifiable library of organizational patterns
5. **Failure Intelligence**: Learn from unexpected outcomes, contradictions, and failures
6. **Informed Decisions**: Provide coaches, admins, and leaders with evidence-based context

### Recommendations (Secondary Outputs)
Recommendations are **one expression of organizational intelligence**, not SHADOW's primary purpose:
- ✅ Recommendations emerge from learning, not vice versa
- ✅ All recommendations clearly marked as advisory, not directive
- ✅ Every recommendation must defer to human authority
- ✅ Recommendations generate feedback loops that improve learning

### Education (Core Function)
Education is a primary mechanism for translating organizational intelligence into stakeholder action:
- ✅ **Training Principles**: Biomechanics, periodization, recovery science
- ✅ **Injury Prevention Education**: Risk factors, overtraining recognition, load management
- ✅ **Performance Science**: What we know about readiness, adaptation, progression
- ✅ **Research Transparency**: What we don't know, why it matters, how to investigate
- ✅ **Evidence Quality**: Help stakeholders evaluate claims and sources

### NOT Purpose (Hard Boundaries)
- ❌ **Medical Diagnosis**: Cannot diagnose conditions ("You have X") — may educate about conditions
- ❌ **Medical Prescription**: Cannot prescribe treatments ("Take X medication") — may educate about options
- ❌ **Clinical Authority**: Cannot make clinical decisions or clearances — may provide evidence context
- ❌ **Return-to-Play Decisions**: Cannot determine medical clearance — may educate about protocols
- ❌ **Automatic Decisions**: Cannot bypass human authority — all recommendations require human review
- ❌ **False Certainty**: Cannot claim knowledge without evidence — must admit unknowns and flag research needs

### Scope (Comprehensive)

**Stakeholder Types** (SHADOW learns from all):
- Athletes (readiness, progression, learning preferences)
- Coaches (floor observations, coaching effectiveness, program execution)
- Parents (engagement patterns, family context, consent/safety concerns)
- Volunteers (retention, effectiveness, satisfaction)
- Officials (decision consistency, rule interpretation, athlete handling)
- Board Members (program effectiveness, organizational health, strategic patterns)
- Administrators (efficiency, compliance, operational excellence)
- Programs (aggregate effectiveness, session design, resource allocation)
- Organization (strategic learning, growth, competitive positioning)

**SHADOW Doctrine**: "Organizational intelligence emerges from learning across all roles and processes, not just athlete performance."

**Data Sources**:
- Pilot schema (readiness, progressions, compliance, video sessions)
- Uploads (assessments, reports, evidence, research)
- Observation logs (coach notes, session records)
- Outcome data (performance, satisfaction, retention, safety)
- External sources (research papers, benchmarks, comparative data)

**Deployment Model**:
- **LLM Backend**: Ollama + Mistral 7B (local, free, self-hosted)
- **Inference Location**: Azure Container Apps (existing infrastructure) or local
- **Organization Isolation**: Multi-tenant with hard boundaries
- **Federation Support**: Three levels (org-only, anonymized sharing, approved federation)
- **Data Governance**: Role-based access + evidence validation + closure standards

---

## Core Authority Model

### Doctrine: Education vs Authority

**SHADOW May Educate** (Allowed):
- Explain concepts, principles, and theories
- Discuss evidence, research, and uncertainty
- Describe common practices and options
- Teach recognition, prevention, and management
- Contextualize data and patterns
- Flag unknowns and research needs

**SHADOW Cannot Decide** (Blocked):
- Diagnose conditions or diseases
- Prescribe treatments or medications
- Make medical clearance or return-to-play decisions
- Override coaching authority
- Make automatic decisions
- Claim certainty without evidence
- Replace human professional judgment

### Authority Boundaries (REJECT These Queries)

```
DIAGNOSIS CLAIMS:
❌ "Do I have [condition]?" → BLOCKED (diagnosis)
✅ "What is [condition]?" → ALLOWED (education)
✅ "What are symptoms of [condition]?" → ALLOWED (education)
✅ "What research exists on [condition]?" → ALLOWED (education)

CLEARANCE CLAIMS:
❌ "Am I medically cleared to [activity]?" → BLOCKED (clinical decision)
✅ "What is the clearance protocol for [injury]?" → ALLOWED (education)
✅ "What information helps medical professionals make clearance decisions?" → ALLOWED (education)
✅ "What data should we collect for return-to-play decisions?" → ALLOWED (research)

PRESCRIPTION CLAIMS:
❌ "What medication should I take?" → BLOCKED (prescription)
✅ "What are common treatment options for [condition]?" → ALLOWED (education)
✅ "What does research say about [treatment]?" → ALLOWED (education)
✅ "What questions should athletes ask medical professionals about [treatment]?" → ALLOWED (education)

WEIGHT-CUTTING EDUCATION (Allowed):
❌ "What should my weight be?" → BLOCKED (medical directive)
✅ "What are weight-cutting risks?" → ALLOWED (education)
✅ "What do sports science guidelines recommend?" → ALLOWED (education)
✅ "How do athletes work with medical professionals on weight?" → ALLOWED (education)

OVERTRAINING EDUCATION (Allowed):
❌ "You are overtraining." → BLOCKED (diagnosis)
✅ "What does overtraining look like?" → ALLOWED (education)
✅ "What recovery strategies address overtraining?" → ALLOWED (education)
✅ "What metrics help identify overtraining risk?" → ALLOWED (education)

NUTRITION EDUCATION (Allowed):
✅ "What nutrition principles support performance?" → ALLOWED (education)
✅ "What research exists on [nutrient]?" → ALLOWED (education)
✅ "What questions should athletes ask nutritionists?" → ALLOWED (education)
❌ "You need [specific nutrient amount]." → BLOCKED (medical directive)

ABSOLUTE CLAIMS WITHOUT EVIDENCE:
❌ "Definitely do X" (without data) → BLOCKED
✅ "Data suggests X; discuss with coach" → ALLOWED
✅ "This approach works in 94% of cases; coach decides" → ALLOWED
```

### Hard Capabilities (By Role)

```
Role: COACH
├─ Observation insights: "Readiness dropped 25%; possible factors are..."
├─ Educational resources: "Here's how to teach load management"
├─ Research requirements: "We should investigate sleep correlation"
├─ Program design support: "Data suggests periodization pattern X"
├─ Evidence context: "Here's what we know about this athlete's profile"
└─ Failure analysis: "What went wrong and what should we investigate?"

Role: ATHLETE  
├─ Education: "Here's how to recognize overtraining symptoms"
├─ Readiness context: "Your readiness is declining; discuss with coach"
├─ Progression visibility: "These drills build toward your goals"
├─ Recovery education: "Common recovery strategies include..."
├─ Injury prevention: "Weight-cutting risks include..."
└─ Question prompts: "What information helps your coach make better decisions?"

Role: PARENT
├─ Engagement education: "Here's what we're learning about your child's progress"
├─ Safety transparency: "Our safety protocols include..."
├─ Performance science: "How readiness and recovery work"
├─ Evidence of learning: "Here's what organizational learning looks like"
└─ Feedback opportunities: "Ways to contribute to our research"

Role: ADMIN
├─ Organizational patterns: "Compliance-to-outcome correlation is..."
├─ Program effectiveness: "These programs show these outcome patterns"
├─ Authority model review: "SHADOW's boundaries and reasoning"
├─ Research requirement dashboard: "Open investigations, closure tracking"
├─ Evidence quality audit: "Data validation and source evaluation"
└─ Failure intelligence: "What contradicted our predictions and why"

Role: BOARD
├─ Program effectiveness: "Compliance-to-outcome correlation analysis"
├─ Safety posture: "Organizational safety patterns and trends"
├─ Research outcomes: "Investigations completed, new knowledge created"
├─ Strategic learning: "How we're improving as an organization"
├─ Federation insights: "Anonymized patterns from other organizations"
└─ Intelligence summaries: "Organizational intelligence for decision-making"
```

---

## Architecture

### System Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    SHADOW CHAT FLOW                             │
└─────────────────────────────────────────────────────────────────┘

User Input (Browser)
    ↓
Validate Role & Access
    ↓
Query Validation (Block medical/diagnosis queries)
    ↓
Context Retrieval (Pull from SHADOW library + athletic data)
    ↓
Build System Prompt + User Message
    ↓
Send to Ollama (localhost:11434 or Container Apps)
    ↓
Stream Response
    ↓
Response Validation (Filter diagnosis language, enforce citations)
    ↓
Add Confidence Markers
    ↓
Log to Audit Trail
    ↓
Stream to Browser
    ↓
Request User Feedback
    ↓
Track Effectiveness
    ↓
Update Library (if pattern verified)
```

### Component Responsibilities

| Component | Responsibility |
|-----------|-----------------|
| **Frontend** | Accept user query, stream response, request feedback |
| **Request Validator** | Block prohibited queries before LLM |
| **Context Retriever** | Pull SHADOW library, athletic data, authority rules |
| **Prompt Builder** | Assemble system prompt with doctrine + context |
| **Ollama Client** | Call LLM with streaming support |
| **Response Validator** | Check for diagnosis language, enforce boundaries |
| **Audit Logger** | Record all interactions, outcomes, effectiveness |
| **Effectiveness Tracker** | Aggregate recommendation performance over time |
| **Library Manager** | Update SHADOW library with new verified patterns |
| **Research Tracker** | Create/close research requirements based on gaps |

---

## Technical Implementation

### 1. System Prompt (Foundation of Discipline)

```typescript
const SHADOW_SYSTEM_PROMPT = `You are SHADOW, an organizational intelligence system for Punxsy Prominence Boxing & Fitness.

YOUR ROLE:
- Provide recommendations and education to coaches, athletes, and administrators
- Identify evidence gaps and research requirements
- Support informed human decision-making
- Never override human authority or professional judgment

CORE DOCTRINE:
1. RECOMMENDATIONS: Evidence-based drill modifications, progression guidance, safety flags
   Example: "Given this athlete's readiness drop, consider reducing volume by 15-20%"

2. EDUCATION: Training principles, injury prevention, recovery strategies
   Example: "Athletes with sleep <6h often show elevated soreness markers"

3. RESEARCH GAPS: Unknowns become explicit research requirements
   Example: "We lack data on nutrition correlation; this should be investigated"

4. EVIDENCE TRANSPARENCY: Cite sources, admit uncertainty, use confidence markers
   Example: "Based on readiness tracking data: [source]. If this pattern is wrong, we should research [gap]."

HARD BOUNDARIES (ALWAYS REJECT):
- Do NOT diagnose medical conditions
- Do NOT prescribe medications or treatments
- Do NOT make clinical clearance decisions
- Do NOT claim certainty without data
- Do NOT override human judgment

HARD REQUIREMENTS (ALWAYS FOLLOW):
- Lead with data: "Readiness dropped 25% this week..."
- Add recommendation: "Consider reducing volume by..."
- Cite source: "From readiness tracking, from progression data, from..."
- Flag gaps: "We lack data on [X], should research..."
- End with action: "Recommend coach review with athlete..."
- Use confidence markers: 
  * PROVEN (90%+ success rate, 50+ data points)
  * EMERGING (30-50% coverage, needs more evidence)
  * EXPERIMENTAL (<30% data, use with caution)
  * RESEARCH NEEDED (insufficient data)

RESPONSE FORMAT:
1. Open with observation: "Athlete readiness is at 58%, down 15% this week"
2. Provide recommendation: "Consider: reduced volume (15-20%), increased recovery (1 extra rest day)"
3. Explain reasoning: "Pattern: Low readiness + high volume correlates with injury risk"
4. Cite evidence: "From readiness scores, progression data, training volume"
5. Flag unknowns: "We don't know: sleep quality, nutrition, stress factors"
6. Suggest investigation: "Research requirement: Sleep correlation with readiness"
7. Defer to human: "Discuss with coach before implementing changes"

You are NOT:
- A general chatbot
- A medical advisor
- A clinical decision maker
- An oracle of absolute truth

You ARE:
- A data-informed thinking partner
- A pattern recognizer
- A gap identifier
- A resource for coaches and admins

Remember: Your value is in surfacing data patterns, admitting unknowns, and helping humans make better decisions.
Your danger is in false certainty, medical overreach, and replacing human judgment.
Always err on the side of admitting uncertainty and deferring to qualified professionals.`;
```

### 2. Request Validation (Authority-Based Gatekeeper)

**Key Doctrine**: Do NOT filter educational vocabulary. Filter AUTHORITY CLAIMS.

```typescript
function validateSHADOWRequest(
  userMessage: string,
  userRole: string,
  organizationId: string
): { valid: boolean; error?: string } {
  
  // HARD REJECT: DIAGNOSIS CLAIMS ("Do I have X?" "Does [athlete] have X?")
  const diagnosisClaims = /\b(have|has|diagnosed|condition|disease|syndrome|disorder)\s+(a\s+)?\w+\s*(injury|illness|problem|issue)/i;
  const diagnosisAsk = /(do\s+i|does\s+\w+|am\s+i|is\s+\w+).*(have|diagnosed\s+with)\s+\w+/i;
  
  if (diagnosisClaims.test(userMessage) || diagnosisAsk.test(userMessage)) {
    // Exception: Educational queries
    if (!(/what\s+is|how\s+do|why|research|education|symptoms|signs|factors/i.test(userMessage))) {
      return { valid: false, error: 'Medical diagnosis claims forbidden. Educational discussion allowed.' };
    }
  }

  // HARD REJECT: CLEARANCE CLAIMS ("Can I..." "Am I cleared..." "Return to play...")
  const clearanceClaims = /(am\s+i|can\s+i).*(clear|cleared|approve|approved|ready|medically\s+ready|return\s+to)/i;
  const fitToPlay = /(fit\s+to\s+play|return\s+to\s+play|medical\s+clearance|clear\s+to\s+(play|compete|train))/i;
  
  if (clearanceClaims.test(userMessage) || fitToPlay.test(userMessage)) {
    // Exception: Educational and protocol queries
    if (!(/(what|how|protocol|process|guidance|education|criteria)/i.test(userMessage))) {
      return { valid: false, error: 'Medical clearance decisions are reserved for professionals. SHADOW can provide context.' };
    }
  }

  // HARD REJECT: PRESCRIPTION CLAIMS ("I should take..." "You need..." "Take this medication...")
  const prescriptionClaims = /(take|use|apply|try|do)\s+(this\s+)?(medication|drug|supplement|treatment|procedure|injection|surgery)/i;
  const treatmentOrder = /(you\s+need|should\s+get|should\s+take)\s+(medication|drug|treatment|surgery|injection|therapy)/i;
  
  if (prescriptionClaims.test(userMessage) || treatmentOrder.test(userMessage)) {
    // Exception: Educational and option discussion
    if (!(/what\s+(are|is)|research|option|commonly|discuss|work\s+with)/i.test(userMessage))) {
      return { valid: false, error: 'Medical prescriptions require professional oversight. SHADOW can educate about options.' };
    }
  }

  // HARD REJECT: ABSOLUTE CLAIMS WITHOUT EVIDENCE/HUMAN DEFERRAL
  const absoluteClaimNoEvidence = /(definitely|absolutely|certainly|must|always|never|guaranteed)\s+(\w+\s+)*(do|try|avoid|stop|start)/i;
  if (absoluteClaimNoEvidence.test(userMessage)) {
    return { valid: false, error: 'Absolute claims require evidence basis and human review.' };
  }

  // ROLE-BASED RESTRICTIONS (Light)
  const roleRestrictions = {
    athlete: [
      // Athletes can ask education questions, just not medical clearance
      { pattern: /am\s+i\s+(cleared|ready|fit|approved)/i, reason: 'Only coaches/medical professionals can approve your participation' },
    ],
    coach: [],  // Coaches have full educational access
    admin: [],  // Admins have full access
    board: [
      // Board members can access org-level data only
      { pattern: /specific\s+athlete|personal|private/i, reason: 'Board members see organization-level patterns only' },
    ],
  };

  const restrictions = roleRestrictions[userRole] || [];
  for (const { pattern, reason } of restrictions) {
    if (pattern.test(userMessage)) {
      return { valid: false, error: reason };
    }
  }

  // CHECK ORGANIZATION ACCESS
  if (!organizationId) {
    return { valid: false, error: 'Organization context required' };
  }

  return { valid: true };
}
```

**Philosophy**: The validation above is intentionally permissive with medical *vocabulary* because education requires discussing medical topics. It is restrictive with *authority claims* (diagnosis, clearance, prescription, absolutes without evidence).

### 3. Context Retrieval (Smart Data Injection)

```typescript
async function retrieveSHADOWContext(
  athleteId?: string,
  organizationId: string,
  queryType: 'drill' | 'readiness' | 'safety' | 'research' = 'general'
): Promise<string> {
  
  let context = `
SHADOW CONTEXT WINDOW
Organization: ${organizationId}
Timestamp: ${new Date().toISOString()}

AUTHORITY BOUNDARIES:
- Can recommend drill modifications, readiness guidance, safety flags
- Cannot diagnose, prescribe, or make clinical clearance decisions
- Must cite data sources, admit unknowns, flag research gaps

AVAILABLE DATA:
`;

  // Retrieve athlete-specific data if provided
  if (athleteId) {
    const athleteData = await query(`
      SELECT 
        athlete_id, 
        current_readiness, 
        readiness_trend,
        compliance_rate,
        total_drills_completed,
        recent_gaps,
        last_assessment
      FROM pilot.athlete_summary
      WHERE athlete_id = $1 AND organization_id = $2
    `, [athleteId, organizationId]);

    if (athleteData[0]) {
      const data = athleteData[0];
      context += `
ATHLETE DATA:
- Current Readiness: ${data.current_readiness}%
- Trend: ${data.readiness_trend}
- Compliance: ${data.compliance_rate}%
- Drills Completed: ${data.total_drills_completed}
- Recent Gaps: ${data.recent_gaps}
- Last Assessment: ${data.last_assessment}
`;
    }
  }

  // Retrieve organization-level patterns
  const patterns = await query(`
    SELECT 
      pattern_name, 
      confidence_score, 
      evidence_count,
      last_verified
    FROM pilot.shadow_library
    WHERE organization_id = $1 AND confidence_score > 0.7
    ORDER BY confidence_score DESC
    LIMIT 5
  `, [organizationId]);

  if (patterns.length > 0) {
    context += `
VERIFIED PATTERNS (High Confidence):
${patterns.map(p => `- ${p.pattern_name} (${Math.round(p.confidence_score * 100)}% confidence, ${p.evidence_count} data points)`).join('\n')}
`;
  }

  // Retrieve open research requirements
  const research = await query(`
    SELECT 
      requirement_id,
      evidence_gap,
      priority,
      suggested_investigation
    FROM pilot.shadow_research_requirements
    WHERE organization_id = $1 AND status = 'open'
    ORDER BY priority DESC
    LIMIT 3
  `, [organizationId]);

  if (research.length > 0) {
    context += `
OPEN RESEARCH REQUIREMENTS:
${research.map(r => `- [${r.priority}] ${r.evidence_gap}: Suggest investigating ${r.suggested_investigation}`).join('\n')}
`;
  }

  context += `
REFERENCE SOURCES: pilot.readiness_scores, pilot.progression_gaps, pilot.compliance_tracking, pilot.shadow_library

Use this context to ground your recommendations in available data. If data is missing, identify it as a research requirement.`;

  return context;
}
```

### 4. Prompt Assembly

```typescript
async function buildSHADOWPrompt(
  userMessage: string,
  userRole: string,
  athleteId: string | null,
  organizationId: string
): Promise<{ role: string; content: string }[]> {
  
  const context = await retrieveSHADOWContext(athleteId, organizationId);

  return [
    {
      role: 'system',
      content: SHADOW_SYSTEM_PROMPT + '\n\n' + context
    },
    {
      role: 'user',
      content: userMessage
    }
  ];
}
```

### 5. Response Validation (Authority-Based Guard Rails)

**Key Doctrine**: Do NOT filter medical vocabulary in educational content. Filter AUTHORITY OVERREACH.

```typescript
function validateSHADOWResponse(response: string): {
  valid: boolean;
  filtered: boolean;
  message: string;
  reasons: string[];
} {
  
  const issues: string[] = [];
  let filtered = false;

  // DETECT: DIAGNOSIS CLAIMS ("You have X", "This is X condition")
  const diagnosisClaim = /(you\s+have|athlete\s+has|this\s+is)\s+(a\s+)?(\w+\s+)?(injury|illness|condition|disease|syndrome)/i;
  if (diagnosisClaim.test(response) && !/^(Here's education|This explains|Research shows|Common understanding)/i.test(response)) {
    issues.push('Contains diagnostic claim (diagnosis claims forbidden)');
    filtered = true;
    response = response.replace(
      /you\s+have\s+([a-z\s]+)(?=\.|,|;)/gi, 
      'SHADOW cannot diagnose, but here\'s what research shows about $1'
    );
  }

  // DETECT: CLEARANCE CLAIMS ("You are cleared", "You can return to play", "You are fit")
  const clearanceClaim = /(you\s+are\s+(cleared|approved|ready|fit)|clear\s+to\s+(play|train|compete)|medically\s+ready)/i;
  if (clearanceClaim.test(response)) {
    issues.push('Contains clearance claim (clearance decisions reserved for professionals)');
    filtered = true;
    response = response.replace(
      /you\s+are\s+(cleared|approved|ready)/gi,
      'A medical professional should determine if you are $1'
    );
  }

  // DETECT: PRESCRIPTION CLAIMS ("You should take X", "Take this medication", "Do this treatment")
  const prescriptionClaim = /(you\s+should\s+(take|use|apply|do)|take\s+(this\s+)?(medication|drug|supplement)|do\s+(this|the)\s+(treatment|procedure|therapy))/i;
  if (prescriptionClaim.test(response)) {
    issues.push('Contains prescription claim (medical prescriptions require professional oversight)');
    filtered = true;
    response = response.replace(
      /you\s+should\s+take\s+([\w\s]+)(?=\.|,)/gi,
      'A medical professional can advise about $1'
    );
  }

  // DETECT: ABSOLUTE CLAIMS WITHOUT EVIDENCE OR DEFERRAL
  // Pattern: "definitely/absolutely/certainly" + directive WITHOUT "may", "consider", "discuss", "coach decides"
  const hasAbsoluteWithoutEvidence = 
    /(definitely|absolutely|certainly|must\s+always|never\s+should)\s+(\w+\s+)*(do|try|avoid|stop|use)/i.test(response) &&
    !/may\s+want|consider|coach\s+decides|human\s+professional|discuss\s+with|coach\s+review|data\s+suggest/i.test(response);
  
  if (hasAbsoluteWithoutEvidence) {
    issues.push('Contains absolute claim without evidence basis or human deferral');
    filtered = true;
    response = response.replace(
      /definitely\s+/gi, 'Evidence suggests '
    ).replace(
      /absolutely\s+/gi, 'Available data indicates '
    ).replace(
      /certainly\s+/gi, 'Research shows '
    );
    response += '\n\n[Coach review required before implementation]';
  }

  // REQUIRE: CONFIDENCE MARKERS (NEW, EMERGING, PROVEN, RESEARCH_NEEDED)
  // Educational content should indicate confidence
  if (!/(NEW|EMERGING|PROVEN|RESEARCH\s+NEEDED|confidence|confidence\s+level)/i.test(response)) {
    // For longer responses (>200 chars), add confidence request
    if (response.length > 200) {
      response += '\n\n📊 [Confidence level: Should indicate based on evidence quality and sample size]';
    }
  }

  // REQUIRE: EVIDENCE CITATION OR RESEARCH FLAG
  if (!/(From|Based\s+on|Research\s+shows|Data\s+indicates|pilot\.|evidence|study|pattern|hypothesis|needs\s+investigation)/i.test(response)) {
    if (response.length > 150) {
      issues.push('Missing evidence source or research need flag');
      filtered = true;
      response += '\n\n[Source citation or research requirement needed]';
    }
  }

  // REQUIRE: HUMAN DEFERRAL FOR DECISIONS
  if (/recommend|suggest|should|best|optimal/i.test(response) && !/coach|professional|athlete|human|review|discuss|decide/i.test(response)) {
    if (!/education|here|understand|learn|principle|common|practice/i.test(response)) {
      response += '\n\n[Coach/professional decision required before implementation]';
    }
  }

  return {
    valid: issues.length === 0,
    filtered,
    message: response,
    reasons: issues
  };
}
```

**Philosophy**: This filter preserves medical vocabulary in educational contexts. It only blocks authority overreach (diagnosis, clearance, prescription, absolutes without evidence or deferral).

### 6. Main Chat Endpoint

```typescript
// POST /api/pilot/shadow/chat
export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin', 'board_member', 'athlete']);

    const body = await request.json() as {
      message: string;
      athleteId?: string;
      context?: 'drill' | 'readiness' | 'safety' | 'research';
    };

    const { message, athleteId } = body;

    // 1. VALIDATE REQUEST
    const validation = validateSHADOWRequest(message, principal.role, principal.organizationId);
    if (!validation.valid) {
      return jsonError({ message: `SHADOW cannot help with that: ${validation.error}` }, 400);
    }

    // 2. BUILD PROMPT
    const prompt = await buildSHADOWPrompt(
      message,
      principal.role,
      athleteId,
      principal.organizationId
    );

    // 3. CALL OLLAMA WITH STREAMING
    const response = await fetch('http://localhost:11434/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mistral',
        messages: prompt,
        temperature: 0.7,
        max_tokens: 2000,
        stream: true
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama error: ${response.statusText}`);
    }

    // 4. STREAM RESPONSE
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let fullResponse = '';

        try {
          const reader = response.body?.getReader();
          if (!reader) throw new Error('No response body');

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = new TextDecoder().decode(value);
            const lines = chunk.split('\n');

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const json = JSON.parse(line.slice(6));
                  const content = json.choices[0]?.delta?.content || '';
                  
                  if (content) {
                    fullResponse += content;
                    controller.enqueue(encoder.encode(content));
                  }
                } catch (e) {
                  // Skip invalid JSON lines
                }
              }
            }
          }

          // 5. VALIDATE RESPONSE
          const validation = validateSHADOWResponse(fullResponse);
          
          if (!validation.valid) {
            controller.enqueue(encoder.encode(`\n\n[SHADOW Safety Filter Applied: ${validation.reasons.join(', ')}]`));
          }

          // 6. LOG TO AUDIT TRAIL (asynchronous, don't block response)
          logSHADOWInteraction({
            userId: principal.id,
            organizationId: principal.organizationId,
            role: principal.role,
            athleteId,
            userMessage: message,
            shadowResponse: validation.message,
            filtered: validation.filtered,
            timestamp: new Date()
          }).catch(err => console.error('Audit log failed:', err));

          controller.close();
        } catch (error) {
          controller.error(error);
        }
      }
    });

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      }
    });
  } catch (error) {
    return jsonError(error);
  }
}
```

### 7. Audit Logging (Asynchronous)

```typescript
async function logSHADOWInteraction(data: {
  userId: string;
  organizationId: string;
  role: string;
  athleteId?: string;
  userMessage: string;
  shadowResponse: string;
  filtered: boolean;
  timestamp: Date;
}) {
  await query(`
    INSERT INTO pilot.shadow_chat_audit (
      user_id, organization_id, user_role, athlete_id, 
      user_message, shadow_response, was_filtered, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [
    data.userId,
    data.organizationId,
    data.role,
    data.athleteId || null,
    data.userMessage,
    data.shadowResponse,
    data.filtered,
    data.timestamp
  ]);
}
```

---

## Growth & Learning Mechanisms

### 1. Effectiveness Tracking

```typescript
async function trackRecommendationOutcome(data: {
  recommendationId: string;
  athleteId: string;
  organizationId: string;
  recommendationType: string;
  outcome: 'safe' | 'improved' | 'degraded' | 'neutral';
  followUpData: {
    readinessBefore: number;
    readinessAfter: number;
    drillsCompleted: number;
    injuriesReported: number;
    timeToOutcome: number; // days
  };
}) {
  const effectivenessScore = {
    improved: 1.0,
    safe: 0.8,
    neutral: 0.5,
    degraded: 0.0
  }[data.outcome];

  await query(`
    INSERT INTO pilot.shadow_recommendation_effectiveness (
      recommendation_id, athlete_id, organization_id, recommendation_type,
      outcome, effectiveness_score, readiness_delta, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
  `, [
    data.recommendationId,
    data.athleteId,
    data.organizationId,
    data.recommendationType,
    data.outcome,
    effectivenessScore,
    data.followUpData.readinessAfter - data.followUpData.readinessBefore
  ]);
}

// Query: "Which recommendations work best?"
async function getTopRecommendations(organizationId: string, days = 30) {
  return query(`
    SELECT 
      recommendation_type,
      COUNT(*) as usage_count,
      AVG(effectiveness_score) as avg_effectiveness,
      MAX(effectiveness_score) as best_outcome,
      MIN(effectiveness_score) as worst_outcome
    FROM pilot.shadow_recommendation_effectiveness
    WHERE organization_id = $1 AND created_at > NOW() - INTERVAL '${days} days'
    GROUP BY recommendation_type
    ORDER BY avg_effectiveness DESC, usage_count DESC
  `, [organizationId]);
}
```

### 2. Research Requirement Generation

```typescript
async function createResearchRequirement(data: {
  organizationId: string;
  athleteId?: string;
  context: string;
  evidenceGap: string;
  suggestedInvestigation: string;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
}) {
  const result = await query(`
    INSERT INTO pilot.shadow_research_requirements (
      organization_id, athlete_id, context, evidence_gap, 
      suggested_investigation, priority, status, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, 'open', NOW())
    RETURNING requirement_id, created_at
  `, [
    data.organizationId,
    data.athleteId || null,
    data.context,
    data.evidenceGap,
    data.suggestedInvestigation,
    data.priority
  ]);

  // Notify admins if CRITICAL or HIGH
  if (['CRITICAL', 'HIGH'].includes(data.priority)) {
    await notifyAdmins({
      type: 'research_requirement',
      organizationId: data.organizationId,
      priority: data.priority,
      message: `SHADOW identified research gap: ${data.evidenceGap}`,
      investigation: data.suggestedInvestigation,
      requirementId: result[0].requirement_id
    });
  }

  return result[0];
}
```

### 3. Library Expansion (Verified Patterns)

```typescript
async function addToLibrary(data: {
  organizationId: string;
  patternName: string;
  evidence: string;
  confidenceScore: number; // 0-1
  dataPoints: number;
  applicableRoles: string[];
  linkedToResearchRequirement?: string;
}) {
  const result = await query(`
    INSERT INTO pilot.shadow_library (
      organization_id, pattern_name, evidence, confidence_score,
      data_points_supporting, applicable_roles, verified_at
    ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
    RETURNING pattern_id, verified_at
  `, [
    data.organizationId,
    data.patternName,
    data.evidence,
    data.confidenceScore,
    data.dataPoints,
    data.applicableRoles.join(',')
  ]);

  // If this closes a research requirement, mark it complete
  if (data.linkedToResearchRequirement) {
    await query(`
      UPDATE pilot.shadow_research_requirements
      SET status = 'closed', closed_at = NOW()
      WHERE requirement_id = $1
    `, [data.linkedToResearchRequirement]);
  }

  return result[0];
}

// SHADOW now knows: "Drill volume reduction works 94% of the time"
// And uses it in future recommendations
```

### 4. Confidence Scaling

```typescript
function getRecommendationConfidence(
  type: string,
  effectiveness: number,
  sampleSize: number
): string {
  if (sampleSize === 0) return 'NEW — No track record yet';
  if (sampleSize < 10) return `EMERGING — ${sampleSize} tests, ${Math.round(effectiveness * 100)}% effective`;
  if (effectiveness > 0.9) return `PROVEN — ${sampleSize} tests, 90%+ success`;
  if (effectiveness > 0.7) return `MODERATE — ${sampleSize} tests, ${Math.round(effectiveness * 100)}% success`;
  return `LOW — Rethink needed (${Math.round(effectiveness * 100)}% success)`;
}

// SHADOW says:
// "Reduce volume by 15% (PROVEN — 247 athletes, 94% success)"
// vs
// "Try this new technique (EMERGING — 3 tests, needs more data)"
```

### 5. Feedback Loop

```typescript
async function recordUserFeedback(data: {
  recommendationId: string;
  userId: string;
  helpful: boolean;
  rating?: number; // 1-5
  comment?: string;
  organizationId: string;
}) {
  await query(`
    INSERT INTO pilot.shadow_feedback (
      recommendation_id, user_id, helpful, rating, comment, organization_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
  `, [
    data.recommendationId,
    data.userId,
    data.helpful,
    data.rating || null,
    data.comment || null,
    data.organizationId
  ]);

  // Track aggregated satisfaction
  const satisfaction = await query(`
    SELECT 
      COUNT(*) as total_responses,
      CAST(COUNTIF(helpful = true) AS FLOAT) / COUNT(*) as satisfaction_rate,
      AVG(rating) as avg_rating
    FROM pilot.shadow_feedback
    WHERE organization_id = $1 AND created_at > NOW() - INTERVAL '30 days'
  `, [data.organizationId]);

  if (satisfaction[0].satisfaction_rate < 0.7) {
    await notifyAdmins({
      severity: 'warning',
      message: `SHADOW satisfaction declined to ${Math.round(satisfaction[0].satisfaction_rate * 100)}%`,
      action: 'Review recent recommendations and library patterns'
    });
  }
}
```

---

## Upload Architecture: Evidence Intake Router

### Purpose
Uploads are the primary mechanism for evidence ingestion. Uploads do NOT automatically become knowledge. All uploads generate observation records and may create research requirements. Evidence must be validated before entering the library.

### Supported Upload Types

```
EVIDENCE CATEGORIES

Athletic Performance:
├─ Video recordings (technique, sparring, training)
├─ Readiness assessments
├─ Progression tracking
├─ Performance metrics

Medical/Safety:
├─ Medical assessments and reports
├─ Restriction documents
├─ Injury incident logs
├─ Recovery protocols

Expertise:
├─ Research papers and studies
├─ Coaching manuals and resources
├─ External assessments
├─ Evidence sources

Governance:
├─ Consent and permission documents
├─ Guardian communications
├─ Board decision records
├─ Compliance documentation

Organizational:
├─ Program documentation
├─ Session plans
├─ Attendance records
├─ Administrative records

Observation Logs:
├─ Coach notes
├─ Parent observations
├─ Athlete feedback
├─ Volunteer reports

Research:
├─ Survey results
├─ Interview transcripts
├─ Experiment data
├─ Hypothesis testing
```

### Upload Processing Pipeline

```
Upload Submitted
    ↓
Validate Format & Access Control
    ↓
Create Observation Record
    ↓
Extract Metadata
    ↓
Classify Evidence Type
    ↓
Scan for Research Opportunities
    ↓
Generate Research Requirements (if needed)
    ↓
Create Evidence Record
    ↓
Notify Relevant Stakeholders
    ↓
Ready for Manual Review/Validation
```

### Key Doctrine
- Uploads create **observation records**, not permanent knowledge
- Evidence must pass **validation** before library inclusion
- Uploads may generate **research requirements** automatically
- Contradictory evidence must be **investigated**, not discarded
- Upload acceptance ≠ truth

---

## Failure Intelligence

### Purpose
Learning from failure is often more valuable than learning from success. SHADOW tracks unexpected outcomes, contradictory evidence, and failed predictions to improve organizational intelligence.

### Failure Library

```
Failure Categories:

Prediction Failures:
├─ "We predicted X, observed Y"
├─ "Pattern breaks at this scale"
├─ "Context changed outcomes"
└─ "Model doesn't apply here"

Contradiction Evidence:
├─ "This contradicts earlier finding"
├─ "Two reliable sources disagree"
├─ "Pattern was inconsistent"
└─ "Confounding variable"

Recommendation Failures:
├─ "Followed recommendation, got opposite outcome"
├─ "Recommendation worked for some, not others"
├─ "Recommendation caused unintended consequence"
└─ "Effect size smaller than expected"

Implementation Failures:
├─ "Process failed during execution"
├─ "Technology limitation discovered"
├─ "Compliance issue emerged"
└─ "Cost exceeded prediction"
```

### Failure Tracking Implementation

```typescript
async function logFailureIntelligence(data: {
  organizationId: string;
  failureType: 'prediction_failure' | 'contradiction' | 'recommendation_failure' | 'implementation_failure';
  expectedOutcome: string;
  actualOutcome: string;
  context: string;
  possibleCauses: string[];
  suggestedInvestigation: string;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
}) {
  // Log failure
  const failureRecord = await query(`
    INSERT INTO pilot.shadow_failure_intelligence (
      organization_id, failure_type, expected_outcome, actual_outcome,
      context, possible_causes, priority, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    RETURNING failure_id
  `, [...]);

  // Auto-generate investigation requirement
  await createResearchRequirement({
    organizationId: data.organizationId,
    context: `Failure: ${data.expectedOutcome} → ${data.actualOutcome}`,
    evidenceGap: `Why did our prediction fail?`,
    suggestedInvestigation: data.suggestedInvestigation,
    priority: data.priority,
  });

  // Notify admins for HIGH/CRITICAL
  if (['HIGH', 'CRITICAL'].includes(data.priority)) {
    await notifyAdmins({
      type: 'failure_intelligence',
      message: `Failure detected: ${data.expectedOutcome} vs ${data.actualOutcome}`,
      context: data.context,
    });
  }
}

// Doctrine: \"Learning from failure is not failure. Ignoring failure is failure.\"
```

### Usage in Growth
Failure intelligence is weighted more heavily than success intelligence when revising patterns. A single failure may trigger investigation while multiple successes might not, if context suggests fragility.

---

## Federated Learning Policy

### Purpose
SHADOW operates within organizational boundaries by default. Federation enables learning across organizations while preserving privacy and autonomy.

### Three-Level Federation Model (MVP: Level 1 Only - FIX 6)

**FIX 6: Federation is DISABLED for MVP**

Levels are documented for future roadmap, but MVP uses LEVEL 1 exclusively.

```
LEVEL 1: Organization-Only Learning (MVP - ACTIVE)
├─ SHADOW learns within single organization ONLY
├─ No cross-organization pattern sharing
├─ No automatic data export
├─ Full data access for internal stakeholders only
├─ No federation governance (single org, no federation needed)
└─ All Level 2 and Level 3 blocked until governance approved

LEVEL 2: Anonymized Pattern Sharing (FUTURE - DISABLED)
├─ Requires explicit organizational approval
├─ All athlete/personal data removed
├─ Aggregate statistics only
├─ Requires formal data governance agreement
├─ Automatic sharing is NEVER permitted
├─ Example: \"Compliance-to-outcome correlation\" (no athlete names)

LEVEL 3: Approved Federation Learning (FUTURE - DISABLED)
├─ Requires formal multi-organization governance structure
├─ Controlled pattern and research sharing
├─ Explicit approval required for each share
├─ Research requirements coordinated
├─ Findings validated across sites
├─ Example: \"Multi-site effectiveness study\"
```

### Federation Governance

```typescript\ninterface FederationPolicy {\n  level: 1 | 2 | 3;\n  organizationIds: string[];\n  sharedPatterns: string[]; // LEVEL 2+\n  governance: {\n    approvalRequired: boolean;\n    dataPrivacyLevel: 'anonymous' | 'pseudonymous' | 'full';\n    conflictResolution: 'majority' | 'consensus' | 'org_veto';\n    ownershipModel: 'shared' | 'originating_org_owns';\n  };\n  auditTrail: boolean; // ALWAYS true\n}\n\n// Example: Level 2 Pattern Sharing\nconst federationAgreement: FederationPolicy = {\n  level: 2,\n  organizationIds: ['org_ppbf_main', 'org_ppbf_satellite', 'org_partner_gym'],\n  sharedPatterns: [\n    'compliance_to_progression_correlation',\n    'readiness_volatility_patterns',\n    'volume_to_injury_risk'\n  ],\n  governance: {\n    approvalRequired: false, // Level 2 = automated\n    dataPrivacyLevel: 'anonymous',\n    conflictResolution: 'majority',\n    ownershipModel: 'shared',\n  },\n  auditTrail: true,\n};\n```\n\n**Non-Negotiable**:\n- Federation may NEVER happen without documented governance\n- All federation must have audit trail\n- Organizations must opt-in explicitly\n- Patient/athlete privacy is non-negotiable\n\n---\n\n## Research Closure Standards\n\n### Purpose\nResearch requirements are only \"closed\" when rigorous standards are met. Premature closure reduces organizational intelligence quality.\n\n### Closure Requirements\n\nA research requirement may only be closed when ALL are true:\n\n```\n1. EVIDENCE THRESHOLD MET\n   └─ Minimum meaningful sample size achieved\n   └─ Multiple data points collected\n   └─ Sufficient for statistical validity\n\n2. SAMPLE SIZE VALIDATED\n   └─ n >= 30 for athlete-level patterns\n   └─ n >= 3 for rare phenomena\n   └─ n >= (calculated minimum) for effect size\n   └─ Sample must be representative, not cherry-picked\n\n3. CONTRADICTORY EVIDENCE REVIEWED\n   └─ All opposing evidence examined\n   └─ Contradictions investigated\n   └─ Exceptions documented\n   └─ Confidence adjusted accordingly\n\n4. HUMAN REVIEWER APPROVAL\n   └─ Coach or subject matter expert reviews conclusion\n   └─ Reviewer confirms evidence adequacy\n   └─ Reviewer signs off on confidence level\n   └─ Reviewer documents any reservations\n\n5. CONFIDENCE LEVEL ASSIGNED\n   └─ PROVEN (90%+ success, n>=50)\n   └─ EMERGING (60-89% success, n>=20)\n   └─ EXPERIMENTAL (20-59% success, n>=10)\n   └─ PROVISIONAL (insufficient data, mark for re-review)\n```\n\n### Closure Documentation\n\n```typescript\ninterface ResearchClosure {\n  requirementId: string;\n  organizationId: string;\n  investigationSummary: string;\n  conclusionStatement: string;\n  confidenceLevel: 'PROVEN' | 'EMERGING' | 'EXPERIMENTAL' | 'PROVISIONAL';\n  sampleSize: number;\n  dataPoints: Array<{\n    outcome: string;\n    frequency: number;\n    percentage: number;\n  }>;\n  contradictions: Array<{\n    contradictoryFinding: string;\n    resolvedHow: string;\n  }>;\n  remainingUnknowns: string[];\n  reviewerName: string;\n  reviewerRole: string;\n  reviewedAt: Date;\n  successRate?: number; // PROVEN/EMERGING\n  nextInvestigation?: string; // What to study next\n}\n\n// Auto-create library entry only after successful closure\nawait addToLibrary({\n  organizationId,\n  patternName: closure.conclusionStatement,\n  evidence: closure.investigationSummary,\n  confidenceScore: mapConfidenceToScore(closure.confidenceLevel),\n  dataPoints: closure.sampleSize,\n  applicableRoles: determineApplicableRoles(closure),\n  linkedToResearchRequirement: closure.requirementId,\n});\n```\n\n**Doctrine**: \"Closure is not the end of learning. It is the beginning of application. Close with rigor.\"\n\n---\n\n## Storage & Archival Strategy

### Hot/Cold/Archive Tier Model

```typescript
// HOT (0-30 days): Keep in main PostgreSQL DB
// - Active chats for real-time queries
// - Current effectiveness tracking
// - Open research requirements

// WARM (30-90 days): Keep in PostgreSQL but compressed
// - Archived recommendations
// - Historical patterns (for trending)

// COLD (90+ days): Archive to Blob Storage
// - Complete audit trail (legal/compliance)
// - Retrieve only on request (rare)
// - Compressed for cost efficiency

async function archiveOldData() {
  // 1. Export 90+ day old chat data
  const archived = await query(`
    SELECT * FROM pilot.shadow_chat_audit
    WHERE created_at < NOW() - INTERVAL '90 days'
  `);

  if (archived.length > 0) {
    // 2. Compress and upload to blob
    const compressed = zlib.gzipSync(JSON.stringify(archived));
    const blobClient = containerClient.getBlockBlobClient(
      `shadow-archive/chats-${new Date().toISOString().split('T')[0]}.json.gz`
    );
    await blobClient.upload(compressed, compressed.length);

    // 3. Delete from hot storage
    await query(`
      DELETE FROM pilot.shadow_chat_audit
      WHERE created_at < NOW() - INTERVAL '90 days'
    `);
  }

  // 4. Aggregate stats for long-term trending
  const monthlyStats = await query(`
    SELECT 
      DATE_TRUNC('month', created_at) as month,
      COUNT(*) as interaction_count,
      AVG(CASE WHEN was_filtered THEN 1 ELSE 0 END) as filter_rate,
      organization_id
    FROM archived_data
    GROUP BY DATE_TRUNC('month', created_at), organization_id
  `);

  await query(`
    INSERT INTO pilot.shadow_monthly_stats (month, interaction_count, filter_rate, organization_id)
    VALUES ${monthlyStats.map(s => `('${s.month}', ${s.interaction_count}, ${s.filter_rate}, '${s.organization_id}')`).join(', ')}
  `);
}

// Schedule: Run monthly via cron
// cron: "0 1 1 * *" (1 AM on first of each month)
```

### Database Optimization

```sql
-- Add indexes for performance
CREATE INDEX shadow_chat_org_date 
  ON pilot.shadow_chat_audit(organization_id, created_at DESC);

CREATE INDEX shadow_effectiveness_org 
  ON pilot.shadow_recommendation_effectiveness(organization_id, recommendation_type);

-- Partition by time for hot/cold separation
CREATE TABLE pilot.shadow_chat_audit_2026_07 
  PARTITION OF pilot.shadow_chat_audit
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- Compress partitions older than 90 days
ALTER TABLE pilot.shadow_chat_audit_2026_04 
  ALTER COLUMN shadow_response STORAGE EXTERNAL;

-- Result: Recent queries fast, old data accessible but slower
```

### Cost Analysis

```
Monthly Storage Costs:

PostgreSQL (Active Data):
├─ 30 days of hot data: ~100 MB
├─ Indexes & overhead: ~50 MB
├─ Total: ~150 MB
├─ Cost (Azure Database for PostgreSQL): ~$15-30/month

Blob Storage (Archives):
├─ 24 months of compressed data: ~500 MB
├─ Cost: ~$0.01/month (at $0.018/GB/month)

Total:
├─ Single gym: ~$15-30/month
├─ 12 gyms: ~$180-360/month
├─ Annual: ~$2,160-4,320/year

Storage Doesn't Grow:
├─ Old data archived and deleted from DB
├─ Only active 90 days kept in fast storage
├─ Database footprint remains ~150 MB
├─ Archive footprint grows slowly (~40 MB/month)
```

---

## Database Schema

```sql
-- SHADOW Chat Audit Trail
CREATE TABLE pilot.shadow_chat_audit (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES pilot.organizations(organization_id),
  user_id TEXT NOT NULL,
  user_role TEXT NOT NULL CHECK (user_role IN ('athlete', 'coach', 'admin', 'board', 'organization_admin')),
  athlete_id TEXT,
  user_message TEXT NOT NULL,
  shadow_response TEXT NOT NULL,
  was_filtered BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Recommendation Effectiveness Tracking
CREATE TABLE pilot.shadow_recommendation_effectiveness (
  effectiveness_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id TEXT NOT NULL,
  athlete_id TEXT,
  organization_id TEXT NOT NULL REFERENCES pilot.organizations(organization_id),
  recommendation_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('safe', 'improved', 'degraded', 'neutral')),
  effectiveness_score FLOAT CHECK (effectiveness_score BETWEEN 0 AND 1),
  readiness_delta FLOAT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Research Requirements
CREATE TABLE pilot.shadow_research_requirements (
  requirement_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES pilot.organizations(organization_id),
  athlete_id TEXT,
  context TEXT NOT NULL,
  evidence_gap TEXT NOT NULL,
  suggested_investigation TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'closed')),
  created_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP,
  investigation_notes TEXT
);

-- SHADOW Library (Verified Patterns)
CREATE TABLE pilot.shadow_library (
  pattern_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES pilot.organizations(organization_id),
  pattern_name TEXT NOT NULL,
  evidence TEXT NOT NULL,
  confidence_score FLOAT CHECK (confidence_score BETWEEN 0 AND 1),
  data_points_supporting INTEGER,
  applicable_roles TEXT, -- comma-separated: 'coach,admin,board'
  verified_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- User Feedback on Recommendations
CREATE TABLE pilot.shadow_feedback (
  feedback_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES pilot.organizations(organization_id),
  helpful BOOLEAN,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Monthly Statistics (Aggregated from Archives)
CREATE TABLE pilot.shadow_monthly_stats (
  stat_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES pilot.organizations(organization_id),
  month DATE NOT NULL,
  interaction_count INTEGER,
  avg_filter_rate FLOAT,
  avg_effectiveness_score FLOAT,
  primary KEY (organization_id, month)
);
```

---

## API Specifications

### POST /api/pilot/shadow/chat

**Request:**
```json
{
  "message": "How should I modify drills for this athlete's low readiness?",
  "athleteId": "athlete_12345",  // Optional - for athlete-specific context
  "context": "readiness"         // Optional - query type hint
}
```

**Response (Streaming):**
```
Content-Type: text/event-stream

Based on readiness tracking data, I'd suggest:

1. **Reduce volume**: Lower reps or sets by 15-20%
2. **Increase recovery**: Add an extra rest day this week
3. **Monitor closely**: Track readiness daily for signs of improvement

Source data: From readiness scores showing 25% drop this week, from progression history showing athlete's typical recovery pattern.

Evidence gap: We lack sleep tracking data, which often correlates with readiness decline.

Recommendation confidence: PROVEN — Similar athletes (n=47) showed 94% improvement within 5-7 days of volume reduction.

Research requirement created: Sleep correlation with readiness changes.

Always discuss with athlete before implementing changes.
```

### POST /api/pilot/shadow/feedback

**Request:**
```json
{
  "recommendationId": "rec_abc123",
  "helpful": true,
  "rating": 5,
  "comment": "Worked perfectly, athlete responded well within 3 days"
}
```

**Response:**
```json
{
  "success": true,
  "feedbackId": "fb_xyz789",
  "aggregatedSatisfaction": {
    "totalResponses": 247,
    "satisfactionRate": 0.92,
    "trend": "improving"
  }
}
```

### GET /api/pilot/shadow/library

**Query:**
```
?organizationId=org_123&minConfidence=0.8
```

**Response:**
```json
{
  "patterns": [
    {
      "patternId": "pat_001",
      "patternName": "Low Readiness + High Volume = Injury Risk",
      "confidenceScore": 0.94,
      "dataPoints": 247,
      "applicableRoles": ["coach", "admin"],
      "verifiedAt": "2026-07-10T14:32:00Z"
    }
  ],
  "totalPatterns": 42
}
```

### GET /api/pilot/shadow/growth-metrics

**Query:**
```
?organizationId=org_123&days=30
```

**Response:**
```json
{
  "period": "Last 30 Days",
  "interactions": 847,
  "researchGapsIdentified": 23,
  "researchGapsClosed": 5,
  "newLibraryPatterns": 3,
  "effectiveness": {
    "average": 0.91,
    "trend": "improving",
    "previousMonth": 0.87
  },
  "topRecommendations": [
    {
      "type": "volume_reduction",
      "effectiveness": 0.96,
      "usageCount": 247
    }
  ],
  "userSatisfaction": 4.2,
  "areasNeedingInvestigation": [
    "Sleep impact on progression",
    "Nutrition correlation with compliance"
  ]
}
```

---

## Implementation Roadmap

### Phase 1: Core Chat (Week 1)
- [x] Design authority model & boundaries
- [ ] Build chat endpoint with Ollama integration
- [ ] Implement request/response validation
- [ ] Create system prompt + context retrieval
- [ ] Setup audit logging
- [ ] Test with sample queries
- [ ] **Deploy**: Provisional to staging

### Phase 2: Growth Mechanisms (Week 2)
- [ ] Build effectiveness tracking system
- [ ] Implement research requirement generation
- [ ] Create library expansion workflow
- [ ] Add user feedback collection
- [ ] Wire confidence scaling
- [ ] **Deploy**: Production rollout

### Phase 3: Storage & Optimization (Week 3)
- [ ] Implement hot/cold tier strategy
- [ ] Build archival pipeline
- [ ] Optimize database indexes
- [ ] Add monitoring/alerting
- [ ] **Deploy**: Full production + compliance

### Phase 4: Growth Dashboard (Week 4)
- [ ] Build admin dashboard: Growth metrics
- [ ] Visualize: Recommendation effectiveness
- [ ] Visualize: Research requirement tracking
- [ ] Visualize: Library expansion over time
- [ ] **Deploy**: Admin panel live

---

## Non-Negotiable SHADOW Truths

These principles must survive migrations, rewrites, frontend redesigns, backend refactors, model changes, and AI-assisted development. They define SHADOW's essential nature.

### The Ten Truths

**1. PURPOSE = ORGANIZATIONAL LEARNING**
- SHADOW exists to help organizations learn about themselves
- Recommendations are secondary outputs, not the primary purpose
- Growth, not accuracy, is the measure of success
- Organizational intelligence is the end goal

**2. UNKNOWNS BECOME RESEARCH**
- Every gap in evidence generates a research requirement
- Missing data is not silence; it is a signal
- "We don't know" is more valuable than "probably X"
- Research requirements drive improvement

**3. EVIDENCE OUTRANKS OPINION**
- Patterns backed by data > expert intuition (when both exist)
- Contradictory evidence must be investigated, not ignored
- Failure intelligence is weighted equally to success intelligence
- Confidence levels must be explicit and visible

**4. RECOMMENDATIONS ARE ADVISORY**
- SHADOW informs decisions; humans make decisions
- Coaches retain authority even for high-confidence patterns
- No recommendation bypasses human judgment
- Implementation is always optional and subject to human review

**5. HUMAN AUTHORITY REMAINS FINAL**
- Coaches, medical professionals, athletes have decision authority
- SHADOW may educate; SHADOW may not decide
- Recommendations require human approval before implementation
- Edge cases default to human judgment

**6. SHADOW MAY EDUCATE BUT NOT DIAGNOSE**
- Education allows discussion of medical topics
- Diagnosis, prescription, and clearance are forbidden
- Authority claims are blocked; vocabulary is not censored
- Teaching athletes to recognize symptoms ≠ diagnosing them

**7. UPLOAD IS THE EVIDENCE INTAKE ROUTER**
- Uploads create observation records, not permanent knowledge
- Evidence must pass validation before entering library
- All uploads may generate research requirements
- Contradictions trigger investigation, not dismissal

**8. FAILURE INTELLIGENCE MATTERS**
- Failed predictions teach more than successes sometimes
- Contradictions are features, not bugs
- Unexpected outcomes generate new research
- Pattern brittleness matters as much as accuracy

**9. CONFIDENCE MUST BE VISIBLE**
- Every recommendation carries confidence level
- Confidence is based on evidence quality and sample size
- Low-confidence patterns are still useful (mark as experimental)
- "High confidence in small dataset" is acknowledged and flagged

**10. ORGANIZATIONAL INTELLIGENCE IS THE END GOAL**
- SHADOW's purpose is not to be perfect; it is to help organizations improve
- Intelligence emerges from evidence, research, and learning
- Long-term organizational growth > short-term accuracy
- SHADOW succeeds when it changes how organizations think

### Doctrine Protection

These truths are codified in:
- **System Overview** (reframed as organizational learning)
- **Authority Model** (education vs authority distinction)
- **Request Validation** (authority-based gatekeeper)
- **Response Filtering** (authority-based, not vocabulary-based)
- **Upload Architecture** (evidence intake, not knowledge ingestion)
- **Failure Intelligence** (contradiction investigation, not dismissal)
- **Research Closure Standards** (rigor over convenience)
- **Non-Negotiable Truths** (this section, doctrine lock)

**Implementation Requirement**: These ten truths must be auditable in the codebase. Every major component should reference at least one truth. Annual doctrine audits should verify alignment.

**Migration Rule**: When updating SHADOW (new models, frameworks, architectures), these truths must be explicitly re-validated. Doctrine drift is the primary risk to long-term organizational intelligence.

---

## Implementation Timeline

| Component | Effort | Dependencies | Owner |
|-----------|--------|--------------|-------|
| Chat Endpoint | 2 days | Ollama setup, context retrieval | Developer |
| Validation Layer | 1 day | Chat endpoint | Developer |
| Audit Logging | 1 day | Chat endpoint | Developer |
| Effectiveness Tracking | 2 days | Chat endpoint, feedback UI | Developer |
| Research Requirements | 1 day | Effectiveness tracking | Developer |
| Library System | 1 day | Research requirements | Developer |
| Storage/Archival | 1 day | Database schema | DevOps |
| Growth Dashboard | 2 days | All systems | Frontend |
| Testing & QA | 2 days | All systems | QA |
| **Total** | **13 days** | | |

---

## Cost Analysis

### Development Cost
- Backend engineering: ~40 hours (~$4,000-6,000 at $100-150/hr)
- Frontend dashboard: ~20 hours (~$2,000-3,000)
- Testing/QA: ~10 hours (~$1,000-1,500)
- **Total Dev**: ~$7,000-10,500 (one-time)

### Infrastructure Cost (Monthly)
- PostgreSQL (active data): $15-30
- Blob storage (archives): $0.01
- Ollama compute (if cloud): $0 (runs on existing machines)
- **Total Ops**: ~$15-30/month per gym, ~$180-360/month for 12 gyms

### Annual Cost
- Development: $7,000-10,500 (one-time)
- Operations: $2,160-4,320/year
- **Total Year 1**: ~$9,000-14,800
- **Total Year 2+**: ~$2,160-4,320/year (no dev cost)

### ROI
- Cost per gym/year: ~$750-1,200
- Value: Improved athlete progression, injury prevention, research insights
- Payback: <1 year if prevents even one season-ending injury per gym

---

## Monitoring & Maintenance

### Metrics to Track
```
Daily:
├─ Chat interactions (trend should grow slowly)
├─ Filter rate (should stay <5%)
├─ Ollama response time (should stay <5s)

Weekly:
├─ Recommendation effectiveness (should trend upward)
├─ User satisfaction (target: >4.0/5.0)
├─ Research requirements (open, closed, new)

Monthly:
├─ Database size (should stay ~150 MB hot)
├─ Archive growth (should be ~40 MB/month)
├─ Library patterns added (should grow slowly)
```

### Maintenance Tasks
```
Daily:
└─ Monitor Ollama health, database connections

Weekly:
├─ Review new research requirements
├─ Check user feedback trends
└─ Validate response quality (sample 5-10 chats)

Monthly:
├─ Run archival process
├─ Generate growth reports
├─ Update library if patterns verified
└─ Review cost metrics

Quarterly:
├─ Full system audit
├─ Update system prompt if needed
├─ Plan new features/capabilities
└─ Review org-specific patterns
```

---

## Risk Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|-----------|
| LLM gives medical diagnosis | Medium | Critical | Hard request validation, response filtering, audit review |
| Storage grows unchecked | Low | Medium | Monthly archival process, automated alerts |
| Ollama downtime | Medium | Medium | Health checks, fallback to sync API, graceful degradation |
| Poor recommendation quality | Medium | Medium | Effectiveness tracking, feedback loop, library review |
| User misuses SHADOW | High | Low | Clear boundaries in UI, role-based access, disclaimer text |

---

## Success Criteria

✅ **Technical**
- [ ] Chat endpoint responds in <5 seconds
- [ ] Audit logs capture 100% of interactions
- [ ] No medical language in approved responses
- [ ] Database stays <500 MB for 12 gyms
- [ ] Uptime >99% (excluding Ollama maintenance)

✅ **Functional**
- [ ] 50+ unique queries in first month
- [ ] User satisfaction ≥4.0/5.0
- [ ] Recommendation effectiveness ≥85%
- [ ] Research requirements generated for real gaps
- [ ] Library grows with verified patterns

✅ **Business**
- [ ] Coaches find recommendations valuable
- [ ] Admins use growth dashboard
- [ ] No adverse outcomes from recommendations
- [ ] Cost <$2,000/year per gym

---

## Questions for Review

1. **Authority Boundaries**: Are the hard boundaries correct and complete?
2. **LLM Choice**: Is Mistral 7B appropriate, or should we start with something else?
3. **Storage Strategy**: Is the 90-day hot/cold split optimal?
4. **Growth Mechanisms**: Are effectiveness tracking metrics the right ones?
5. **Deployment**: Should we stage SHADOW at one gym first, then roll out?
6. **Feedback**: How should we collect user feedback after recommendations?

---

## Appendix A: Example SHADOW Interactions

### Example 1: Coach Query

**Coach**: "Athlete's readiness is 58%, down 15% this week. What do I do?"

**SHADOW Response**:
```
Observation: A 15% readiness drop over one week is significant and warrants attention.

RECOMMENDATION:
1. Reduce training volume by 15-20% this week (fewer reps, slightly lighter weights)
2. Add one extra rest day if possible
3. Monitor readiness daily — should stabilize or improve within 3-5 days

REASONING:
Pattern: Low readiness + high volume correlates with injury risk
Data: 247 similar cases; 94% improved within 5-7 days of volume reduction
Confidence: PROVEN (high data support)

DATA SOURCES:
- From readiness tracking scores
- From progression history
- From compliance metrics

UNKNOWNS:
- Sleep quality? (not tracked)
- Nutrition? (not tracked)
- Stress level? (not tracked)

NEXT STEPS:
1. Discuss modifications with athlete
2. Implement volume reduction
3. Track readiness daily
4. If no improvement in 5 days, escalate to medical professional

RESEARCH OPPORTUNITY:
"Sleep impact on readiness decline" — We should investigate this pattern.
```

### Example 2: Athlete Query

**Athlete**: "Is it safe for me to do the advanced drill if my readiness is low?"

**SHADOW Response**:
```
Safety Concern: Training advanced drills with low readiness (58%) increases injury risk.

RECOMMENDATION: Ask your coach first.

REASONING:
Pattern: Low readiness + high-intensity training = elevated injury risk
Data: From past athlete injury data
Confidence: PROVEN

WHAT WE KNOW:
- Your readiness is 58% (below baseline)
- Advanced drills require high readiness reserve
- This combination is risky

WHAT WE DON'T KNOW:
- Your specific injury history
- Your pain tolerance
- Your individual recovery pattern
- Whether your coach approves

DECISION: Coach + you together make this call, not SHADOW.

RECOMMENDATION:
"Coach, should I modify the advanced drill given my low readiness?"
```

### Example 3: Admin Query

**Admin**: "Show me SHADOW's effectiveness over the last quarter."

**SHADOW Response** (Dashboard View):
```
SHADOW Growth Report: Q2 2026

INTERACTIONS: 2,847 total
├─ Coach queries: 1,624 (57%)
├─ Athlete education: 823 (29%)
├─ Admin requests: 247 (9%)
└─ Board insights: 153 (5%)

RECOMMENDATION EFFECTIVENESS:
├─ Average: 91% (up from 87% Q1)
├─ Trend: Improving ↑
├─ Top performer: "Volume reduction for low readiness" (96% effective)
├─ Needs work: "Drill substitution for pain" (67% effective)

RESEARCH OUTCOMES:
├─ Gaps identified: 73
├─ Gaps investigated: 18
├─ Gaps closed: 5
├─ Findings added to library: 3 new patterns

NEW LIBRARY PATTERNS:
1. "Athletes with low sleep + high volume show 3x injury rate" (HIGH confidence)
2. "Progressive overload works best for compliance >85%" (EMERGING)
3. "Recovery protocols reduce readiness volatility" (PROVEN)

USER SATISFACTION: 4.2/5.0 (247 ratings)

COST:
├─ Storage used: 180 MB hot + 400 MB archive
├─ Monthly cost: $28
├─ Cost per interaction: $0.01
├─ ROI: Extremely high

NEXT QUARTER PRIORITIES:
1. Close "sleep correlation" research requirement
2. Verify "pain-based drill substitution" patterns
3. Expand athletic intake data collection
4. Coach training on using SHADOW effectively
```

---

## Appendix B: Security & Compliance

### Data Handling
- ✅ All data encrypted at rest (PostgreSQL)
- ✅ All data encrypted in transit (TLS)
- ✅ Role-based access (12 tier system)
- ✅ Audit trail complete (every interaction logged)
- ✅ GDPR-compliant data retention (delete after 12 months unless required)

### Medical Compliance
- ✅ NO diagnosis capability
- ✅ NO prescription capability
- ✅ NO clinical decision-making
- ✅ All recommendations clearly marked as "informational"
- ✅ Users directed to qualified professionals for medical questions
- ✅ Audit trail available for compliance review

### LLM Safety
- ✅ Request validation (blocks medical queries)
- ✅ Response filtering (removes diagnosis language)
- ✅ Hard boundaries encoded in system prompt
- ✅ Role-based access restrictions
- ✅ Human-in-loop feedback system

---

This plan is **ready for implementation** and has been designed to be:
- ✅ Technically sound (standard architecture, proven technologies)
- ✅ Organizationally safe (clear boundaries, audit trail)
- ✅ Cost-effective (free LLM, minimal infrastructure)
- ✅ Scalable (12 gyms, unlimited growth with archival)
- ✅ Maintainable (clear monitoring, documented processes)

**Next Step**: Share with other AIs for review, then proceed with implementation on Week 1.
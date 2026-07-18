'use client';

import { Suspense, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { readRoleSession, clearRoleSession } from '@/components/roleSession';
import { apiBase } from '@/lib/apiBase';
import ShadowChatButton from '@/components/ShadowChatButton';

interface ShadowMessage {
  id: string;
  type: 'user' | 'shadow';
  text: string;
  timestamp: string;
  tier?: 'quick_round' | 'heavy_bag';
  profileTier?: 'bronze' | 'silver' | 'gold';
  modelUsed?: string;
  isAsync?: boolean;
  jobId?: string;
}

interface ShadowResearchReport {
  id: string;
  question: string;
  researchRequirement: string;
  knowledgeGap: string;
  status: 'created' | 'draft';
  createdAt: string;
}

interface ShadowLibraryClaimApiResponse {
  ok: boolean;
  claim: {
    answer: string;
    status: 'supported' | 'weak' | 'unsupported';
    confidence: number;
    evidence: Array<{
      chunk_id: string;
      source_id: string;
    }>;
    researchRequirementId: number | null;
  };
}

const GENERIC_UNSUPPORTED_REPLY = 'If this question needs a sourced answer, I should either answer from verified evidence or create a research requirement. Try asking about doctrine, evidence, readiness, recovery, technique, or organizational learning.';

const HEAVY_BAG_ELIGIBLE_ROLES = new Set(['coach', 'admin', 'organization_admin', 'platform_owner', 'staff']);

function formatTimestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function appendContext(base: string, context: string, prefix: string) {
  if (!context) {
    return `${base}.`;
  }

  return `${base} ${prefix} ${context}.`;
}

function buildWelcomeMessage(mode: 'master' | 'scoped', role: string, context: string, subject: string) {
  if (mode === 'master') {
    const base = `Master SHADOW online for ${role || 'admin'}. I speak from the organizational layer. Ask about doctrine, evidence gaps, capability growth, research requirements, or cross-system learning`;
    return appendContext(base, context, 'from');
  }

  if (subject) {
    const base = `${subject}'s SHADOW is active. This scope is for subject-specific learning, observation review, and support within SHADOW doctrine`;
    return appendContext(base, context, 'from');
  }

  const base = `Scoped SHADOW online for ${role || 'current role'}. Ask about your role context, learning signals, evidence, or what SHADOW can and cannot support`;
  return appendContext(base, context, 'from');
}

function getMasterShadowReply(question: string) {
  if (question.includes('capability') || question.includes('library') || question.includes('grow')) {
    return 'Master SHADOW rule: as organizational capability grows, the SHADOW library must grow with it. Every new capability should increase observations, evidence classes, research requirements, validated lessons, or organizational memory.';
  }

  if (question.includes('pattern') || question.includes('organization') || question.includes('learn')) {
    return 'Master SHADOW looks for organization-wide learning, not athlete scoring. I track patterns, unresolved gaps, doctrine drift, and whether the organization is becoming smarter over time.';
  }

  if (question.includes('report') || question.includes('gap') || question.includes('unknown')) {
    return 'Use the Research Intake lane for source gaps and unresolved questions, and the Admin SHADOW console for authority and telemetry traces. Unknowns should generate research requirements, not fake certainty.';
  }

  return '';
}

function getSubjectShadowReply(question: string, subject: string) {
  if (question.includes('readiness') || question.includes('recovery')) {
    return `${subject}'s SHADOW should focus on observation, learning, recovery patterns, and evidence quality. It may support the human in front of ${subject}, but it may not clear participation or replace human authority.`;
  }

  if (question.includes('injury') || question.includes('pain') || question.includes('hurt')) {
    return `${subject}'s SHADOW can track observations, restrictions, and educational material. It cannot diagnose, prescribe, or clear return to participation.`;
  }

  return '';
}

function getGeneralShadowReply(question: string, context: string) {
  if (question.includes('source') || question.includes('evidence') || question.includes('prove')) {
    return 'If I cannot answer with a source or solid evidence, that should become a SHADOW research requirement. Check The Library and the Research Intake lane for unresolved gaps and evidence reviews.';
  }

  if (question.includes('readiness')) {
    return 'SHADOW should not collapse a person into a single universal readiness score. Use a multidomain advisory profile: sleep, recovery, fatigue, stress, soreness, workload, intent, confidence, restrictions, and data quality.';
  }

  if (question.includes('rpe') || question.includes('effort')) {
    return 'RPE and effort belong inside observation and learning. They help detect pattern shifts, strain, and mismatch, but they do not create truth or authority by themselves.';
  }

  if (question.includes('drill') || question.includes('technique')) {
    return 'Technique questions should produce learning support, not false certainty. SHADOW can organize drills, guidance, and educational material while keeping human coaching authority intact.';
  }

  if (question.includes('injury') || question.includes('pain') || question.includes('hurt')) {
    return 'Injury and pain are observation domains. SHADOW may track, educate, and escalate concerns, but it may not diagnose, prescribe treatment, or clear participation.';
  }

  if (question.includes('how') && question.includes('work')) {
    const base = 'SHADOW turns observations into organizational intelligence through learning, improvement, knowledge, research, and memory';
    return `${appendContext(base, context, 'within')} Humans retain authority.`;
  }

  if (question.includes('data') || question.includes('upload')) {
    return 'Uploads should become routed evidence, then review, then observation, then learning. Evidence supports learning. Evidence does not bypass authority.';
  }

  return GENERIC_UNSUPPORTED_REPLY;
}

function deriveResearchRequirement(mode: 'master' | 'scoped', rawQuestion: string, normalizedQuestion: string, reply: string, context: string, subject: string) {
  const needsSource = normalizedQuestion.includes('source') || normalizedQuestion.includes('evidence') || normalizedQuestion.includes('prove');
  const unsupported = reply === GENERIC_UNSUPPORTED_REPLY;

  if (!needsSource && !unsupported) {
    return null;
  }

  let scopeLabel = 'scoped-shadow';
  if (mode === 'master') {
    scopeLabel = 'master-shadow';
  } else if (subject) {
    scopeLabel = `${subject}-shadow`;
  }
  const contextLabel = context || 'shadow-chat';

  return {
    source_event_name: 'SHADOW_CHAT_SOURCE_GAP',
    source_entity_type: 'shadow_chat_question',
    source_entity_id: `chat-${Date.now()}`,
    research_requirement: `Resolve sourced answer requirement for ${scopeLabel} in ${contextLabel}`,
    knowledge_gap: `Question requires stronger evidence or verified source support: ${rawQuestion}`,
    evidence_label: subject || null,
    source_status: 'observed',
    source_confidence_tier: 'INSUFFICIENT',
    source_verification_state: 'unknown',
    metadata: {
      question: rawQuestion,
      mode,
      context,
      subject,
      scope: scopeLabel,
    },
  } as const;
}

function getShadowReply(mode: 'master' | 'scoped', question: string, context: string, subject: string) {
  if (mode === 'master') {
    const masterReply = getMasterShadowReply(question);
    if (masterReply) {
      return masterReply;
    }
  }

  if (subject) {
    const subjectReply = getSubjectShadowReply(question, subject);
    if (subjectReply) {
      return subjectReply;
    }
  }

  return getGeneralShadowReply(question, context);
}

function getActiveScope(mode: 'master' | 'scoped', subject: string): 'master' | 'scoped' | 'subject' {
  if (mode === 'master') {
    return 'master';
  }

  if (subject) {
    return 'subject';
  }

  return 'scoped';
}

function ShadowChatPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [userRole] = useState<string>(() => (typeof window !== 'undefined' ? readRoleSession()?.role ?? '' : ''));
  const mode = searchParams.get('mode') === 'master' ? 'master' : 'scoped';
  const context = searchParams.get('context')?.trim() ?? '';
  const subject = searchParams.get('subject')?.trim() ?? '';
  const roleLabel = (searchParams.get('role')?.trim() || userRole || 'guest').toUpperCase();
  let heading = 'SHADOW';
  let intro = 'Scoped role-aware SHADOW conversation.';
  let scopeSummary = 'Role-scoped SHADOW view.';

  if (mode === 'master') {
    heading = 'MASTER SHADOW';
    intro = 'Organizational intelligence, doctrine, and learning oversight.';
    scopeSummary = 'Master SHADOW for admin/organizational intelligence.';
  } else if (subject) {
    heading = `${subject.toUpperCase()} SHADOW`;
    intro = `Subject-specific learning scope for ${subject}.`;
    scopeSummary = `${subject} subject scope.`;
  }
  const [messages, setMessages] = useState<ShadowMessage[]>([
    {
      id: '0',
      type: 'shadow',
      text: buildWelcomeMessage(mode, roleLabel, context, subject),
      timestamp: formatTimestamp(),
    },
  ]);
  const [userInput, setUserInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [heavyBagMode, setHeavyBagMode] = useState(false);
  const [reports, setReports] = useState<ShadowResearchReport[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const session = readRoleSession();
    if (!session) {
      router.replace('/login');
    }
  }, [router]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function addMessage(type: 'user' | 'shadow', text: string, meta?: Partial<Pick<ShadowMessage, 'tier' | 'profileTier' | 'modelUsed' | 'isAsync' | 'jobId'>>) {
    const newMessage: ShadowMessage = {
      id: Date.now().toString(),
      type,
      text,
      timestamp: formatTimestamp(),
      ...meta,
    };
    setMessages((prev) => [...prev, newMessage]);
  }

  function handleLogout() {
    clearRoleSession();
    router.push('/login');
  }

  function prependResearchReport(report: ShadowResearchReport) {
    setReports((current) => [report, ...current].slice(0, 8));
  }

  function recordBackendResearchReport(rawQuestion: string, researchRequirementId: number, evidenceCount: number) {
    prependResearchReport({
      id: `rr-${researchRequirementId}`,
      question: rawQuestion,
      researchRequirement: `Backend research requirement #${researchRequirementId} created from SHADOW Library claim flow.`,
      knowledgeGap: `Claim was filed with ${evidenceCount} evidence items and still required research escalation.`,
      status: 'created',
      createdAt: formatTimestamp(),
    });
  }

  async function requestLibraryClaim(rawQuestion: string) {
    const response = await fetch(`${apiBase()}/api/pilot/shadow/library/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: getActiveScope(mode, subject),
        subject_id: subject || undefined,
        question: rawQuestion,
        limit: 5,
      }),
    });

    if (!response.ok) {
      throw new Error('library claim request failed');
    }

    return (await response.json()) as ShadowLibraryClaimApiResponse;
  }

  async function createResearchReport(rawQuestion: string, normalizedQuestion: string, reply: string) {
    const requirement = deriveResearchRequirement(mode, rawQuestion, normalizedQuestion, reply, context, subject);
    if (!requirement) {
      return;
    }

    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/research-requirements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requirement),
      });

      if (!response.ok) {
        throw new Error('backend session unavailable');
      }

      prependResearchReport({
        id: requirement.source_entity_id,
        question: rawQuestion,
        researchRequirement: requirement.research_requirement,
        knowledgeGap: requirement.knowledge_gap,
        status: 'created',
        createdAt: formatTimestamp(),
      });
      addMessage('shadow', 'Research requirement created and routed to the Research Intake lane. Check The Library or Research Intake for follow-up.');
    } catch {
      prependResearchReport({
        id: requirement.source_entity_id,
        question: rawQuestion,
        researchRequirement: requirement.research_requirement,
        knowledgeGap: requirement.knowledge_gap,
        status: 'draft',
        createdAt: formatTimestamp(),
      });
      addMessage('shadow', 'Research report draft captured in this session, but I could not file it to the backend from the current auth context. Open Research Intake to submit or review it manually.');
    }
  }

  async function callShadowAI(rawQuestion: string): Promise<void> {
    const response = await fetch(`${apiBase()}/api/pilot/shadow/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        message: rawQuestion,
        tier: heavyBagMode ? 'heavy_bag' : undefined,
      }),
    });

    if (!response.ok) {
      throw new Error(`SHADOW AI error: ${response.status}`);
    }

    const data = (await response.json()) as {
      success: boolean;
      response: string;
      tier?: 'quick_round' | 'heavy_bag';
      profileTier?: 'bronze' | 'silver' | 'gold';
      modelUsed?: string;
      async?: boolean;
      jobId?: string;
      error?: string;
    };

    if (data.async && data.jobId) {
      addMessage('shadow',
        `Your Heavy Bag Session is queued and processing in the background. Job ID: ${data.jobId}`,
        { tier: 'heavy_bag', isAsync: true, jobId: data.jobId }
      );
    } else {
      addMessage('shadow',
        data.response || data.error || 'SHADOW encountered an error.',
        { tier: data.tier, profileTier: data.profileTier, modelUsed: data.modelUsed }
      );
    }
  }

  async function handleSendMessage(e: SyntheticEvent) {
    e.preventDefault();
    if (!userInput.trim() || isLoading) return;

    const rawQuestion = userInput.trim();
    addMessage('user', rawQuestion);
    setUserInput('');
    setIsLoading(true);

    try {
      await callShadowAI(rawQuestion);
    } catch {
      // Fallback: try library claim, then static reply
      const question = rawQuestion.toLowerCase();
      try {
        const payload = await requestLibraryClaim(rawQuestion);
        addMessage('shadow', payload.claim.answer);
        if (payload.claim.researchRequirementId) {
          recordBackendResearchReport(rawQuestion, payload.claim.researchRequirementId, payload.claim.evidence.length);
        }
      } catch {
        const reply = getShadowReply(mode, question, context, subject);
        addMessage('shadow', reply);
        await createResearchReport(rawQuestion, question, reply);
      }
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6]">
      {/* HEADER */}
      <header className="border-b-4 border-[#8b4444] bg-[#1a1a1a] px-4 py-4 md:px-8 md:py-6">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-[#dc2626]">{mode === 'master' ? 'The Architect' : 'The Scout'}</p>
            <h1 className="font-display text-2xl font-black tracking-tight text-[#e8d7c6] md:text-3xl">{heading}</h1>
            <p className="mt-1 text-xs text-[#b0a095]">{intro}</p>
          </div>
          <div className="flex items-center gap-4 text-right">
            <div>
              <p className="font-mono text-[10px] text-[#8a8a8a]">Role: {roleLabel}</p>
              {context ? <p className="font-mono text-[10px] text-[#8a8a8a]">Context: {context}</p> : null}
              <p className="text-xs font-bold text-[#dc2626]">LIVE</p>
            </div>
            <button
              onClick={handleLogout}
              className="border-2 border-[#8b4444] bg-[#2a1a1a] px-3 py-2 text-xs font-semibold uppercase tracking-[0.1em] text-[#b0a095] transition hover:border-[#d4a574] hover:bg-[#3a2a2a] hover:text-[#e8d7c6]"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-4xl p-4 md:p-8">
        <section className="mb-4 grid gap-3 border-2 border-[#8b4444] bg-[#151515] p-4 text-xs text-[#cfbfae] md:grid-cols-3">
          <div>
            <p className="font-mono uppercase tracking-[0.14em] text-[#d4a574]">Scope</p>
            <p className="mt-2">{scopeSummary}</p>
          </div>
          <div>
            <p className="font-mono uppercase tracking-[0.14em] text-[#d4a574]">Authority Boundary</p>
            <p className="mt-2">SHADOW can improve learning and generate research. SHADOW cannot clear, diagnose, prescribe, or override human authority.</p>
          </div>
          <div>
            <p className="font-mono uppercase tracking-[0.14em] text-[#d4a574]">When Evidence Is Weak</p>
            <p className="mt-2">Use The Library and Research Intake. Unknowns should become research requirements, not fake certainty.</p>
          </div>
        </section>

        {reports.length > 0 ? (
          <section className="mb-4 border-2 border-[#8b4444] bg-[#151515] p-4 text-xs text-[#cfbfae]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-mono uppercase tracking-[0.14em] text-[#d4a574]">Research Reports This Session</p>
                <p className="mt-2">Created reports go to Research Intake when backend auth is available. Otherwise they remain session drafts here.</p>
              </div>
              <Link
                href="/research"
                className="border-2 border-[#d4a574] bg-[#1f1f1f] px-3 py-2 text-[10px] font-mono uppercase tracking-[0.12em] text-[#d4a574] transition hover:border-[#d4a574] hover:bg-[#2a1f1f]"
              >
                Open Research Intake
              </Link>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {reports.map((report) => (
                <article key={report.id} className="border border-[#5a4a3a] bg-[#0f0f0f] p-3">
                  <p className="text-[10px] font-mono uppercase tracking-[0.12em] text-[#d4a574]">{report.status === 'created' ? 'Backend Filed' : 'Session Draft'}</p>
                  <p className="mt-2 text-[12px] leading-5 text-[#e8d7c6]">{report.question}</p>
                  <p className="mt-2 text-[11px] text-[#b0a095]">{report.researchRequirement}</p>
                  <p className="mt-2 text-[11px] text-[#8a8a8a]">{report.createdAt}</p>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {/* CHAT BOX */}
        <section className="border-4 border-[#8b4444] bg-[#0f0f0f] p-6 shadow-2xl shadow-black/60">
          {/* Messages */}
          <div className="mb-6 max-h-[550px] space-y-4 overflow-y-auto bg-[#050505] p-4 font-mono text-sm">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-3 ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-md px-4 py-3 ${
                    msg.type === 'user'
                      ? 'border-2 border-[#dc2626] bg-[#2a1a1a] text-[#ff6b6b]'
                      : 'border-2 border-[#d4a574] bg-[#2a1f0f] text-[#e8d7c6]'
                  }`}
                >
                  <p className="text-xs leading-6">{msg.text}</p>
                  {msg.tier ? (
                    <p className="mt-1 text-[9px] text-[#6a5a4a]">
                      {msg.tier === 'heavy_bag' ? '🥊 Heavy Bag' : '⚡ Quick Round'}
                      {msg.profileTier ? ` · ${msg.profileTier.charAt(0).toUpperCase()}${msg.profileTier.slice(1)}` : ''}
                      {msg.isAsync ? ' · Processing...' : ''}
                    </p>
                  ) : null}
                  <p className="mt-2 text-[9px] opacity-50">{msg.timestamp}</p>
                </div>
              </div>
            ))}
            {isLoading ? (
              <div className="flex justify-start">
                <div className="border-2 border-[#5a4a3a] bg-[#1a1a1a] px-4 py-3">
                  <p className="text-xs text-[#8a8a8a] font-mono">SHADOW {heavyBagMode ? '🥊 Heavy Bag' : '⚡'} processing...</p>
                </div>
              </div>
            ) : null}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <form onSubmit={handleSendMessage} className="flex gap-2">
            {HEAVY_BAG_ELIGIBLE_ROLES.has(userRole) ? (
              <button
                type="button"
                onClick={() => setHeavyBagMode((v) => !v)}
                title={heavyBagMode ? 'Switch to Quick Round' : 'Switch to Heavy Bag Session (deep reasoning)'}
                className={`border-2 px-3 py-3 text-[9px] font-mono font-bold uppercase tracking-[0.1em] transition ${
                  heavyBagMode
                    ? 'border-[#dc2626] bg-[#3a1a1a] text-[#dc2626]'
                    : 'border-[#5a4a3a] bg-[#1a1a1a] text-[#6a5a4a] hover:border-[#8b4444]'
                }`}
              >
                {heavyBagMode ? '🥊' : '⚡'}
              </button>
            ) : null}
            <input
              type="text"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder="What do you need to know?"
              className="flex-1 border-2 border-[#8b4444] bg-[#1a1a1a] px-4 py-3 text-sm text-[#e8d7c6] placeholder-[#6a5a4a] outline-none transition focus:border-[#dc2626] focus:bg-[#2a1a1a]"
            />
            <button
              type="submit"
              disabled={isLoading}
              className="border-2 border-[#8b4444] bg-[#2a1a1a] px-6 py-3 text-xs font-mono font-bold text-[#dc2626] transition hover:border-[#dc2626] hover:bg-[#3a2a2a] hover:text-[#ff6b6b] disabled:opacity-50"
            >
              {isLoading ? '...' : 'Ask'}
            </button>
          </form>
        </section>

        {/* NAV LINKS */}
        <div className="mt-6 flex flex-wrap gap-3">
          <ShadowChatButton context="SHADOW" label="SHADOW CHAT" className="border-[#8b4444] bg-[#1a1a1a] text-[#d4a574] hover:border-[#d4a574] hover:bg-[#2a1a1a]" />
          <Link
            href="/research/chat"
            className="border-2 border-[#d4a574] bg-[#1f1f1f] px-4 py-2 text-xs font-mono text-[#d4a574] transition hover:border-[#d4a574] hover:bg-[#2a1f1f]"
          >
            The Library
          </Link>
          <Link
            href="/research"
            className="border-2 border-[#d4a574] bg-[#1f1f1f] px-4 py-2 text-xs font-mono text-[#d4a574] transition hover:border-[#d4a574] hover:bg-[#2a1f1f]"
          >
            Research Intake
          </Link>
          <Link
            href="/admin/shadow"
            className="border-2 border-[#8b4444] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#dc2626] transition hover:border-[#dc2626] hover:bg-[#2a1a1a]"
          >
            The Office
          </Link>
          <Link
            href="/operations"
            className="border-2 border-[#4a4a4a] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#b0b0b0] transition hover:border-[#8a8a8a] hover:text-[#e8d7c6]"
          >
            Operations
          </Link>
          <Link
            href="/coach/video-analysis"
            className="border-2 border-[#8b4444] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574] transition hover:border-[#d4a574] hover:bg-[#2a1a1a]"
          >
            AI Video Analysis (Planned)
          </Link>
          <Link
            href="/board/compliance-monitoring"
            className="border-2 border-[#8b4444] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574] transition hover:border-[#d4a574] hover:bg-[#2a1a1a]"
          >
            Compliance Monitoring (Planned)
          </Link>
          <Link
            href="/athlete/progression-intelligence"
            className="border-2 border-[#8b4444] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574] transition hover:border-[#d4a574] hover:bg-[#2a1a1a]"
          >
            Progression Intelligence (Planned)
          </Link>
          <Link
            href="/source-control/publication-workflow"
            className="border-2 border-[#8b4444] bg-[#1a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574] transition hover:border-[#d4a574] hover:bg-[#2a1a1a]"
          >
            Publication Workflow (Planned)
          </Link>
        </div>
      </div>
    </main>
  );
}

export default function ShadowChatPage() {
  return (
    <Suspense fallback={<main className="grid min-h-screen place-items-center bg-[#0a0a0a] px-6 text-[#e8d7c6]"><div className="text-center"><p className="text-xs font-mono uppercase tracking-[0.35em] text-[#dc2626]">SHADOW</p><h1 className="mt-3 font-display text-3xl tracking-tight">Loading scope</h1></div></main>}>
      <ShadowChatPageContent />
    </Suspense>
  );
}

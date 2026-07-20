'use client';

import { Suspense, useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from 'react';
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
  feedbackSent?: boolean;
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

interface ExplainabilityChain {
  confidence: number; // 0-100, capped at 95%
  confidenceLevel: '🟢 High' | '🟡 Moderate' | '🟠 Low' | '🔴 Speculative';
  reasoning: string;
  evidenceCount: number;
  disclaimers: string[];
  alternatives?: string[];
}

interface ShadowAIResult {
  success: boolean;
  response: string;
  tier?: 'quick_round' | 'heavy_bag';
  profileTier?: 'bronze' | 'silver' | 'gold';
  modelUsed?: string;
  async?: boolean;
  jobId?: string;
  error?: string;
  explainability?: ExplainabilityChain;
}

function createMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `m-${crypto.randomUUID()}`;
  }
  return `m-${Date.now()}`;
}

interface ShadowJobStatusResult {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  output?: Record<string, unknown> | null;
  error?: string | null;
}

// Module-level: returns 'created' or 'draft' based on backend availability
async function postResearchRequirement(
  requirement: ReturnType<typeof deriveResearchRequirement>,
  apiBaseUrl: string,
): Promise<'created' | 'draft'> {
  if (!requirement) return 'draft';
  try {
    const res = await fetch(`${apiBaseUrl}/api/pilot/shadow/research-requirements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requirement),
    });
    return res.ok ? 'created' : 'draft';
  } catch {
    return 'draft';
  }
}

async function fetchLibraryClaim(
  mode: 'master' | 'scoped',
  subject: string,
  rawQuestion: string,
  apiBaseUrl: string,
): Promise<ShadowLibraryClaimApiResponse> {
  let scope: 'master' | 'subject' | 'scoped';

  if (mode === 'master') {
    scope = 'master';
  } else if (subject) {
    scope = 'subject';
  } else {
    scope = 'scoped';
  }

  const res = await fetch(`${apiBaseUrl}/api/pilot/shadow/library/claims`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, subject_id: subject || undefined, question: rawQuestion, limit: 5 }),
  });
  if (!res.ok) throw new Error('library claim request failed');
  return res.json() as Promise<ShadowLibraryClaimApiResponse>;
}

async function fetchShadowAI(rawQuestion: string, heavyBagMode: boolean, apiBaseUrl: string): Promise<ShadowAIResult> {
  const res = await fetch(`${apiBaseUrl}/api/pilot/shadow/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ message: rawQuestion, tier: heavyBagMode ? 'heavy_bag' : undefined }),
  });
  if (!res.ok) throw new Error(`SHADOW AI error: ${res.status}`);
  return res.json() as Promise<ShadowAIResult>;
}

async function fetchShadowJobStatus(jobId: string, apiBaseUrl: string): Promise<ShadowJobStatusResult | null> {
  const response = await fetch(`${apiBaseUrl}/api/pilot/shadow/jobs/${jobId}`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    return null;
  }

  return response.json() as Promise<ShadowJobStatusResult>;
}

async function submitFeedback(
  messageId: string,
  helpful: boolean,
  apiBaseUrl: string,
  topic?: string,
  sessionType?: string,
): Promise<void> {
  await fetch(`${apiBaseUrl}/api/pilot/shadow/feedback`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      helpful,
      message_id: messageId,
      topic: topic ?? 'general',
      session_type: sessionType ?? 'quick_round',
      outcome_signal: helpful ? 'thumbs_up' : 'thumbs_down',
    }),
  });
}

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

function buildHeading(mode: 'master' | 'scoped', subject: string) {
  if (mode === 'master') {
    return { heading: 'MASTER SHADOW', intro: 'Organizational intelligence, doctrine, and learning oversight.', scopeSummary: 'Master SHADOW for admin/organizational intelligence.' };
  }
  if (subject) {
    return { heading: `${subject.toUpperCase()} SHADOW`, intro: `Subject-specific learning scope for ${subject}.`, scopeSummary: `${subject} subject scope.` };
  }
  return { heading: 'SHADOW', intro: 'Scoped role-aware SHADOW conversation.', scopeSummary: 'Role-scoped SHADOW view.' };
}

function getModeHeadingLabel(mode: 'master' | 'scoped'): string {
  return mode === 'master' ? 'The Architect' : 'The Scout';
}

function getProfileTierLabel(profileTier?: ShadowMessage['profileTier']): string {
  if (!profileTier) {
    return '';
  }

  const tierEmojiMap: Record<string, string> = { bronze: '🥉', silver: '🥈', gold: '🥇' };
  const tierEmoji = tierEmojiMap[profileTier] || '🥇';
  const tierLabel = profileTier.charAt(0).toUpperCase() + profileTier.slice(1);
  return ` · Tier: ${tierEmoji} ${tierLabel}`;
}

function ShadowResearchReportsPanel(props: Readonly<{
  reports: ShadowResearchReport[];
  userRole: string;
}>): ReactElement | null {
  if (props.reports.length === 0) {
    return null;
  }

  return (
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
        {HEAVY_BAG_ELIGIBLE_ROLES.has(props.userRole) ? (
          <Link
            href="/shadow/scout"
            className="border-2 border-[#5a4a3a] bg-[#1f1f1f] px-3 py-2 text-[10px] font-mono uppercase tracking-[0.12em] text-[#b0a095] transition hover:border-[#8b4444] hover:text-[#e8d7c6]"
          >
            Scout Reports →
          </Link>
        ) : null}
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {props.reports.map((report) => (
          <article key={report.id} className="border border-[#5a4a3a] bg-[#0f0f0f] p-3">
            <p className="text-[10px] font-mono uppercase tracking-[0.12em] text-[#d4a574]">{report.status === 'created' ? 'Backend Filed' : 'Session Draft'}</p>
            <p className="mt-2 text-[12px] leading-5 text-[#e8d7c6]">{report.question}</p>
            <p className="mt-2 text-[11px] text-[#b0a095]">{report.researchRequirement}</p>
            <p className="mt-2 text-[11px] text-[#8a8a8a]">{report.createdAt}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function ShadowChatPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [userRole, setUserRole] = useState<string>(() => (typeof window !== 'undefined' ? readRoleSession()?.role ?? '' : ''));
  const [authChecked, setAuthChecked] = useState(false);
  const mode = searchParams.get('mode') === 'master' ? 'master' : 'scoped';
  const context = searchParams.get('context')?.trim() ?? '';
  const subject = searchParams.get('subject')?.trim() ?? '';
  const roleLabel = (searchParams.get('role')?.trim() || userRole || 'guest').toUpperCase();
  const { heading, intro, scopeSummary } = buildHeading(mode, subject);
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
    let cancelled = false;

    void (async () => {
      const localSession = readRoleSession();
      if (localSession?.role) {
        if (!cancelled) {
          setUserRole(localSession.role);
          setAuthChecked(true);
        }
        return;
      }

      try {
        const response = await fetch(`${apiBase()}/api/pilot/auth/session`, {
          method: 'POST',
          credentials: 'include',
        });

        if (!response.ok) {
          if (!cancelled) {
            setAuthChecked(true);
            router.replace('/login');
          }
          return;
        }

        const payload = (await response.json().catch(() => ({ authenticated: false }))) as {
          authenticated?: boolean;
          role?: string;
        };

        if (!payload.authenticated) {
          if (!cancelled) {
            setAuthChecked(true);
            router.replace('/login');
          }
          return;
        }

        if (!cancelled) {
          setUserRole(payload.role || '');
          setAuthChecked(true);
        }
      } catch {
        if (!cancelled) {
          setAuthChecked(true);
          router.replace('/login');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function addMessage(type: 'user' | 'shadow', text: string, meta?: Partial<Pick<ShadowMessage, 'id' | 'tier' | 'profileTier' | 'modelUsed' | 'isAsync' | 'jobId'>>) {
    const newMessage: ShadowMessage = {
      id: createMessageId(),
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
    return fetchLibraryClaim(mode, subject, rawQuestion, apiBase());
  }

  async function createResearchReport(rawQuestion: string, normalizedQuestion: string, reply: string) {
    const requirement = deriveResearchRequirement(mode, rawQuestion, normalizedQuestion, reply, context, subject);
    if (!requirement) return;
    const status = await postResearchRequirement(requirement, apiBase());
    prependResearchReport({ id: requirement.source_entity_id, question: rawQuestion, researchRequirement: requirement.research_requirement, knowledgeGap: requirement.knowledge_gap, status, createdAt: formatTimestamp() });
    const msg = status === 'created'
      ? 'Research requirement created and routed to the Research Intake lane.'
      : 'Research report draft captured in this session. Open Research Intake to submit manually.';
    addMessage('shadow', msg);
  }

  function sendFeedback(messageId: string, helpful: boolean, topic?: string, sessionType?: string) {
    setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, feedbackSent: true } : m));
    submitFeedback(messageId, helpful, apiBase(), topic, sessionType).catch(() => {});
  }

  async function callShadowAI(rawQuestion: string): Promise<void> {
    const data = await fetchShadowAI(rawQuestion, heavyBagMode, apiBase());
    const messageId = createMessageId();
    const text = data.async && data.jobId
      ? `Your Heavy Bag Session is queued. Job ID: ${data.jobId}`
      : (data.response || data.error || 'SHADOW encountered an error.');
    addMessage('shadow', text, {
      id: messageId,
      tier: data.async ? 'heavy_bag' : data.tier,
      profileTier: data.profileTier,
      modelUsed: data.modelUsed,
      isAsync: data.async,
      jobId: data.jobId,
    });

    if (data.async && data.jobId) {
      void pollQueuedShadowJob(data.jobId, messageId);
    }
  }

  async function pollQueuedShadowJob(jobId: string, messageId: string): Promise<void> {
    const maxAttempts = 30;
    const intervalMs = 2000;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const status = await fetchShadowJobStatus(jobId, apiBase());

      if (!status) {
        break;
      }

      if (status.status === 'completed') {
        const outputText = typeof status.output?.response === 'string'
          ? status.output.response
          : 'Heavy Bag Session completed. Open Scout Reports for detailed output.';
        setMessages((prev) => prev.map((msg) => (
          msg.id === messageId
            ? { ...msg, text: outputText, isAsync: false }
            : msg
        )));
        return;
      }

      if (status.status === 'failed' || status.status === 'cancelled') {
        setMessages((prev) => prev.map((msg) => (
          msg.id === messageId
            ? { ...msg, text: status.error || 'Heavy Bag Session failed. Please retry.', isAsync: false }
            : msg
        )));
        return;
      }

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, intervalMs);
      });
    }

    setMessages((prev) => prev.map((msg) => (
      msg.id === messageId
        ? { ...msg, text: `${msg.text}\n\nStill processing. Check Scout Reports for completion.`, isAsync: false }
        : msg
    )));
  }

  async function handleAIFallback(rawQuestion: string) {
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
      await handleAIFallback(rawQuestion);
    } finally {
      setIsLoading(false);
    }
  }

  if (!authChecked) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#0a0a0a] px-6 text-[#e8d7c6]">
        <div className="text-center">
          <p className="text-xs font-mono uppercase tracking-[0.35em] text-[#dc2626]">Secure Session</p>
          <h1 className="mt-3 font-display text-3xl tracking-tight">Opening SHADOW</h1>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6]">
      {/* HEADER */}
      <header className="border-b-4 border-[#8b4444] bg-[#1a1a1a] px-4 py-4 md:px-8 md:py-6">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-[#dc2626]">{getModeHeadingLabel(mode)}</p>
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

        <ShadowResearchReportsPanel reports={reports} userRole={userRole} />

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
                    <div className="mt-3 space-y-2 border-t border-[#5a4a3a] pt-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[9px] text-[#6a5a4a]">
                          {msg.tier === 'heavy_bag' ? '🥊 Heavy Bag' : '⚡ Quick Round'}
                          {getProfileTierLabel(msg.profileTier)}
                          {msg.isAsync ? ' · Processing...' : ''}
                        </p>
                        {!msg.feedbackSent ? (
                          <div className="flex gap-1">
                            <button
                              onClick={() => sendFeedback(msg.id, true, msg.tier, msg.tier)}
                              className="border border-[#3a2a2a] px-2 py-0.5 text-[9px] text-[#6a5a4a] hover:border-[#4a8a4a] hover:text-[#4a8a4a] transition"
                              title="Helpful"
                            >&#x1F44D;</button>
                            <button
                              onClick={() => sendFeedback(msg.id, false, msg.tier, msg.tier)}
                              className="border border-[#3a2a2a] px-2 py-0.5 text-[9px] text-[#6a5a4a] hover:border-[#dc2626] hover:text-[#dc2626] transition"
                              title="Not helpful"
                            >&#x1F44E;</button>
                          </div>
                        ) : (
                          <p className="text-[9px] text-[#4a5a4a] font-mono">✓ Feedback</p>
                        )}
                      </div>
                    </div>
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

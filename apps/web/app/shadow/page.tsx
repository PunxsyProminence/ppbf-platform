'use client';

import { Suspense, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { readRoleSession, clearRoleSession } from '@/components/roleSession';
import { apiBase } from '@/lib/apiBase';
import { revokeShadowSession } from '@/client/shadowLogout';
import {
  buildShadowChatRequest,
  listOwnedShadowSessions,
  loadOwnedShadowSessionMessages,
  mapStoredShadowMessage,
  ShadowSessionsRequestError,
  type OwnedShadowConversation,
} from '@/client/shadowSessions';
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
  feedbackEligible?: boolean;
  state?: ShadowResponseState;
}

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
  state: ShadowResponseState;
  response: string;
  messageId: string;
  conversationId?: string;
  tier?: 'quick_round' | 'heavy_bag';
  sessionType?: string;
  profileTier?: 'bronze' | 'silver' | 'gold';
  modelUsed?: string;
  async?: boolean;
  jobId?: string;
  error?: string;
  explainability?: ExplainabilityChain;
}

type ShadowResponseState = 'ok' | 'filtered' | 'degraded' | 'queued';

class ShadowApiError extends Error {
  constructor(
    readonly status: number,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'ShadowApiError';
  }
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
  safetyStatus: 'pending' | 'passed' | 'filtered' | 'not_applicable';
  output?: Record<string, unknown> | null;
  error?: string | null;
}

async function fetchShadowAI(
  rawQuestion: string,
  heavyBagMode: boolean,
  apiBaseUrl: string,
  conversationId?: string,
  athleteId?: string,
): Promise<ShadowAIResult> {
  const res = await fetch(`${apiBaseUrl}/api/pilot/shadow/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(buildShadowChatRequest({
      message: rawQuestion,
      heavyBagMode,
      conversationId,
      athleteId,
    })),
  });
  const payload = await res.json().catch(() => null) as ShadowAIResult | null;
  if (!res.ok) {
    throw new ShadowApiError(
      res.status,
      payload?.response || payload?.error || 'SHADOW could not process that request.',
    );
  }
  if (!payload?.state) {
    throw new ShadowApiError(502, 'SHADOW returned an invalid response. No guidance was displayed.');
  }
  return payload;
}

async function fetchShadowJobStatus(jobId: string, apiBaseUrl: string): Promise<ShadowJobStatusResult | null> {
  const response = await fetch(`${apiBaseUrl}/api/pilot/shadow/jobs/${jobId}`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ShadowApiError(response.status, 'Your session is no longer valid. Sign in again.');
    }
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
  const response = await fetch(`${apiBaseUrl}/api/pilot/shadow/feedback`, {
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
  if (!response.ok) {
    throw new ShadowApiError(response.status, 'Feedback was not saved. You can try again.');
  }
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

function ShadowChatPageContent() {
  const router = useRouter();
  const [userRole, setUserRole] = useState<string>(() => (typeof window !== 'undefined' ? readRoleSession()?.role ?? '' : ''));
  const [authChecked, setAuthChecked] = useState(false);
  const [capabilitiesLoaded, setCapabilitiesLoaded] = useState(false);
  const [mode, setMode] = useState<'master' | 'scoped'>('scoped');
  const context = '';
  const subject = '';
  const roleLabel = (userRole || 'guest').toUpperCase();
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
  const [allowedSessionTypes, setAllowedSessionTypes] = useState<string[]>(['quick_round']);
  const [conversationId, setConversationId] = useState<string>();
  const [conversationAthleteId, setConversationAthleteId] = useState<string>();
  const [savedSessions, setSavedSessions] = useState<OwnedShadowConversation[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [restoringSessionId, setRestoringSessionId] = useState<string>();
  const [sessionNotice, setSessionNotice] = useState<string>();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const restoreAbortRef = useRef<AbortController | null>(null);
  const restoreRequestIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const localSession = readRoleSession();
      if (localSession?.role) {
        if (!cancelled) {
          setUserRole(localSession.role);
        }
      }

      try {
        const response = await fetch(`${apiBase()}/api/pilot/auth/session`, {
          method: 'POST',
          credentials: 'include',
        });

        if (!response.ok) {
          if (!cancelled) {
            clearRoleSession();
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
            clearRoleSession();
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
          clearRoleSession();
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
    if (!authChecked) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/shadow/capabilities`, {
          credentials: 'include',
        });
        if (!response.ok) {
          if (!cancelled) {
            setMode('scoped');
            setMessages([{
              id: '0',
              type: 'shadow',
              text: buildWelcomeMessage('scoped', (userRole || 'guest').toUpperCase(), '', ''),
              timestamp: formatTimestamp(),
            }]);
            setCapabilitiesLoaded(true);
          }
          return;
        }
        const payload = await response.json() as {
          capabilities?: { allowedSessionTypes?: unknown; mode?: unknown };
        };
        const sessionTypes = Array.isArray(payload.capabilities?.allowedSessionTypes)
          ? payload.capabilities.allowedSessionTypes.filter(
            (value): value is string => typeof value === 'string',
          )
          : ['quick_round'];
        if (!cancelled) {
          const serverMode = payload.capabilities?.mode === 'master' ? 'master' : 'scoped';
          setMode(serverMode);
          setAllowedSessionTypes(sessionTypes);
          if (!sessionTypes.includes('heavy_bag')) setHeavyBagMode(false);
          setMessages([{
            id: '0',
            type: 'shadow',
            text: buildWelcomeMessage(serverMode, (userRole || 'guest').toUpperCase(), '', ''),
            timestamp: formatTimestamp(),
          }]);
          setCapabilitiesLoaded(true);
        }
      } catch {
        if (!cancelled) {
          setMode('scoped');
          setAllowedSessionTypes(['quick_round']);
          setHeavyBagMode(false);
          setMessages([{
            id: '0',
            type: 'shadow',
            text: buildWelcomeMessage('scoped', (userRole || 'guest').toUpperCase(), '', ''),
            timestamp: formatTimestamp(),
          }]);
          setCapabilitiesLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authChecked, userRole]);

  useEffect(() => {
    if (!capabilitiesLoaded) return;
    const controller = new AbortController();

    void listOwnedShadowSessions(apiBase(), controller.signal)
      .then((sessions) => {
        if (!controller.signal.aborted) {
          setSavedSessions(sessions);
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (
          error instanceof ShadowSessionsRequestError
          && (error.status === 401 || error.status === 403)
        ) {
          clearRoleSession();
          router.replace('/login');
          return;
        }
        setSessionNotice('Saved sessions are temporarily unavailable. You can still start a new chat.');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setSessionsLoading(false);
        }
      });

    return () => controller.abort();
  }, [capabilitiesLoaded, router]);

  useEffect(() => () => {
    restoreRequestIdRef.current += 1;
    restoreAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function addMessage(type: 'user' | 'shadow', text: string, meta?: Partial<Pick<ShadowMessage, 'id' | 'tier' | 'profileTier' | 'modelUsed' | 'isAsync' | 'jobId' | 'state' | 'feedbackEligible'>>) {
    const newMessage: ShadowMessage = {
      id: createMessageId(),
      type,
      text,
      timestamp: formatTimestamp(),
      ...meta,
    };
    setMessages((prev) => [...prev, newMessage]);
  }

  function welcomeMessage(): ShadowMessage {
    return {
      id: '0',
      type: 'shadow',
      text: buildWelcomeMessage(mode, roleLabel, context, subject),
      timestamp: formatTimestamp(),
    };
  }

  function handleNewChat() {
    restoreRequestIdRef.current += 1;
    restoreAbortRef.current?.abort();
    restoreAbortRef.current = null;
    setRestoringSessionId(undefined);
    setConversationId(undefined);
    setConversationAthleteId(undefined);
    setMessages([welcomeMessage()]);
    setHeavyBagMode(false);
    setUserInput('');
    setSessionNotice(undefined);
  }

  async function handleRestoreSession(session: OwnedShadowConversation): Promise<void> {
    if (isLoading) return;
    const requestId = restoreRequestIdRef.current + 1;
    restoreRequestIdRef.current = requestId;
    restoreAbortRef.current?.abort();
    const controller = new AbortController();
    restoreAbortRef.current = controller;
    setRestoringSessionId(session.conversationId);
    setSessionNotice(undefined);

    try {
      const storedMessages = await loadOwnedShadowSessionMessages(
        apiBase(),
        session.conversationId,
        controller.signal,
      );
      if (controller.signal.aborted || restoreRequestIdRef.current !== requestId) return;

      const restoredTier = session.sessionType === 'heavy_bag'
        ? 'heavy_bag'
        : session.sessionType === 'quick_round'
          ? 'quick_round'
          : undefined;
      const restoredMessages: ShadowMessage[] = storedMessages.map((storedMessage) => {
        const mapped = mapStoredShadowMessage(storedMessage);
        return {
          ...mapped,
          tier: mapped.type === 'shadow' ? restoredTier : undefined,
        };
      });

      setConversationId(session.conversationId);
      setConversationAthleteId(session.athleteId ?? undefined);
      setMessages(restoredMessages.length > 0 ? restoredMessages : [welcomeMessage()]);
      setHeavyBagMode(
        session.sessionType === 'heavy_bag'
        && allowedSessionTypes.includes('heavy_bag'),
      );
    } catch (error) {
      if (controller.signal.aborted || restoreRequestIdRef.current !== requestId) return;
      if (error instanceof ShadowSessionsRequestError) {
        if (error.status === 401 || error.status === 403) {
          clearRoleSession();
          router.replace('/login');
          return;
        }
        if (error.status === 404) {
          setSavedSessions((current) => current.filter(
            (item) => item.conversationId !== session.conversationId,
          ));
          if (conversationId === session.conversationId) {
            setConversationId(undefined);
            setConversationAthleteId(undefined);
            setMessages([welcomeMessage()]);
            setHeavyBagMode(false);
          }
          setSessionNotice('That saved session is no longer available.');
          return;
        }
      }
      setSessionNotice('SHADOW could not restore that session. Your current chat was left unchanged.');
    } finally {
      if (restoreRequestIdRef.current === requestId) {
        setRestoringSessionId(undefined);
        restoreAbortRef.current = null;
      }
    }
  }

  async function handleLogout() {
    try {
      await revokeShadowSession(apiBase());
    } finally {
      clearRoleSession();
      router.replace('/login');
    }
  }

  async function sendFeedback(messageId: string, helpful: boolean, topic?: string, sessionType?: string) {
    try {
      await submitFeedback(messageId, helpful, apiBase(), topic, sessionType);
      setMessages((prev) => prev.map((m) => (
        m.id === messageId ? { ...m, feedbackSent: true } : m
      )));
    } catch (feedbackError) {
      if (
        feedbackError instanceof ShadowApiError
        && (feedbackError.status === 401 || feedbackError.status === 403)
      ) {
        clearRoleSession();
        router.replace('/login');
      }
    }
  }

  async function callShadowAI(rawQuestion: string): Promise<void> {
    const data = await fetchShadowAI(
      rawQuestion,
      heavyBagMode,
      apiBase(),
      conversationId,
      conversationAthleteId,
    );
    if (data.conversationId) {
      setConversationId(data.conversationId);
      const now = new Date().toISOString();
      const persistedSessionType = data.sessionType
        ?? (heavyBagMode ? 'heavy_bag' : 'quick_round');
      setSavedSessions((current) => {
        const existing = current.find((item) => item.conversationId === data.conversationId);
        const session: OwnedShadowConversation = existing
          ? {
              ...existing,
              athleteId: conversationAthleteId ?? existing.athleteId,
              sessionType: persistedSessionType,
              updatedAt: now,
            }
          : {
              conversationId: data.conversationId as string,
              title: rawQuestion.replace(/\s+/g, ' ').trim().slice(0, 80) || 'New conversation',
              athleteId: conversationAthleteId ?? null,
              sessionType: persistedSessionType,
              createdAt: now,
              updatedAt: now,
            };
        return [
          session,
          ...current.filter((item) => item.conversationId !== data.conversationId),
        ];
      });
    }
    const messageId = data.messageId || createMessageId();
    const text = data.state === 'queued' && data.jobId
      ? `Your Heavy Bag Session is queued. Job ID: ${data.jobId}`
      : (data.response || data.error || 'SHADOW encountered an error.');
    addMessage('shadow', text, {
      id: messageId,
      tier: data.state === 'queued' ? 'heavy_bag' : data.tier,
      profileTier: data.profileTier,
      modelUsed: data.modelUsed,
      isAsync: data.state === 'queued',
      jobId: data.jobId,
      state: data.state,
      feedbackEligible: (
        data.state === 'ok' || data.state === 'filtered'
      ) && Boolean(data.conversationId) && Boolean(data.messageId),
    });

    if (data.state === 'queued' && data.jobId) {
      void pollQueuedShadowJob(data.jobId, messageId);
    }
  }

  async function pollQueuedShadowJob(jobId: string, messageId: string): Promise<void> {
    const maxAttempts = 30;
    const intervalMs = 2000;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let status: ShadowJobStatusResult | null;
      try {
        status = await fetchShadowJobStatus(jobId, apiBase());
      } catch (error) {
        if (error instanceof ShadowApiError && (error.status === 401 || error.status === 403)) {
          clearRoleSession();
          router.replace('/login');
        }
        setMessages((prev) => prev.map((msg) => (
          msg.id === messageId
            ? { ...msg, text: 'SHADOW could not verify the queued result. No generated guidance was displayed.', isAsync: false, state: 'degraded' }
            : msg
        )));
        return;
      }

      if (!status) {
        break;
      }

      if (status.status === 'completed') {
        const resultStatus = typeof status.output?.resultStatus === 'string'
          ? status.output.resultStatus
          : 'unavailable';
        const safeCompletion = status.safetyStatus === 'passed' && resultStatus === 'ok';
        setMessages((prev) => prev.map((msg) => (
          msg.id === messageId
            ? {
                ...msg,
                text: safeCompletion
                  ? 'Heavy Bag Session completed. Open Scout Reports to review the server-validated result.'
                  : 'SHADOW withheld or could not produce this queued result. No generated guidance was displayed.',
                isAsync: false,
                state: safeCompletion ? 'ok' : 'degraded',
                feedbackEligible: false,
              }
            : msg
        )));
        return;
      }

      if (status.status === 'failed' || status.status === 'cancelled') {
        setMessages((prev) => prev.map((msg) => (
          msg.id === messageId
            ? { ...msg, text: 'Heavy Bag Session failed. No generated guidance was displayed.', isAsync: false, state: 'degraded' }
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
        ? {
            ...msg,
            text: 'SHADOW could not confirm the queued result in time. No generated guidance was displayed.',
            isAsync: false,
            state: 'degraded',
          }
        : msg
    )));
  }

  function handleAIFallback(error: unknown) {
    if (error instanceof ShadowApiError) {
      if (error.status === 401 || error.status === 403) {
        clearRoleSession();
        router.replace('/login');
      }
      addMessage(
        'shadow',
        error.safeMessage,
        { state: error.status >= 500 ? 'degraded' : 'filtered' },
      );
      return;
    }

    addMessage(
      'shadow',
      'SHADOW could not reach the secure chat service. No generated or fallback guidance was displayed.',
      { state: 'degraded' },
    );
  }

  async function handleSendMessage(e: SyntheticEvent) {
    e.preventDefault();
    if (!userInput.trim() || isLoading || restoringSessionId) return;

    const rawQuestion = userInput.trim();
    addMessage('user', rawQuestion);
    setUserInput('');
    setIsLoading(true);

    try {
      await callShadowAI(rawQuestion);
    } catch (error) {
      handleAIFallback(error);
    } finally {
      setIsLoading(false);
    }
  }

  if (!authChecked || !capabilitiesLoaded) {
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

        <section
          aria-label="Saved SHADOW sessions"
          className="mb-4 border-2 border-[#5a4a3a] bg-[#111111] p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#d4a574]">
                Saved sessions
              </p>
              <p className="mt-1 text-xs text-[#8a8a8a]">
                Your server-stored conversation history. Chat content is not stored in this browser.
              </p>
            </div>
            <button
              type="button"
              onClick={handleNewChat}
              disabled={isLoading}
              className="border-2 border-[#8b4444] bg-[#2a1a1a] px-3 py-2 text-[10px] font-mono font-bold uppercase tracking-[0.12em] text-[#dc2626] transition hover:border-[#dc2626] disabled:opacity-50"
            >
              New chat
            </button>
          </div>

          {sessionNotice ? (
            <p role="status" className="mt-3 text-xs text-[#d4a574]">{sessionNotice}</p>
          ) : null}

          {sessionsLoading ? (
            <p className="mt-3 font-mono text-[10px] text-[#8a8a8a]">Loading saved sessions...</p>
          ) : savedSessions.length === 0 ? (
            <p className="mt-3 font-mono text-[10px] text-[#6a5a4a]">No saved sessions yet.</p>
          ) : (
            <div className="mt-3 grid max-h-40 gap-2 overflow-y-auto md:grid-cols-2">
              {savedSessions.map((session) => {
                const selected = conversationId === session.conversationId;
                const restoring = restoringSessionId === session.conversationId;
                return (
                  <button
                    key={session.conversationId}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => void handleRestoreSession(session)}
                    disabled={isLoading}
                    className={`border px-3 py-2 text-left transition disabled:opacity-50 ${
                      selected
                        ? 'border-[#dc2626] bg-[#2a1a1a]'
                        : 'border-[#3a3a3a] bg-[#171717] hover:border-[#8b4444]'
                    }`}
                  >
                    <span className="block truncate text-xs font-semibold text-[#cfbfae]">
                      {restoring ? 'Restoring…' : session.title}
                    </span>
                    <span className="mt-1 block font-mono text-[9px] uppercase tracking-[0.08em] text-[#6a5a4a]">
                      {session.sessionType.replaceAll('_', ' ')} · {new Date(session.updatedAt).toLocaleDateString()}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

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
                  {msg.type === 'shadow' && msg.state && msg.state !== 'ok' ? (
                    <p className="mt-2 text-[9px] font-bold uppercase tracking-[0.12em] text-[#d4a574]">
                      State: {msg.state}
                    </p>
                  ) : null}
                  {msg.tier ? (
                    <div className="mt-3 space-y-2 border-t border-[#5a4a3a] pt-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[9px] text-[#6a5a4a]">
                          {msg.tier === 'heavy_bag' ? '🥊 Heavy Bag' : '⚡ Quick Round'}
                          {getProfileTierLabel(msg.profileTier)}
                          {msg.isAsync ? ' · Processing...' : ''}
                        </p>
                        {msg.feedbackEligible
                          && (msg.state === 'ok' || msg.state === 'filtered')
                          && !msg.feedbackSent ? (
                          <div className="flex gap-1">
                            <button
                              onClick={() => void sendFeedback(msg.id, true, msg.tier, msg.tier)}
                              className="border border-[#3a2a2a] px-2 py-0.5 text-[9px] text-[#6a5a4a] hover:border-[#4a8a4a] hover:text-[#4a8a4a] transition"
                              title="Helpful"
                            >&#x1F44D;</button>
                            <button
                              onClick={() => void sendFeedback(msg.id, false, msg.tier, msg.tier)}
                              className="border border-[#3a2a2a] px-2 py-0.5 text-[9px] text-[#6a5a4a] hover:border-[#dc2626] hover:text-[#dc2626] transition"
                              title="Not helpful"
                            >&#x1F44E;</button>
                          </div>
                        ) : msg.feedbackSent ? (
                          <p className="text-[9px] text-[#4a5a4a] font-mono">✓ Feedback</p>
                        ) : null}
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
            {allowedSessionTypes.includes('heavy_bag') ? (
              <button
                type="button"
                onClick={() => setHeavyBagMode((v) => !v)}
                disabled={Boolean(restoringSessionId)}
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
              disabled={Boolean(restoringSessionId)}
              placeholder="What do you need to know?"
              className="flex-1 border-2 border-[#8b4444] bg-[#1a1a1a] px-4 py-3 text-sm text-[#e8d7c6] placeholder-[#6a5a4a] outline-none transition focus:border-[#dc2626] focus:bg-[#2a1a1a]"
            />
            <button
              type="submit"
              disabled={isLoading || Boolean(restoringSessionId)}
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

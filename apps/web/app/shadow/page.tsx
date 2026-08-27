'use client';

import { Suspense, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { readRoleSession, clearRoleSession } from '@/components/roleSession';
import RefusalStamp from '@/components/RefusalStamp';
import ShadowDisclosure from '@/components/ShadowDisclosure';
import ShadowFeedback from '@/components/ShadowFeedback';
import ShadowStructuredProse from '@/components/shadowStructuredProse';
import {
  EVIDENCE_TIER_MEANINGS,
  EVIDENCE_TIER_ORDER,
  type ShadowDisplayCitation,
} from '@/components/shadowEvidenceDisplay';
import { apiBase } from '@/lib/apiBase';
import { revokeShadowSession } from '@/client/shadowLogout';
import {
  buildShadowChatRequest,
  deleteOwnedShadowSession,
  listOwnedShadowSessions,
  loadOwnedShadowSessionMessages,
  mapStoredShadowMessage,
  normalizeShadowSessionTitle,
  renameOwnedShadowSession,
  ShadowSessionsRequestError,
  type OwnedShadowConversation,
} from '@/client/shadowSessions';
import { formatGymClock24, formatGymDateNumeric } from '@/src/lib/gymTime';

// How much verified evidence actually backed a response -- drives the
// message background darkness (bigger shadow = more evidenced). Independent
// of ShadowResponseState (ok/filtered/degraded/queued): a response can be
// state 'ok' and still be EXPERIMENTAL/RESEARCH_NEEDED if nothing concrete
// was cited.
type ShadowEvidenceTier = 'PROVEN' | 'EMERGING' | 'EXPERIMENTAL' | 'RESEARCH_NEEDED';

interface ShadowUnlockHint {
  featureKey: string;
  unlocked: boolean;
  progress: number;
  closeToUnlocking: boolean;
}

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
  evidenceTier?: ShadowEvidenceTier;
  evidenceNotice?: string;
  handoff?: string;
  citations?: ShadowDisplayCitation[];
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
  evidenceTier?: ShadowEvidenceTier;
  evidenceNotice?: string;
  handoff?: string;
  citations?: ShadowDisplayCitation[];
  unlockHints?: ShadowUnlockHint[];
}

// A response that never actually reached the server (network failure,
// timed-out job poll, etc.) has no real evidence to grade -- always render
// it as the flattest/least-shadowed tier rather than defaulting to blank.
const NO_SERVER_EVIDENCE_TIER: ShadowEvidenceTier = 'RESEARCH_NEEDED';

// Darkest (most evidenced) to lightest (least evidenced) -- "the bigger the
// shadow, the more authentic the message."
const EVIDENCE_TIER_STYLES: Record<ShadowEvidenceTier, string> = {
  PROVEN: 'border border-[color:var(--brass-800)] bg-[var(--hide-900)] text-[color:var(--bone-100)]',
  EMERGING: 'border border-[color:var(--brass-900)] bg-[var(--hide-800)] text-[color:var(--bone-200)]',
  EXPERIMENTAL: 'border border-[color:var(--brass-900)] bg-[var(--hide-700)] text-[color:var(--bone-300)]',
  RESEARCH_NEEDED: 'border border-[color:var(--brass-800)] bg-[var(--hide-600)] text-[color:var(--bone-300)]',
};

function getEvidenceTierLabel(tier: ShadowEvidenceTier): string {
  const labels: Record<ShadowEvidenceTier, string> = {
    PROVEN: 'Proven',
    EMERGING: 'Emerging',
    EXPERIMENTAL: 'Experimental',
    RESEARCH_NEEDED: 'Research Needed',
  };
  return labels[tier];
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

// Must stay aligned with requireRole on chat / sessions / jobs / feedback.
// A role outside this set can still pass the page-level auth check; the UI
// must not offer a live composer that can only 403 and used to force logout.
const SHADOW_CHAT_ROLES = new Set([
  'admin',
  'coach',
  'athlete',
  'parent',
  'organization_admin',
  'staff',
  'volunteer',
  'platform_owner',
]);

/**
 * Only 401 means the HttpOnly session is gone. A 403 is "not allowed for
 * this action/role", not "signed out". Treating them alike forced logout
 * mid-conversation (e.g. platform_owner thumbs-up before feedback parity).
 */
function isSessionDeathStatus(status: number): boolean {
  return status === 401;
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
  preferAsync = false,
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
      preferAsync,
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
    if (isSessionDeathStatus(response.status)) {
      throw new ShadowApiError(response.status, 'Your session is no longer valid. Sign in again.');
    }
    if (response.status === 403) {
      throw new ShadowApiError(response.status, 'SHADOW could not verify that job for this account.');
    }
    return null;
  }

  return response.json() as Promise<ShadowJobStatusResult>;
}

/**
 * `comment` is optional here because it is optional on the route: POST
 * /api/pilot/shadow/feedback requires `helpful` and a durable `message_id`,
 * and nothing else. The reason requirement this page used to enforce lived
 * only in the browser, so saying "yes, this helped" cost a paragraph of
 * writing that the answer did not need.
 *
 * `outcome_signal` is deliberately NOT sent. The route derives it from
 * `helpful` and the human review queue's SQL filters on that exact derived
 * vocabulary -- a client-supplied value outside it would strand the row as
 * permanently unapprovable.
 */
async function submitFeedback(
  messageId: string,
  helpful: boolean,
  comment: string | undefined,
  apiBaseUrl: string,
): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/api/pilot/shadow/feedback`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      helpful,
      message_id: messageId,
      ...(comment ? { comment } : {}),
    }),
  });
  if (!response.ok) {
    throw new ShadowApiError(response.status, 'Feedback was not saved. You can try again.');
  }
}

function formatTimestamp() {
  return formatGymClock24(new Date(), { seconds: true }) ?? '';
}

// Entry hints from the launching page's query string (ShadowChatButton sends
// ?context=...&subject=...). Display-only: they shape the heading, welcome
// line, and the "Context:" caption -- authorization never reads them, and the
// server-authoritative mode from the capabilities API is unaffected. Bounded
// and stripped of control characters because they render verbatim in headers.
function sanitizeEntryParam(value: string | null): string {
  if (!value) return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

// Omega is the cross-organization platform tier. It is deliberately not an
// alias for 'master': it reads operational signal across organizations but
// never organization-private athlete records, so it states that scope plainly
// rather than presenting as an organization admin with a wider reach.
type ShadowChatMode = 'omega' | 'master' | 'scoped';

// The room's voice is SHADOW OBSERVED / COACH DECIDES -- spare and exact. The
// welcome states the mode and its scope; it does not introduce itself in the
// first person or read out a menu of things to ask. The scope sentence is the
// same scopeSummary the header prints, so the two can never drift apart.
function buildWelcomeMessage(mode: ShadowChatMode, role: string, context: string, subject: string) {
  const { scopeSummary } = buildHeading(mode, subject);
  const opening = mode === 'omega'
    ? 'OMEGA ONLINE.'
    : mode === 'master'
      ? 'ARCHITECT ONLINE.'
      : subject
        ? 'SCOUT ONLINE.'
        : `SCOUT ONLINE FOR ${role || 'CURRENT ROLE'}.`;
  const base = `${opening} ${scopeSummary}`;
  return context ? `${base} Entered from ${context}.` : base;
}

function buildHeading(mode: ShadowChatMode, subject: string) {
  if (mode === 'omega') {
    return { heading: 'OMEGA', intro: 'Cross-organization operational and aggregate intelligence.', scopeSummary: 'Platform tier. No organization-private athlete records.' };
  }
  if (mode === 'master') {
    // The eyebrow above this h1 has always read "Architect" while the h1 read
    // "MASTER SHADOW" -- two names for one mode, and the second is the Master
    // vocabulary this room forbids. The mode label is the name.
    return { heading: 'ARCHITECT', intro: 'Organizational intelligence, doctrine, and learning oversight.', scopeSummary: 'Organizational layer. Doctrine, evidence gaps, and learning oversight.' };
  }
  if (subject) {
    return { heading: `${subject.toUpperCase()} SHADOW`, intro: `Subject-specific learning scope for ${subject}.`, scopeSummary: `Subject scope: ${subject}.` };
  }
  return { heading: 'SHADOW', intro: 'Scoped role-aware SHADOW conversation.', scopeSummary: 'Role-scoped view.' };
}

// Scout / Architect / Omega -- the three labels this room is allowed to show.
// No definite article, and never "Master".
function getModeHeadingLabel(mode: ShadowChatMode): string {
  if (mode === 'omega') return 'Omega';
  return mode === 'master' ? 'Architect' : 'Scout';
}

function getProfileTierLabel(profileTier?: ShadowMessage['profileTier']): string {
  if (!profileTier) {
    return '';
  }

  // Law 3: the tier is carried by its uppercase word, not by a medal emoji
  // that vanishes in greyscale packets and screen readers alike.
  const tierLabel = profileTier.charAt(0).toUpperCase() + profileTier.slice(1);
  return ` · Tier: ${tierLabel}`;
}

function ShadowChatPageContent() {
  const router = useRouter();
  const [userRole, setUserRole] = useState<string>(() => (typeof window !== 'undefined' ? readRoleSession()?.role ?? '' : ''));
  const [authChecked, setAuthChecked] = useState(false);
  const [chatRoleAllowed, setChatRoleAllowed] = useState(true);
  const [capabilitiesLoaded, setCapabilitiesLoaded] = useState(false);
  const [mode, setMode] = useState<ShadowChatMode>('scoped');
  // These were hardcoded '' for the page's whole life, which made the
  // subject-scoped heading, welcome text, and Context caption unreachable
  // from all 17 launch points that send them (the Suspense wrapper below
  // existed for exactly this useSearchParams call and was never used).
  const entryParams = useSearchParams();
  const context = sanitizeEntryParam(entryParams.get('context'));
  const subject = sanitizeEntryParam(entryParams.get('subject'));
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
  const [backgroundHeavyBag, setBackgroundHeavyBag] = useState(false);
  const [allowedSessionTypes, setAllowedSessionTypes] = useState<string[]>(['quick_round']);
  const [conversationId, setConversationId] = useState<string>();
  const [conversationAthleteId, setConversationAthleteId] = useState<string>();
  const [unlockHints, setUnlockHints] = useState<ShadowUnlockHint[]>([]);
  const [modelStatus, setModelStatus] = useState<Record<string, { displayName: string; available: boolean; tier: string }>>({});
  const [savedSessions, setSavedSessions] = useState<OwnedShadowConversation[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [restoringSessionId, setRestoringSessionId] = useState<string>();
  const [sessionNotice, setSessionNotice] = useState<string>();
  const [renamingSessionId, setRenamingSessionId] = useState<string>();
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();
  const [sessionActionBusyId, setSessionActionBusyId] = useState<string>();
  const [feedbackSubmitting, setFeedbackSubmitting] = useState<Record<string, boolean>>({});
  const [feedbackErrors, setFeedbackErrors] = useState<Record<string, string>>({});
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
          const role = payload.role || '';
          setUserRole(role);
          // Do not force logout for an authenticated but non-chat role (e.g. board).
          // Show a static denial instead of a composer that can only 403.
          setChatRoleAllowed(!role || SHADOW_CHAT_ROLES.has(role));
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

  /* chatRoleAllowed, not just authChecked: the capabilities endpoint answers
     with the names of this platform's authority model -- crossOrganizationRead,
     canAccessProtectedHealthInformation, canReviewChatSafetyTelemetry, and the
     tier in `mode`. A denied role is shown none of it (the refusal below
     returns before any of this renders) but was still SENT all of it, on a
     request this page made on its behalf. The route now refuses that role too;
     this stops the page asking on the one path where the answer can only be a
     refusal. */
  useEffect(() => {
    if (!authChecked || !chatRoleAllowed) return;
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
              text: buildWelcomeMessage('scoped', (userRole || 'guest').toUpperCase(), context, subject),
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
          // Omega must be recognized explicitly. Falling through to 'scoped'
          // would silently strip the platform tier of affordances it holds.
          const rawMode = payload.capabilities?.mode;
          const serverMode: ShadowChatMode = rawMode === 'omega'
            ? 'omega'
            : rawMode === 'master'
              ? 'master'
              : 'scoped';
          setMode(serverMode);
          setAllowedSessionTypes(sessionTypes);
          if (!sessionTypes.includes('heavy_bag')) setHeavyBagMode(false);
          setMessages([{
            id: '0',
            type: 'shadow',
            text: buildWelcomeMessage(serverMode, (userRole || 'guest').toUpperCase(), context, subject),
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
  }, [authChecked, chatRoleAllowed, userRole, context, subject]);

  useEffect(() => {
    if (!capabilitiesLoaded || !allowedSessionTypes.includes('heavy_bag')) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/shadow/models`, { credentials: 'include' });
        if (!response.ok) return;
        const payload = await response.json() as {
          models?: Record<string, { displayName: string; available: boolean; tier: string }>;
        };
        if (!cancelled && payload.models) {
          setModelStatus(payload.models);
        }
      } catch {
        // Model status is purely informational -- a failed fetch just means
        // the panel stays empty, nothing else in the page depends on it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [capabilitiesLoaded, allowedSessionTypes]);

  /* Same reason as the effect above, and belt-and-braces with it: capabilities
     never load on the deny path now, so this could not fire anyway -- but a
     refusal screen must not depend on an upstream flag staying false to keep
     from listing somebody's conversations. */
  useEffect(() => {
    if (!capabilitiesLoaded || !chatRoleAllowed) return;
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
          && isSessionDeathStatus(error.status)
        ) {
          clearRoleSession();
          router.replace('/login');
          return;
        }
        setSessionNotice(
          error instanceof ShadowSessionsRequestError && error.status === 403
            ? 'Saved sessions are not available for this role. You can still try a new chat if your role is allowed.'
            : 'Saved sessions are temporarily unavailable. You can still start a new chat.',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setSessionsLoading(false);
        }
      });

    return () => controller.abort();
  }, [capabilitiesLoaded, chatRoleAllowed, router]);

  useEffect(() => () => {
    restoreRequestIdRef.current += 1;
    restoreAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function addMessage(type: 'user' | 'shadow', text: string, meta?: Partial<Pick<ShadowMessage, 'id' | 'tier' | 'profileTier' | 'modelUsed' | 'isAsync' | 'jobId' | 'state' | 'feedbackEligible' | 'evidenceTier' | 'evidenceNotice' | 'handoff' | 'citations'>>) {
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
          // evidenceTier and handoff come from the stored row, so a reopened
          // conversation shows the grade the answer was given and keeps its
          // "Human Handoff Required" banner.
          evidenceTier: mapped.type === 'shadow' ? mapped.evidenceTier : undefined,
          handoff: mapped.type === 'shadow' ? mapped.handoff : undefined,
          citations: mapped.type === 'shadow' ? mapped.citations : undefined,
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
        if (isSessionDeathStatus(error.status)) {
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
        if (error.status === 403) {
          setSessionNotice('That session cannot be opened for this account. Your current chat was left unchanged.');
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

  // Shared failure handling for rename and delete. A 404 means the session is
  // already gone server-side, and the honest reaction is the same one the
  // restore path takes: drop it from the list (and detach the live chat if it
  // was the active conversation) rather than leave a card that can only fail.
  function handleSessionActionError(error: unknown, session: OwnedShadowConversation, fallback: string) {
    if (error instanceof ShadowSessionsRequestError) {
      if (isSessionDeathStatus(error.status)) {
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
      setSessionNotice(error.message);
      return;
    }
    setSessionNotice(fallback);
  }

  function beginRenameSession(session: OwnedShadowConversation) {
    setConfirmDeleteId(undefined);
    setRenamingSessionId(session.conversationId);
    setRenameDraft(session.title);
  }

  async function commitRenameSession(session: OwnedShadowConversation) {
    const normalizedTitle = normalizeShadowSessionTitle(renameDraft);
    if (!normalizedTitle || sessionActionBusyId) return;
    if (normalizedTitle === session.title) {
      setRenamingSessionId(undefined);
      return;
    }
    setSessionActionBusyId(session.conversationId);
    try {
      await renameOwnedShadowSession(apiBase(), session.conversationId, normalizedTitle);
      setSavedSessions((current) => current.map((item) => (
        item.conversationId === session.conversationId
          ? { ...item, title: normalizedTitle, updatedAt: new Date().toISOString() }
          : item
      )));
      setRenamingSessionId(undefined);
      setSessionNotice(undefined);
    } catch (error) {
      handleSessionActionError(error, session, 'SHADOW could not rename that session.');
    } finally {
      setSessionActionBusyId(undefined);
    }
  }

  async function handleDeleteSession(session: OwnedShadowConversation) {
    // First click arms the confirmation; only the second click deletes.
    if (confirmDeleteId !== session.conversationId) {
      setConfirmDeleteId(session.conversationId);
      setRenamingSessionId(undefined);
      return;
    }
    if (sessionActionBusyId) return;
    setSessionActionBusyId(session.conversationId);
    try {
      await deleteOwnedShadowSession(apiBase(), session.conversationId);
      setSavedSessions((current) => current.filter(
        (item) => item.conversationId !== session.conversationId,
      ));
      if (conversationId === session.conversationId) {
        // The active conversation was just deleted; without this, the next
        // send would 404 against the id we deleted ourselves.
        setConversationId(undefined);
        setConversationAthleteId(undefined);
        setMessages([welcomeMessage()]);
        setHeavyBagMode(false);
      }
      setSessionNotice(`Deleted "${session.title}".`);
    } catch (error) {
      handleSessionActionError(error, session, 'SHADOW could not delete that session.');
    } finally {
      setConfirmDeleteId(undefined);
      setSessionActionBusyId(undefined);
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

  async function sendFeedback(messageId: string, helpful: boolean, comment?: string) {
    setFeedbackSubmitting((prev) => ({ ...prev, [messageId]: true }));
    setFeedbackErrors((prev) => {
      if (!prev[messageId]) return prev;
      const next = { ...prev };
      delete next[messageId];
      return next;
    });
    try {
      await submitFeedback(messageId, helpful, comment, apiBase());
      setMessages((prev) => prev.map((m) => (
        m.id === messageId ? { ...m, feedbackSent: true } : m
      )));
    } catch (feedbackError) {
      // Only 401 means the session is actually gone. Treating 403 the same way
      // logged a user out mid-conversation over a rating -- any role the chat
      // route admits but the feedback route did not would be ejected to /login
      // by a thumbs-up. A 403 here means "not allowed to rate", not "not
      // signed in", and it should never cost the user their conversation.
      if (feedbackError instanceof ShadowApiError && isSessionDeathStatus(feedbackError.status)) {
        clearRoleSession();
        router.replace('/login');
        return;
      }
      // Everything else was previously swallowed: the thumb stayed unset with
      // no explanation, so the natural response was to click again and spend
      // more of the 30/min feedback budget on a request that could not succeed.
      // The message belongs AT the rating that failed -- it used to go to the
      // session notice above the saved-sessions list, several hundred pixels
      // and one scroll away from the button that had just done nothing.
      setFeedbackErrors((prev) => ({
        ...prev,
        [messageId]: feedbackError instanceof ShadowApiError && feedbackError.status === 429
          ? 'Too much feedback too quickly. Wait a moment and try again.'
          : 'SHADOW could not record that feedback. Your conversation is unaffected.',
      }));
    } finally {
      setFeedbackSubmitting((prev) => ({ ...prev, [messageId]: false }));
    }
  }

  async function callShadowAI(rawQuestion: string): Promise<void> {
    const data = await fetchShadowAI(
      rawQuestion,
      heavyBagMode,
      apiBase(),
      conversationId,
      conversationAthleteId,
      heavyBagMode && backgroundHeavyBag,
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
      evidenceTier: data.evidenceTier ?? NO_SERVER_EVIDENCE_TIER,
      evidenceNotice: data.evidenceNotice,
      handoff: data.handoff,
      // The server has always computed and returned these; the client dropped
      // them on the floor, so evidence-backed answers showed no receipts.
      citations: data.citations,
      feedbackEligible: (
        data.state === 'ok' || data.state === 'filtered'
      ) && Boolean(data.conversationId) && Boolean(data.messageId),
    });

    if (data.unlockHints?.length) {
      setUnlockHints(data.unlockHints);
    }

    if (data.state === 'queued' && data.jobId) {
      void pollQueuedShadowJob(data.jobId, messageId);
    }
  }

  async function pollQueuedShadowJob(jobId: string, messageId: string): Promise<void> {
    // The old window was 30 x 2s = 60 seconds -- shorter than the operation
    // it bounded: the worker's first claim can take up to its full tick
    // interval (default 30s), and generation itself measures 33-95s. Most
    // real jobs finished AFTER the poll had already told the user "no
    // generated guidance was displayed", which was false. Fast phase for the
    // quick outcomes, then a slow phase that comfortably covers tick + P95
    // generation (~8.5 minutes total).
    const phases = [
      { attempts: 30, intervalMs: 2_000 },
      { attempts: 45, intervalMs: 10_000 },
    ];
    const schedule = phases.flatMap((phase) => Array<number>(phase.attempts).fill(phase.intervalMs));

    for (const delayMs of schedule) {
      let status: ShadowJobStatusResult | null;
      try {
        status = await fetchShadowJobStatus(jobId, apiBase());
      } catch (error) {
        if (error instanceof ShadowApiError && isSessionDeathStatus(error.status)) {
          clearRoleSession();
          router.replace('/login');
          return;
        }
        setMessages((prev) => prev.map((msg) => (
          msg.id === messageId
            ? { ...msg, text: 'SHADOW could not verify the queued result. No generated guidance was displayed.', isAsync: false, state: 'degraded', evidenceTier: NO_SERVER_EVIDENCE_TIER }
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
        // A conversation-bound Heavy Bag completion carries the validated
        // answer, its grade, and the citations the server persisted; showing
        // anything else here would diverge from what restore will replay.
        const output = (status.output ?? {}) as Record<string, unknown>;
        const outputResponse = typeof output.response === 'string' && output.response.trim()
          ? output.response
          : null;
        const outputTier = output.evidenceTier;
        const gradedTier = outputTier === 'PROVEN' || outputTier === 'EMERGING'
          || outputTier === 'EXPERIMENTAL' || outputTier === 'RESEARCH_NEEDED'
          ? outputTier
          : NO_SERVER_EVIDENCE_TIER;
        const outputCitations = Array.isArray(output.citations)
          ? (output.citations as Array<Record<string, unknown>>)
              .filter((entry) => typeof entry.evidenceId === 'string'
                && typeof entry.token === 'string'
                && typeof entry.sourceTitle === 'string'
                && typeof entry.documentName === 'string')
              .map((entry) => ({
                evidenceId: entry.evidenceId as string,
                token: entry.token as string,
                sourceTitle: entry.sourceTitle as string,
                documentName: entry.documentName as string,
              }))
          : [];
        // The completion carries the persisted assistant message's server id.
        // Adopting it makes this bubble identical to a restored message --
        // including feedback eligibility, which keys on the server id.
        const serverMessageId = typeof output.assistantMessageId === 'string' && output.assistantMessageId
          ? output.assistantMessageId
          : null;
        setMessages((prev) => prev.map((msg) => (
          msg.id === messageId
            ? {
                ...msg,
                id: safeCompletion && serverMessageId ? serverMessageId : msg.id,
                text: safeCompletion
                  ? (outputResponse
                    ?? 'Heavy Bag Session completed. Open Scout Reports to review the server-validated result.')
                  : 'SHADOW withheld or could not produce this queued result. No generated guidance was displayed.',
                isAsync: false,
                state: safeCompletion ? 'ok' : 'degraded',
                evidenceTier: safeCompletion && outputResponse ? gradedTier : NO_SERVER_EVIDENCE_TIER,
                citations: safeCompletion && outputCitations.length > 0 ? outputCitations : undefined,
                feedbackEligible: Boolean(safeCompletion && serverMessageId && outputResponse),
              }
            : msg
        )));
        return;
      }

      if (status.status === 'failed' || status.status === 'cancelled') {
        setMessages((prev) => prev.map((msg) => (
          msg.id === messageId
            ? { ...msg, text: 'Heavy Bag Session failed. No generated guidance was displayed.', isAsync: false, state: 'degraded', evidenceTier: NO_SERVER_EVIDENCE_TIER }
            : msg
        )));
        return;
      }

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, delayMs);
      });
    }

    setMessages((prev) => prev.map((msg) => (
      msg.id === messageId
        ? {
            ...msg,
            // Truthful timeout: the JOB is not known to have failed -- this
            // page just stopped watching. For Heavy Bag the completed answer
            // is appended to this conversation server-side regardless, so
            // the message says where it will appear instead of implying the
            // work was lost.
            text: 'Still processing. This page stopped checking, but the job continues -- a Heavy Bag answer will be added to this conversation when it completes (reopen the session to see it), and reports appear under Scout Reports.',
            isAsync: false,
            state: 'queued',
            evidenceTier: NO_SERVER_EVIDENCE_TIER,
          }
        : msg
    )));
  }

  function handleAIFallback(error: unknown) {
    if (error instanceof ShadowApiError) {
      // Only a missing session ends the chat. A 403 (role/scope denial) must
      // stay in-conversation -- same policy as sendFeedback after the
      // platform_owner thumbs-up fix.
      if (isSessionDeathStatus(error.status)) {
        clearRoleSession();
        router.replace('/login');
        return;
      }
      if (error.status === 404 && conversationId) {
        // The server no longer has this conversation, so the id is dead --
        // kept, it re-404s every later send and the chat is wedged for good.
        // The restore path already recovers from exactly this state; this is
        // the same recovery on the send path. The transcript stays: what is
        // on screen really was said, only the server-side continuation is
        // gone, and the next message starts a fresh conversation.
        const deadConversationId = conversationId;
        setSavedSessions((current) => current.filter(
          (item) => item.conversationId !== deadConversationId,
        ));
        setConversationId(undefined);
        setConversationAthleteId(undefined);
        addMessage(
          'shadow',
          'This conversation no longer exists on the server, so it cannot be continued. Your next message starts a new conversation.',
          { state: 'filtered', evidenceTier: NO_SERVER_EVIDENCE_TIER },
        );
        return;
      }
      addMessage(
        'shadow',
        error.safeMessage,
        { state: error.status >= 500 ? 'degraded' : 'filtered', evidenceTier: NO_SERVER_EVIDENCE_TIER },
      );
      return;
    }

    addMessage(
      'shadow',
      'SHADOW could not reach the secure chat service. No generated or fallback guidance was displayed.',
      { state: 'degraded', evidenceTier: NO_SERVER_EVIDENCE_TIER },
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

  // Role denial does not need capabilities; show it as soon as auth is known.
  if (authChecked && !chatRoleAllowed) {
    return (
      <main className="room room--night min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-300)]">
        <div className="mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center gap-6 border border-[color:var(--brass-900)] px-6">
          <div className="text-center">
            <p className="t-eyebrow">SHADOW</p>
            <RefusalStamp
              kind="wrong_door"
              detail={`your signed-in role (${userRole || 'unknown'}) cannot use SHADOW chat`}
              className="mt-[var(--s3)]"
            />
            <p className="t-muted mt-[var(--s4)] max-w-md">
              You are still signed in — return to your dashboard or sign out.
            </p>
          </div>
          {/* The two ways out of a denial, on the design system's own control
              rather than a hand-rolled one. The pair used to carry identical
              one-off classes with no height on either, and the two did NOT come
              out the same size: globals.css floors `button` at 44px in @layer
              base and deliberately exempts `a`, so Logout landed at 44px and
              Dashboard at roughly 30 -- two controls that read as a pair,
              built as a pair, rendering as a mismatched pair, on a screen whose
              entire content is a refusal and these two links. .btn--ghost is
              the quiet variant this ground already uses everywhere else, and
              .btn carries the 44px and the stencil voice for both. */}
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link href="/dashboard" className="btn btn--ghost">
              Dashboard
            </Link>
            <button type="button" onClick={handleLogout} className="btn btn--ghost">
              Logout
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (!authChecked || !capabilitiesLoaded) {
    return (
      <main className="room room--night min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-300)]">
        <div className="mx-auto flex min-h-screen max-w-5xl items-center justify-center border border-[color:var(--brass-900)] rounded-none px-6">
          <div className="text-center">
            <p className="t-eyebrow">Secure Session</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-lg)' }}>Opening SHADOW</h1>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="room room--night min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-300)]">
      <header className="border-b border-[color:var(--brass-900)]">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-5">
          <div>
            <p className="t-eyebrow">{getModeHeadingLabel(mode)}</p>
            <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-xl)' }}>{heading}</h1>
            <p className="t-muted mt-[var(--s2)]">{intro}</p>
          </div>
          {/* No local Logout. The signed-in chrome already carries one, and
              revokeShadowSession posts the same /api/pilot/auth/logout the
              global control does -- so this button was a second door to the
              same room, two tab stops apart, on the surface where a mis-click
              costs an in-progress conversation. The refusal screen below keeps
              its own Logout: the global bar suppresses itself there, so that
              one is the only way out. */}
          <div className="flex flex-wrap items-center gap-[var(--s4)] text-right">
            <div>
              <p className="t-label">Role: {roleLabel}</p>
              {context ? <p className="t-label mt-[var(--s1)]">Context: {context}</p> : null}
              <p className="t-data mt-[var(--s2)] uppercase tracking-[0.12em] text-[color:var(--bone-300)]">LIVE</p>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-5xl px-6 py-6">
        <section className="mat-leather mb-[var(--s4)] grid gap-[var(--s4)] rounded-[var(--r-lg)] p-[var(--s5)] md:grid-cols-3">
          <div>
            <p className="t-eyebrow">Scope</p>
            <p className="t-body mt-[var(--s2)]">{scopeSummary}</p>
          </div>
          <div>
            <p className="t-eyebrow">Authority Boundary</p>
            <p className="t-body mt-[var(--s2)]">SHADOW can improve learning and generate research. SHADOW cannot clear, diagnose, prescribe, or override human authority.</p>
          </div>
          <div>
            <p className="t-eyebrow">When Evidence Is Weak</p>
            <p className="t-body mt-[var(--s2)]">Use The Library and Research Intake. Unknowns should become research requirements, not fake certainty.</p>
          </div>
        </section>

        {unlockHints.some((hint) => hint.closeToUnlocking) ? (
          <section
            aria-label="SHADOW features close to unlocking"
            className="mat-leather mb-[var(--s4)] rounded-[var(--r-lg)] p-[var(--s5)]"
          >
            <p className="t-eyebrow">
              {unlockHints.filter((hint) => hint.closeToUnlocking).length} feature
              {unlockHints.filter((hint) => hint.closeToUnlocking).length === 1 ? '' : 's'} close to unlocking
            </p>
          </section>
        ) : null}

        <section
          aria-label="Saved SHADOW sessions"
          className="mat-leather mb-[var(--s4)] rounded-[var(--r-lg)] p-[var(--s5)]"
        >
          <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
            <div>
              <p className="t-eyebrow">Saved sessions</p>
              <p className="t-muted mt-[var(--s2)]">
                Your server-stored conversation history. Chat content is not stored in this browser.
              </p>
            </div>
            <button
              type="button"
              onClick={handleNewChat}
              disabled={isLoading}
              className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
            >
              New chat
            </button>
          </div>

          {sessionNotice ? (
            <p role="status" className="t-body mt-[var(--s3)]">{sessionNotice}</p>
          ) : null}

          {sessionsLoading ? (
            <p className="t-muted mt-[var(--s3)]">Loading saved sessions...</p>
          ) : savedSessions.length === 0 ? (
            <p className="t-muted mt-[var(--s3)]">No saved sessions yet.</p>
          ) : (
            <div className="mt-[var(--s3)] grid max-h-[233px] gap-[var(--s3)] overflow-y-auto md:grid-cols-2">
              {savedSessions.map((session) => {
                const selected = conversationId === session.conversationId;
                const restoring = restoringSessionId === session.conversationId;
                const renaming = renamingSessionId === session.conversationId;
                const armedDelete = confirmDeleteId === session.conversationId;
                const busy = sessionActionBusyId === session.conversationId;
                return (
                  <div
                    key={session.conversationId}
                    className={`mat-leather--raised rounded-[var(--r-md)] border transition ${
                      selected
                        ? 'border-[color:var(--brass-700)]'
                        : 'border-[color:var(--brass-900)] hover:border-[color:var(--brass-800)]'
                    }`}
                  >
                    {renaming ? (
                      <form
                        className="p-[var(--s3)]"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void commitRenameSession(session);
                        }}
                      >
                        <label className="sr-only" htmlFor={`rename-${session.conversationId}`}>
                          New name for {session.title}
                        </label>
                        <input
                          id={`rename-${session.conversationId}`}
                          value={renameDraft}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          maxLength={120}
                          autoFocus
                          disabled={busy}
                          className="input"
                        />
                        <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
                          <button
                            type="submit"
                            disabled={busy || !renameDraft.trim()}
                            className="btn disabled:opacity-50"
                          >
                            {busy ? 'Saving…' : 'Save'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setRenamingSessionId(undefined)}
                            disabled={busy}
                            className="btn btn--ghost disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <button
                          type="button"
                          aria-pressed={selected}
                          onClick={() => void handleRestoreSession(session)}
                          disabled={isLoading || busy}
                          className="w-full p-[var(--s3)] text-left disabled:opacity-50"
                        >
                          {/* Not .t-command: a session title is the user's own
                              sentence, and the stencil voice uppercases it. */}
                          <span className="t-body block truncate font-semibold text-[color:var(--bone-100)]">
                            {restoring ? 'Restoring…' : session.title}
                          </span>
                          <span className="t-label mt-[var(--s1)] block">
                            {session.sessionType.replaceAll('_', ' ')} · {formatGymDateNumeric(session.updatedAt)}
                          </span>
                        </button>
                        <div className="flex flex-wrap items-center gap-[var(--s3)] border-t border-[color:var(--brass-900)] p-[var(--s3)]">
                          <button
                            type="button"
                            onClick={() => beginRenameSession(session)}
                            disabled={busy || isLoading}
                            className="btn btn--ghost disabled:opacity-50"
                          >
                            Rename
                          </button>
                          {/* Armed delete keeps --restricted, not --locked or
                              .btn--danger: losing your own saved chat is not a
                              child in danger. Same amber the rest of this room
                              uses for "weigh this", on the system's control. */}
                          <button
                            type="button"
                            onClick={() => void handleDeleteSession(session)}
                            disabled={busy || isLoading}
                            className={`btn btn--ghost disabled:opacity-50 ${
                              armedDelete
                                ? 'border-[color:var(--restricted)] text-[color:var(--restricted-ink)]'
                                : ''
                            }`}
                          >
                            {busy && armedDelete ? 'Deleting…' : armedDelete ? 'Confirm delete' : 'Delete'}
                          </button>
                          {armedDelete && !busy ? (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(undefined)}
                              className="btn btn--ghost"
                            >
                              Keep
                            </button>
                          ) : null}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <ShadowDisclosure
            label="What the evidence labels mean"
            className="mat-leather--raised mb-[var(--s3)] rounded-[var(--r-md)] px-[var(--s3)]"
          >
            <ul className="mt-[var(--s2)] space-y-[var(--s1)]">
              {EVIDENCE_TIER_ORDER.map((tier) => (
                <li key={tier} className="t-muted">
                  <span className="t-label">{getEvidenceTierLabel(tier)}:</span>{' '}
                  {EVIDENCE_TIER_MEANINGS[tier]}
                </li>
              ))}
            </ul>
          </ShadowDisclosure>
          {/* The transcript is a log, and it was a bare scrolling <div>: a
              screen reader was told nothing when an answer arrived, and a
              keyboard user could not scroll it at all because nothing in it
              could hold focus. role="log" with additions-only politeness is
              the pattern research/chat already uses. */}
          <div
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-label="SHADOW conversation"
            tabIndex={0}
            className="mb-[var(--s5)] max-h-[550px] space-y-[var(--s4)] overflow-y-auto pr-[var(--s2)]"
          >
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex gap-3 ${msg.type === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] border px-4 py-3 transition-colors ${
                    msg.type === 'user'
                      ? 'border-[color:var(--brass-700)] bg-[var(--hide-700)] text-[color:var(--bone-100)]'
                      : `border-[color:var(--brass-900)] bg-[var(--hide-900)] text-[color:var(--bone-300)] ${EVIDENCE_TIER_STYLES[msg.evidenceTier ?? NO_SERVER_EVIDENCE_TIER]}`
                  }`}
                >
                  {/* THE ANSWER FIRST, AND AT A SIZE MEANT FOR READING.
                      `.t-body` is 14px: right for a caption in a table, wrong
                      for four paragraphs of coaching guidance read on a phone
                      in a gym. 16px/1.6 capped near 66 characters is the
                      running-text setting, and the answer is rendered as real
                      paragraphs and lists rather than one wall of text --
                      through React text nodes only, never HTML, so nothing a
                      model emits can become markup. */}
                  {msg.type === 'shadow' ? (
                    <ShadowStructuredProse
                      text={msg.text}
                      className="max-w-[66ch] space-y-[var(--s3)] text-[16px] leading-[1.6]"
                    />
                  ) : (
                    <p className="max-w-[66ch] text-[16px] leading-[1.6]">{msg.text}</p>
                  )}
                  {msg.type === 'shadow' && msg.evidenceTier ? (
                    <p
                      className="t-label mt-[var(--s3)]"
                      title={EVIDENCE_TIER_MEANINGS[msg.evidenceTier]}
                    >
                      Evidence: {getEvidenceTierLabel(msg.evidenceTier)}
                    </p>
                  ) : null}
                  {msg.type === 'shadow' && msg.evidenceNotice === 'EVIDENCE_RETRIEVAL_UNAVAILABLE' ? (
                    <p className="t-label mt-[var(--s1)]">
                      Evidence lookup temporarily unavailable -- graded without it.
                    </p>
                  ) : null}
                  {/* Said in a sentence, not left to the tier badge. "Research
                      Needed" describes the evidence; it does not tell a coach
                      that what they just read is unsourced and should not be
                      acted on alone. Amber rather than the tier's red, because
                      this is an answer to weigh, not a refusal. */}
                  {/* Set at reading size, not caption size. This sentence and
                      the handoff below it were the two smallest things in the
                      bubble at 12.5px, under an answer at 16 -- the shape that
                      reads as fine print, which is exactly what a limitation
                      must not read as. */}
                  {msg.type === 'shadow' && msg.evidenceNotice === 'NO_VERIFIED_EVIDENCE' ? (
                    <p className="mt-[var(--s2)] max-w-[66ch] text-[16px] leading-[1.6] text-[color:var(--restricted)]">
                      No verified Library evidence matched this question. Treat the answer above as
                      unsourced -- confirm it with a coach before acting on it.
                    </p>
                  ) : null}
                  {/* Law 2/3: a response state is a queue outcome, so it rides
                      the badge ladder -- glyph plus uppercase word, never a
                      one-off chip. Withheld and degraded are --restricted, not
                      --locked: neither is a medical or safeguarding refusal.
                      A queued answer is not an outcome yet, so it wears the
                      administrative rung. */}
                  {msg.type === 'shadow' && msg.state && msg.state !== 'ok' ? (
                    <p className="mt-[var(--s3)]">
                      <span className={`badge ${msg.state === 'queued' ? 'badge--filed' : 'badge--restricted'}`}>
                        <i aria-hidden="true">{msg.state === 'queued' ? '◌' : '▲'}</i>
                        {msg.state === 'filtered' ? 'Withheld' : msg.state}
                      </span>
                    </p>
                  ) : null}
                  {msg.type === 'shadow' && msg.handoff ? (
                    <div className="mt-[var(--s3)]">
                      <span className="badge badge--restricted">
                        <i aria-hidden="true">▲</i>
                        Human Handoff Required
                      </span>
                      <p className="mt-[var(--s2)] max-w-[66ch] text-[16px] leading-[1.6] text-[color:var(--bone-300)]">
                        {msg.handoff}
                      </p>
                    </div>
                  ) : null}
                  {/* THE RATING, ON ANSWERS THAT CAN ACTUALLY CARRY ONE.
                      This block used to render under every SHADOW bubble
                      including the welcome, where the only thing it could do
                      was sit there disabled with a required-reason textarea
                      three rows tall -- a form asking for a paragraph before
                      it would accept the word "yes". The endpoint never
                      wanted that paragraph. ShadowFeedback renders nothing
                      unless the message is a durable server answer, asks one
                      question, and only asks for a reason when the answer is
                      that it did not help. */}
                  {msg.type === 'shadow' ? (
                    <ShadowFeedback
                      messageId={msg.id}
                      eligible={Boolean(msg.feedbackEligible)}
                      sent={Boolean(msg.feedbackSent)}
                      submitting={Boolean(feedbackSubmitting[msg.id])}
                      error={feedbackErrors[msg.id]}
                      onSubmit={(helpful, comment) => void sendFeedback(msg.id, helpful, comment)}
                    />
                  ) : null}
                  {/* THE MACHINERY, COLLAPSED. Which tier answered, which model
                      ran, and when are diagnostics: they told an athlete
                      nothing about whether to trust the answer, and they sat
                      between the answer and the controls at full contrast.
                      Behind one disclosure, in the order someone debugging
                      would want them. */}
                  {msg.type === 'shadow' && (msg.tier || msg.modelUsed) ? (
                    <ShadowDisclosure label="Details" className="mt-[var(--s3)] border-t border-[color:var(--brass-900)]">
                      <ul className="space-y-[var(--s1)]">
                        {msg.tier ? (
                          <li className="t-data text-[color:var(--bone-400)]">
                            {msg.tier === 'heavy_bag' ? 'Heavy Bag' : 'Quick Round'}
                            {getProfileTierLabel(msg.profileTier)}
                            {msg.isAsync ? ' · Processing...' : ''}
                          </li>
                        ) : null}
                        {msg.modelUsed ? (
                          <li className="t-data text-[color:var(--bone-400)]">Model: {msg.modelUsed}</li>
                        ) : null}
                        <li className="t-data text-[color:var(--bone-400)]">Answered {msg.timestamp}</li>
                      </ul>
                    </ShadowDisclosure>
                  ) : null}
                  {/* The receipts. Kept out of the always-visible band because
                      the grade above already states how well evidenced the
                      answer is; this is for the reader who wants to go and
                      read the source. */}
                  {msg.type === 'shadow' && msg.citations?.length ? (
                    <ShadowDisclosure
                      label={`Sources (${msg.citations.length})`}
                      className="border-t border-[color:var(--brass-900)]"
                    >
                      <ul className="space-y-[var(--s1)]">
                        {msg.citations.map((citation) => (
                          <li key={citation.evidenceId} className="t-data text-[color:var(--bone-400)]">
                            [{citation.token}] {citation.sourceTitle} — {citation.documentName}
                          </li>
                        ))}
                      </ul>
                    </ShadowDisclosure>
                  ) : null}
                  {/* A bubble with nothing to collapse -- your own question,
                      the opening line, a network error -- keeps its clock
                      where it always was. A disclosure holding one timestamp
                      would be furniture. */}
                  {msg.type === 'user' || !(msg.tier || msg.modelUsed) ? (
                    <p className="t-data mt-[var(--s2)] text-[color:var(--bone-400)]">{msg.timestamp}</p>
                  ) : null}
                </div>
              </div>
            ))}
            {isLoading ? (
              <div className="flex justify-start">
                <div className="mat-leather--raised rounded-[var(--r-md)] px-[var(--s4)] py-[var(--s3)]">
                  {/* Announced, not just drawn. Inside a polite log a screen
                      reader may or may not read an inserted node; role="status"
                      says this one is a state change worth hearing. */}
                  <p role="status" className="t-label">
                    Working on your {heavyBagMode ? 'deep' : 'quick'} answer…
                  </p>
                </div>
              </div>
            ) : null}
            <div ref={messagesEndRef} />
          </div>

          {allowedSessionTypes.includes('heavy_bag') && Object.keys(modelStatus).length > 0 ? (
            <div className="mb-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
              {/* Deliberately NOT the badge ladder: a model's deployment state
                  is not a safety or queue rung, and badge--cleared means
                  CLEARED. Telemetry voice on a brass chip instead. */}
              {Object.values(modelStatus).map((model) => (
                <span
                  key={model.displayName}
                  className={`t-data rounded-[var(--r-md)] border px-[var(--s3)] py-[var(--s1)] uppercase ${model.available ? 'border-[color:var(--brass-700)] text-[color:var(--bone-300)]' : 'border-[color:var(--brass-800)] text-[color:var(--bone-400)]'}`}
                  title={`${model.tier} tier -- ${model.available ? 'live' : 'not deployed yet'}`}
                >
                  {model.available ? '● ' : '○ '}{model.displayName}
                </span>
              ))}
            </div>
          ) : null}

          <form onSubmit={handleSendMessage} className="flex flex-col gap-[var(--s3)]">
            {allowedSessionTypes.includes('heavy_bag') ? (
              <fieldset className="flex flex-wrap items-center gap-[var(--s3)]">
                {/* "Quick" / "Heavy Bag" was the room's own vocabulary printed
                    on a toggle that showed its STATE -- so the button read
                    "Quick" while you were in quick mode and pressing it did
                    the opposite of what it said. Same two modes, same request
                    field, named by what you get. */}
                <legend className="t-label mb-[var(--s2)]">How deep should the answer go?</legend>
                <button
                  type="button"
                  onClick={() => setHeavyBagMode(false)}
                  disabled={Boolean(restoringSessionId)}
                  aria-pressed={!heavyBagMode}
                  className={`btn disabled:cursor-not-allowed disabled:opacity-60 ${heavyBagMode ? 'btn--ghost' : ''}`}
                >
                  Quick answer
                </button>
                <button
                  type="button"
                  onClick={() => setHeavyBagMode(true)}
                  disabled={Boolean(restoringSessionId)}
                  aria-pressed={heavyBagMode}
                  className={`btn disabled:cursor-not-allowed disabled:opacity-60 ${heavyBagMode ? '' : 'btn--ghost'}`}
                >
                  Full session
                </button>
                {heavyBagMode ? (
                  /* The checkbox was .sr-only inside a .btn label, so the
                     focus ring drew around a 1px box in the corner: keyboard
                     users could tab to it and see nothing move. It is a real
                     visible checkbox now, and "BG" -- which named nothing --
                     says what it does. */
                  <label className="btn btn--ghost flex cursor-pointer items-center gap-[var(--s2)]">
                    <input
                      type="checkbox"
                      checked={backgroundHeavyBag}
                      onChange={(event) => setBackgroundHeavyBag(event.target.checked)}
                      disabled={Boolean(restoringSessionId)}
                      className="h-[18px] w-[18px]"
                    />
                    Finish in background
                  </label>
                ) : null}
              </fieldset>
            ) : null}
            <div className="flex flex-col gap-[var(--s2)]">
              {/* Was a single-line <input> with a placeholder for a label:
                  the label vanished the moment anyone typed, and a
                  three-sentence question scrolled sideways through a 220px
                  slot. A textarea that grows to two rows, Enter to send so
                  the habit still works, Shift+Enter for a new line. */}
              <label htmlFor="shadow-composer" className="t-label">
                Your question
              </label>
              <textarea
                id="shadow-composer"
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void handleSendMessage(event);
                  }
                }}
                disabled={Boolean(restoringSessionId)}
                rows={2}
                aria-describedby="shadow-composer-hint"
                placeholder="What do you need to know?"
                className="textarea w-full"
              />
              <p id="shadow-composer-hint" className="t-muted">
                Enter sends. Shift + Enter starts a new line.
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-[var(--s3)]">
              <button
                type="submit"
                disabled={isLoading || Boolean(restoringSessionId) || !userInput.trim()}
                className="btn disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isLoading ? 'Asking…' : 'Ask SHADOW'}
              </button>
            </div>
          </form>
        </section>

      </div>
    </main>
  );
}

export default function ShadowChatPage() {
  return (
    <Suspense fallback={<main className="room room--night min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-300)]"><div className="mx-auto flex min-h-screen max-w-5xl items-center justify-center border border-[color:var(--brass-900)] rounded-none px-6"><div className="text-center"><p className="t-eyebrow">SHADOW</p><h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-lg)' }}>Loading scope</h1></div></div></main>}>
      <ShadowChatPageContent />
    </Suspense>
  );
}

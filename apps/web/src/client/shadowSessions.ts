export type StoredShadowResponseState = 'ok' | 'filtered';

export type StoredShadowEvidenceTier =
  | 'PROVEN'
  | 'EMERGING'
  | 'EXPERIMENTAL'
  | 'RESEARCH_NEEDED';

// Messages written before evidence_tier existed have no grade to recover, and a
// missing grade must never be read as a good one. RESEARCH_NEEDED is the
// flattest tier, which matches what the live chat already does for a response
// that never reached the server.
export const RESTORED_MESSAGE_FALLBACK_TIER: StoredShadowEvidenceTier = 'RESEARCH_NEEDED';

function isStoredEvidenceTier(value: unknown): value is StoredShadowEvidenceTier {
  return value === 'PROVEN'
    || value === 'EMERGING'
    || value === 'EXPERIMENTAL'
    || value === 'RESEARCH_NEEDED';
}

export interface OwnedShadowConversation {
  conversationId: string;
  title: string;
  athleteId: string | null;
  sessionType: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredShadowConversationMessage {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  responseState: StoredShadowResponseState | null;
  evidenceTier: StoredShadowEvidenceTier | null;
  handoff: string | null;
  createdAt: string;
}

export interface RestoredShadowMessage {
  id: string;
  type: 'user' | 'shadow';
  text: string;
  timestamp: string;
  state?: StoredShadowResponseState;
  evidenceTier: StoredShadowEvidenceTier;
  handoff?: string;
  feedbackEligible: boolean;
}

export interface ShadowChatRequestInput {
  message: string;
  heavyBagMode: boolean;
  conversationId?: string;
  athleteId?: string;
}

type ShadowSessionsFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export class ShadowSessionsRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ShadowSessionsRequestError';
  }
}

function normalizedBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildShadowChatRequest(input: ShadowChatRequestInput): {
  message: string;
  tier: 'heavy_bag' | undefined;
  conversationId: string | undefined;
  athleteId: string | undefined;
} {
  return {
    message: input.message,
    tier: input.heavyBagMode ? 'heavy_bag' : undefined,
    conversationId: input.conversationId,
    athleteId: input.athleteId,
  };
}

function requiredString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ShadowSessionsRequestError(502, 'SHADOW session history was malformed.');
  }
  return value;
}

function requiredIsoTimestamp(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = requiredString(record, field);
  if (!Number.isFinite(Date.parse(value))) {
    throw new ShadowSessionsRequestError(502, 'SHADOW session history was malformed.');
  }
  return value;
}

function parseConversation(value: unknown): OwnedShadowConversation {
  if (!isRecord(value)) {
    throw new ShadowSessionsRequestError(502, 'SHADOW session history was malformed.');
  }
  const athleteId = value.athleteId;
  if (athleteId !== null && athleteId !== undefined && typeof athleteId !== 'string') {
    throw new ShadowSessionsRequestError(502, 'SHADOW session history was malformed.');
  }
  return {
    conversationId: requiredString(value, 'conversationId'),
    title: requiredString(value, 'title'),
    athleteId: typeof athleteId === 'string' ? athleteId : null,
    sessionType: requiredString(value, 'sessionType'),
    createdAt: requiredIsoTimestamp(value, 'createdAt'),
    updatedAt: requiredIsoTimestamp(value, 'updatedAt'),
  };
}

function parseMessage(value: unknown): StoredShadowConversationMessage {
  if (!isRecord(value)) {
    throw new ShadowSessionsRequestError(502, 'SHADOW session messages were malformed.');
  }
  const role = value.role;
  const responseState = value.responseState;
  if (role !== 'user' && role !== 'assistant') {
    throw new ShadowSessionsRequestError(502, 'SHADOW session messages were malformed.');
  }
  if (responseState !== null && responseState !== 'ok' && responseState !== 'filtered') {
    throw new ShadowSessionsRequestError(502, 'SHADOW session messages were malformed.');
  }
  const evidenceTier = value.evidenceTier;
  if (
    evidenceTier !== null
    && evidenceTier !== undefined
    && !isStoredEvidenceTier(evidenceTier)
  ) {
    throw new ShadowSessionsRequestError(502, 'SHADOW session messages were malformed.');
  }
  const handoff = value.handoff;
  if (handoff !== null && handoff !== undefined && typeof handoff !== 'string') {
    throw new ShadowSessionsRequestError(502, 'SHADOW session messages were malformed.');
  }
  return {
    messageId: requiredString(value, 'messageId'),
    role,
    content: requiredString(value, 'content'),
    responseState,
    evidenceTier: isStoredEvidenceTier(evidenceTier) ? evidenceTier : null,
    handoff: typeof handoff === 'string' && handoff.trim() ? handoff : null,
    createdAt: requiredIsoTimestamp(value, 'createdAt'),
  };
}

async function parseJsonResponse(
  response: Response,
  unavailableMessage: string,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new ShadowSessionsRequestError(response.status, unavailableMessage);
  }
  const payload = await response.json().catch(() => null);
  if (!isRecord(payload)) {
    throw new ShadowSessionsRequestError(502, unavailableMessage);
  }
  return payload;
}

export async function listOwnedShadowSessions(
  apiBaseUrl: string,
  signal?: AbortSignal,
  fetchImpl: ShadowSessionsFetch = fetch,
): Promise<OwnedShadowConversation[]> {
  const response = await fetchImpl(
    `${normalizedBaseUrl(apiBaseUrl)}/api/pilot/shadow/sessions?limit=50`,
    { method: 'GET', credentials: 'include', signal },
  );
  const payload = await parseJsonResponse(
    response,
    'SHADOW could not load your saved sessions.',
  );
  if (payload.success !== true || !Array.isArray(payload.conversations)) {
    throw new ShadowSessionsRequestError(502, 'SHADOW session history was malformed.');
  }
  return payload.conversations.map(parseConversation);
}

export async function loadOwnedShadowSessionMessages(
  apiBaseUrl: string,
  conversationId: string,
  signal?: AbortSignal,
  fetchImpl: ShadowSessionsFetch = fetch,
): Promise<StoredShadowConversationMessage[]> {
  const response = await fetchImpl(
    `${normalizedBaseUrl(apiBaseUrl)}/api/pilot/shadow/sessions/${encodeURIComponent(conversationId)}?limit=50`,
    { method: 'GET', credentials: 'include', signal },
  );
  const payload = await parseJsonResponse(
    response,
    'SHADOW could not restore that session.',
  );
  if (payload.success !== true || !Array.isArray(payload.messages)) {
    throw new ShadowSessionsRequestError(502, 'SHADOW session messages were malformed.');
  }
  return payload.messages.map(parseMessage);
}

export function mapStoredShadowMessage(
  message: StoredShadowConversationMessage,
): RestoredShadowMessage {
  const state = message.role === 'assistant' && message.responseState
    ? message.responseState
    : undefined;
  return {
    id: message.messageId,
    type: message.role === 'assistant' ? 'shadow' : 'user',
    text: message.content,
    timestamp: new Date(message.createdAt).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
    state,
    // A user turn has no grade of its own; grading only describes SHADOW's
    // answers. Assistant turns fall back to the flattest tier rather than the
    // renderer's old EMERGING default, which silently promoted ungraded
    // answers to look well-evidenced.
    evidenceTier: message.role === 'assistant'
      ? (message.evidenceTier ?? RESTORED_MESSAGE_FALLBACK_TIER)
      : RESTORED_MESSAGE_FALLBACK_TIER,
    handoff: message.role === 'assistant' ? (message.handoff ?? undefined) : undefined,
    feedbackEligible: message.role === 'assistant' && Boolean(state),
  };
}

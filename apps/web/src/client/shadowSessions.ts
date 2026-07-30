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

export interface StoredShadowCitation {
  evidenceId: string;
  token: string;
  sourceTitle: string;
  documentName: string;
}

export interface StoredShadowConversationMessage {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  responseState: StoredShadowResponseState | null;
  evidenceTier: StoredShadowEvidenceTier | null;
  handoff: string | null;
  createdAt: string;
  citations: StoredShadowCitation[];
}

export interface RestoredShadowMessage {
  id: string;
  type: 'user' | 'shadow';
  text: string;
  timestamp: string;
  state?: StoredShadowResponseState;
  evidenceTier: StoredShadowEvidenceTier;
  handoff?: string;
  citations?: StoredShadowCitation[];
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
    citations: parseCitations(value.citations),
  };
}

// An absent field is not malformed -- rows written before citations were
// persisted, and servers older than this client, both send nothing. A present
// field with the wrong shape is malformed, and follows this parser's existing
// convention of failing loudly rather than rendering wrong receipts.
function parseCitations(value: unknown): StoredShadowCitation[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ShadowSessionsRequestError(502, 'SHADOW session messages were malformed.');
  }
  return value.map((entry) => {
    if (
      !isRecord(entry)
      || typeof entry.evidenceId !== 'string'
      || typeof entry.token !== 'string'
      || typeof entry.sourceTitle !== 'string'
      || typeof entry.documentName !== 'string'
    ) {
      throw new ShadowSessionsRequestError(502, 'SHADOW session messages were malformed.');
    }
    return {
      evidenceId: entry.evidenceId,
      token: entry.token,
      sourceTitle: entry.sourceTitle,
      documentName: entry.documentName,
    };
  });
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

// Mirrors renameConversation's server-side normalization (collapse whitespace,
// trim, cap at 120) so the optimistic title the list shows is byte-identical
// to what the server stored -- otherwise the card would briefly display a
// title the next refresh silently corrects.
export function normalizeShadowSessionTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, 120);
}

export async function renameOwnedShadowSession(
  apiBaseUrl: string,
  conversationId: string,
  title: string,
  fetchImpl: ShadowSessionsFetch = fetch,
): Promise<string> {
  const normalizedTitle = normalizeShadowSessionTitle(title);
  if (!normalizedTitle) {
    throw new ShadowSessionsRequestError(400, 'Enter a name for the session.');
  }
  const response = await fetchImpl(
    `${normalizedBaseUrl(apiBaseUrl)}/api/pilot/shadow/sessions/${encodeURIComponent(conversationId)}`,
    {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: normalizedTitle }),
    },
  );
  const payload = await parseJsonResponse(
    response,
    'SHADOW could not rename that session.',
  );
  if (payload.success !== true) {
    throw new ShadowSessionsRequestError(502, 'SHADOW could not rename that session.');
  }
  return normalizedTitle;
}

export async function deleteOwnedShadowSession(
  apiBaseUrl: string,
  conversationId: string,
  fetchImpl: ShadowSessionsFetch = fetch,
): Promise<void> {
  const response = await fetchImpl(
    `${normalizedBaseUrl(apiBaseUrl)}/api/pilot/shadow/sessions/${encodeURIComponent(conversationId)}`,
    { method: 'DELETE', credentials: 'include' },
  );
  const payload = await parseJsonResponse(
    response,
    'SHADOW could not delete that session.',
  );
  if (payload.success !== true) {
    throw new ShadowSessionsRequestError(502, 'SHADOW could not delete that session.');
  }
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
    // Receipts belong to SHADOW's answers only, and an empty list stays
    // undefined so the renderer draws no empty Sources block.
    citations: message.role === 'assistant' && message.citations.length > 0
      ? message.citations
      : undefined,
    feedbackEligible: message.role === 'assistant' && Boolean(state),
  };
}

import { formatGymClock24 } from '../lib/gymTime';

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
  // Explicit opt-in to background processing for Heavy Bag. Omitted from the
  // wire unless true -- the server defaults to synchronous, and older servers
  // reject unknown non-boolean values.
  preferAsync?: boolean;
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
  preferAsync: true | undefined;
} {
  return {
    message: input.message,
    tier: input.heavyBagMode ? 'heavy_bag' : undefined,
    conversationId: input.conversationId,
    athleteId: input.athleteId,
    preferAsync: input.preferAsync === true ? true : undefined,
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

/**
 * One person's own SHADOW history, as GET /api/pilot/shadow/data returns it.
 *
 * The three counts are the reason this has a type rather than being handed
 * around as `unknown`. An export that quietly carried the most recent hundred
 * of somebody's hundred and fifty conversations would be a partial answer
 * wearing the label of a complete one, and the person who asked for their data
 * is precisely the person who cannot check.
 *
 * `completeAccountExport` is the server's own flag and it is false by design:
 * this is SHADOW conversation history and memory corrections, not everything
 * the platform holds about somebody. The screen that offers this must say so.
 */
export interface OwnShadowDataExport {
  readonly exportedAt: string;
  readonly exportScope: string;
  readonly completeAccountExport: boolean;
  readonly conversationLimit: number;
  readonly conversationsStored: number;
  readonly conversationsIncluded: number;
  /** The raw payload, passed through unread, for writing to the file. */
  readonly payload: Record<string, unknown>;
}

function requiredCount(value: unknown, label: string): number {
  // A missing or non-numeric count is a malformed export, not a zero. Reading
  // it as zero would render "0 of 0 conversations" over a file full of them.
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ShadowSessionsRequestError(502, `SHADOW returned an export with no ${label}.`);
  }
  return value;
}

export async function fetchOwnShadowDataExport(
  apiBaseUrl: string,
  signal?: AbortSignal,
  fetchImpl: ShadowSessionsFetch = fetch,
): Promise<OwnShadowDataExport> {
  const response = await fetchImpl(
    `${normalizedBaseUrl(apiBaseUrl)}/api/pilot/shadow/data`,
    { method: 'GET', credentials: 'include', signal },
  );
  const payload = await parseJsonResponse(
    response,
    'SHADOW could not put your history together.',
  );
  if (payload.success !== true || !isRecord(payload.data)) {
    throw new ShadowSessionsRequestError(502, 'SHADOW returned a malformed export.');
  }
  const data = payload.data;
  return {
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : new Date().toISOString(),
    exportScope: typeof data.exportScope === 'string' ? data.exportScope : 'unknown',
    // Absent is treated as NOT complete. The safe reading of a server that did
    // not say whether this is everything is "assume it is not".
    completeAccountExport: data.completeAccountExport === true,
    conversationLimit: requiredCount(data.conversationLimit, 'conversation limit'),
    conversationsStored: requiredCount(data.conversationsStored, 'stored conversation count'),
    conversationsIncluded: requiredCount(data.conversationsIncluded, 'included conversation count'),
    payload: data,
  };
}

export type OwnShadowDeletionStatus = 'pending' | 'approved' | 'completed' | 'denied';

export interface OwnShadowDeletionRequest {
  readonly requestId: string;
  readonly status: OwnShadowDeletionStatus;
  readonly requestedAt: string;
  readonly completedAt: string | null;
}

function parseDeletionRequest(value: unknown): OwnShadowDeletionRequest | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (
    typeof value.requestId !== 'string'
    || typeof value.requestedAt !== 'string'
    || (status !== 'pending' && status !== 'approved' && status !== 'completed' && status !== 'denied')
  ) {
    throw new ShadowSessionsRequestError(502, 'SHADOW returned a malformed deletion request.');
  }
  return {
    requestId: value.requestId,
    status,
    requestedAt: value.requestedAt,
    completedAt: typeof value.completedAt === 'string' ? value.completedAt : null,
  };
}

/**
 * Where the caller's own deletion request stands, or null if they have none.
 *
 * Null and "could not read" are NOT the same and this never conflates them: a
 * failed read throws. A person told "you have no request" when the server
 * could not be asked would file a second one, which is exactly what the
 * route's idempotency check exists to absorb and exactly the confusion it
 * cannot undo.
 */
export async function fetchOwnShadowDeletionRequest(
  apiBaseUrl: string,
  signal?: AbortSignal,
  fetchImpl: ShadowSessionsFetch = fetch,
): Promise<OwnShadowDeletionRequest | null> {
  const response = await fetchImpl(
    `${normalizedBaseUrl(apiBaseUrl)}/api/pilot/shadow/data/deletion-request`,
    { method: 'GET', credentials: 'include', signal },
  );
  const payload = await parseJsonResponse(
    response,
    'SHADOW could not check your deletion request.',
  );
  if (payload.ok !== true) {
    throw new ShadowSessionsRequestError(502, 'SHADOW could not check your deletion request.');
  }
  return payload.request === null || payload.request === undefined
    ? null
    : parseDeletionRequest(payload.request);
}

/** File a request to have SHADOW conversation history cleared. Idempotent
 *  server-side: a repeat while one is pending returns the same request. */
export async function requestOwnShadowDeletion(
  apiBaseUrl: string,
  fetchImpl: ShadowSessionsFetch = fetch,
): Promise<{ requestId: string }> {
  const response = await fetchImpl(
    `${normalizedBaseUrl(apiBaseUrl)}/api/pilot/shadow/data`,
    { method: 'POST', credentials: 'include' },
  );
  const payload = await parseJsonResponse(
    response,
    'SHADOW could not file your request.',
  );
  if (payload.success !== true || typeof payload.requestId !== 'string') {
    throw new ShadowSessionsRequestError(502, 'SHADOW could not file your request.');
  }
  return { requestId: payload.requestId };
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
    timestamp: formatGymClock24(message.createdAt, { seconds: true }) ?? '',
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

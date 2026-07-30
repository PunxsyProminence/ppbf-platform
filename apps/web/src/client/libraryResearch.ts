// Client for The Library's research Q&A.
//
// The /research/chat page used to answer from a hardcoded keyword if/else --
// canned strings, no retrieval, while the real SHADOW chat directed users here
// whenever its own evidence was weak. This talks to the actual Library:
// POST /api/pilot/shadow/library/claims runs the organization-scoped search
// over approved sources and returns a claim graded by what was found.
//
// Honesty contract carried into the UI: answers come only from evidence a
// reviewer approved. When nothing is found, the server has already opened a
// research requirement for the question, and the answer must say that rather
// than improvise.

export type LibraryClaimStatus = 'supported' | 'weak' | 'unsupported';

export interface LibraryEvidenceItem {
  sourceTitle: string;
  documentName: string;
  authorityTier: number;
  snippet: string;
}

export interface LibraryClaimAnswer {
  status: LibraryClaimStatus;
  answer: string;
  evidence: LibraryEvidenceItem[];
  // Present when the Library found nothing and logged the gap -- the server
  // opens a research requirement for every unsupported claim.
  researchRequirementId: number | null;
}

export class LibraryResearchError extends Error {
  constructor(
    readonly status: number,
    readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'LibraryResearchError';
  }
}

// One-line meaning per grade, shown beside the answer. 'unsupported' states
// the two true facts: nothing approved matched, and the gap is now logged --
// createShadowLibraryClaim opens a research requirement for exactly this case.
export function claimStatusLabel(status: LibraryClaimStatus): string {
  switch (status) {
    case 'supported':
      return 'Backed by approved Library evidence';
    case 'weak':
      return 'Limited Library evidence — treat as a starting point';
    case 'unsupported':
      return 'No approved evidence found — logged as a research need';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isClaimStatus(value: unknown): value is LibraryClaimStatus {
  return value === 'supported' || value === 'weak' || value === 'unsupported';
}

function parseEvidence(value: unknown): LibraryEvidenceItem[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: LibraryEvidenceItem[] = [];
  for (const entry of value) {
    if (
      isRecord(entry)
      && typeof entry.source_title === 'string'
      && typeof entry.document_name === 'string'
      && typeof entry.text_content === 'string'
    ) {
      items.push({
        sourceTitle: entry.source_title,
        documentName: entry.document_name,
        authorityTier: typeof entry.authority_tier === 'number' ? entry.authority_tier : 5,
        snippet: entry.text_content.length > 280
          ? `${entry.text_content.slice(0, 280).trimEnd()}…`
          : entry.text_content,
      });
    }
  }
  return items;
}

export async function askLibrary(
  apiBaseUrl: string,
  question: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LibraryClaimAnswer> {
  let response: Response;
  try {
    response = await fetchImpl(`${apiBaseUrl}/api/pilot/shadow/library/claims`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, scope: 'scoped' }),
    });
  } catch {
    throw new LibraryResearchError(0, 'The Library could not be reached. Check your connection and try again.');
  }

  if (response.status === 401) {
    throw new LibraryResearchError(401, 'Sign in to search the Library.');
  }
  if (response.status === 403) {
    throw new LibraryResearchError(403, 'Your role does not have Library access.');
  }
  if (response.status === 429) {
    throw new LibraryResearchError(429, 'The Library is rate limited right now — wait a moment and ask again.');
  }
  if (!response.ok) {
    throw new LibraryResearchError(response.status, 'The Library could not answer right now. Try again shortly.');
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.claim)) {
    throw new LibraryResearchError(502, 'The Library returned a malformed answer.');
  }

  const claim = payload.claim;
  if (!isClaimStatus(claim.status) || typeof claim.answer !== 'string') {
    throw new LibraryResearchError(502, 'The Library returned a malformed answer.');
  }

  return {
    status: claim.status,
    answer: claim.answer,
    evidence: parseEvidence(claim.evidence),
    researchRequirementId: typeof claim.researchRequirementId === 'number' ? claim.researchRequirementId : null,
  };
}

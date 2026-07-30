// Plain-language display layer for SHADOW's evidence vocabulary.
//
// The four tier names render as badges on every answer, but nothing anywhere
// explained what they mean -- a parent seeing EMERGING had no definition of it
// on the page, in a tooltip, or in any doc they can reach. The names stay
// (they are load-bearing in the doctrine, the validator, and the stored rows);
// this module supplies the one-line meanings the UI shows beside them.
//
// Kept separate from the chat page so the meanings are importable by any
// surface that renders a tier badge, and testable without mounting the page.

import type { ShadowEvidenceTier } from '@/src/server/pilot/shadowEvidenceTier';

export const EVIDENCE_TIER_MEANINGS: Record<ShadowEvidenceTier, string> = {
  PROVEN: 'Backed by verified evidence your organization has reviewed and approved.',
  EMERGING: 'Early supporting evidence exists, but it is not yet fully verified.',
  EXPERIMENTAL: 'Being tried and evaluated. Treat it as a hypothesis, not a conclusion.',
  RESEARCH_NEEDED: 'No verified evidence yet. Treat this as unverified guidance.',
};

// Display order for the legend: most evidenced first, matching the visual
// convention that "the bigger the shadow, the more authentic the message."
export const EVIDENCE_TIER_ORDER: readonly ShadowEvidenceTier[] = [
  'PROVEN',
  'EMERGING',
  'EXPERIMENTAL',
  'RESEARCH_NEEDED',
];

// Shape of a citation as the chat API returns it to the browser
// (publicEvidenceCitations in shadowEvidence.ts). Declared here rather than
// imported from the server module so the client bundle does not pull server
// code, and so a server-side change to the internal type fails typecheck here
// instead of silently changing what the UI expects.
export interface ShadowDisplayCitation {
  evidenceId: string;
  token: string;
  sourceTitle: string;
  documentName: string;
}

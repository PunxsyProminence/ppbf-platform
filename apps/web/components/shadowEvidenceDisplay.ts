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

// What each grade measures: the strongest source the answer cites
// (shadowEvidenceTier.ts). The old lines said EMERGING was "not yet fully
// verified", but every passage SHADOW serves is approved and verified, and
// PROVEN's "reviewed and approved" was true of every grade. Wording PROPOSED in
// audit item 11, accepted with Jason's ruling A (relayed by Overwatch
// 2026-10-17); EXPERIMENTAL also names low-tier sources, which the rule grades
// there too.
export const EVIDENCE_TIER_MEANINGS: Record<ShadowEvidenceTier, string> = {
  PROVEN: 'The strongest source cited is verified, boxing-specific evidence from a top-tier source.',
  EMERGING: 'The strongest source cited is verified or strongly supported, but from a lower tier or another sport.',
  EXPERIMENTAL: 'Cites only contested, hypothesis, film-study or low-tier material, or no Library source.',
  RESEARCH_NEEDED: 'No approved evidence was found for this question.',
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
  /** The cited passage; sent only within the rights rule (A-Q11). */
  excerpt?: string;
}

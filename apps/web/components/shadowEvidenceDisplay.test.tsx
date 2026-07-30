/**
 * @jest-environment jsdom
 */

import { render, screen } from '@testing-library/react';

import {
  EVIDENCE_TIER_MEANINGS,
  EVIDENCE_TIER_ORDER,
  type ShadowDisplayCitation,
} from './shadowEvidenceDisplay';

// Mirrors the chat page's citation block: same fields, same "[token] title —
// document" shape, so a drift in the citation contract fails here instead of
// rendering blank rows in production.
function CitationList({ citations }: { readonly citations: ShadowDisplayCitation[] }) {
  return (
    <ul>
      {citations.map((citation) => (
        <li key={citation.evidenceId}>
          [{citation.token}] {citation.sourceTitle} — {citation.documentName}
        </li>
      ))}
    </ul>
  );
}

describe('evidence tier meanings', () => {
  test('every tier has a plain-language meaning, and the legend order covers all of them', () => {
    // The badge names are jargon to parents and athletes; a tier with no
    // meaning renders as an unexplained label again, which is the defect this
    // module exists to close.
    expect(EVIDENCE_TIER_ORDER).toHaveLength(4);
    for (const tier of EVIDENCE_TIER_ORDER) {
      expect(EVIDENCE_TIER_MEANINGS[tier]).toEqual(expect.any(String));
      expect(EVIDENCE_TIER_MEANINGS[tier].length).toBeGreaterThan(20);
    }
  });

  test('RESEARCH_NEEDED says plainly that the guidance is unverified', () => {
    // The least-evidenced tier is the one a reader most needs to understand.
    expect(EVIDENCE_TIER_MEANINGS.RESEARCH_NEEDED).toMatch(/unverified/i);
    expect(EVIDENCE_TIER_MEANINGS.RESEARCH_NEEDED).toMatch(/no verified evidence/i);
  });
});

describe('citation rendering contract', () => {
  test('renders token, source title, and document name for each citation', () => {
    const citations: ShadowDisplayCitation[] = [
      {
        evidenceId: 'ev-1',
        token: 'E:1',
        sourceTitle: 'SHADOW Canonical Authority Model',
        documentName: 'Authority Model',
      },
      {
        evidenceId: 'ev-2',
        token: 'E:2',
        sourceTitle: 'USA Boxing Safety Rules',
        documentName: 'Rulebook 2026',
      },
    ];

    render(<CitationList citations={citations} />);

    expect(screen.getByText(/\[E:1\] SHADOW Canonical Authority Model — Authority Model/)).toBeTruthy();
    expect(screen.getByText(/\[E:2\] USA Boxing Safety Rules — Rulebook 2026/)).toBeTruthy();
  });
});

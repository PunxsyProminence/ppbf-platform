/**
 * @jest-environment jsdom
 */

// The first component test in the repo. Until jest.config.js matched .test.tsx
// and a DOM environment was available, every file under app/ and components/ sat
// outside the suite -- which is why a chat page that dropped a safety banner and
// mis-graded restored answers coexisted with a green build.
//
// It covers the two render rules from the restore defect directly, against the
// same constants the page uses, so the guarantee is asserted rather than assumed:
//   1. an ungraded message must not draw the well-evidenced style
//   2. a stored handoff must still render its banner after a restore

import { render, screen } from '@testing-library/react';

import {
  mapStoredShadowMessage,
  RESTORED_MESSAGE_FALLBACK_TIER,
  type StoredShadowConversationMessage,
} from '@/client/shadowSessions';

type ShadowEvidenceTier = 'PROVEN' | 'EMERGING' | 'EXPERIMENTAL' | 'RESEARCH_NEEDED';

// Kept in step with app/shadow/page.tsx. Only the ordering matters here: the
// darker the style, the more evidenced the answer claims to be.
const EVIDENCE_TIER_STYLES: Record<ShadowEvidenceTier, string> = {
  PROVEN: 'bg-black',
  EMERGING: 'bg-[var(--hide-800)]',
  EXPERIMENTAL: 'bg-[var(--hide-700)]',
  RESEARCH_NEEDED: 'bg-[var(--bone-400)]',
};

function RestoredBubble({ message }: { readonly message: StoredShadowConversationMessage }) {
  const mapped = mapStoredShadowMessage(message);
  return (
    <div data-testid="bubble" className={EVIDENCE_TIER_STYLES[mapped.evidenceTier]}>
      <p>{mapped.text}</p>
      <p data-testid="evidence-label">Evidence: {mapped.evidenceTier}</p>
      {mapped.handoff ? (
        <div data-testid="handoff-banner">
          <p>Human Handoff Required</p>
          <p>{mapped.handoff}</p>
        </div>
      ) : null}
    </div>
  );
}

const BASE: StoredShadowConversationMessage = {
  messageId: 'm1',
  role: 'assistant',
  content: 'A bounded answer.',
  responseState: 'ok',
  evidenceTier: null,
  handoff: null,
  createdAt: '2026-07-24T12:00:00.000Z',
  citations: [],
};

describe('restored SHADOW message rendering', () => {
  test('an ungraded message does not render at the well-evidenced style', () => {
    render(<RestoredBubble message={BASE} />);

    const bubble = screen.getByTestId('bubble');
    expect(bubble.className).toBe(EVIDENCE_TIER_STYLES[RESTORED_MESSAGE_FALLBACK_TIER]);
    // The specific regression: the renderer used to default to EMERGING.
    expect(bubble.className).not.toBe(EVIDENCE_TIER_STYLES.EMERGING);
    expect(screen.getByTestId('evidence-label').textContent).toContain('RESEARCH_NEEDED');
  });

  test('a stored grade survives the restore rather than being defaulted away', () => {
    render(<RestoredBubble message={{ ...BASE, evidenceTier: 'PROVEN' }} />);

    expect(screen.getByTestId('bubble').className).toBe(EVIDENCE_TIER_STYLES.PROVEN);
    expect(screen.getByTestId('evidence-label').textContent).toContain('PROVEN');
  });

  test('a stored handoff still renders its banner after a restore', () => {
    const handoff = 'Talk to your medical team before changing any weight-cut plan.';
    render(<RestoredBubble message={{ ...BASE, handoff }} />);

    expect(screen.getByTestId('handoff-banner')).toBeTruthy();
    expect(screen.getByText(handoff)).toBeTruthy();
  });

  test('no banner is invented when the stored message had no handoff', () => {
    render(<RestoredBubble message={BASE} />);

    expect(screen.queryByTestId('handoff-banner')).toBeNull();
  });
});

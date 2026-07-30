import { isIntakeDocumentReadyForReview } from './intake';

describe('intake document security gate', () => {
  test('requires both a clean scanner result and completed bounded extraction', () => {
    expect(isIntakeDocumentReadyForReview({
      metadata: { security_state: 'clean', extraction_state: 'ready_for_review' },
    })).toBe(true);
    expect(isIntakeDocumentReadyForReview({
      metadata: { quarantine_status: 'clean', extraction_state: 'ready_for_review' },
    })).toBe(true);
  });

  test.each([
    {},
    { security_state: 'quarantined', extraction_state: 'ready_for_review' },
    { security_state: 'clean', extraction_state: 'pending' },
    { quarantine_status: 'pending_security_review' },
    { security_state: 'infected', extraction_state: 'ready_for_review' },
  ])('fails closed for incomplete or unsafe metadata %#', (metadata) => {
    expect(isIntakeDocumentReadyForReview({ metadata })).toBe(false);
  });
});

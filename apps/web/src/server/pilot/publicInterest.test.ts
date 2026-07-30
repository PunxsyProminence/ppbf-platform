jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));
jest.mock('./env', () => ({
  getPilotDefaultOrganizationId: jest.fn().mockReturnValue('org-default'),
}));

import { queryOne } from './db';
import {
  createPublicInterestSubmission,
  PublicInterestValidationError,
  validatePublicInterestSubmission,
  type PublicInterestSubmissionInput,
} from './publicInterest';

const mockQueryOne = jest.mocked(queryOne);

beforeEach(() => {
  jest.clearAllMocks();
});

function validInput(overrides: Partial<PublicInterestSubmissionInput> = {}): PublicInterestSubmissionInput {
  return {
    fullName: 'Jordan Visitor',
    email: 'jordan@example.com',
    phone: '555-123-4567',
    visitorType: 'Parent / Guardian',
    programInterest: 'Youth Development',
    preferredContactMethod: 'Email',
    message: 'Interested in the youth program.',
    consentToContact: true,
    ...overrides,
  };
}

describe('validatePublicInterestSubmission', () => {
  test('accepts a well-formed submission', () => {
    expect(() => validatePublicInterestSubmission(validInput())).not.toThrow();
  });

  test('rejects an empty full name', () => {
    expect(() => validatePublicInterestSubmission(validInput({ fullName: '' })))
      .toThrow(PublicInterestValidationError);
  });

  test('rejects a malformed email', () => {
    expect(() => validatePublicInterestSubmission(validInput({ email: 'not-an-email' })))
      .toThrow(PublicInterestValidationError);
  });

  test('rejects a visitor type outside the known set (client enum is not trusted)', () => {
    expect(() => validatePublicInterestSubmission(validInput({ visitorType: '<script>alert(1)</script>' })))
      .toThrow(PublicInterestValidationError);
  });

  test('rejects a program interest outside the known set', () => {
    expect(() => validatePublicInterestSubmission(validInput({ programInterest: 'Not A Real Program' })))
      .toThrow(PublicInterestValidationError);
  });

  test('rejects a preferred contact method outside the known set', () => {
    expect(() => validatePublicInterestSubmission(validInput({ preferredContactMethod: 'Carrier Pigeon' })))
      .toThrow(PublicInterestValidationError);
  });

  test('rejects a message over 4,000 characters', () => {
    expect(() => validatePublicInterestSubmission(validInput({ message: 'x'.repeat(4_001) })))
      .toThrow(PublicInterestValidationError);
  });

  test('rejects submission without consent, regardless of how complete the rest is', () => {
    expect(() => validatePublicInterestSubmission(validInput({ consentToContact: false })))
      .toThrow(PublicInterestValidationError);
  });
});

describe('createPublicInterestSubmission', () => {
  test('inserts with the default organization id and returns the row', async () => {
    mockQueryOne.mockResolvedValueOnce({
      submission_id: 'sub-1',
      organization_id: 'org-default',
      full_name: 'Jordan Visitor',
      email: 'jordan@example.com',
      phone: '555-123-4567',
      visitor_type: 'Parent / Guardian',
      program_interest: 'Youth Development',
      preferred_contact_method: 'Email',
      message: 'Interested in the youth program.',
      consent_to_contact: true,
      review_state: 'new',
      reviewed_by_account_id: null,
      reviewed_at: null,
      created_at: '2026-07-27T00:00:00.000Z',
    });

    const result = await createPublicInterestSubmission(validInput());

    expect(result.submission_id).toBe('sub-1');
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(String(sql)).toContain('insert into pilot.public_interest_submissions');
    expect(params?.[0]).toBe('org-default');
  });

  test('never reaches the database for an invalid submission', async () => {
    await expect(createPublicInterestSubmission(validInput({ consentToContact: false })))
      .rejects.toBeInstanceOf(PublicInterestValidationError);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });
});

import { NextRequest } from 'next/server';

import { POST } from './route';
import { createPublicInterestSubmission } from '@/src/server/pilot/publicInterest';

// The real validation runs (it is what used to refuse a submission without
// consent); only the database insert is replaced.
jest.mock('@/src/server/pilot/publicInterest', () => {
  const actual = jest.requireActual('@/src/server/pilot/publicInterest');
  return {
    ...actual,
    createPublicInterestSubmission: jest.fn(async (input) => {
      actual.validatePublicInterestSubmission(input);
      return { submission_id: 'sub-1' };
    }),
  };
});

jest.mock('@/src/server/pilot/rateLimit', () => ({
  getClientIp: () => '203.0.113.1',
  reserveAttempts: jest.fn(async () => ({ isLimited: false })),
}));

const create = createPublicInterestSubmission as jest.Mock;

function post(body: unknown) {
  return POST(new NextRequest('http://localhost/api/pilot/public-interest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

const visitor = {
  full_name: 'Pat Example',
  email: 'pat@example.com',
  visitor_type: 'Parent / Guardian',
  program_interest: 'Youth Development',
  preferred_contact_method: 'Email',
};

beforeEach(() => create.mockClear());

test('a submission with no consent field is accepted: sending is the request to be contacted', async () => {
  const response = await post(visitor);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, submissionId: 'sub-1' });
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ consentToContact: true }));
});

test('an older client sending consent_to_contact false is still accepted and recorded as a request', async () => {
  const response = await post({ ...visitor, consent_to_contact: false });
  expect(response.status).toBe(200);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ consentToContact: true }));
});

test('validation still refuses a missing email', async () => {
  const response = await post({ ...visitor, email: undefined });
  expect(response.status).toBe(400);
  expect(create).not.toHaveBeenCalled();
});

test('validation still refuses an unknown visitor type', async () => {
  const response = await post({ ...visitor, visitor_type: 'Hacker' });
  expect(response.status).toBe(400);
});

test('the honeypot still swallows bot submissions without storing them', async () => {
  const response = await post({ ...visitor, website: 'http://spam.example' });
  expect(await response.json()).toEqual({ ok: true });
  expect(create).not.toHaveBeenCalled();
});

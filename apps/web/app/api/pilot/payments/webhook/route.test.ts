import { createHmac } from 'node:crypto';

import { NextRequest } from 'next/server';

import { POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import {
  markAccountDisconnected,
  readPaymentPlatformConfig,
} from '@/src/server/pilot/paymentConnect';

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

jest.mock('@/src/server/pilot/paymentConnect', () => {
  const actual = jest.requireActual('@/src/server/pilot/paymentConnect');
  return {
    ...actual,
    readPaymentPlatformConfig: jest.fn(),
    markAccountDisconnected: jest.fn(),
  };
});

const mockConfig = readPaymentPlatformConfig as jest.Mock;
const mockDisconnect = markAccountDisconnected as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

const SECRET = 'whsec_test';

afterEach(() => {
  jest.clearAllMocks();
});

function signedRequest(body: string, options: { signature?: string } = {}): NextRequest {
  const timestamp = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
  return new NextRequest('https://gym.example/api/pilot/payments/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': options.signature ?? `t=${timestamp},v1=${v1}` },
    body,
  });
}

function configured() {
  mockConfig.mockReturnValue({ connectClientId: 'ca_1', platformSecretKey: 'sk_1', webhookSecret: SECRET });
}

test('an unconfigured webhook answers 503, not a silent 200', async () => {
  mockConfig.mockReturnValue({ connectClientId: null, platformSecretKey: null, webhookSecret: null });

  const response = await POST(signedRequest('{}'));

  expect(response.status).toBe(503);
});

test('a bad signature is a 400 and touches nothing', async () => {
  configured();

  const response = await POST(signedRequest('{"type":"account.application.deauthorized","account":"acct_1"}', {
    signature: 't=1,v1=deadbeef',
  }));

  expect(response.status).toBe(400);
  expect(mockDisconnect).not.toHaveBeenCalled();
});

test('deauthorization marks every lane the account backed and audits each', async () => {
  configured();
  mockDisconnect.mockResolvedValue([
    { organization_id: 'org-1', lane: 'giving', stripe_account_id: 'acct_1' },
  ]);

  const response = await POST(signedRequest('{"type":"account.application.deauthorized","account":"acct_1"}'));
  const payload = await response.json();

  expect(response.status).toBe(200);
  expect(payload.handled).toBe(true);
  expect(mockDisconnect).toHaveBeenCalledWith('acct_1');
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    event_type: 'payment_account_disconnected',
    organization_id: 'org-1',
    actor_account_id: null,
  }));
});

test('an account not on file is rejected, not guessed at', async () => {
  configured();
  mockDisconnect.mockResolvedValue([]);

  const response = await POST(signedRequest('{"type":"account.application.deauthorized","account":"acct_unknown"}'));

  expect(response.status).toBe(400);
  expect(mockAudit).not.toHaveBeenCalled();
});

test('other event types are acknowledged and deliberately unhandled', async () => {
  configured();

  const response = await POST(signedRequest('{"type":"payment_intent.succeeded","account":"acct_1"}'));
  const payload = await response.json();

  expect(response.status).toBe(200);
  expect(payload.handled).toBe(false);
  expect(mockDisconnect).not.toHaveBeenCalled();
});

import { NextRequest } from 'next/server';

import { POST } from './route';

jest.mock('@/src/server/pilot/rateLimit', () => ({
  getClientIp: jest.fn(() => '127.0.0.1'),
  checkRateLimit: jest.fn(() => ({ isLimited: false })),
  recordFailedAttempt: jest.fn(),
  clearRateLimit: jest.fn(),
}));

describe('POST /api/pilot/admin/bootstrap', () => {
  const originalKey = process.env.PPBF_PILOT_BOOTSTRAP_KEY;

  beforeEach(() => {
    process.env.PPBF_PILOT_BOOTSTRAP_KEY = 'valid-key';
  });

  afterEach(() => {
    process.env.PPBF_PILOT_BOOTSTRAP_KEY = originalKey;
  });

  test('rejects legacy privileged local-PIN bootstrap path', async () => {
    const request = new NextRequest('http://localhost/api/pilot/admin/bootstrap', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ppbf-bootstrap-key': 'valid-key',
      },
      body: JSON.stringify({
        account_id: 'admin-1',
        pin: '123456',
        organization_id: 'org-1',
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Unsupported bootstrap path: privileged accounts must be Microsoft-authenticated. Use /api/pilot/admin/bootstrap/platform-owner-microsoft',
    });
  });
});

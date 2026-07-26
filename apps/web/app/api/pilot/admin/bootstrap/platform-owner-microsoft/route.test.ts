import { NextRequest } from 'next/server';

import { POST } from './route';

describe('POST /api/pilot/admin/bootstrap/platform-owner-microsoft', () => {
  const originalKey = process.env.PPBF_PILOT_BOOTSTRAP_KEY;

  beforeEach(() => {
    process.env.PPBF_PILOT_BOOTSTRAP_KEY = 'valid-key';
  });

  afterEach(() => {
    process.env.PPBF_PILOT_BOOTSTRAP_KEY = originalKey;
  });

  test('requires explicit control-plane intent header', async () => {
    const request = new NextRequest('http://localhost/api/pilot/admin/bootstrap/platform-owner-microsoft', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ppbf-bootstrap-key': 'valid-key',
      },
      body: JSON.stringify({ organization_id: 'org-1' }),
    });

    const response = await POST(request);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Forbidden: control plane intent required',
    });
  });
});
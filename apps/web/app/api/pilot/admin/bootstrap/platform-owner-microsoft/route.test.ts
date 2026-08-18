import { NextRequest } from 'next/server';

import { POST } from './route';
import {
  createOrUpdateMicrosoftPlatformOwnerAccount,
  createOrganization,
} from '@/src/server/pilot/auth';
import { checkDurableRateLimit } from '@/src/server/pilot/rateLimit';

jest.mock('@/src/server/pilot/auth', () => {
  const actual = jest.requireActual('@/src/server/pilot/auth');
  return {
    getPrimaryOwnerEmail: actual.getPrimaryOwnerEmail,
    createOrganization: jest.fn().mockResolvedValue(undefined),
    createOrUpdateMicrosoftPlatformOwnerAccount: jest.fn().mockResolvedValue({
      accountId: 'owner-account',
      organizationId: 'ppbf-default-org',
      created: true,
    }),
  };
});

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/env', () => ({
  getPilotDefaultOrganizationId: () => 'ppbf-default-org',
}));

jest.mock('@/src/server/pilot/http', () => ({
  jsonError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith('Forbidden') ? 403 : message.startsWith('Missing') ? 400 : 500;
    return new Response(JSON.stringify({ error: message }), { status });
  },
}));

jest.mock('@/src/server/pilot/rateLimit', () => ({
  getClientIp: () => '203.0.113.1',
  checkRateLimit: () => ({ isLimited: false }),
  recordFailedAttempt: jest.fn(),
  clearRateLimit: jest.fn(),
  checkDurableRateLimit: jest.fn(async () => ({ isLimited: false })),
  recordDurableFailedAttempt: jest.fn(async () => ({ delayMs: 1000 })),
  clearDurableRateLimit: jest.fn(async () => undefined),
}));

jest.mock('@/src/server/pilot/security', () => ({
  bootstrapKeyMatches: () => true,
}));

const mockCreateOrganization = createOrganization as jest.Mock;
const mockCreateOwner = createOrUpdateMicrosoftPlatformOwnerAccount as jest.Mock;
const mockCheckDurable = checkDurableRateLimit as jest.Mock;

const originalPrimaryOwnerEmail = process.env.PPBF_PRIMARY_OWNER_EMAIL;
const originalBootstrapKey = process.env.PPBF_PILOT_BOOTSTRAP_KEY;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeEach(() => {
  process.env.PPBF_PILOT_BOOTSTRAP_KEY = 'bootstrap-key';
});

afterEach(() => {
  jest.clearAllMocks();
});

afterAll(() => {
  restoreEnv('PPBF_PRIMARY_OWNER_EMAIL', originalPrimaryOwnerEmail);
  restoreEnv('PPBF_PILOT_BOOTSTRAP_KEY', originalBootstrapKey);
});

function request() {
  return new NextRequest('https://ppbf.example/api/pilot/admin/bootstrap/platform-owner-microsoft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

describe('POST /api/pilot/admin/bootstrap/platform-owner-microsoft', () => {
  // Bootstrap and Microsoft sign-in must resolve the owner identity the same
  // way; a bootstrap that writes a different address provisions an account
  // that the callback then refuses.
  test('provisions the configured owner identity, lowercased', async () => {
    process.env.PPBF_PRIMARY_OWNER_EMAIL = '  Owner@Example.COM ';

    const response = await POST(request());
    const payload = (await response.json()) as { login_email?: string };

    expect(response.status).toBe(200);
    expect(payload.login_email).toBe('owner@example.com');
    expect(mockCreateOwner).toHaveBeenCalledWith(expect.objectContaining({
      loginEmail: 'owner@example.com',
      accountIdHint: 'owner@example.com',
    }));
    expect(mockCreateOrganization).toHaveBeenCalledWith(
      'ppbf-default-org',
      expect.any(String),
      'owner@example.com',
    );
  });

  test('falls back to the same default the sign-in callback uses', async () => {
    delete process.env.PPBF_PRIMARY_OWNER_EMAIL;

    const response = await POST(request());
    const payload = (await response.json()) as { login_email?: string };

    expect(response.status).toBe(200);
    expect(payload.login_email).toBe('admin@punxsyprominence.org');
  });

  // The in-memory limiter alone is per-container; a durable "limited" must
  // refuse the highest-privilege account's own credential guess just as
  // firmly as the volatile one does, and before the key comparison runs.
  test('a durable-limited IP is refused before the bootstrap key is even checked', async () => {
    mockCheckDurable.mockResolvedValueOnce({ isLimited: true });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(mockCreateOwner).not.toHaveBeenCalled();
  });
});

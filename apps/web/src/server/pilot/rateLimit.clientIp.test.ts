import { getClientIp } from './rateLimit';

// getClientIp keys every per-IP throttle bucket (PIN login, activation-code
// entry, the unauthenticated public-interest form). If a client can choose the
// value, it can hand itself a fresh bucket on every request and the throttle
// stops existing. Nothing covered this function until an audit found the
// index arithmetic trusted one hop too many.

function requestWith(headers: Record<string, string>): Request {
  return new Request('https://example.org/api/pilot/auth/login', { headers });
}

describe('getClientIp trusts only what a proxy actually appended', () => {
  const originalTrustedProxyCount = process.env.PPBF_TRUSTED_PROXY_COUNT;

  afterEach(() => {
    if (originalTrustedProxyCount === undefined) {
      delete process.env.PPBF_TRUSTED_PROXY_COUNT;
    } else {
      process.env.PPBF_TRUSTED_PROXY_COUNT = originalTrustedProxyCount;
    }
  });

  test('a fabricated left-hand entry cannot become the bucket key', () => {
    // One trusted hop (the default, and what Azure Container Apps ingress is):
    // the client wrote 'junk', the ingress appended the address it saw.
    delete process.env.PPBF_TRUSTED_PROXY_COUNT;
    expect(getClientIp(requestWith({ 'x-forwarded-for': 'junk, 203.0.113.7' }))).toBe('203.0.113.7');
  });

  test('a long forged chain still resolves to the appended address', () => {
    delete process.env.PPBF_TRUSTED_PROXY_COUNT;
    const forged = '1.1.1.1, 2.2.2.2, 3.3.3.3, 198.51.100.9';
    expect(getClientIp(requestWith({ 'x-forwarded-for': forged }))).toBe('198.51.100.9');
  });

  test('two trusted hops step back exactly two entries', () => {
    process.env.PPBF_TRUSTED_PROXY_COUNT = '2';
    expect(
      getClientIp(requestWith({ 'x-forwarded-for': 'junk, 203.0.113.7, 10.0.0.5' })),
    ).toBe('203.0.113.7');
  });

  test('a single-entry header is the appended address, not client data', () => {
    delete process.env.PPBF_TRUSTED_PROXY_COUNT;
    expect(getClientIp(requestWith({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  test('zero trusted hops ignores the header entirely rather than trusting it', () => {
    // No hop appends on our side, so every entry is client-written. Falling
    // back to x-real-ip (or 'unknown') is the only safe reading.
    process.env.PPBF_TRUSTED_PROXY_COUNT = '0';
    expect(
      getClientIp(requestWith({ 'x-forwarded-for': 'junk, 203.0.113.7', 'x-real-ip': '198.51.100.2' })),
    ).toBe('198.51.100.2');
    expect(getClientIp(requestWith({ 'x-forwarded-for': 'junk' }))).toBe('unknown');
  });

  test('ports and bracketed IPv6 are normalized away', () => {
    delete process.env.PPBF_TRUSTED_PROXY_COUNT;
    expect(getClientIp(requestWith({ 'x-forwarded-for': 'junk, 203.0.113.7:44321' }))).toBe('203.0.113.7');
    expect(getClientIp(requestWith({ 'x-forwarded-for': 'junk, [2001:db8::1]:443' }))).toBe('2001:db8::1');
  });

  test('no forwarding headers at all yields the unknown bucket', () => {
    expect(getClientIp(requestWith({}))).toBe('unknown');
  });
});

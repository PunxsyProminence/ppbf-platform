// Pins the baseline browser defenses in next.config.ts. These headers are
// the application's only header layer -- the container-app ingress and the
// static-web-app config inject none -- so a regression here is a regression
// in production, and this suite is what fails if a directive is dropped or
// quietly widened. NODE_ENV is 'test' when this runs, which takes the
// production branch of the config: what is pinned here is what ships.

import nextConfig from '../next.config';

async function resolveHeaders(): Promise<Map<string, string>> {
  const rules = await nextConfig.headers!();
  expect(rules).toHaveLength(1);
  expect(rules[0].source).toBe('/:path*');
  return new Map(rules[0].headers.map((h) => [h.key, h.value]));
}

test('every baseline defense is present on every route', async () => {
  const headers = await resolveHeaders();

  expect([...headers.keys()].sort()).toEqual([
    'Content-Security-Policy',
    'Permissions-Policy',
    'Referrer-Policy',
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'X-Frame-Options',
  ]);
  expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(headers.get('X-Frame-Options')).toBe('DENY');
  expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  expect(headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
  expect(headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
});

test('the production CSP stays as narrow as the app inventory allows', async () => {
  const headers = await resolveHeaders();
  const csp = headers.get('Content-Security-Policy')!;

  // The inventory (2026-08-15): local fonts, app-served images with
  // data:/blob: previews, blob-SAS video as the only external origin,
  // same-origin fetches, OAuth via top-level navigation. Nothing else may
  // creep in without this test naming it.
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("media-src 'self' blob: https://*.blob.core.windows.net");
  expect(csp).toContain("img-src 'self' data: blob:");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("font-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'self'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).toContain("frame-ancestors 'none'");

  // Documented, deliberate width: Next's hydration bootstrap is an inline
  // script and its styling pipeline emits inline styles, so both carry
  // 'unsafe-inline' until a nonce migration. What must NEVER appear in the
  // production policy: eval, wildcards, or any frame allowance.
  expect(csp).toContain("script-src 'self' 'unsafe-inline'");
  expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  expect(csp).not.toContain('unsafe-eval');
  expect(csp).not.toMatch(/\s\*\s|\s\*;|src \*/);
  expect(csp).not.toContain('frame-src');
});

test('the powered-by banner is off', () => {
  expect(nextConfig.poweredByHeader).toBe(false);
});

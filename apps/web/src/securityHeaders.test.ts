// Pins the baseline browser defenses in next.config.ts. These headers are
// the application's only header layer -- the container-app ingress and the
// static-web-app config inject none -- so a regression here is a regression
// in production, and this suite is what fails if a directive is dropped or
// quietly widened. NODE_ENV is 'test' when this runs, which takes the
// production branch of the config: what is pinned here is what ships.

import nextConfig from '../next.config';

const CAPTURE_ROUTE = '/coach/video-analysis/capture';

/*
 * TWO RULES NOW, AND EXACTLY ONE MUST MATCH ANY PATH.
 *
 * The in-app recorder needs a camera, and Permissions-Policy is a per-response
 * header -- a page served with camera=() can never turn one on later. So the
 * capture surface is its own document and only that document asks for the
 * capability; every other page in the app stays closed.
 *
 * If both rules ever matched one path, Next would emit Permissions-Policy
 * twice and leave the winner to the browser. This helper therefore asserts
 * that precisely one rule matches, which is the property the negative
 * lookahead in next.config.ts exists to provide.
 */
function resolveHeaders(routeRules: Awaited<ReturnType<NonNullable<typeof nextConfig.headers>>>, pathname: string) {
  const matching = routeRules.filter((rule) => {
    if (rule.source === CAPTURE_ROUTE) return pathname === CAPTURE_ROUTE;
    return pathname !== CAPTURE_ROUTE;
  });
  expect(matching).toHaveLength(1);
  return new Map(matching[0].headers.map((h) => [h.key, h.value]));
}

async function headersFor(pathname: string): Promise<Map<string, string>> {
  const rules = await nextConfig.headers!();
  expect(rules).toHaveLength(2);
  return resolveHeaders(rules, pathname);
}

test('every baseline defense is present on every route', async () => {
  const headers = await headersFor('/coach/video-analysis');

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
  const headers = await headersFor('/coach/video-analysis');
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


/*
 * The capture route is the ONLY document that may open a camera, and even
 * there the microphone stays shut: punch recognition must work on silent
 * shadowboxing and in loud gyms, so impact sound would be a shortcut signal
 * rather than something the recognizer should lean on. The recorder asks for a
 * video-only stream, so an open microphone would serve nothing.
 */
test('the capture route opens the camera and nothing else', async () => {
  const headers = await headersFor('/coach/video-analysis/capture');

  expect(headers.get('Permissions-Policy')).toBe('camera=(self), microphone=(), geolocation=()');
});

test('every other route still refuses the camera outright', async () => {
  for (const pathname of ['/', '/coach/video-analysis', '/admin/athlete-consent', '/athlete/dashboard']) {
    const headers = await headersFor(pathname);
    expect(headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
  }
});

/*
 * The capture route is not a hole in anything else. Widening one header on one
 * document must not quietly relax the rest of that document's defenses, so the
 * capture response is asserted to carry the identical CSP, frame and transport
 * protections every other route gets.
 */
test('the capture route keeps every other defense unchanged', async () => {
  const capture = await headersFor('/coach/video-analysis/capture');
  const ordinary = await headersFor('/coach/video-analysis');

  for (const key of [
    'Content-Security-Policy',
    'X-Frame-Options',
    'X-Content-Type-Options',
    'Referrer-Policy',
    'Strict-Transport-Security',
  ]) {
    expect(capture.get(key)).toBe(ordinary.get(key));
  }
  // In particular: recording does not need to talk to anywhere new. The upload
  // still goes to this origin, so direct-to-Blob's CSP widening stays a
  // separate, deliberate act rather than arriving as a side effect of this one.
  expect(capture.get('Content-Security-Policy')).toContain("connect-src 'self'");
});

test('the powered-by banner is off', () => {
  expect(nextConfig.poweredByHeader).toBe(false);
});

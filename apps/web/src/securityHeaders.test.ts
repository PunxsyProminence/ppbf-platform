// Pins the baseline browser defenses in next.config.ts. These headers are
// the application's only header layer -- the container-app ingress and the
// static-web-app config inject none -- so a regression here is a regression
// in production, and this suite is what fails if a directive is dropped or
// quietly widened. NODE_ENV is 'test' when this runs, which takes the
// production branch of the config: what is pinned here is what ships.

import { pathToRegexp } from 'next/dist/compiled/path-to-regexp';
import nextConfig from '../next.config';

/*
 * THE TWO DOCUMENTS THAT MAY OPEN A CAMERA, WRITTEN OUT INDEPENDENTLY.
 *
 * Deliberately not imported from next.config.ts. A test that derives its
 * expectation from the thing it is testing agrees with a typo: rename the
 * route badly in one place and both sides move together, the suite stays
 * green, and the recorder is served a closed policy in production. Spelling
 * them again here is what makes this an independent statement of the rule.
 *
 * Two, not one, because the app records for two purposes the owner has ruled
 * must never mix -- Film Study footage a coach reviews with an athlete, and
 * Teach Shadow footage collected to teach the recognizer. The destination is
 * decided by which document the coach was standing on, so each needs its own.
 */
const CAPTURE_ROUTES = ['/teach-shadow/capture', '/coach/video-analysis/capture'] as const;

/*
 * THE SAME TWO DOCUMENTS, REQUESTED WITH A TRAILING SLASH.
 *
 * path-to-regexp compiles a literal source non-strictly, so the open rule
 * already matches these. The closed rule's lookahead has to exclude them too,
 * or the request matches BOTH rules, Permissions-Policy is emitted twice, and
 * the browser decides -- which is the one outcome this arrangement exists to
 * prevent. The lookahead was anchored with `$` alone and did not, so these are
 * listed rather than left to be assumed.
 */
const CAPTURE_ROUTES_TRAILING_SLASH = CAPTURE_ROUTES.map((route) => `${route}/`);

// Routes that must never be handed a camera. /teach-shadow and
// /teach-shadow/annotation are in here on purpose: they are the new area's
// other two documents, they sit directly beside a route that IS granted the
// camera, and a lookahead written one character too loose would cover them.
const CLOSED_ROUTES = [
	'/',
	'/teach-shadow',
	'/teach-shadow/',
	// A path BELOW a capture route is a different document and stays closed --
	// the lookahead must exclude the trailing slash without swallowing what
	// comes after it.
	'/teach-shadow/capture/preview',
	'/coach/video-analysis/capture/preview',
	'/teach-shadow/annotation',
	'/coach/video-analysis',
	'/coach/calibration',
	'/admin/athlete-consent',
	'/athlete/dashboard',
] as const;

type Rule = Awaited<ReturnType<NonNullable<typeof nextConfig.headers>>>[number];

/*
 * MATCHED THE WAY NEXT MATCHES, not the way this test wishes it did.
 *
 * The previous version of this helper decided which rule applied by comparing
 * the pathname to a route string in JavaScript. That modelled the INTENT of
 * the config and never executed the negative lookahead, so a malformed
 * alternation -- a missing anchor, a stray pipe, a route spelled wrong inside
 * the template literal -- would have passed here and failed in a browser.
 *
 * `source` is run through the same path-to-regexp build Next itself compiles
 * these with, so what is asserted below is the behaviour of the actual string
 * in next.config.ts.
 */
function rulesMatching(rules: readonly Rule[], pathname: string): Rule[] {
	return rules.filter((rule) => pathToRegexp(rule.source).test(pathname));
}

async function headersFor(pathname: string): Promise<Map<string, string>> {
	const rules = await nextConfig.headers!();
	const matching = rulesMatching(rules, pathname);
	// The whole design rests on this: Next applies EVERY matching entry, so a
	// path matched twice gets Permissions-Policy twice and the browser picks.
	expect({ pathname, matched: matching.length }).toEqual({ pathname, matched: 1 });
	return new Map(matching[0]!.headers.map((h) => [h.key, h.value]));
}

test('the config grants the camera to exactly the two capture documents and nothing else', async () => {
	const rules = await nextConfig.headers!();

	// One open rule per capture route, plus the single closed rule.
	expect(rules).toHaveLength(CAPTURE_ROUTES.length + 1);

	const open = rules.filter((rule) =>
		rule.headers.some((h) => h.key === 'Permissions-Policy' && h.value.includes('camera=(self)')));
	expect(open.map((rule) => rule.source).sort()).toEqual([...CAPTURE_ROUTES].sort());
});

test('exactly one rule matches every route the app serves', async () => {
	const rules = await nextConfig.headers!();
	for (const pathname of [...CAPTURE_ROUTES, ...CAPTURE_ROUTES_TRAILING_SLASH, ...CLOSED_ROUTES]) {
		expect({ pathname, matched: rulesMatching(rules, pathname).length })
			.toEqual({ pathname, matched: 1 });
	}
});

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
 * Each capture route is the only kind of document that may open a camera, and
 * even there the microphone stays shut: punch recognition must work on silent
 * shadowboxing and in loud gyms, so impact sound would be a shortcut signal
 * rather than something the recognizer should lean on. Both recorders ask for
 * a video-only stream, so an open microphone would serve nothing.
 */
test.each([...CAPTURE_ROUTES, ...CAPTURE_ROUTES_TRAILING_SLASH])('%s opens the camera and nothing else', async (route) => {
	const headers = await headersFor(route);

	expect(headers.get('Permissions-Policy')).toBe('camera=(self), microphone=(), geolocation=()');
});

test.each(CLOSED_ROUTES)('%s still refuses the camera outright', async (route) => {
	const headers = await headersFor(route);

	expect(headers.get('Permissions-Policy')).toBe('camera=(), microphone=(), geolocation=()');
});

/*
 * A capture route is not a hole in anything else. Widening one header on one
 * document must not quietly relax the rest of that document's defenses, so
 * each capture response is asserted to carry the identical CSP, frame and
 * transport protections every other route gets.
 */
test.each(CAPTURE_ROUTES)('%s keeps every other defense unchanged', async (route) => {
	const capture = await headersFor(route);
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

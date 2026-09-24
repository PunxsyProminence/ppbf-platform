/*
 * Types for the matcher Next compiles route `source` strings with.
 *
 * WHY THE VENDORED COPY AND NOT THE PACKAGE. `path-to-regexp` is present in
 * node_modules as somebody else's transitive dependency, at a major version
 * whose API and matching rules differ from the one Next bundles. Reaching for
 * it would mean securityHeaders.test.ts asserting that the header rules behave
 * under a DIFFERENT regex engine than the one that will serve them -- a test
 * that agrees with production only by luck. Next ships its own build precisely
 * so its matching does not move underneath it, and that build is the one the
 * test has to use.
 *
 * It carries no type declarations, so the single function the test calls is
 * declared here rather than silenced with `any` at the call site.
 */
declare module 'next/dist/compiled/path-to-regexp' {
	export function pathToRegexp(
		path: string | RegExp | Array<string | RegExp>,
		keys?: unknown[],
		options?: { sensitive?: boolean; strict?: boolean; end?: boolean; start?: boolean },
	): RegExp;
}

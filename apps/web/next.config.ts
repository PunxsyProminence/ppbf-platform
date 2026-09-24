import type { NextConfig } from "next";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");
const staticExportEnabled = process.env.NEXT_BUILD_OUTPUT === "export";

// Built from the app's real inventory, not a template (audited 2026-08-15):
// fonts are local (next/font/local + ppbf.css @font-face); images are served
// by the app's own routes (profile/gym photos) or data:/blob: previews;
// video streams from Azure blob storage via short-lived SAS URLs -- the one
// external origin the app genuinely loads from; uploads are multipart POSTs
// to the app itself; Microsoft sign-in and parent magic links are top-level
// navigations, which CSP fetch directives do not govern. script-src carries
// 'unsafe-inline' because Next's hydration bootstrap is an inline script --
// tightening that to nonces is real middleware work, tracked separately, and
// everything else here does not wait for it.
// React's dev mode uses eval() for debugging affordances (its own console
// message says production never does); the allowance exists only there and
// never ships.
const SCRIPT_SRC = process.env.NODE_ENV === "development"
	? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
	: "script-src 'self' 'unsafe-inline'";

const CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	SCRIPT_SRC,
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	`media-src 'self' blob: https://*.blob.core.windows.net`,
	"connect-src 'self'",
	"font-src 'self'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join("; ");

// THE CAMERA IS OFF EVERYWHERE EXCEPT ONE DOCUMENT.
//
// Permissions-Policy is a per-RESPONSE header, which is the fact that shapes
// this: a page served with camera=() can never turn the camera on later, no
// matter what a button on it does. So the in-app recorder cannot be a modal on
// an ordinary page -- it has to be its own document, and only that document
// asks for the capability.
//
// The alternative was camera=(self) for the whole origin, which the owner
// authorized. It is not taken: it would hand the capability to every page in
// the app to serve one, and a cross-site scripting hole anywhere would then
// reach a camera instead of stopping at the DOM.
//
// Microphone stays CLOSED even on the capture route, and that is a product
// decision rather than caution. Punch recognition has to work on silent
// shadowboxing, in loud gyms, and across several cameras hearing different
// sound mixtures; impact sound would offer the model a shortcut instead of
// making it learn the movement. The recorder requests a video-only stream, so
// there is nothing for an open microphone to serve.
const PERMISSIONS_POLICY_CLOSED = "camera=(), microphone=(), geolocation=()";
const PERMISSIONS_POLICY_CAPTURE = "camera=(self), microphone=(), geolocation=()";

// The one document allowed to open a camera. Kept as a constant because the
// header rules below must agree with it exactly: a typo in either would either
// leave the recorder unable to start or open the camera on a route nobody
// examined.
const CAPTURE_ROUTE = "/coach/video-analysis/capture";

function securityHeaders(permissionsPolicy: string) {
	return [
		{ key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
		// Belt to frame-ancestors' braces, for anything old enough to need it.
		{ key: "X-Frame-Options", value: "DENY" },
		{ key: "X-Content-Type-Options", value: "nosniff" },
		{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
		{ key: "Permissions-Policy", value: permissionsPolicy },
		// No includeSubDomains: only the www app origin is known to be HTTPS-only
		// end to end; the apex and any future subdomains are not this config's to
		// commit.
		{ key: "Strict-Transport-Security", value: "max-age=31536000" },
	];
}

const nextConfig: NextConfig = {
	output: staticExportEnabled ? "export" : "standalone",
	// A local replica must not contend with an already-running normal `next dev`
	// process (or reuse its build artifacts). Production keeps Next's default.
	...(process.env.PPBF_OFFLINE_RUNTIME === "true" ? { distDir: ".next-offline" } : {}),
	poweredByHeader: false,
	turbopack: {
		root: repoRoot,
	},
	// headers() applies to the standalone (container app) deployment, which
	// is the live one. The static-export path ignores it; if that path ever
	// ships, staticwebapp.config.json must mirror these.
	async headers() {
		// TWO MUTUALLY EXCLUSIVE RULES, not a general rule plus an override.
		// Next applies every matching entry, so two rules that both matched the
		// capture route would emit Permissions-Policy twice and leave which one
		// wins to the browser. The negative lookahead makes exactly one rule
		// match any given path, so the answer is decided here rather than by a
		// user agent. securityHeaders.test.ts pins both sides.
		return [
			{
				source: CAPTURE_ROUTE,
				headers: securityHeaders(PERMISSIONS_POLICY_CAPTURE),
			},
			{
				source: `/((?!${CAPTURE_ROUTE.slice(1)}$).*)`,
				headers: securityHeaders(PERMISSIONS_POLICY_CLOSED),
			},
		];
	},
};

export default nextConfig;

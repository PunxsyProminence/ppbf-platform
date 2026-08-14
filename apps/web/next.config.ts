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

const SECURITY_HEADERS = [
	{ key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
	// Belt to frame-ancestors' braces, for anything old enough to need it.
	{ key: "X-Frame-Options", value: "DENY" },
	{ key: "X-Content-Type-Options", value: "nosniff" },
	{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
	// The app uses no device APIs (the photo flow is a file input; "camera"
	// in ProfileSettings is prose about EXIF stripping).
	{ key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
	// No includeSubDomains: only the www app origin is known to be HTTPS-only
	// end to end; the apex and any future subdomains are not this config's to
	// commit.
	{ key: "Strict-Transport-Security", value: "max-age=31536000" },
];

const nextConfig: NextConfig = {
	output: staticExportEnabled ? "export" : "standalone",
	poweredByHeader: false,
	turbopack: {
		root: repoRoot,
	},
	// headers() applies to the standalone (container app) deployment, which
	// is the live one. The static-export path ignores it; if that path ever
	// ships, staticwebapp.config.json must mirror these.
	async headers() {
		return [
			{
				source: "/:path*",
				headers: SECURITY_HEADERS,
			},
		];
	},
};

export default nextConfig;

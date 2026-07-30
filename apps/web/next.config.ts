import type { NextConfig } from "next";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");
const staticExportEnabled = process.env.NEXT_BUILD_OUTPUT === "export";

const nextConfig: NextConfig = {
	output: staticExportEnabled ? "export" : "standalone",
	turbopack: {
		root: repoRoot,
	},
};

export default nextConfig;

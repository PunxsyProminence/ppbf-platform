import type { NextConfig } from "next";
import path from "path";

const repoRoot = path.resolve(__dirname, "..", "..");

const nextConfig: NextConfig = {
	output: "standalone",
	turbopack: {
		root: repoRoot,
	},
};

export default nextConfig;

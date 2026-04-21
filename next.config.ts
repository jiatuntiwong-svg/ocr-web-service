import type { NextConfig } from "next";

// Enable calling `getCloudflareContext()` in `next dev`.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
if (process.env.NODE_ENV === "development") {
	initOpenNextCloudflareForDev();
}

const nextConfig: NextConfig = {
	webpack: (config) => {
		// pdfjs-dist v5 optionally requires 'canvas' (Node native module).
		// Not needed in browser context — tell webpack to ignore it.
		config.resolve.alias.canvas = false;
		return config;
	},
	turbopack: {},
};

export default nextConfig;

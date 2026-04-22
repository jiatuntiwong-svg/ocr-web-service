import type { NextConfig } from "next";

// Enable calling `getCloudflareContext()` in `next dev`.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
if (process.env.NODE_ENV === "development") {
	initOpenNextCloudflareForDev();
}

const nextConfig: NextConfig = {
	// These packages contain native .node binaries that cannot run in
	// Cloudflare Workers (V8 isolate). Mark them external so esbuild never
	// tries to bundle them. The code has try/catch fallbacks for when
	// they are unavailable at runtime.
	serverExternalPackages: ["canvas", "tesseract.js", "image-size"],
	webpack: (config) => {
		// pdfjs-dist v5 optionally requires 'canvas' (Node native module).
		// Not needed in browser context — tell webpack to ignore it.
		config.resolve.alias.canvas = false;
		return config;
	},
	turbopack: {},
};

export default nextConfig;

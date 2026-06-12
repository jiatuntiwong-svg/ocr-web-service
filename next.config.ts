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
	// NOTE: do NOT enable turbopack for production build — its chunk runtime
	// is not compatible with Cloudflare Workers via OpenNext (manifests as
	// "Failed to load chunk server/chunks/ssr/..." at runtime). next dev can
	// still use Turbopack; the prod build must use webpack.
};

export default nextConfig;

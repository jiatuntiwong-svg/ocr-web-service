import type { NextConfig } from "next";

// Enable calling `getCloudflareContext()` in `next dev`.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
if (process.env.NODE_ENV === "development") {
	initOpenNextCloudflareForDev();
}

const nextConfig: NextConfig = {
	/* config options here */
};

export default nextConfig;

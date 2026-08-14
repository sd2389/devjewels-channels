import type { NextConfig } from "next";
import { loadEnvConfig } from "@next/env";
import path from "node:path";

/**
 * Monorepo: `next dev` runs from apps/core, but shared secrets live in
 * repo-root `.env`. loadEnvConfig here helps next.config itself; route
 * handlers still cannot see those keys (Next allowlists apps/core/.env*).
 * Runtime reads go through `src/config/serverEnv.ts`.
 */
const monorepoRoot = path.join(__dirname, "../..");
loadEnvConfig(monorepoRoot);

/**
 * Allow DevJewels admin to embed this dashboard in an iframe.
 * Override with CHANNELS_FRAME_ANCESTORS (space-separated origins).
 */
const frameAncestors =
  process.env.CHANNELS_FRAME_ANCESTORS?.trim() ||
  "'self' http://localhost:3000 http://127.0.0.1:3000 https://*.devjewels.com";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `frame-ancestors ${frameAncestors}`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;

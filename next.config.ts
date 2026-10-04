import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // OAuth callback query strings must not enter development request logs.
  logging: { incomingRequests: false },
  serverExternalPackages: ["@whiskeysockets/baileys", "jimp"],
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;

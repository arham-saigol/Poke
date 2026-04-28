import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: [
    "@poke/agent-runtime",
    "@poke/automations",
    "@poke/channels",
    "@poke/connectors",
    "@poke/memory",
    "@poke/skills",
    "@poke/storage",
    "@mariozechner/pi-ai"
  ],
  transpilePackages: [],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
        ]
      }
    ];
  }
};

export default nextConfig;

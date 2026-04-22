import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["puppeteer"],
  experimental: {
    serverActions: { bodySizeLimit: "4mb" },
  },
};

export default nextConfig;

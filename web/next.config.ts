import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg is a Node-only driver; keep it out of the bundler.
  serverExternalPackages: ["pg"],
  // The repo root has its own package-lock.json (the voice server); this app's root is here.
  turbopack: { root: __dirname },
};

export default nextConfig;

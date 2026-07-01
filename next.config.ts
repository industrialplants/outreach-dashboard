import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module — keep it out of the Turbopack/webpack bundle
  // so its `.node` binary is loaded via Node's require at runtime.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;

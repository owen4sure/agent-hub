import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname),
  },
  // Runtime data can contain user workflows, screenshots, generated files and
  // credentials-backed run context. It belongs beside the self-hosted process,
  // never inside a production server bundle or its file trace.
  outputFileTracingExcludes: {
    "/*": ["./data/**/*"],
  },
};

export default nextConfig;

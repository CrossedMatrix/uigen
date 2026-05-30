// Load the Node 25+ Web Storage shim first. Next loads this config before
// any app code, so importing here is early enough — and unlike the previous
// NODE_OPTIONS='--require …' approach, this works on Windows.
import "./node-compat.cjs";

// Allow the IBKR CP Gateway's self-signed TLS certificate on localhost:4002.
// next.config is the earliest execution point in the Next.js process, so
// setting the flag here ensures every subsequent fetch / https.request call
// (including Turbopack's internal keep-alive connections) skips cert rejection.
if (process.env.NODE_ENV === 'development') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // Pin the workspace root so a stray yarn.lock or package.json elsewhere
  // on the learner's machine can't hijack Turbopack's module resolution.
  // resolveAlias pins @prisma/client to its resolved path so Turbopack's
  // module graph never attempts to trace into the .prisma/client engine
  // binaries directory (bypasses the NFT directory trace error on Vercel).
  turbopack: {
    root: process.cwd(),
    resolveAlias: {
      '@prisma/client': require.resolve('@prisma/client'),
    },
  },
  // Keep @prisma/client external so Next.js skips bundling it and avoids the
  // NFT (nft-trace) directory scan that causes build errors on Vercel.
  serverExternalPackages: ['@prisma/client'],
};

export default nextConfig;

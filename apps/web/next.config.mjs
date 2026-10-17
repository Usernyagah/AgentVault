import path from "node:path";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { loadEnvConfig } = nextEnv;
loadEnvConfig(repoRoot);

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: repoRoot,
  transpilePackages: ["@agentvault/shared"],
  serverExternalPackages: [
    "@agentvault/agent-core",
    "@circle-fin/developer-controlled-wallets",
    "@circle-fin/smart-contract-platform",
    "@circle-fin/user-controlled-wallets",
    "openai",
    "viem",
  ],
};

export default nextConfig;

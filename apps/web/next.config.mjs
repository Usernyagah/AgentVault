import path from "node:path";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@agentvault/shared"],
  async rewrites() {
    // Skip rewrites in Vercel Services deployment (API is on same domain)
    if (process.env.VERCEL === "1") {
      return [];
    }

    const apiBase = (
      process.env.AGENTVAULT_API_URL ||
      process.env.NEXT_PUBLIC_API_URL ||
      "http://localhost:4000"
    ).replace(/\/+$/, "");

    return [
      {
        source: "/api/:path*",
        destination: `${apiBase}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;

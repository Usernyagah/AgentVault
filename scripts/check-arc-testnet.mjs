import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const expectedChainId = 5042002n;
const defaultRpcUrl = "https://rpc.testnet.arc.io";

function readDotEnv(contents) {
  const values = new Map();
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    values.set(match[1], value);
  }
  return values;
}

let fileValues = new Map();
try {
  fileValues = readDotEnv(await readFile(resolve(".env"), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const rpcUrl = process.env.ARC_RPC_URL || fileValues.get("ARC_RPC_URL") || defaultRpcUrl;
let rpcLabel = "configured RPC";
try {
  const parsed = new URL(rpcUrl);
  rpcLabel = `${parsed.origin}${parsed.pathname === "/" ? "" : "/[redacted-path]"}`;
} catch {
  console.error("ARC_RPC_URL must be a valid URL.");
  process.exit(1);
}
const configuredChainId = process.env.ARC_CHAIN_ID || fileValues.get("ARC_CHAIN_ID");
if (configuredChainId && Number(configuredChainId) !== Number(expectedChainId)) {
  console.error(`ARC_CHAIN_ID is ${configuredChainId}; Arc testnet requires ${expectedChainId}.`);
  process.exit(1);
}

let response;
try {
  response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    signal: AbortSignal.timeout(10_000),
  });
} catch (error) {
  console.error(`Could not reach Arc RPC ${rpcLabel}: ${String(error)}`);
  process.exit(1);
}

if (!response.ok) {
  console.error(`Arc RPC ${rpcLabel} returned HTTP ${response.status}.`);
  process.exit(1);
}

const result = await response.json();
if (result.error) {
  console.error(`Arc RPC returned an error: ${result.error.message ?? JSON.stringify(result.error)}`);
  process.exit(1);
}
if (typeof result.result !== "string" || !/^0x[0-9a-f]+$/i.test(result.result)) {
  console.error("Arc RPC returned an invalid eth_chainId response.");
  process.exit(1);
}

const actualChainId = BigInt(result.result);
if (actualChainId !== expectedChainId) {
  console.error(
    `RPC network mismatch: ${rpcLabel} reported chain ID ${actualChainId}; expected Arc testnet ${expectedChainId}.`
  );
  process.exit(1);
}

console.log(`Arc testnet preflight passed (${rpcLabel}, chain ID ${actualChainId}).`);

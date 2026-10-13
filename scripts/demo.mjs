import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tscCli = resolve(root, "node_modules/typescript/bin/tsc");
const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
const nextCli = resolve(root, "node_modules/next/dist/bin/next");
const apiUrl = "http://localhost:4000";
const webUrl = "http://localhost:3000";
const children = [];
let shuttingDown = false;

function start(name, cli, args, cwd) {
  const child = spawn(process.execPath, [cli, ...args], {
    stdio: "inherit",
    cwd: resolve(root, cwd),
    env: process.env,
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(`Unable to start ${name}:`, error);
    shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (!shuttingDown && (code ?? 0) !== 0) {
      console.error(`${name} exited (${signal ?? code}). Stopping demo services.`);
      shutdown(code ?? 1);
    }
  });
  return child;
}

function waitForExit(child, name) {
  return new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} failed (${signal ?? code}).`));
    });
  });
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const activePids = children
    .map((child) => child.pid)
    .filter((pid) => pid && children.some((child) => child.pid === pid && child.exitCode === null));

  if (process.platform === "win32" && activePids.length > 0) {
    const roots = activePids.join(",");
    const script = `
      $ErrorActionPreference = 'Stop'
      $roots = @(${roots})
      $all = @(Get-CimInstance Win32_Process)
      $targets = [System.Collections.Generic.List[int]]::new()
      function Add-Children([int]$parentId) {
        foreach ($item in $all) {
          if ([int]$item.ParentProcessId -eq $parentId -and -not $targets.Contains([int]$item.ProcessId)) {
            Add-Children ([int]$item.ProcessId)
            $targets.Add([int]$item.ProcessId)
          }
        }
      }
      foreach ($root in $roots) { Add-Children $root }
      foreach ($id in $targets) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
      foreach ($root in $roots) { Stop-Process -Id $root -Force -ErrorAction SilentlyContinue }
    `;
    const result = spawnSync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ], { encoding: "utf8" });
    if (result.error || result.status !== 0) {
      console.error("Unable to stop the complete demo process tree:", result.error ?? result.stderr);
      for (const child of children) {
        if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      }
    }
  } else {
    for (const child of children) {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    }
  }
  process.exitCode = exitCode;
}

async function waitFor(url, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (response.ok) return;
      lastError = new Error(`${label} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} did not become ready: ${String(lastError)}`);
}

async function assertPortAvailable(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

try {
  await assertPortAvailable(4000);
  await assertPortAvailable(3000);

  console.log("Preparing workspace packages…");
  const build = start("workspace typecheck", tscCli, ["--build"], root);
  await waitForExit(build, "Workspace typecheck");

  console.log("Starting AgentVault API…");
  start("API", tsxCli, ["src/index.ts"], "apps/api");
  await waitFor(`${apiUrl}/health`, "API");

  const toggleResponse = await fetch(`${apiUrl}/api/demo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  const toggleBody = await toggleResponse.json();
  if (!toggleResponse.ok || !toggleBody.success) {
    throw new Error(toggleBody.error ?? `Demo Mode request failed (${toggleResponse.status}).`);
  }

  console.log("Starting dashboard…");
  start("dashboard", nextCli, ["dev", "--port", "3000"], "apps/web");
  await waitFor(webUrl, "Dashboard");

  console.log(`
AgentVault Demo Mode is ready.
  Dashboard: ${webUrl}
  API health: ${apiUrl}/health

Synthetic demo balances, decisions, and approvals are enabled.
No transaction will be sent to Arc. Press Ctrl+C to stop both services.
`);
} catch (error) {
  console.error("Unable to start the AgentVault demo:", error);
  shutdown(1);
}

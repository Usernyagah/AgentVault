import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: resolve(root, ".env") });
const tscCli = resolve(root, "node_modules/typescript/bin/tsc");
const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
const nextCli = resolve(root, "node_modules/next/dist/bin/next");
const apiPort = Number(process.env.API_PORT || 4000);
const webPort = 3000;
const children = [];
let shuttingDown = false;

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
    const result = spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8" }
    );
    if (result.error || result.status !== 0) {
      console.error("Unable to stop the complete application process tree:", result.error ?? result.stderr);
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

function assertPortAvailable(port) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => (error ? reject(error) : resolvePromise()));
    });
  });
}

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
    if (!shuttingDown) {
      console.error(`${name} exited (${signal ?? code}). Stopping the application.`);
      shutdown(1);
    }
  });
  return child;
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
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error(`${label} did not become ready: ${String(lastError)}`);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

try {
  await Promise.all([assertPortAvailable(apiPort), assertPortAvailable(webPort)]);

  console.log("Preparing shared workspace packages…");
  const build = spawnSync(process.execPath, [tscCli, "--build"], {
    stdio: "inherit",
    cwd: root,
    env: process.env,
  });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error(`Workspace build failed (${build.status ?? build.signal}).`);

  console.log("Starting API and dashboard…");
  start("API", tsxCli, ["watch", "src/index.ts"], "apps/api");
  start("Dashboard", nextCli, ["dev", "--port", String(webPort)], "apps/web");

  await Promise.all([
    waitFor(`http://localhost:${apiPort}/health`, "API"),
    waitFor(`http://localhost:${webPort}`, "Dashboard"),
  ]);

  console.log(`
AgentVault is ready.
  Dashboard: http://localhost:${webPort}
  API health: http://localhost:${apiPort}/health

Press Ctrl+C to stop both services.
`);
} catch (error) {
  console.error("Unable to start AgentVault:", error);
  shutdown(1);
}

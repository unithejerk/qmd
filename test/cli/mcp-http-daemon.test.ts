/**
 * Tests for MCP HTTP daemon lifecycle (qmd mcp --http --daemon).
 *
 * Verifies foreground HTTP server startup with /health and /mcp endpoints,
 * --index selection, --port override, --daemon PID file management,
 * stale PID cleanup, duplicate daemon rejection, and qmd mcp stop.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { chmod, copyFile, mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { setTimeout as sleep } from "timers/promises";
import { runQmd, qmdRunnerArgs, setupCliTestEnv, teardownCliTestEnv, createIsolatedTestEnv } from "../helpers/cli.js";
import { writeFileSync } from "fs";
import { readFileSync } from "fs";
import { unlinkSync } from "fs";
import { spawn } from "child_process";

// Module-level constants (same as original test/cli.test.ts)
const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(thisDir, "..", "..");

let testDir: string;
let dbPath: string;
let configDir: string;
let fixturesDir: string;

beforeAll(async () => {
  const env = await setupCliTestEnv();
  testDir = env.testDir;
  dbPath = env.dbPath;
  configDir = env.configDir;
  fixturesDir = env.fixturesDir;
});

afterAll(async () => {
  await teardownCliTestEnv(testDir);
});

beforeEach(async () => {
  await writeFile(join(configDir, "index.yml"), "collections: {}\n");
});

// Thin wrapper that injects dbPath + configDir so test bodies can call qmd(args)
// the same way they called runQmd(args) with module-level defaults.
async function qmd(args: string[], opts: { cwd?: string; env?: Record<string, string>; dbPath?: string; configDir?: string } = {}) {
  return runQmd(args, { dbPath: opts.dbPath || dbPath, configDir: opts.configDir || configDir, cwd: opts.cwd || fixturesDir, env: opts.env });
}


// =============================================================================
// MCP HTTP Daemon Lifecycle
// =============================================================================

describe("mcp http daemon", () => {
  let daemonTestDir: string;
  let daemonCacheDir: string; // XDG_CACHE_HOME value (the qmd/ subdir is created automatically)
  let daemonDbPath: string;
  let daemonConfigDir: string;

  // Track spawned PIDs for cleanup
  const spawnedPids: number[] = [];

  /** Get path to PID file inside the test cache dir */
  function pidPath(): string {
    return join(daemonCacheDir, "qmd", "mcp.pid");
  }

  /** Run qmd with test-isolated env (cache, db, config) */
  async function runDaemonQmd(
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return qmd(args, {
      dbPath: daemonDbPath,
      configDir: daemonConfigDir,
      env: { XDG_CACHE_HOME: daemonCacheDir },
    });
  }

  /** Spawn a foreground HTTP server (non-blocking) and return the process */
  function spawnHttpServer(
    port: number,
    options: { args?: string[]; env?: Record<string, string> } = {},
  ): import("child_process").ChildProcess {
    const runner = qmdRunnerArgs([...(options.args ?? []), "mcp", "--http", "--port", String(port)]);
    const proc = spawn(runner.command, runner.args, {
      cwd: fixturesDir,
      env: {
        ...process.env,
        INDEX_PATH: daemonDbPath,
        QMD_CONFIG_DIR: daemonConfigDir,
        PWD: fixturesDir,
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (proc.pid) spawnedPids.push(proc.pid);
    return proc;
  }

  /** Wait for HTTP server to become ready */
  async function waitForServer(port: number, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://localhost:${port}/health`);
        if (res.ok) return true;
      } catch { /* not ready yet */ }
      await sleep(200);
    }
    return false;
  }

  /** Pick a random high port unlikely to conflict */
  function randomPort(): number {
    return 10000 + Math.floor(Math.random() * 50000);
  }

  beforeAll(async () => {
    daemonTestDir = await mkdtemp(join(tmpdir(), "qmd-daemon-test-"));
    daemonCacheDir = join(daemonTestDir, "cache");
    daemonDbPath = join(daemonTestDir, "test.sqlite");
    daemonConfigDir = join(daemonTestDir, "config");

    await mkdir(join(daemonCacheDir, "qmd"), { recursive: true });
    await mkdir(daemonConfigDir, { recursive: true });
    await writeFile(join(daemonConfigDir, "index.yml"), "collections: {}\n");
  });

  afterAll(async () => {
    // Kill any leftover spawned processes
    for (const pid of spawnedPids) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
    }
    // Also clean up via PID file if present
    try {
      const pf = pidPath();
      if (existsSync(pf)) {
        const pid = parseInt(readFileSync(pf, "utf-8").trim());
        try { process.kill(pid, "SIGTERM"); } catch {}
        unlinkSync(pf);
      }
    } catch {}

    await rm(daemonTestDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Foreground HTTP
  // -------------------------------------------------------------------------

  test("foreground HTTP server starts and responds to health check", async () => {
    const port = randomPort();
    const proc = spawnHttpServer(port);

    try {
      const ready = await waitForServer(port);
      expect(ready).toBe(true);

      const res = await fetch(`http://localhost:${port}/health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ok");
    } finally {
      const closed = new Promise(r => proc.once("close", r));
      proc.kill("SIGTERM");
      await closed;
    }
  });

  test("foreground HTTP server honors --index when selecting the store", async () => {
    const customIndex = "mcp-alt-index";
    const customCacheDir = join(daemonTestDir, `cache-index-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const customConfigDir = join(daemonTestDir, `config-index-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(customCacheDir, { recursive: true });
    await mkdir(customConfigDir, { recursive: true });

    const addResult = await qmd(
      ["--index", customIndex, "collection", "add", fixturesDir, "--name", "mcp-fixtures"],
      {
        dbPath: daemonDbPath,
        configDir: customConfigDir,
        env: {
          INDEX_PATH: "",
          XDG_CACHE_HOME: customCacheDir,
        },
      },
    );
    expect(addResult.exitCode).toBe(0);

    const updateResult = await qmd(
      ["--index", customIndex, "update"],
      {
        dbPath: daemonDbPath,
        configDir: customConfigDir,
        env: {
          INDEX_PATH: "",
          XDG_CACHE_HOME: customCacheDir,
        },
      },
    );
    expect(updateResult.exitCode).toBe(0);

    const port = randomPort();
    const proc = spawnHttpServer(port, {
      args: ["--index", customIndex],
      env: {
        INDEX_PATH: "",
        XDG_CACHE_HOME: customCacheDir,
        QMD_CONFIG_DIR: customConfigDir,
      },
    });

    try {
      const ready = await waitForServer(port);
      expect(ready).toBe(true);

      const res = await fetch(`http://localhost:${port}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ searches: [{ type: "lex", query: "authentication" }], limit: 5, rerank: false }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const files = body.results.map((r: { file: string }) => r.file);
      expect(files.some((file: string) => file.includes("mcp-fixtures/notes/meeting.md"))).toBe(true);
    } finally {
      const closed = new Promise(r => proc.once("close", r));
      proc.kill("SIGTERM");
      await closed;
    }
  }, 10000);

  // -------------------------------------------------------------------------
  // Daemon lifecycle
  // -------------------------------------------------------------------------

  test("--daemon writes PID file and starts server", async () => {
    const port = randomPort();
    const { stdout, exitCode } = await runDaemonQmd([
      "mcp", "--http", "--daemon", "--port", String(port),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`http://localhost:${port}/mcp`);

    // PID file should exist
    expect(existsSync(pidPath())).toBe(true);

    const pid = parseInt(readFileSync(pidPath(), "utf-8").trim());
    spawnedPids.push(pid);

    // Server should be reachable
    const ready = await waitForServer(port);
    expect(ready).toBe(true);

    // Clean up
    process.kill(pid, "SIGTERM");
    await sleep(500);
    try { unlinkSync(pidPath()); } catch {}
  });

  test("stop kills daemon and removes PID file", async () => {
    const port = randomPort();
    // Start daemon
    const { exitCode: startCode } = await runDaemonQmd([
      "mcp", "--http", "--daemon", "--port", String(port),
    ]);
    expect(startCode).toBe(0);

    const pid = parseInt(readFileSync(pidPath(), "utf-8").trim());
    spawnedPids.push(pid);

    await waitForServer(port);

    // Stop it
    const { stdout: stopOut, exitCode: stopCode } = await runDaemonQmd(["mcp", "stop"]);
    expect(stopCode).toBe(0);
    expect(stopOut).toContain("Stopped");

    // PID file should be gone
    expect(existsSync(pidPath())).toBe(false);

    // Process should be dead
    await sleep(500);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("stop handles dead PID gracefully (cleans stale file)", async () => {
    // Write a PID file pointing to a dead process
    writeFileSync(pidPath(), "999999999");

    const { stdout, exitCode } = await runDaemonQmd(["mcp", "stop"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("stale");

    // PID file should be cleaned up
    expect(existsSync(pidPath())).toBe(false);
  });

  test("--daemon rejects if already running", async () => {
    const port = randomPort();
    // Start first daemon
    const { exitCode: firstCode } = await runDaemonQmd([
      "mcp", "--http", "--daemon", "--port", String(port),
    ]);
    expect(firstCode).toBe(0);

    const pid = parseInt(readFileSync(pidPath(), "utf-8").trim());
    spawnedPids.push(pid);

    await waitForServer(port);

    // Try to start second daemon — should fail
    const { stderr, exitCode } = await runDaemonQmd([
      "mcp", "--http", "--daemon", "--port", String(port + 1),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Already running");

    // Clean up first daemon
    process.kill(pid, "SIGTERM");
    await sleep(500);
    try { unlinkSync(pidPath()); } catch {}
  });

  test("--daemon cleans stale PID file and starts fresh", async () => {
    // Write a stale PID file
    writeFileSync(pidPath(), "999999999");

    const port = randomPort();
    const { exitCode, stdout } = await runDaemonQmd([
      "mcp", "--http", "--daemon", "--port", String(port),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`http://localhost:${port}/mcp`);

    const pid = parseInt(readFileSync(pidPath(), "utf-8").trim());
    spawnedPids.push(pid);
    expect(pid).not.toBe(999999999);

    // Clean up
    const ready = await waitForServer(port);
    expect(ready).toBe(true);
    process.kill(pid, "SIGTERM");
    await sleep(500);
    try { unlinkSync(pidPath()); } catch {}
  });
});

// =============================================================================
// MCP stdio stdout hygiene
// =============================================================================


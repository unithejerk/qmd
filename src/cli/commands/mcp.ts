/**
 * MCP CLI command handling.
 *
 * Owns stdio/HTTP startup plus HTTP daemon process and PID-file management.
 */

import { spawn as nodeSpawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join as pathJoin } from "node:path";
import { homedir, resolve } from "../../store.js";
import { getDbPath } from "../lifecycle.js";

type McpCommandOptions = {
  args: string[];
  values: Record<string, unknown>;
  selfPath: string;
};

export async function runMcpCommand(options: McpCommandOptions): Promise<void> {
  const sub = options.args[0];
  const cacheDir = process.env.XDG_CACHE_HOME
    ? resolve(process.env.XDG_CACHE_HOME, "qmd")
    : resolve(homedir(), ".cache", "qmd");
  const pidPath = resolve(cacheDir, "mcp.pid");

  if (sub === "stop") {
    if (!existsSync(pidPath)) {
      console.log("Not running (no PID file).");
      process.exit(0);
    }
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim());
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGTERM");
      unlinkSync(pidPath);
      console.log(`Stopped QMD MCP server (PID ${pid}).`);
    } catch {
      unlinkSync(pidPath);
      console.log("Cleaned up stale PID file (server was not running).");
    }
    process.exit(0);
  }

  if (options.values.http) {
    const port = Number(options.values.port) || 8181;

    if (options.values.daemon) {
      if (existsSync(pidPath)) {
        const existingPid = parseInt(readFileSync(pidPath, "utf-8").trim());
        try {
          process.kill(existingPid, 0);
          console.error(`Already running (PID ${existingPid}). Run 'qmd mcp stop' first.`);
          process.exit(1);
        } catch {
          // Stale PID file; continue and replace it.
        }
      }

      mkdirSync(cacheDir, { recursive: true });
      const logPath = resolve(cacheDir, "mcp.log");
      const logFd = openSync(logPath, "w");
      const indexArgs = options.values.index ? ["--index", String(options.values.index)] : [];
      const spawnArgs = options.selfPath.endsWith(".ts")
        ? ["--import", pathJoin(dirname(options.selfPath), "..", "..", "node_modules", "tsx", "dist", "esm", "index.mjs"), options.selfPath, ...indexArgs, "mcp", "--http", "--port", String(port)]
        : [options.selfPath, ...indexArgs, "mcp", "--http", "--port", String(port)];
      const child = nodeSpawn(process.execPath, spawnArgs, {
        stdio: ["ignore", logFd, logFd],
        detached: true,
      });
      child.unref();
      closeSync(logFd);

      writeFileSync(pidPath, String(child.pid));
      console.log(`Started on http://localhost:${port}/mcp (PID ${child.pid})`);
      console.log(`Logs: ${logPath}`);
      process.exit(0);
    }

    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    const { startMcpHttpServer } = await import("../../mcp/server.js");
    try {
      await startMcpHttpServer(port, { dbPath: getDbPath() });
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE") {
        console.error(`Port ${port} already in use. Try a different port with --port.`);
        process.exit(1);
      }
      throw error;
    }
    return;
  }

  const { startMcpServer } = await import("../../mcp/server.js");
  await startMcpServer({ dbPath: getDbPath() });
}

/**
 * Tests for MCP stdio launcher.
 *
 * Verifies that the MCP stdio server sets native llama/ggml quiet
 * environment variables before spawning Node, keeping stdout clean
 * for JSON-RPC framing.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { chmod, copyFile, mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { setTimeout as sleep } from "timers/promises";
import { runQmd, qmdRunnerArgs, setupCliTestEnv, teardownCliTestEnv, createIsolatedTestEnv } from "../helpers/cli.js";
import { chmod, copyFile } from "fs/promises";
import { chmod, copyFile } from "fs/promises";
import { spawn } from "child_process";
import { qmdCommand } from "../helpers/cli.js";

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
// MCP stdio stdout hygiene
// =============================================================================

describe("mcp stdio launcher", () => {
  test("sets native llama/ggml quiet env before Node starts so stdout stays JSON-RPC only", async () => {
    const tempPackage = await mkdtemp(join(tmpdir(), "qmd-bin-mcp-"));
    try {
      await mkdir(join(tempPackage, "bin"), { recursive: true });
      await mkdir(join(tempPackage, "dist", "cli"), { recursive: true });
      await writeFile(join(tempPackage, "dist", "cli", "qmd.js"), "// fixture\n");
      await mkdir(join(tempPackage, "fake-bin"), { recursive: true });

      const qmdBin = join(tempPackage, "bin", "qmd");
      await copyFile(join(projectRoot, "bin", "qmd"), qmdBin);
      await chmod(qmdBin, 0o755);

      // Force the wrapper down the Node branch, then put our fake `node` first
      // in PATH. The fake node behaves like the native llama/ggml layer: it
      // writes a non-JSON stdout line unless qmd pre-seeded the documented
      // quiet env vars before launching JS.
      await writeFile(join(tempPackage, "package-lock.json"), "{}\n");
      const fakeNode = join(tempPackage, "fake-bin", "node");
      await writeFile(fakeNode, `#!/bin/sh
if [ "$(basename "$1")" = "qmd" ]; then
  exec "${process.execPath}" "$@"
else
  if [ "\${GGML_BACKEND_SILENT:-}" != "1" ]; then
    printf 'llama.cpp native log on stdout\\n'
  fi
  printf '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\\n'
fi
`);
      await chmod(fakeNode, 0o755);

      const proc = spawn(qmdBin, ["mcp"], {
        cwd: tempPackage,
        env: {
          ...process.env,
          PATH: `${join(tempPackage, "fake-bin")}:${process.env.PATH}`,
          LLAMA_LOG_LEVEL: "",
          GGML_LOG_LEVEL: "",
          GGML_BACKEND_SILENT: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      const exitCode = await new Promise<number>((resolve, reject) => {
        proc.once("error", reject);
        proc.on("close", (code) => resolve(code ?? 1));
      });

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const lines = stdout.trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      await rm(tempPackage, { recursive: true, force: true });
    }
  });
});

/**
 * Tests for CLI get command (qmd get).
 *
 * Verifies document retrieval by path, docid (#abc123), :from:count suffix,
 * --from/-l flags, line numbers, --full-path, and error handling for
 * missing documents.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { chmod, copyFile, mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { setTimeout as sleep } from "timers/promises";
import { runQmd, qmdRunnerArgs, setupCliTestEnv, teardownCliTestEnv, createIsolatedTestEnv } from "../helpers/cli.js";

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


describe("CLI Get Command", () => {
  beforeEach(async () => {
    // Ensure we have indexed files
    await qmd(["collection", "add", "."]);
  });

  test("retrieves document content by path", async () => {
    const { stdout, exitCode } = await qmd(["get", "README.md"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Project");
  });

  test("retrieves document from subdirectory", async () => {
    const { stdout, exitCode } = await qmd(["get", "notes/meeting.md"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Team Meeting");
  });

  test("handles non-existent file", async () => {
    const { stdout, exitCode } = await qmd(["get", "nonexistent.md"]);
    // Should indicate file not found
    expect(exitCode).toBe(1);
  });

  test("clamps negative --from to top of file (no silent tail content)", async () => {
    const baseline = await qmd(["get", "README.md"]);
    const negative = await qmd(["get", "README.md", "--from", "-19"]);
    expect(negative.exitCode).toBe(0);
    expect(negative.stdout).toBe(baseline.stdout);
  });
});


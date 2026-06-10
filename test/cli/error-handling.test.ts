/**
 * Tests for CLI error handling.
 *
 * Verifies error messages and exit codes for invalid commands, missing
 * arguments, unknown flags, and doctor hint display on failures.
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


describe("CLI Error Handling", () => {
  test("handles unknown command", async () => {
    const { stderr, exitCode } = await qmd(["unknowncommand"]);
    expect(exitCode).toBe(1);
    // Should indicate unknown command and point users to diagnostics
    expect(stderr).toContain("Unknown command");
    expect(stderr).toContain("qmd doctor");
  });

  test("uses INDEX_PATH environment variable", async () => {
    // Verify the test DB path is being used by creating a separate index
    const customDbPath = join(testDir, "custom.sqlite");
    const { exitCode } = await qmd(["collection", "add", "."], {
      env: { INDEX_PATH: customDbPath },
    });
    expect(exitCode).toBe(0);

    // The custom database should exist
    expect(existsSync(customDbPath)).toBe(true);
  });
});


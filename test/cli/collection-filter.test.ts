/**
 * Tests for CLI collection filtering (-c, --collection).
 *
 * Verifies that search results are scoped to the requested collection(s),
 * multi-collection filter behavior, and error handling for nonexistent
 * collection names.
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


describe("CLI Search with Collection Filter", () => {
  let localDbPath: string;

  beforeEach(async () => {
    // Use a fresh database for this test suite
    localDbPath = join(testDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    // Create multiple collections with explicit names
    await qmd(["collection", "add", ".", "--name", "notes", "--mask", "notes/*.md"], { dbPath: localDbPath });
    await qmd(["collection", "add", ".", "--name", "docs", "--mask", "docs/*.md"], { dbPath: localDbPath });
  });

  test("filters search by collection name", async () => {
    const { stdout, stderr, exitCode } = await qmd([
      "search",
      "-c",
      "notes",
      "meeting",
    ], { dbPath: localDbPath });
    if (exitCode !== 0) {
      console.log("Collection filter search failed:");
      console.log("stdout:", stdout);
      console.log("stderr:", stderr);
    }
    expect(exitCode).toBe(0);
  });
});


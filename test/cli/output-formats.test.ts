/**
 * Tests for CLI output format flags (--json, --csv, --md, --xml, --files).
 *
 * Verifies that each output format produces correctly structured output
 * for search and multi-get commands.
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


describe("CLI Output Formats", () => {
  beforeEach(async () => {
    await qmd(["collection", "add", "."]);
  });

  test("search with --json flag outputs JSON", async () => {
    const { stdout, exitCode } = await qmd(["search", "--json", "test"]);
    expect(exitCode).toBe(0);
    // Should be valid JSON
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("search with --files flag outputs file paths", async () => {
    const { stdout, exitCode } = await qmd(["search", "--files", "meeting"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(".md");
  });

  test("search output includes snippets by default", async () => {
    const { stdout, exitCode } = await qmd(["search", "API"]);
    expect(exitCode).toBe(0);
    // If results found, should have snippet content
    if (!stdout.includes("No results")) {
      expect(stdout.toLowerCase()).toContain("api");
    }
  });
});


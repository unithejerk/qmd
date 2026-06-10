/**
 * Tests for CLI context add/check commands (qmd context add, qmd context check).
 *
 * Verifies context creation for current directory, explicit paths,
 * virtual qmd:// paths, global context with /, and missing-context detection.
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


describe("CLI Add-Context Command", () => {
  let localDbPath: string;
  let localConfigDir: string;
  const collName = "fixtures";

  beforeAll(async () => {
    const env = await createIsolatedTestEnv(testDir, "context-cmd");
    localDbPath = env.dbPath;
    localConfigDir = env.configDir;

    // Add collection with known name
    const { exitCode, stderr } = await qmd(
      ["collection", "add", fixturesDir, "--name", collName],
      { dbPath: localDbPath, configDir: localConfigDir }
    );
    if (exitCode !== 0) console.error("collection add failed:", stderr);
    expect(exitCode).toBe(0);
  });

  test("adds context to a path", async () => {
    // Add context to the collection root using virtual path
    const { stdout, exitCode } = await qmd([
      "context",
      "add",
      `qmd://${collName}/`,
      "Personal notes and meeting logs",
    ], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Added context");
  });

  test("requires path and text arguments", async () => {
    const { stderr, exitCode } = await qmd(["context", "add"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(1);
    // Error message goes to stderr
    expect(stderr).toContain("Usage:");
  });
});


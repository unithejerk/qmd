/**
 * Tests for CLI context management commands (qmd context add/list/rm).
 *
 * Verifies hierarchical context inheritance, virtual qmd:// paths,
 * global context, context listing, and context removal.
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


describe("CLI Context Management", () => {
  let localDbPath: string;

  beforeEach(async () => {
    // Use a fresh database for this test suite
    localDbPath = join(testDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    // Index some files first
    await qmd(["collection", "add", "."], { dbPath: localDbPath });
  });

  test("add global context with /", async () => {
    const { stdout, exitCode } = await qmd([
      "context",
      "add",
      "/",
      "Global system context",
    ], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Set global context");
    expect(stdout).toContain("Global system context");
  });

  test("list contexts", async () => {
    // Add a global context first
    await qmd([
      "context",
      "add",
      "/",
      "Test context",
    ], { dbPath: localDbPath });

    const { stdout, exitCode } = await qmd([
      "context",
      "list",
    ], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Configured Contexts");
    expect(stdout).toContain("Test context");
  });

  test("add context to virtual path", async () => {
    // Collection name should be "fixtures" (basename of the fixtures directory)
    const { stdout, exitCode } = await qmd([
      "context",
      "add",
      "qmd://fixtures/notes",
      "Context for notes subdirectory",
    ], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Added context for: qmd://fixtures/notes");
  });

  test("remove global context", async () => {
    // Add a global context first
    await qmd([
      "context",
      "add",
      "/",
      "Global context to remove",
    ], { dbPath: localDbPath });

    const { stdout, exitCode } = await qmd([
      "context",
      "rm",
      "/",
    ], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Removed");
  });

  test("remove virtual path context", async () => {
    // Add a context first
    await qmd([
      "context",
      "add",
      "qmd://fixtures/notes",
      "Context to remove",
    ], { dbPath: localDbPath });

    const { stdout, exitCode } = await qmd([
      "context",
      "rm",
      "qmd://fixtures/notes",
    ], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Removed context for: qmd://fixtures/notes");
  });

  test("fails to remove non-existent context", async () => {
    const { stdout, stderr, exitCode } = await qmd([
      "context",
      "rm",
      "qmd://nonexistent/path",
    ], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr || stdout).toContain("not found");
  });
});


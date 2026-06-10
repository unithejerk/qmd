/**
 * Tests for CLI collection management commands (qmd collection list/rename/remove).
 *
 * Verifies collection enumeration, rename validation, removal with
 * confirmation, and edge cases like renaming to existing names.
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


describe("CLI Collection Commands", () => {
  let localDbPath: string;

  beforeEach(async () => {
    // Use a fresh database for this test suite
    localDbPath = join(testDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    // Index some files first to create a collection
    await qmd(["collection", "add", "."], { dbPath: localDbPath });
  });

  test("lists collections", async () => {
    const { stdout, exitCode } = await qmd(["collection", "list"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Collections");
    expect(stdout).toContain("fixtures");
    expect(stdout).toContain("qmd://fixtures/");
    expect(stdout).toContain("Pattern:");
    expect(stdout).toContain("Files:");
  });

  test("removes a collection", async () => {
    // First verify the collection exists
    const { stdout: listBefore } = await qmd(["collection", "list"], { dbPath: localDbPath });
    expect(listBefore).toContain("fixtures");

    // Remove it
    const { stdout, exitCode } = await qmd(["collection", "remove", "fixtures"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Removed collection 'fixtures'");
    expect(stdout).toContain("Deleted");

    // Verify it's gone
    const { stdout: listAfter } = await qmd(["collection", "list"], { dbPath: localDbPath });
    expect(listAfter).not.toContain("fixtures");
  });

  test("handles removing non-existent collection", async () => {
    const { stderr, exitCode } = await qmd(["collection", "remove", "nonexistent"], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Collection not found");
  });

  test("handles missing remove argument", async () => {
    const { stderr, exitCode } = await qmd(["collection", "remove"], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage:");
  });

  test("handles unknown subcommand", async () => {
    const { stderr, exitCode } = await qmd(["collection", "invalid"], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown subcommand");
  });

  test("renames a collection", async () => {
    // First verify the collection exists
    const { stdout: listBefore } = await qmd(["collection", "list"], { dbPath: localDbPath });
    expect(listBefore).toContain("qmd://fixtures/");

    // Rename it
    const { stdout, exitCode } = await qmd(["collection", "rename", "fixtures", "my-fixtures"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("✓ Renamed collection 'fixtures' to 'my-fixtures'");
    expect(stdout).toContain("qmd://fixtures/");
    expect(stdout).toContain("qmd://my-fixtures/");

    // Verify the new name exists and old name is gone
    const { stdout: listAfter } = await qmd(["collection", "list"], { dbPath: localDbPath });
    expect(listAfter).toContain("qmd://my-fixtures/");
    expect(listAfter).not.toContain("qmd://fixtures/"); // Old collection should not appear
  });

  test("handles renaming non-existent collection", async () => {
    const { stderr, exitCode } = await qmd(["collection", "rename", "nonexistent", "newname"], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Collection not found");
  });

  test("handles renaming to existing collection name", async () => {
    // Create a second collection in a temp directory
    const tempDir = await mkdtemp(join(tmpdir(), "qmd-second-"));
    await writeFile(join(tempDir, "test.md"), "# Test");
    const addResult = await qmd(["collection", "add", tempDir, "--name", "second"], { dbPath: localDbPath });

    if (addResult.exitCode !== 0) {
      console.error("Failed to add second collection:", addResult.stderr);
    }
    expect(addResult.exitCode).toBe(0);

    // Verify both collections exist
    const { stdout: listBoth } = await qmd(["collection", "list"], { dbPath: localDbPath });
    expect(listBoth).toContain("qmd://fixtures/");
    expect(listBoth).toContain("qmd://second/");

    // Try to rename fixtures to second (which already exists)
    const { stderr, exitCode } = await qmd(["collection", "rename", "fixtures", "second"], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Collection name already exists");
  });

  test("handles missing rename arguments", async () => {
    const { stderr: stderr1, exitCode: exitCode1 } = await qmd(["collection", "rename"], { dbPath: localDbPath });
    expect(exitCode1).toBe(1);
    expect(stderr1).toContain("Usage:");

    const { stderr: stderr2, exitCode: exitCode2 } = await qmd(["collection", "rename", "fixtures"], { dbPath: localDbPath });
    expect(exitCode2).toBe(1);
    expect(stderr2).toContain("Usage:");
  });
});

// =============================================================================
// Collection Ignore Patterns
// =============================================================================


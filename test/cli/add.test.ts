/**
 * Tests for CLI collection add command (qmd collection add).
 *
 * Verifies collection creation with --name and --mask options, indexing
 * of markdown files, and error handling for missing paths.
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


describe("CLI Add Command", () => {
  test("adds files from current directory", async () => {
    const { stdout, exitCode } = await qmd(["collection", "add", "."]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Collection:");
    expect(stdout).toContain("Indexed:");
  });

  test("adds files with custom glob pattern", async () => {
    const { stdout, stderr, exitCode } = await qmd(["collection", "add", ".", "--mask", "notes/*.md"]);
    if (exitCode !== 0) {
      console.error("Command failed:", stderr);
    }
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Collection:");
    // Should find meeting.md and ideas.md in notes/
    expect(stdout).toContain("notes/*.md");
  });

  test("can recreate collection with remove and add", async () => {
    // First add
    await qmd(["collection", "add", "."]);
    // Remove it
    await qmd(["collection", "remove", "fixtures"]);
    // Re-add
    const { stdout, exitCode } = await qmd(["collection", "add", "."]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Collection 'fixtures' created successfully");
  });

  test("fails with usage when no path is provided", async () => {
    const { stderr, exitCode } = await qmd(["collection", "add"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage: qmd collection add");
  });

  test("adds files with comma-separated mask patterns", async () => {
    const { dbPath, configDir } = await createIsolatedTestEnv(testDir, "comma-mask");
    const { stdout, stderr, exitCode } = await qmd(["collection", "add", ".", "--mask", "README.md,test1.md"], { dbPath, configDir });
    if (exitCode !== 0) {
      console.error("Command failed:", stderr);
    }
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Indexed:");
    // Should find both README.md and test1.md
    expect(stdout).toContain("2 new");
  });

  test("does not split commas inside character classes", async () => {
    const { dbPath, configDir } = await createIsolatedTestEnv(testDir, "charclass-mask");
    const { stdout, stderr, exitCode } = await qmd(["collection", "add", ".", "--mask", "README[,.]md,test1.md"], { dbPath, configDir });
    if (exitCode !== 0) {
      console.error("Command failed:", stderr);
    }
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Indexed:");
    expect(stdout).toContain("2 new");
    expect(stderr).not.toContain("No files matched the mask pattern(s)");
  });

  test("warns on comma-separated mask with zero matches", async () => {
    const { stdout, stderr, exitCode } = await qmd(["collection", "add", ".", "--mask", "nonexistent1.md,nonexistent2.md"]);
    // collection add still succeeds (creates empty collection, 0 files indexed)
    expect(exitCode).toBe(0);
    expect(stderr).toContain("No files matched the mask pattern(s)");
  });
});


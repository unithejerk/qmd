/**
 * Tests for collection ignore patterns.
 *
 * Verifies that files matching ignore globs are excluded from indexing,
 * multi-pattern ignore lists, and pattern validation.
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


// =============================================================================
// Collection Ignore Patterns
// =============================================================================

describe("collection ignore patterns", () => {
  let localDbPath: string;
  let localConfigDir: string;
  let ignoreTestDir: string;

  beforeAll(async () => {
    const env = await createIsolatedTestEnv(testDir, "ignore-patterns");
    localDbPath = env.dbPath;
    localConfigDir = env.configDir;

    // Create directory structure with subdirectories to ignore
    ignoreTestDir = join(testDir, "ignore-fixtures");
    await mkdir(join(ignoreTestDir, "notes"), { recursive: true });
    await mkdir(join(ignoreTestDir, "sessions"), { recursive: true });
    await mkdir(join(ignoreTestDir, "sessions", "2026-03"), { recursive: true });
    await mkdir(join(ignoreTestDir, "archive"), { recursive: true });

    // Files that should be indexed
    await writeFile(join(ignoreTestDir, "readme.md"), "# Main readme\nThis should be indexed.");
    await writeFile(join(ignoreTestDir, "notes", "note1.md"), "# Note 1\nThis is a personal note.");

    // Files that should be ignored
    await writeFile(join(ignoreTestDir, "sessions", "session1.md"), "# Session 1\nThis session should be ignored.");
    await writeFile(join(ignoreTestDir, "sessions", "2026-03", "session2.md"), "# Session 2\nNested session should also be ignored.");
    await writeFile(join(ignoreTestDir, "archive", "old.md"), "# Old stuff\nThis archive file should be ignored.");
  });

  test("ignore patterns exclude matching files from indexing", async () => {
    // Write YAML config with ignore patterns
    await writeFile(
      join(localConfigDir, "index.yml"),
      `collections:
  ignoretst:
    path: ${ignoreTestDir}
    pattern: "**/*.md"
    ignore:
      - "sessions/**"
      - "archive/**"
`
    );

    const { stdout, exitCode } = await qmd(["update"], {
      cwd: ignoreTestDir,
      dbPath: localDbPath,
      configDir: localConfigDir,
    });
    expect(exitCode).toBe(0);
    // Should index 2 files (readme.md + notes/note1.md), not 5
    expect(stdout).toContain("2 new");
  });

  test("ignored files are not searchable", async () => {
    const { stdout, exitCode } = await qmd(["search", "session", "-n", "10"], {
      cwd: ignoreTestDir,
      dbPath: localDbPath,
      configDir: localConfigDir,
    });
    // Should find no results since sessions/ was ignored
    if (exitCode === 0) {
      expect(stdout).not.toContain("session1");
      expect(stdout).not.toContain("session2");
    }
  });

  test("non-ignored files are searchable", async () => {
    const { stdout, exitCode } = await qmd(["search", "personal note", "-n", "10"], {
      cwd: ignoreTestDir,
      dbPath: localDbPath,
      configDir: localConfigDir,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("note1");
  });

  test("status shows ignore patterns", async () => {
    const { stdout, exitCode } = await qmd(["collection", "list"], {
      cwd: ignoreTestDir,
      dbPath: localDbPath,
      configDir: localConfigDir,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Ignore:");
    expect(stdout).toContain("sessions/**");
    expect(stdout).toContain("archive/**");
  });

  test("collection without ignore indexes all files", async () => {
    // Create a second collection without ignore
    const env2 = await createIsolatedTestEnv(testDir, "no-ignore");
    await writeFile(
      join(env2.configDir, "index.yml"),
      `collections:
  allfiles:
    path: ${ignoreTestDir}
    pattern: "**/*.md"
`
    );

    const { stdout, exitCode } = await qmd(["update"], {
      cwd: ignoreTestDir,
      dbPath: env2.dbPath,
      configDir: env2.configDir,
    });
    expect(exitCode).toBe(0);
    // Should index all 5 files
    expect(stdout).toContain("5 new");
  });
});

// =============================================================================
// Output Format Tests - qmd:// URIs, context, and docid
// =============================================================================


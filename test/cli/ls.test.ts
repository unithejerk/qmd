/**
 * Tests for CLI ls command (qmd ls).
 *
 * Verifies collection listing, file listing under paths, virtual path
 * (qmd://) listing, absolute-path collection listing, and empty collection
 * handling.
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


describe("CLI ls Command", () => {
  let localDbPath: string;

  beforeEach(async () => {
    // Use a fresh database for this test suite
    localDbPath = join(testDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    // Index some files first
    await qmd(["collection", "add", "."], { dbPath: localDbPath });
  });

  test("lists all collections", async () => {
    const { stdout, exitCode } = await qmd(["ls"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Collections:");
    expect(stdout).toContain("qmd://fixtures/");
  });

  test("lists files in a collection", async () => {
    const { stdout, exitCode } = await qmd(["ls", "fixtures"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    // handelize preserves original case
    expect(stdout).toContain("qmd://fixtures/README.md");
    expect(stdout).toContain("qmd://fixtures/notes/meeting.md");
  });

  test("lists files with path prefix", async () => {
    const { stdout, exitCode } = await qmd(["ls", "fixtures/notes"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("qmd://fixtures/notes/meeting.md");
    expect(stdout).toContain("qmd://fixtures/notes/ideas.md");
    // Should not include files outside the prefix (case preserved)
    expect(stdout).not.toContain("qmd://fixtures/README.md");
  });

  test("lists files with virtual path", async () => {
    const { stdout, exitCode } = await qmd(["ls", "qmd://fixtures/docs"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("qmd://fixtures/docs/api.md");
  });

  test("continues to normalize extra slashes for normal collection virtual paths", async () => {
    const { stdout, stderr, exitCode } = await qmd(["ls", "qmd:///fixtures/docs"], { dbPath: localDbPath });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("qmd://fixtures/docs/api.md");
  });

  test("lists an absolute-path collection from a qmd:/// virtual path", async () => {
    const env = await createIsolatedTestEnv(testDir, "absolute-qmd-path");
    const absoluteDir = await mkdtemp(join(tmpdir(), "qmd-absolute-collection-"));
    await writeFile(join(absoluteDir, "root.md"), "# Absolute collection\n");
    await writeFile(
      join(env.configDir, "index.yml"),
      `collections:\n  "${absoluteDir}":\n    path: "${absoluteDir}"\n    pattern: "**/*.md"\n`
    );

    const update = await qmd(["update"], {
      cwd: absoluteDir,
      dbPath: env.dbPath,
      configDir: env.configDir,
    });
    expect(update.exitCode).toBe(0);

    const { stdout, stderr, exitCode } = await qmd(["ls", `qmd://${absoluteDir}/`], {
      cwd: absoluteDir,
      dbPath: env.dbPath,
      configDir: env.configDir,
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`qmd://${absoluteDir}/root.md`);
  });

  test("lists an absolute-path collection from a raw path using the longest prefix match", async () => {
    const env = await createIsolatedTestEnv(testDir, "absolute-raw-path");
    const parentCollectionName = await mkdtemp(join(tmpdir(), "qmd-absolute-parent-name-"));
    const childCollectionName = join(parentCollectionName, "nested");
    const parentDataDir = await mkdtemp(join(tmpdir(), "qmd-absolute-parent-data-"));
    const childDataDir = await mkdtemp(join(tmpdir(), "qmd-absolute-child-data-"));
    await writeFile(join(parentDataDir, "parent.md"), "# Parent collection\n");
    await writeFile(join(childDataDir, "child.md"), "# Child collection\n");
    await writeFile(
      join(env.configDir, "index.yml"),
      `collections:\n  "${parentCollectionName}":\n    path: "${parentDataDir}"\n    pattern: "**/*.md"\n  "${childCollectionName}":\n    path: "${childDataDir}"\n    pattern: "**/*.md"\n`
    );

    const update = await qmd(["update"], {
      cwd: parentDataDir,
      dbPath: env.dbPath,
      configDir: env.configDir,
    });
    expect(update.exitCode).toBe(0);

    const { stdout, stderr, exitCode } = await qmd(["ls", `${childCollectionName}/`], {
      cwd: childDataDir,
      dbPath: env.dbPath,
      configDir: env.configDir,
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`qmd://${childCollectionName}/child.md`);
    expect(stdout).not.toContain("No files found");
    expect(stdout).not.toContain(`qmd://${parentCollectionName}/parent.md`);
  });

  test("handles non-existent collection", async () => {
    const { stderr, exitCode } = await qmd(["ls", "nonexistent"], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Collection not found");
  });
});


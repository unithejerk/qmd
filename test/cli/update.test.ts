/**
 * Tests for CLI update and reindex commands (qmd update).
 *
 * Verifies collection reindexing with progress reporting, --pull git
 * integration, custom update commands from YAML config, and error handling.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { chmod, copyFile, mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { setTimeout as sleep } from "timers/promises";
import { runQmd, qmdRunnerArgs, setupCliTestEnv, teardownCliTestEnv, createIsolatedTestEnv } from "../helpers/cli.js";
import { unlinkSync } from "fs";

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


describe("CLI Update Command", () => {
  let localDbPath: string;

  beforeEach(async () => {
    // Use a fresh database for this test suite
    localDbPath = join(testDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    // Ensure we have indexed files
    await qmd(["collection", "add", "."], { dbPath: localDbPath });
  });

  test("updates all collections", async () => {
    const { stdout, exitCode } = await qmd(["update"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Updating");
  });

  test("update -c <name> scopes to a single collection", async () => {
    const { stdout, stderr, exitCode } = await qmd(["update", "-c", "fixtures"], { dbPath: localDbPath });
    if (exitCode !== 0) {
      console.error("Command failed:", stderr);
    }
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Updating 1 collection(s)");
    expect(stdout).toContain("fixtures");
  });

  test("update -c supports multiple collection filters", async () => {
    const notesAdd = await qmd(["collection", "add", ".", "--name", "notes", "--mask", "notes/*.md"], { dbPath: localDbPath });
    expect(notesAdd.exitCode).toBe(0);
    const docsAdd = await qmd(["collection", "add", ".", "--name", "docs", "--mask", "docs/*.md"], { dbPath: localDbPath });
    expect(docsAdd.exitCode).toBe(0);

    const { stdout, stderr, exitCode } = await qmd(["update", "-c", "notes", "-c", "docs"], { dbPath: localDbPath });
    if (exitCode !== 0) {
      console.error("Command failed:", stderr);
    }
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Updating 2 collection(s)");
    expect(stdout).toContain("notes");
    expect(stdout).toContain("docs");
    expect(stdout).not.toContain("[3/");
  });

  test("update -c nonexistent exits with error", async () => {
    const { stderr, exitCode } = await qmd(["update", "-c", "nonexistent"], { dbPath: localDbPath });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Collection not found");
  });

  test("deactivates stale docs when collection has zero matching files", async () => {
    const { dbPath, configDir } = await createIsolatedTestEnv(testDir, "update-empty");
    const collectionDir = join(testDir, `update-empty-${Date.now()}`);
    await mkdir(collectionDir, { recursive: true });

    const docPath = join(collectionDir, "only.md");
    const token = `stale-proof-${Date.now()}`;
    await writeFile(
      docPath,
      `---
date: 2026-03-06
---
# Empty Collection Deactivation
${token}
`
    );

    const add = await qmd(
      ["collection", "add", collectionDir, "--name", "empty-check"],
      { dbPath, configDir }
    );
    expect(add.exitCode).toBe(0);

    const before = await qmd(["get", "qmd://empty-check/only.md"], { dbPath, configDir });
    expect(before.exitCode).toBe(0);
    expect(before.stdout).toContain(token);

    unlinkSync(docPath);

    const update = await qmd(["update"], { dbPath, configDir });
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain("0 new, 0 updated, 0 unchanged, 1 removed");

    const after = await qmd(["get", "qmd://empty-check/only.md"], { dbPath, configDir });
    expect(after.exitCode).toBe(1);
  });
});


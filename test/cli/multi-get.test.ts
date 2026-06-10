/**
 * Tests for CLI multi-get command (qmd multi-get).
 *
 * Verifies batch document retrieval by glob pattern and comma-separated list,
 * --max-bytes filtering, --format output modes, --full-path, and docid
 * inclusion in all output formats.
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


describe("CLI Multi-Get Command", () => {
  let localDbPath: string;

  beforeEach(async () => {
    // Use fresh database for each test
    localDbPath = join(testDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
    // Ensure we have indexed files
    const addResult = await qmd(["collection", "add", ".", "--name", "fixtures"], { dbPath: localDbPath });
    if (addResult.exitCode !== 0) {
      throw new Error(`Failed to add collection: ${addResult.stderr}`);
    }
  });

  test("retrieves multiple documents by pattern", async () => {
    // Test glob pattern matching
    const { stdout, stderr, exitCode } = await qmd(["multi-get", "notes/*.md"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    // Should contain content from both notes files
    expect(stdout).toContain("Meeting");
    expect(stdout).toContain("Ideas");
  });

  test("retrieves documents by comma-separated paths", async () => {
    const { stdout, exitCode } = await qmd([
      "multi-get",
      "README.md,notes/meeting.md",
    ], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Project");
    expect(stdout).toContain("Team Meeting");
  });

  test("--md output includes a #docid for each file", async () => {
    const { stdout, exitCode } = await qmd(["multi-get", "notes/*.md", "--md"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    // Every result carries a docid line, consistent with `search --md`.
    expect(stdout).toMatch(/\*\*docid:\*\* `#[a-f0-9]{6}`/);
  });

  test("--json output includes a #docid for each file", async () => {
    const { stdout, exitCode } = await qmd(["multi-get", "notes/*.md", "--json"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.length).toBeGreaterThan(0);
    for (const entry of parsed) {
      expect(entry.docid).toMatch(/^#[a-f0-9]{6}$/);
    }
  });

  test("shows line numbers by default and --no-line-numbers disables them", async () => {
    const withNums = await qmd(["multi-get", "README.md"], { dbPath: localDbPath });
    expect(withNums.exitCode).toBe(0);
    expect(withNums.stdout).toMatch(/^1: /m);

    const raw = await qmd(["multi-get", "README.md", "--no-line-numbers"], { dbPath: localDbPath });
    expect(raw.exitCode).toBe(0);
    expect(raw.stdout).not.toMatch(/^1: /m);
  });

  test("--full-path --md shows ./-prefixed on-disk paths and drops the docid", async () => {
    // Default runQmd cwd is fixturesDir, so notes/*.md files are subpaths.
    const { stdout, exitCode } = await qmd(["multi-get", "notes/*.md", "--md", "--full-path"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    // Headings are ./-prefixed relative paths under fixturesDir.
    expect(stdout).toMatch(/^## \.\/notes\/[^\s]+\.md$/m);
    expect(stdout).not.toContain("qmd://");
    expect(stdout).not.toMatch(/\*\*docid:\*\*/);
  });

  test("--full-path --json puts the ./-prefixed path in `file` and omits docid", async () => {
    const { stdout, exitCode } = await qmd(["multi-get", "notes/*.md", "--json", "--full-path"], { dbPath: localDbPath });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.length).toBeGreaterThan(0);
    for (const entry of parsed) {
      expect(entry.file.startsWith("./notes/")).toBe(true);
      expect(entry.docid).toBeUndefined();
    }
  });

  test("--full-path --json uses absolute path when files are outside $PWD", async () => {
    const { stdout, exitCode } = await qmd(
      ["multi-get", "notes/*.md", "--json", "--full-path"],
      { dbPath: localDbPath, cwd: "/" }
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.length).toBeGreaterThan(0);
    for (const entry of parsed) {
      expect(entry.file.startsWith("/")).toBe(true);
      expect(entry.file).not.toMatch(/^\.\//);
      expect(entry.docid).toBeUndefined();
    }
  });
});


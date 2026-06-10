/**
 * Tests for get command path normalization and --full-path flag.
 *
 * Verifies relative path resolution, absolute path handling, ./ prefix
 * for paths under $PWD, docid-based retrieval, :from:count suffix parsing,
 * and fallback to qmd:// + docid when files are deleted.
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
// Get Command Path Normalization Tests
// =============================================================================

describe("get command path normalization", () => {
  let localDbPath: string;
  let localConfigDir: string;
  const collName = "fixtures";

  beforeAll(async () => {
    const env = await createIsolatedTestEnv(testDir, "get-paths");
    localDbPath = env.dbPath;
    localConfigDir = env.configDir;

    const { exitCode, stderr } = await qmd(
      ["collection", "add", fixturesDir, "--name", collName],
      { dbPath: localDbPath, configDir: localConfigDir }
    );
    if (exitCode !== 0) console.error("collection add failed:", stderr);
    expect(exitCode).toBe(0);
  });

  test("get with qmd://collection/path format", async () => {
    const { stdout, exitCode } = await qmd(["get", `qmd://${collName}/test1.md`, "-l", "3"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Document 1");
  });

  test("get with collection/path format (no scheme)", async () => {
    const { stdout, exitCode } = await qmd(["get", `${collName}/test1.md`, "-l", "3"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Document 1");
  });

  test("get with //collection/path format", async () => {
    const { stdout, exitCode } = await qmd(["get", `//${collName}/test1.md`, "-l", "3"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Document 1");
  });

  test("get with qmd:////collection/path format (extra slashes)", async () => {
    const { stdout, exitCode } = await qmd(["get", `qmd:////${collName}/test1.md`, "-l", "3"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Test Document 1");
  });

  test("get with path:line format", async () => {
    const { stdout, exitCode } = await qmd(["get", `${collName}/test1.md:3`, "-l", "2"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    // Should start from line 3, not line 1
    expect(stdout).not.toMatch(/^# Test Document 1$/m);
  });

  test("get with qmd://path:line format", async () => {
    const { stdout, exitCode } = await qmd(["get", `qmd://${collName}/test1.md:3`, "-l", "2"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    // Should start from line 3, not line 1
    expect(stdout).not.toMatch(/^# Test Document 1$/m);
  });

  test("get with path:from:count format reads a bounded range", async () => {
    // Lines: 1 "# Test Document 1", 5 "It has multiple lines...",
    //        6 "Line 6 is here.", 7 "Line 7 is here."
    const { stdout, exitCode } = await qmd(["get", `${collName}/test1.md:5:2`], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("It has multiple lines");
    expect(stdout).toContain("Line 6 is here.");
    // Bounded to 2 lines: must not include the start of the file or line 7
    expect(stdout).not.toMatch(/^# Test Document 1$/m);
    expect(stdout).not.toContain("Line 7 is here.");
  });

  test("get with qmd://path:from:count format reads a bounded range", async () => {
    const { stdout, exitCode } = await qmd(["get", `qmd://${collName}/test1.md:5:2`], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("It has multiple lines");
    expect(stdout).toContain("Line 6 is here.");
    expect(stdout).not.toMatch(/^# Test Document 1$/m);
    expect(stdout).not.toContain("Line 7 is here.");
  });

  test("explicit -l overrides the :count in path:from:count", async () => {
    const { stdout, exitCode } = await qmd(["get", `${collName}/test1.md:5:2`, "-l", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("It has multiple lines");
    expect(stdout).not.toContain("Line 6 is here.");
  });

  test("get header includes canonical qmd:// path and a #docid", async () => {
    const { stdout, exitCode } = await qmd(["get", `${collName}/test1.md`], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    // First line of output identifies the document by path + docid.
    expect(stdout).toMatch(new RegExp(`^qmd://${collName}/test1\\.md\\s+#[a-f0-9]{6}`, "m"));
  });

  test("get shows line numbers by default", async () => {
    const { stdout, exitCode } = await qmd(["get", `${collName}/test1.md`], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^1: # Test Document 1$/m);
    expect(stdout).toMatch(/^6: Line 6 is here\.$/m);
  });

  test("get --no-line-numbers returns raw content", async () => {
    const { stdout, exitCode } = await qmd(["get", `${collName}/test1.md`, "--no-line-numbers"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).not.toMatch(/^1: /m);
    expect(stdout).toMatch(/^# Test Document 1$/m);
  });

  test("get line numbers reflect the start line of a range", async () => {
    const { stdout, exitCode } = await qmd(["get", `${collName}/test1.md:5:2`], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    // Numbering starts at the requested line, not at 1.
    expect(stdout).toMatch(/^5: It has multiple lines/m);
    expect(stdout).not.toMatch(/^1: /m);
  });

  test("get --full-path shows ./-prefixed path when file is under $PWD", async () => {
    // Default runQmd cwd is fixturesDir, and test1.md lives in fixturesDir,
    // so the rendered path must be relative-with-./ prefix.
    const { stdout, exitCode } = await qmd(["get", `${collName}/test1.md`, "--full-path"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^\.\/test1\.md$/m);
    expect(stdout).not.toContain("qmd://");
    expect(stdout).not.toMatch(/#[a-f0-9]{6}/);
    // Body still present and line-numbered.
    expect(stdout).toMatch(/^1: # Test Document 1$/m);
  });

  test("get --full-path shows absolute path when file is outside $PWD", async () => {
    const { stdout, exitCode } = await qmd(
      ["get", `${collName}/test1.md`, "--full-path"],
      { dbPath: localDbPath, configDir: localConfigDir, cwd: "/" }
    );
    expect(exitCode).toBe(0);
    // Absolute realpath (allow macOS /var → /private/var).
    expect(stdout).toMatch(/^\/.+\/test1\.md$/m);
    expect(stdout).not.toMatch(/^\.\//m);
    expect(stdout).not.toContain("qmd://");
    expect(stdout).not.toMatch(/#[a-f0-9]{6}/);
  });

  test("get --full-path falls back to qmd:// + docid when the file is gone", async () => {
    // Index a doc, then delete the underlying file so the fs path no longer exists.
    const env = await createIsolatedTestEnv(testDir, "full-path-fallback");
    const collectionDir = join(testDir, `gone-fixtures-${Date.now()}`);
    await mkdir(collectionDir, { recursive: true });
    const gonePath = join(collectionDir, "gone.md");
    await writeFile(gonePath, "# Gone\n\nbody line\n");
    const add = await qmd(["collection", "add", collectionDir, "--name", "gonecoll"], { dbPath: env.dbPath, configDir: env.configDir });
    expect(add.exitCode).toBe(0);
    await rm(gonePath);

    const { stdout, exitCode } = await qmd(["get", "gonecoll/gone.md", "--full-path"], { dbPath: env.dbPath, configDir: env.configDir });
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(new RegExp(`^qmd://gonecoll/gone\\.md\\s+#[a-f0-9]{6}`, "m"));
  });
});

// =============================================================================
// Status and Collection List - No Full Paths
// =============================================================================


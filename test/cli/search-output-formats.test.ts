/**
 * Tests for search output formatting in all modes.
 *
 * Verifies search result output across --json, --csv, --md, --xml, --files,
 * and default CLI formats. Covers snippet extraction, score display,
 * docid inclusion, --full output, --explain traces, and context rendering.
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
// Output Format Tests - qmd:// URIs, context, and docid
// =============================================================================

describe("search output formats", () => {
  let localDbPath: string;
  let localConfigDir: string;
  const collName = "fixtures";

  beforeAll(async () => {
    const env = await createIsolatedTestEnv(testDir, "output-format");
    localDbPath = env.dbPath;
    localConfigDir = env.configDir;

    // Add collection
    const { exitCode, stderr } = await qmd(
      ["collection", "add", fixturesDir, "--name", collName],
      { dbPath: localDbPath, configDir: localConfigDir }
    );
    if (exitCode !== 0) console.error("collection add failed:", stderr);
    expect(exitCode).toBe(0);

    // Add context
    await qmd(["context", "add", `qmd://${collName}/`, "Test fixtures for QMD"], { dbPath: localDbPath, configDir: localConfigDir });
  });

  test("search --json includes qmd:// path, docid, and context", async () => {
    const { stdout, exitCode } = await qmd(["search", "test", "--json", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    const results = JSON.parse(stdout);
    expect(results.length).toBeGreaterThan(0);

    const result = results[0];
    expect(result.file).toMatch(new RegExp(`^qmd://${collName}/`));
    expect(result.docid).toMatch(/^#[a-f0-9]{6}$/);
    expect(result.context).toBe("Test fixtures for QMD");
    // Ensure no full filesystem paths
    expect(result.file).not.toMatch(/^\/Users\//);
    expect(result.file).not.toMatch(/^\/home\//);
  });

  test("custom-index search links include ?index= and can be passed back to qmd get", async () => {
    const env = await createIsolatedTestEnv(testDir, "custom-index-links");
    const customColl = "fixtures-alt";
    const customIndex = "release-notes";
    const customCacheDir = join(testDir, `cache-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(customCacheDir, { recursive: true });

    const sharedEnv = {
      INDEX_PATH: "",
      XDG_CACHE_HOME: customCacheDir,
    };

    const addResult = await qmd(
      ["--index", customIndex, "collection", "add", fixturesDir, "--name", customColl],
      { dbPath: env.dbPath, configDir: env.configDir, env: sharedEnv }
    );
    expect(addResult.exitCode).toBe(0);

    const searchResult = await qmd(
      ["--index", customIndex, "search", "test", "--json", "-n", "1"],
      { dbPath: env.dbPath, configDir: env.configDir, env: sharedEnv }
    );
    expect(searchResult.exitCode).toBe(0);

    const results = JSON.parse(searchResult.stdout);
    const file = results[0]?.file;
    expect(file).toMatch(new RegExp(`^qmd://${customColl}/.+\\?index=${customIndex}$`));

    const getResult = await qmd(
      ["get", file, "-l", "2"],
      { dbPath: env.dbPath, configDir: env.configDir, env: sharedEnv }
    );
    expect(getResult.exitCode).toBe(0);
    expect(getResult.stdout.trim().length).toBeGreaterThan(0);
  });

  test("search --files includes qmd:// path, docid, and context", async () => {
    const { stdout, exitCode } = await qmd(["search", "test", "--files", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    // Format: #docid,score,qmd://collection/path,"context"
    expect(stdout).toMatch(new RegExp(`^#[a-f0-9]{6},[\\d.]+,qmd://${collName}/`, "m"));
    expect(stdout).toContain("Test fixtures for QMD");
    // Ensure no full filesystem paths
    expect(stdout).not.toMatch(/\/Users\//);
    expect(stdout).not.toMatch(/\/home\//);
  });

  test("search --csv includes qmd:// path, docid, and context", async () => {
    const { stdout, exitCode } = await qmd(["search", "test", "--csv", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    // Header should include context
    expect(stdout).toMatch(/^docid,score,file,title,context,line,snippet$/m);
    // Data rows should have qmd:// paths and context
    expect(stdout).toMatch(new RegExp(`#[a-f0-9]{6},[\\d.]+,qmd://${collName}/`));
    expect(stdout).toContain("Test fixtures for QMD");
    // Ensure no full filesystem paths
    expect(stdout).not.toMatch(/\/Users\//);
    expect(stdout).not.toMatch(/\/home\//);
  });

  test("search --md includes docid, context, and qmd:// file line", async () => {
    const { stdout, exitCode } = await qmd(["search", "test", "--md", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    expect(stdout).toMatch(/\*\*docid:\*\* `#[a-f0-9]{6}`/);
    expect(stdout).toContain("**context:** Test fixtures for QMD");
    // The file path must be a qmd:// URI so the model can pipe it back into
    // `qmd get` without having to reassemble a collection-relative string.
    expect(stdout).toMatch(new RegExp(`\\*\\*file:\\*\\* \`qmd://${collName}/`));
  });

  test("search --xml includes qmd:// path, docid, and context", async () => {
    const { stdout, exitCode } = await qmd(["search", "test", "--xml", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    expect(stdout).toMatch(new RegExp(`<file docid="#[a-f0-9]{6}" name="qmd://${collName}/`));
    expect(stdout).toContain('context="Test fixtures for QMD"');
    // Ensure no full filesystem paths
    expect(stdout).not.toMatch(/\/Users\//);
    expect(stdout).not.toMatch(/\/home\//);
  });

  test("search --full-path --json swaps qmd:// for absolute realpath when cwd is unrelated", async () => {
    // Use "/" as cwd so the fixtures path (under tmpdir) is NOT a subpath of $PWD.
    const { stdout, exitCode } = await qmd(
      ["search", "test", "--full-path", "--json", "-n", "1"],
      { dbPath: localDbPath, configDir: localConfigDir, cwd: "/" }
    );
    expect(exitCode).toBe(0);
    const results = JSON.parse(stdout);
    expect(results.length).toBeGreaterThan(0);
    const result = results[0];
    expect(result.file).not.toMatch(/^qmd:\/\//);
    // Must be an absolute path ending in .md.
    expect(result.file).toMatch(/^\/.+\.md$/);
    // --full-path: the on-disk path replaces the docid as the identifier.
    expect(result.docid).toBeUndefined();
  });

  test("search --full-path --json uses ./-prefixed $PWD-relative path when in a parent of the file", async () => {
    const { stdout, exitCode } = await qmd(
      ["search", "test", "--full-path", "--json", "-n", "1"],
      { dbPath: localDbPath, configDir: localConfigDir, cwd: fixturesDir }
    );
    expect(exitCode).toBe(0);
    const results = JSON.parse(stdout);
    expect(results.length).toBeGreaterThan(0);
    const result = results[0];
    expect(result.file).not.toMatch(/^qmd:\/\//);
    // Must start with "./" so it's unambiguously a filesystem path and not
    // mistaken for a bare collection-relative string.
    expect(result.file.startsWith("./")).toBe(true);
    expect(result.file).not.toMatch(/^\.\.\//);
    expect(result.file).toMatch(/\.md$/);
  });

  test("search --full-path default CLI format shows on-disk path and drops the docid", async () => {
    const { stdout, exitCode } = await qmd(
      ["search", "test", "--full-path", "-n", "1"],
      { dbPath: localDbPath, configDir: localConfigDir, cwd: "/" }
    );
    expect(exitCode).toBe(0);
    // eslint-disable-next-line no-control-regex
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, "");
    const plain = stripAnsi(stdout);
    expect(plain).not.toMatch(/qmd:\/\//);
    expect(plain).toMatch(/^\/.+\.md/m);
    // No `#docid` suffix when --full-path is set.
    expect(plain).not.toMatch(/#[a-f0-9]{6}\s*$/m);
  });

  test("search --full-path --md uses on-disk path in heading and drops the docid", async () => {
    const { stdout, exitCode } = await qmd(
      ["search", "test", "--full-path", "--md", "-n", "1"],
      { dbPath: localDbPath, configDir: localConfigDir, cwd: "/" }
    );
    expect(exitCode).toBe(0);
    expect(stdout).not.toMatch(/qmd:\/\//);
    expect(stdout).not.toMatch(/\*\*docid:\*\*/);
    expect(stdout).toMatch(/\*\*file:\*\* `\/.+\.md`/);
  });

  test("search --format json matches the legacy --json behavior", async () => {
    const a = await qmd(["search", "test", "--format", "json", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    const b = await qmd(["search", "test", "--json", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    // Both must yield valid JSON with at least one result.
    const ar = JSON.parse(a.stdout);
    const br = JSON.parse(b.stdout);
    expect(ar.length).toBeGreaterThan(0);
    expect(br.length).toBeGreaterThan(0);
    // Identical first-result file path (the rest may differ in score formatting only).
    expect(ar[0].file).toBe(br[0].file);
  });

  test("search --format md works equivalent to legacy --md", async () => {
    const a = await qmd(["search", "test", "--format", "md", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(a.exitCode).toBe(0);
    expect(a.stdout).toMatch(/\*\*docid:\*\* `#[a-f0-9]{6}`/);
    expect(a.stdout).toMatch(new RegExp(`\\*\\*file:\\*\\* \`qmd://${collName}/`));
  });

  test("search --format with an unknown kind fails cleanly", async () => {
    const { exitCode, stderr } = await qmd(["search", "test", "--format", "yaml", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Unknown --format value");
  });

  test("search default CLI format includes plain qmd:// path, docid, and context in non-TTY mode", async () => {
    const { stdout, exitCode } = await qmd(["search", "test", "-n", "1"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    // runQmd uses piped stdio, so stdout is non-TTY and should not contain OSC 8 links.
    expect(stdout).toMatch(new RegExp(`^qmd://${collName}/.*#[a-f0-9]{6}`, "m"));
    expect(stdout).toContain("Context: Test fixtures for QMD");
    expect(stdout).not.toContain("\x1b]8;;");
    // Ensure no full filesystem paths
    expect(stdout).not.toMatch(/\/Users\//);
    expect(stdout).not.toMatch(/\/home\//);
    // The visible path must NOT be the bare collection-relative form
    // (a leading `${collName}/foo.md` would be "relative to nowhere").
    // Strip ANSI and OSC 8 sequences then assert no result line starts with
    // a bare collection-relative path missing the qmd:// scheme.
    // eslint-disable-next-line no-control-regex
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x07]*\x07/g, "");
    const plain = stripAnsi(stdout);
    expect(plain).not.toMatch(new RegExp(`^${collName}/`, "m"));
  });
});


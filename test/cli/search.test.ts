/**
 * Tests for CLI search commands (qmd search, qmd query).
 *
 * Verifies BM25 full-text search, hybrid query with expansion, result
 * formatting, --json/--csv/--md/--xml/--files output modes, score filtering,
 * snippet extraction, and --explain score traces.
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


describe("CLI Search Command", () => {
  beforeEach(async () => {
    // Ensure we have indexed files
    await qmd(["collection", "add", "."]);
  });

  test("searches for documents with BM25", async () => {
    const { stdout, exitCode } = await qmd(["search", "meeting"]);
    expect(exitCode).toBe(0);
    // Should find meeting.md
    expect(stdout.toLowerCase()).toContain("meeting");
  });

  test("searches with limit option", async () => {
    const { stdout, exitCode } = await qmd(["search", "-n", "1", "test"]);
    expect(exitCode).toBe(0);
  });

  test("searches with all results option", async () => {
    const { stdout, exitCode } = await qmd(["search", "--all", "the"]);
    expect(exitCode).toBe(0);
  });

  test("returns no results message for non-matching query", async () => {
    const { stdout, exitCode } = await qmd(["search", "xyznonexistent123"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No results");
  });

  test("returns empty JSON array for non-matching query with --json", async () => {
    const { stdout, exitCode } = await qmd(["search", "xyznonexistent123", "--json"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  test("returns CSV header only for non-matching query with --csv", async () => {
    const { stdout, exitCode } = await qmd(["search", "xyznonexistent123", "--csv"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("docid,score,file,title,context,line,snippet");
  });

  test("returns empty XML container for non-matching query with --xml", async () => {
    const { stdout, exitCode } = await qmd(["search", "xyznonexistent123", "--xml"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("<results></results>");
  });

  test("returns empty output for non-matching query with --md", async () => {
    const { stdout, exitCode } = await qmd(["search", "xyznonexistent123", "--md"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("returns empty output for non-matching query with --files", async () => {
    const { stdout, exitCode } = await qmd(["search", "xyznonexistent123", "--files"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("");
  });

  test("returns min-score threshold message for default CLI output", async () => {
    const { stdout, exitCode } = await qmd(["search", "test", "--min-score", "2"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No results found above minimum score threshold.");
  });

  test("returns format-safe empty output when --min-score filters all results", async () => {
    const json = await qmd(["search", "test", "--json", "--min-score", "2"]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual([]);

    const csv = await qmd(["search", "test", "--csv", "--min-score", "2"]);
    expect(csv.exitCode).toBe(0);
    expect(csv.stdout.trim()).toBe("docid,score,file,title,context,line,snippet");

    const xml = await qmd(["search", "test", "--xml", "--min-score", "2"]);
    expect(xml.exitCode).toBe(0);
    expect(xml.stdout.trim()).toBe("<results></results>");

    const md = await qmd(["search", "test", "--md", "--min-score", "2"]);
    expect(md.exitCode).toBe(0);
    expect(md.stdout.trim()).toBe("");

    const files = await qmd(["search", "test", "--files", "--min-score", "2"]);
    expect(files.exitCode).toBe(0);
    expect(files.stdout.trim()).toBe("");
  });

  test("requires query argument", async () => {
    const { stdout, stderr, exitCode } = await qmd(["search"]);
    expect(exitCode).toBe(1);
    // Error message goes to stderr
    expect(stderr).toContain("Usage:");
  });

  test("--json --full includes line field for round-tripping to qmd get", async () => {
    const { stdout, exitCode } = await qmd(["search", "meeting", "--json", "--full", "-n", "1"]);
    expect(exitCode).toBe(0);
    const results = JSON.parse(stdout);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].line).toBeTypeOf("number");
    expect(results[0].line).toBeGreaterThan(0);
    expect(results[0].body).toBeTypeOf("string");
  });
});


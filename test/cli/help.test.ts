/**
 * Tests for CLI help output (qmd --help, qmd <command> --help).
 *
 * Verifies that the help command displays usage information, lists available
 * subcommands, and exits with the correct status code when invoked with
 * --help or no arguments.
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


describe("CLI Help", () => {
  test("shows help with --help flag", async () => {
    const { stdout, exitCode } = await qmd(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("qmd collection add");
    expect(stdout).toContain("qmd search");
    expect(stdout).toContain("--no-gpu");
    expect(stdout).toContain("qmd skill show/install");
  });

  test("shows help with no arguments", async () => {
    const { stdout, exitCode } = await qmd([]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Usage:");
  });
});




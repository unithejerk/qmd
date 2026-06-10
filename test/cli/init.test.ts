/**
 * Tests for CLI init command (qmd init).
 *
 * Verifies project-local .qmd/index.yml and index.sqlite creation,
 * refusal to init in $HOME, and idempotent behavior.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { chmod, copyFile, mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { setTimeout as sleep } from "timers/promises";
import { runQmd, qmdRunnerArgs, setupCliTestEnv, teardownCliTestEnv, createIsolatedTestEnv } from "../helpers/cli.js";
import { readFileSync } from "fs";

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


describe("CLI Init Command", () => {
  test("creates a project-local .qmd index", async () => {
    const projectDir = join(testDir, "init-project");
    await mkdir(projectDir, { recursive: true });

    const { stdout, exitCode } = await qmd(["init"], { cwd: projectDir });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("ready to go with new local index");
    expect(existsSync(join(projectDir, ".qmd", "index.yml"))).toBe(true);
    expect(existsSync(join(projectDir, ".qmd", "index.sqlite"))).toBe(true);
    const configText = readFileSync(join(projectDir, ".qmd", "index.yml"), "utf-8");
    expect(configText).toContain("collections: {}");
    expect(configText).toContain("models:");
  });

  test("refuses to initialize in HOME", async () => {
    const fakeHome = join(testDir, "init-home");
    await mkdir(fakeHome, { recursive: true });

    const { stderr, exitCode } = await qmd(["init"], {
      cwd: fakeHome,
      env: { HOME: fakeHome },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Refusing to initialize a local index in $HOME");
    expect(stderr).toContain("global index is automatically created");
    expect(existsSync(join(fakeHome, ".qmd", "index.yml"))).toBe(false);
  });
});


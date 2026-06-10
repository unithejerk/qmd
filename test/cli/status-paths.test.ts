/**
 * Tests for status and collection list path display.
 *
 * Verifies that qmd status and qmd collection list hide internal
 * filesystem paths by default, showing qmd:// URIs instead.
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
// Status and Collection List - No Full Paths
// =============================================================================

describe("status and collection list hide filesystem paths", () => {
  let localDbPath: string;
  let localConfigDir: string;
  const collName = "fixtures";

  beforeAll(async () => {
    const env = await createIsolatedTestEnv(testDir, "status-paths");
    localDbPath = env.dbPath;
    localConfigDir = env.configDir;

    const { exitCode, stderr } = await qmd(
      ["collection", "add", fixturesDir, "--name", collName],
      { dbPath: localDbPath, configDir: localConfigDir }
    );
    if (exitCode !== 0) console.error("collection add failed:", stderr);
    expect(exitCode).toBe(0);
  });

  test("status does not show full filesystem paths", async () => {
    const { stdout, exitCode } = await qmd(["status"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    // Should show qmd:// URIs
    expect(stdout).toContain(`qmd://${collName}/`);
    // Should NOT show full filesystem paths (except for the index location which is ok)
    const lines = stdout.split('\n').filter(l => !l.includes('Index:'));
    const pathLines = lines.filter(l => l.includes('/Users/') || l.includes('/home/') || l.includes('/tmp/'));
    expect(pathLines.length).toBe(0);
  });

  test("doctor does not show full filesystem paths", async () => {
    const { stdout, exitCode } = await qmd(["doctor"], {
      dbPath: localDbPath,
      configDir: localConfigDir,
      env: { QMD_DOCTOR_DEVICE_PROBE: "0" },
    });
    expect(exitCode).toBe(0);

    expect(stdout).toContain("QMD Doctor");
    const lines = stdout.split('\n').filter(l => !l.includes('Index:') && !l.includes('INDEX_PATH=') && !l.includes('QMD_CONFIG_DIR='));
    const pathLines = lines.filter(l => l.includes('/Users/') || l.includes('/home/') || l.includes('/tmp/'));
    expect(pathLines.length).toBe(0);
  }, 20000);

  test("collection list does not show full filesystem paths", async () => {
    const { stdout, exitCode } = await qmd(["collection", "list"], { dbPath: localDbPath, configDir: localConfigDir });
    expect(exitCode).toBe(0);

    // Should show qmd:// URIs
    expect(stdout).toContain(`qmd://${collName}/`);
    // Should NOT show Path: lines with filesystem paths
    expect(stdout).not.toMatch(/Path:\s+\//);
  });
});

// =============================================================================
// MCP HTTP Daemon Lifecycle
// =============================================================================


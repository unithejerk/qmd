/**
 * Tests for CLI skills listing (qmd skills list, qmd skills get, qmd skills path).
 *
 * Verifies that bundled runtime skill instructions are discoverable,
 * retrievable with --full content, and have valid filesystem paths.
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




describe("CLI Skills", () => {
  test("lists bundled runtime skills", async () => {
    const { stdout, stderr, exitCode } = await qmd(["skills", "list"]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("qmd");
    expect(stdout).toContain("Search local markdown knowledge bases");
  });

  test("gets version-matched runtime skill content", async () => {
    const { stdout, stderr, exitCode } = await qmd(["skills", "get", "qmd"]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("# QMD - Query Markdown Documents");
    expect(stdout).toContain("## MCP Tool: `query`");
    expect(stdout).not.toContain("This file is a discovery stub");
  });

  test("gets runtime skill with supplementary references", async () => {
    const { stdout, stderr, exitCode } = await qmd(["skills", "get", "qmd", "--full"]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("# QMD - Query Markdown Documents");
    expect(stdout).toContain("--- references/mcp-setup.md ---");
    expect(stdout).toContain("# QMD MCP Server Setup");
  });

  test("prints canonical repository skill path", async () => {
    const { stdout, stderr, exitCode } = await qmd(["skills", "path", "qmd"]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/skills\/qmd$/);
  });

  test("legacy skill show prints the canonical skill", async () => {
    const { stdout, stderr, exitCode } = await qmd(["skill", "show"]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("# QMD - Query Markdown Documents");
    expect(stdout).toContain("## MCP Tool: `query`");
    expect(stdout).not.toContain("This file is a discovery stub");
  });

  test("legacy skill install writes a qmd skill show bootstrap", async () => {
    const installDir = join(testDir, "skill-install-target");
    await mkdir(installDir, { recursive: true });

    const { stdout, stderr, exitCode } = await qmd(["skill", "install", "--yes"], { cwd: installDir });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Installed QMD skill");

    const installedSkillDir = join(installDir, ".agents", "skills", "qmd");
    const installed = readFileSync(join(installedSkillDir, "SKILL.md"), "utf8");
    expect(installed).toContain("# QMD - Query Markdown Documents");
    expect(installed).toContain("!`qmd skill show`");
    expect(installed).toContain("qmd get");
    expect(installed).not.toContain("## MCP Tool: `query`");
    expect(readFileSync(join(installedSkillDir, "references", "mcp-setup.md"), "utf8")).toContain("# QMD MCP Server Setup");
  });
});


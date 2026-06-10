/**
 * Tests for CLI skill subcommands (qmd skill show, qmd skill install).
 *
 * Verifies skill installation into ./.agents/skills/qmd, --global mode,
 * --yes symlink creation, --force replacement, and --skill backward compat.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { chmod, copyFile, mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { setTimeout as sleep } from "timers/promises";
import { runQmd, qmdRunnerArgs, setupCliTestEnv, teardownCliTestEnv, createIsolatedTestEnv } from "../helpers/cli.js";
import { lstatSync, readFileSync, symlinkSync, writeFileSync, unlinkSync } from "fs";
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


describe("CLI Skill Commands", () => {
  test("shows embedded skill with --skill alias", async () => {
    const { stdout, exitCode } = await qmd(["--skill"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("QMD Skill");
    expect(stdout).toContain("name: qmd");
    expect(stdout).toContain("allowed-tools: Bash(qmd:*), mcp__qmd__*");
  });

  test("shows skill help with -h", async () => {
    const { stdout, exitCode } = await qmd(["skill", "-h"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: qmd skill <show|install> [options]");
    expect(stdout).toContain("install");
    expect(stdout).toContain("--global");
  });

  test("installs the skill into the current project", async () => {
    const projectDir = join(testDir, "skill-project");
    await mkdir(projectDir, { recursive: true });

    const { stdout, exitCode } = await qmd(["skill", "install"], { cwd: projectDir });
    expect(exitCode).toBe(0);

    const skillDir = join(projectDir, ".agents", "skills", "qmd");
    const installed = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
    expect(installed).toContain("# QMD - Query Markdown Documents");
    expect(installed).toContain("!`qmd skill show`");
    expect(existsSync(join(projectDir, ".claude", "skills", "qmd"))).toBe(false);
    expect(stdout).toContain(`✓ Installed QMD skill to ${skillDir}`);
    expect(stdout).toContain("Tip: create a Claude symlink manually");
  });

  test("installs globally and creates the Claude symlink with --yes", async () => {
    const fakeHome = join(testDir, "skill-home");
    await mkdir(fakeHome, { recursive: true });

    const { stdout, exitCode } = await qmd(["skill", "install", "--global", "--yes"], {
      env: { HOME: fakeHome },
    });
    expect(exitCode).toBe(0);

    const skillDir = join(fakeHome, ".agents", "skills", "qmd");
    const claudeLink = join(fakeHome, ".claude", "skills", "qmd");

    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toContain("!`qmd skill show`");
    expect(lstatSync(claudeLink).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(claudeLink, "SKILL.md"), "utf-8")).toContain("!`qmd skill show`");
    expect(stdout).toContain(`✓ Installed QMD skill to ${skillDir}`);
    expect(stdout).toContain(`✓ Linked Claude skill at ${claudeLink}`);
  });

  test("skips Claude qmd symlink when .claude/skills already points to .agents/skills", async () => {
    const fakeHome = join(testDir, "skill-home-shared");
    await mkdir(join(fakeHome, ".agents"), { recursive: true });
    await mkdir(join(fakeHome, ".claude"), { recursive: true });
    symlinkSync(join(fakeHome, ".agents", "skills"), join(fakeHome, ".claude", "skills"), "dir");

    const { stdout, exitCode } = await qmd(["skill", "install", "--global", "--yes"], {
      env: { HOME: fakeHome },
    });
    expect(exitCode).toBe(0);

    const skillDir = join(fakeHome, ".agents", "skills", "qmd");
    expect(lstatSync(skillDir).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toContain("!`qmd skill show`");
    expect(stdout).toContain(`✓ Claude already sees the skill via ${join(fakeHome, ".claude", "skills")}`);
  });

  test("refuses to overwrite an existing install without --force", async () => {
    const projectDir = join(testDir, "skill-project-force");
    await mkdir(projectDir, { recursive: true });

    const first = await qmd(["skill", "install"], { cwd: projectDir });
    expect(first.exitCode).toBe(0);

    const second = await qmd(["skill", "install"], { cwd: projectDir });
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain("Skill already exists");
    expect(second.stderr).toContain("--force");
  });
});


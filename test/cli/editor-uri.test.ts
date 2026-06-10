/**
 * Tests for editor URI template rendering (buildEditorUri, termLink).
 *
 * Verifies clickable terminal hyperlinks (OSC 8) for various editor URI
 * templates (vscode, cursor, zed, sublime), path/line/column substitution,
 * and TTY detection.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { chmod, copyFile, mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { setTimeout as sleep } from "timers/promises";
import { runQmd, qmdRunnerArgs, setupCliTestEnv, teardownCliTestEnv, createIsolatedTestEnv } from "../helpers/cli.js";
import { buildEditorUri, termLink } from "../../src/cli/search-formatting.ts";

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


describe("editor URI templates", () => {
  test("buildEditorUri expands path, line, and col placeholders", () => {
    const uri = buildEditorUri(
      "vscode://file/{path}:{line}:{col}",
      "/tmp/my notes/readme.md",
      42,
      1,
    );

    expect(uri).toBe("vscode://file//tmp/my%20notes/readme.md:42:1");
  });

  test("buildEditorUri supports {column} alias", () => {
    const uri = buildEditorUri(
      "cursor://file/{path}:{line}:{column}",
      "/tmp/docs/api.md",
      7,
      3,
    );

    expect(uri).toBe("cursor://file//tmp/docs/api.md:7:3");
  });

  test("termLink returns plain text when stdout is not a TTY", () => {
    const linked = termLink("docs/api.md:12", "vscode://file//tmp/docs/api.md:12:1", false);

    expect(linked).toBe("docs/api.md:12");
  });

  test("termLink emits OSC 8 hyperlinks when stdout is a TTY", () => {
    const linked = termLink("docs/api.md:12", "vscode://file//tmp/docs/api.md:12:1", true);

    expect(linked).toBe("\x1b]8;;vscode://file//tmp/docs/api.md:12:1\x07docs/api.md:12\x1b]8;;\x07");
  });
});

// =============================================================================
// Get Command Path Normalization Tests
// =============================================================================


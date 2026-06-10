/**
 * Tests for CLI embed command (qmd embed).
 *
 * Verifies embed command parsing, flag handling (--force, --max-docs-per-batch,
 * --max-batch-mb, --chunk-strategy), and error messages for invalid inputs.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { chmod, copyFile, mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { setTimeout as sleep } from "timers/promises";
import { runQmd, qmdRunnerArgs, setupCliTestEnv, teardownCliTestEnv, createIsolatedTestEnv } from "../helpers/cli.js";
import { resolveEmbedModelForCli } from "../../src/cli/qmd.ts";
import { DEFAULT_EMBED_MODEL_URI, DEFAULT_GENERATE_MODEL_URI, DEFAULT_RERANK_MODEL_URI } from "../../src/llm.ts";
import { setConfigSource } from "../../src/collections.ts";

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


describe("CLI Embed", () => {
  test("prefers QMD_EMBED_MODEL for qmd embed when the index has no model pin", () => {
    const prev = process.env.QMD_EMBED_MODEL;
    process.env.QMD_EMBED_MODEL = "hf:env/embed-model.gguf";
    setConfigSource({ config: { collections: {} } });

    try {
      expect(resolveEmbedModelForCli()).toBe("hf:env/embed-model.gguf");
    } finally {
      setConfigSource();
      if (prev === undefined) delete process.env.QMD_EMBED_MODEL;
      else process.env.QMD_EMBED_MODEL = prev;
    }
  });

  test("falls back to the default embed model when QMD_EMBED_MODEL is unset", () => {
    const prev = process.env.QMD_EMBED_MODEL;
    delete process.env.QMD_EMBED_MODEL;
    setConfigSource({ config: { collections: {} } });

    try {
      expect(resolveEmbedModelForCli()).toBe(DEFAULT_EMBED_MODEL_URI);
    } finally {
      setConfigSource();
      if (prev === undefined) delete process.env.QMD_EMBED_MODEL;
      else process.env.QMD_EMBED_MODEL = prev;
    }
  });

  test("rejects invalid --max-docs-per-batch", async () => {
    const { stderr, exitCode } = await qmd(["embed", "--max-docs-per-batch", "0"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("maxDocsPerBatch");
  });

  test("rejects invalid --max-batch-mb", async () => {
    const { stderr, exitCode } = await qmd(["embed", "--max-batch-mb", "0"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("maxBatchBytes");
  });
});


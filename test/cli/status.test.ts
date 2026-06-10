/**
 * Tests for CLI status and doctor commands (qmd status, qmd doctor).
 *
 * Verifies index health reporting, collection listing with contexts,
 * model resolution display, remote endpoint health probing,
 * embedding fingerprint diagnostics, and GPU/Metal mitigation reporting.
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
import { resolveEmbedModelForCli } from "../../src/cli/qmd.ts";
import { openDatabase } from "../../src/db.ts";
import { DEFAULT_EMBED_MODEL_URI, DEFAULT_GENERATE_MODEL_URI, DEFAULT_RERANK_MODEL_URI } from "../../src/llm.ts";

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


describe("CLI Status Command", () => {
  beforeEach(async () => {
    // Ensure we have indexed files
    await qmd(["collection", "add", "."]);
  });

  test("qmd doctor reports core index health checks", async () => {
    const { stdout, exitCode } = await qmd(["doctor"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("QMD Doctor");
    expect(stdout).toContain("SQLite runtime");
    expect(stdout).toContain("sqlite-vec");
    expect(stdout).toContain("environment overrides");
    expect(stdout).toContain("INDEX_PATH");
    expect(stdout).toContain("overrides the SQLite index path");
    expect(stdout).toContain("QMD_CONFIG_DIR");
    expect(stdout).toContain("overrides the QMD config directory");
    expect(stdout).toContain("model defaults");
    expect(stdout).toContain("model cache");
    expect(stdout).toContain("device mode");
    expect(stdout).toContain("device probe");
    expect(stdout).toContain("embedding freshness");
    expect(stdout).toContain("embedding fingerprints");
    expect(stdout).toContain("embedding vector sample");
    expect(stdout).toContain("please run qmd embed again");

    // Doctor reports model defaults in stdout, not by modifying index.yml.
    // The local-first defaults change removed auto-save behavior.
    expect(stdout).toContain("model defaults");
  }, 20000);

  test("qmd doctor warns when no collections are configured", async () => {
    const env = await createIsolatedTestEnv(testDir, "doctor-no-collections");
    const { stdout, exitCode } = await qmd(["doctor"], { dbPath: env.dbPath, configDir: env.configDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("index config");
    expect(stdout).toContain("no collections configured");
    expect(stdout).toContain("qmd collection add .");
  }, 20000);

  test("qmd doctor reports invalid index.yml without crashing", async () => {
    const env = await createIsolatedTestEnv(testDir, "doctor-invalid-config");
    await writeFile(join(env.configDir, "index.yml"), "collections:\n  bad: [unterminated\n");

    const { stdout, exitCode } = await qmd(["doctor"], { dbPath: env.dbPath, configDir: env.configDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("index config");
    expect(stdout).toContain("invalid index.yml at");
    expect(stdout).toContain(join(env.configDir, "index.yml"));
    expect(stdout).toContain("fix the YAML");
  }, 20000);

  test("qmd doctor warns when configured models differ from code defaults", async () => {
    const env = await createIsolatedTestEnv(testDir, "doctor-custom-models");
    await writeFile(join(env.configDir, "index.yml"), `collections: {}\nmodels:\n  embed: hf:example/custom-embed/custom.gguf\n  generate: ${DEFAULT_GENERATE_MODEL_URI}\n  rerank: ${DEFAULT_RERANK_MODEL_URI}\n`);

    const { stdout, exitCode } = await qmd(["doctor"], { dbPath: env.dbPath, configDir: env.configDir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("model defaults");
    expect(stdout).toContain("non-default model configuration");
    expect(stdout).toContain("index hf:example/custom-embed/custom.gguf");
    expect(stdout).toContain("might be ok");
    expect(stdout).toContain("qmd pull");
  }, 20000);

  test("qmd doctor identifies cached non-GGUF model files", async () => {
    const env = await createIsolatedTestEnv(testDir, "doctor-invalid-model-cache");
    const model = "hf:example/custom-model/custom.gguf";
    await writeFile(join(env.configDir, "index.yml"), `collections: {}\nmodels:\n  embed: ${model}\n  generate: ${model}\n  rerank: ${model}\n`);
    const cacheRoot = join(env.configDir, "cache");
    const modelCacheDir = join(cacheRoot, "qmd", "models");
    await mkdir(modelCacheDir, { recursive: true });
    const badModelPath = join(modelCacheDir, "custom.gguf");
    await writeFile(badModelPath, "<!doctype html><html>blocked</html>");

    const { stdout, exitCode } = await qmd(["doctor"], {
      dbPath: env.dbPath,
      configDir: env.configDir,
      env: {
        XDG_CACHE_HOME: cacheRoot,
        QMD_DOCTOR_DEVICE_PROBE: "0",
      },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("model cache");
    expect(stdout).toContain("invalid 1");
    expect(stdout).toContain("HTML page, not a GGUF model");
    expect(stdout).toContain("qmd pull --refresh");
  }, 20000);

  test("qmd doctor says when models are overridden by env", async () => {
    const env = await createIsolatedTestEnv(testDir, "doctor-env-models");
    await writeFile(join(env.configDir, "index.yml"), "collections: {}\n");

    const customEmbed = "hf:example/env-embed/custom.gguf";
    const { stdout, exitCode } = await qmd(["doctor"], {
      dbPath: env.dbPath,
      configDir: env.configDir,
      env: { QMD_EMBED_MODEL: customEmbed },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("model defaults");
    expect(stdout).toContain(`env QMD_EMBED_MODEL=${customEmbed}`);
    expect(stdout).toContain("might be ok");
    expect(stdout).toContain("environment overrides");
    expect(stdout).toContain(`QMD_EMBED_MODEL=${customEmbed}`);
    expect(stdout).toContain("sets the active embed model");
  }, 20000);

  test("qmd doctor shows CPU-forced device mode with QMD_FORCE_CPU=1", async () => {
    const env = await createIsolatedTestEnv(testDir, "doctor-force-cpu");
    const { stdout, exitCode } = await qmd(["doctor"], {
      dbPath: env.dbPath,
      configDir: env.configDir,
      env: {
        QMD_FORCE_CPU: "1",
        QMD_DOCTOR_DEVICE_PROBE: "0",
      },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("QMD_FORCE_CPU=1");
    expect(stdout).toContain("forces llama.cpp to bypass GPU backends");
    expect(stdout).toContain("device mode: CPU forced (QMD_FORCE_CPU)");
  }, 20000);

  test("qmd doctor lists known environment overrides and consequences", async () => {
    const env = await createIsolatedTestEnv(testDir, "doctor-env-overrides");
    const overrides = {
      XDG_CACHE_HOME: join(env.configDir, "cache"),
      QMD_DOCTOR_DEVICE_PROBE: "0",
      QMD_FORCE_CPU: "1",
      QMD_LLAMA_GPU: "metal",
      QMD_EMBED_PARALLELISM: "2",
      QMD_EXPAND_CONTEXT_SIZE: "4096",
      QMD_RERANK_CONTEXT_SIZE: "8192",
      QMD_EMBED_CONTEXT_SIZE: "1024",
      QMD_EDITOR_URI: "vscode://file/{file}:{line}:{col}",
      QMD_SKILLS_DIR: "/tmp/qmd-skills",
      QMD_METAL_KEEP_RESIDENCY: "1",
      NO_COLOR: "1",
      CI: "1",
      HF_ENDPOINT: "https://hf-mirror.com",
      WSL_DISTRO_NAME: "Ubuntu",
      WSL_INTEROP: "1",
    };

    const { stdout, exitCode } = await qmd(["doctor"], {
      dbPath: env.dbPath,
      configDir: env.configDir,
      env: overrides,
    });
    expect(exitCode).toBe(0);
    for (const name of Object.keys(overrides)) {
      expect(stdout).toContain(name);
    }
    expect(stdout).toContain("forces llama.cpp to bypass GPU backends");
    expect(stdout).toContain("moves the default index cache");
    expect(stdout).toContain("disables real LLM operations");
    expect(stdout).toContain("changes Hugging Face download endpoint");
  }, 20000);

  test("qmd doctor flags mixed embedding fingerprints", async () => {
    const db = openDatabase(dbPath);
    const doc = db.prepare(`SELECT hash FROM documents WHERE active = 1 LIMIT 1`).get() as { hash: string };
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embed_fingerprint, total_chunks, embedded_at)
      VALUES (?, 0, 0, ?, 'stale1', 2, ?)
    `).run(doc.hash, resolveEmbedModelForCli(), now);
    db.prepare(`
      INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embed_fingerprint, total_chunks, embedded_at)
      VALUES (?, 1, 1, ?, 'stale2', 2, ?)
    `).run(doc.hash, resolveEmbedModelForCli(), now);
    db.close();

    const { stdout, exitCode } = await qmd(["doctor"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("embedding fingerprints");
    expect(stdout).toContain("mixed named embedding fingerprints");
    expect(stdout).toContain("stale1");
  }, 20000);

  test("shows index status", async () => {
    const { stdout, exitCode } = await qmd(["status"]);
    expect(exitCode).toBe(0);
    // Should show collection info
    expect(stdout).toContain("Collection");
  });

  test("status omits device probing details; doctor owns GPU diagnostics", async () => {
    const { stdout, exitCode } = await qmd(["status"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("Device");
    expect(stdout).not.toContain("QMD_STATUS_DEVICE_PROBE");
    expect(stdout).not.toContain("not probed");
  });
});


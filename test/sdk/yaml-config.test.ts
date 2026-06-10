/**
 * Auto-generated split from test/sdk.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import YAML from "yaml";
import {
  createStore,
  type QMDStore,
  type CollectionConfig,
  type StoreOptions,
} from "../../src/index.js";

let testDir: string;
let docsDir: string;
let notesDir: string;

beforeAll(async () => {
  testDir = await mkdtemp(join(tmpdir(), "qmd-sdk-test-"));
  docsDir = join(testDir, "docs");
  notesDir = join(testDir, "notes");
  await mkdir(docsDir, { recursive: true });
  await mkdir(notesDir, { recursive: true });
  await writeFile(join(docsDir, "readme.md"), "# Getting Started\n\nThis is the getting started guide for the project.\n");
  await writeFile(join(docsDir, "auth.md"), "# Authentication\n\nAuthentication uses JWT tokens for session management.\nUsers log in with email and password.\n");
  await writeFile(join(docsDir, "api.md"), "# API Reference\n\n## Endpoints\n\n### POST /login\nAuthenticate a user.\n\n### GET /users\nList all users.\n");
  await writeFile(join(notesDir, "meeting-2025-01.md"), "# January Planning Meeting\n\nDiscussed Q1 roadmap and resource allocation.\n");
  await writeFile(join(notesDir, "meeting-2025-02.md"), "# February Standup\n\nReviewed sprint progress. Authentication feature is on track.\n");
  await writeFile(join(notesDir, "ideas.md"), "# Project Ideas\n\n- Build a search engine\n- Create a knowledge base\n- Implement vector search\n");
});

afterAll(async () => {
  try { await rm(testDir, { recursive: true, force: true }); } catch {}
});

function freshDbPath(): string {
  return join(testDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}


// =============================================================================
// YAML Config File Tests
// =============================================================================

describe("YAML config file mode", () => {
  test("loads collections from YAML file", async () => {
    const configPath = join(testDir, `config-${Date.now()}.yml`);
    const config: CollectionConfig = {
      collections: {
        docs: { path: docsDir, pattern: "**/*.md" },
        notes: { path: notesDir, pattern: "**/*.md" },
      },
    };
    writeFileSync(configPath, YAML.stringify(config));

    const store = await createStore({ dbPath: freshDbPath(), configPath });
    const names = (await store.listCollections()).map(c => c.name);

    expect(names).toContain("docs");
    expect(names).toContain("notes");
    await store.close();
  });

  test("addCollection persists to YAML file", async () => {
    const configPath = join(testDir, `config-persist-${Date.now()}.yml`);
    writeFileSync(configPath, YAML.stringify({ collections: {} }));

    const store = await createStore({ dbPath: freshDbPath(), configPath });
    await store.addCollection("newcol", { path: docsDir, pattern: "**/*.md" });
    await store.close();

    // Read the YAML file directly and verify
    const raw = readFileSync(configPath, "utf-8");
    const parsed = YAML.parse(raw) as CollectionConfig;
    expect(parsed.collections).toHaveProperty("newcol");
    expect(parsed.collections.newcol!.path).toBe(docsDir);
  });

  test("context persists to YAML file", async () => {
    const configPath = join(testDir, `config-ctx-${Date.now()}.yml`);
    writeFileSync(configPath, YAML.stringify({
      collections: { docs: { path: docsDir, pattern: "**/*.md" } },
    }));

    const store = await createStore({ dbPath: freshDbPath(), configPath });
    await store.addContext("docs", "/api", "API documentation");
    await store.close();

    const raw = readFileSync(configPath, "utf-8");
    const parsed = YAML.parse(raw) as CollectionConfig;
    expect(parsed.collections.docs!.context).toEqual({ "/api": "API documentation" });
  });

  test("non-existent config file returns empty collections", async () => {
    const configPath = join(testDir, "nonexistent-config.yml");
    const store = await createStore({ dbPath: freshDbPath(), configPath });
    const collections = await store.listCollections();

    expect(collections).toEqual([]);
    await store.close();
  });
});

// =============================================================================
// Search Tests (BM25 - no LLM needed)
// =============================================================================


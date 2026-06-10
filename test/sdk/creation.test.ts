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
// Constructor Tests
// =============================================================================

describe("createStore", () => {
  test("creates store with inline config", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    expect(store).toBeDefined();
    expect(store.dbPath).toBeTruthy();
    expect(store.internal).toBeDefined();
    await store.close();
  });

  test("creates store with YAML config file", async () => {
    const configPath = join(testDir, "test-config.yml");
    const config: CollectionConfig = {
      collections: {
        docs: { path: docsDir, pattern: "**/*.md" },
      },
    };
    writeFileSync(configPath, YAML.stringify(config));

    const store = await createStore({
      dbPath: freshDbPath(),
      configPath,
    });

    expect(store).toBeDefined();
    await store.close();
  });

  test("throws if dbPath is missing", async () => {
    await expect(
      createStore({ dbPath: "", config: { collections: {} } })
    ).rejects.toThrow("dbPath is required");
  });

  test("opens with just dbPath (DB-only mode)", async () => {
    const store = await createStore({ dbPath: freshDbPath() } as StoreOptions);
    expect(store).toBeDefined();
    // No collections yet — fresh DB
    const collections = await store.listCollections();
    expect(collections).toEqual([]);
    await store.close();
  });

  test("throws if both configPath and config are provided", async () => {
    await expect(
      createStore({
        dbPath: freshDbPath(),
        configPath: "/some/path.yml",
        config: { collections: {} },
      })
    ).rejects.toThrow("Provide either configPath or config, not both");
  });

  test("creates database file on disk", async () => {
    const dbPath = freshDbPath();
    const store = await createStore({
      dbPath,
      config: { collections: {} },
    });

    expect(existsSync(dbPath)).toBe(true);
    await store.close();
  });

  test("store.dbPath matches the provided path", async () => {
    const dbPath = freshDbPath();
    const store = await createStore({
      dbPath,
      config: { collections: {} },
    });

    expect(store.dbPath).toBe(dbPath);
    await store.close();
  });
});

// =============================================================================
// Collection Management Tests
// =============================================================================


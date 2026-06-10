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
// DB-Only Mode Tests (self-contained store)
// =============================================================================

describe("DB-only mode", () => {
  test("reopen store with just dbPath after config+update session", async () => {
    const dbPath = freshDbPath();

    // Session 1: create store with config, update, close
    const store1 = await createStore({
      dbPath,
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
          notes: { path: notesDir, pattern: "**/*.md" },
        },
        global_context: "Test knowledge base",
      },
    });

    await store1.update();

    // Verify documents indexed
    const status1 = await store1.getStatus();
    expect(status1.totalDocuments).toBe(6);
    await store1.close();

    // Session 2: reopen with just dbPath — no config
    const store2 = await createStore({ dbPath } as StoreOptions);

    // Collections should still be available
    const collections = await store2.listCollections();
    expect(collections.map(c => c.name).sort()).toEqual(["docs", "notes"]);

    // Search should still work
    const results = await store2.searchLex("authentication");
    expect(results.length).toBeGreaterThan(0);

    // Global context should still be available
    const globalCtx = await store2.getGlobalContext();
    expect(globalCtx).toBe("Test knowledge base");

    // Contexts from collections should persist
    const status2 = await store2.getStatus();
    expect(status2.totalDocuments).toBe(6);

    await store2.close();
  });

  test("config sync populates store_collections table", async () => {
    const dbPath = freshDbPath();
    const store = await createStore({
      dbPath,
      config: {
        collections: {
          docs: {
            path: docsDir,
            pattern: "**/*.md",
            context: { "/auth": "Auth documentation" },
          },
        },
      },
    });

    // Verify collections are in the DB via listCollections
    const collections = await store.listCollections();
    expect(collections).toHaveLength(1);
    expect(collections[0]!.name).toBe("docs");
    expect(collections[0]!.pwd).toBe(docsDir);

    // Verify contexts are accessible
    const contexts = await store.listContexts();
    expect(contexts).toContainEqual({
      collection: "docs",
      path: "/auth",
      context: "Auth documentation",
    });

    await store.close();
  });

  test("config hash skip: second init with same config skips sync", async () => {
    const dbPath = freshDbPath();
    const config = {
      collections: {
        docs: { path: docsDir, pattern: "**/*.md" },
      },
    };

    // First init — syncs config
    const store1 = await createStore({ dbPath, config });
    await store1.close();

    // Second init with same config — should skip sync (no-op, but should not error)
    const store2 = await createStore({ dbPath, config });
    const collections = await store2.listCollections();
    expect(collections).toHaveLength(1);
    expect(collections[0]!.name).toBe("docs");
    await store2.close();
  });

  test("DB-only mode supports collection mutations", async () => {
    const dbPath = freshDbPath();

    // Session 1: create with config
    const store1 = await createStore({
      dbPath,
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });
    await store1.close();

    // Session 2: reopen DB-only, add a collection
    const store2 = await createStore({ dbPath } as StoreOptions);
    await store2.addCollection("notes", { path: notesDir, pattern: "**/*.md" });

    const names = (await store2.listCollections()).map(c => c.name).sort();
    expect(names).toEqual(["docs", "notes"]);

    await store2.close();

    // Session 3: reopen DB-only again, verify both collections persist
    const store3 = await createStore({ dbPath } as StoreOptions);
    const names3 = (await store3.listCollections()).map(c => c.name).sort();
    expect(names3).toEqual(["docs", "notes"]);
    await store3.close();
  });

  test("DB-only mode supports context mutations", async () => {
    const dbPath = freshDbPath();

    // Session 1: create with config
    const store1 = await createStore({
      dbPath,
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });
    await store1.addContext("docs", "/api", "API docs");
    await store1.setGlobalContext("Global context");
    await store1.close();

    // Session 2: reopen DB-only
    const store2 = await createStore({ dbPath } as StoreOptions);

    const contexts = await store2.listContexts();
    expect(contexts).toContainEqual({
      collection: "docs",
      path: "/api",
      context: "API docs",
    });
    expect(contexts).toContainEqual({
      collection: "*",
      path: "/",
      context: "Global context",
    });

    await store2.close();
  });
});

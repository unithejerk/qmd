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
// Collection Management Tests
// =============================================================================

describe("collection management", () => {
  let store: QMDStore;

  beforeEach(async () => {
    store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });
  });

  afterEach(async () => {
    await store.close();
  });

  test("addCollection adds a collection to inline config", async () => {
    await store.addCollection("docs", { path: docsDir, pattern: "**/*.md" });

    const collections = await store.listCollections();
    const names = collections.map(c => c.name);
    expect(names).toContain("docs");
  });

  test("addCollection with default pattern", async () => {
    await store.addCollection("notes", { path: notesDir });

    const collections = await store.listCollections();
    expect(collections.find(c => c.name === "notes")).toBeDefined();
  });

  test("removeCollection removes existing collection", async () => {
    await store.addCollection("docs", { path: docsDir, pattern: "**/*.md" });
    const removed = await store.removeCollection("docs");

    expect(removed).toBe(true);
    const collections = await store.listCollections();
    expect(collections.map(c => c.name)).not.toContain("docs");
  });

  test("removeCollection returns false for non-existent collection", async () => {
    const removed = await store.removeCollection("nonexistent");
    expect(removed).toBe(false);
  });

  test("renameCollection renames a collection", async () => {
    await store.addCollection("old-name", { path: docsDir, pattern: "**/*.md" });
    const renamed = await store.renameCollection("old-name", "new-name");

    expect(renamed).toBe(true);
    const names = (await store.listCollections()).map(c => c.name);
    expect(names).toContain("new-name");
    expect(names).not.toContain("old-name");
  });

  test("renameCollection returns false for non-existent source", async () => {
    const renamed = await store.renameCollection("nonexistent", "new-name");
    expect(renamed).toBe(false);
  });

  test("renameCollection throws if target exists", async () => {
    await store.addCollection("a", { path: docsDir, pattern: "**/*.md" });
    await store.addCollection("b", { path: notesDir, pattern: "**/*.md" });

    await expect(store.renameCollection("a", "b")).rejects.toThrow("already exists");
  });

  test("listCollections returns empty array for empty config", async () => {
    const collections = await store.listCollections();
    expect(collections).toEqual([]);
  });

  test("multiple collections can be added", async () => {
    await store.addCollection("docs", { path: docsDir, pattern: "**/*.md" });
    await store.addCollection("notes", { path: notesDir, pattern: "**/*.md" });

    const names = (await store.listCollections()).map(c => c.name);
    expect(names).toContain("docs");
    expect(names).toContain("notes");
    expect(names).toHaveLength(2);
  });
});

// =============================================================================
// Context Management Tests
// =============================================================================


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
// Context Management Tests
// =============================================================================

describe("context management", () => {
  let store: QMDStore;

  beforeEach(async () => {
    store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
          notes: { path: notesDir, pattern: "**/*.md" },
        },
      },
    });
  });

  afterEach(async () => {
    await store.close();
  });

  test("addContext adds context to a collection path", async () => {
    const added = await store.addContext("docs", "/auth", "Authentication docs");
    expect(added).toBe(true);

    const contexts = await store.listContexts();
    expect(contexts).toContainEqual({
      collection: "docs",
      path: "/auth",
      context: "Authentication docs",
    });
  });

  test("addContext returns false for non-existent collection", async () => {
    const added = await store.addContext("nonexistent", "/path", "Some context");
    expect(added).toBe(false);
  });

  test("removeContext removes existing context", async () => {
    await store.addContext("docs", "/auth", "Authentication docs");
    const removed = await store.removeContext("docs", "/auth");

    expect(removed).toBe(true);
    const contexts = await store.listContexts();
    expect(contexts.find(c => c.path === "/auth")).toBeUndefined();
  });

  test("removeContext returns false for non-existent context", async () => {
    const removed = await store.removeContext("docs", "/nonexistent");
    expect(removed).toBe(false);
  });

  test("setGlobalContext sets and retrieves global context", async () => {
    await store.setGlobalContext("Global knowledge base");
    const global = await store.getGlobalContext();

    expect(global).toBe("Global knowledge base");
  });

  test("setGlobalContext with undefined clears it", async () => {
    await store.setGlobalContext("Some context");
    await store.setGlobalContext(undefined);
    const global = await store.getGlobalContext();

    expect(global).toBeUndefined();
  });

  test("listContexts includes global context", async () => {
    await store.setGlobalContext("Global context");
    const contexts = await store.listContexts();

    expect(contexts).toContainEqual({
      collection: "*",
      path: "/",
      context: "Global context",
    });
  });

  test("listContexts returns contexts across multiple collections", async () => {
    await store.addContext("docs", "/", "Documentation");
    await store.addContext("notes", "/", "Personal notes");

    const contexts = await store.listContexts();
    expect(contexts.filter(c => c.path === "/")).toHaveLength(2);
  });

  test("multiple contexts on same collection", async () => {
    await store.addContext("docs", "/auth", "Auth docs");
    await store.addContext("docs", "/api", "API docs");

    const contexts = (await store.listContexts()).filter(c => c.collection === "docs");
    expect(contexts).toHaveLength(2);
    expect(contexts.map(c => c.path).sort()).toEqual(["/api", "/auth"]);
  });

  test("addContext overwrites existing context for same path", async () => {
    await store.addContext("docs", "/auth", "Old context");
    await store.addContext("docs", "/auth", "New context");

    const contexts = (await store.listContexts()).filter(c => c.path === "/auth");
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.context).toBe("New context");
  });
});

// =============================================================================
// Inline Config Isolation Tests
// =============================================================================


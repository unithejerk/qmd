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
// Config Initialization Tests
// =============================================================================

describe("config initialization", () => {
  test("inline config with global_context is preserved", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        global_context: "System knowledge base",
        collections: {
          docs: { path: docsDir, pattern: "**/*.md" },
        },
      },
    });

    const global = await store.getGlobalContext();
    expect(global).toBe("System knowledge base");
    await store.close();
  });

  test("inline config with pre-existing contexts is preserved", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: {
            path: docsDir,
            pattern: "**/*.md",
            context: { "/auth": "Authentication docs" },
          },
        },
      },
    });

    const contexts = await store.listContexts();
    expect(contexts).toContainEqual({
      collection: "docs",
      path: "/auth",
      context: "Authentication docs",
    });
    await store.close();
  });

  test("inline config with empty collections object works", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    expect(await store.listCollections()).toEqual([]);
    expect(await store.listContexts()).toEqual([]);
    await store.close();
  });

  test("inline config with multiple collection options", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: {
        collections: {
          docs: {
            path: docsDir,
            pattern: "**/*.md",
            ignore: ["drafts/**"],
            includeByDefault: true,
          },
          notes: {
            path: notesDir,
            pattern: "**/*.md",
            includeByDefault: false,
          },
        },
      },
    });

    const collections = await store.listCollections();
    expect(collections).toHaveLength(2);
    await store.close();
  });
});

// =============================================================================
// Type Export Tests (compile-time checks, runtime verification)
// =============================================================================


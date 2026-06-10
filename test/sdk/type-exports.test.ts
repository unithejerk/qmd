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
// Type Export Tests (compile-time checks, runtime verification)
// =============================================================================

describe("type exports", () => {
  test("StoreOptions type is usable", () => {
    const opts: StoreOptions = {
      dbPath: "/tmp/test.sqlite",
      config: { collections: {} },
    };
    expect(opts.dbPath).toBe("/tmp/test.sqlite");
  });

  test("CollectionConfig type is usable", () => {
    const config: CollectionConfig = {
      global_context: "test",
      collections: {
        test: { path: "/tmp", pattern: "**/*.md" },
      },
    };
    expect(config.collections).toHaveProperty("test");
  });

  test("QMDStore type exposes expected methods", async () => {
    const store = await createStore({
      dbPath: freshDbPath(),
      config: { collections: {} },
    });

    // Verify all methods exist
    expect(typeof store.search).toBe("function");
    expect(typeof store.searchLex).toBe("function");
    expect(typeof store.searchVector).toBe("function");
    expect(typeof store.expandQuery).toBe("function");
    expect(typeof store.get).toBe("function");
    expect(typeof store.multiGet).toBe("function");
    expect(typeof store.addCollection).toBe("function");
    expect(typeof store.removeCollection).toBe("function");
    expect(typeof store.renameCollection).toBe("function");
    expect(typeof store.listCollections).toBe("function");
    expect(typeof store.addContext).toBe("function");
    expect(typeof store.removeContext).toBe("function");
    expect(typeof store.setGlobalContext).toBe("function");
    expect(typeof store.getGlobalContext).toBe("function");
    expect(typeof store.listContexts).toBe("function");
    expect(typeof store.getStatus).toBe("function");
    expect(typeof store.getIndexHealth).toBe("function");
    expect(typeof store.update).toBe("function");
    expect(typeof store.embed).toBe("function");
    expect(typeof store.close).toBe("function");

    await store.close();
  });
});

// =============================================================================
// DB-Only Mode Tests (self-contained store)
// =============================================================================

